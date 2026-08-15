// @effect-diagnostics nodeBuiltinImport:off - This private wire codec needs Node streams and zlib.
/**
 * Streams deterministic file trees through the private Agent desktop data plane.
 *
 * The format is deliberately small: a magic prefix, length-prefixed JSON entry
 * headers, exact file bytes, and a zero-length terminator. It preserves the
 * metadata useful across a user workspace and an isolated Linux guest while
 * rejecting entries that could escape the selected destination.
 *
 * @module AgentDesktopBundle
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import * as Schema from "effect/Schema";

const BUNDLE_MAGIC = Buffer.from("T3BNDL1\n", "ascii");
const END_HEADER = Buffer.alloc(4);
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ENTRY_COUNT = 1_000_000;
const MAX_ENTRY_PATH_BYTES = 16 * 1024;
const MAX_LINK_TARGET_BYTES = 16 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const AUTO_COMPRESSION_SAMPLE_BYTES = 4 * 1024 * 1024;
const AUTO_COMPRESSION_MIN_BYTES = 64 * 1024;
const AUTO_COMPRESSION_MAX_RATIO = 0.9;
const GZIP_LEVEL = 1;

export type AgentDesktopBundleCompression = "none" | "gzip";
export type AgentDesktopBundleCompressionPreference = AgentDesktopBundleCompression | "auto";
export type AgentDesktopBundleCollision = "create" | "replace" | "merge";
export type AgentDesktopBundleRootType = "file" | "directory" | "symlink";

const BundleEntryPath = Schema.String.check(Schema.isMaxLength(MAX_ENTRY_PATH_BYTES));
const BundleMode = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0o777 }));
const BundleMtime = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const BundleEntry = Schema.Union([
  Schema.Struct({
    path: BundleEntryPath,
    type: Schema.Literal("file"),
    mode: BundleMode,
    mtimeMs: BundleMtime,
    size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  }),
  Schema.Struct({
    path: BundleEntryPath,
    type: Schema.Literal("directory"),
    mode: BundleMode,
    mtimeMs: BundleMtime,
  }),
  Schema.Struct({
    path: BundleEntryPath,
    type: Schema.Literal("symlink"),
    mode: BundleMode,
    mtimeMs: BundleMtime,
    target: Schema.String.check(Schema.isMaxLength(MAX_LINK_TARGET_BYTES)),
  }),
]);
type BundleEntry = typeof BundleEntry.Type;

const decodeBundleEntry = Schema.decodeUnknownSync(BundleEntry);

export interface AgentDesktopBundleSummary {
  readonly rootType: AgentDesktopBundleRootType;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly symlinkCount: number;
  readonly logicalBytes: number;
}

export interface AgentDesktopBundlePackResult extends AgentDesktopBundleSummary {
  readonly archiveBytes: number;
  readonly wireBytes: number;
  readonly compression: AgentDesktopBundleCompression;
  readonly sha256: string;
}

export interface AgentDesktopBundleExtractResult extends AgentDesktopBundleSummary {
  readonly destinationPath: string;
}

export interface PackAgentDesktopBundleInput {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly compression?: AgentDesktopBundleCompressionPreference;
  readonly signal?: AbortSignal;
}

export interface ExtractAgentDesktopBundleInput {
  readonly archivePath: string;
  readonly destinationPath: string;
  readonly compression: AgentDesktopBundleCompression;
  readonly collision?: AgentDesktopBundleCollision;
  readonly allowExternalSymlinks?: boolean;
  readonly signal?: AbortSignal;
}

export class AgentDesktopBundleError extends Error {
  readonly code:
    | "invalid-bundle"
    | "invalid-entry"
    | "unsupported-entry"
    | "destination-exists"
    | "destination-type-mismatch"
    | "source-changed";
  readonly entryPath?: string;

  /** Creates one bounded bundle failure. */
  constructor(input: {
    readonly code: AgentDesktopBundleError["code"];
    readonly message: string;
    readonly entryPath?: string;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "AgentDesktopBundleError";
    this.code = input.code;
    if (input.entryPath !== undefined) this.entryPath = input.entryPath;
  }
}

interface PackCounters {
  rootType: AgentDesktopBundleRootType;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  logicalBytes: number;
  entryCount: number;
}

interface DeferredSymlink {
  readonly absolutePath: string;
  readonly bundlePath: string;
  readonly stats: NodeFS.Stats;
}

/** Throws the caller's abort reason at explicit I/O boundaries. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/** Maps a supported lstat result to its portable root type. */
function rootTypeOf(stats: NodeFS.Stats, entryPath: string): AgentDesktopBundleRootType {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  throw new AgentDesktopBundleError({
    code: "unsupported-entry",
    message: `unsupported file type at ${entryPath}`,
    entryPath,
  });
}

/** Returns portable permission bits without ownership or special-mode flags. */
function portableMode(stats: NodeFS.Stats): number {
  return stats.mode & 0o777;
}

/** Writes every byte even when the underlying file handle accepts a partial buffer. */
async function writeAll(handle: NodeFSP.FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await handle.write(data, offset, data.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error("bundle write made no progress");
    offset += result.bytesWritten;
  }
}

/** Reads exactly the requested number of bytes from the handle's current offset. */
async function readExact(handle: NodeFSP.FileHandle, length: number): Promise<Buffer> {
  const data = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(data, offset, length - offset, null);
    if (result.bytesRead <= 0) {
      throw new AgentDesktopBundleError({
        code: "invalid-bundle",
        message: "bundle ended before the declared entry length",
      });
    }
    offset += result.bytesRead;
  }
  return data;
}

/** Encodes and writes one bounded entry header. */
async function writeEntryHeader(handle: NodeFSP.FileHandle, entry: BundleEntry): Promise<void> {
  const header = Buffer.from(JSON.stringify(entry), "utf8");
  if (header.byteLength === 0 || header.byteLength > MAX_HEADER_BYTES) {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: `bundle entry header exceeds ${MAX_HEADER_BYTES} bytes`,
      entryPath: entry.path,
    });
  }
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(header.byteLength);
  await writeAll(handle, length);
  await writeAll(handle, header);
}

/** Rejects entry paths that are ambiguous or can escape the extraction root. */
function validateBundlePath(value: string): ReadonlyArray<string> {
  if (value === ".") return [];
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_ENTRY_PATH_BYTES
  ) {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: `invalid bundle entry path '${value}'`,
      entryPath: value,
    });
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: `invalid bundle entry path '${value}'`,
      entryPath: value,
    });
  }
  return segments;
}

/** Rejects symlink targets that would leave the copied tree. */
function validateSymlinkTarget(entryPath: string, target: string): void {
  if (
    target.length === 0 ||
    target.includes("\0") ||
    target.includes("\\") ||
    Buffer.byteLength(target, "utf8") > MAX_LINK_TARGET_BYTES ||
    NodePath.posix.isAbsolute(target)
  ) {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: `unsafe symlink target at '${entryPath}'`,
      entryPath,
    });
  }
  const base = entryPath === "." ? "." : NodePath.posix.dirname(entryPath);
  const resolved = NodePath.posix.normalize(NodePath.posix.join(base, target));
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: `symlink target escapes the copied tree at '${entryPath}'`,
      entryPath,
    });
  }
}

/** Copies one source file into the bundle while detecting concurrent size changes. */
async function appendFileData(input: {
  readonly sourcePath: string;
  readonly expectedBytes: number;
  readonly output: NodeFSP.FileHandle;
  readonly signal?: AbortSignal;
}): Promise<void> {
  let copiedBytes = 0;
  const stream = NodeFS.createReadStream(input.sourcePath, {
    highWaterMark: COPY_CHUNK_BYTES,
    signal: input.signal,
  });
  for await (const chunk of stream) {
    throwIfAborted(input.signal);
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    copiedBytes += data.byteLength;
    if (copiedBytes > input.expectedBytes) {
      throw new AgentDesktopBundleError({
        code: "source-changed",
        message: `source file grew while it was being copied: ${input.sourcePath}`,
        entryPath: input.sourcePath,
      });
    }
    await writeAll(input.output, data);
  }
  if (copiedBytes !== input.expectedBytes) {
    throw new AgentDesktopBundleError({
      code: "source-changed",
      message: `source file changed while it was being copied: ${input.sourcePath}`,
      entryPath: input.sourcePath,
    });
  }
}

/** Appends one regular file and updates portable bundle counters. */
async function appendRegularFile(input: {
  readonly absolutePath: string;
  readonly bundlePath: string;
  readonly stats: NodeFS.Stats;
  readonly output: NodeFSP.FileHandle;
  readonly counters: PackCounters;
  readonly signal?: AbortSignal;
}): Promise<void> {
  input.counters.entryCount += 1;
  input.counters.fileCount += 1;
  input.counters.logicalBytes += input.stats.size;
  if (input.counters.entryCount > MAX_ENTRY_COUNT) {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: `bundle exceeds ${MAX_ENTRY_COUNT} entries`,
    });
  }
  await writeEntryHeader(input.output, {
    path: input.bundlePath,
    type: "file",
    mode: portableMode(input.stats),
    mtimeMs: input.stats.mtimeMs,
    size: input.stats.size,
  });
  await appendFileData({
    sourcePath: input.absolutePath,
    expectedBytes: input.stats.size,
    output: input.output,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

/** Traverses directories in lexical order and defers symlinks until the end. */
async function appendDirectory(input: {
  readonly absolutePath: string;
  readonly bundlePath: string;
  readonly stats: NodeFS.Stats;
  readonly output: NodeFSP.FileHandle;
  readonly counters: PackCounters;
  readonly symlinks: Array<DeferredSymlink>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(input.signal);
  input.counters.entryCount += 1;
  input.counters.directoryCount += 1;
  if (input.counters.entryCount > MAX_ENTRY_COUNT) {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: `bundle exceeds ${MAX_ENTRY_COUNT} entries`,
    });
  }
  await writeEntryHeader(input.output, {
    path: input.bundlePath,
    type: "directory",
    mode: portableMode(input.stats),
    mtimeMs: input.stats.mtimeMs,
  });
  const children = await NodeFSP.readdir(input.absolutePath, { withFileTypes: true });
  children.sort((left: NodeFS.Dirent, right: NodeFS.Dirent) => left.name.localeCompare(right.name));
  for (const child of children) {
    throwIfAborted(input.signal);
    if (child.name.includes("/") || child.name.includes("\\") || child.name.includes("\0")) {
      throw new AgentDesktopBundleError({
        code: "invalid-entry",
        message: `unsupported file name '${child.name}'`,
        entryPath: child.name,
      });
    }
    const absolutePath = NodePath.join(input.absolutePath, child.name);
    const bundlePath = input.bundlePath === "." ? child.name : `${input.bundlePath}/${child.name}`;
    const stats = await NodeFSP.lstat(absolutePath);
    const type = rootTypeOf(stats, bundlePath);
    if (type === "directory") {
      await appendDirectory({ ...input, absolutePath, bundlePath, stats });
    } else if (type === "file") {
      await appendRegularFile({ ...input, absolutePath, bundlePath, stats });
    } else {
      input.symlinks.push({ absolutePath, bundlePath, stats });
    }
  }
}

/** Appends deferred symlinks without following their targets. */
async function appendSymlinks(input: {
  readonly symlinks: ReadonlyArray<DeferredSymlink>;
  readonly output: NodeFSP.FileHandle;
  readonly counters: PackCounters;
  readonly signal?: AbortSignal;
}): Promise<void> {
  for (const symlink of input.symlinks) {
    throwIfAborted(input.signal);
    input.counters.entryCount += 1;
    input.counters.symlinkCount += 1;
    if (input.counters.entryCount > MAX_ENTRY_COUNT) {
      throw new AgentDesktopBundleError({
        code: "invalid-entry",
        message: `bundle exceeds ${MAX_ENTRY_COUNT} entries`,
      });
    }
    const target = await NodeFSP.readlink(symlink.absolutePath);
    validateSymlinkTarget(symlink.bundlePath, target);
    await writeEntryHeader(input.output, {
      path: symlink.bundlePath,
      type: "symlink",
      mode: portableMode(symlink.stats),
      mtimeMs: symlink.stats.mtimeMs,
      target,
    });
  }
}

/** Builds one uncompressed bundle and returns its source summary. */
async function writeRawBundle(input: {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly signal?: AbortSignal;
}): Promise<AgentDesktopBundleSummary> {
  const sourcePath = NodePath.resolve(input.sourcePath);
  const sourceStats = await NodeFSP.lstat(sourcePath);
  const rootType = rootTypeOf(sourceStats, ".");
  if (rootType === "symlink") {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: "a copied tree root cannot be a symlink",
      entryPath: ".",
    });
  }
  const counters: PackCounters = {
    rootType,
    fileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    logicalBytes: 0,
    entryCount: 0,
  };
  const symlinks: Array<DeferredSymlink> = [];
  const output = await NodeFSP.open(input.outputPath, "wx");
  try {
    await writeAll(output, BUNDLE_MAGIC);
    if (rootType === "directory") {
      await appendDirectory({
        absolutePath: sourcePath,
        bundlePath: ".",
        stats: sourceStats,
        output,
        counters,
        symlinks,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } else if (rootType === "file") {
      await appendRegularFile({
        absolutePath: sourcePath,
        bundlePath: ".",
        stats: sourceStats,
        output,
        counters,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    }
    await appendSymlinks({
      symlinks,
      output,
      counters,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    await writeAll(output, END_HEADER);
    await output.sync();
  } finally {
    await output.close();
  }
  return counters;
}

/** Chooses gzip only when a bounded sample predicts material wire savings. */
async function resolveCompression(input: {
  readonly path: string;
  readonly bytes: number;
  readonly preference: AgentDesktopBundleCompressionPreference;
}): Promise<AgentDesktopBundleCompression> {
  if (input.preference !== "auto") return input.preference;
  if (input.bytes < AUTO_COMPRESSION_MIN_BYTES) return "none";
  const sampleBytes = Math.min(input.bytes, AUTO_COMPRESSION_SAMPLE_BYTES);
  const handle = await NodeFSP.open(input.path, "r");
  try {
    const sample = Buffer.allocUnsafe(sampleBytes);
    const result = await handle.read(sample, 0, sampleBytes, 0);
    const compressed = NodeZlib.gzipSync(sample.subarray(0, result.bytesRead), {
      level: GZIP_LEVEL,
    });
    return compressed.byteLength / result.bytesRead <= AUTO_COMPRESSION_MAX_RATIO ? "gzip" : "none";
  } finally {
    await handle.close();
  }
}

/** Computes one lowercase SHA-256 digest without materializing the file. */
export async function sha256AgentDesktopBundle(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const stream = NodeFS.createReadStream(path, { highWaterMark: COPY_CHUNK_BYTES, signal });
  for await (const chunk of stream) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Packs one file tree into an optionally compressed Agent desktop bundle. */
export async function packAgentDesktopBundle(
  input: PackAgentDesktopBundleInput,
): Promise<AgentDesktopBundlePackResult> {
  const outputPath = NodePath.resolve(input.outputPath);
  const rawPath = `${outputPath}.${NodeCrypto.randomUUID()}.raw`;
  let ownsOutput = false;
  await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
  try {
    const summary = await writeRawBundle({
      sourcePath: input.sourcePath,
      outputPath: rawPath,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const archiveBytes = (await NodeFSP.stat(rawPath)).size;
    const compression = await resolveCompression({
      path: rawPath,
      bytes: archiveBytes,
      preference: input.compression ?? "auto",
    });
    if (compression === "gzip") {
      const output = NodeFS.createWriteStream(outputPath, { flags: "wx" });
      output.once("open", () => {
        ownsOutput = true;
      });
      await NodeStreamPromises.pipeline(
        NodeFS.createReadStream(rawPath, { signal: input.signal }),
        NodeZlib.createGzip({ level: GZIP_LEVEL }),
        output,
        { signal: input.signal },
      );
      await NodeFSP.rm(rawPath, { force: true });
    } else {
      await NodeFSP.link(rawPath, outputPath);
      ownsOutput = true;
      await NodeFSP.rm(rawPath, { force: true });
    }
    const wireBytes = (await NodeFSP.stat(outputPath)).size;
    return {
      ...summary,
      archiveBytes,
      wireBytes,
      compression,
      sha256: await sha256AgentDesktopBundle(outputPath, input.signal),
    };
  } catch (cause) {
    await NodeFSP.rm(rawPath, { force: true }).catch(() => undefined);
    if (ownsOutput) await NodeFSP.rm(outputPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** Parses and validates one JSON entry header. */
function parseEntryHeader(header: Buffer): BundleEntry {
  let value: unknown;
  try {
    value = JSON.parse(header.toString("utf8"));
    return decodeBundleEntry(value);
  } catch (cause) {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: "bundle contains an invalid entry header",
      cause,
    });
  }
}

/** Confirms every existing parent under the fresh staging root is a directory. */
async function ensureSafeParent(root: string, segments: ReadonlyArray<string>): Promise<string> {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = NodePath.join(current, segment);
    const stats = await NodeFSP.lstat(current).catch(() => null);
    if (stats === null) {
      await NodeFSP.mkdir(current, { mode: 0o700 });
    } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AgentDesktopBundleError({
        code: "invalid-entry",
        message: `bundle parent is not a directory: ${segments.join("/")}`,
        entryPath: segments.join("/"),
      });
    }
  }
  return segments.length === 0 ? root : NodePath.join(root, ...segments);
}

/** Copies an exact file payload from the archive into a new staging file. */
async function extractRegularFile(input: {
  readonly archive: NodeFSP.FileHandle;
  readonly destination: string;
  readonly size: number;
  readonly mode: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const output = await NodeFSP.open(input.destination, "wx", input.mode);
  try {
    let remaining = input.size;
    while (remaining > 0) {
      throwIfAborted(input.signal);
      const chunk = await readExact(input.archive, Math.min(remaining, COPY_CHUNK_BYTES));
      await writeAll(output, chunk);
      remaining -= chunk.byteLength;
    }
    await output.sync();
  } finally {
    await output.close();
  }
}

/** Applies portable modification times without following symlinks. */
async function applyEntryTime(path: string, mtimeMs: number): Promise<void> {
  const time = mtimeMs / 1_000;
  await NodeFSP.utimes(path, time, time);
}

/** Moves one staged tree into a destination, replacing conflicting merge entries. */
async function mergeStagedDirectory(stagingPath: string, destinationPath: string): Promise<void> {
  const destinationStats = await NodeFSP.lstat(destinationPath).catch(() => null);
  if (destinationStats === null) {
    await NodeFSP.rename(stagingPath, destinationPath);
    return;
  }
  if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
    throw new AgentDesktopBundleError({
      code: "destination-type-mismatch",
      message: `merge destination is not a directory: ${destinationPath}`,
    });
  }
  const children = await NodeFSP.readdir(stagingPath);
  children.sort((left, right) => left.localeCompare(right));
  for (const child of children) {
    const source = NodePath.join(stagingPath, child);
    const destination = NodePath.join(destinationPath, child);
    const [sourceStats, targetStats] = await Promise.all([
      NodeFSP.lstat(source),
      NodeFSP.lstat(destination).catch(() => null),
    ]);
    if (
      sourceStats.isDirectory() &&
      !sourceStats.isSymbolicLink() &&
      targetStats?.isDirectory() &&
      !targetStats.isSymbolicLink()
    ) {
      await mergeStagedDirectory(source, destination);
    } else {
      if (targetStats !== null) await NodeFSP.rm(destination, { recursive: true, force: true });
      await NodeFSP.rename(source, destination);
    }
  }
  await NodeFSP.rm(stagingPath, { recursive: true, force: true });
}

/** Installs a complete staging tree according to the selected collision policy. */
async function installStaging(input: {
  readonly stagingPath: string;
  readonly destinationPath: string;
  readonly rootType: AgentDesktopBundleRootType;
  readonly collision: AgentDesktopBundleCollision;
}): Promise<void> {
  const destinationStats = await NodeFSP.lstat(input.destinationPath).catch(() => null);
  if (input.collision === "create") {
    if (destinationStats !== null) {
      throw new AgentDesktopBundleError({
        code: "destination-exists",
        message: `destination already exists: ${input.destinationPath}`,
      });
    }
    await NodeFSP.rename(input.stagingPath, input.destinationPath);
    return;
  }
  if (input.collision === "merge") {
    if (input.rootType !== "directory") {
      throw new AgentDesktopBundleError({
        code: "destination-type-mismatch",
        message: "merge requires a directory source",
      });
    }
    await mergeStagedDirectory(input.stagingPath, input.destinationPath);
    return;
  }
  if (destinationStats === null) {
    await NodeFSP.rename(input.stagingPath, input.destinationPath);
    return;
  }
  const backupPath = `${input.destinationPath}.t3-backup-${NodeCrypto.randomUUID()}`;
  await NodeFSP.rename(input.destinationPath, backupPath);
  try {
    await NodeFSP.rename(input.stagingPath, input.destinationPath);
  } catch (cause) {
    await NodeFSP.rename(backupPath, input.destinationPath).catch(() => undefined);
    throw cause;
  }
  await NodeFSP.rm(backupPath, { recursive: true, force: true });
}

/** Extracts one validated raw bundle into a fresh sibling staging path. */
async function extractRawBundle(input: {
  readonly archivePath: string;
  readonly destinationPath: string;
  readonly collision: AgentDesktopBundleCollision;
  readonly allowExternalSymlinks: boolean;
  readonly signal?: AbortSignal;
}): Promise<AgentDesktopBundleExtractResult> {
  const archive = await NodeFSP.open(input.archivePath, "r");
  const stagingPath = `${input.destinationPath}.t3-transfer-${NodeCrypto.randomUUID()}`;
  const seen = new Set<string>();
  const directoryMetadata: Array<{
    readonly path: string;
    readonly mode: number;
    readonly mtimeMs: number;
  }> = [];
  const symlinks: Array<{ readonly path: string; readonly target: string }> = [];
  let rootType: AgentDesktopBundleRootType | null = null;
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let logicalBytes = 0;
  let entryCount = 0;
  let consumedBytes = 0;
  try {
    const magic = await readExact(archive, BUNDLE_MAGIC.byteLength);
    consumedBytes += magic.byteLength;
    if (!magic.equals(BUNDLE_MAGIC)) {
      throw new AgentDesktopBundleError({
        code: "invalid-bundle",
        message: "bundle magic does not match the supported format",
      });
    }
    await NodeFSP.mkdir(NodePath.dirname(input.destinationPath), { recursive: true });
    while (true) {
      throwIfAborted(input.signal);
      const lengthBytes = await readExact(archive, 4);
      consumedBytes += lengthBytes.byteLength;
      const headerLength = lengthBytes.readUInt32BE();
      if (headerLength === 0) break;
      if (headerLength > MAX_HEADER_BYTES) {
        throw new AgentDesktopBundleError({
          code: "invalid-bundle",
          message: `bundle entry header exceeds ${MAX_HEADER_BYTES} bytes`,
        });
      }
      const header = await readExact(archive, headerLength);
      consumedBytes += header.byteLength;
      const entry = parseEntryHeader(header);
      const segments = validateBundlePath(entry.path);
      if (seen.has(entry.path)) {
        throw new AgentDesktopBundleError({
          code: "invalid-entry",
          message: `bundle contains duplicate entry '${entry.path}'`,
          entryPath: entry.path,
        });
      }
      seen.add(entry.path);
      entryCount += 1;
      if (entryCount > MAX_ENTRY_COUNT || (entryCount === 1 && entry.path !== ".")) {
        throw new AgentDesktopBundleError({
          code: "invalid-entry",
          message:
            entryCount > MAX_ENTRY_COUNT
              ? `bundle exceeds ${MAX_ENTRY_COUNT} entries`
              : "the first bundle entry must describe the source root",
          entryPath: entry.path,
        });
      }
      if (rootType === null) rootType = entry.type;
      const destination = await ensureSafeParent(stagingPath, segments);
      if (entry.type === "directory") {
        await NodeFSP.mkdir(destination, { recursive: false, mode: 0o700 });
        directoryMetadata.push({ path: destination, mode: entry.mode, mtimeMs: entry.mtimeMs });
        directoryCount += 1;
      } else if (entry.type === "file") {
        await extractRegularFile({
          archive,
          destination,
          size: entry.size,
          mode: entry.mode,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        consumedBytes += entry.size;
        await applyEntryTime(destination, entry.mtimeMs);
        fileCount += 1;
        logicalBytes += entry.size;
      } else {
        if (entry.path === "." && !input.allowExternalSymlinks) {
          throw new AgentDesktopBundleError({
            code: "invalid-entry",
            message: "a bundle root cannot be a symlink",
            entryPath: entry.path,
          });
        }
        if (!input.allowExternalSymlinks) validateSymlinkTarget(entry.path, entry.target);
        symlinks.push({ path: destination, target: entry.target });
        symlinkCount += 1;
      }
    }
    const archiveBytes = (await archive.stat()).size;
    if (consumedBytes !== archiveBytes || rootType === null) {
      throw new AgentDesktopBundleError({
        code: "invalid-bundle",
        message:
          rootType === null
            ? "bundle contains no root entry"
            : "bundle contains trailing bytes after its terminator",
      });
    }
    for (const symlink of symlinks) {
      await NodeFSP.symlink(symlink.target, symlink.path);
    }
    for (const directory of directoryMetadata.toReversed()) {
      await NodeFSP.chmod(directory.path, directory.mode);
      await applyEntryTime(directory.path, directory.mtimeMs);
    }
    await installStaging({
      stagingPath,
      destinationPath: input.destinationPath,
      rootType,
      collision: input.collision,
    });
    return {
      destinationPath: input.destinationPath,
      rootType,
      fileCount,
      directoryCount,
      symlinkCount,
      logicalBytes,
    };
  } catch (cause) {
    await NodeFSP.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  } finally {
    await archive.close();
  }
}

/** Extracts one Agent desktop bundle with safe staging and collision handling. */
export async function extractAgentDesktopBundle(
  input: ExtractAgentDesktopBundleInput,
): Promise<AgentDesktopBundleExtractResult> {
  const destinationPath = NodePath.resolve(input.destinationPath);
  const rawPath = `${input.archivePath}.${NodeCrypto.randomUUID()}.raw`;
  try {
    const archivePath =
      input.compression === "gzip"
        ? await (async () => {
            await NodeStreamPromises.pipeline(
              NodeFS.createReadStream(input.archivePath, { signal: input.signal }),
              NodeZlib.createGunzip(),
              NodeFS.createWriteStream(rawPath, { flags: "wx" }),
              { signal: input.signal },
            );
            return rawPath;
          })()
        : input.archivePath;
    return await extractRawBundle({
      archivePath,
      destinationPath,
      collision: input.collision ?? "create",
      allowExternalSymlinks: input.allowExternalSymlinks ?? false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } finally {
    await NodeFSP.rm(rawPath, { force: true }).catch(() => undefined);
  }
}

// @effect-diagnostics nodeBuiltinImport:off - This private wire codec needs Node streams and zlib.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { checkTransferName } from "./entryNative.ts";
import type { WorkspaceTransferPath } from "./workspace.ts";
export const BUNDLE_MAGIC = Buffer.from("T3BNDL1\n", "ascii");
export const END_HEADER = Buffer.alloc(4);
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_ENTRY_COUNT = 1_000_000;
const MAX_ENTRY_PATH_BYTES = 16 * 1024;
const MAX_LINK_TARGET_BYTES = 16 * 1024;
export const COPY_CHUNK_BYTES = 1024 * 1024;
export const AUTO_COMPRESSION_SAMPLE_BYTES = 4 * 1024 * 1024;
export const AUTO_COMPRESSION_MIN_BYTES = 64 * 1024;
export const AUTO_COMPRESSION_MAX_RATIO = 0.9;
export const GZIP_LEVEL = 1;

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
export type BundleEntry = typeof BundleEntry.Type;

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
  readonly workspace?: WorkspaceTransferPath;
  readonly maxBytes?: number;
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly compression?: AgentDesktopBundleCompressionPreference;
  readonly signal?: AbortSignal;
}

export interface ExtractAgentDesktopBundleInput {
  readonly workspace?: WorkspaceTransferPath;
  readonly maxBytes?: number;
  readonly beforePublish?: () => Promise<void>;
  readonly loadKoffi?: () => Promise<typeof import("koffi").default>;
  readonly archivePath: string;
  readonly destinationPath: string;
  readonly compression: AgentDesktopBundleCompression;
  readonly collision?: AgentDesktopBundleCollision;
  readonly allowExternalSymlinks?: boolean;
  readonly signal?: AbortSignal;
}

export class AgentDesktopBundleError extends Schema.TaggedError<AgentDesktopBundleError>()(
  "AgentDesktopBundleError",
  {
    code: Schema.Literals([
      "invalid-bundle",
      "invalid-entry",
      "unsupported-entry",
      "destination-exists",
      "destination-type-mismatch",
      "source-changed",
    ]),
    message: Schema.String,
    entryPath: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const isAgentDesktopBundleError = Schema.is(AgentDesktopBundleError);
/** Writes every byte even when the underlying file handle accepts a partial buffer. */
export async function writeAll(handle: NodeFSP.FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await handle.write(data, offset, data.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error("bundle write made no progress");
    offset += result.bytesWritten;
  }
}

/** Reads exactly the requested number of bytes from the handle's current offset. */
export async function readExact(handle: NodeFSP.FileHandle, length: number): Promise<Buffer> {
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
export function entryHeader(entry: BundleEntry): Buffer {
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
  return Buffer.concat([length, header]);
}

/** Rejects entry paths that are ambiguous or can escape the extraction root. */
export function validateBundlePath(value: string): ReadonlyArray<string> {
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
  segments.forEach(checkTransferName);
  return segments;
}

/** Rejects symlink targets that would leave the copied tree. */
export function validateSymlinkTarget(entryPath: string, target: string): void {
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
  for (const segment of target.split("/")) {
    if (segment && segment !== "." && segment !== "..") checkTransferName(segment);
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
/** Parses and validates one JSON entry header. */
export function parseEntryHeader(header: Buffer): BundleEntry {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header));
    return decodeBundleEntry(value);
  } catch (cause) {
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: "bundle contains an invalid entry header",
      cause,
    });
  }
}

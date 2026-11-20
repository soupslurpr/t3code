// @effect-diagnostics nodeBuiltinImport:off - This private wire codec needs Node streams and zlib.
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";
import { fileBytes, openArchiveFile } from "./fileBytes.ts";
import { isDesktopTransferError } from "./errors.ts";
import {
  AgentDesktopBundleError,
  isAgentDesktopBundleError,
  BUNDLE_MAGIC,
  END_HEADER,
  COPY_CHUNK_BYTES,
  MAX_ENTRY_COUNT,
  MAX_HEADER_BYTES,
  parseEntryHeader,
  validateBundlePath,
  validateSymlinkTarget,
  readExact,
  writeAll,
  type AgentDesktopBundleCollision,
  type AgentDesktopBundleRootType,
  type AgentDesktopBundleExtractResult,
  type ExtractAgentDesktopBundleInput,
} from "./format.ts";
import { publishWorkspaceTransfer } from "./publish.ts";
import { existingChild, removePrivateWrapper, type WorkspaceTransferPath } from "./workspace.ts";
import { bindAbsoluteTransfer } from "./absolute.ts";
import { openTransferRoot } from "./entry.ts";
import { checkBytes, boundedBytes, transferByteLimit } from "./bytes.ts";
import { RenameNoReplaceError, isRenameNoReplaceError } from "./renameNoReplace.ts";
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
  readonly onCreated?: (identity: NodeFS.BigIntStats) => void;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const output = await NodeFSP.open(input.destination, "wx", input.mode);
  try {
    input.onCreated?.(await output.stat({ bigint: true }));
    let remaining = input.size;
    while (remaining > 0) {
      input.signal?.throwIfAborted();
      const chunk = await readExact(input.archive, Math.min(remaining, COPY_CHUNK_BYTES));
      await writeAll(output, chunk);
      remaining -= chunk.byteLength;
    }
    await output.chmod(input.mode);
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

async function removeOwnedStaging(
  parent: Awaited<ReturnType<typeof openTransferRoot>>,
  identity: NodeFS.BigIntStats,
) {
  await using entry = await existingChild(parent, "payload");
  if (!entry) return;
  if (entry.identity.dev !== identity.dev || entry.identity.ino !== identity.ino)
    throw new Error("The staged payload changed and was retained.");
  await removePrivateWrapper(parent, entry);
}

/** Extracts one validated raw bundle into a fresh sibling staging path. */
async function extractRawBundle(input: {
  readonly workspace: WorkspaceTransferPath;
  readonly directory: string;
  readonly archive: NodeFSP.FileHandle;
  readonly limit: number;
  readonly beforePublish?: () => Promise<void>;
  readonly loadKoffi?: () => Promise<typeof import("koffi").default>;
  readonly destinationPath: string;
  readonly collision: AgentDesktopBundleCollision;
  readonly allowExternalSymlinks: boolean;
  readonly signal?: AbortSignal;
}): Promise<AgentDesktopBundleExtractResult> {
  const { archive } = input;
  const archiveBytes = (await archive.stat()).size;
  checkBytes(archiveBytes, input.limit);
  await using staging = await openTransferRoot(input.directory, input.workspace.koffi);
  const stagingPath = NodePath.join(input.directory, "payload");
  let stagingIdentity: NodeFS.BigIntStats | undefined;
  const seen = new Set<string>();
  const directoryMetadata: Array<{
    readonly path: string;
    readonly mode: number;
    readonly mtimeMs: number;
  }> = [];
  const symlinks: Array<{
    readonly path: string;
    readonly target: string;
    readonly mtimeMs: number;
  }> = [];
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
    while (true) {
      input.signal?.throwIfAborted();
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
      input.workspace.checkEntry?.(segments);
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
        if (entry.path === ".")
          stagingIdentity = await NodeFSP.lstat(destination, { bigint: true });
        directoryMetadata.push({ path: destination, mode: entry.mode, mtimeMs: entry.mtimeMs });
        directoryCount += 1;
      } else if (entry.type === "file") {
        if (entry.size > archiveBytes - consumedBytes - END_HEADER.length)
          throw new AgentDesktopBundleError({
            code: "invalid-bundle",
            message: "File payload exceeds the remaining archive.",
            entryPath: entry.path,
          });
        await extractRegularFile({
          archive,
          destination,
          size: entry.size,
          mode: entry.mode,
          ...(entry.path === "."
            ? {
                onCreated: (identity: NodeFS.BigIntStats) => {
                  stagingIdentity = identity;
                },
              }
            : {}),
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
        symlinks.push({ path: destination, target: entry.target, mtimeMs: entry.mtimeMs });
        symlinkCount += 1;
      }
    }
    if (
      consumedBytes !== archiveBytes ||
      (await archive.stat()).size !== archiveBytes ||
      rootType === null
    ) {
      throw new AgentDesktopBundleError({
        code: "invalid-bundle",
        message:
          rootType === null
            ? "bundle contains no root entry"
            : "bundle contains trailing bytes after its terminator",
      });
    }
    for (const symlink of symlinks) {
      input.signal?.throwIfAborted();
      await NodeFSP.symlink(symlink.target, symlink.path);
      if (symlink.path === stagingPath)
        stagingIdentity = await NodeFSP.lstat(stagingPath, { bigint: true });
      await NodeFSP.lutimes(symlink.path, symlink.mtimeMs / 1_000, symlink.mtimeMs / 1_000);
    }
    for (const directory of directoryMetadata.reverse()) {
      input.signal?.throwIfAborted();
      await NodeFSP.chmod(directory.path, directory.mode);
      await applyEntryTime(directory.path, directory.mtimeMs);
    }
    input.signal?.throwIfAborted();
    if (!stagingIdentity) throw new Error("No verified payload was staged.");
    await input.beforePublish?.();
    await publishWorkspaceTransfer({
      ...input,
      stagingIdentity,
      stagingPath,
      rootType,
    });
    await removeOwnedStaging(staging, stagingIdentity);
    stagingIdentity = undefined;
    return {
      destinationPath: input.destinationPath,
      rootType,
      fileCount,
      directoryCount,
      symlinkCount,
      logicalBytes,
    };
  } catch (cause) {
    if (stagingIdentity !== undefined) {
      try {
        await removeOwnedStaging(staging, stagingIdentity);
      } catch (cleanupCause) {
        const failure = new AggregateError(
          [cause, cleanupCause],
          `Staging cleanup was not confirmed at ${stagingPath}: ${cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)}. Extraction failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
        if (isAgentDesktopBundleError(cause))
          throw new AgentDesktopBundleError({
            code: cause.code,
            message: failure.message,
            ...(cause.entryPath === undefined ? {} : { entryPath: cause.entryPath }),
            cause: failure,
          });
        if (isRenameNoReplaceError(cause))
          throw new RenameNoReplaceError({
            code: cause.code,
            message: failure.message,
            cause: failure,
          });
        throw failure;
      }
    }
    throw cause;
  }
}

/** Extracts one Agent desktop bundle with safe staging and collision handling. */
export async function extractAgentDesktopBundle(
  input: ExtractAgentDesktopBundleInput,
): Promise<AgentDesktopBundleExtractResult> {
  const limit = transferByteLimit(input.maxBytes);
  const { signal } = input;
  signal?.throwIfAborted();
  if (input.compression !== "gzip" && input.compression !== "none")
    throw new AgentDesktopBundleError({
      code: "invalid-bundle",
      message: "Unsupported bundle compression.",
    });
  const collision = input.collision ?? "create";
  if (collision !== "create" && collision !== "merge" && collision !== "replace")
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: "Unsupported destination collision mode.",
    });
  await using local = input.workspace
    ? null
    : await bindAbsoluteTransfer(input.destinationPath, false, input.loadKoffi);
  const workspace = input.workspace ?? local!;
  const destinationPath = NodePath.resolve(input.destinationPath);
  if (workspace.source || workspace.named !== destinationPath)
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: "Destination differs from its bound import path.",
    });
  await workspace.verify(collision !== "create");
  const archiveParent = await NodeFSP.realpath(
    NodePath.dirname(NodePath.resolve(input.archivePath)),
  );
  const relative = NodePath.relative(
    NodePath.join(workspace.parent.path, ...workspace.names),
    archiveParent,
  );
  if (
    relative !== ".." &&
    !relative.startsWith(".." + NodePath.sep) &&
    !NodePath.isAbsolute(relative)
  )
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: "The destination contains private transfer storage.",
    });
  await using wire = await openArchiveFile(input.archivePath);
  const stats = await wire.stat();
  if (!stats.isFile())
    throw new AgentDesktopBundleError({
      code: "invalid-bundle",
      message: "The archive must be a regular file.",
    });
  checkBytes(stats.size, limit);
  const directory = await NodeFSP.mkdtemp(NodePath.join(archiveParent, ".t3-unpack-"));
  const rawPath = NodePath.join(directory, "raw");
  try {
    await using raw =
      input.compression === "gzip" ? await NodeFSP.open(rawPath, "wx+", 0o600) : null;
    if (raw) {
      await NodeStreamPromises.pipeline(
        fileBytes(wire, stats.size, signal),
        NodeZlib.createGunzip(),
        boundedBytes(limit),
        async (chunks) => {
          let position = 0;
          for await (const chunk of chunks) {
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await raw.write(
                chunk,
                offset,
                chunk.length - offset,
                position,
              );
              if (!bytesWritten) throw new Error("Expanded archive write made no progress.");
              offset += bytesWritten;
              position += bytesWritten;
            }
          }
        },
        { signal },
      );
    }
    return await extractRawBundle({
      ...input,
      workspace,
      directory,
      archive: raw ?? wire,
      destinationPath,
      collision,
      limit,
      allowExternalSymlinks: !input.workspace && (input.allowExternalSymlinks ?? false),
    });
  } catch (cause) {
    if (
      !input.workspace &&
      isDesktopTransferError(cause) &&
      (cause.code === "destination-exists" || cause.code === "destination-type-mismatch")
    )
      throw new AgentDesktopBundleError({ code: cause.code, message: cause.message, cause });
    throw cause;
  } finally {
    await NodeFSP.rm(rawPath, { force: true });
    // A lost publication receipt can leave a recoverable backup in this directory.
    await NodeFSP.rmdir(directory).catch((cause: unknown) => {
      if (
        !(
          cause instanceof Error &&
          "code" in cause &&
          (cause.code === "ENOTEMPTY" || cause.code === "EEXIST")
        )
      )
        throw cause;
    });
  }
}

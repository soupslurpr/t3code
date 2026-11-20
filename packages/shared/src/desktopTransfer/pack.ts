// @effect-diagnostics nodeBuiltinImport:off - Bundles stream between held native entries and private files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import { bindAbsoluteTransfer, existingAncestor } from "./absolute.ts";
import { boundedBytes, checkBytes, transferByteLimit } from "./bytes.ts";
import { openTransferRoot, type BoundTransferEntry } from "./entry.ts";
import { sameEntry } from "./entryNative.ts";
import { stagedFileBytes } from "./fileBytes.ts";
import { renameBoundNoReplace } from "./renameNoReplace.ts";
import {
  AgentDesktopBundleError,
  AUTO_COMPRESSION_MAX_RATIO,
  AUTO_COMPRESSION_MIN_BYTES,
  AUTO_COMPRESSION_SAMPLE_BYTES,
  BUNDLE_MAGIC,
  COPY_CHUNK_BYTES,
  END_HEADER,
  GZIP_LEVEL,
  MAX_ENTRY_COUNT,
  entryHeader,
  validateBundlePath,
  validateSymlinkTarget,
  writeAll,
  type AgentDesktopBundleCompression,
  type AgentDesktopBundleCompressionPreference,
  type AgentDesktopBundlePackResult,
  type PackAgentDesktopBundleInput,
} from "./format.ts";
import type { WorkspaceTransferPath } from "./workspace.ts";

async function packRaw(
  workspace: WorkspaceTransferPath,
  directory: string,
  limit: number,
  signal?: AbortSignal,
) {
  const admitted = workspace.leaf;
  if (!admitted || (admitted.kind !== "file" && admitted.kind !== "directory"))
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: "A bundle source must be a file or directory.",
    });
  // Each export needs its own file offset, including concurrent exports against the same grant.
  const name = workspace.names[0];
  await using root = name
    ? await workspace.parent.child(name, "list")
    : await openTransferRoot(admitted.path, workspace.koffi, "list");
  if (!sameEntry(root.identity, admitted.identity))
    throw new AgentDesktopBundleError({
      code: "source-changed",
      message: "The bound source changed before packing.",
    });
  await using output = await NodeFSP.open(NodePath.join(directory, "raw"), "wx", 0o600);
  await using links = await NodeFSP.open(NodePath.join(directory, "links"), "wx+", 0o600);
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  const summary = {
    rootType: admitted.kind,
    fileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    logicalBytes: 0,
  };
  let archiveBytes = BUNDLE_MAGIC.length + END_HEADER.length;
  checkBytes(archiveBytes, limit);
  await writeAll(output, BUNDLE_MAGIC);

  const visit = async (
    entry: BoundTransferEntry,
    path: string,
    verify: () => Promise<void>,
  ): Promise<void> => {
    signal?.throwIfAborted();
    validateBundlePath(path);
    await verify();
    if (summary.fileCount + summary.directoryCount + summary.symlinkCount >= MAX_ENTRY_COUNT)
      throw new AgentDesktopBundleError({
        code: "invalid-entry",
        message: "Too many bundle entries.",
      });
    const { size, mtimeMs } = entry.stats;
    if (mtimeMs < 0 || !Number.isFinite(mtimeMs))
      throw new AgentDesktopBundleError({
        code: "invalid-entry",
        message: "Unsupported source timestamp.",
        entryPath: path,
      });
    const meta = { mode: entry.stats.mode & 0o777, mtimeMs };
    switch (entry.kind) {
      case "symlink": {
        const target = await entry.linkTarget();
        validateSymlinkTarget(path, target);
        const header = entryHeader({ path, type: "symlink", ...meta, target });
        archiveBytes += header.length;
        checkBytes(archiveBytes, limit);
        await writeAll(links, header);
        summary.symlinkCount++;
        break;
      }
      case "directory": {
        const header = entryHeader({ path, type: "directory", ...meta });
        archiveBytes += header.length;
        checkBytes(archiveBytes, limit);
        await writeAll(output, header);
        summary.directoryCount++;
        const slots =
          MAX_ENTRY_COUNT - summary.fileCount - summary.directoryCount - summary.symlinkCount;
        const names = await entry.names(Math.min(slots, limit - archiveBytes) + 1, signal);
        if (names.length > slots)
          throw new AgentDesktopBundleError({
            code: "invalid-entry",
            message: "Too many bundle entries.",
          });
        checkBytes(archiveBytes + names.length, limit);
        names.sort((a, b) => a.localeCompare(b));
        for (const name of names) {
          signal?.throwIfAborted();
          const relative = path === "." ? name : path + "/" + name;
          validateBundlePath(relative);
          await using child = await entry.child(name, "list");
          await visit(child, relative, async () => {
            await verify();
            await using current = await entry.child(name);
            if (!sameEntry(child.identity, current.identity))
              throw new AgentDesktopBundleError({
                code: "source-changed",
                message: "The source entry changed during packing.",
                entryPath: relative,
              });
          });
        }
        break;
      }
      case "file": {
        checkBytes(size, limit);
        const header = entryHeader({ path, type: "file", ...meta, size });
        archiveBytes += header.length + size;
        checkBytes(archiveBytes, limit);
        await writeAll(output, header);
        let remaining = size;
        for (;;) {
          signal?.throwIfAborted();
          const count = await entry.read(
            buffer.subarray(0, Math.min(buffer.length, remaining + 1)),
          );
          if (count > remaining || (count === 0 && remaining !== 0))
            throw new AgentDesktopBundleError({
              code: "source-changed",
              message: "The source file changed size during packing.",
              entryPath: path,
            });
          if (!count) break;
          await writeAll(output, buffer.subarray(0, count));
          remaining -= count;
        }
        summary.fileCount++;
        summary.logicalBytes += size;
        break;
      }
      default:
        throw new AgentDesktopBundleError({
          code: "unsupported-entry",
          message: "Unsupported source entry type.",
          entryPath: path,
        });
    }
    await verify();
  };
  await visit(root, ".", workspace.verify);
  for (let position = 0; ;) {
    signal?.throwIfAborted();
    const { bytesRead } = await links.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    await writeAll(output, buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  await writeAll(output, END_HEADER);
  await output.sync();
  return { ...summary, archiveBytes };
}

async function compressionFor(
  path: string,
  bytes: number,
  preference: AgentDesktopBundleCompressionPreference,
): Promise<AgentDesktopBundleCompression> {
  if (preference !== "auto") return preference;
  if (bytes < AUTO_COMPRESSION_MIN_BYTES) return "none";
  await using file = await NodeFSP.open(path, "r");
  const sample = Buffer.allocUnsafe(Math.min(bytes, AUTO_COMPRESSION_SAMPLE_BYTES));
  const { bytesRead } = await file.read(sample);
  return NodeZlib.gzipSync(sample.subarray(0, bytesRead), { level: GZIP_LEVEL }).length <=
    bytesRead * AUTO_COMPRESSION_MAX_RATIO
    ? "gzip"
    : "none";
}

export async function sha256AgentDesktopBundle(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of stagedFileBytes(path, transferByteLimit(), signal)) hash.update(chunk);
  return hash.digest("hex");
}

export async function packAgentDesktopBundle(
  input: PackAgentDesktopBundleInput,
): Promise<AgentDesktopBundlePackResult> {
  const limit = transferByteLimit(input.maxBytes);
  const signal = input.signal;
  signal?.throwIfAborted();
  const preference = input.compression ?? "auto";
  if (preference !== "auto" && preference !== "gzip" && preference !== "none")
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: "Unsupported bundle compression.",
    });
  await using local = input.workspace ? null : await bindAbsoluteTransfer(input.sourcePath, true);
  const workspace = input.workspace ?? local!;
  if (!workspace.source || NodePath.resolve(input.sourcePath) !== workspace.named)
    throw new AgentDesktopBundleError({
      code: "invalid-entry",
      message: "Source path differs from the bound source.",
    });
  await workspace.verify();
  const parent = NodePath.dirname(NodePath.resolve(input.outputPath));
  const checkParent = async (existing: string) => {
    if (workspace.leaf?.kind !== "directory") return;
    const relative = NodePath.relative(workspace.leaf.path, await NodeFSP.realpath(existing));
    if (
      relative !== ".." &&
      !relative.startsWith(".." + NodePath.sep) &&
      !NodePath.isAbsolute(relative)
    )
      throw new AgentDesktopBundleError({
        code: "invalid-entry",
        message: "The copied directory contains transfer staging.",
      });
  };
  const ancestor = await existingAncestor(parent);
  await checkParent(ancestor);
  if (ancestor !== parent) {
    await NodeFSP.mkdir(parent, { recursive: true });
    await checkParent(parent);
  }
  const directory = await NodeFSP.mkdtemp(NodePath.join(parent, ".t3-pack-"));
  try {
    const raw = NodePath.join(directory, "raw");
    const summary = await packRaw(workspace, directory, limit, signal);
    const compression = await compressionFor(raw, summary.archiveBytes, preference);
    const archive = compression === "gzip" ? NodePath.join(directory, "wire") : raw;
    if (compression === "gzip") {
      await NodeStreamPromises.pipeline(
        NodeFS.createReadStream(raw),
        NodeZlib.createGzip({ level: GZIP_LEVEL }),
        boundedBytes(limit),
        NodeFS.createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        { signal },
      );
    }
    const wireBytes = (await NodeFSP.stat(archive)).size;
    const sha256 = await sha256AgentDesktopBundle(archive, signal);
    await using outputParent = await openTransferRoot(
      await NodeFSP.realpath(parent),
      workspace.koffi,
    );
    await using staging = await outputParent.child(NodePath.basename(directory));
    const name = NodePath.basename(archive);
    await using staged = await staging.child(name);
    await workspace.verify();
    await renameBoundNoReplace({
      root: outputParent,
      sourceParent: staging,
      source: name,
      sourceIdentity: staged.identity,
      destinationParent: outputParent,
      destination: NodePath.basename(input.outputPath),
      koffi: workspace.koffi,
      ...(signal ? { signal } : {}),
    });
    return { ...summary, compression, wireBytes, sha256 };
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

/** Bounded archive I/O shared by the environment server and native desktop. */
// @effect-diagnostics nodeBuiltinImport:off - Streaming filesystem boundary shared with Electron.
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type { DesktopTransferManifest, UserDesktopTransferFailure } from "@t3tools/contracts";

export class DesktopTransferError extends Error {
  readonly code: UserDesktopTransferFailure["code"];
  constructor(code: UserDesktopTransferFailure["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "DesktopTransferError";
  }
}

/** A stalled peer must not prevent cancellation or retain the staged file. */
function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    iterator.next().then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Writes exactly the advertised bytes and verifies them before extraction is possible. */
export async function receiveDesktopTransferArchive(input: {
  readonly archivePath: string;
  readonly manifest: DesktopTransferManifest;
  readonly body: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
}): Promise<void> {
  input.signal.throwIfAborted();
  const file = await NodeFSP.open(input.archivePath, "wx", 0o600);
  let verified = false;
  const iterator = input.body[Symbol.asyncIterator]();
  try {
    const hash = NodeCrypto.createHash("sha256");
    let bytes = 0;
    while (true) {
      const next = await nextChunk(iterator, input.signal);
      if (next.done) break;
      const chunk = next.value;
      input.signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > input.manifest.wireBytes) {
        throw new DesktopTransferError("integrity-failed", "Transfer exceeds its advertised size.");
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        input.signal.throwIfAborted();
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten === 0)
          throw new DesktopTransferError("transport-failed", "Archive write made no progress.");
        offset += bytesWritten;
      }
      input.onProgress?.(bytes);
    }
    input.signal.throwIfAborted();
    if (bytes !== input.manifest.wireBytes || hash.digest("hex") !== input.manifest.sha256) {
      throw new DesktopTransferError(
        "integrity-failed",
        "Transfer size or SHA-256 does not match its manifest.",
      );
    }
    await file.sync();
    verified = true;
  } finally {
    // Returning an async iterator can itself wait for a stalled peer. Closing the file must not.
    void iterator.return?.().catch(() => undefined);
    try {
      await file.close();
    } finally {
      if (!verified) await NodeFSP.rm(input.archivePath, { force: true });
    }
  }
}

/** Streams an immutable staged archive without buffering it in JSON or renderer memory. */
export async function* desktopTransferArchiveChunks(input: {
  readonly archivePath: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
}): AsyncGenerator<Uint8Array> {
  const stream = NodeFS.createReadStream(input.archivePath, {
    highWaterMark: 64 * 1024,
    signal: input.signal,
  });
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      input.signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array))
        throw new DesktopTransferError("transport-failed", "Expected binary archive data.");
      bytes += chunk.byteLength;
      input.onProgress?.(bytes);
      yield chunk;
    }
  } finally {
    stream.destroy();
  }
}

/** Resolves a transfer within a workspace, including existing symlink ancestors. */
export async function resolveDesktopTransferWorkspacePath(
  rootPath: string,
  relativePath: string,
  source: boolean,
): Promise<string> {
  const code = source ? "invalid-source" : "invalid-destination";
  const fail = () =>
    new DesktopTransferError(
      code,
      "Workspace paths must stay inside the current thread workspace; the destination must be a child path.",
    );
  const root = NodePath.resolve(rootPath);
  const candidate = NodePath.resolve(root, relativePath);
  const within = (base: string, value: string) => {
    const relative = NodePath.relative(base, value);
    return (
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative)
    );
  };
  if (
    NodePath.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    !within(root, candidate) ||
    (!source && root === candidate)
  )
    throw fail();
  const canonicalRoot = await NodeFSP.realpath(root);
  let ancestor = source ? candidate : NodePath.dirname(candidate);
  if (!source) {
    while (true) {
      try {
        await NodeFSP.lstat(ancestor);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        const parent = NodePath.dirname(ancestor);
        if (parent === ancestor) throw fail();
        ancestor = parent;
      }
    }
  }
  if (!within(canonicalRoot, await NodeFSP.realpath(ancestor))) throw fail();
  return candidate;
}

/** Reads Fetch response bytes with backpressure and releases the reader on cancellation. */
export async function* desktopTransferResponseChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Removes only expired private staging directories after a crash; transfers last at most six hours. */
export async function pruneDesktopTransferStaging(
  directory: string,
  prefix: "session-" | "transfer-",
  nowMs: number,
): Promise<void> {
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const path = NodePath.join(directory, entry.name);
    const stats = await NodeFSP.stat(path).catch(() => null);
    if (stats !== null && nowMs - stats.mtimeMs > 24 * 60 * 60 * 1000)
      await NodeFSP.rm(path, { recursive: true, force: true });
  }
}

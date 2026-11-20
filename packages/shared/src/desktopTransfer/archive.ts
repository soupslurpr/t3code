// @effect-diagnostics nodeBuiltinImport:off - These streams connect private staging to the transfer transport.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import type { DesktopTransferManifest } from "@t3tools/contracts";
import { loadTransferKoffi } from "./absolute.ts";
import { boundedBytes, checkBytes, integrity, transferByteLimit } from "./bytes.ts";
import { openTransferRoot } from "./entry.ts";
import { DesktopTransferError, isDesktopTransferError } from "./errors.ts";
import { fileBytes, stagedFileBytes } from "./fileBytes.ts";
import { existingChild, removePrivateWrapper } from "./workspace.ts";

export interface ReceiveDesktopTransferArchiveInput {
  readonly archivePath: string;
  readonly manifest: DesktopTransferManifest;
  readonly body: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
  readonly maxBytes?: number;
}

export interface DesktopTransferArchiveChunksInput {
  readonly archivePath: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
  readonly maxBytes?: number;
}

function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return iterator.next();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function receiveDesktopTransferArchive(
  input: ReceiveDesktopTransferArchiveInput,
): Promise<void> {
  const { manifest, signal } = input;
  const limit = transferByteLimit(input.maxBytes);
  signal.throwIfAborted();
  checkBytes(manifest.wireBytes, limit);
  checkBytes(manifest.archiveBytes, limit);
  checkBytes(manifest.logicalBytes, limit);
  if (
    manifest.logicalBytes > manifest.archiveBytes ||
    (manifest.compression !== "gzip" && manifest.compression !== "none") ||
    (manifest.compression === "none" && manifest.archiveBytes !== manifest.wireBytes) ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256)
  )
    throw integrity("Invalid transfer manifest compression, sizes or digest.");
  const file = await NodeFSP.open(input.archivePath, "wx+", 0o600);
  let verified = false;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  try {
    iterator = input.body[Symbol.asyncIterator]();
    const hash = NodeCrypto.createHash("sha256");
    let bytes = 0;
    for (;;) {
      const next = await nextChunk(iterator, signal);
      if (next.done) break;
      const chunk = next.value;
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw integrity("Expected binary transfer data.");
      bytes += chunk.byteLength;
      if (bytes > manifest.wireBytes) throw integrity("Transfer exceeds its advertised wire size.");
      // The producer owns its chunk. Hash the bytes which are actually written to disk.
      for (let offset = 0; offset < chunk.length;) {
        signal.throwIfAborted();
        const data = Buffer.from(chunk.subarray(offset, offset + 64 * 1024));
        hash.update(data);
        let written = 0;
        while (written < data.length) {
          signal.throwIfAborted();
          const { bytesWritten } = await file.write(data, written, data.length - written);
          if (!bytesWritten)
            throw new DesktopTransferError({
              code: "transport-failed",
              message: "Archive write made no progress.",
            });
          written += bytesWritten;
        }
        offset += data.length;
      }
      input.onProgress?.(bytes);
    }
    signal.throwIfAborted();
    if (bytes !== manifest.wireBytes || hash.digest("hex") !== manifest.sha256)
      throw integrity("Transfer size or SHA-256 differs from its manifest.");
    if (manifest.compression === "gzip") {
      try {
        await NodeStreamPromises.pipeline(
          fileBytes(file, bytes, signal),
          NodeZlib.createGunzip(),
          boundedBytes(limit, manifest.archiveBytes),
          async (chunks) => {
            for await (const _chunk of chunks) signal.throwIfAborted();
          },
          { signal },
        );
      } catch (cause) {
        signal.throwIfAborted();
        if (isDesktopTransferError(cause)) throw cause;
        throw integrity("Invalid gzip transfer archive.");
      }
    }
    await file.sync();
    signal.throwIfAborted();
    verified = true;
  } finally {
    if (iterator?.return) {
      const active = iterator;
      void Promise.resolve()
        .then(() => active.return?.())
        .catch(() => undefined);
    }
    try {
      // The staging name may already have been retired and reused by a concurrent request.
      if (!verified) {
        const owned = await file.stat({ bigint: true });
        const named = await NodeFSP.lstat(input.archivePath, { bigint: true }).catch(() => null);
        if (named?.dev === owned.dev && named.ino === owned.ino)
          await NodeFSP.unlink(input.archivePath);
      }
    } finally {
      await file.close();
    }
  }
}

export async function* desktopTransferArchiveChunks(
  input: DesktopTransferArchiveChunksInput,
): AsyncGenerator<Uint8Array> {
  const { signal } = input;
  const limit = transferByteLimit(input.maxBytes);
  let bytes = 0;
  for await (const chunk of stagedFileBytes(input.archivePath, limit, signal)) {
    bytes += chunk.length;
    input.onProgress?.(bytes);
    yield chunk;
  }
}

export function desktopTransferResponseChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  async function* read(): AsyncGenerator<Uint8Array> {
    const active = body.getReader();
    reader = active;
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await active.read();
        if (chunk.done) return;
        bytes += chunk.value.length;
        checkBytes(bytes, transferByteLimit());
        yield chunk.value;
      }
    } finally {
      reader = undefined;
      const cancelled = active.cancel().catch(() => undefined);
      active.releaseLock();
      void cancelled;
    }
  }
  const chunks = read();
  const finish = chunks.return.bind(chunks);
  chunks.return = (value) => {
    // AsyncGenerator.return queues behind an in-flight read. Cancel that read immediately.
    if (reader) void reader.cancel().catch(() => undefined);
    return finish(value);
  };
  return chunks;
}

export async function pruneDesktopTransferStaging(
  directory: string,
  prefix: "session-" | "transfer-",
  nowMs: number,
): Promise<void> {
  await using parent = await openTransferRoot(
    await NodeFSP.realpath(directory),
    await loadTransferKoffi(),
    "list",
  );
  for (const name of await parent.names()) {
    if (!name.startsWith(prefix)) continue;
    await using entry = await existingChild(parent, name);
    if (entry?.kind === "directory" && nowMs - entry.stats.mtimeMs > 24 * 60 * 60 * 1000)
      await removePrivateWrapper(parent, entry);
  }
}

export function isDesktopTransferCancellation(cause: unknown, reason: unknown): boolean {
  const local = (value: unknown) =>
    value === reason ||
    (value instanceof Error &&
      value.name === "AbortError" &&
      "code" in value &&
      value.code === "ABORT_ERR" &&
      value.cause === reason);
  return (
    local(cause) ||
    (cause instanceof AggregateError &&
      cause.errors.length === 2 &&
      cause.cause === cause.errors[0] &&
      local(cause.cause))
  );
}

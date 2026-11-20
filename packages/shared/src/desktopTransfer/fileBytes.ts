// @effect-diagnostics nodeBuiltinImport:off - Positioned reads leave the caller's descriptor open.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import { checkBytes, integrity } from "./bytes.ts";

export async function openArchiveFile(path: string) {
  const file = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0) |
      (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  if (!NodeFS.constants.O_NOFOLLOW) {
    try {
      const opened = await file.stat({ bigint: true });
      const named = await NodeFSP.lstat(path, { bigint: true });
      if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino)
        throw integrity("The staged archive must be an identifiable regular file.");
    } catch (cause) {
      await file.close();
      throw cause;
    }
  }
  return file;
}

export async function* stagedFileBytes(path: string, limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await using file = await openArchiveFile(path);
  const stats = await file.stat();
  if (!stats.isFile()) throw integrity("The staged archive must be a regular file.");
  checkBytes(stats.size, limit);
  yield* fileBytes(file, stats.size, signal);
}

export async function* fileBytes(file: NodeFSP.FileHandle, size: number, signal?: AbortSignal) {
  for (let position = 0; ;) {
    signal?.throwIfAborted();
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - position + 1));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    signal?.throwIfAborted();
    if (!bytesRead) {
      if (position !== size) throw integrity("The staged archive changed size.");
      return;
    }
    position += bytesRead;
    if (position > size) throw integrity("The staged archive grew during transmission.");
    yield buffer.subarray(0, bytesRead);
  }
}

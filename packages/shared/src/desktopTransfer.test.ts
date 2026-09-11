// @effect-diagnostics nodeBuiltinImport:off - Verifies exact byte streams and real symlink resolution.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { DesktopTransferManifest } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  pruneDesktopTransferStaging,
  receiveDesktopTransferArchive,
  resolveDesktopTransferWorkspacePath,
} from "./desktopTransfer.ts";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
});
async function temporary() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-transfer-io-test-"));
  directories.push(directory);
  return directory;
}
const data = Buffer.from("exact binary \0 →");
const manifest: DesktopTransferManifest = {
  rootType: "file",
  fileCount: 1,
  directoryCount: 0,
  symlinkCount: 0,
  logicalBytes: data.length,
  archiveBytes: data.length,
  wireBytes: data.length,
  compression: "none",
  sha256: NodeCrypto.createHash("sha256").update(data).digest("hex"),
};
async function* chunks(...values: Uint8Array[]) {
  yield* values;
}
describe("desktop transfer archive I/O", () => {
  it("prunes expired crash staging while retaining active and unrelated directories", async () => {
    const directory = await temporary();
    for (const name of ["transfer-expired", "transfer-active", "unrelated"])
      await NodeFSP.mkdir(NodePath.join(directory, name));
    await NodeFSP.utimes(NodePath.join(directory, "transfer-expired"), 0, 0);
    await NodeFSP.utimes(NodePath.join(directory, "unrelated"), 0, 0);
    await NodeFSP.symlink(await temporary(), NodePath.join(directory, "transfer-link"));
    await pruneDesktopTransferStaging(directory, "transfer-", 2 * 24 * 60 * 60 * 1000);
    expect((await NodeFSP.readdir(directory)).toSorted()).toEqual([
      "transfer-active",
      "transfer-link",
      "unrelated",
    ]);
  });
  it("cancels a peer that stops sending bytes without waiting for another chunk", async () => {
    const archivePath = NodePath.join(await temporary(), "archive");
    const entered = Promise.withResolvers<void>();
    const abort = new AbortController();
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          entered.resolve();
          return new Promise(() => undefined);
        },
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      }),
    };
    const running = receiveDesktopTransferArchive({
      archivePath,
      manifest,
      body,
      signal: abort.signal,
    });
    const rejected = expect(running).rejects.toBeDefined();
    await entered.promise;
    abort.abort();
    await rejected;
    expect(returned).toBe(true);
    await expect(NodeFSP.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    data.subarray(1),
    Buffer.concat([data, Buffer.from("extra")]),
    Buffer.alloc(data.length),
  ])(
    "rejects incomplete, oversized and corrupt archives and removes the partial file",
    async (bytes) => {
      const archivePath = NodePath.join(await temporary(), "archive");
      await expect(
        receiveDesktopTransferArchive({
          archivePath,
          manifest,
          body: chunks(bytes),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "integrity-failed" });
      await expect(NodeFSP.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("writes exact chunks and cleans up when cancelled mid-stream", async () => {
    const archivePath = NodePath.join(await temporary(), "archive");
    const abort = new AbortController();
    await receiveDesktopTransferArchive({
      archivePath,
      manifest,
      body: chunks(data.subarray(0, 2), data.subarray(2)),
      signal: abort.signal,
    });
    expect(await NodeFSP.readFile(archivePath)).toEqual(data);
    await NodeFSP.rm(archivePath);
    async function* cancelled() {
      yield data.subarray(0, 2);
      abort.abort();
      yield data.subarray(2);
    }
    await expect(
      receiveDesktopTransferArchive({
        archivePath,
        manifest,
        body: cancelled(),
        signal: abort.signal,
      }),
    ).rejects.toBeDefined();
    await expect(NodeFSP.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("confines workspace sources and destination ancestors including symlinks", async () => {
    const workspace = await temporary();
    const outside = await temporary();
    await NodeFSP.writeFile(NodePath.join(outside, "source"), data);
    await NodeFSP.symlink(outside, NodePath.join(workspace, "escape"));
    await expect(
      resolveDesktopTransferWorkspacePath(workspace, "../escape", false),
    ).rejects.toMatchObject({ code: "invalid-destination" });
    await expect(resolveDesktopTransferWorkspacePath(workspace, ".", false)).rejects.toMatchObject({
      code: "invalid-destination",
    });
    await expect(
      resolveDesktopTransferWorkspacePath(workspace, "escape/new/file", false),
    ).rejects.toMatchObject({ code: "invalid-destination" });
    await expect(
      resolveDesktopTransferWorkspacePath(workspace, "escape/source", true),
    ).rejects.toMatchObject({ code: "invalid-source" });
    expect(await resolveDesktopTransferWorkspacePath(workspace, "new/file", false)).toBe(
      NodePath.join(workspace, "new/file"),
    );
  });
});

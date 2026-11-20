// @effect-diagnostics nodeBuiltinImport:off - These tests exercise the transfer's real private staging.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeZlib from "node:zlib";
import { expect, it } from "@effect/vitest";
import type { DesktopTransferManifest } from "@t3tools/contracts";
import {
  MAX_DESKTOP_TRANSFER_BYTES,
  desktopTransferArchiveChunks,
  desktopTransferResponseChunks,
  extractAgentDesktopBundle,
  isDesktopTransferCancellation,
  packAgentDesktopBundle,
  pruneDesktopTransferStaging,
  receiveDesktopTransferArchive,
  sha256AgentDesktopBundle,
} from "./index.ts";
import { onTransferMount, sameEntry } from "./entryNative.ts";

const temp = () => NodeFSP.mkdtempDisposable(NodePath.join(NodeOS.tmpdir(), "t3-transfer-io-"));
const manifest = (
  wire: Buffer,
  raw: Buffer,
  compression: DesktopTransferManifest["compression"],
): DesktopTransferManifest => ({
  fileCount: 1,
  directoryCount: 0,
  symlinkCount: 0,
  rootType: "file",
  logicalBytes: 0,
  wireBytes: wire.length,
  archiveBytes: raw.length,
  compression,
  sha256: NodeCrypto.createHash("sha256").update(wire).digest("hex"),
});
async function* chunks(...data: Uint8Array[]) {
  yield* data;
}

it("accepts exact wire and expanded bytes and removes incomplete, corrupt or oversized staging", async () => {
  await using directory = await temp();
  const archivePath = NodePath.join(directory.path, "received");
  const raw = Buffer.alloc(128 * 1024, 41);
  const gz = NodeZlib.gzipSync(raw);
  const signal = new AbortController().signal;
  const good = manifest(gz, raw, "gzip");
  for (const [declared, wire] of [
    [{ ...good, wireBytes: gz.length - 1 }, gz],
    [{ ...good, wireBytes: gz.length + 1 }, gz],
    [{ ...good, sha256: "f".repeat(64) }, gz],
    [{ ...good, archiveBytes: raw.length - 1 }, gz],
    [{ ...good, archiveBytes: raw.length + 1 }, gz],
    [manifest(Buffer.from("wrong format"), raw, "gzip"), Buffer.from("wrong format")],
  ] as const) {
    await expect(
      receiveDesktopTransferArchive({
        archivePath,
        manifest: declared,
        signal,
        body: chunks(wire),
      }),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await NodeFSP.readdir(directory.path)).toEqual([]);
  }
  for (const [metadata, wire] of [
    [good, gz],
    [manifest(raw, raw, "none"), raw],
  ] as const) {
    const progress: number[] = [];
    await receiveDesktopTransferArchive({
      archivePath,
      manifest: metadata,
      signal,
      body: chunks(wire.subarray(0, 2), wire.subarray(2)),
      onProgress: (n) => progress.push(n),
    });
    expect(progress).toEqual([2, wire.length]);
    const result = [];
    for await (const bytes of desktopTransferArchiveChunks({ archivePath, signal }))
      result.push(bytes);
    expect(Buffer.concat(result)).toEqual(wire);
    await expect(
      receiveDesktopTransferArchive({
        archivePath,
        manifest: metadata,
        signal,
        body: chunks(wire),
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await NodeFSP.unlink(archivePath);
  }
});

it("cancels a stalled response reader and promptly releases its staging file", async () => {
  await using directory = await temp();
  const archivePath = NodePath.join(directory.path, "partial");
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        entered.resolve();
      },
      cancel() {
        cancelled.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  const abort = new AbortController();
  const stop = new Error("cancel transfer");
  const receiving = receiveDesktopTransferArchive({
    archivePath,
    manifest: manifest(Buffer.from("a"), Buffer.from("a"), "none"),
    signal: abort.signal,
    body: desktopTransferResponseChunks(stream),
  });
  const rejection = expect(receiving).rejects.toBe(stop);
  await entered.promise;
  abort.abort(stop);
  await Promise.all([rejection, cancelled.promise]);
  expect(stream.locked).toBe(false);
  expect(await NodeFSP.readdir(directory.path)).toEqual([]);
  expect(isDesktopTransferCancellation(stop, stop)).toBe(true);
  expect(
    isDesktopTransferCancellation(new Error("uncertain publication", { cause: stop }), stop),
  ).toBe(false);
});

it("honors a lower negotiated limit independently for wire, expanded archives and packed bundles", async () => {
  await using directory = await temp();
  const archivePath = NodePath.join(directory.path, "archive");
  const source = NodePath.join(directory.path, "source");
  const target = NodePath.join(directory.path, "dest");
  const data = Buffer.alloc(256 * 1024, 7);
  await NodeFSP.writeFile(source, data);
  await expect(
    packAgentDesktopBundle({
      sourcePath: source,
      outputPath: archivePath,
      compression: "gzip",
      maxBytes: data.length,
    }),
  ).rejects.toMatchObject({ code: "resource-exhausted" });
  const packed = await packAgentDesktopBundle({
    sourcePath: source,
    outputPath: archivePath,
    compression: "gzip",
  });
  await expect(
    extractAgentDesktopBundle({
      archivePath,
      destinationPath: target,
      compression: "gzip",
      maxBytes: packed.archiveBytes - 1,
    }),
  ).rejects.toMatchObject({ code: "resource-exhausted" });
  await expect(
    receiveDesktopTransferArchive({
      archivePath: target,
      manifest: packed,
      body: chunks(),
      signal: new AbortController().signal,
      maxBytes: packed.archiveBytes - 1,
    }),
  ).rejects.toMatchObject({ code: "resource-exhausted" });
  await NodeFSP.truncate(source, MAX_DESKTOP_TRANSFER_BYTES + 1);
  await expect(sha256AgentDesktopBundle(source)).rejects.toMatchObject({
    code: "resource-exhausted",
  });
  await expect(
    packAgentDesktopBundle({ sourcePath: source, outputPath: target, compression: "none" }),
  ).rejects.toMatchObject({ code: "resource-exhausted" });
  await expect(
    extractAgentDesktopBundle({
      archivePath: source,
      destinationPath: target,
      compression: "none",
      maxBytes: Number.MAX_SAFE_INTEGER,
    }),
  ).rejects.toMatchObject({ code: "resource-exhausted" });
  expect((await NodeFSP.readdir(directory.path)).toSorted()).toEqual(["archive", "source"]);
});

it("prunes only expired staging directories and compares mount identity independently of backing files", async () => {
  await using directory = await temp();
  const old = NodePath.join(directory.path, "transfer-old");
  const active = NodePath.join(directory.path, "transfer-active");
  const other = NodePath.join(directory.path, "unrelated");
  for (const path of [old, active, other]) await NodeFSP.mkdir(path);
  await NodeFSP.writeFile(NodePath.join(old, "data"), "old");
  const now = 1700000000;
  await NodeFSP.utimes(old, 100, 100);
  await NodeFSP.utimes(other, 100, 100);
  await NodeFSP.utimes(active, now, now);
  if (NodeProcess.platform !== "win32")
    await NodeFSP.symlink(other, NodePath.join(directory.path, "transfer-link"));
  await pruneDesktopTransferStaging(directory.path, "transfer-", now * 1000);
  expect((await NodeFSP.readdir(directory.path)).toSorted()).toEqual(
    NodeProcess.platform === "win32"
      ? ["transfer-active", "unrelated"]
      : ["transfer-active", "transfer-link", "unrelated"],
  );
  if (NodeProcess.platform === "linux") {
    const parent = { identity: { dev: 10n, ino: 2n, mountId: 9n }, kind: "directory" as const };
    const backingFile = { identity: { dev: 11n, ino: 3n, mountId: 9n }, kind: "file" as const };
    expect(onTransferMount(backingFile, parent)).toBe(true);
    expect(onTransferMount({ ...backingFile, kind: "directory" }, parent)).toBe(false);
    expect(
      onTransferMount(
        { ...backingFile, identity: { ...backingFile.identity, mountId: 8n } },
        parent,
      ),
    ).toBe(false);
    expect(sameEntry(parent.identity, { ...parent.identity, mountId: 8n })).toBe(false);
  }
});

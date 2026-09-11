// @effect-diagnostics nodeBuiltinImport:off - Native streaming integration against a real HTTP listener.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DESKTOP_TRANSFER_MANIFEST_HEADER,
  DESKTOP_TRANSFER_ROUTE_PREFIX,
  DesktopTransferManifest,
  type UserDesktopTransferRequest,
} from "@t3tools/contracts";
import {
  packAgentDesktopBundle,
  extractAgentDesktopBundle,
} from "@t3tools/shared/agentDesktopBundle";
import { receiveDesktopTransferArchive } from "@t3tools/shared/desktopTransfer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { DesktopTransferManager } from "./DesktopTransferManager.ts";

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopTransferManifest));
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const owner = { environmentId: "environment", threadId: "thread" };
const desktop = { kind: "user", desktopId: "test-desktop" } as const;
const token = "a".repeat(64);
type Run = Extract<UserDesktopTransferRequest, { operation: "run" }>;

async function fixture(handler: NodeHttp.RequestListener) {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-native-transfer-test-"),
  );
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const manager = new DesktopTransferManager({
    directory: NodePath.join(directory, "staging"),
    now: () => 0,
    homeDirectory: directory,
  });
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await manager.revoke();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  const request: Run = {
    operation: "run",
    desktop,
    transferId: "transfer-test",
    direction: "to-desktop",
    desktopPath: "received",
    collision: "create",
    compression: "auto",
    timeoutMs: 30_000,
    token,
    url: `http://127.0.0.1:${address.port}${DESKTOP_TRANSFER_ROUTE_PREFIX}/transfer-test`,
  };
  return { directory, manager, request };
}

describe("native desktop file transfers", () => {
  it("round trips a binary directory through HTTP with exact bytes and internal symlinks", async () => {
    let archive = "";
    let incomingArchive = "";
    const uploaded = Promise.withResolvers<DesktopTransferManifest>();
    const { directory, manager, request } = await fixture((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      if (req.method === "GET") {
        NodeFS.createReadStream(archive).pipe(res);
        return;
      }
      void (async () => {
        const manifest = decodeManifest(req.headers[DESKTOP_TRANSFER_MANIFEST_HEADER]);
        await receiveDesktopTransferArchive({
          archivePath: incomingArchive,
          manifest,
          body: req,
          signal: new AbortController().signal,
        });
        uploaded.resolve(manifest);
        res.writeHead(204).end();
      })().catch((error: unknown) => {
        uploaded.reject(error);
        res.writeHead(400).end();
      });
    });
    const source = NodePath.join(directory, "source");
    await NodeFSP.mkdir(NodePath.join(source, "nested"), { recursive: true });
    const bytes = NodeCrypto.randomBytes(2 * 1024 * 1024);
    await NodeFSP.writeFile(NodePath.join(source, "nested", "data.bin"), bytes);
    await NodeFSP.writeFile(NodePath.join(source, "name ü.txt"), "Unicode →\n");
    await NodeFSP.symlink("nested/data.bin", NodePath.join(source, "link"));
    archive = NodePath.join(directory, "source.bundle");
    incomingArchive = NodePath.join(directory, "incoming.bundle");
    const manifest = await packAgentDesktopBundle({
      sourcePath: source,
      outputPath: archive,
      compression: "gzip",
    });
    const downloaded = await manager.run(owner, "grant", { ...request, manifest });
    expect(downloaded.manifest).toEqual(manifest);
    expect(
      await NodeFSP.readFile(NodePath.join(directory, "received", "nested", "data.bin")),
    ).toEqual(bytes);
    expect(await NodeFSP.readlink(NodePath.join(directory, "received", "link"))).toBe(
      "nested/data.bin",
    );
    await manager.run(owner, "grant", {
      ...request,
      direction: "from-desktop",
      desktopPath: "~/received",
    });
    const receivedManifest = await uploaded.promise;
    await extractAgentDesktopBundle({
      archivePath: incomingArchive,
      destinationPath: NodePath.join(directory, "roundtrip"),
      compression: receivedManifest.compression,
    });
    expect(
      await NodeFSP.readFile(NodePath.join(directory, "roundtrip", "nested", "data.bin")),
    ).toEqual(bytes);
    expect(await NodeFSP.readdir(NodePath.join(directory, "staging"))).toEqual([]);
  });

  it("refuses corrupt downloads and preserves an existing destination", async () => {
    const { directory, manager, request } = await fixture((_req, res) => {
      res.end("corrupt");
    });
    await NodeFSP.writeFile(NodePath.join(directory, "received"), "original");
    const manifest: DesktopTransferManifest = {
      rootType: "file",
      fileCount: 1,
      directoryCount: 0,
      symlinkCount: 0,
      logicalBytes: 7,
      archiveBytes: 7,
      wireBytes: 7,
      compression: "none",
      sha256: "0".repeat(64),
    };
    await expect(
      manager.run(owner, "grant", { ...request, collision: "replace", manifest }),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await NodeFSP.readFile(NodePath.join(directory, "received"), "utf8")).toBe("original");
    expect(await NodeFSP.readdir(NodePath.join(directory, "staging"))).toEqual([]);
  });

  it("rejects another thread's cancellation and drains streams when a grant is revoked", async () => {
    const entered = Promise.withResolvers<void>();
    const { directory, manager, request } = await fixture((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
      entered.resolve();
    });
    const manifest: DesktopTransferManifest = {
      rootType: "file",
      fileCount: 1,
      directoryCount: 0,
      symlinkCount: 0,
      logicalBytes: 1,
      archiveBytes: 1000,
      wireBytes: 1000,
      compression: "none",
      sha256: "0".repeat(64),
    };
    const running = manager.run(owner, "grant", { ...request, manifest });
    const rejected = expect(running).rejects.toBeDefined();
    await entered.promise;
    await expect(
      manager.cancel({ ...owner, threadId: "other" }, request.transferId),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await manager.revoke(new Set(["grant"]));
    await rejected;
    expect(await NodeFSP.readdir(NodePath.join(directory, "staging"))).toEqual([]);
    await expect(NodeFSP.stat(NodePath.join(directory, "received"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

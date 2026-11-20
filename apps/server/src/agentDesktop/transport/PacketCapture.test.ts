// @effect-diagnostics nodeBuiltinImport:off - Protocol fixtures use real private host sockets and temporary files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

const script = NodeURL.fileURLToPath(
  new URL("../../../resources/agent-desktop/network/capture.py", import.meta.url),
);
const run = NodeUtil.promisify(NodeChildProcess.execFile);
const token = "1".repeat(32);
function pcap(...records: Buffer[]) {
  return Buffer.concat([
    Buffer.from("d4c3b2a10200040000000000000000000000010001000000", "hex"),
    ...records,
  ]);
}
function record(payload: Buffer) {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(payload.length, 8);
  header.writeUInt32LE(payload.length, 12);
  return Buffer.concat([header, payload]);
}

async function monitor(data: Buffer, failure: "lost-reply" | "still-attached" | undefined) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cap-"));
  const path = NodePath.join(directory, "qmp");
  const published = "network-" + token + ".pcap";
  const removed: string[] = [];
  const premature: string[] = [];
  let attached = false;
  const installed = Promise.withResolvers<void>();
  const server = NodeNet.createServer((socket) => {
    socket.write('{"QMP":{"version":{},"capabilities":[]}}\r\n');
    let pending = "";
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      pending += chunk.toString();
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const { execute, arguments: args, id } = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        let result: unknown = {};
        switch (execute) {
          case "object-add":
            expect(args["qom-type"]).toBe("filter-dump");
            expect(args.netdev).toBe("net0");
            expect(args.file).toBe(NodePath.join(directory, ".network-" + token + ".part"));
            await NodeFSP.writeFile(args.file, data);
            attached = true;
            installed.resolve();
            break;
          case "object-del":
            premature.push(
              ...(await NodeFSP.readdir(directory)).filter((file) => file.endsWith(".pcap")),
            );
            removed.push(args.id);
            if (failure !== "still-attached") attached = false;
            if (failure) {
              socket.destroy();
              return;
            }
            break;
          case "qom-list":
            result = attached ? [{ name: "t3-capture-" + token, type: "child<filter-dump>" }] : [];
            break;
        }
        socket.write(JSON.stringify({ return: result, id }) + "\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
  return {
    directory,
    published,
    removed,
    premature,
    installed: installed.promise,
    start: () => run("python3", ["-I", "-B", script, path, directory, token, "1000", "1024"]),
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

describe.runIf(HostProcess.Platform.defaultValue() === "linux")(
  "independent packet capture service",
  () => {
    it("publishes whole Ethernet records only after confirmed detach, including a lost QMP reply", async () => {
      const packet = Buffer.alloc(600, 0x5a);
      await using capture = await monitor(pcap(record(packet), record(packet)), "lost-reply");
      const { stdout } = await capture.start();
      expect(JSON.parse(stdout)).toMatchObject({ sizeBytes: 640, truncated: true });
      expect(capture.premature).toEqual([]);
      expect(capture.removed).toEqual(["t3-capture-" + token]);
      const artifact = await NodeFSP.readFile(NodePath.join(capture.directory, capture.published));
      expect(artifact.length).toBe(640);
      expect(artifact.readUInt32LE(0)).toBe(0xa1b2c3d4);
      expect(artifact.readUInt32LE(32)).toBe(600);
      expect(artifact.readUInt32LE(36)).toBe(600);
      expect(artifact.subarray(40)).toEqual(packet);
    });

    it("enforces its deadline on a silent partial frame without any further controller request", async () => {
      const partial = pcap(record(Buffer.alloc(20)).subarray(0, 22));
      await using capture = await monitor(partial, undefined);
      const { stdout } = await capture.start();
      expect(JSON.parse(stdout)).toMatchObject({ sizeBytes: 24, truncated: true });
      expect(capture.removed).toEqual(["t3-capture-" + token]);
      expect(await NodeFSP.readdir(capture.directory)).toEqual([capture.published, "qmp"]);
    });

    it("detaches when the owner pipe closes and discards even a valid partial capture", async () => {
      await using capture = await monitor(pcap(record(Buffer.alloc(40))), undefined);
      const job = capture.start();
      await capture.installed;
      job.child.stdin!.end();
      await expect(job).rejects.toThrow(/cancelled/);
      expect(capture.removed).toEqual(["t3-capture-" + token]);
      expect(await NodeFSP.readdir(capture.directory)).toEqual(["qmp"]);
    });

    it("leaves no published artifact if the filter remains attached", async () => {
      await using capture = await monitor(pcap(record(Buffer.alloc(1024))), "still-attached");
      await expect(capture.start()).rejects.toThrow();
      expect(await NodeFSP.readdir(capture.directory)).toEqual([
        ".network-" + token + ".part",
        "qmp",
      ]);
    });

    it("rejects invalid packet lengths before publication even when the byte limit was met", async () => {
      const invalid = pcap(record(Buffer.alloc(984)));
      invalid.writeUInt32LE(12, 36);
      await using capture = await monitor(invalid, undefined);
      await expect(capture.start()).rejects.toThrow(/Invalid PCAP record/);
      expect(await NodeFSP.readdir(capture.directory)).toEqual(["qmp"]);
    });
  },
);

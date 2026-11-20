// @effect-diagnostics nodeBuiltinImport:off - Protocol fixtures use real private host sockets and temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";
import { machinePaths } from "../MachinePaths.ts";
import { guestIo } from "./GuestIo.ts";

interface Request {
  execute: string;
  arguments?: Record<string, unknown>;
  id: string;
}

function reply(socket: NodeNet.Socket, request: Request, value: unknown, sentinel = false) {
  if (sentinel) socket.write(Buffer.from([255]));
  socket.write(JSON.stringify({ return: value, id: request.id }) + "\r\n");
}

async function fixture(
  channel: "qga" | "qmp",
  respond: (request: Request, socket: NodeNet.Socket, delimited: boolean) => void,
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-guest-io-"));
  const path = NodePath.join(directory, "monitor");
  const vm = {
    ...machinePaths(directory, "agent-" + "0".repeat(32)),
    qgaSocket: path,
    qmpSocket: path,
  };
  const server = NodeNet.createServer((socket) => {
    socket.on("error", () => {});
    if (channel === "qmp") socket.write('{"QMP":{"version":{},"capabilities":[]}}\r\n');
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10)) {
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        respond(
          JSON.parse(line.subarray(line[0] === 255 ? 1 : 0).toString()),
          socket,
          line[0] === 255,
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
  return {
    vm,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

describe.runIf(HostProcess.Platform.defaultValue() !== "win32")("private guest transport", () => {
  it("requires a delimited matching nonce after stale and fragmented guest bytes, and serializes calls", async () => {
    const nonces: unknown[] = [];
    const trace: string[] = [];
    await using peer = await fixture("qga", (request, socket, delimited) => {
      trace.push(request.execute);
      if (request.execute === "guest-sync-delimited") {
        expect(delimited).toBe(true);
        const nonce = request.arguments?.id;
        nonces.push(nonce);
        reply(socket, request, nonce);
        reply(socket, request, -1, true);
        socket.write(Buffer.from([255, 123, 10]));
        socket.write('{"stale":');
        reply(socket, request, nonce, true);
      } else {
        reply(socket, request, request.arguments?.path);
      }
    });
    const calls = ["a", "b"].map((path) => guestIo.qga(peer.vm, "guest-exec", { path }));
    expect(await Promise.all(calls)).toEqual(["a", "b"]);
    expect(trace).toEqual([
      "guest-sync-delimited",
      "guest-exec",
      "guest-sync-delimited",
      "guest-exec",
    ]);
    expect(new Set(nonces).size).toBe(2);
  });

  it("requires a new sentinel and nonce after both a handshake timeout and a command timeout", async () => {
    const commands: string[] = [];
    let handshakes = 0;
    await using peer = await fixture("qga", (request, socket, delimited) => {
      if (request.execute === "guest-sync-delimited") {
        expect(delimited).toBe(true);
        handshakes++;
        reply(socket, request, request.arguments?.id, handshakes !== 1);
      } else {
        commands.push(request.execute);
        if (request.execute === "guest-ping") reply(socket, request, {});
      }
    });
    await expect(guestIo.qga(peer.vm, "guest-exec", {}, 150)).rejects.toThrow(/timeout/i);
    expect(commands).toEqual([]);
    await expect(guestIo.qga(peer.vm, "guest-exec", {}, 150)).rejects.toThrow(/outcome is unknown/);
    await guestIo.qga(peer.vm, "guest-ping");
    expect(commands).toEqual(["guest-exec", "guest-ping"]);
    expect(handshakes).toBe(3);
  });

  it("returns bounded exec output while preserving argv, stdin and the guest exit status", async () => {
    const input = Buffer.from([0, 255, 9]);
    await using peer = await fixture("qga", (request, socket) => {
      if (request.execute === "guest-sync-delimited")
        return reply(socket, request, request.arguments?.id, true);
      if (request.execute === "guest-exec") {
        expect(request.arguments?.arg).toEqual(
          expect.arrayContaining(["/path with space", "two words", "$(literal)"]),
        );
        expect(request.arguments?.["input-data"]).toBe(input.toString("base64"));
        return reply(socket, request, { pid: 7 });
      }
      reply(socket, request, {
        exited: true,
        exitcode: 3,
        "out-data": Buffer.from("abc").toString("base64"),
        "err-data": Buffer.from("defghi").toString("base64"),
      });
    });
    expect(
      await guestIo.exec(peer.vm, {
        executable: "/path with space",
        args: ["two words", "$(literal)"],
        stdin: input,
        maxOutputBytes: 5,
      }),
    ).toEqual({ exitCode: 3, stdout: "abc", stderr: "de" });
  });

  it("creates a missing file at zero, preserves its tail on overwrite, and reads only the requested bytes", async () => {
    let file: Buffer | undefined;
    let position = 0;
    await using peer = await fixture("qga", (request, socket) => {
      const args = request.arguments ?? {};
      switch (request.execute) {
        case "guest-sync-delimited":
          return reply(socket, request, args.id, true);
        case "guest-file-open":
          if (args.mode === "ab") file ??= Buffer.alloc(0);
          if (!file) {
            socket.write(
              JSON.stringify({
                id: request.id,
                error: { class: "GenericError", desc: "No such file or directory" },
              }) + "\n",
            );
            return;
          }
          return reply(socket, request, 2);
        case "guest-file-seek":
          position = Number(args.offset);
          return reply(socket, request, { position, eof: false });
        case "guest-file-write": {
          const bytes = Buffer.from(String(args["buf-b64"]), "base64");
          file = Buffer.concat([
            file!.subarray(0, position),
            bytes,
            file!.subarray(position + bytes.length),
          ]);
          return reply(socket, request, { count: bytes.length, eof: false });
        }
        case "guest-file-read": {
          const bytes = file!.subarray(position, position + Number(args.count));
          return reply(socket, request, {
            count: bytes.length,
            "buf-b64": bytes.toString("base64"),
            eof: true,
          });
        }
        default:
          return reply(socket, request, {});
      }
    });
    await expect(guestIo.write(peer.vm, "/file", 1, Buffer.from("!"))).rejects.toThrow(
      /No such file/,
    );
    await guestIo.write(peer.vm, "/file", 0, Buffer.from("abcdef"));
    await guestIo.write(peer.vm, "/file", 0, Buffer.from("xy"));
    expect(await guestIo.read(peer.vm, "/file", 1, 3)).toEqual(Buffer.from("ycd"));
    expect(file?.toString()).toBe("xycdef");
  });

  it("synchronizes after losing a mutation response without executing the process twice", async () => {
    const trace: string[] = [];
    await using peer = await fixture("qga", (request, socket) => {
      trace.push(request.execute);
      if (request.execute === "guest-sync-delimited")
        reply(socket, request, request.arguments?.id, true);
      else if (request.execute === "guest-exec") socket.destroy();
      else reply(socket, request, {});
    });
    await expect(guestIo.exec(peer.vm, { executable: "/usr/bin/true" })).rejects.toThrow(
      /unknown|uncertain/i,
    );
    await guestIo.qga(peer.vm, "guest-ping");
    expect(trace.filter((name) => name === "guest-exec")).toHaveLength(1);
    expect(trace.slice(-2)).toEqual(["guest-sync-delimited", "guest-ping"]);
  });

  it("matches QMP replies after capability negotiation and ignores asynchronous events", async () => {
    const calls: string[] = [];
    await using peer = await fixture("qmp", (request, socket) => {
      calls.push(request.execute);
      socket.write('{"event":"RESUME"}\r\n');
      reply(socket, request, { status: "running" });
    });
    expect(await guestIo.qmp(peer.vm, "query-status")).toEqual({ status: "running" });
    expect(calls).toEqual(["qmp_capabilities", "query-status"]);
  });

  it("resumes an acknowledged prefix at the actual guest file offset after a lost write reply", async () => {
    const file = Buffer.from("abcdefgh");
    let position = 0;
    const writes: string[] = [];
    await using peer = await fixture("qga", (request, socket) => {
      const args = request.arguments;
      switch (request.execute) {
        case "guest-sync-delimited":
          return reply(socket, request, args?.id, true);
        case "guest-file-open":
          expect(args?.mode).toBe("r+b");
          return reply(socket, request, 7);
        case "guest-file-seek":
          if (args?.whence === "set") position = Number(args.offset);
          return reply(socket, request, { position, eof: false });
        case "guest-file-write": {
          const bytes = Buffer.from(String(args?.["buf-b64"]), "base64");
          writes.push(bytes.toString());
          const count = writes.length === 1 ? 2 : bytes.length;
          bytes.copy(file, position, 0, count);
          position += count;
          if (writes.length === 1) return socket.destroy();
          return reply(socket, request, { count, eof: false });
        }
        default:
          return reply(socket, request, {});
      }
    });
    await guestIo.write(peer.vm, "/tmp/offset", 2, Buffer.from("WXYZ"));
    expect(writes).toEqual(["WXYZ", "YZ"]);
    expect(file.toString()).toBe("abWXYZgh");
  });
});

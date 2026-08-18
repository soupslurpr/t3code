import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";

import { captureFrame } from "./QemuVnc.ts";

/** Reads exact byte counts from one deterministic test connection. */
function socketReader(socket: NodeNet.Socket): (size: number) => Promise<Buffer> {
  let buffer = Buffer.alloc(0);
  const pending: Array<{
    readonly size: number;
    readonly resolve: (value: Buffer) => void;
  }> = [];
  const drain = () => {
    while (pending.length > 0 && buffer.byteLength >= pending[0]!.size) {
      const read = pending.shift()!;
      const value = buffer.subarray(0, read.size);
      buffer = buffer.subarray(read.size);
      read.resolve(value);
    }
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  return (size) =>
    new Promise((resolve) => {
      pending.push({ size, resolve });
      drain();
    });
}

/** Starts one raw-encoding RFB fixture on a private Unix socket. */
async function rawFrameServer(): Promise<{
  readonly path: string;
  readonly server: NodeNet.Server;
}> {
  const path = `/tmp/t3-qemu-vnc-${process.pid}.sock`;
  const server = NodeNet.createServer((socket) => {
    void (async () => {
      const read = socketReader(socket);
      socket.write("RFB 003.008\n");
      await read(12);
      socket.write(Buffer.from([1, 1]));
      await read(1);
      socket.write(Buffer.alloc(4));
      await read(1);

      const serverInit = Buffer.alloc(24);
      serverInit.writeUInt16BE(2, 0);
      serverInit.writeUInt16BE(1, 2);
      serverInit.writeUInt32BE(4, 20);
      socket.write(serverInit);
      socket.write("test");
      await read(20);
      await read(8);
      await read(10);

      const update = Buffer.alloc(16);
      update.writeUInt16BE(1, 2);
      update.writeUInt16BE(2, 8);
      update.writeUInt16BE(1, 10);
      socket.write(update);
      socket.write(Buffer.from([10, 20, 30, 0, 40, 50, 60, 0]));
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, server };
}

/** Closes one RFB fixture after its client disconnects. */
async function closeServer(server: NodeNet.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("QemuVnc", () => {
  it.effect("negotiates a private connection and returns an opaque BGRA frame", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(rawFrameServer);
      return yield* Effect.gen(function* () {
        const frame = yield* captureFrame(fixture.path);
        assert.equal(frame.width, 2);
        assert.equal(frame.height, 1);
        assert.deepEqual([...frame.data], [10, 20, 30, 255, 40, 50, 60, 255]);
      }).pipe(Effect.ensuring(Effect.promise(() => closeServer(fixture.server))));
    }),
  );
});

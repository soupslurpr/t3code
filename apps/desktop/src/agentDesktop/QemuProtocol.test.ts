import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";

import { invokeQga, invokeQmp } from "./QemuProtocol.ts";

interface TestServer {
  readonly path: string;
  readonly server: NodeNet.Server;
}

/** Starts a deterministic Unix JSON server and removes its socket on release. */
async function testServer(
  name: string,
  onConnection: (socket: NodeNet.Socket) => void,
): Promise<TestServer> {
  const path = `/tmp/t3-${name}-${process.pid}.sock`;
  const server = NodeNet.createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, server };
}

/** Closes a test server after all pending protocol writes drain. */
async function closeServer(server: NodeNet.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Splits newline JSON requests while tolerating QGA's synchronization byte. */
function consumeRequests(
  socket: NodeNet.Socket,
  respond: (request: Record<string, unknown>) => void,
) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      const objectStart = line.indexOf(0x7b);
      if (objectStart >= 0) respond(JSON.parse(line.subarray(objectStart).toString("utf8")));
    }
  });
}

describe("QemuProtocol", () => {
  it.effect("negotiates QMP capabilities before invoking a command", () =>
    Effect.gen(function* () {
      const requests: Record<string, unknown>[] = [];
      const fixture = yield* Effect.promise(() =>
        testServer("qmp", (socket) => {
          socket.write(`${JSON.stringify({ QMP: { version: {}, capabilities: [] } })}\r\n`);
          consumeRequests(socket, (request) => {
            requests.push(request);
            socket.write(
              `${JSON.stringify({ return: request.execute === "query-status" ? { status: "running" } : {}, id: request.id })}\r\n`,
            );
          });
        }),
      );
      return yield* Effect.gen(function* () {
        assert.deepEqual(yield* invokeQmp(fixture.path, "query-status"), {
          status: "running",
        });
        assert.deepEqual(
          requests.map((request) => request.execute),
          ["qmp_capabilities", "query-status"],
        );
      }).pipe(Effect.ensuring(Effect.promise(() => closeServer(fixture.server))));
    }),
  );

  it.effect("invokes QGA directly over its dedicated channel", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        testServer("qga", (socket) => {
          consumeRequests(socket, (request) => {
            socket.write(`${JSON.stringify({ return: { ready: true }, id: request.id })}\n`);
          });
        }),
      );
      return yield* Effect.gen(function* () {
        assert.deepEqual(yield* invokeQga(fixture.path, "guest-ping"), { ready: true });
      }).pipe(Effect.ensuring(Effect.promise(() => closeServer(fixture.server))));
    }),
  );
});

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeStream from "node:stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  mcpToolSession,
  AcpMcpBridgeError,
  callAcpMcpTool,
  listAcpMcpTools,
  runAcpMcpCliFastPath,
  runAcpMcpStdioBridge,
} from "./AcpMcpStdioBridge.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

function makeHarness(responder: (request: Request) => Promise<Response> | Response) {
  const input = new NodeStream.PassThrough();
  const written: Array<string> = [];
  const requests: Array<{ readonly headers: Headers; readonly body: string }> = [];
  const bridge = runAcpMcpStdioBridge({
    endpoint: "http://127.0.0.1:1/mcp",
    authorization: "Bearer bridge-test",
    input,
    output: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
    fetchImplementation: async (_url, init) => {
      const request = new Request("http://127.0.0.1:1/mcp", init);
      requests.push({ headers: request.headers, body: String(init?.body ?? "") });
      return responder(request);
    },
  });
  return { input, written, requests, bridge };
}

function pendingFetch(started: Deferred.Deferred<AbortSignal | undefined>) {
  return (_url: string, init?: RequestInit): Promise<Response> => {
    Deferred.doneUnsafe(started, Effect.succeed(init?.signal ?? undefined));
    return new Promise(() => {});
  };
}

interface TerminalRequest {
  readonly id?: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function makeTerminalHarness(
  respond: (request: TerminalRequest) => { result?: unknown; error?: unknown },
) {
  const requests: Array<{ body: TerminalRequest; headers: Headers }> = [];
  const terminations: Headers[] = [];
  return {
    terminations,
    requests,
    endpoint: "http://127.0.0.1:1/mcp",
    authorization: "Bearer bridge-test",
    fetchImplementation: async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        terminations.push(new Headers(init.headers));
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as TerminalRequest;
      requests.push({ body, headers: new Headers(init?.headers) });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          ...(body.method === "initialize"
            ? { result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} } }
            : respond(body)),
        }),
        {
          headers: { "content-type": "application/json", "mcp-session-id": "terminal-session" },
        },
      );
    },
  };
}

const mediaDirectoryScope = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mcp-media-test-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

async function withMediaDirectory(run: (directory: string) => Promise<void>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mcp-media-test-"));
  try {
    await run(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

describe("AcpMcpStdioBridge", () => {
  it.effect.each([undefined, "PrEvIeW", "missing"])(
    "lists input schemas across pages with an optional name filter (%s)",
    (filter) =>
      Effect.gen(function* () {
        const first = {
          name: "preview_status",
          description: "Current tabs",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        };
        const second = {
          name: "preview_navigate",
          description: "Navigate",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        };
        const unrelated = {
          name: "computer_status",
          description: "Includes preview in its description",
          inputSchema: { type: "object" },
        };
        const harness = makeTerminalHarness((request) => ({
          result:
            request.params?.cursor === undefined
              ? {
                  tools: [{ ...first, annotations: { readOnlyHint: true } }, unrelated],
                  nextCursor: "page-2",
                }
              : { tools: [second] },
        }));
        const result = yield* listAcpMcpTools({
          ...harness,
          ...(filter === undefined ? {} : { filter }),
        });
        expect(result).toEqual(
          filter === undefined
            ? [first, unrelated, second]
            : filter === "missing"
              ? []
              : [first, second],
        );
        expect(harness.requests.map((request) => request.body.method)).toEqual([
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/list",
        ]);
        expect(harness.terminations).toHaveLength(1);
        expect(harness.terminations[0]!.get("mcp-session-id")).toBe("terminal-session");
        expect(harness.terminations[0]!.get("authorization")).toBe("Bearer bridge-test");
        expect(harness.requests[2]!.body.params).toEqual({});
        expect(harness.requests[3]!.body.params).toEqual({ cursor: "page-2" });
        expect(harness.requests[3]!.headers.get("authorization")).toBe("Bearer bridge-test");
        expect(harness.requests[3]!.headers.get("mcp-session-id")).toBe("terminal-session");
        expect(harness.requests[3]!.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      }),
  );

  it.effect("fails a repeated pagination cursor instead of looping", () =>
    Effect.gen(function* () {
      const harness = makeTerminalHarness(() => ({ result: { tools: [], nextCursor: "same" } }));
      const error = yield* listAcpMcpTools(harness).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AcpMcpBridgeError);
      expect(error.message).toContain("repeated a tool cursor");
      expect(harness.requests).toHaveLength(4);
    }),
  );

  it.effect.each(["call", "list"])("preserves JSON-RPC errors for terminal %s", (operation) =>
    Effect.gen(function* () {
      const rpcError = {
        code: -32602,
        message: "Bad tool request",
        data: { detail: "invalid argument" },
      };
      const harness = makeTerminalHarness(() => ({ error: rpcError }));
      const error = yield* (
        operation === "call"
          ? callAcpMcpTool({ ...harness, tool: "missing", arguments: {} })
          : listAcpMcpTools(harness)
      ).pipe(Effect.asVoid, Effect.flip);
      expect(error).toBeInstanceOf(AcpMcpBridgeError);
      expect(harness.terminations).toHaveLength(1);
      expect(error.message).toBe(
        `T3 Code MCP tools/${operation} failed: ${JSON.stringify(rpcError)}`,
      );
    }),
  );

  it.effect("preserves transport errors during discovery", () =>
    Effect.gen(function* () {
      const source = new Error("network failed");
      const error = yield* listAcpMcpTools({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer test",
        fetchImplementation: () => Promise.reject(source),
      }).pipe(Effect.flip);
      expect(error.cause).toBe(source);
    }),
  );

  it.effect(
    "materializes images with private unique paths while retaining all other payload fields",
    () =>
      Effect.gen(function* () {
        const directory = yield* mediaDirectoryScope;
        const mediaDirectory = NodePath.join(directory, "session-media");
        const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
        const image = {
          type: "image",
          data: bytes.toString("base64"),
          mimeType: "image/png",
          _meta: { frameId: "frame-1" },
          annotations: { audience: ["assistant"] },
        };
        const original = {
          content: [
            { type: "text", text: "Exact text\nwith whitespace  " },
            image,
            { ...image, mimeType: "image/webp" },
            { type: "audio", data: "unchanged", mimeType: "audio/wav" },
          ],
          structuredContent: { frameId: "frame-1", nested: { values: [1, null, "x"] } },
          isError: true,
          _meta: { observationId: "observation-1" },
        };
        const harness = makeTerminalHarness(() => ({ result: original }));
        const result = (yield* callAcpMcpTool({
          ...harness,
          tool: "computer_observe",
          arguments: {},
          mediaDirectory,
        })) as { content: Array<Record<string, unknown>> };
        const firstPath = result.content[1]!.filePath as string;
        const secondPath = result.content[2]!.filePath as string;
        expect(NodePath.isAbsolute(firstPath)).toBe(true);
        expect(NodePath.dirname(firstPath)).toBe(mediaDirectory);
        expect(NodePath.extname(firstPath)).toBe(".png");
        expect(NodePath.extname(secondPath)).toBe(".webp");
        expect(firstPath).not.toBe(secondPath);
        expect(yield* Effect.promise(() => NodeFSP.readFile(firstPath))).toEqual(bytes);
        expect(yield* Effect.promise(() => NodeFSP.readFile(secondPath))).toEqual(bytes);
        if ((yield* HostProcess.Platform) !== "win32") {
          expect((yield* Effect.promise(() => NodeFSP.stat(firstPath))).mode & 0o777).toBe(0o600);
          expect((yield* Effect.promise(() => NodeFSP.stat(mediaDirectory))).mode & 0o777).toBe(
            0o700,
          );
        }
        const { data: _data, ...withoutData } = image;
        expect(result).toEqual({
          ...original,
          content: [
            original.content[0],
            { ...withoutData, filePath: firstPath },
            { ...withoutData, mimeType: "image/webp", filePath: secondPath },
            original.content[3],
          ],
        });
        expect(original.content[1]).toHaveProperty("data", bytes.toString("base64"));
      }).pipe(Effect.scoped),
  );

  it.effect("leaves oversized image blocks unchanged with a note and writes no file", () =>
    Effect.gen(function* () {
      const directory = yield* mediaDirectoryScope;
      const image = {
        type: "image",
        data: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64"),
        mimeType: "image/png",
        _meta: { frameId: "large-frame" },
      };
      const harness = makeTerminalHarness(() => ({ result: { content: [image], isError: false } }));
      const result = (yield* callAcpMcpTool({
        ...harness,
        tool: "computer_observe",
        arguments: {},
        mediaDirectory: directory,
      })) as { content: Array<Record<string, unknown>>; isError: boolean };
      expect(result.content[0]).toEqual(image);
      expect(result.content[1]).toEqual({ type: "text", text: expect.stringContaining("25 MiB") });
      expect(result.isError).toBe(false);
      expect(yield* Effect.promise(() => NodeFSP.readdir(directory))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.each(["directory", "partial-write", "collision"] as const)(
    "preserves receipts and cleans only owned images after a %s failure",
    (failure) =>
      withMediaDirectory(async (directory) => {
        const blocked = failure === "directory" ? NodePath.join(directory, "file") : directory;
        if (failure === "directory") await NodeFSP.writeFile(blocked, "not a directory");
        const collisionId = "00000000-0000-4000-8000-000000000001";
        const collisionName = `image-${collisionId}.png`;
        if (failure === "collision")
          await NodeFSP.writeFile(NodePath.join(directory, collisionName), "existing image");
        let partialWritten = false;
        const image = {
          type: "image",
          data: "eA==",
          mimeType: "image/png",
          _meta: { frameId: "frame-2" },
        };
        const original = {
          content: [{ type: "text", text: "Action completed" }, image],
          structuredContent: { actionResults: [{ status: "completed" }], frameId: "frame-2" },
          isError: false,
          _meta: { receiptId: "action-receipt" },
        };
        const harness = makeTerminalHarness(() => ({ result: original }));
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        vi.stubEnv("T3_ACP_MCP_ENDPOINT", harness.endpoint);
        vi.stubEnv("T3_ACP_MCP_AUTHORIZATION", harness.authorization);
        vi.stubEnv("T3_ACP_MCP_MEDIA_DIR", blocked);
        vi.stubGlobal("fetch", harness.fetchImplementation);
        try {
          if (failure === "collision")
            vi.spyOn(NodeCrypto, "randomUUID").mockReturnValue(collisionId);
          if (failure === "partial-write") {
            const { open } =
              await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
            vi.spyOn(NodeFSP, "open").mockImplementation(async (path, flags, mode) => {
              const file = await open(path, flags, mode);
              const write = file.writeFile.bind(file);
              vi.spyOn(file, "writeFile").mockImplementation(async () => {
                await write("x");
                partialWritten = (await file.stat()).size === 1;
                throw new Error("ENOSPC: simulated failure after a partial write");
              });
              return file;
            });
          }
          await runAcpMcpCliFastPath("acp-mcp-call", ["computer_act", '{"actions":[]}']);
          expect(output).toHaveBeenCalledTimes(1);
          const result = JSON.parse(String(output.mock.calls[0]![0])) as {
            content: Array<Record<string, unknown>>;
          };
          expect(result).toEqual({
            ...original,
            content: [
              ...original.content,
              { type: "text", text: expect.stringContaining("do not repeat an action") },
            ],
          });
          expect(result.content[2]!.text).toMatch(
            failure === "partial-write" ? /ENOSPC/ : /EEXIST|ENOTDIR/,
          );
          expect(
            harness.requests.filter((request) => request.body.method === "tools/call"),
          ).toHaveLength(1);
          expect(await NodeFSP.readdir(directory)).toEqual(
            failure === "directory" ? ["file"] : failure === "collision" ? [collisionName] : [],
          );
          if (failure === "partial-write") expect(partialWritten).toBe(true);
          if (failure === "collision")
            expect(await NodeFSP.readFile(NodePath.join(directory, collisionName), "utf8")).toBe(
              "existing image",
            );
        } finally {
          vi.restoreAllMocks();
          vi.mocked(NodeFSP.open).mockReset();
          vi.mocked(NodeCrypto.randomUUID).mockReset();
          vi.unstubAllEnvs();
          vi.unstubAllGlobals();
        }
      }),
  );

  it.each([false, true])("keeps CLI output identical unless MEDIA_DIR is set (%s)", (materialize) =>
    withMediaDirectory(async (directory) => {
      const original = {
        content: [
          { type: "text", text: "unchanged\n" },
          { type: "image", data: "eA==", mimeType: "image/png", _meta: { frameId: "f" } },
        ],
        structuredContent: { frameId: "f" },
        isError: true,
        _meta: { custom: "value" },
      };
      const harness = makeTerminalHarness(() => ({ result: original }));
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.stubEnv("T3_ACP_MCP_ENDPOINT", harness.endpoint);
      vi.stubEnv("T3_ACP_MCP_AUTHORIZATION", harness.authorization);
      vi.stubEnv("T3_ACP_MCP_MEDIA_DIR", materialize ? directory : undefined);
      vi.stubGlobal("fetch", harness.fetchImplementation);
      try {
        await runAcpMcpCliFastPath("acp-mcp-call", ["computer_observe", "{}"]);
        expect(output).toHaveBeenCalledTimes(1);
        const printed = String(output.mock.calls[0]![0]);
        if (!materialize) {
          expect(printed).toBe(`${JSON.stringify(original)}\n`);
          expect(await NodeFSP.readdir(directory)).toEqual([]);
        } else {
          const result = JSON.parse(printed) as { content: Array<Record<string, unknown>> };
          expect(result.content[1]).not.toHaveProperty("data");
          expect(await NodeFSP.readFile(result.content[1]!.filePath as string, "utf8")).toBe("x");
        }
      } finally {
        output.mockRestore();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      }
    }),
  );

  it("prints the filtered tool schemas from the list fast path", async () => {
    const tool = { name: "preview_status", description: "Tabs", inputSchema: { type: "object" } };
    const harness = makeTerminalHarness(() => ({ result: { tools: [tool] } }));
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubEnv("T3_ACP_MCP_ENDPOINT", harness.endpoint);
    vi.stubEnv("T3_ACP_MCP_AUTHORIZATION", harness.authorization);
    vi.stubGlobal("fetch", harness.fetchImplementation);
    try {
      await runAcpMcpCliFastPath("acp-mcp-list", ["PREVIEW"]);
      expect(output).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify([tool])}\n`);
    } finally {
      output.mockRestore();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it.effect("forwards requests and replays the session id and protocol version", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness((request) => {
        const body = JSON.parse(String(requests.at(-1)?.body ?? "{}")) as { id?: number };
        void request;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: body.id === 1 ? { protocolVersion: "2025-06-18" } : { ok: true },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
          },
        );
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(2);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 1 });
      expect(JSON.parse(written[1]!)).toMatchObject({ id: 2, result: { ok: true } });
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    }),
  );

  it.effect("acknowledges notifications silently and synthesizes errors for failed requests", () =>
    Effect.gen(function* () {
      let call = 0;
      const { input, written, bridge } = makeHarness(() => {
        call += 1;
        return call === 1
          ? new Response(null, { status: 202 })
          : new Response("upstream broke", { status: 500 });
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(1);
      expect(JSON.parse(written[0]!)).toMatchObject({
        id: 3,
        error: { code: -32603 },
      });
    }),
  );

  it.effect("emits parse errors for malformed JSON-RPC input", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness(
        () => new Response(null, { status: 202 }),
      );
      const fiber = yield* Effect.forkChild(bridge);

      input.end("{not-json}\n");
      yield* Fiber.join(fiber);

      expect(requests).toHaveLength(0);
      expect(JSON.parse(written[0]!)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }),
  );

  it.effect("forwards SSE messages before the HTTP response closes", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      let firstWrite: (() => void) | undefined;
      const firstWritten = new Promise<void>((resolve) => {
        firstWrite = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              firstWrite?.();
            },
          },
          fetchImplementation: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  resolveResponseController(controller);
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      const responseController = yield* Effect.promise(() => responseControllerReady);
      responseController.enqueue(
        new TextEncoder().encode(
          'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
        ),
      );
      yield* Effect.promise(() => firstWritten);
      expect(JSON.parse(written[0]!)).toMatchObject({ method: "notifications/progress" });

      responseController.enqueue(
        new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
      );
      responseController.close();
      input.end();
      yield* Fiber.join(fiber);
      expect(written).toHaveLength(2);
    }),
  );

  it.effect("forwards client responses while an SSE request is still open", () =>
    Effect.gen(function* () {
      let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let serverRequestWritten: (() => void) | undefined;
      const serverRequestReachedClient = new Promise<void>((resolve) => {
        serverRequestWritten = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              if (JSON.parse(chunk).id === "server-request-1") serverRequestWritten?.();
            },
          },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly id?: unknown;
              readonly method?: unknown;
              readonly result?: unknown;
            };
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: (controller) => {
                    responseController = controller;
                    controller.enqueue(
                      new TextEncoder().encode(
                        'data: {"jsonrpc":"2.0","id":"server-request-1","method":"elicitation/create","params":{}}\n\n',
                      ),
                    );
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            expect(body).toMatchObject({ id: "server-request-1", result: { action: "accept" } });
            responseController?.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            responseController?.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => serverRequestReachedClient);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "server-request-1", result: { action: "accept" } })}\n`,
      );
      input.end();
      yield* Fiber.join(fiber);

      expect(written.map((line) => JSON.parse(line).id)).toEqual(["server-request-1", 7]);
    }),
  );

  it.effect("forwards cancellation while a tool SSE response is still open", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      const methods: Array<string> = [];
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: { write: (chunk) => written.push(chunk) },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly method?: string;
            };
            methods.push(body.method ?? "");
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: resolveResponseController,
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            const controller = await responseControllerReady;
            controller.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            controller.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => responseControllerReady);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`,
      );
      input.end();
      yield* Fiber.join(fiber);

      expect(methods).toEqual(["tools/call", "notifications/cancelled"]);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 7, result: {} });
    }),
  );

  it.effect("aborts the pending fetch when a tool call is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal | undefined>();
      const fiber = yield* mcpToolSession({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        clientName: "t3-code-acp-cli",
        fetchImplementation: pendingFetch(started),
      }).pipe(
        Effect.flatMap((session) => session.call("orchestrator_capabilities", {})),
        Effect.scoped,
        Effect.forkChild,
      );

      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
    }),
  );

  it.effect("aborts the pending fetch when the stdio bridge is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal | undefined>();
      const input = new NodeStream.PassThrough();
      const fiber = yield* runAcpMcpStdioBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        input,
        output: { write: () => undefined },
        fetchImplementation: pendingFetch(started),
      }).pipe(Effect.forkChild);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
    }),
  );
});

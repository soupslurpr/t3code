import * as QemuAgentDesktop from "../agentDesktop/QemuAgentDesktop.ts";
import * as AgentDesktopManager from "../agentDesktop/AgentDesktopManager.ts";
import { ThreadWorkspaceQuery } from "../orchestration-v2/ThreadWorkspaceQuery.ts";
import { AgentDesktopTransferService } from "../agentDesktop/AgentDesktopTransferService.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type AgentDesktop, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("computer-http-environment");
const threadId = ThreadId.make("computer-http-thread");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "computer-http-session",
  thread: {
    threadId,
    providerSessionId: "computer-http-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["computer"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "computer-http-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "computer-http-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const desktop = (
  id: string,
  environment = environmentId,
  thread = threadId,
  controllerId = "previous-controller",
): AgentDesktop => ({
  id,
  label: id,
  owner: { environmentId: environment, threadId: thread, controllerId },
  state: "ready",
  automaticParking: true,
  capabilities: ["command"],
  graphics: {
    backend: "virtio-gpu-2d",
    hardwareAccelerated: false,
    renderer: "virtio-gpu 2D",
    checkpointMode: "full-state",
  },
  controllerId: null,
  viewerCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  recoverableUntil: null,
});
const layer = McpHttpServer.AgentDesktopToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(
    Layer.mock(AgentDesktopManager.AgentDesktopManager)({
      list: Effect.succeed({
        available: true,
        desktops: [
          desktop("first"),
          desktop("second", environmentId, threadId, "second-controller"),
          desktop("foreign-thread", environmentId, ThreadId.make("other")),
          desktop("foreign-environment", EnvironmentId.make("other")),
        ],
        requirements: [],
      }),
      setup: Effect.succeed({
        attempted: true,
        completed: true,
        packages: ["passt"],
        imageProvisioned: false,
        status: { available: true, desktops: [], requirements: [] },
      }),
      command: (owner) =>
        Effect.sync(() =>
          expect(owner).toEqual({ environmentId, threadId, controllerId: "computer-http-session" }),
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new QemuAgentDesktop.QemuAgentDesktopError({
                code: "timed-out",
                operation: "command",
                detail: "guest process 42 exceeded its timeout",
              }),
            ),
          ),
        ),
    }),
  ),
  Layer.provide(Layer.mock(ThreadWorkspaceQuery)({})),
  Layer.provide(Layer.mock(AgentDesktopTransferService)({})),
);
const call = Effect.fn("AgentDesktopHttpTest.call")(
  (name: string, input: Record<string, unknown>, scope = invocation) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: input })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    ),
);

it.effect("routes an Agent desktop list directly to the environment service", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call("agent_desktop_list", {});
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        available: true,
        desktops: [{ id: "first" }, { id: "second" }],
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["agent_desktop_list", {}],
  ["agent_desktop_setup", {}],
  ["agent_desktop_acquire", {}],
  ["agent_desktop_manage", { operation: "stop", desktopId: "agent-one" }],
  ["agent_desktop_command", { executable: "/usr/bin/true" }],
  ["agent_desktop_read_file", { path: "/tmp/a" }],
  ["agent_desktop_write_file", { path: "/tmp/a", data: "a" }],
  [
    "agent_desktop_copy",
    { source: { kind: "workspace", path: "a" }, destination: { kind: "agent", path: "~/a" } },
  ],
  ["agent_desktop_transfer_status", { transferId: "transfer-one" }],
  ["agent_desktop_transfer_cancel", { transferId: "transfer-one" }],
  ["agent_desktop_inspect", {}],
  ["agent_desktop_create_port_route", { guestPort: 3000 }],
  ["agent_desktop_remove_port_route", { routeId: "route-one" }],
  ["agent_desktop_packet_capture", { durationMs: 1000, maxBytes: 1024 }],
] as const)("rejects external callers for %s", ([name, input]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call(name, input, {
        ...invocation,
        thread: undefined,
        client: { sessionId: "external", label: "External client", access: "full-access" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "This tool acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.",
        },
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("denies Agent tools when the calling thread lacks the current capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* call(
        "agent_desktop_list",
        {},
        { ...invocation, capabilities: new Set() },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("does not grant the computer capability");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  [
    "agent_desktop_copy",
    { source: { kind: "workspace", path: "a" }, destination: { kind: "agent", path: "~/a" } },
  ],
  ["agent_desktop_transfer_status", { transferId: "transfer-one" }],
  ["agent_desktop_transfer_cancel", { transferId: "transfer-one" }],
] as const)("denies %s after its capability is removed", ([name, input]) =>
  Effect.gen(function* () {
    const result = yield* call(name, input, { ...invocation, capabilities: new Set() });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("does not grant the computer capability");
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  [
    "agent_desktop_copy",
    { source: { kind: "workspace", path: "a" }, destination: { kind: "agent", path: "~/a" } },
  ],
  ["agent_desktop_transfer_cancel", { transferId: "transfer-one" }],
] as const)("denies %s for a read-only client", ([name, input]) =>
  Effect.gen(function* () {
    const result = yield* call(name, input, {
      ...invocation,
      client: { sessionId: "read-only", label: "Observer", access: "read-only" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("read-only");
  }).pipe(Effect.provide(layer)),
);

it.effect("reports normalized guest timeouts through the environment and MCP boundary", () =>
  Effect.gen(function* () {
    const result = yield* call("agent_desktop_command", {
      executable: "/usr/bin/env",
      environment: { LANG: "C.UTF-8" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("The desktop operation timed out.");
    expect(JSON.stringify(result)).not.toContain("private host log");
  }).pipe(Effect.provide(layer)),
);

it.effect("returns environment setup readiness through the guarded Agent tool", () =>
  Effect.gen(function* () {
    const result = yield* call("agent_desktop_setup", {});
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      completed: true,
      status: { available: true },
    });
  }).pipe(Effect.provide(layer)),
);

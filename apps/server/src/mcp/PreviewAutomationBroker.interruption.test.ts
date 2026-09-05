/** Verifies thread Stop routing independently of provider credentials and screen watches. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  COMPUTER_AUTOMATION_OPERATIONS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as UserDesktops from "../persistence/UserDesktops.ts";

const thread = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerInstanceId: ProviderInstanceId.make("provider-1"),
};
const desktop = { kind: "user", desktopId: "desktop-1" } as const;
const makeBroker = PreviewAutomationBroker.make.pipe(
  Effect.provide(Layer.merge(UserDesktops.layerMemory, NodeServices.layer)),
);
const makeScope = Effect.gen(function* () {
  const controllerId = yield* McpInvocationContext.threadComputerControllerId(
    thread.environmentId,
    thread.threadId,
  );
  return {
    ...thread,
    controllerId,
    providerSessionId: "session-before-stop",
    capabilities: new Set(["computer"] as const),
    issuedAt: 0,
  };
}).pipe(Effect.provide(NodeServices.layer));

/** Registers a host and exposes ordered events after its connection receipt. */
const connectHost = Effect.fn("test.connectHost")(function* (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  overrides: Partial<PreviewAutomationHost> = {},
) {
  const connected = yield* Deferred.make<void>();
  const events = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
  const host: PreviewAutomationHost = {
    clientId: "client-1",
    environmentId: thread.environmentId,
    supportedOperations: [...COMPUTER_AUTOMATION_OPERATIONS],
    userDesktop: {
      protocolVersion: 1,
      desktopId: desktop.desktopId,
      defaultLabel: "Test desktop",
      platform: "linux",
      capabilities: ["view", "control", "availability"],
    },
    ...overrides,
  };
  yield* (yield* broker.connect(host)).pipe(
    Stream.runForEach((event) =>
      event.type === "connected"
        ? Deferred.succeed(connected, undefined)
        : Queue.offer(events, event),
    ),
    Effect.forkScoped,
  );
  yield* Deferred.await(connected);
  return { events, host };
});

/** Consumes a request receipt without polling or timing assumptions. */
const takeRequest = Effect.fn("test.takeRequest")(function* (
  events: Queue.Queue<PreviewAutomationStreamEvent>,
) {
  const event = yield* Queue.take(events);
  if (event.type !== "request")
    return yield* Effect.die(`expected request, received ${event.type}`);
  return event;
});

it.effect("cancels only the normal thread controller and resumes without restoring access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const scope = yield* makeScope;
      const { events, host } = yield* connectHost(broker);
      const invoke = (
        controller: McpInvocationContext.McpInvocationScope,
        operation: "computerRequestControl" | "computerSnapshot" | "computerStatus",
      ) =>
        broker.invoke<{ retained: boolean } | string>({
          scope: controller,
          operation,
          input: { desktop },
        });
      const pending = yield* Effect.forkChild(invoke(scope, "computerRequestControl"));
      const pendingRequest = yield* takeRequest(events);
      const watch = yield* Effect.forkChild(
        invoke(
          {
            ...scope,
            controllerId: "thread-monitor:watch",
            providerSessionId: "thread-monitor:watch",
          },
          "computerSnapshot",
        ),
      );
      const watchRequest = yield* takeRequest(events);
      const human = yield* Effect.forkChild(
        invoke({ ...scope, controllerKind: "human" }, "computerStatus"),
      );
      const humanRequest = yield* takeRequest(events);
      const other = yield* Effect.forkChild(
        invoke(
          { ...scope, threadId: ThreadId.make("other-thread"), controllerId: "other-controller" },
          "computerSnapshot",
        ),
      );
      const otherRequest = yield* takeRequest(events);

      const cleanup = yield* broker.beginThreadInterruption(thread);
      expect(yield* Effect.flip(Fiber.join(pending))).toMatchObject({
        computerFailure: { code: "request-cancelled" },
      });
      expect(yield* Queue.take(events)).toEqual({
        type: "cancel",
        connectionId: pendingRequest.connectionId,
        requestId: pendingRequest.request.requestId,
        preserveDesktopAccess: true,
      });
      expect(
        yield* Effect.flip(
          invoke({ ...scope, providerSessionId: "late-session" }, "computerRequestControl"),
        ),
      ).toMatchObject({ computerFailure: { code: "request-cancelled" } });
      const stopped = yield* Effect.forkChild(cleanup);
      const interruption = yield* takeRequest(events);
      expect(interruption.request).toMatchObject({
        operation: "computerInterrupt",
        controllerId: scope.controllerId,
        controllerKind: "agent",
        threadId: thread.threadId,
        input: { desktop },
      });
      for (const event of [
        pendingRequest,
        watchRequest,
        humanRequest,
        otherRequest,
        interruption,
      ]) {
        yield* broker.respond({
          clientId: host.clientId,
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: { retained: true },
        });
      }
      yield* Fiber.join(stopped);
      for (const unaffected of [watch, human, other])
        expect(yield* Fiber.join(unaffected)).toEqual({ retained: true });
      expect(yield* Queue.takeBetween(events, 0, Infinity)).toHaveLength(0);

      yield* broker.resumeThread(thread);
      expect(yield* Queue.takeBetween(events, 0, Infinity)).toHaveLength(0);
      const resumed = yield* Effect.forkChild(invoke(scope, "computerRequestControl"));
      const reacquisition = yield* takeRequest(events);
      yield* broker.respond({
        clientId: host.clientId,
        connectionId: reacquisition.connectionId,
        requestId: reacquisition.request.requestId,
        ok: true,
        result: "explicit reacquisition",
      });
      expect(yield* Fiber.join(resumed)).toBe("explicit reacquisition");
    }),
  ),
);

it.effect(
  "releases retained ownership after broker restart without targeting another environment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const { events, host } = yield* connectHost(broker);
        const other = yield* connectHost(broker, {
          clientId: "other-client",
          environmentId: EnvironmentId.make("other-environment"),
        });
        const cleanup = yield* broker.beginThreadInterruption(thread);
        const stopped = yield* Effect.forkChild(cleanup);
        const request = yield* takeRequest(events);
        expect(request.request.operation).toBe("computerInterrupt");
        yield* broker.respond({
          clientId: host.clientId,
          connectionId: request.connectionId,
          requestId: request.request.requestId,
          ok: true,
        });
        yield* Fiber.join(stopped);
        expect(yield* Queue.takeBetween(other.events, 0, Infinity)).toHaveLength(0);
      }),
    ),
);

it.effect(
  "reports legacy cleanup failure while still cleaning compatible hosts without full release",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const scope = yield* makeScope;
        const legacy = yield* connectHost(broker, {
          supportedOperations: COMPUTER_AUTOMATION_OPERATIONS.filter(
            (operation) => operation !== "computerInterrupt",
          ),
        });
        const modern = yield* connectHost(broker, {
          clientId: "modern-client",
          userDesktop: { ...legacy.host.userDesktop!, desktopId: "modern-desktop" },
        });
        const pending = yield* Effect.forkChild(
          broker.invoke<void>({ scope, operation: "computerAct", input: { desktop, actions: [] } }),
        );
        yield* takeRequest(legacy.events);
        const cleanup = yield* broker.beginThreadInterruption(thread);
        const stopped = yield* Effect.forkChild(cleanup);
        const request = yield* takeRequest(modern.events);
        expect(request.request.operation).toBe("computerInterrupt");
        yield* broker.respond({
          clientId: modern.host.clientId,
          connectionId: request.connectionId,
          requestId: request.request.requestId,
          ok: true,
        });
        expect(yield* Effect.flip(Fiber.join(stopped))).toMatchObject({
          _tag: "PreviewAutomationNoAvailableHostError",
        });
        expect(yield* Effect.flip(Fiber.join(pending))).toMatchObject({
          computerFailure: { code: "request-cancelled" },
        });
        expect(yield* Queue.takeBetween(legacy.events, 0, Infinity)).toHaveLength(0);
      }),
    ),
);

it.effect("can stop a thread without any attached desktop", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    yield* yield* broker.beginThreadInterruption(thread);
    yield* broker.resumeThread(thread);
  }),
);

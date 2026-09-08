/** Verifies browser desktop selection, reconnects, and result provenance. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as UserDesktops from "../persistence/UserDesktops.ts";

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  controllerId: "controller-1",
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const makeBroker = PreviewAutomationBroker.make.pipe(
  Effect.provide(Layer.merge(UserDesktops.layerMemory, NodeServices.layer)),
);

/** Creates a host with an independent desktop identity. */
function makeHost(clientId: string): PreviewAutomationHost {
  return {
    clientId,
    environmentId: scope.environmentId,
    userDesktop: {
      protocolVersion: 1,
      desktopId: `desktop-${clientId}`,
      defaultLabel: clientId,
      platform: "linux",
      capabilities: [],
    },
  };
}

/** Waits for registration and records requests before returning their page state. */
const attachHost = Effect.fn("attachBrowserHost")(function* (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  host: PreviewAutomationHost,
) {
  const connected = yield* Deferred.make<string>();
  const requests: PreviewAutomationRequest[] = [];
  const consumer = yield* Stream.runForEach(yield* broker.connect(host), (event) => {
    if (event.type === "connected") return Deferred.succeed(connected, event.connectionId);
    if (event.type !== "request") return Effect.void;
    requests.push(event.request);
    return broker.respond({
      clientId: host.clientId,
      connectionId: event.connectionId,
      requestId: event.request.requestId,
      ok: true,
      result: {
        available: true,
        tabId: event.request.tabId ?? `tab-${host.clientId}`,
        host: "page-controlled-value",
      },
    });
  }).pipe(Effect.forkScoped);
  const connectionId = yield* Deferred.await(connected);
  return { consumer, connectionId, requests };
});

it.effect("selects an exact desktop, retains its tab, and restores automatic selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const first = yield* attachHost(broker, makeHost("first"));
      const second = yield* attachHost(broker, makeHost("second"));
      yield* broker.focusHost({
        clientId: "second",
        environmentId: scope.environmentId,
        connectionId: second.connectionId,
        focused: true,
      });
      const automatic = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: {},
      });
      expect(automatic.host?.desktop?.desktopId).toBe("desktop-second");

      const desktop = { kind: "user", desktopId: "desktop-first" } as const;
      const selected = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: {},
        desktop,
      });
      expect(selected.host).toEqual({
        clientId: "first",
        desktop,
        defaultLabel: "first",
        platform: "linux",
      });
      expect(first.requests[0]?.tabId).toBeUndefined();
      yield* broker.invoke({ scope, operation: "click", input: { x: 10, y: 10 } });
      expect(first.requests.at(-1)?.tabId).toBe("tab-first");
      expect(second.requests).toHaveLength(1);

      const restored = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
        desktop: null,
      });
      expect(restored.host?.desktop?.desktopId).toBe("desktop-second");
      expect(second.requests.at(-1)?.tabId).toBeUndefined();
      yield* broker.invoke({
        scope,
        operation: "snapshot",
        input: {},
        desktop: { kind: "user", desktopId: "desktop-second" },
      });
      expect(second.requests.at(-1)?.tabId).toBe("tab-second");

      yield* broker.invoke({
        scope,
        operation: "open",
        input: {},
        desktop,
        tabId: PreviewTabId.make("explicit-thread-tab"),
      });
      expect(first.requests.at(-1)?.tabId).toBe("explicit-thread-tab");
      expect(first.requests.at(-1)?.tabIdExplicit).toBe(true);
    }),
  ),
);

it.effect("retains an explicit desktop and tab through disconnect and client replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const host = makeHost("first");
      const first = yield* attachHost(broker, host);
      const other = yield* attachHost(broker, makeHost("other"));
      const desktop = { kind: "user", desktopId: "desktop-first" } as const;
      yield* broker.invoke({ scope, operation: "open", input: {}, desktop });
      yield* Fiber.interrupt(first.consumer);
      const offline = yield* broker
        .invoke<void>({
          scope,
          operation: "click",
          input: { x: 10, y: 10 },
        })
        .pipe(Effect.flip);
      expect(offline).toMatchObject({
        _tag: "PreviewAutomationNoAvailableHostError",
        desktop,
        reason: "offline",
      });
      expect(offline.message).toContain("user_desktop_list");
      expect(other.requests).toHaveLength(0);

      const reconnected = yield* attachHost(broker, { ...host, clientId: "reconnected" });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.host?.clientId).toBe("reconnected");
      expect(reconnected.requests[0]?.tabId).toBe("tab-first");

      const replaced = yield* attachHost(broker, { ...host, clientId: "reconnected" });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });
      expect(replaced.requests[0]?.tabId).toBe("tab-first");
      expect(other.requests).toHaveLength(0);
    }),
  ),
);

it.effect("keeps a failed desktop choice from falling back on the next action", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const other = yield* attachHost(broker, makeHost("other"));
      yield* attachHost(broker, {
        ...makeHost("absent"),
        environmentId: EnvironmentId.make("another-environment"),
      });
      const desktop = { kind: "user", desktopId: "desktop-absent" } as const;
      for (const selection of [desktop, undefined]) {
        const error = yield* broker
          .invoke<void>({
            scope,
            operation: "status",
            input: {},
            ...(selection === undefined ? {} : { desktop: selection }),
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ desktop, reason: "offline" });
      }
      expect(other.requests).toHaveLength(0);
      yield* broker.invoke({ scope, operation: "status", input: {}, desktop: null });
      expect(other.requests).toHaveLength(1);
    }),
  ),
);

it.effect("rejects ambiguous identities and unsupported operations on the selected desktop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const firstHost = makeHost("first");
      const first = yield* attachHost(broker, firstHost);
      const desktop = { kind: "user", desktopId: "desktop-first" } as const;
      yield* broker.invoke({ scope, operation: "open", input: {}, desktop });
      const duplicate = yield* attachHost(broker, { ...firstHost, clientId: "duplicate" });
      const conflict = yield* broker
        .invoke<void>({
          scope,
          operation: "status",
          input: {},
        })
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({ desktop, reason: "identity-conflict" });
      expect(duplicate.requests).toHaveLength(0);
      yield* Fiber.interrupt(duplicate.consumer);
      const capable = yield* attachHost(broker, {
        ...makeHost("capable"),
        supportedOperations: ["resize"],
      });
      const unsupported = yield* broker
        .invoke<void>({
          scope,
          operation: "resize",
          input: { mode: "fill" },
        })
        .pipe(Effect.flip);
      expect(unsupported).toMatchObject({ desktop, reason: "unsupported-operation" });
      expect(capable.requests).toHaveLength(0);
      expect(first.requests).toHaveLength(1);
    }),
  ),
);

it.effect("reports legacy host identity without changing page evaluation results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const { userDesktop: _desktop, ...legacy } = makeHost("legacy");
      yield* attachHost(broker, legacy);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.host).toEqual({ clientId: "legacy" });
      const evaluated = yield* broker.invoke({
        scope,
        operation: "evaluate",
        input: { expression: "({host: 'page-controlled-value'})" },
      });
      expect(evaluated).toMatchObject({ host: "page-controlled-value" });
    }),
  ),
);

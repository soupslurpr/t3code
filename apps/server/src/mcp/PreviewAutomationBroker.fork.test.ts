import { AuthSessionId } from "@t3tools/contracts";
import { DesktopExecutionAuthorizationChannel } from "../computer/DesktopExecutionAuthorizationChannel.ts";
import * as ComputerObservationStore from "../computer/ComputerObservationStore.ts";
import * as UserDesktops from "../persistence/UserDesktops.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MAX_USER_DESKTOPS,
  COMPUTER_AUTOMATION_OPERATIONS,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationStreamEvent,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { runUserDesktopHumanRequest as runHumanRequest } from "../computer/UserDesktopHuman.ts";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("fork-agent-environment");
const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId,
  requestNamespace: "provider-one",
  thread: {
    threadId: ThreadId.make("thread-one"),
    controllerId: "provider-one",
    providerSessionId: "provider-one",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};
const layer = Layer.merge(
  ComputerObservationStore.layer,
  PreviewAutomationBroker.layer.pipe(
    Layer.provide(UserDesktops.layerMemory),
    Layer.provide(NodeServices.layer),
  ),
);
const registration = (desktopId: string) => ({
  protocolVersion: 1 as const,
  desktopId,
  defaultLabel: desktopId,
  platform: "linux" as const,
  capabilities: ["view" as const, "control" as const, "availability" as const],
});
const serveInventoryHost = Effect.fn("ForkBrokerTest.serveInventoryHost")(function* (
  host: PreviewAutomationHost,
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const connected = yield* Deferred.make<void>();
  const requests: PreviewAutomationRequest[] = [];
  const events = yield* broker.connect(host);
  const fiber = yield* Stream.runForEach(events, (event) => {
    if (event.type === "connected") return Deferred.succeed(connected, undefined);
    if (event.type === "cancel" || event.type === "lifecycle") return Effect.void;
    requests.push(event.request);
    return broker.respond({
      clientId: host.clientId,
      connectionId: event.connectionId,
      requestId: event.request.requestId,
      ok: true,
      result: host.clientId,
    });
  }).pipe(Effect.forkScoped);
  yield* Deferred.await(connected);
  return { fiber, requests };
});
const serve = Effect.fn("ForkBrokerTest.serve")(function* (
  host: PreviewAutomationHost,
  answer?: Pick<PreviewAutomationResponse, "ok" | "result" | "error">,
  options?: { readonly focused?: boolean; readonly preferred?: boolean },
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const connected = yield* Deferred.make<void>();
  const received: PreviewAutomationRequest[] = [];
  const events = yield* broker.connect(
    {
      ...host,
      ...(host.userDesktop === undefined &&
      host.supportedOperations?.some((operation) => operation.startsWith("computer"))
        ? {
            userDesktop: {
              protocolVersion: 1 as const,
              desktopId: "user-desktop-1",
              defaultLabel: "Test desktop",
              platform: "linux" as const,
              capabilities: ["view" as const, "control" as const, "availability" as const],
            },
          }
        : {}),
    },
    options,
  );
  yield* Stream.runForEach(events, (event) => {
    if (event.type === "connected") {
      return (
        options?.focused
          ? broker.focusHost({
              clientId: host.clientId,
              environmentId: host.environmentId,
              connectionId: event.connectionId,
              focused: true,
            })
          : Effect.void
      ).pipe(Effect.orDie, Effect.andThen(Deferred.succeed(connected, undefined)));
    }
    if (event.type === "cancel" || event.type === "lifecycle") return Effect.void;
    received.push(event.request);
    return broker.respond({
      clientId: host.clientId,
      connectionId: event.connectionId,
      requestId: event.request.requestId,
      ...(answer ?? { ok: true, result: host.clientId }),
    });
  }).pipe(Effect.forkScoped);
  yield* Deferred.await(connected);
  return received;
});

it.effect("retains distinct logical controllers for parallel callers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const agent = yield* serve({
        clientId: "agent",
        environmentId,
        supportedOperations: ["computerRequestControl"],
      });
      for (const [providerSessionId, controllerKind] of [
        ["provider-one", "agent"],
        ["provider-two", "human"],
      ] as const) {
        yield* broker.invoke({
          scope: {
            ...scope,
            thread: {
              ...scope.thread,
              controllerId: providerSessionId,
              providerSessionId,
              controllerKind,
            },
          },
          operation: "computerRequestControl",
          input: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
        });
      }
      expect(agent.map((request) => request.controllerKind)).toEqual(["agent", "human"]);
      expect(agent.map((request) => request.controllerId)).toEqual([
        "provider-one",
        "provider-two",
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("retains structured native desktop timeout diagnostics at the broker boundary", () =>
  Effect.gen(function* () {
    const failure = {
      code: "timed-out",
      category: "timeout",
      message: "The Agent desktop command timed out.",
      backendCode: "timed-out",
      detail: "guest process 42 exceeded its timeout",
    };
    yield* serve(
      {
        clientId: "agent",
        environmentId,
        supportedOperations: ["computerAct"],
      },
      {
        ok: false,
        error: {
          _tag: "PreviewAutomationExecutionError",
          message: "private host log",
          detail: { computerFailure: failure },
        },
      },
    );
    const error = yield* (yield* PreviewAutomationBroker.PreviewAutomationBroker)
      .invoke<void>({
        scope,
        operation: "computerAct",
        input: { desktop: { kind: "user", desktopId: "user-desktop-1" }, actions: [] },
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ computerFailure: failure });
    expect(error.message).toBe(failure.message);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects every missing computer target before routing a request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const received = yield* serve({
        clientId: "user",
        environmentId,
        supportedOperations: COMPUTER_AUTOMATION_OPERATIONS,
      });
      for (const operation of COMPUTER_AUTOMATION_OPERATIONS) {
        const error = yield* broker.invoke<void>({ scope, operation, input: {} }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "PreviewAutomationDesktopTargetRequiredError",
          computerFailure: {
            code: "desktop-target-required",
            field: "desktop",
            received: "missing",
          },
        });
      }
      expect(received).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("retains a tagged remote missing-host failure", () =>
  Effect.gen(function* () {
    const failure = {
      code: "agent-desktop-unavailable",
      category: "resource",
      message: "The environment host is unavailable.",
      backendCode: "no-connected-automation-host",
    };
    yield* serve(
      {
        clientId: "agent",
        environmentId,
        supportedOperations: ["computerStatus"],
      },
      {
        ok: false,
        error: {
          _tag: "PreviewAutomationNoAvailableHostError",
          message: "outer",
          detail: { computerFailure: failure },
        },
      },
    );
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const error = yield* broker
      .invoke<void>({
        scope,
        operation: "computerStatus",
        input: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "PreviewAutomationNoAvailableHostError",
      computerFailure: failure,
    });
    expect(error.message).toBe(failure.message);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("keeps focused user and preferred server-browser hosts independent", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const browser = yield* serve(
      {
        clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
        environmentId,
        supportedOperations: ["open", "snapshot"],
      },
      undefined,
      { preferred: true },
    );
    const user = yield* serve(
      {
        clientId: "focused-user",
        environmentId,
        supportedOperations: ["computerRequestControl", "computerAct"],
      },
      undefined,
      { focused: true },
    );
    expect(
      yield* broker.invoke({
        scope,
        operation: "computerRequestControl",
        input: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
      }),
    ).toBe("focused-user");
    expect(yield* broker.invoke({ scope, operation: "open", input: {} })).toBe(
      SERVER_BROWSER_AUTOMATION_CLIENT_ID,
    );
    expect(
      yield* broker.invoke({
        scope,
        operation: "computerAct",
        input: { desktop: { kind: "user", desktopId: "user-desktop-1" }, actions: [] },
      }),
    ).toBe("focused-user");
    expect(yield* broker.invoke({ scope, operation: "snapshot", input: {} })).toBe(
      SERVER_BROWSER_AUTOMATION_CLIENT_ID,
    );
    expect(user.map((request) => request.operation)).toEqual([
      "computerRequestControl",
      "computerAct",
    ]);
    expect(browser.map((request) => request.operation)).toEqual(["open", "snapshot"]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("explains missing native hosts without exposing other environments", () =>
  Effect.gen(function* () {
    yield* serve({
      clientId: "private-foreign-host",
      environmentId: EnvironmentId.make("foreign"),
      supportedOperations: ["computerStatus"],
    });
    const error = yield* (yield* PreviewAutomationBroker.PreviewAutomationBroker)
      .invoke<void>({
        scope,
        operation: "computerStatus",
        input: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "PreviewAutomationNoAvailableHostError",
      computerFailure: { backendCode: "user-desktop-offline" },
    });
    expect(JSON.stringify(error)).not.toContain("private-foreign-host");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("distinguishes unsupported operations from conflicting desktop identity claims", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    yield* serve({
      clientId: "user",
      environmentId,
      supportedOperations: ["computerRequestControl"],
    });
    const input = { desktop: { kind: "user", desktopId: "user-desktop-1" } };
    const unsupported = yield* broker
      .invoke<void>({ scope, operation: "computerStatus", input })
      .pipe(Effect.flip);
    expect(unsupported).toMatchObject({
      computerFailure: {
        backendCode: "user-desktop-operation-unsupported",
        field: "operation",
        received: "computerStatus",
      },
    });
    yield* broker.invoke({ scope, operation: "computerRequestControl", input });
    const alternative = yield* serve({
      clientId: "another-user",
      environmentId,
      supportedOperations: ["computerStatus"],
    });
    const assigned = yield* broker
      .invoke<void>({ scope, operation: "computerStatus", input })
      .pipe(Effect.flip);
    expect(assigned).toMatchObject({
      computerFailure: { code: "desktop-identity-conflict" },
    });
    expect(alternative).toEqual([]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "routes a stable identity through disconnect and reconnect without substituting another desktop",
  () =>
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const first = yield* serveInventoryHost({
        clientId: "first",
        environmentId,
        supportedOperations: ["computerStatus"],
        userDesktop: registration("user-first"),
      });
      const second = yield* serveInventoryHost({
        clientId: "second",
        environmentId,
        supportedOperations: ["computerStatus"],
        userDesktop: registration("user-second"),
      });
      const input = { desktop: { kind: "user", desktopId: "user-first" } };
      expect(yield* broker.invoke({ scope, operation: "computerStatus", input })).toBe("first");
      yield* Fiber.interrupt(first.fiber);
      expect(
        yield* broker.invoke<void>({ scope, operation: "computerStatus", input }).pipe(Effect.flip),
      ).toMatchObject({ computerFailure: { code: "desktop-offline" } });
      expect(second.requests).toEqual([]);
      yield* serveInventoryHost({
        clientId: "reconnected",
        environmentId,
        supportedOperations: ["computerStatus"],
        userDesktop: registration("user-first"),
      });
      expect(yield* broker.invoke({ scope, operation: "computerStatus", input })).toBe(
        "reconnected",
      );
      expect((yield* broker.listUserDesktops(environmentId)).desktops).toHaveLength(2);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "blocks duplicate identity claims and resumes routing once the duplicate disconnects",
  () =>
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      yield* serveInventoryHost({
        clientId: "original",
        environmentId,
        supportedOperations: ["computerStatus"],
        userDesktop: registration("user-shared"),
      });
      const duplicate = yield* serveInventoryHost({
        clientId: "duplicate",
        environmentId,
        supportedOperations: ["computerStatus"],
        userDesktop: registration("user-shared"),
      });
      const input = { desktop: { kind: "user", desktopId: "user-shared" } };
      expect((yield* broker.listUserDesktops(environmentId)).desktops).toMatchObject([
        { connectionState: "identity-conflict" },
      ]);
      expect(
        yield* broker.invoke<void>({ scope, operation: "computerStatus", input }).pipe(Effect.flip),
      ).toMatchObject({ computerFailure: { code: "desktop-identity-conflict" } });
      yield* Fiber.interrupt(duplicate.fiber);
      expect(yield* broker.invoke({ scope, operation: "computerStatus", input })).toBe("original");
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "retains an offline inventory, allows rename and removal, and restores the same identity on reconnect",
  () =>
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const host = {
        clientId: "inventory",
        environmentId,
        supportedOperations: ["computerStatus" as const],
        userDesktop: registration("user-inventory"),
      };
      const connected = yield* serveInventoryHost(host);
      expect(
        yield* broker.removeUserDesktop(environmentId, "user-inventory").pipe(Effect.flip),
      ).toMatchObject({ code: "user-desktop-online" });
      yield* broker.renameUserDesktop({ desktopId: "user-inventory", label: "Workstation" });
      yield* Fiber.interrupt(connected.fiber);
      expect((yield* broker.listUserDesktops(environmentId)).desktops).toMatchObject([
        { label: "Workstation", connectionState: "offline" },
      ]);
      yield* broker.removeUserDesktop(environmentId, "user-inventory");
      expect((yield* broker.listUserDesktops(environmentId)).desktops).toEqual([]);
      yield* serveInventoryHost(host);
      expect((yield* broker.listUserDesktops(environmentId)).desktops).toMatchObject([
        { desktop: { kind: "user", desktopId: "user-inventory" }, connectionState: "online" },
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "distinguishes incompatible clients, unsupported platforms and missing concrete targets",
  () =>
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const legacy = yield* serveInventoryHost({
        clientId: "legacy",
        environmentId,
        supportedOperations: ["computerStatus"],
      });
      expect(yield* broker.listUserDesktops(environmentId)).toEqual({
        desktops: [],
        incompatibleClientCount: 1,
        environmentHost: { status: "unidentified" },
      });
      expect(
        yield* broker
          .invoke<void>({
            scope,
            operation: "computerStatus",
            input: { desktop: { kind: "user" } },
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        computerFailure: { code: "desktop-target-required", field: "desktop.desktopId" },
      });
      expect(
        yield* broker
          .invoke<void>({
            scope,
            operation: "computerStatus",
            input: { desktop: { kind: "user", desktopId: "unknown" } },
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        computerFailure: {
          code: "desktop-offline",
          backendCode: "connected-client-update-required",
        },
      });
      expect(legacy.requests).toEqual([]);
      yield* serveInventoryHost({
        clientId: "unsupported",
        environmentId,
        supportedOperations: [],
        userDesktop: { ...registration("user-unsupported"), platform: "unknown", capabilities: [] },
      });
      expect(
        yield* broker
          .invoke<void>({
            scope,
            operation: "computerStatus",
            input: { desktop: { kind: "user", desktopId: "user-unsupported" } },
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        computerFailure: {
          code: "unsupported-operation",
          backendCode: "user-desktop-capability-unavailable",
        },
      });
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each([false, true])(
  "lists live metadata when persistence writes fail and stored data exists: %s",
  (hasStaleRecord) =>
    Effect.gen(function* () {
      const repository = UserDesktops.UserDesktopRepository.of({
        upsertHost: () =>
          Effect.fail(
            new PersistenceSqlError({
              operation: "test.upsertHost",
              cause: new Error("unavailable"),
            }),
          ),
        list: () =>
          Effect.succeed(
            hasStaleRecord
              ? [
                  {
                    desktopId: "user-live",
                    defaultLabel: "Stale",
                    customLabel: null,
                    platform: "unknown",
                    capabilities: [],
                    lastSeenAt: "2026-01-01T00:00:00.000Z",
                    lastActiveAt: null,
                  },
                ]
              : [],
          ),
        rename: () => Effect.void,
        remove: () => Effect.void,
        markActive: () => Effect.void,
        recordAudit: () => Effect.void,
        listAudit: () => Effect.succeed({ events: [] }),
      });
      yield* Effect.gen(function* () {
        yield* serveInventoryHost({
          clientId: "live",
          environmentId,
          supportedOperations: ["computerStatus"],
          userDesktop: registration("user-live"),
        });
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        expect((yield* broker.listUserDesktops(environmentId)).desktops).toMatchObject([
          {
            label: "user-live",
            platform: "linux",
            capabilities: ["view", "control", "availability"],
            connectionState: "online",
          },
        ]);
      }).pipe(
        Effect.provide(
          PreviewAutomationBroker.layer.pipe(
            Layer.provide(
              Layer.merge(
                NodeServices.layer,
                Layer.succeed(UserDesktops.UserDesktopRepository, repository),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "routes human remember, release and forget requests to the selected desktop with a human controller",
  () =>
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const target = yield* serveInventoryHost({
        clientId: "human-target",
        environmentId,
        supportedOperations: COMPUTER_AUTOMATION_OPERATIONS,
        userDesktop: registration("user-human"),
      });
      const humanScope = {
        ...scope,
        requestNamespace: "human:session",
        thread: {
          ...scope.thread,
          controllerId: "human:session",
          controllerKind: "human" as const,
          providerSessionId: "human:session",
          providerInstanceId: ProviderInstanceId.make("user-desktop-human"),
        },
      };
      for (const operation of [
        "status",
        "remember-view",
        "remember-control",
        "release",
        "end-all-access",
        "forget",
      ] as const) {
        expect(
          yield* runUserDesktopHumanRequest(broker, humanScope, {
            request: { operation, desktopId: "user-human" },
          }),
        ).toBe("human-target");
      }
      expect(target.requests.map((request) => request.operation)).toEqual([
        "computerStatus",
        "computerRememberView",
        "computerRememberControl",
        "computerRelease",
        "computerForceRelease",
        "computerForceForgetControl",
      ]);
      expect(target.requests.every((request) => request.controllerId === "human:session")).toBe(
        true,
      );
      expect(target.requests.every((request) => request.controllerKind === "human")).toBe(true);
      expect(target.requests.slice(1, 3).map((request) => request.input)).toEqual(
        [1, 2].map(() => ({
          desktop: { kind: "user", desktopId: "user-human" },
          observation: false,
        })),
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect.each(["timeout", "interruption"] as const)(
  "cancels the exact routed request after %s",
  (reason) =>
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const received = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
      const events = yield* broker.connect({
        clientId: "cancel-host",
        environmentId,
        userDesktop: registration("cancel-target"),
        supportedOperations: ["computerRequestControl"],
      });
      yield* Stream.runForEach(events, (event) => Queue.offer(received, event)).pipe(
        Effect.forkScoped,
      );
      const connected = yield* Queue.take(received);
      expect(connected.type).toBe("connected");
      const invoking = yield* broker
        .invoke({
          scope,
          operation: "computerRequestControl",
          input: { desktop: { kind: "user", desktopId: "cancel-target" } },
          updateCurrentTab: false,
          timeoutMs: 1000,
        })
        .pipe(Effect.result, Effect.forkScoped);
      const request = yield* Queue.take(received);
      expect(request.type).toBe("request");
      if (request.type !== "request") return yield* Effect.die("Expected native request");
      if (reason === "timeout") {
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(invoking);
        expect(result._tag).toBe("Failure");
      } else {
        yield* Fiber.interrupt(invoking);
      }
      expect(yield* Queue.take(received)).toEqual({
        type: "cancel",
        connectionId: connected.connectionId,
        requestId: request.request.requestId,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("routes stable logical identity across provider credential restarts", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const received = yield* serve({
      clientId: "stable-host",
      environmentId,
      userDesktop: registration("stable-target"),
      supportedOperations: ["computerStatus"],
    });
    for (const providerSessionId of ["old-credential", "new-credential"]) {
      yield* broker.invoke({
        scope: {
          ...scope,
          requestNamespace: providerSessionId,
          thread: { ...scope.thread, controllerId: "stable-controller", providerSessionId },
        },
        operation: "computerStatus",
        input: { desktop: { kind: "user", desktopId: "stable-target" } },
      });
    }
    expect(received.map((request) => request.controllerId)).toEqual([
      "stable-controller",
      "stable-controller",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "reads retained user evidence without requesting a new capture and rejects foreign scopes",
  () =>
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const observations = yield* ComputerObservationStore.ComputerObservationStore;
      const target = yield* serveInventoryHost({
        clientId: "evidence-host",
        environmentId,
        supportedOperations: COMPUTER_AUTOMATION_OPERATIONS,
        userDesktop: registration("user-evidence"),
      });
      yield* observations.publishController({
        environmentId,
        threadId: scope.thread.threadId,
        instanceId: scope.thread.providerInstanceId,
        desktopId: "user-evidence",
        source: "snapshot",
        observation: {
          snapshot: {
            display: {
              id: "display-0",
              label: "Display",
              primary: true,
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              scaleFactor: 1,
            },
            cursor: null,
            captureSource: "virtual-display",
            accessibility: {
              available: true,
              coordinateSpace: "focused-window",
              window: null,
              windows: [],
              targets: [],
              truncated: false,
            },
          },
        },
      });
      const retained = yield* observations.read({
        environmentId,
        threadId: scope.thread.threadId,
        desktopId: "user-evidence",
      });
      const observationId = retained.latestId!;
      expect(
        yield* runUserDesktopHumanRequest(broker, scope, {
          request: {
            operation: "observation-list",
            desktopId: "user-evidence",
          },
        }),
      ).toMatchObject({ observations: [{ id: observationId, hasAccessibility: true }] });
      expect(
        yield* runUserDesktopHumanRequest(broker, scope, {
          request: {
            operation: "observation",
            desktopId: "user-evidence",
            observationId,
          },
        }),
      ).toEqual(retained);
      expect(
        yield* runUserDesktopHumanRequest(
          broker,
          { ...scope, environmentId: EnvironmentId.make("foreign-environment") },
          { request: { operation: "observation", desktopId: "user-evidence", observationId } },
        ),
      ).toEqual({ latestId: null });
      expect(
        yield* runUserDesktopHumanRequest(broker, scope, {
          request: {
            operation: "observation",
            desktopId: "other-desktop",
            observationId,
          },
        }),
      ).toEqual({ latestId: null });
      expect(target.requests).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "audits successful access transitions with nested caller identity and no authorization payload",
  () =>
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      yield* serve({
        clientId: "audit-host",
        environmentId,
        supportedOperations: COMPUTER_AUTOMATION_OPERATIONS,
      });
      const desktop = { kind: "user" as const, desktopId: "user-desktop-1" };
      yield* broker.invoke({
        scope,
        operation: "computerRequestControl",
        input: { desktop, takeoverLeaseId: "opaque-confirmation", typedText: "private typed text" },
      });
      const human = { ...scope, thread: { ...scope.thread, controllerKind: "human" as const } };
      for (const [operation, options] of [
        ["computerRequestView", { releaseControlToView: true }],
        ["computerRequestControl", { returnControlToAgent: true }],
        ["computerRelease", {}],
        ["computerForceRelease", {}],
        ["computerRememberView", {}],
        ["computerRememberControl", {}],
        ["computerForceForgetControl", {}],
      ] as const)
        yield* broker.invoke({ scope: human, operation, input: { desktop, ...options } });
      const audit = yield* broker.listUserDesktopAudit(desktop.desktopId);
      expect(audit.events.map((event) => event.action)).toEqual([
        "approval-forgotten",
        "control-remembered",
        "view-remembered",
        "all-access-ended",
        "access-released",
        "control-returned-to-agent",
        "control-released",
        "control-granted",
      ]);
      expect(audit.events.at(-1)).toMatchObject({
        actorKind: "agent",
        threadId: scope.thread.threadId,
        actorLabel: scope.thread.providerInstanceId,
        takeover: true,
      });
      expect(audit.events[0]).toMatchObject({ actorKind: "human", takeover: false });
      expect(audit.events[0]).not.toHaveProperty("threadId");
      expect(audit.events[0]).not.toHaveProperty("actorLabel");
      expect(JSON.stringify(audit)).not.toContain("opaque-confirmation");
      expect(JSON.stringify(audit)).not.toContain("private typed text");
      expect(
        yield* runUserDesktopHumanRequest(broker, human, {
          request: { operation: "audit", desktopId: desktop.desktopId },
        }),
      ).toEqual(audit);
      expect(yield* broker.listUserDesktopAudit("other-desktop")).toEqual({ events: [] });
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("does not audit rejected access", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    yield* serve(
      { clientId: "denied-host", environmentId, supportedOperations: ["computerRequestControl"] },
      { ok: false, error: { _tag: "PreviewAutomationExecutionError", message: "Denied" } },
    );
    yield* broker
      .invoke<void>({
        scope,
        operation: "computerRequestControl",
        input: { desktop: { kind: "user", desktopId: "user-desktop-1" } },
      })
      .pipe(Effect.flip);
    expect(yield* broker.listUserDesktopAudit("user-desktop-1")).toEqual({ events: [] });
  }).pipe(Effect.provide(layer), Effect.scoped),
);

const USER_DESKTOP = registration("user-desktop-1");
it.effect("identifies the desktop-managed environment host while it is offline", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.make.pipe(
      Effect.provideService(PreviewAutomationBroker.EnvironmentUserDesktopHost, USER_DESKTOP),
      Effect.provide(Layer.merge(UserDesktops.layerMemory, NodeServices.layer)),
    );

    expect(yield* broker.listUserDesktops(scope.environmentId)).toMatchObject({
      environmentHost: {
        status: "identified",
        desktop: { kind: "user", desktopId: USER_DESKTOP.desktopId },
      },
      desktops: [
        {
          desktop: { kind: "user", desktopId: USER_DESKTOP.desktopId },
          connectionState: "offline",
        },
      ],
    });
  }),
);

it.effect("retains the environment host when the inventory reaches its bound", () =>
  Effect.gen(function* () {
    const records = [
      ...Array.from({ length: MAX_USER_DESKTOPS }, (_, index) =>
        UserDesktops.UserDesktopRecord.make({
          desktopId: `other-desktop-${index}`,
          defaultLabel: `Other desktop ${index}`,
          customLabel: null,
          platform: "linux",
          capabilities: ["view", "control", "availability"],
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          lastActiveAt: null,
        }),
      ),
      UserDesktops.UserDesktopRecord.make({
        desktopId: USER_DESKTOP.desktopId,
        defaultLabel: USER_DESKTOP.defaultLabel,
        customLabel: null,
        platform: USER_DESKTOP.platform,
        capabilities: USER_DESKTOP.capabilities,
        lastSeenAt: "2025-01-01T00:00:00.000Z",
        lastActiveAt: null,
      }),
    ];
    const repository = UserDesktops.UserDesktopRepository.of({
      upsertHost: () => Effect.void,
      list: () => Effect.succeed(records),
      rename: () => Effect.void,
      remove: () => Effect.void,
      markActive: () => Effect.void,
      recordAudit: () => Effect.void,
      listAudit: () => Effect.succeed({ events: [] }),
    });
    const broker = yield* PreviewAutomationBroker.make.pipe(
      Effect.provideService(PreviewAutomationBroker.EnvironmentUserDesktopHost, USER_DESKTOP),
      Effect.provideService(UserDesktops.UserDesktopRepository, repository),
      Effect.provide(NodeServices.layer),
    );

    const listed = yield* broker.listUserDesktops(scope.environmentId);

    expect(listed.desktops).toHaveLength(MAX_USER_DESKTOPS);
    expect(
      listed.desktops.some((desktop) => desktop.desktop.desktopId === USER_DESKTOP.desktopId),
    ).toBe(true);
  }),
);

it.effect("keeps the bootstrap owner separate from a focused remote client", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.make.pipe(
      Effect.provideService(PreviewAutomationBroker.EnvironmentUserDesktopHost, USER_DESKTOP),
      Effect.provide(Layer.merge(UserDesktops.layerMemory, NodeServices.layer)),
    );
    const remote = yield* broker.connect({
      clientId: "remote-client",
      environmentId,
      userDesktop: registration("remote-user"),
      supportedOperations: ["computerStatus"],
    });
    const ready = yield* Deferred.make<void>();
    const fiber = yield* Stream.runForEach(remote, (event) =>
      event.type === "connected"
        ? broker
            .focusHost({
              clientId: "remote-client",
              environmentId,
              connectionId: event.connectionId,
              focused: true,
            })
            .pipe(Effect.andThen(Deferred.succeed(ready, undefined)))
        : Effect.void,
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    const listed = yield* broker.listUserDesktops(environmentId);
    expect(listed.environmentHost).toEqual({
      status: "identified",
      desktop: { kind: "user", desktopId: USER_DESKTOP.desktopId },
    });
    expect(
      listed.desktops.find((desktop) => desktop.desktop.desktopId === "remote-user"),
    ).toMatchObject({ connectionState: "online", t3Focused: true });
    expect(
      listed.desktops.find((desktop) => desktop.desktop.desktopId === USER_DESKTOP.desktopId),
    ).toMatchObject({ connectionState: "offline" });
    yield* Fiber.interrupt(fiber);
    expect((yield* broker.listUserDesktops(environmentId)).environmentHost).toEqual(
      listed.environmentHost,
    );
  }),
);

it.effect("evicts an unanswered native host and ignores its late traffic after recovery", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const events = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
    const host = {
      clientId: "frozen-native",
      environmentId,
      userDesktop: registration("target"),
      supportedOperations: [...COMPUTER_AUTOMATION_OPERATIONS],
    };
    yield* (yield* broker.connect(host)).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    const connected = yield* Queue.take(events);
    expect(connected.type).toBe("connected");
    const invoke = (
      operation: "computerStatus" | "computerAct" | "computerSnapshot",
      timeoutMs = 10_000,
    ) =>
      broker.invoke({
        scope,
        operation,
        input: { desktop: { kind: "user", desktopId: "target" } },
        timeoutMs,
      });
    const warm = yield* invoke("computerStatus").pipe(Effect.forkScoped);
    const warmRequest = yield* Queue.take(events);
    if (warmRequest.type !== "request") return yield* Effect.die("expected warm request");
    yield* broker.respond({
      clientId: host.clientId,
      connectionId: connected.connectionId,
      requestId: warmRequest.request.requestId,
      ok: true,
      result: "warm",
    });
    yield* Fiber.join(warm);
    const first = yield* invoke("computerAct", 1_000).pipe(Effect.result, Effect.forkScoped);
    const firstRequest = yield* Queue.take(events);
    if (firstRequest.type !== "request") return yield* Effect.die("expected action request");
    const second = yield* invoke("computerSnapshot").pipe(Effect.result, Effect.forkScoped);
    expect((yield* Queue.take(events)).type).toBe("request");
    const healthy = yield* serveInventoryHost({ ...host, clientId: "healthy-native" });
    yield* TestClock.adjust(2_000);
    expect(yield* Fiber.join(first)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "PreviewAutomationTimeoutError" },
    });
    expect(yield* Fiber.join(second)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "PreviewAutomationClientDisconnectedError" },
    });
    yield* broker.respond({
      clientId: host.clientId,
      connectionId: connected.connectionId,
      requestId: firstRequest.request.requestId,
      ok: true,
      result: "late",
    });
    yield* broker.focusHost({
      clientId: host.clientId,
      connectionId: connected.connectionId,
      environmentId,
      focused: true,
    });
    expect(yield* invoke("computerStatus")).toBe("healthy-native");
    expect(healthy.requests).toHaveLength(1);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("routes command execution to its exact desktop independently of screen access", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const desktop = { kind: "user", desktopId: "execution-desktop" } as const;
    const host = yield* serveInventoryHost({
      clientId: "execution-host",
      environmentId,
      userDesktop: {
        ...registration(desktop.desktopId),
        platform: "macos",
        capabilities: ["execution"],
      },
      supportedOperations: ["computerExecution"],
    });
    const input = { operation: "process", desktop, input: { action: "list", desktop } } as const;
    expect(yield* broker.invoke({ scope, operation: "computerExecution", input })).toBe(
      "execution-host",
    );
    expect(host.requests[0]).toMatchObject({
      operation: "computerExecution",
      input,
      threadId: scope.thread.threadId,
    });
    expect(
      (yield* broker.listUserDesktops(environmentId, { includeExecution: true })).desktops[0]
        ?.capabilities,
    ).toEqual(["execution"]);
    expect((yield* broker.listUserDesktops(environmentId)).desktops[0]?.capabilities).toEqual([]);
    expect(
      yield* broker
        .invoke<void>({
          scope,
          operation: "computerExecution",
          input: { ...input, desktop: { kind: "user", desktopId: "other-desktop" } },
        })
        .pipe(Effect.flip),
    ).toMatchObject({ computerFailure: { code: "desktop-offline" } });
    expect(
      yield* runUserDesktopHumanRequest(broker, scope, {
        request: { operation: "execution", desktopId: desktop.desktopId, input },
      }),
    ).toBe("execution-host");
    expect(
      yield* runUserDesktopHumanRequest(broker, scope, {
        request: { operation: "list", includeExecution: true },
      }),
    ).toMatchObject({ desktops: [{ capabilities: ["execution"] }] });
  }).pipe(Effect.provide(layer), Effect.scoped),
);

function runUserDesktopHumanRequest(
  ...args: [
    Parameters<typeof runHumanRequest>[0],
    Parameters<typeof runHumanRequest>[1],
    Parameters<typeof runHumanRequest>[2],
  ]
) {
  return runHumanRequest(...args, AuthSessionId.make("test-session")).pipe(
    Effect.provideService(DesktopExecutionAuthorizationChannel, {
      invoke: () => Effect.succeedNone,
      reserveWorktreeCleanup: Effect.succeed(false),
    }),
  );
}

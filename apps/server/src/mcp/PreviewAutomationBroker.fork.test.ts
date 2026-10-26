import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  COMPUTER_AUTOMATION_OPERATIONS,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("fork-agent-environment");
const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId,
  requestNamespace: "provider-one",
  thread: {
    threadId: ThreadId.make("thread-one"),
    providerSessionId: "provider-one",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};
const layer = PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer));
const serve = Effect.fn("ForkBrokerTest.serve")(function* (
  host: PreviewAutomationHost,
  answer?: Pick<PreviewAutomationResponse, "ok" | "result" | "error">,
  options?: { readonly focused?: boolean; readonly preferred?: boolean },
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const connected = yield* Deferred.make<void>();
  const received: PreviewAutomationRequest[] = [];
  const events = yield* broker.connect(host, options);
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
      ).pipe(Effect.andThen(Deferred.succeed(connected, undefined)));
    }
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

it.effect("keeps browser affinity independent when explicit desktop targets change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const user = yield* serve({
        clientId: "user",
        environmentId,
        supportedOperations: ["status", "computerRequestControl", "computerAct"],
        computerDesktopKinds: ["user"],
      });
      const agent = yield* serve({
        clientId: "agent",
        environmentId,
        supportedOperations: ["agentDesktopList", "computerRequestControl", "computerAct"],
        computerDesktopKinds: ["agent"],
      });
      expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toBe("user");
      expect(yield* broker.invoke({ scope, operation: "agentDesktopList", input: {} })).toBe(
        "agent",
      );
      expect(
        yield* broker.invoke({
          scope,
          operation: "computerRequestControl",
          input: { desktop: { kind: "agent", fresh: true } },
        }),
      ).toBe("agent");
      expect(
        yield* broker.invoke({
          scope,
          operation: "computerAct",
          input: { desktop: { kind: "agent", desktopId: "agent-one" }, actions: [] },
        }),
      ).toBe("agent");
      expect(
        yield* broker.invoke({
          scope,
          operation: "computerRequestControl",
          input: { desktop: { kind: "user" } },
        }),
      ).toBe("user");
      expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toBe("user");
      expect(user).toHaveLength(3);
      expect(agent).toHaveLength(3);
      expect(agent.map((request) => request.controllerId)).toEqual(
        Array(3).fill(scope.thread.providerSessionId),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("sends human supervision only to an Agent host and retains the controller identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const agent = yield* serve({
        clientId: "agent",
        environmentId,
        supportedOperations: ["agentDesktopHumanInvoke"],
        computerDesktopKinds: ["agent"],
      });
      const user = yield* serve({
        clientId: "user",
        environmentId,
        supportedOperations: ["agentDesktopHumanInvoke"],
        computerDesktopKinds: ["user"],
      });
      expect(
        yield* broker.invoke({
          scope: { ...scope, thread: { ...scope.thread, providerSessionId: "human:one" } },
          operation: "agentDesktopHumanInvoke",
          input: { operation: "list" },
        }),
      ).toBe("agent");
      expect(agent[0]?.controllerId).toBe("human:one");
      expect(user).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("retains distinct controllers for parallel provider sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const agent = yield* serve({
        clientId: "agent",
        environmentId,
        supportedOperations: ["computerRequestControl"],
        computerDesktopKinds: ["agent"],
      });
      for (const providerSessionId of ["provider-one", "provider-two"]) {
        yield* broker.invoke({
          scope: { ...scope, thread: { ...scope.thread, providerSessionId } },
          operation: "computerRequestControl",
          input: { desktop: { kind: "agent", fresh: true } },
        });
      }
      expect(agent.map((request) => request.controllerId)).toEqual([
        "provider-one",
        "provider-two",
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("retains structured Agent desktop timeout diagnostics at the broker boundary", () =>
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
        supportedOperations: ["agentDesktopCommand"],
        computerDesktopKinds: ["agent"],
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
        operation: "agentDesktopCommand",
        input: { executable: "/usr/bin/env" },
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ computerFailure: failure });
    expect(error.message).toBe(failure.message);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps focused user, primary Agent and server browser hosts independent", () =>
  Effect.scoped(
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
          computerDesktopKinds: ["user"],
        },
        undefined,
        { focused: true },
      );
      const agent = yield* serve({
        clientId: "primary-agent",
        environmentId,
        supportedOperations: ["agentDesktopList", "computerRequestControl", "computerAct"],
        computerDesktopKinds: ["user", "agent"],
      });
      expect(
        yield* broker.invoke({
          scope,
          operation: "computerRequestControl",
          input: { desktop: { kind: "user" } },
        }),
      ).toBe("focused-user");
      expect(yield* broker.invoke({ scope, operation: "agentDesktopList", input: {} })).toBe(
        "primary-agent",
      );
      expect(yield* broker.invoke({ scope, operation: "open", input: {} })).toBe(
        SERVER_BROWSER_AUTOMATION_CLIENT_ID,
      );
      expect(
        yield* broker.invoke({
          scope,
          operation: "computerAct",
          input: { desktop: { kind: "agent", desktopId: "agent-one" }, actions: [] },
        }),
      ).toBe("primary-agent");
      expect(
        yield* broker.invoke({
          scope,
          operation: "computerAct",
          input: { desktop: { kind: "user" }, actions: [] },
        }),
      ).toBe("focused-user");
      expect(yield* broker.invoke({ scope, operation: "snapshot", input: {} })).toBe(
        SERVER_BROWSER_AUTOMATION_CLIENT_ID,
      );
      expect(user.map((request) => request.operation)).toEqual([
        "computerRequestControl",
        "computerAct",
      ]);
      expect(agent.map((request) => request.operation)).toEqual([
        "agentDesktopList",
        "computerAct",
      ]);
      expect(browser.map((request) => request.operation)).toEqual(["open", "snapshot"]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("rejects every missing computer target before routing a request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const received = yield* serve({
        clientId: "user",
        environmentId,
        supportedOperations: COMPUTER_AUTOMATION_OPERATIONS,
        computerDesktopKinds: ["user"],
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

it.effect("explains missing environment hosts without exposing other environments", () =>
  Effect.gen(function* () {
    yield* serve({
      clientId: "private-foreign-host",
      environmentId: EnvironmentId.make("foreign"),
      supportedOperations: ["agentDesktopList"],
      computerDesktopKinds: ["agent"],
    });
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const error = yield* broker
      .invoke<void>({ scope, operation: "agentDesktopList", input: {} })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "PreviewAutomationNoAvailableHostError",
      computerFailure: {
        code: "agent-desktop-unavailable",
        category: "resource",
        backendCode: "no-connected-automation-host",
        detail:
          "Connected hosts: 0; hosts supporting agentDesktopList: 0; advertised desktop kinds: none.",
      },
    });
    expect(error.message).toContain("Agent desktops are owned by the environment");
    expect(JSON.stringify(error)).not.toContain("private-foreign-host");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("distinguishes desktop-kind, operation and assigned-host incompatibility", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    yield* serve({
      clientId: "user",
      environmentId,
      supportedOperations: ["computerRequestControl"],
      computerDesktopKinds: ["user"],
    });
    const missingKind = yield* broker
      .invoke<void>({
        scope,
        operation: "computerRequestControl",
        input: { desktop: { kind: "agent" } },
      })
      .pipe(Effect.flip);
    expect(missingKind).toMatchObject({
      computerFailure: {
        backendCode: "environment-agent-desktop-host-required",
        field: "desktop.kind",
        received: "agent",
        expected: ["user"],
      },
    });
    yield* serve({
      clientId: "agent",
      environmentId,
      supportedOperations: ["computerRequestControl"],
      computerDesktopKinds: ["agent"],
    });
    const missingOperation = yield* broker
      .invoke<void>({ scope, operation: "agentDesktopList", input: {} })
      .pipe(Effect.flip);
    expect(missingOperation).toMatchObject({
      computerFailure: {
        backendCode: "automation-operation-unsupported",
        field: "operation",
        received: "agentDesktopList",
      },
    });
    yield* broker.invoke({
      scope,
      operation: "computerRequestControl",
      input: { desktop: { kind: "agent" } },
    });
    const alternative = yield* serve({
      clientId: "another-agent",
      environmentId,
      supportedOperations: ["agentDesktopList"],
      computerDesktopKinds: ["agent"],
    });
    const assigned = yield* broker
      .invoke<void>({ scope, operation: "agentDesktopList", input: {} })
      .pipe(Effect.flip);
    expect(assigned).toMatchObject({
      computerFailure: { backendCode: "assigned-automation-host-incompatible" },
    });
    expect(alternative).toEqual([]);
  }).pipe(Effect.provide(layer), Effect.scoped),
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
        supportedOperations: ["agentDesktopList"],
        computerDesktopKinds: ["agent"],
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
      .invoke<void>({ scope, operation: "agentDesktopList", input: {} })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "PreviewAutomationNoAvailableHostError",
      computerFailure: failure,
    });
    expect(error.message).toBe(failure.message);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

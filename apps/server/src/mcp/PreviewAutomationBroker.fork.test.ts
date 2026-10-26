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

it.effect("retains distinct controllers for parallel provider sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const agent = yield* serve({
        clientId: "agent",
        environmentId,
        supportedOperations: ["computerRequestControl"],
      });
      for (const providerSessionId of ["provider-one", "provider-two"]) {
        yield* broker.invoke({
          scope: { ...scope, thread: { ...scope.thread, providerSessionId } },
          operation: "computerRequestControl",
          input: { desktop: { kind: "user" } },
        });
      }
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
        input: { desktop: { kind: "user" }, actions: [] },
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
      .invoke<void>({ scope, operation: "computerStatus", input: { desktop: { kind: "user" } } })
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
        input: { desktop: { kind: "user" } },
      }),
    ).toBe("focused-user");
    expect(yield* broker.invoke({ scope, operation: "open", input: {} })).toBe(
      SERVER_BROWSER_AUTOMATION_CLIENT_ID,
    );
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
      .invoke<void>({ scope, operation: "computerStatus", input: { desktop: { kind: "user" } } })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "PreviewAutomationNoAvailableHostError",
      computerFailure: { backendCode: "no-connected-automation-host" },
    });
    expect(JSON.stringify(error)).not.toContain("private-foreign-host");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("distinguishes unsupported operations and never substitutes an assigned host", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    yield* serve({
      clientId: "user",
      environmentId,
      supportedOperations: ["computerRequestControl"],
    });
    const input = { desktop: { kind: "user" } };
    const unsupported = yield* broker
      .invoke<void>({ scope, operation: "computerStatus", input })
      .pipe(Effect.flip);
    expect(unsupported).toMatchObject({
      computerFailure: {
        backendCode: "automation-operation-unsupported",
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
      computerFailure: { backendCode: "assigned-automation-host-incompatible" },
    });
    expect(alternative).toEqual([]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

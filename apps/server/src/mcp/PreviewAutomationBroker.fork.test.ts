import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
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
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const connected = yield* Deferred.make<void>();
  const received: PreviewAutomationRequest[] = [];
  const events = yield* broker.connect(host);
  yield* Stream.runForEach(events, (event) => {
    if (event.type === "connected") return Deferred.succeed(connected, undefined);
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

it.effect("keeps user-desktop and browser affinity separate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const browser = yield* serve({
        clientId: "browser",
        environmentId,
        supportedOperations: ["status"],
      });
      const native = yield* serve({
        clientId: "native",
        environmentId,
        supportedOperations: ["computerRequestControl", "computerAct"],
      });
      expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toBe("browser");
      expect(
        yield* broker.invoke({
          scope,
          operation: "computerRequestControl",
          input: { desktop: { kind: "user" } },
        }),
      ).toBe("native");
      expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toBe("browser");
      expect(browser).toHaveLength(2);
      expect(native).toHaveLength(1);
      expect(native[0]?.controllerId).toBe(scope.thread.providerSessionId);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([undefined, { kind: "agent", desktopId: "agent-one" }])(
  "rejects an unresolved or server-owned target before native delivery: %s",
  (desktop) =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const native = yield* serve({
          clientId: "native",
          environmentId,
          supportedOperations: ["computerAct"],
        });
        const error = yield* Effect.flip(
          broker.invoke<never>({
            scope,
            operation: "computerAct",
            input: { desktop, actions: [] },
          }),
        );
        expect(error._tag).toBe("PreviewAutomationDesktopTargetRequiredError");
        expect(native).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("retains structured native timeout diagnostics at the broker boundary", () =>
  Effect.gen(function* () {
    const failure = {
      code: "timed-out",
      category: "timeout",
      message: "The desktop operation timed out.",
      backendCode: "timed-out",
      detail: "native backend exceeded its timeout",
    };
    yield* serve(
      {
        clientId: "native",
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
        input: { desktop: { kind: "user" }, actions: [{ type: "press", key: "Enter" }] },
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ computerFailure: failure });
    expect(error.message).toBe(failure.message);
  }).pipe(Effect.provide(layer)),
);

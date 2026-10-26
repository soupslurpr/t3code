import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
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
const serve = Effect.fn("ForkBrokerTest.serve")(function* (host: PreviewAutomationHost) {
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
      ok: true,
      result: host.clientId,
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

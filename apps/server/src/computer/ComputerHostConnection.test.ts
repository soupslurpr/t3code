import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type ComputerHostRegistration } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeHostConnection } from "./ComputerHostConnection.ts";

const registration: ComputerHostRegistration = {
  clientId: "attached",
  environmentId: EnvironmentId.make("environment"),
  supportedOperations: [
    "computerRequestControl",
    "computerStatus",
    "computerExecution",
    "computerTransfer",
  ],
  userDesktop: {
    protocolVersion: 1,
    desktopId: "host",
    defaultLabel: "Workstation",
    platform: "linux",
    capabilities: ["view", "control", "availability"],
  },
};
const caller = {
  environmentId: registration.environmentId,
  threadId: ThreadId.make("thread"),
  controllerId: "controller",
  controllerKind: "agent" as const,
};
const lifecycle = { read: () => Effect.die("Unexpected lifecycle read"), changes: Stream.empty };

it.effect(
  "rejects pre-grant on a legacy host before sending a request, then grants a normal request",
  () =>
    Effect.gen(function* () {
      const host = yield* makeHostConnection(registration, lifecycle);
      const rejected = yield* Effect.result(
        host.invoke(caller, "computerRequestControl", { acquireLease: false }, 100),
      );
      expect(rejected).toMatchObject({
        _tag: "Failure",
        failure: { computerFailure: { code: "desktop-client-update-required" } },
      });
      for (const operation of ["computerExecution", "computerTransfer"] as const) {
        expect(yield* Effect.result(host.invoke(caller, operation, {}, 100))).toMatchObject({
          _tag: "Failure",
          failure: { computerFailure: { code: "unsupported-operation" } },
        });
      }
      const requests: unknown[] = [];
      yield* host.events.pipe(
        Stream.runForEach((event) => {
          if (event.type !== "request") return Effect.void;
          requests.push(event.request.input);
          return host.respond({
            clientId: registration.clientId,
            connectionId: host.connectionId,
            requestId: event.request.requestId,
            ok: true,
            result: "active",
          });
        }),
        Effect.forkScoped,
      );
      expect(yield* host.invoke(caller, "computerRequestControl", {}, 100)).toBe("active");
      expect(requests).toEqual([{}]);
      yield* host.close();
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("cancels expired consent and continues serving the same host generation", () =>
  Effect.gen(function* () {
    const host = yield* makeHostConnection(
      { ...registration, supportsPermissionPreparation: true },
      lifecycle,
    );
    const requested = yield* Deferred.make<string>();
    const cancelled = yield* Queue.unbounded<string>();
    yield* host.events.pipe(
      Stream.runForEach((event) => {
        if (event.type === "cancel") return Queue.offer(cancelled, event.requestId);
        if (event.type !== "request") return Effect.void;
        if (event.request.operation === "computerRequestControl")
          return Deferred.succeed(requested, event.request.requestId);
        return host.respond({
          clientId: registration.clientId,
          connectionId: host.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: "ready",
        });
      }),
      Effect.forkScoped,
    );
    const pending = yield* Effect.result(
      host.invoke(caller, "computerRequestControl", { acquireLease: false }, 250),
    ).pipe(Effect.forkScoped);
    const id = yield* Deferred.await(requested);
    yield* TestClock.adjust(250);
    expect(yield* Fiber.join(pending)).toMatchObject({
      _tag: "Failure",
      failure: { computerFailure: { code: "timed-out" } },
    });
    expect(yield* Queue.take(cancelled)).toBe(id);
    expect(host.isOpen()).toBe(true);
    expect(yield* host.invoke(caller, "computerStatus", {}, 100)).toBe("ready");
    yield* host.close();
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

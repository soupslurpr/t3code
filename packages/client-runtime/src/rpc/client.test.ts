import {
  EnvironmentId,
  type PreviewAutomationStreamEvent,
  type RelayClientInstallProgressEvent,
  type ServerLifecycleStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { runStream, subscribe, subscribeDynamicWithSession } from "./client.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INSTALL_CHECKING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "checking",
};
const INSTALL_DOWNLOADING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "downloading",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    retryCount,
    supervisor,
  };
});

describe("environment RPC", () => {
  it.effect.each([false, true])(
    "reopens a completed automation registration only when configured (%s)",
    (reconnect) =>
      Effect.gen(function* () {
        const first = yield* Queue.unbounded<PreviewAutomationStreamEvent, Cause.Done>();
        const second = yield* Queue.unbounded<PreviewAutomationStreamEvent, Cause.Done>();
        const started = yield* Queue.unbounded<number>();
        const received = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
        const ended = yield* Deferred.make<void>();
        let subscriptions = 0;
        const client = {
          [WS_METHODS.previewAutomationConnect]: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                subscriptions += 1;
                yield* Queue.offer(started, subscriptions);
                return subscriptions === 1
                  ? Stream.fromQueue(first).pipe(
                      Stream.ensuring(Deferred.succeed(ended, undefined)),
                    )
                  : Stream.fromQueue(second);
              }),
            ),
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor, retryCount } = yield* makeHarness();
        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const fiber = yield* subscribe(
          WS_METHODS.previewAutomationConnect,
          { clientId: "desktop", environmentId: TARGET.environmentId },
          reconnect ? { resubscribeOnCompletionAfter: "1 second" } : undefined,
        ).pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        expect(yield* Queue.take(started)).toBe(1);
        yield* Queue.offer(first, { type: "connected", connectionId: "first" });
        expect(yield* Queue.take(received)).toEqual({ type: "connected", connectionId: "first" });
        yield* Queue.end(first);
        yield* Deferred.await(ended);
        yield* TestClock.adjust("999 millis");
        expect(Option.isNone(yield* Queue.poll(started))).toBe(true);
        yield* TestClock.adjust("1 millis");
        expect(subscriptions).toBe(reconnect ? 2 : 1);
        if (reconnect) {
          expect(yield* Queue.take(started)).toBe(2);
          yield* Queue.offer(second, { type: "connected", connectionId: "second" });
          expect(yield* Queue.take(received)).toEqual({
            type: "connected",
            connectionId: "second",
          });
        }
        expect(subscriptions).toBe(reconnect ? 2 : 1);
        expect(yield* Ref.get(retryCount)).toBe(0);
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust("5 seconds");
        expect(Option.isNone(yield* Queue.poll(started))).toBe(true);
      }),
  );

  it.effect("cancels a completion retry when the supervisor replaces its session", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>();
      const ended = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.fromEffect(Queue.offer(started, "first")).pipe(
            Stream.drain,
            Stream.ensuring(Deferred.succeed(ended, undefined)),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.fromEffect(Queue.offer(started, "second")).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const fiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        { resubscribeOnCompletionAfter: "1 second" },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      expect(yield* Queue.take(started)).toBe("first");
      yield* Deferred.await(ended);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      expect(yield* Queue.take(started)).toBe("second");
      yield* TestClock.adjust("5 seconds");
      expect(Option.isNone(yield* Queue.poll(started))).toBe(true);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect.each([WS_METHODS.subscribeTerminalEvents, WS_METHODS.previewAutomationConnect])(
    "switches durable %s subscriptions when the supervisor replaces the session",
    (method) =>
      Effect.gen(function* () {
        const subscriptions: string[] = [];
        const subscriptionChanges = yield* Queue.make<void>();
        const firstClient = {
          [method]: () => {
            subscriptions.push("first");
            Queue.offerUnsafe(subscriptionChanges, undefined);
            return Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const secondClient = {
          [method]: () => {
            subscriptions.push("second");
            Queue.offerUnsafe(subscriptionChanges, undefined);
            return Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, retryCount, supervisor } = yield* makeHarness();
        const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
          count: number,
        ) {
          for (;;) {
            if (subscriptions.length >= count) {
              return;
            }
            yield* Queue.take(subscriptionChanges);
          }
        });

        const subscriptionFiber = yield* subscribe(
          method,
          method === WS_METHODS.previewAutomationConnect
            ? {
                clientId: "computer-host",
                environmentId: TARGET.environmentId,
                supportedOperations: ["computerStatus"],
              }
            : {},
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
        yield* awaitSubscriptions(1);
        yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
        yield* awaitSubscriptions(2);
        yield* Fiber.interrupt(subscriptionFiber);

        expect(subscriptions).toEqual(["first", "second"]);
        expect(yield* Ref.get(retryCount)).toBe(0);
      }),
  );

  it.effect("keeps the producer session on an old value buffered across a session switch", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const firstValueBlocked = yield* Deferred.make<void>();
      const releaseFirstValue = yield* Deferred.make<void>();
      const firstValue = { source: "first", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const bufferedFirstValue = {
        source: "first",
        index: 2,
      } as unknown as ServerLifecycleStreamEvent;
      const secondValue = { source: "second", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable([firstValue, bufferedFirstValue])),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(secondValue)),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const { activeSession, supervisor } = yield* makeHarness();

      const resultFiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeServerLifecycle,
        () => Effect.succeed({}),
      ).pipe(
        Stream.mapEffect(([producerSession, value]) =>
          value === firstValue
            ? Deferred.succeed(firstValueBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstValue)),
                Effect.as([producerSession, value] as const),
              )
            : Effect.succeed([producerSession, value] as const),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* Deferred.await(firstSubscribed);
      yield* Deferred.await(firstValueBlocked);
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      yield* Deferred.await(secondSubscribed);
      yield* Deferred.succeed(releaseFirstValue, undefined);

      const result = yield* Fiber.join(resultFiber);
      expect(result).toEqual([
        [firstSession, firstValue],
        [firstSession, bufferedFirstValue],
        [secondSession, secondValue],
      ]);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      while (subscriptions.length < 1) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const observedFailures: Error[] = [];
      const failureObserved = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
              Deferred.doneUnsafe(failureObserved, Effect.void);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(failureObserved);

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect.each(["input", "stream"] as const)(
    "does not classify %s subscription defects as expected failures",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const client = {
          [WS_METHODS.subscribeTerminalEvents]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const exit = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalEvents,
          () =>
            Effect.sync(() => {
              inputs += 1;
            }).pipe(Effect.andThen(where === "input" ? Effect.die(defect) : Effect.succeed({}))),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                expectedFailureCount += 1;
              }),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(defect);
        }
        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);
      }),
  );
});

it.effect("ignores a late completion from the replaced automation generation", () =>
  Effect.gen(function* () {
    const oldEvents = yield* Queue.unbounded<PreviewAutomationStreamEvent, Cause.Done>();
    const started = yield* Queue.unbounded<string>();
    const oldClient = {
      [WS_METHODS.previewAutomationConnect]: () =>
        Stream.fromEffect(Queue.offer(started, "old")).pipe(
          Stream.drain,
          Stream.concat(Stream.fromQueue(oldEvents)),
        ),
    } as unknown as WsRpcProtocolClient;
    const newClient = {
      [WS_METHODS.previewAutomationConnect]: () =>
        Stream.fromEffect(Queue.offer(started, "new")).pipe(
          Stream.drain,
          Stream.concat(Stream.never),
        ),
    } as unknown as WsRpcProtocolClient;
    const { activeSession, supervisor, retryCount } = yield* makeHarness();
    yield* SubscriptionRef.set(activeSession, Option.some(session(oldClient)));
    const fiber = yield* subscribe(
      WS_METHODS.previewAutomationConnect,
      { clientId: "desktop", environmentId: TARGET.environmentId },
      { resubscribeOnCompletionAfter: "1 second" },
    ).pipe(
      Stream.runDrain,
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.forkChild,
    );
    expect(yield* Queue.take(started)).toBe("old");
    yield* SubscriptionRef.set(activeSession, Option.some(session(newClient)));
    expect(yield* Queue.take(started)).toBe("new");
    yield* Queue.end(oldEvents);
    yield* TestClock.adjust("5 seconds");
    expect(Option.isNone(yield* Queue.poll(started))).toBe(true);
    expect(yield* Ref.get(retryCount)).toBe(0);
    yield* Fiber.interrupt(fiber);
  }),
);

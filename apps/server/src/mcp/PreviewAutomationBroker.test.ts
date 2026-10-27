import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { DesktopThreadLifecycleError } from "../computer/DesktopThreadLifecycle.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as Layer from "effect/Layer";
import * as UserDesktops from "../persistence/UserDesktops.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const makeBroker = PreviewAutomationBroker.make.pipe(
  Effect.provide(Layer.merge(UserDesktops.layerMemory, NodeServices.layer)),
);

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-1"),
    controllerId: "provider-session-1",
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const USER_DESKTOP = {
  protocolVersion: 1,
  desktopId: "user-desktop-1",
  defaultLabel: "Test desktop",
  platform: "linux",
  capabilities: ["view", "control", "availability"],
} as const;

const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  ...overrides,
});

it.effect(
  "reconciles only referenced desktop threads and binds operation snapshots to the current connection",
  () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<ThreadId>();
      const received =
        yield* Queue.unbounded<Extract<PreviewAutomationStreamEvent, { type: "lifecycle" }>>();
      const connected = yield* Deferred.make<string>();
      const reads: ThreadId[] = [];
      const broker = yield* makeBroker.pipe(
        Effect.provideService(PreviewAutomationBroker.DesktopLifecycleSource, {
          read: (environmentId, threadId) =>
            Effect.sync(() => {
              reads.push(threadId);
              return {
                version: 2 as const,
                environmentId,
                threadId,
                revision: 20,
                activityRevision: 10,
                state: "active" as const,
                activityAt: "2026-10-15T00:00:00.000Z",
                serverNow: "2026-10-15T00:00:00.000Z",
                settledAt: null,
              };
            }),
          changes: Stream.fromQueue(changes),
        }),
      );
      yield* Stream.runForEach(
        yield* broker.connect(
          makeHost({
            userDesktop: USER_DESKTOP,
            authorizationVersion: 2,
            supportedOperations: ["computerSnapshot"],
          }),
        ),
        (event) => {
          if (event.type === "connected") return Deferred.succeed(connected, event.connectionId);
          if (event.type === "lifecycle") return Queue.offer(received, event);
          if (event.type === "cancel") return Effect.void;
          return broker.respond({
            clientId: "client-1",
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            ok: true,
            result: event.request,
          });
        },
      ).pipe(Effect.forkScoped);
      const generation = yield* Deferred.await(connected);
      yield* broker.focusHost({
        clientId: "client-1",
        environmentId: scope.environmentId,
        connectionId: generation,
        focused: false,
        authorizationThreads: [scope.thread.threadId],
      });
      expect((yield* Queue.take(received)).snapshots[0]?.threadId).toBe(scope.thread.threadId);
      yield* Queue.offer(changes, ThreadId.make("unreferenced"));
      yield* Queue.offer(changes, scope.thread.threadId);
      expect((yield* Queue.take(received)).connectionId).toBe(generation);
      expect(reads).toEqual([scope.thread.threadId, scope.thread.threadId]);
      const request = yield* broker.invoke<PreviewAutomationRequest>({
        scope,
        operation: "computerSnapshot",
        input: { desktop: { kind: "user", desktopId: USER_DESKTOP.desktopId } },
      });
      expect(request.connectionGeneration).toBe(generation);
      expect(request.lifecycle).toMatchObject({
        revision: 20,
        environmentId: scope.environmentId,
        threadId: scope.thread.threadId,
      });
    }).pipe(Effect.scoped),
);

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

it.effect(
  "supplies committed lifecycle for human permission requests without blocking recovery",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      let unavailable = false;
      const broker = yield* makeBroker.pipe(
        Effect.provideService(PreviewAutomationBroker.DesktopLifecycleSource, {
          read: (environmentId, threadId) =>
            Effect.suspend(() => {
              reads++;
              return unavailable
                ? Effect.fail(new DesktopThreadLifecycleError({ threadId, message: "Unavailable" }))
                : Effect.succeed({
                    version: 2 as const,
                    environmentId,
                    threadId,
                    revision: 20,
                    activityRevision: 10,
                    state: "active" as const,
                    activityAt: "2026-10-15T00:00:00.000Z",
                    serverNow: "2026-10-15T00:00:00.000Z",
                    settledAt: null,
                  });
            }),
          changes: Stream.never,
        }),
      );
      const operations = [
        "computerRequestView",
        "computerRequestControl",
        "computerRememberView",
        "computerRememberControl",
        "computerExecution",
      ] as const;
      const connected = yield* Deferred.make<void>();
      yield* Stream.runForEach(
        yield* broker.connect(
          makeHost({
            authorizationVersion: 2,
            supportedOperations: operations,
            userDesktop: {
              ...USER_DESKTOP,
              capabilities: [...USER_DESKTOP.capabilities, "execution"],
            },
          }),
        ),
        (event) => {
          if (event.type === "connected") return Deferred.succeed(connected, undefined);
          if (event.type !== "request") return Effect.void;
          return broker.respond({
            clientId: "client-1",
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            ok: true,
            result: event.request,
          });
        },
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const human = { ...scope, thread: { ...scope.thread, controllerKind: "human" as const } };
      const desktop = { kind: "user" as const, desktopId: USER_DESKTOP.desktopId };
      const permission = {
        operation: "access",
        desktop,
        input: { action: "edit", desktop, scope: "thread", lifetime: "automatic" },
      };
      for (const operation of operations) {
        const delivered = yield* broker.invoke<PreviewAutomationRequest>({
          scope: human,
          operation,
          input: operation === "computerExecution" ? permission : { desktop },
        });
        expect(delivered.lifecycle).toMatchObject({
          revision: 20,
          environmentId: scope.environmentId,
          threadId: scope.thread.threadId,
        });
      }
      expect(reads).toBe(operations.length);
      unavailable = true;
      for (const action of ["list", "read", "signal", "forget"] as const) {
        const delivered = yield* broker.invoke<PreviewAutomationRequest>({
          scope: human,
          operation: "computerExecution",
          input: {
            operation: "process",
            desktop,
            input: { action, desktop, processId: "owned-job" },
          },
        });
        expect(delivered.lifecycle).toBeUndefined();
      }
      expect(reads).toBe(operations.length);
      const settings = yield* broker.invoke<PreviewAutomationRequest>({
        scope: {
          ...human,
          thread: { ...human.thread, threadId: ThreadId.make("synthetic-settings") },
        },
        operation: "computerExecution",
        input: permission,
      });
      expect(settings.lifecycle).toBeUndefined();
      expect(reads).toBe(operations.length + 1);
      const agent = yield* broker
        .invoke<PreviewAutomationRequest>({
          scope,
          operation: "computerExecution",
          input: permission,
        })
        .pipe(Effect.flip);
      expect(agent._tag).toBe("PreviewAutomationExecutionError");
    }).pipe(Effect.scoped),
);

const requestsFrom = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  onConnected: (connectionId: PreviewAutomationStreamEvent["connectionId"]) => void = () => {},
): Stream.Stream<RoutedRequest> =>
  events.pipe(
    Stream.filterMap((event) => {
      if (event.type === "connected") {
        onConnected(event.connectionId);
        return Result.failVoid;
      }
      if (event.type === "cancel" || event.type === "lifecycle") return Result.failVoid;
      return Result.succeed({ ...event.request, connectionId: event.connectionId });
    }),
  );

it.effect("atomically registers a connected host and correlates its response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: { available: true },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<{ available: boolean }>({
        scope,
        operation: "open",
        input: {},
      });

      expect(result).toEqual({ available: true });
    }),
  ),
);

it.effect("targets multiple tabs explicitly while retaining a default tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const appTabId = PreviewTabId.make("tab-web-app");
      const simulatorTabId = PreviewTabId.make("tab-ios-simulator");
      const openedTabIds = [appTabId, simulatorTabId];
      let openIndex = 0;
      const routedRequests: RoutedRequest[] = [];
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) => {
        routedRequests.push(request);
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "open"
              ? { available: true, tabId: openedTabIds[openIndex++] }
              : { url: "http://localhost:3200" },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke({ scope, operation: "open", input: { reuseExistingTab: false } });
      yield* broker.invoke({ scope, operation: "open", input: { reuseExistingTab: false } });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });
      yield* broker.invoke({ scope, operation: "snapshot", input: {}, tabId: appTabId });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });

      expect(routedRequests).toHaveLength(5);
      expect(routedRequests[0]?.tabId).toBeUndefined();
      expect(routedRequests[1]?.tabId).toBe(appTabId);
      expect(routedRequests[2]?.tabId).toBe(simulatorTabId);
      expect(routedRequests[2]?.tabIdExplicit).toBe(false);
      expect(routedRequests[3]?.tabId).toBe(appTabId);
      expect(routedRequests[3]?.tabIdExplicit).toBe(true);
      expect(routedRequests[4]?.tabId).toBe(appTabId);
    }),
  ),
);

it.effect.each([true, false])(
  "keeps an older target stable while a newer explicit tab responds (implicit: %s)",
  (implicit) =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const olderTabId = PreviewTabId.make("tab-older-request");
        const newerTabId = PreviewTabId.make("tab-newer-request");
        const releaseOlderResponse = yield* Deferred.make<void>();
        const routedRequests: RoutedRequest[] = [];
        const requests = requestsFrom(yield* broker.connect(makeHost()));
        yield* Stream.runForEach(requests, (request) => {
          routedRequests.push(request);
          const response = Effect.gen(function* () {
            if (request.tabId === olderTabId && request.operation === "snapshot") {
              yield* Deferred.await(releaseOlderResponse);
            }
            yield* broker.respond({
              clientId: "client-1",
              connectionId: request.connectionId,
              requestId: request.requestId,
              ok: true,
              result: { url: "http://localhost:3200" },
            });
            if (request.tabId === newerTabId) {
              yield* Deferred.succeed(releaseOlderResponse, undefined);
            }
          });
          return response.pipe(Effect.forkScoped, Effect.asVoid);
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        yield* broker.invoke({ scope, operation: "status", input: {}, tabId: olderTabId });
        let capturedTabId: PreviewTabId | undefined;
        const older = yield* broker
          .invoke({
            scope,
            operation: "snapshot",
            input: {},
            ...(implicit ? {} : { tabId: olderTabId }),
            onTargetTab: (tabId) => {
              capturedTabId = tabId;
            },
          })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const newer = yield* broker
          .invoke({ scope, operation: "snapshot", input: {}, tabId: newerTabId })
          .pipe(Effect.forkScoped);
        yield* Fiber.join(newer);
        yield* Fiber.join(older);
        yield* broker.invoke({
          scope,
          operation: "status",
          input: {},
          tabId: olderTabId,
          updateCurrentTab: false,
        });
        yield* broker.invoke({ scope, operation: "snapshot", input: {} });

        expect(routedRequests.at(-1)?.tabId).toBe(newerTabId);
        expect(capturedTabId).toBe(olderTabId);
      }),
    ),
);

it.effect("does not let a no-tab response suppress an earlier tab decision", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const initialTabId = PreviewTabId.make("tab-initial");
      const openedTabId = PreviewTabId.make("tab-opened-late");
      const releaseOpenResponse = yield* Deferred.make<void>();
      const routedRequests: RoutedRequest[] = [];
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) => {
        routedRequests.push(request);
        const marker =
          typeof request.input === "object" && request.input !== null && "marker" in request.input
            ? request.input.marker
            : undefined;
        const response = Effect.gen(function* () {
          if (marker === "older") {
            yield* Deferred.await(releaseOpenResponse);
          }
          yield* broker.respond({
            clientId: "client-1",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result:
              request.operation === "open"
                ? { available: true, tabId: marker === "older" ? openedTabId : initialTabId }
                : { url: "http://localhost:3200" },
          });
          if (marker === "newer") {
            yield* Deferred.succeed(releaseOpenResponse, undefined);
          }
        });
        return response.pipe(Effect.forkScoped, Effect.asVoid);
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke({ scope, operation: "open", input: {} });
      const older = yield* broker
        .invoke({
          scope,
          operation: "open",
          input: { marker: "older", reuseExistingTab: false },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const newer = yield* broker
        .invoke({ scope, operation: "snapshot", input: { marker: "newer" } })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(newer);
      yield* Fiber.join(older);
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });

      expect(routedRequests.at(-1)?.tabId).toBe(openedTabId);
    }),
  ),
);

it.effect("announces a live replacement stream before delivering requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const events = yield* broker.connect(makeHost());
      const receivedTypes: PreviewAutomationStreamEvent["type"][] = [];
      const consumer = yield* events.pipe(
        Stream.take(2),
        Stream.runForEach((event) => {
          receivedTypes.push(event.type);
          return event.type !== "request"
            ? Effect.void
            : broker.respond({
                clientId: "client-1",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: "ready",
              });
        }),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });
      yield* Fiber.join(consumer);

      expect(receivedTypes).toEqual(["connected", "request"]);
      expect(result).toBe("ready");
    }),
  ),
);

it.effect.each([
  { clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID, shown: true },
  { clientId: "client-1", shown: false },
])("tells the agent why its own server browser failed ($clientId)", ({ clientId, shown }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost({ clientId })));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId,
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            message: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4719/",
          },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const error = yield* broker
        .invoke<void>({ scope, operation: "open", input: {} })
        .pipe(Effect.flip);
      expect(error._tag).toBe("PreviewAutomationExecutionError");
      expect(error.message.includes("ERR_CONNECTION_REFUSED")).toBe(shown);
    }),
  ),
);

it.effect("distinguishes malformed remote failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const error = yield* broker
        .invoke<void>({ scope, operation: "status", input: {}, timeoutMs: 2_000 })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewAutomationMalformedResponseError);
      expect(error).toMatchObject({
        operation: "status",
        environmentId: scope.environmentId,
        threadId: scope.thread.threadId,
        providerSessionId: scope.thread.providerSessionId,
        providerInstanceId: scope.thread.providerInstanceId,
        clientId: "client-1",
        requestId: "preview-0",
        timeoutMs: 2_000,
      });
    }),
  ),
);

it.effect("does not create host state from focus updates without a live stream", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    yield* broker.focusHost({
      clientId: "client-1",
      environmentId: scope.environmentId,
      connectionId: "connection-missing",
      focused: true,
    });

    const error = yield* broker
      .invoke<void>({ scope, operation: "status", input: {} })
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
  }),
);

it.effect("removes host availability when the authoritative request stream disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      const beforeAcquisition = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip);
      expect(beforeAcquisition).toBeInstanceOf(PreviewAutomationNoAvailableHostError);

      const consumer = yield* Stream.runDrain(requests).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(consumer);

      const error = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
    }),
  ),
);

it.effect("routes requests for background threads through an environment-level host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const backgroundThreadId = ThreadId.make("thread-background");
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      let routedThreadId: string | undefined;
      yield* Stream.runForEach(requests, (request) => {
        routedThreadId = request.threadId;
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "background",
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<string>({
        scope: {
          ...scope,
          thread: {
            ...scope.thread,
            threadId: backgroundThreadId,
            controllerId: "provider-session-background",
            providerSessionId: "provider-session-background",
          },
        },
        operation: "status",
        input: {},
      });

      expect(result).toBe("background");
      expect(routedThreadId).toBe(backgroundThreadId);
    }),
  ),
);

it.effect("never routes a provider session to a host from another environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const matchingRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-matching" })),
      );
      const foreignRequests = requestsFrom(
        yield* broker.connect(
          makeHost({
            clientId: "client-foreign",
            environmentId: EnvironmentId.make("environment-foreign"),
          }),
        ),
      );
      yield* Stream.runForEach(matchingRequests, (request) =>
        broker.respond({
          clientId: "client-matching",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "matching",
        }),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(foreignRequests, (request) =>
        broker.respond({
          clientId: "client-foreign",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "foreign",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "matching",
      );
    }),
  ),
);

it.effect("pins a provider session to its initial host despite later focus changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let firstConnectionId = "";
      let secondConnectionId = "";
      const firstRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-first" })),
        (connectionId) => {
          firstConnectionId = connectionId;
        },
      );
      const secondRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-second" })),
        (connectionId) => {
          secondConnectionId = connectionId;
        },
      );
      yield* Stream.runForEach(firstRequests, (request) =>
        broker.respond({
          clientId: "client-first",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "first",
        }),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(secondRequests, (request) =>
        broker.respond({
          clientId: "client-second",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "second",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.focusHost({
        clientId: "client-first",
        environmentId: scope.environmentId,
        connectionId: "connection-stale",
        focused: true,
        liveTabs: [{ threadId: scope.thread.threadId, tabId: PreviewTabId.make("stale-tab") }],
      });
      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "second",
      );
      yield* broker.focusHost({
        clientId: "client-first",
        environmentId: scope.environmentId,
        connectionId: firstConnectionId,
        focused: true,
      });

      const firstPinnedScope = {
        ...scope,
        thread: { ...scope.thread, providerSessionId: "provider-session-first-pinned" },
      };
      expect(
        yield* broker.invoke<string>({ scope: firstPinnedScope, operation: "status", input: {} }),
      ).toBe("first");

      yield* broker.focusHost({
        clientId: "client-second",
        environmentId: scope.environmentId,
        connectionId: secondConnectionId,
        focused: true,
      });

      expect(
        yield* broker.invoke<string>({ scope: firstPinnedScope, operation: "status", input: {} }),
      ).toBe("first");
      expect(
        yield* broker.invoke<string>({
          scope: {
            ...scope,
            thread: { ...scope.thread, providerSessionId: "provider-session-second-pinned" },
          },
          operation: "status",
          input: {},
        }),
      ).toBe("second");
    }),
  ),
);

it.effect("prefers the live tab owner for new sessions without moving existing leases", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const connections = new Map<string, string>();
      for (const clientId of ["owner", "other"]) {
        const requests = requestsFrom(
          yield* broker.connect(makeHost({ clientId })),
          (connectionId) => connections.set(clientId, connectionId),
        );
        yield* Stream.runForEach(requests, (request) =>
          broker.respond({
            clientId,
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: clientId,
          }),
        ).pipe(Effect.forkScoped);
      }
      yield* Effect.yieldNow;
      yield* broker.focusHost({
        clientId: "owner",
        environmentId: scope.environmentId,
        connectionId: connections.get("owner")!,
        focused: false,
        liveTabs: [
          { threadId: scope.thread.threadId, tabId: PreviewTabId.make("signed-in"), visible: true },
        ],
      });
      yield* broker.focusHost({
        clientId: "other",
        environmentId: scope.environmentId,
        connectionId: connections.get("other")!,
        focused: true,
        liveTabs: [
          {
            threadId: scope.thread.threadId,
            tabId: PreviewTabId.make("signed-in"),
            visible: false,
          },
          {
            threadId: ThreadId.make("another-thread"),
            tabId: PreviewTabId.make("different-tab"),
            visible: true,
          },
        ],
      });
      expect(yield* broker.invoke<string>({ scope, operation: "evaluate", input: {} })).toBe(
        "owner",
      );
      expect(
        yield* broker.invoke<string>({
          scope: { ...scope, thread: { ...scope.thread, providerSessionId: "explicit-owner" } },
          tabId: PreviewTabId.make("signed-in"),
          operation: "snapshot",
          input: {},
        }),
      ).toBe("owner");
      expect(
        yield* broker.invoke<string>({
          scope: { ...scope, thread: { ...scope.thread, providerSessionId: "other-tab" } },
          tabId: PreviewTabId.make("different-tab"),
          operation: "evaluate",
          input: {},
        }),
      ).toBe("other");

      yield* broker.focusHost({
        clientId: "owner",
        environmentId: scope.environmentId,
        connectionId: connections.get("owner")!,
        focused: false,
        liveTabs: [],
      });
      expect(yield* broker.invoke<string>({ scope, operation: "evaluate", input: {} })).toBe(
        "owner",
      );
      expect(
        yield* broker.invoke<string>({
          scope: { ...scope, thread: { ...scope.thread, providerSessionId: "after-tab-closed" } },
          operation: "evaluate",
          input: {},
        }),
      ).toBe("other");
    }),
  ),
);

it.effect("routes resize to a capable host instead of a newer legacy connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const capableRequests = requestsFrom(
        yield* broker.connect(
          makeHost({ clientId: "client-capable", supportedOperations: ["resize"] }),
        ),
      );
      const legacyRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-legacy" })),
      );
      yield* Stream.runForEach(capableRequests, (request) =>
        broker.respond({
          clientId: "client-capable",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "capable",
        }),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(legacyRequests, (request) =>
        broker.respond({
          clientId: "client-legacy",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "legacy",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(
        yield* broker.invoke<string>({ scope, operation: "resize", input: { mode: "fill" } }),
      ).toBe("capable");
    }),
  ),
);

it.effect("does not move a live legacy assignment to another runtime for resize", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const legacyRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-legacy" })),
      );
      yield* Stream.runForEach(legacyRequests, (request) =>
        broker.respond({
          clientId: "client-legacy",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "legacy",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "legacy",
      );

      const capableRequests = requestsFrom(
        yield* broker.connect(
          makeHost({ clientId: "client-capable", supportedOperations: ["resize"] }),
        ),
      );
      yield* Stream.runForEach(capableRequests, (request) =>
        broker.respond({
          clientId: "client-capable",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "capable",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const error = yield* broker
        .invoke<void>({ scope, operation: "resize", input: { mode: "fill" } })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "legacy",
      );
    }),
  ),
);

it.effect("ignores stale focus updates for a different environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let firstConnectionId = "";
      const firstRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-first" })),
        (connectionId) => {
          firstConnectionId = connectionId;
        },
      );
      const secondRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-second" })),
      );
      yield* Stream.runForEach(firstRequests, (request) =>
        broker.respond({
          clientId: "client-first",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "first",
        }),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(secondRequests, (request) =>
        broker.respond({
          clientId: "client-second",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "second",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.focusHost({
        clientId: "client-first",
        environmentId: EnvironmentId.make("environment-stale"),
        connectionId: firstConnectionId,
        focused: true,
      });

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "second",
      );
    }),
  ),
);

it.effect("fails over a pinned provider session only after its host disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const firstTabId = PreviewTabId.make("tab-on-first-host");
      let firstConnectionId = "";
      let secondRoutedTabId: PreviewTabId | undefined;
      const firstRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-first" })),
        (connectionId) => {
          firstConnectionId = connectionId;
        },
      );
      const secondRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-second" })),
      );
      const firstConsumer = yield* Stream.runForEach(firstRequests, (request) =>
        broker.respond({
          clientId: "client-first",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: request.operation === "open" ? { host: "first", tabId: firstTabId } : "first",
        }),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(secondRequests, (request) => {
        secondRoutedTabId = request.tabId;
        return broker.respond({
          clientId: "client-second",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "second",
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.focusHost({
        clientId: "client-first",
        environmentId: scope.environmentId,
        connectionId: firstConnectionId,
        focused: true,
        liveTabs: [{ threadId: scope.thread.threadId, tabId: firstTabId }],
      });
      expect(yield* broker.invoke({ scope, operation: "open", input: {} })).toEqual({
        host: "first",
        tabId: firstTabId,
      });

      yield* Fiber.interrupt(firstConsumer);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "second",
      );
      expect(secondRoutedTabId).toBeUndefined();
    }),
  ),
);

it.effect("keeps a replacement stream authoritative when the old stream finalizes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let firstConnectionId = "";
      let replacementConnectionId = "";
      const firstRequests = requestsFrom(yield* broker.connect(makeHost()), (connectionId) => {
        firstConnectionId = connectionId;
      });
      yield* Stream.runDrain(firstRequests).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const replacementRequests = requestsFrom(
        yield* broker.connect(makeHost()),
        (connectionId) => {
          replacementConnectionId = connectionId;
        },
      );
      yield* Stream.runForEach(replacementRequests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "replacement",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(replacementConnectionId).not.toBe(firstConnectionId);
      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });
      expect(result).toBe("replacement");
    }),
  ),
);

it.effect("does not carry a tab id across a replacement automation stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const openedTabId = PreviewTabId.make("tab-first-webcontents");
      const firstRequests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(firstRequests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "open"
              ? { host: "first", tabId: openedTabId }
              : { host: "first" },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke({ scope, operation: "open", input: {} })).toEqual({
        host: "first",
        tabId: openedTabId,
      });

      const routedRequests: RoutedRequest[] = [];
      const replacementRequests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(replacementRequests, (request) => {
        routedRequests.push(request);
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "replacement",
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "replacement",
      );
      expect(routedRequests.at(-1)?.tabId).toBeUndefined();
    }),
  ),
);

it.effect("fails requests assigned to the stream that is replaced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runDrain(requests).pipe(Effect.forkScoped);
      const pending = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;

      const replacementRequests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runDrain(replacementRequests).pipe(Effect.forkScoped);

      const error = yield* Fiber.join(pending);
      expect(error).toBeInstanceOf(PreviewAutomationClientDisconnectedError);
      expect(error).toMatchObject({
        operation: "status",
        environmentId: scope.environmentId,
        threadId: scope.thread.threadId,
        providerSessionId: scope.thread.providerSessionId,
        providerInstanceId: scope.thread.providerInstanceId,
        clientId: "client-1",
        requestId: "preview-0",
        timeoutMs: 15_000,
      });
    }),
  ),
);

it.effect("accepts responses only from the host that received the request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        Effect.gen(function* () {
          yield* broker.respond({
            clientId: "client-foreign",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: "foreign",
          });
          yield* broker.respond({
            clientId: "client-1",
            connectionId: "connection-stale",
            requestId: request.requestId,
            ok: true,
            result: "stale",
          });
          yield* broker.respond({
            clientId: "client-1",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: "owner",
          });
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });
      expect(result).toBe("owner");
    }),
  ),
);

it.effect("keeps each thread's current tab when threads share a provider session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routed: Array<RoutedRequest> = [];
      const requests = requestsFrom(yield* broker.connect(makeHost(), { preferred: true }));
      yield* Stream.runForEach(requests, (request) => {
        routed.push(request);
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: { tabId: request.tabId ?? `tab-${request.threadId}` },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      // Codex runs every thread of an instance in one provider session.
      const otherThread = {
        ...scope,
        thread: { ...scope.thread, threadId: ThreadId.make("thread-2") },
      };

      yield* broker.invoke({ scope, operation: "open", input: {} });
      yield* broker.invoke({ scope: otherThread, operation: "snapshot", input: {} });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });
      yield* broker.invoke({ scope: otherThread, operation: "snapshot", input: {} });

      expect(routed.map(({ threadId, tabId }) => [threadId, tabId])).toEqual([
        ["thread-1", undefined],
        ["thread-2", undefined],
        ["thread-1", "tab-thread-1"],
        ["thread-2", "tab-thread-2"],
      ]);
      expect(routed[0]!.agentSessionId).not.toBe(routed[1]!.agentSessionId);
    }),
  ),
);

it.effect(
  "invalidates desktop authority on lifecycle feed failure and reconciles referenced threads after recovery",
  () =>
    Effect.gen(function* () {
      const fail = yield* Deferred.make<void>();
      let subscriptions = 0;
      const received =
        yield* Queue.unbounded<Extract<PreviewAutomationStreamEvent, { type: "lifecycle" }>>();
      const connected = yield* Deferred.make<string>();
      const changes = Stream.unwrap(
        Effect.sync(() =>
          ++subscriptions === 1
            ? Stream.fromEffect(
                Deferred.await(fail).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new PersistenceSqlError({
                        operation: "test.lifecycle",
                        cause: new Error("feed disconnected"),
                      }),
                    ),
                  ),
                ),
              )
            : Stream.concat(Stream.make(null), Stream.never),
        ),
      );
      const broker = yield* makeBroker.pipe(
        Effect.provideService(PreviewAutomationBroker.DesktopLifecycleSource, {
          read: (environmentId, threadId) =>
            Effect.succeed({
              version: 2,
              environmentId,
              threadId,
              revision: subscriptions,
              activityRevision: 1,
              state: "active",
              serverNow: "1970-01-01T00:00:00.000Z",
              activityAt: "1970-01-01T00:00:00.000Z",
              settledAt: null,
            }),
          changes,
        }),
      );
      yield* (yield* broker.connect(
        makeHost({
          userDesktop: USER_DESKTOP,
          authorizationVersion: 2,
          supportedOperations: ["computerSnapshot"],
        }),
      )).pipe(
        Stream.runForEach((event) => {
          if (event.type === "connected") return Deferred.succeed(connected, event.connectionId);
          if (event.type === "lifecycle") return Queue.offer(received, event);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      const generation = yield* Deferred.await(connected);
      yield* broker.focusHost({
        clientId: "client-1",
        environmentId: scope.environmentId,
        connectionId: generation,
        focused: false,
        authorizationThreads: [scope.thread.threadId],
      });
      expect((yield* Queue.take(received)).snapshots[0]?.revision).toBe(1);
      yield* Deferred.succeed(fail, undefined);
      expect((yield* Queue.take(received)).unavailable).toBe(true);
      yield* TestClock.adjust("1 second");
      const reconciled = yield* Queue.take(received);
      expect(reconciled.snapshots.map((snapshot) => snapshot.threadId)).toEqual([
        scope.thread.threadId,
      ]);
      expect(reconciled.snapshots[0]?.revision).toBe(2);
    }).pipe(Effect.scoped),
);

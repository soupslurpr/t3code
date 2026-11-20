import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  AuthSourceControlWriteScope,
  WS_METHODS,
  VcsProcessExitError,
  type VcsListRefsResult,
  type VcsStatusResult,
  type ServerConfig,
  type VcsListRefsInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createGitEnvironmentAtoms } from "./git.ts";

import {
  commitVcsRefsRefresh,
  createVcsEnvironmentAtoms,
  makeCachedVcsRefsChanges,
  resolveQuickAction,
  vcsRefPageInput,
} from "./vcs.ts";
import {
  invalidateCachedVcsRefs,
  invalidateVcsRefs,
  vcsRefsCacheStateAtom,
} from "./vcsRefInvalidation.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED_CONNECTION_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

const CACHED_REFS: VcsListRefsResult = {
  refs: [
    {
      name: "main",
      current: true,
      isDefault: true,
      worktreePath: "/repo",
    },
  ],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 1,
};

const LIVE_REFS: VcsListRefsResult = {
  ...CACHED_REFS,
  refs: [
    {
      name: "release",
      current: true,
      isDefault: true,
      worktreePath: "/repo",
    },
  ],
};

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

function cacheWithRefs(
  refs: Option.Option<VcsListRefsResult>,
  overrides: Partial<Persistence.EnvironmentCacheStore["Service"]> = {},
) {
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(refs),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
    ...overrides,
  });
}

describe("branch subscriptions", () => {
  it.effect.each([true, false])(
    "shares and releases branch streams across session replacement (capability %s)",
    (supported) =>
      Effect.gen(function* () {
        const released = yield* Queue.unbounded<string>();
        let subscriptions = 0;
        const clientFor = (refName: string, branchSupported: boolean) =>
          ({
            [branchSupported ? WS_METHODS.subscribeVcsBranch : WS_METHODS.subscribeVcsStatus]:
              () => {
                subscriptions += 1;
                return Stream.concat(
                  Stream.make(
                    branchSupported
                      ? { refName, isRepo: true }
                      : { _tag: "snapshot", local: status({ refName }), remote: null },
                  ),
                  Stream.never,
                ).pipe(Stream.ensuring(Queue.offer(released, refName)));
              },
          }) as unknown as WsRpcProtocolClient;
        const branchSession = (refName: string, branchSupported: boolean): RpcSession => ({
          ...session(clientFor(refName, branchSupported)),
          initialConfig: Effect.succeed({
            environment: { capabilities: branchSupported ? { vcsBranchStatus: true } : {} },
          } as ServerConfig),
        });
        const activeSession = yield* SubscriptionRef.make(
          Option.some(branchSession("main", supported)),
        );
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: activeSession,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          followStream: (_environmentId, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        );
        const atoms = createVcsEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const target = { environmentId: TARGET.environmentId, input: { cwd: "/repo" } };
        const first = yield* Stream.toPull(
          AtomRegistry.toStreamResult(registry, atoms.branch(target)),
        );
        expect(yield* first).toEqual([{ refName: "main", isRepo: true }]);
        const second = yield* Stream.toPull(
          AtomRegistry.toStreamResult(registry, atoms.branch(target)),
        );
        expect(yield* second).toEqual([{ refName: "main", isRepo: true }]);
        expect(subscriptions).toBe(1);
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(branchSession("external", !supported)),
        );
        expect(yield* Queue.take(released)).toBe("main");
        expect(yield* first).toEqual([{ refName: "external", isRepo: true }]);
        expect(yield* second).toEqual([{ refName: "external", isRepo: true }]);
        registry.dispose();
        expect(yield* Queue.take(released)).toBe("external");
      }),
  );
});

describe("cached VCS refs", () => {
  it("invalidates all ref streams in the mutated environment", () => {
    const registry = AtomRegistry.make();
    const environment = {
      environmentId: TARGET.environmentId,
    };
    const otherEnvironment = {
      environmentId: EnvironmentId.make("environment-2"),
    };

    expect(registry.get(vcsRefsCacheStateAtom(environment))).toEqual({
      revision: 0,
      persistedCacheReadable: true,
    });
    expect(registry.get(vcsRefsCacheStateAtom(otherEnvironment))).toEqual({
      revision: 0,
      persistedCacheReadable: true,
    });

    invalidateVcsRefs(registry, environment);

    expect(registry.get(vcsRefsCacheStateAtom(environment))).toEqual({
      revision: 1,
      persistedCacheReadable: true,
    });
    expect(registry.get(vcsRefsCacheStateAtom(otherEnvironment))).toEqual({
      revision: 0,
      persistedCacheReadable: true,
    });
    registry.dispose();
  });

  it.effect("bypasses the server ref snapshot when a mounted list is invalidated", () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<VcsListRefsInput>();
      const client = {
        [WS_METHODS.vcsListRefs]: (input: VcsListRefsInput) =>
          Effect.sync(() => {
            Queue.offerUnsafe(requests, input);
            return LIVE_REFS;
          }),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
        _environmentId,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        followStream,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Layer.succeed(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
        ),
      );
      const atoms = createVcsEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registry.mount(
            atoms.listRefs({
              environmentId: TARGET.environmentId,
              input: { cwd: "/repo", limit: 100 },
            }),
          ),
        ),
        (unmount) => Effect.sync(unmount),
      );

      expect(yield* Queue.take(requests)).toEqual({ cwd: "/repo", limit: 100 });

      invalidateVcsRefs(registry, TARGET);

      expect(yield* Queue.take(requests)).toEqual({ cwd: "/repo", limit: 100, refresh: true });

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registry.mount(
            atoms.listRefs({
              environmentId: TARGET.environmentId,
              input: { cwd: "/other-repo", limit: 100 },
            }),
          ),
        ),
        (unmount) => Effect.sync(unmount),
      );
      expect(yield* Queue.take(requests)).toEqual({
        cwd: "/other-repo",
        limit: 100,
        refresh: true,
      });

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registry.mount(
            atoms.listRefs({
              environmentId: TARGET.environmentId,
              input: { cwd: "/other-repo", query: "release", limit: 100 },
            }),
          ),
        ),
        (unmount) => Effect.sync(unmount),
      );
      expect(yield* Queue.take(requests)).toEqual({
        cwd: "/other-repo",
        query: "release",
        limit: 100,
      });
    }),
  );

  it.effect("does not repersist a refresh superseded by ref invalidation", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const saved = yield* Ref.make<ReadonlyArray<VcsListRefsResult>>([]);
      const clears = yield* Ref.make(0);
      const revisionsObservedDuringClear = yield* Ref.make<ReadonlyArray<number>>([]);
      const cache = cacheWithRefs(Option.none(), {
        saveVcsRefs: (_environmentId, _cwd, refs) =>
          Ref.update(saved, (current) => [...current, refs]),
        clearVcsRefs: () =>
          Effect.all([
            Ref.update(clears, (count) => count + 1),
            Ref.update(revisionsObservedDuringClear, (current) => [
              ...current,
              registry.get(vcsRefsCacheStateAtom(TARGET)).revision,
            ]),
          ]).pipe(Effect.asVoid),
      });

      yield* invalidateCachedVcsRefs(registry, {
        environmentId: TARGET.environmentId,
        cwd: "/repo-worktree",
      }).pipe(Effect.provideService(Persistence.EnvironmentCacheStore, cache));

      expect(
        yield* commitVcsRefsRefresh(registry, cache, {
          environmentId: TARGET.environmentId,
          cwd: "/repo",
          refs: CACHED_REFS,
          expectedRevision: 0,
          persist: true,
        }),
      ).toBe(false);

      expect(yield* Ref.get(saved)).toEqual([]);
      expect(yield* Ref.get(clears)).toBe(1);
      expect(yield* Ref.get(revisionsObservedDuringClear)).toEqual([0]);
      expect(registry.get(vcsRefsCacheStateAtom(TARGET))).toEqual({
        revision: 1,
        persistedCacheReadable: true,
      });

      expect(
        yield* commitVcsRefsRefresh(registry, cache, {
          environmentId: TARGET.environmentId,
          cwd: "/repo",
          refs: LIVE_REFS,
          expectedRevision: 1,
          persist: true,
        }),
      ).toBe(true);
      expect(yield* Ref.get(saved)).toEqual([LIVE_REFS]);
    }),
  );

  it.effect("coalesces pending checkout refreshes and preserves the latest localOnly option", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls: Array<{ readonly cwd: string; readonly localOnly?: boolean }> = [];
      const client = {
        [WS_METHODS.vcsRefreshStatus]: (input: {
          readonly cwd: string;
          readonly localOnly?: boolean;
        }) =>
          Effect.gen(function* () {
            calls.push(input);
            if (calls.length === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return { refsDigest: null };
          }),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
            run,
            entries: yield* SubscriptionRef.make<
              ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
            >(new Map()),
            networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          }),
          Layer.succeed(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
        ),
      );
      const atoms = createVcsEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const start = (input: { readonly cwd: string; readonly localOnly?: boolean }) =>
        Effect.forkChild(
          Effect.exit(
            atoms.refreshStatus.run(registry, {
              environmentId: TARGET.environmentId,
              input,
            }),
          ),
          { startImmediately: true },
        );
      const first = yield* start({ cwd: "/repo" });
      yield* Deferred.await(entered);
      const second = yield* start({ cwd: "/repo" });
      const latest = yield* start({ cwd: "/repo", localOnly: true });
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.all([
        Fiber.join(first),
        Fiber.join(second),
        Fiber.join(latest),
      ]);
      expect(results.every(Exit.isSuccess)).toBe(true);
      expect(calls).toEqual([{ cwd: "/repo" }, { cwd: "/repo", localOnly: true }]);
    }),
  );
  it.effect("invalidates persisted refs when ref-affecting commands settle", () =>
    Effect.gen(function* () {
      const refsDigest = yield* Ref.make("refs-a");
      const expectedError = new EnvironmentRpcUnavailableError({
        environmentId: TARGET.environmentId,
        message: "pull failed after fetching refs",
      });
      const client = {
        [WS_METHODS.vcsPull]: () => Effect.fail(expectedError),
        [WS_METHODS.vcsRefreshStatus]: () =>
          Ref.get(refsDigest).pipe(Effect.map((digest) => ({ refsDigest: digest }))),
        [WS_METHODS.gitPreparePullRequestThread]: () =>
          Effect.succeed({ branch: "feature/pr", worktreePath: null }),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
        _environmentId,
        effect,
      ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        run,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const clears = yield* Ref.make(0);
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Layer.succeed(
            Persistence.EnvironmentCacheStore,
            cacheWithRefs(Option.none(), {
              clearVcsRefs: () => Ref.update(clears, (count) => count + 1),
            }),
          ),
        ),
      );
      const atoms = createVcsEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );

      const result = yield* Effect.exit(
        atoms.pull.run(registry, {
          environmentId: TARGET.environmentId,
          input: { cwd: "/repo" },
        }),
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* Ref.get(clears)).toBe(1);
      expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(1);

      const refreshResult = yield* Effect.exit(
        atoms.refreshStatus.run(registry, {
          environmentId: TARGET.environmentId,
          input: { cwd: "/repo" },
        }),
      );

      expect(Exit.isSuccess(refreshResult)).toBe(true);
      expect(yield* Ref.get(clears)).toBe(2);
      expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(2);

      const refreshStatus = atoms.refreshStatus.run(registry, {
        environmentId: TARGET.environmentId,
        input: { cwd: "/repo" },
      });
      yield* refreshStatus;
      expect(yield* Ref.get(clears)).toBe(2);
      expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(2);

      yield* Ref.set(refsDigest, "refs-b");
      yield* refreshStatus;
      expect(yield* Ref.get(clears)).toBe(3);
      expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(3);

      yield* atoms.refreshLocalStatusForPicker.run(registry, {
        environmentId: TARGET.environmentId,
        input: { cwd: "/repo" },
      });
      expect(yield* Ref.get(clears)).toBe(3);
      expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(3);

      const prepareResult = yield* Effect.exit(
        createGitEnvironmentAtoms(runtime).preparePullRequestThread.run(registry, {
          environmentId: TARGET.environmentId,
          input: { cwd: "/repo", reference: "42", mode: "local" },
        }),
      );

      expect(Exit.isSuccess(prepareResult)).toBe(true);
      expect(yield* Ref.get(clears)).toBe(4);
      expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(4);
    }),
  );

  it.effect("a checkout does not wait behind a picker's local status refresh", () =>
    Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.vcsRefreshStatus]: (input: { cwd: string; localOnly?: boolean }) =>
          Deferred.succeed(refreshStarted, undefined).pipe(
            Effect.tap(() => Effect.sync(() => expect(input.localOnly).toBe(true))),
            Effect.andThen(Deferred.await(releaseRefresh)),
            Effect.as({}),
          ),
        [WS_METHODS.vcsSwitchRef]: () => Effect.succeed({ refName: "feature" }),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
        _environmentId,
        effect,
      ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(
            EnvironmentRegistry.EnvironmentRegistry,
            EnvironmentRegistry.EnvironmentRegistry.of({
              run,
            } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
          ),
          Layer.succeed(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
        ),
      );
      const atoms = createVcsEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const target = { environmentId: TARGET.environmentId, input: { cwd: "/repo" } };

      const refresh = yield* Effect.forkChild(
        Effect.exit(atoms.refreshLocalStatusForPicker.run(registry, target)),
        { startImmediately: true },
      );
      yield* Deferred.await(refreshStarted);
      const checkout = yield* Effect.exit(
        atoms.switchRef.run(registry, {
          ...target,
          input: { cwd: "/repo", refName: "feature" },
        }),
      );

      expect(Exit.isSuccess(checkout)).toBe(true);
      yield* Deferred.succeed(releaseRefresh, undefined);
      expect(Exit.isSuccess(yield* Fiber.join(refresh))).toBe(true);
    }),
  );

  it.effect("suppresses persisted snapshots after an environment-wide clear fails", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const persisted = yield* Ref.make<Option.Option<VcsListRefsResult>>(Option.some(CACHED_REFS));
      const loads = yield* Ref.make(0);
      const clearAttempts = yield* Ref.make(0);
      const cache = cacheWithRefs(Option.none(), {
        loadVcsRefs: () =>
          Ref.update(loads, (count) => count + 1).pipe(Effect.andThen(Ref.get(persisted))),
        saveVcsRefs: (_environmentId, _cwd, refs) => Ref.set(persisted, Option.some(refs)),
        clearVcsRefs: () =>
          Ref.updateAndGet(clearAttempts, (count) => count + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Effect.fail(
                    new Persistence.ConnectionPersistenceError({
                      operation: "clear-vcs-refs",
                      message: "storage unavailable",
                    }),
                  )
                : Ref.set(persisted, Option.none()),
            ),
          ),
      });

      yield* invalidateCachedVcsRefs(registry, {
        environmentId: TARGET.environmentId,
        cwd: "/repo",
      }).pipe(Effect.provideService(Persistence.EnvironmentCacheStore, cache));

      const state = registry.get(vcsRefsCacheStateAtom(TARGET));
      expect(state).toEqual({
        revision: 1,
        persistedCacheReadable: false,
      });

      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const refs = yield* Stream.unwrap(
        makeCachedVcsRefsChanges(
          { cwd: "/repo", limit: 100 },
          state.revision,
          registry,
          state.persistedCacheReadable,
        ).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        ),
      ).pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));

      yield* Effect.yieldNow;
      expect(yield* Ref.get(loads)).toBe(0);
      yield* Fiber.interrupt(refs);
      expect(registry.get(vcsRefsCacheStateAtom(TARGET))).toEqual(state);

      expect(
        yield* commitVcsRefsRefresh(registry, cache, {
          environmentId: TARGET.environmentId,
          cwd: "/repo",
          refs: LIVE_REFS,
          expectedRevision: state.revision,
          persist: true,
        }),
      ).toBe(true);
      const recoveredState = registry.get(vcsRefsCacheStateAtom(TARGET));
      expect(recoveredState).toEqual({
        revision: 1,
        persistedCacheReadable: true,
      });
      expect(yield* Ref.get(clearAttempts)).toBe(2);

      const recoveredRefs = yield* Stream.unwrap(
        makeCachedVcsRefsChanges(
          { cwd: "/repo", limit: 100 },
          recoveredState.revision,
          registry,
          recoveredState.persistedCacheReadable,
        ).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        ),
      ).pipe(Stream.runHead);

      expect(Option.getOrThrow(recoveredRefs)).toEqual(LIVE_REFS);
      expect(yield* Ref.get(loads)).toBe(1);
    }),
  );

  it.effect("loads an unfiltered branch list without a connection", () =>
    Effect.gen(function* () {
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const refs = yield* Stream.unwrap(
        makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(
            Persistence.EnvironmentCacheStore,
            cacheWithRefs(Option.some(CACHED_REFS)),
          ),
        ),
      ).pipe(Stream.runHead);

      expect(Option.getOrThrow(refs)).toEqual(CACHED_REFS);
    }),
  );

  it.effect("waits silently for a session while the connection phase is still connected", () =>
    Effect.gen(function* () {
      const logs: unknown[] = [];
      const logger = Logger.make(({ message }) => logs.push(message));
      const liveSession = yield* SubscriptionRef.make(Option.none<RpcSession>());
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
        session: liveSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const refs = yield* Stream.unwrap(
        makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(
            Persistence.EnvironmentCacheStore,
            cacheWithRefs(Option.some(CACHED_REFS)),
          ),
        ),
      ).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* TestClock.adjust("1 minute");
      expect(logs).toEqual([]);

      const client = {
        [WS_METHODS.vcsListRefs]: () => Effect.succeed(LIVE_REFS),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(liveSession, Option.some(session(client)));
      expect(yield* Fiber.join(refs)).toEqual([CACHED_REFS, LIVE_REFS]);
      expect(logs).toEqual([]);
    }),
  );

  it.effect("cancels an in-flight refresh and restarts when the RPC session changes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      const interruptions = yield* Ref.make(0);
      const client = {
        [WS_METHODS.vcsListRefs]: () =>
          Ref.updateAndGet(calls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Ref.update(interruptions, (interruptions) => interruptions + 1).pipe(
                        Effect.andThen(Deferred.succeed(interrupted, undefined)),
                      ),
                    ),
                  )
                : Effect.succeed(LIVE_REFS),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const liveSession = yield* SubscriptionRef.make(Option.some(session(client)));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
        session: liveSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

      const fiber = yield* Stream.unwrap(
        makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
        ),
      ).pipe(Stream.runHead, Effect.forkChild);

      yield* Deferred.await(started);
      yield* SubscriptionRef.set(liveSession, Option.none());
      yield* Deferred.await(interrupted);
      expect(yield* Ref.get(interruptions)).toBe(1);

      yield* SubscriptionRef.set(liveSession, Option.some(session(client)));
      expect(Option.getOrThrow(yield* Fiber.join(fiber))).toEqual(LIVE_REFS);
      expect(yield* Ref.get(calls)).toBe(2);
    }),
  );

  it.effect("retries Git failures and cancels pending retries when the session is removed", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const warnings = yield* Queue.unbounded<unknown>();
      const logger = Logger.make(({ message }) => Queue.offerUnsafe(warnings, message));
      const failure = new VcsProcessExitError({
        operation: "listRefs",
        command: "git",
        cwd: "/repo",
        exitCode: 128,
        detail: "Could not read refs.",
      });
      const client = {
        [WS_METHODS.vcsListRefs]: () =>
          Ref.updateAndGet(calls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count < 3 ? Effect.fail(failure) : Effect.succeed(LIVE_REFS),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const liveSession = yield* SubscriptionRef.make(Option.some(session(client)));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
        session: liveSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const refs = yield* Stream.unwrap(
        makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(
            Persistence.EnvironmentCacheStore,
            cacheWithRefs(Option.some(CACHED_REFS)),
          ),
        ),
      ).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Queue.take(warnings);
      expect(yield* Ref.get(calls)).toBe(1);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(calls)).toBe(2);
      expect(yield* Queue.size(warnings)).toBe(1);

      yield* SubscriptionRef.set(liveSession, Option.none());
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(calls)).toBe(2);
      expect(yield* Queue.size(warnings)).toBe(1);

      yield* SubscriptionRef.set(liveSession, Option.some(session(client)));
      expect(yield* Fiber.join(refs)).toEqual([CACHED_REFS, LIVE_REFS]);
      expect(yield* Ref.get(calls)).toBe(3);
    }),
  );

  it.effect(
    "refreshes picker openings while search and later pages retain their ref snapshot",
    () =>
      Effect.gen(function* () {
        let repository = ["main"];
        let snapshot = [...repository];
        const client = {
          [WS_METHODS.vcsListRefs]: (input: VcsListRefsInput) =>
            Effect.sync(() => {
              if (input.refresh) snapshot = [...repository];
              const refs = snapshot
                .filter((name) => name.includes(input.query ?? ""))
                .slice(input.cursor ?? 0);
              return {
                ...CACHED_REFS,
                refs: refs.map((name) => ({
                  name,
                  current: name === "main",
                  isDefault: name === "main",
                  worktreePath: null,
                })),
                totalCount: refs.length,
              };
            }),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const read = (query: string, cursor: number | undefined = undefined) =>
          Stream.unwrap(
            makeCachedVcsRefsChanges(vcsRefPageInput("/repo", query, cursor, 100)).pipe(
              Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
              Effect.provideService(
                Persistence.EnvironmentCacheStore,
                cacheWithRefs(Option.none()),
              ),
            ),
          ).pipe(
            Stream.runHead,
            Effect.map((result) => Option.getOrThrow(result).refs.map((ref) => ref.name)),
          );
        expect(yield* read("")).toEqual(["main"]);
        repository = ["main", "release"];
        expect(yield* read("")).toEqual(["main", "release"]);
        repository = ["main", "release", "feature"];
        expect(yield* read("release")).toEqual(["release"]);
        expect(yield* read("", 1)).toEqual(["release"]);
        expect(yield* read("")).toEqual(["main", "release", "feature"]);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps reopened picker pages and searches in the new snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let repository = [
          "main",
          ...Array.from({ length: 100 }, (_, i) => `branch${String(i + 1).padStart(3, "0")}`),
        ];
        let snapshot = [...repository];
        const calls: VcsListRefsInput[] = [];
        const client = {
          [WS_METHODS.vcsListRefs]: (input: VcsListRefsInput) =>
            Effect.sync(() => {
              calls.push(input);
              if (input.refresh) snapshot = [...repository];
              const matching = snapshot.filter((name) => name.includes(input.query ?? ""));
              const offset = input.cursor ?? 0;
              const limit = input.limit ?? 100;
              return {
                ...CACHED_REFS,
                refs: matching.slice(offset, offset + limit).map((name) => ({
                  name,
                  current: name === "main",
                  isDefault: name === "main",
                  worktreePath: null,
                })),
                nextCursor: offset + limit < matching.length ? offset + limit : null,
                totalCount: matching.length,
              };
            }),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        );
        const atoms = createVcsEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const page = (cacheKey: string, query = "", cursor?: number) =>
          atoms.listRefs({
            environmentId: TARGET.environmentId,
            input: vcsRefPageInput("/repo", query, cursor, 100),
            cacheKey,
          });
        const first = page("opening-1");
        const later = page("opening-1", "", 100);
        const search = page("opening-1", "branch100");
        const read = (atom: typeof first) =>
          AtomRegistry.getResult(registry, atom, { suspendOnWaiting: false });
        expect((yield* read(first)).refs).toHaveLength(100);
        expect((yield* read(later)).refs.map((ref) => ref.name)).toEqual(["branch100"]);
        expect((yield* read(search)).refs.map((ref) => ref.name)).toEqual(["branch100"]);
        repository = ["main", "new-branch", ...repository.slice(1, 100)];
        const reopened = yield* read(page("opening-2"));
        const reopenedLater = yield* read(page("opening-2", "", 100));
        const reopenedSearch = yield* read(page("opening-2", "branch100"));
        expect(reopened.refs[1]?.name).toBe("new-branch");
        expect(reopenedLater.refs.map((ref) => ref.name)).toEqual(["branch099"]);
        expect(reopenedSearch.refs).toEqual([]);
        expect([...reopened.refs, ...reopenedLater.refs].map((ref) => ref.name)).toEqual(
          repository,
        );
        expect(calls.filter((input) => input.refresh)).toHaveLength(2);
        expect(
          calls
            .filter((input) => input.cursor !== undefined || input.query !== undefined)
            .every((input) => input.refresh === undefined),
        ).toBe(true);
      }),
    ),
  );

  it.effect("emits persisted refs before a live refresh", () =>
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.vcsListRefs]: () => Effect.succeed(LIVE_REFS),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

      const refs = yield* Stream.unwrap(
        makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(
            Persistence.EnvironmentCacheStore,
            cacheWithRefs(Option.some(CACHED_REFS)),
          ),
        ),
      ).pipe(Stream.take(2), Stream.runCollect);

      expect(refs).toEqual([CACHED_REFS, LIVE_REFS]);
    }),
  );
});

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: grantedSessions }),
}));
const grantedSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSourceControlWriteScope],
    }),
  ),
);

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("resolveQuickAction", () => {
  it("commits local changes without pushing when the branch is behind upstream", () => {
    const behind = status({ hasWorkingTreeChanges: true, behindCount: 2 });
    const commit = { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    expect(resolveQuickAction(behind, false)).toEqual(commit);
    expect(
      resolveQuickAction(
        {
          ...behind,
          pr: {
            number: 13,
            title: "Open PR",
            url: "https://example.com/pr/13",
            baseRef: "main",
            headRef: "feature/test",
            state: "open",
          },
        },
        false,
      ),
    ).toEqual(commit);
  });
});

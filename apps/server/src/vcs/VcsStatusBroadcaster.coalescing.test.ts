import { assert, it } from "@effect/vitest";
import {
  GitManagerError,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as Broadcaster from "./VcsStatusBroadcaster.ts";

const local: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};
const remote: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};
const result = { ...local, ...remote };
const harness = Effect.fn("VcsCoalescingTest.harness")(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  const state = {
    remoteCalls: 0,
    localCalls: 0,
    invalidations: 0,
    localInvalidations: 0,
    fail: false,
  };
  const service = yield* Broadcaster.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(true),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localCalls++;
              return local;
            }),
          remoteStatus: () =>
            Effect.gen(function* () {
              state.remoteCalls++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              if (state.fail)
                return yield* new GitManagerError({
                  operation: "status",
                  cwd: "/repo",
                  detail: "shared failure",
                });
              return remote;
            }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
          invalidateStatus: () =>
            Effect.sync(() => {
              state.invalidations++;
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidations++;
            }),
          invalidateRemoteStatus: () => Effect.void,
        }),
      ),
    ),
  );
  return { service, state, entered, release, interrupted };
});

it.effect(
  "shares a producer after the original caller disconnects, then allows a fresh refresh",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const first = yield* h.service
        .refreshStatus("/repo")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(h.entered);
      // Immediate start plus synchronous path resolution reaches the pending Deferred.
      const second = yield* h.service
        .refreshStatus("/repo")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(first);
      assert.equal(h.state.remoteCalls, 1);
      assert.equal(h.state.localCalls, 0);
      yield* Deferred.succeed(h.release, undefined);
      assert.deepEqual(yield* Fiber.join(second), result);
      assert.equal(h.state.invalidations, 1);
      assert.deepEqual(yield* h.service.refreshStatus("/repo"), result);
      assert.equal(h.state.remoteCalls, 2);
      assert.equal(h.state.localCalls, 2);
    }),
);

it.effect("shares failures and removes their producer lease before retry", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.state.fail = true;
    const first = yield* h.service
      .refreshStatus("/repo")
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(h.entered);
    const second = yield* h.service
      .refreshStatus("/repo")
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(h.release, undefined);
    const failure = yield* Fiber.join(first);
    assert.isTrue(Exit.isFailure(failure));
    assert.deepEqual(yield* Fiber.join(second), failure);
    assert.equal(h.state.remoteCalls, 1);
    h.state.fail = false;
    assert.deepEqual(yield* h.service.refreshStatus("/repo"), result);
    assert.equal(h.state.remoteCalls, 2);
  }),
);

it.effect("retains the local-only path while a full refresh is pending", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const full = yield* h.service
      .refreshStatus("/repo")
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(h.entered);
    const localOnly = yield* h.service
      .refreshStatus("/repo", { localOnly: true })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(h.release, undefined);
    assert.deepEqual(yield* Fiber.join(full), result);
    assert.deepEqual(yield* Fiber.join(localOnly), result);
    assert.equal(h.state.remoteCalls, 1);
    assert.equal(h.state.localCalls, 2);
    assert.equal(h.state.localInvalidations, 1);
  }),
);

it.effect("interrupts an active producer and its waiters when the broadcaster scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const h = yield* harness().pipe(Effect.provideService(Scope.Scope, scope));
    const request = yield* h.service.refreshStatus("/repo").pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(h.entered);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(h.interrupted);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(request)));
  }),
);

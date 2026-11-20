import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  traceWorkspacePath,
  withTurnStartReservation,
  withWorkspaceRemovalLease,
} from "./workspaceLease.ts";

it.live(
  "blocks turn-start reservations across deep symlink chains and symlink/.. traversals without blocking siblings under a shared symlink root",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-lease-" });
      const realWorktrees = path.join(base, "real-worktrees");
      const worktreesAlias = path.join(base, "worktrees-alias");
      const taskOne = path.join(realWorktrees, "task-1");
      const taskTwo = path.join(realWorktrees, "task-2");
      const outsideParent = path.join(base, "outside");
      const outsideChild = path.join(outsideParent, "child");
      yield* fs.makeDirectory(taskOne, { recursive: true });
      yield* fs.makeDirectory(taskTwo, { recursive: true });
      yield* fs.makeDirectory(outsideChild, { recursive: true });
      yield* fs.symlink(realWorktrees, worktreesAlias);

      const outwardLink = path.join(taskOne, "outward-link");
      yield* fs.symlink(outsideChild, outwardLink);

      // 15-hop symlink chain ending at outwardLink inside task-1.
      let chainTarget = outwardLink;
      for (let hop = 1; hop <= 15; hop++) {
        const nextLink = path.join(base, `hop-${hop}`);
        yield* fs.symlink(chainTarget, nextLink);
        chainTarget = nextLink;
      }

      const removalEntered = yield* Deferred.make<void>();
      const releaseRemoval = yield* Deferred.make<void>();
      const removal = yield* withWorkspaceRemovalLease(
        fs,
        path,
        taskOne,
        Deferred.succeed(removalEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRemoval)),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(removalEntered);

      // Sibling task and unrelated symlink/.. under the same worktrees root must NOT block.
      const siblingLink = path.join(realWorktrees, "unrelated-link");
      yield* fs.symlink(outsideChild, siblingLink);
      const siblingRan = yield* withTurnStartReservation(
        fs,
        path,
        path.join(worktreesAlias, "task-2"),
        Effect.succeed("ok"),
      );
      expect(siblingRan).toBe("ok");
      const unrelatedDotDotRan = yield* withTurnStartReservation(
        fs,
        path,
        `${siblingLink}${path.sep}..`,
        Effect.succeed("ok"),
      );
      expect(unrelatedDotDotRan).toBe("ok");

      // Deep symlink chain, symlink/.., and ordinary-dir/.. paths through task-1 must wait for removal.
      const deepTraced = yield* Deferred.make<void>();
      const dotDotTraced = yield* Deferred.make<void>();
      const dirDotDotTraced = yield* Deferred.make<void>();
      const deepEntered = yield* Deferred.make<void>();
      const dotDotEntered = yield* Deferred.make<void>();
      const dirDotDotEntered = yield* Deferred.make<void>();
      const signalAfterTrace = (traced: Deferred.Deferred<void>) =>
        FileSystem.FileSystem.of({
          ...fs,
          realPath: (target) =>
            fs.realPath(target).pipe(Effect.tap(() => Deferred.succeed(traced, undefined))),
        });
      const deepFiber = yield* withTurnStartReservation(
        signalAfterTrace(deepTraced),
        path,
        chainTarget,
        Deferred.succeed(deepEntered, undefined),
      ).pipe(Effect.forkScoped);
      const dotDotFiber = yield* withTurnStartReservation(
        signalAfterTrace(dotDotTraced),
        path,
        `${path.join(worktreesAlias, "task-1", "outward-link")}${path.sep}..`,
        Deferred.succeed(dotDotEntered, undefined),
      ).pipe(Effect.forkScoped);
      const dirDotDotFiber = yield* withTurnStartReservation(
        signalAfterTrace(dirDotDotTraced),
        path,
        `${taskOne}${path.sep}..${path.sep}task-2`,
        Deferred.succeed(dirDotDotEntered, undefined),
      ).pipe(Effect.forkScoped);

      yield* Deferred.await(deepTraced);
      yield* Deferred.await(dotDotTraced);
      yield* Deferred.await(dirDotDotTraced);
      expect(yield* Deferred.isDone(deepEntered)).toBe(false);
      expect(yield* Deferred.isDone(dotDotEntered)).toBe(false);
      expect(yield* Deferred.isDone(dirDotDotEntered)).toBe(false);

      yield* Deferred.succeed(releaseRemoval, undefined);
      yield* Fiber.join(removal);
      yield* Fiber.join(deepFiber);
      yield* Fiber.join(dotDotFiber);
      yield* Fiber.join(dirDotDotFiber);
      expect(yield* Deferred.isDone(deepEntered)).toBe(true);
      expect(yield* Deferred.isDone(dotDotEntered)).toBe(true);
      expect(yield* Deferred.isDone(dirDotDotEntered)).toBe(true);

      // traceWorkspacePath resolves `symlink/..` like OS chdir, not lexical path.resolve.
      const taskSub = path.join(taskOne, "sub");
      yield* fs.makeDirectory(taskSub, { recursive: true });
      const outsideLinkToSub = path.join(outsideParent, "link-to-task-sub");
      yield* fs.symlink(taskSub, outsideLinkToSub);
      const traced = yield* traceWorkspacePath(fs, path, `${outsideLinkToSub}${path.sep}..`);
      expect(traced.resolved).toBe(yield* fs.realPath(taskOne));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

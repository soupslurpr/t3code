import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as CurrentTodoStore from "./CurrentTodoStore.ts";

const TestLayer = CurrentTodoStore.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-current-todo-store-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("CurrentTodoStore", () => {
  it.effect("persists one real CURRENT_TODO.md outside the workspace", () =>
    Effect.gen(function* () {
      const store = yield* CurrentTodoStore.CurrentTodoStore;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("../../path-like-thread");
      const content = "# Current status\n\nMilestone one is active.\n";

      assert.deepEqual(yield* store.read(threadId), { exists: false, content: null });
      yield* store.write(threadId, content);
      assert.deepEqual(yield* store.read(threadId), { exists: true, content });

      const rootDirectory = path.join(config.stateDir, "current-todos");
      const threadDirectories = yield* fileSystem.readDirectory(rootDirectory);
      assert.equal(threadDirectories.length, 1);
      assert.equal(
        yield* fileSystem.readFileString(
          path.join(rootDirectory, threadDirectories[0]!, "CURRENT_TODO.md"),
        ),
        content,
      );
      assert.isFalse(yield* fileSystem.exists(path.join(config.stateDir, "CURRENT_TODO.md")));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("snapshots, restores, and prunes tracker checkpoints", () =>
    Effect.gen(function* () {
      const store = yield* CurrentTodoStore.CurrentTodoStore;
      const threadId = ThreadId.make("thread-checkpoints");

      yield* store.write(threadId, "milestone 0");
      yield* store.captureCheckpoint(threadId, 0);
      yield* store.write(threadId, "milestone 1");
      yield* store.captureCheckpoint(threadId, 1);
      yield* store.write(threadId, "future work");

      yield* store.restoreCheckpoint(threadId, 0);
      assert.deepEqual(yield* store.read(threadId), {
        exists: true,
        content: "milestone 0",
      });

      yield* store.deleteCheckpointsAfter(threadId, 0);
      const exit = yield* Effect.exit(store.readCheckpoint(threadId, 1));
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps the first snapshot captured for a turn", () =>
    Effect.gen(function* () {
      const store = yield* CurrentTodoStore.CurrentTodoStore;
      const threadId = ThreadId.make("thread-duplicate-baseline");

      yield* store.write(threadId, "pre-turn state");
      yield* store.captureCheckpoint(threadId, 2);
      yield* store.write(threadId, "mid-turn state");
      yield* store.captureCheckpoint(threadId, 2);

      yield* store.restoreCheckpoint(threadId, 2);
      assert.deepEqual(yield* store.read(threadId), {
        exists: true,
        content: "pre-turn state",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("restores an absent tracker and keeps copied threads independent", () =>
    Effect.gen(function* () {
      const store = yield* CurrentTodoStore.CurrentTodoStore;
      const absentThreadId = ThreadId.make("thread-absent-checkpoint");
      const legacyAbsentThreadId = ThreadId.make("thread-legacy-absent-checkpoint");
      const sourceThreadId = ThreadId.make("thread-copy-source");
      const targetThreadId = ThreadId.make("thread-copy-target");

      yield* store.captureCheckpoint(absentThreadId, 0);
      yield* store.write(absentThreadId, "temporary");
      yield* store.restoreCheckpoint(absentThreadId, 0);
      assert.deepEqual(yield* store.read(absentThreadId), { exists: false, content: null });

      // Checkpoints created before tracker support have no snapshot. They
      // remain safely revertible while the thread has no active tracker.
      yield* store.restoreCheckpoint(legacyAbsentThreadId, 4);
      assert.deepEqual(yield* store.read(legacyAbsentThreadId), {
        exists: false,
        content: null,
      });

      yield* store.write(sourceThreadId, "source snapshot");
      yield* store.copyThread(sourceThreadId, targetThreadId);
      yield* store.write(sourceThreadId, "source changed");
      assert.deepEqual(yield* store.read(targetThreadId), {
        exists: true,
        content: "source snapshot",
      });

      yield* store.deleteThread(targetThreadId);
      assert.deepEqual(yield* store.read(targetThreadId), { exists: false, content: null });
      assert.deepEqual(yield* store.read(sourceThreadId), {
        exists: true,
        content: "source changed",
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});

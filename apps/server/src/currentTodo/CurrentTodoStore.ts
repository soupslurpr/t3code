/**
 * CurrentTodoStore - Persists Codex's thread-scoped milestone tracker.
 *
 * Active trackers live outside project worktrees under T3's state directory.
 * Checkpoint snapshots preserve the same tracker state as workspace reverts.
 *
 * @module CurrentTodoStore
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

const ACTIVE_FILE_NAME = "CURRENT_TODO.md";
const CHECKPOINT_DIRECTORY_NAME = "checkpoints";
const SNAPSHOT_VERSION = 1;
const ERROR_DETAIL_MAX_LENGTH = 1_024;

export const CurrentTodoStoreOperation = Schema.Literals([
  "read",
  "write",
  "snapshot",
  "restore",
  "prune",
  "delete",
  "copy",
]);
export type CurrentTodoStoreOperation = typeof CurrentTodoStoreOperation.Type;

/** Reports a bounded failure from thread tracker persistence. */
export class CurrentTodoStoreError extends Schema.TaggedErrorClass<CurrentTodoStoreError>()(
  "CurrentTodoStoreError",
  {
    operation: CurrentTodoStoreOperation,
    threadId: ThreadId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Current TODO ${this.operation} failed: ${this.detail}`;
  }
}

export interface CurrentTodoReadResult {
  readonly exists: boolean;
  readonly content: string | null;
}

export interface CurrentTodoStoreShape {
  readonly read: (
    threadId: ThreadId,
  ) => Effect.Effect<CurrentTodoReadResult, CurrentTodoStoreError>;
  readonly write: (
    threadId: ThreadId,
    content: string,
  ) => Effect.Effect<void, CurrentTodoStoreError>;
  readonly captureCheckpoint: (
    threadId: ThreadId,
    turnCount: number,
  ) => Effect.Effect<void, CurrentTodoStoreError>;
  readonly readCheckpoint: (
    threadId: ThreadId,
    turnCount: number,
  ) => Effect.Effect<CurrentTodoReadResult, CurrentTodoStoreError>;
  readonly restoreCheckpoint: (
    threadId: ThreadId,
    turnCount: number,
  ) => Effect.Effect<void, CurrentTodoStoreError>;
  readonly deleteCheckpointsAfter: (
    threadId: ThreadId,
    turnCount: number,
  ) => Effect.Effect<void, CurrentTodoStoreError>;
  readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void, CurrentTodoStoreError>;
  readonly copyThread: (
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
  ) => Effect.Effect<void, CurrentTodoStoreError>;
}

/** Provides thread tracker persistence to MCP and lifecycle reactors. */
export class CurrentTodoStore extends Context.Service<CurrentTodoStore, CurrentTodoStoreShape>()(
  "t3/currentTodo/CurrentTodoStore",
) {}

const CurrentTodoSnapshot = Schema.Struct({
  version: Schema.Literal(SNAPSHOT_VERSION),
  content: Schema.NullOr(Schema.String),
});
type CurrentTodoSnapshot = typeof CurrentTodoSnapshot.Type;
const CurrentTodoSnapshotJson = Schema.fromJsonString(CurrentTodoSnapshot);
const encodeCurrentTodoSnapshot = Schema.encodeEffect(CurrentTodoSnapshotJson);
const decodeCurrentTodoSnapshot = Schema.decodeEffect(CurrentTodoSnapshotJson);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const checkpointCaptureSemaphore = yield* Semaphore.make(1);
  const rootDirectory = path.join(config.stateDir, "current-todos");
  const writeAtomically = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const failure = (
    operation: CurrentTodoStoreOperation,
    threadId: ThreadId,
    cause: unknown,
  ): CurrentTodoStoreError => {
    const detail = (cause instanceof Error ? cause.message : String(cause))
      .replaceAll(/\s+/g, " ")
      .trim()
      .slice(0, ERROR_DETAIL_MAX_LENGTH);
    return new CurrentTodoStoreError({
      operation,
      threadId,
      detail: detail.length > 0 ? detail : "unknown storage error",
    });
  };

  const threadDirectory = Effect.fn("CurrentTodoStore.threadDirectory")(function* (
    threadId: ThreadId,
  ) {
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(threadId))
      .pipe(Effect.orDie);
    const key = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return path.join(rootDirectory, key);
  });

  const readFor = Effect.fn("CurrentTodoStore.readFor")(function* (
    threadId: ThreadId,
    operation: CurrentTodoStoreOperation,
  ) {
    const directory = yield* threadDirectory(threadId);
    const filePath = path.join(directory, ACTIVE_FILE_NAME);
    return yield* Effect.gen(function* () {
      if (!(yield* fileSystem.exists(filePath))) {
        return { exists: false, content: null } satisfies CurrentTodoReadResult;
      }
      return {
        exists: true,
        content: yield* fileSystem.readFileString(filePath),
      } satisfies CurrentTodoReadResult;
    }).pipe(Effect.mapError((cause) => failure(operation, threadId, cause)));
  });

  const writeFor = Effect.fn("CurrentTodoStore.writeFor")(function* (
    threadId: ThreadId,
    content: string,
    operation: CurrentTodoStoreOperation,
  ) {
    const directory = yield* threadDirectory(threadId);
    yield* writeAtomically(path.join(directory, ACTIVE_FILE_NAME), content).pipe(
      Effect.mapError((cause) => failure(operation, threadId, cause)),
    );
  });

  const removeActiveFor = Effect.fn("CurrentTodoStore.removeActiveFor")(function* (
    threadId: ThreadId,
    operation: CurrentTodoStoreOperation,
  ) {
    const directory = yield* threadDirectory(threadId);
    yield* fileSystem
      .remove(path.join(directory, ACTIVE_FILE_NAME), { force: true })
      .pipe(Effect.mapError((cause) => failure(operation, threadId, cause)));
  });

  const checkpointFilePath = Effect.fn("CurrentTodoStore.checkpointFilePath")(function* (
    threadId: ThreadId,
    turnCount: number,
  ) {
    const directory = yield* threadDirectory(threadId);
    return path.join(directory, CHECKPOINT_DIRECTORY_NAME, `${turnCount}.json`);
  });

  const read: CurrentTodoStoreShape["read"] = (threadId) => readFor(threadId, "read");

  const write: CurrentTodoStoreShape["write"] = (threadId, content) =>
    writeFor(threadId, content, "write");

  const captureCheckpointUnlocked = Effect.fn("CurrentTodoStore.captureCheckpoint")(function* (
    threadId: ThreadId,
    turnCount: number,
  ) {
    const snapshotPath = yield* checkpointFilePath(threadId, turnCount);
    const snapshotExists = yield* fileSystem
      .exists(snapshotPath)
      .pipe(Effect.mapError((cause) => failure("snapshot", threadId, cause)));
    if (snapshotExists) return;

    const active = yield* readFor(threadId, "snapshot");
    const snapshot: CurrentTodoSnapshot = {
      version: SNAPSHOT_VERSION,
      content: active.content,
    };
    const encoded = yield* encodeCurrentTodoSnapshot(snapshot).pipe(
      Effect.mapError((cause) => failure("snapshot", threadId, cause)),
    );
    yield* writeAtomically(snapshotPath, `${encoded}\n`).pipe(
      Effect.mapError((cause) => failure("snapshot", threadId, cause)),
    );
  });

  const captureCheckpoint: CurrentTodoStoreShape["captureCheckpoint"] = (threadId, turnCount) =>
    checkpointCaptureSemaphore.withPermits(1)(captureCheckpointUnlocked(threadId, turnCount));

  const readCheckpoint: CurrentTodoStoreShape["readCheckpoint"] = Effect.fn(
    "CurrentTodoStore.readCheckpoint",
  )(function* (threadId, turnCount) {
    const snapshotPath = yield* checkpointFilePath(threadId, turnCount);
    const snapshotExists = yield* fileSystem
      .exists(snapshotPath)
      .pipe(Effect.mapError((cause) => failure("restore", threadId, cause)));
    if (!snapshotExists) {
      const active = yield* readFor(threadId, "restore");
      if (!active.exists) return active;
      return yield* failure(
        "restore",
        threadId,
        new Error(`checkpoint snapshot for turn ${turnCount} is unavailable`),
      );
    }
    const encoded = yield* fileSystem
      .readFileString(snapshotPath)
      .pipe(Effect.mapError((cause) => failure("restore", threadId, cause)));
    const snapshot = yield* decodeCurrentTodoSnapshot(encoded).pipe(
      Effect.mapError((cause) => failure("restore", threadId, cause)),
    );
    return {
      exists: snapshot.content !== null,
      content: snapshot.content,
    };
  });

  const restoreCheckpoint: CurrentTodoStoreShape["restoreCheckpoint"] = Effect.fn(
    "CurrentTodoStore.restoreCheckpoint",
  )(function* (threadId, turnCount) {
    const snapshot = yield* readCheckpoint(threadId, turnCount);
    if (snapshot.content === null) {
      yield* removeActiveFor(threadId, "restore");
    } else {
      yield* writeFor(threadId, snapshot.content, "restore");
    }
  });

  const deleteCheckpointsAfter: CurrentTodoStoreShape["deleteCheckpointsAfter"] = Effect.fn(
    "CurrentTodoStore.deleteCheckpointsAfter",
  )(function* (threadId, turnCount) {
    const directory = yield* threadDirectory(threadId);
    const checkpointDirectory = path.join(directory, CHECKPOINT_DIRECTORY_NAME);
    yield* Effect.gen(function* () {
      if (!(yield* fileSystem.exists(checkpointDirectory))) return;
      const entries = yield* fileSystem.readDirectory(checkpointDirectory);
      yield* Effect.forEach(
        entries,
        (entry) => {
          const match = /^(\d+)\.json$/.exec(entry);
          if (!match || Number(match[1]) <= turnCount) return Effect.void;
          return fileSystem.remove(path.join(checkpointDirectory, entry), { force: true });
        },
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.mapError((cause) => failure("prune", threadId, cause)));
  });

  const deleteThread: CurrentTodoStoreShape["deleteThread"] = Effect.fn(
    "CurrentTodoStore.deleteThread",
  )(function* (threadId) {
    const directory = yield* threadDirectory(threadId);
    yield* fileSystem
      .remove(directory, { recursive: true, force: true })
      .pipe(Effect.mapError((cause) => failure("delete", threadId, cause)));
  });

  const copyThread: CurrentTodoStoreShape["copyThread"] = Effect.fn("CurrentTodoStore.copyThread")(
    function* (sourceThreadId, targetThreadId) {
      const source = yield* readFor(sourceThreadId, "copy");
      const targetDirectory = yield* threadDirectory(targetThreadId);
      yield* fileSystem
        .remove(targetDirectory, { recursive: true, force: true })
        .pipe(Effect.mapError((cause) => failure("copy", targetThreadId, cause)));
      if (source.content !== null) {
        yield* writeFor(targetThreadId, source.content, "copy");
      }
    },
  );

  return CurrentTodoStore.of({
    read,
    write,
    captureCheckpoint,
    readCheckpoint,
    restoreCheckpoint,
    deleteCheckpointsAfter,
    deleteThread,
    copyThread,
  });
});

/** Constructs the live thread tracker store under T3's state directory. */
export const layer = Layer.effect(CurrentTodoStore, make);

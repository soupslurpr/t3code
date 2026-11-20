import { describe, expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  CheckpointId,
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  type FilesystemEntryMetadata,
  type FilesystemGetMetadataInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  type SupervisorConnectionState,
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createFileMetadataAtoms, createCheckpointFileTracker } from "./fileMetadata.ts";

const ENVIRONMENT_ID = EnvironmentId.make("metadata-environment");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("metadata-other-environment");

const makeHarness = Effect.fnUntraced(function* () {
  const batches: string[][] = [];
  const values = new Map<string, FilesystemEntryMetadata | null>();
  const failure = { denied: false };
  const response = { wait: Effect.void as Effect.Effect<void> };
  const makeSession = () =>
    ({
      client: {
        [WS_METHODS.filesystemGetMetadata]: (input: FilesystemGetMetadataInput) =>
          Effect.gen(function* () {
            batches.push([...input.paths]);
            if (failure.denied)
              return yield* new EnvironmentAuthorizationError({
                requiredScope: AuthFilesystemReadScope,
                message: "File access is not granted.",
              });
            const entries = input.paths.map((path) => values.get(path) ?? null);
            yield* response.wait;
            return { entries };
          }),
      },
    }) as unknown as RpcSession;
  const session = yield* SubscriptionRef.make(Option.some(makeSession()));
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected" as const,
  });
  const supervisor = {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Test",
      connectionId: "test",
    }),
    session,
    state,
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const otherSupervisor = {
    ...supervisor,
    target: new BearerConnectionTarget({
      environmentId: OTHER_ENVIRONMENT_ID,
      label: "Test",
      connectionId: "test",
    }),
    session: yield* SubscriptionRef.make(Option.some(makeSession())),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const getSupervisor = (environmentId: EnvironmentId) =>
    environmentId === OTHER_ENVIRONMENT_ID ? otherSupervisor : supervisor;
  const environmentRegistry = {
    run: (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        getSupervisor(environmentId),
      ),
    followStream: (environmentId, stream) =>
      Stream.provideService(
        stream,
        EnvironmentSupervisor.EnvironmentSupervisor,
        getSupervisor(environmentId),
      ),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const clock = yield* Clock.Clock;
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(Clock.Clock, clock),
    ),
  );
  const atoms = createFileMetadataAtoms(runtime);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atom = (path: string, environmentId = ENVIRONMENT_ID, threadId?: ThreadId) =>
    atoms.metadata({ environmentId, input: { path, ...(threadId ? { threadId } : {}) } });
  const read = (path: string, environmentId = ENVIRONMENT_ID, threadId?: ThreadId) =>
    AtomRegistry.getResult(registry, atom(path, environmentId, threadId), {
      suspendOnWaiting: true,
    }).pipe(Effect.tap(() => Effect.yieldNow));
  const seed = (path: string, kind: "file" | "directory") =>
    atoms
      .rememberEntries("/workspace", [{ path, kind }])
      .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
  return {
    batches,
    state,
    values,
    registry,
    atom,
    read,
    seed,
    session,
    makeSession,
    atoms,
    supervisor,
    failure,
    response,
  };
});

describe("file metadata", () => {
  it.effect("checks inferred paths once, then follows checkpoint and connection changes", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      const h = yield* makeHarness();
      const ref = { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("scratch") };
      const path = "/scratch/config/AGENTS.md";
      const query = (path: string) =>
        h.atoms.confirmedKind({
          environmentId: ref.environmentId,
          input: { path, threadId: ref.threadId },
        });
      h.registry.mount(h.atoms.retainThread(ref));
      const kind = query(path);
      const waitForKind = (value: "file" | null) =>
        AtomRegistry.toStream(h.registry, kind).pipe(
          Stream.filter((current) => current === value),
          Stream.runHead,
        );
      const unmount = h.registry.mount(kind);
      h.registry.mount(query("/scratch/config/GEMINI.md"));
      h.registry.mount(query("\\\\host\\share\\file.md"));
      h.registry.mount(query("/" + "x".repeat(512)));
      h.registry.mount(query("unanchored/file.md"));
      yield* h.read(path, ref.environmentId, ref.threadId);
      expect(h.batches).toEqual([[path, "/scratch/config/GEMINI.md"]]);
      yield* TestClock.adjust(120_001);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(120_001));
      expect(h.batches).toHaveLength(1);

      const changes = createCheckpointFileTracker();
      const checkpoint = {
        id: CheckpointId.make("cp"),
        status: "ready",
        files: [{ path: "config/AGENTS.md", kind: "added", additions: 1, deletions: 0 }],
      } as const;
      expect(changes(ref, "/scratch", [])).toEqual([]);
      const refreshCheckpoint = Effect.fn("test.refreshCheckpoint")(function* (
        checkpoints: ReadonlyArray<typeof checkpoint>,
      ) {
        const paths = changes(ref, "/scratch", checkpoints);
        expect(paths).toEqual([path]);
        yield* h.atoms
          .invalidate(paths)
          .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
        h.atoms.refreshPaths(ref.environmentId, paths, h.registry);
      });
      h.values.set(path, { kind: "file" });
      yield* refreshCheckpoint([checkpoint]);
      yield* waitForKind("file");
      yield* SubscriptionRef.set<SupervisorConnectionState>(h.state, {
        ...AVAILABLE_CONNECTION_STATE,
        phase: "offline",
      });
      yield* waitForKind(null);
      yield* SubscriptionRef.set(h.session, Option.some(h.makeSession()));
      yield* SubscriptionRef.set<SupervisorConnectionState>(h.state, {
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
      });
      yield* waitForKind("file");
      h.values.delete(path);
      yield* refreshCheckpoint([]);
      yield* h.read(path, ref.environmentId, ref.threadId);
      expect(h.registry.get(kind)).toBeNull();
      expect(h.batches.slice(1)).toEqual([[path], expect.arrayContaining([path]), [path]]);
      unmount();
      yield* TestClock.adjust(61_000);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(61_000));
      h.values.set(path, { kind: "file" });
      h.registry.mount(kind);
      yield* waitForKind("file");
      h.failure.denied = true;
      yield* refreshCheckpoint([checkpoint]);
      expect(yield* h.read(path, ref.environmentId, ref.threadId).pipe(Effect.flip)).toBeInstanceOf(
        EnvironmentAuthorizationError,
      );
      expect(h.registry.get(kind)).toBeNull();
    }),
  );

  it.effect(
    "rechecks home aliases affected by absolute checkpoint paths, even across row unmounts",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const ref = { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("home-thread") };
        const alias = "~/repo/config/AGENTS.md";
        const unrelated = "~/other/GEMINI.md";
        h.registry.mount(h.atoms.retainThread(ref));
        const kind = h.atoms.confirmedKind({
          environmentId: ref.environmentId,
          input: { path: alias, threadId: ref.threadId },
        });
        const unmount = h.registry.mount(kind);
        yield* h.read(alias, ref.environmentId, ref.threadId);
        yield* h.read(unrelated, ref.environmentId, ref.threadId);
        const refresh = Effect.fn("test.invalidateHomeCheckpoint")(function* (...paths: string[]) {
          yield* h.atoms
            .invalidate(paths)
            .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
          h.atoms.refreshPaths(ref.environmentId, paths, h.registry);
        });
        const before = h.batches.length;
        h.values.set(alias, { kind: "file" });
        yield* refresh("/srv/account/repo/config/AGENTS.md", "/mnt/archive/repo/config/AGENTS.md");
        expect(yield* h.read(alias, ref.environmentId, ref.threadId)).toEqual({ kind: "file" });
        expect(h.registry.get(kind)).toBe("file");
        unmount();
        yield* TestClock.adjust(120_001);
        h.values.delete(alias);
        yield* refresh("C:\\Users\\account\\repo\\config\\agents.md");
        expect(yield* h.read(alias, ref.environmentId, ref.threadId)).toBeNull();
        expect(h.batches.slice(before)).toEqual([[alias], [alias]]);
      }),
  );

  it.effect("refreshes expired mounted misses while retaining known thread entries", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      const h = yield* makeHarness();
      const threadId = ThreadId.make("new-directory-thread");
      h.registry.mount(h.atoms.retainThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const path = "/home/user/games/hl1";
      h.registry.mount(h.atom(path, ENVIRONMENT_ID, threadId));
      h.values.set("/workspace/known", { kind: "file", byteLength: 5 });
      expect(yield* h.read(path, ENVIRONMENT_ID, threadId)).toBeNull();
      yield* h.read("/workspace/known", ENVIRONMENT_ID, threadId);
      h.values.set(path, { kind: "directory" });
      h.registry.refresh(h.atom(path, ENVIRONMENT_ID, threadId));
      expect(yield* h.read(path, ENVIRONMENT_ID, threadId)).toBeNull();
      h.failure.denied = true;
      yield* TestClock.adjust(60_001);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
      expect(yield* h.read(path, ENVIRONMENT_ID, threadId).pipe(Effect.flip)).toBeInstanceOf(
        EnvironmentAuthorizationError,
      );
      h.failure.denied = false;
      yield* TestClock.adjust(60_001);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
      expect(yield* h.read(path, ENVIRONMENT_ID, threadId)).toEqual({ kind: "directory" });
      h.registry.refresh(h.atom("/workspace/known", ENVIRONMENT_ID, threadId));
      expect(yield* h.read("/workspace/known", ENVIRONMENT_ID, threadId)).toEqual({
        kind: "file",
        byteLength: 5,
      });
      yield* TestClock.adjust(60_001);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
      expect(h.batches).toEqual([[path], ["/workspace/known"], [path], [path]]);
    }),
  );

  it.effect("does not seed a different path from a literal name with a numeric suffix", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.seed("report:123", "directory");
      h.values.set("/workspace/report", { kind: "file", byteLength: 5 });
      expect(yield* h.read("/workspace/report")).toEqual({ kind: "file", byteLength: 5 });
      expect(yield* h.read("/workspace/report:123")).toEqual({ kind: "directory" });
      yield* h.atoms
        .rememberFile("/workspace", {
          relativePath: "/workspace/read:12:3",
          byteLength: 100,
        })
        .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
      expect(yield* h.read("/workspace/read:12:3")).toEqual({ kind: "file", byteLength: 100 });
      expect(yield* h.read("/workspace/read")).toBeNull();
      expect(h.batches).toEqual([["/workspace/report"], ["/workspace/read"]]);
    }),
  );

  it.effect("retries only paths invalidated while their response is in flight", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("in-flight-thread");
      h.registry.mount(h.atoms.retainThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      h.response.wait = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const file = "/workspace//./file";
      h.values.set(file, { kind: "file", byteLength: 5 });
      h.values.set("/workspace/unchanged", { kind: "directory" });
      const read = yield* Effect.all(
        [h.read(file, ENVIRONMENT_ID, threadId), h.read("/workspace/unchanged")],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* h.atoms
        .invalidate(["/workspace/file"])
        .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
      h.values.set(file, { kind: "file", byteLength: 10 });
      h.response.wait = Effect.void;
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(read)).toEqual([
        { kind: "file", byteLength: 10 },
        { kind: "directory" },
      ]);
      expect(h.batches).toEqual([[file, "/workspace/unchanged"], [file]]);
      h.registry.refresh(h.atom(file, ENVIRONMENT_ID, threadId));
      expect(yield* h.read(file, ENVIRONMENT_ID, threadId)).toEqual({
        kind: "file",
        byteLength: 10,
      });
      expect(h.batches).toHaveLength(2);
    }),
  );

  it.effect("an offscreen invalidation waits until that path is read again", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("offscreen-thread");
      h.registry.mount(h.atoms.retainThread({ environmentId: ENVIRONMENT_ID, threadId }));
      yield* h.read("/workspace/file", ENVIRONMENT_ID, threadId);
      yield* h.atoms
        .invalidate(["/workspace/file"])
        .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
      h.atoms.refreshPaths(ENVIRONMENT_ID, ["/workspace/file"], h.registry);
      yield* Effect.yieldNow;
      expect(h.batches).toHaveLength(1);
      h.values.set("/workspace/file", { kind: "directory" });
      expect(yield* h.read("/workspace/file", ENVIRONMENT_ID, threadId)).toEqual({
        kind: "directory",
      });
      expect(h.batches).toHaveLength(2);
    }),
  );

  it.effect("invalidates a changed retained path without refetching other paths", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("changing-thread");
      h.registry.mount(h.atoms.retainThread({ environmentId: ENVIRONMENT_ID, threadId }));
      h.values.set("/workspace/file", { kind: "file", byteLength: 5 });
      const file = h.atom("/workspace/file", ENVIRONMENT_ID, threadId);
      h.registry.mount(file);
      yield* h.read("/workspace/file", ENVIRONMENT_ID, threadId);
      yield* h.read("/workspace/unchanged", ENVIRONMENT_ID, threadId);
      const before = h.batches.length;
      h.values.set("/workspace/file", { kind: "file", byteLength: 10 });
      yield* h.atoms
        .invalidate(["/workspace/file"])
        .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
      h.atoms.refreshPaths(ENVIRONMENT_ID, ["/workspace/file"], h.registry);
      expect(yield* h.read("/workspace/file", ENVIRONMENT_ID, threadId)).toEqual({
        kind: "file",
        byteLength: 10,
      });
      h.registry.refresh(h.atom("/workspace/unchanged", ENVIRONMENT_ID, threadId));
      yield* h.read("/workspace/unchanged", ENVIRONMENT_ID, threadId);
      expect(h.batches.slice(before)).toEqual([["/workspace/file"]]);
    }),
  );

  it.effect("a reconnect discards retained metadata from the previous session", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("reconnected-thread");
      h.registry.mount(h.atoms.retainThread({ environmentId: ENVIRONMENT_ID, threadId }));
      h.values.set("/workspace/file", { kind: "file" });
      yield* h.read("/workspace/file", ENVIRONMENT_ID, threadId);
      h.values.set("/workspace/file", { kind: "directory" });
      yield* SubscriptionRef.set(h.session, Option.some(h.makeSession()));
      h.registry.refresh(h.atom("/workspace/file", ENVIRONMENT_ID, threadId));
      expect(yield* h.read("/workspace/file", ENVIRONMENT_ID, threadId)).toEqual({
        kind: "directory",
      });
      expect(h.batches).toHaveLength(2);
    }),
  );

  it.effect("keeps batches and cached paths separate across environments", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.seed("known", "directory");
      expect(yield* h.read("/workspace/known", OTHER_ENVIRONMENT_ID)).toBeNull();
      expect(h.batches).toEqual([["/workspace/known"]]);
      yield* Effect.all(
        [h.read("/workspace/new"), h.read("/workspace/new", OTHER_ENVIRONMENT_ID)],
        { concurrency: "unbounded" },
      );
      expect(h.batches.slice(1)).toEqual([["/workspace/new"], ["/workspace/new"]]);
    }),
  );

  it.effect("settles a failed batch and can retry after access is granted", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.failure.denied = true;
      const failures = yield* Effect.all(
        [h.read("/workspace/a").pipe(Effect.flip), h.read("/workspace/b").pipe(Effect.flip)],
        { concurrency: "unbounded" },
      );
      expect(failures.every(Schema.is(EnvironmentAuthorizationError))).toBe(true);
      h.failure.denied = false;
      h.values.set("/workspace/a", { kind: "directory" });
      h.registry.refresh(h.atom("/workspace/a"));
      expect(yield* h.read("/workspace/a")).toEqual({ kind: "directory" });
    }),
  );

  it.effect("invalidates equivalent separator and dot spellings and stats the written path", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const ref = { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("dot-path") };
      const path = "/scratch/config/./AGENTS.md";
      const parent = "/scratch/link/../config/AGENTS.md";
      h.registry.mount(h.atoms.retainThread(ref));
      const kind = h.atoms.confirmedKind({
        environmentId: ref.environmentId,
        input: { path, threadId: ref.threadId },
      });
      h.registry.mount(kind);
      expect(yield* h.read(path, ref.environmentId, ref.threadId)).toBeNull();
      expect(yield* h.read(parent, ref.environmentId, ref.threadId)).toBeNull();
      h.values.set(path, { kind: "file" });
      const changed = ["/scratch/config/AGENTS.md"];
      yield* h.atoms
        .invalidate(changed)
        .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
      h.atoms.refreshPaths(ref.environmentId, changed, h.registry);
      expect(yield* h.read(path, ref.environmentId, ref.threadId)).toEqual({ kind: "file" });
      expect(h.registry.get(kind)).toBe("file");
      expect(yield* h.read(parent, ref.environmentId, ref.threadId)).toBeNull();
      expect(h.batches).toEqual([[path], [parent], [path]]);
    }),
  );

  it.effect("preserves Windows casing on the wire and in retained metadata", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const ref = {
        environmentId: ENVIRONMENT_ID,
        threadId: ThreadId.make("case-sensitive-mount"),
      };
      h.registry.mount(h.atoms.retainThread(ref));
      const upper = String.raw`C:\MixedCase\File.md`;
      const lower = String.raw`C:\MixedCase\file.md`;
      const read = (path: string) => h.read(path, ref.environmentId, ref.threadId);
      h.values.set(upper, { kind: "file" });
      expect(yield* read(upper)).toEqual({ kind: "file" });
      expect(yield* read(lower)).toBeNull();
      expect(h.batches).toEqual([[upper], [lower]]);
      h.values.delete(upper);
      h.values.set(lower, { kind: "directory" });
      const changed = ["c:/mixedcase/FILE.md"];
      yield* h.atoms
        .invalidate(changed)
        .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
      h.atoms.refreshPaths(ref.environmentId, changed, h.registry);
      expect(yield* read(upper)).toBeNull();
      expect(yield* read(lower)).toEqual({ kind: "directory" });
      expect(h.batches.flat()).toEqual([upper, lower, upper, lower]);
    }),
  );

  it.effect("reuses file read sizes across Windows separator spellings", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.atoms
        .rememberFile("C:\\Workspace", {
          relativePath: "file",
          byteLength: 100,
        })
        .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
      expect(yield* h.read("C:/Workspace/file/")).toEqual({ kind: "file", byteLength: 100 });
      expect(h.batches).toHaveLength(0);
    }),
  );

  it.effect("batches mounted paths and deduplicates repeated chips", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.values.set("/workspace/file", { kind: "file", byteLength: 5 });
      h.values.set("/workspace/folder.ts", { kind: "directory" });
      const results = yield* Effect.all(
        [h.read("/workspace/file"), h.read("/workspace/folder.ts"), h.read("/workspace/file")],
        { concurrency: "unbounded" },
      );
      expect(h.batches).toEqual([["/workspace/file", "/workspace/folder.ts"]]);
      expect(results).toEqual([
        { kind: "file", byteLength: 5 },
        { kind: "directory" },
        { kind: "file", byteLength: 5 },
      ]);
      yield* h.read("/workspace/file");
      expect(h.batches).toHaveLength(1);
    }),
  );

  it.effect("uses search and tree kinds for directories but still stats found files", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.seed("folder.ts", "directory");
      expect(yield* h.read("/workspace/folder.ts")).toEqual({ kind: "directory" });
      expect(h.batches).toHaveLength(0);
      h.values.set("/workspace/notes.md", { kind: "file", byteLength: 2048 });
      yield* h.seed("notes.md", "file");
      expect(yield* h.read("/workspace/notes.md")).toEqual({ kind: "file", byteLength: 2048 });
    }),
  );

  it.effect(
    "stats listed files that replace directories or misses and reuses known file sizes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const threadId = ThreadId.make("listed-file-thread");
        h.registry.mount(h.atoms.retainThread({ environmentId: ENVIRONMENT_ID, threadId }));
        const directory = "/workspace/was-directory";
        const missing = "/workspace/was-missing";
        const file = "/workspace/known-file";
        yield* h.seed("was-directory", "directory");
        expect(yield* h.read(missing, ENVIRONMENT_ID, threadId)).toBeNull();
        h.values.set(file, { kind: "file", byteLength: 100 });
        yield* h.read(file, ENVIRONMENT_ID, threadId);

        h.values.set(directory, { kind: "file", byteLength: 2048 });
        h.values.set(missing, { kind: "file", byteLength: 4096 });
        yield* h.seed("was-directory", "file");
        yield* h.seed("was-missing", "file");
        yield* h.seed("known-file", "file");

        expect(yield* h.read(directory)).toEqual({ kind: "file", byteLength: 2048 });
        h.registry.refresh(h.atom(missing, ENVIRONMENT_ID, threadId));
        expect(yield* h.read(missing, ENVIRONMENT_ID, threadId)).toEqual({
          kind: "file",
          byteLength: 4096,
        });
        h.registry.refresh(h.atom(file, ENVIRONMENT_ID, threadId));
        expect(yield* h.read(file, ENVIRONMENT_ID, threadId)).toEqual({
          kind: "file",
          byteLength: 100,
        });
        expect(h.batches.flat()).toEqual([missing, file, directory, missing]);
      }),
  );

  it.effect("splits large mounts into bounded batches and caches misses", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.all(
        Array.from({ length: 130 }, (_, i) => h.read(`/workspace/${i}`)),
        { concurrency: "unbounded" },
      );
      expect(h.batches.flat()).toHaveLength(130);
      expect(h.batches.map((batch) => batch.length)).toEqual([64, 64, 2]);
      expect(h.batches.every((batch) => batch.length <= 64)).toBe(true);
      const count = h.batches.length;
      yield* h.read("/workspace/0");
      expect(h.batches).toHaveLength(count);
    }),
  );
});

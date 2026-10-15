import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type DesktopThreadLifecycle } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";
import * as DesktopGrants from "./DesktopGrants.ts";
import { approveGrant, GRANT_MAXIMUM_MS } from "./DesktopGrantPolicy.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Number,
      grants: Schema.Array(
        Schema.Struct({ grantId: Schema.String, expiresAt: Schema.NullOr(Schema.String) }),
      ),
    }),
  ),
);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const owner = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const source: DesktopThreadLifecycle = {
  version: 2,
  ...owner,
  revision: 1,
  activityRevision: 1,
  state: "active",
  serverNow: iso(0),
  activityAt: iso(0),
  settledAt: null,
};
const open = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  run.pipe(Effect.provide(DesktopGrants.layer), Effect.scoped);

function withDesktop<A, E, R>(run: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const processArch = yield* HostProcess.Architecture;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grant-store-test-" });
    const environment = DesktopEnvironment.layer({
      dirname: path.join(directory, "dist-electron"),
      homeDirectory: directory,
      platform,
      processArch,
      appVersion: "1.0.0",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/repo/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.merge(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: directory })),
      ),
    );
    return yield* run.pipe(
      Effect.provide(
        UserDesktopIdentity.layer.pipe(
          Layer.provideMerge(environment),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
}
const file = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(environment.stateDir, { recursive: true });
  return environment.path.join(environment.stateDir, "desktop-execution-grants.json");
});
const legacy = { grantId: "legacy", scope: "thread", ...owner, remembered: true, expiresAt: null };

describe("desktop grant persistence", () => {
  it.effect("expires and removes finite grants despite a wall clock rollback during uptime", () =>
    withDesktop(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* file;
        let wall = 0;
        let elapsed = 0;
        yield* open(
          Effect.gen(function* () {
            const store = yield* DesktopGrants.DesktopGrants;
            const grant = approveGrant({
              grantId: "temporary",
              owner,
              capability: "execution",
              source,
              now: store.now(),
              policy: {
                scope: "thread",
                lifetime: "until-time",
                deadline: iso(60_000),
                remembered: true,
              },
            });
            yield* store.withPermit(store.replace([grant]));
            yield* store.synchronize(owner, source, "source");
            wall = elapsed = 10_000;
            assert.isDefined(store.select(owner, "execution"));
            wall = -3_600_000;
            elapsed = 70_000;
            assert.equal(store.now(), 70_000);
            assert.isUndefined(store.select(owner, "execution"));
            yield* store.prune;
            assert.isEmpty(store.list());
            const saved = yield* fs.readFileString(path).pipe(Effect.flatMap(decode));
            assert.isEmpty(saved.grants);
          }),
        ).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillisUnsafe: () => wall,
            currentTimeNanosUnsafe: () => BigInt(wall) * 1_000_000n,
            monotonicTimeNanosUnsafe: () => BigInt(elapsed) * 1_000_000n,
          }),
        );
      }),
    ),
  );

  it.effect(
    "migrates once, deduplicates records, and withholds old thread grants until reconciliation",
    () =>
      withDesktop(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* file;
          yield* fs.writeFileString(
            path,
            json({
              version: 1,
              grants: [
                legacy,
                { ...legacy, grantId: "duplicate" },
                { ...legacy, grantId: "expired", expiresAt: iso(0) },
              ],
            }),
          );
          const first = yield* open(
            Effect.gen(function* () {
              const store = yield* DesktopGrants.DesktopGrants;
              assert.lengthOf(store.list(), 1);
              assert.isUndefined(store.select(owner, "execution"));
              yield* store.synchronize(owner, source, "first");
              assert.isDefined(store.select(owner, "execution"));
              return store.list()[0]!.expiresAt;
            }),
          );
          assert.equal(first, iso(GRANT_MAXIMUM_MS));
          yield* TestClock.adjust("1 day");
          yield* open(
            Effect.gen(function* () {
              const store = yield* DesktopGrants.DesktopGrants;
              assert.equal(store.list()[0]!.expiresAt, first);
              assert.isUndefined(store.select(owner, "execution"));
            }),
          );
          const saved = yield* fs.readFileString(path).pipe(Effect.flatMap(decode));
          assert.equal(saved.version, 2);
          assert.lengthOf(saved.grants, 1);
        }),
      ),
  );

  it.effect("removes expired records on its own timer and keeps the saved file owner-only", () =>
    withDesktop(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* file;
        const pruned = yield* Deferred.make<void>();
        let writes = 0;
        const observedFs = {
          ...fs,
          rename: (from: string, to: string) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.tap(() =>
                  ++writes === 2 ? Deferred.succeed(pruned, undefined) : Effect.void,
                ),
              ),
        };
        yield* open(
          Effect.gen(function* () {
            const store = yield* DesktopGrants.DesktopGrants;
            const grant = approveGrant({
              grantId: "temporary",
              owner,
              capability: "execution",
              source,
              now: store.now(),
              policy: {
                scope: "thread",
                lifetime: "until-time",
                deadline: iso(60_000),
                remembered: true,
              },
            });
            yield* store.withPermit(store.replace([grant]));
            yield* TestClock.adjust("1 minute");
            yield* Deferred.await(pruned);
            assert.isEmpty(store.list());
            const saved = yield* fs.readFileString(path).pipe(Effect.flatMap(decode));
            assert.isEmpty(saved.grants);
            const info = yield* fs.stat(path);
            assert.equal(info.mode & 0o777, 0o600);
          }),
        ).pipe(Effect.provideService(FileSystem.FileSystem, observedFs));
      }),
    ),
  );

  it.effect(
    "drops temporary grants on a detected startup clock rollback but preserves explicit indefinite access",
    () =>
      withDesktop(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* file;
          const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
          const temporary = approveGrant({
            grantId: "temporary",
            owner,
            capability: "execution",
            source,
            now: 0,
            policy: { scope: "thread", lifetime: "automatic", deadline: null, remembered: true },
          });
          const indefinite = approveGrant({
            grantId: "indefinite",
            owner,
            capability: "view",
            source,
            now: 0,
            policy: {
              scope: "thread",
              lifetime: "until-revoked",
              deadline: null,
              remembered: true,
            },
          });
          yield* fs.writeFileString(
            path,
            json({
              version: 2,
              desktopId: identity.registration.desktopId,
              lastObservedAt: iso(10_000),
              migratedAt: null,
              grants: [temporary, indefinite],
            }),
          );
          yield* open(
            Effect.gen(function* () {
              const store = yield* DesktopGrants.DesktopGrants;
              assert.deepEqual(
                store.list().map((grant) => grant.grantId),
                ["indefinite"],
              );
            }),
          );
          const saved = yield* fs.readFileString(path).pipe(Effect.flatMap(decode));
          assert.deepEqual(
            saved.grants.map((grant) => grant.grantId),
            ["indefinite"],
          );
        }),
      ),
  );

  it.effect("fails closed on corrupt saved permissions without loading a legacy backup", () =>
    withDesktop(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* file;
        yield* fs.writeFileString(path, "{broken");
        yield* fs.writeFileString(`${path}.bak`, json({ version: 1, grants: [legacy] }));
        yield* open(
          Effect.gen(function* () {
            const store = yield* DesktopGrants.DesktopGrants;
            assert.equal(
              (yield* store.checkStorage.pipe(Effect.flip)).code,
              "grant-storage-failed",
            );
            assert.isEmpty(store.list());
            assert.isUndefined(store.select(owner, "execution"));
          }),
        );
        assert.equal(yield* fs.readFileString(path), "{broken");
      }),
    ),
  );

  it.effect(
    "removes deleted thread records while preserving shared grants and blocking that source",
    () =>
      withDesktop(
        open(
          Effect.gen(function* () {
            const store = yield* DesktopGrants.DesktopGrants;
            const thread = approveGrant({
              grantId: "thread",
              owner,
              capability: "execution",
              source,
              now: 0,
              policy: {
                scope: "thread",
                lifetime: "until-revoked",
                remembered: true,
                deadline: null,
              },
            });
            const broad = approveGrant({
              grantId: "broad",
              owner,
              capability: "execution",
              source,
              now: 0,
              policy: {
                scope: "environment",
                lifetime: "until-revoked",
                remembered: true,
                deadline: null,
              },
            });
            yield* store.withPermit(store.replace([thread, broad]));
            yield* store.synchronize(
              owner,
              { ...source, revision: 2, state: "deleted" },
              "connection",
            );
            assert.deepEqual(
              store.list().map((grant) => grant.grantId),
              ["broad"],
            );
            assert.isUndefined(store.select(owner, "execution"));
            const fs = yield* FileSystem.FileSystem;
            const saved = yield* fs.readFileString(yield* file).pipe(Effect.flatMap(decode));
            assert.deepEqual(
              saved.grants.map((grant) => grant.grantId),
              ["broad"],
            );
          }),
        ),
      ),
  );
});

it.effect(
  "withholds cached authority during feed failure and reconciles without extending the same revision",
  () =>
    withDesktop(
      open(
        Effect.gen(function* () {
          const store = yield* DesktopGrants.DesktopGrants;
          const grant = approveGrant({
            grantId: "feed-grant",
            owner,
            capability: "execution",
            source,
            now: 0,
            policy: { scope: "thread", lifetime: "automatic", remembered: true, deadline: null },
          });
          store.connect(owner.environmentId, "generation");
          yield* store.withPermit(store.replace([grant]));
          yield* store.synchronize(owner, source, "generation");
          assert.isDefined(store.select(owner, "execution"));
          const before = store.list()[0]!.expiresAt;
          store.invalidate(owner.environmentId, "generation", [owner.threadId]);
          assert.isUndefined(store.select(owner, "execution"));
          assert.lengthOf(store.list(), 1);
          yield* TestClock.adjust("1 minute");
          yield* store.synchronize(owner, { ...source, serverNow: iso(60_000) }, "generation");
          assert.isDefined(store.select(owner, "execution"));
          assert.equal(store.list()[0]!.expiresAt, before);
          store.invalidate(owner.environmentId, "retired-generation");
          assert.isDefined(store.select(owner, "execution"));
        }),
      ),
    ),
);

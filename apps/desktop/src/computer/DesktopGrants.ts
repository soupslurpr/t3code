/** Owns the current capability records; expiry removes authority, never accepted work. */
import {
  DesktopCapabilityGrant,
  DesktopGrantScope,
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  type DesktopGrantCapability,
  type DesktopThreadLifecycle,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";
import {
  DesktopGrantError,
  grantExpired,
  grantKey,
  migrateGrant,
  reconcileGrant,
  selectGrant,
  type GrantOwner,
} from "./DesktopGrantPolicy.ts";

const LegacyDocument = Schema.Struct({
  version: Schema.Literal(1),
  grants: Schema.Array(
    Schema.Struct({
      grantId: Schema.String,
      scope: DesktopGrantScope,
      environmentId: Schema.NullOr(EnvironmentId),
      threadId: Schema.NullOr(ThreadId),
      remembered: Schema.Boolean,
      expiresAt: Schema.NullOr(IsoDateTime),
    }),
  ),
});
const GrantsDocument = Schema.Struct({
  version: Schema.Literal(2),
  desktopId: Schema.String,
  lastObservedAt: IsoDateTime,
  migratedAt: Schema.NullOr(IsoDateTime),
  grants: Schema.Array(DesktopCapabilityGrant),
});
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([LegacyDocument, GrantsDocument])),
);
const encode = Schema.encodeEffect(Schema.fromJsonString(GrantsDocument));
const ownerKey = (owner: GrantOwner) => JSON.stringify([owner.environmentId, owner.threadId]);

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);
  const references = new Map<string, GrantOwner>();
  const file = environment.path.join(environment.stateDir, "desktop-execution-grants.json");
  const initialWall = clock.currentTimeMillisUnsafe();
  const initialNanos = clock.monotonicTimeNanosUnsafe();
  let lastNow = initialWall;
  const now = () =>
    (lastNow = Math.max(
      lastNow,
      clock.currentTimeMillisUnsafe(),
      initialWall + Number(clock.monotonicTimeNanosUnsafe() - initialNanos) / 1_000_000,
    ));
  let grants: ReadonlyArray<DesktopCapabilityGrant> = [];
  let migratedAt: string | null = null;
  let loadError: DesktopGrantError | null = null;
  let changed = yield* Deferred.make<void>();
  // Reconciliation is connection-local. Saved authority is not usable merely because it decoded.
  const sources = new Map<string, { generation: string; snapshot: DesktopThreadLifecycle }>();
  const connections = new Map<string, string>();
  const retired = new Set<string>();
  const disconnect = (environmentId: string, generation: string) => {
    if (connections.get(environmentId) !== generation) return;
    connections.delete(environmentId);
    retired.add(generation);
    for (const [key, source] of sources)
      if (source.snapshot.environmentId === environmentId) sources.delete(key);
    PubSub.publishUnsafe(changes, undefined);
  };
  const connect = (environmentId: string, generation: string) => {
    if (retired.has(generation)) return false;
    const previous = connections.get(environmentId);
    if (previous !== undefined && previous !== generation) disconnect(environmentId, previous);
    connections.set(environmentId, generation);
    return true;
  };

  const replace = Effect.fn("DesktopGrants.replace")(
    function* (next: ReadonlyArray<DesktopCapabilityGrant>) {
      const encoded = yield* encode({
        version: 2,
        desktopId: identity.registration.desktopId,
        lastObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now())),
        migratedAt,
        grants: next.filter((grant) => grant.remembered),
      });
      const temporary = `${file}.${yield* crypto.randomUUIDv4()}.tmp`;
      yield* fs.makeDirectory(environment.stateDir, { recursive: true });
      yield* fs.writeFileString(temporary, encoded, { mode: 0o600 }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            yield* fs.rename(temporary, file);
            grants = next;
            const previous = changed;
            changed = yield* Deferred.make<void>();
            yield* Deferred.succeed(previous, undefined);
            yield* PubSub.publish(changes, undefined);
          }).pipe(Effect.uninterruptible),
        ),
        // Once renamed, disk and memory must agree even if the caller is interrupted.
        Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
      );
    },
    Effect.mapError((cause) => new DesktopGrantError("grant-storage-failed", String(cause))),
  );

  if (yield* fs.exists(file)) {
    const result = yield* fs.readFileString(file).pipe(Effect.flatMap(decode), Effect.result);
    if (result._tag === "Failure")
      loadError = new DesktopGrantError(
        "grant-storage-failed",
        "Saved desktop permissions could not be read. No saved access has been enabled.",
      );
    else {
      const document = result.success;
      const time = now();
      if (document.version === 2 && document.desktopId !== identity.registration.desktopId)
        loadError = new DesktopGrantError(
          "desktop-target-mismatch",
          "Saved permissions belong to another desktop.",
        );
      else {
        migratedAt =
          document.version === 1
            ? DateTime.formatIso(DateTime.makeUnsafe(time))
            : document.migratedAt;
        const clockRegressed = document.version === 2 && Date.parse(document.lastObservedAt) > time;
        const retained =
          document.version === 1
            ? document.grants.flatMap((grant) => {
                const migrated = migrateGrant(grant, time);
                return migrated === null ? [] : [migrated];
              })
            : document.grants.filter(
                (grant) =>
                  grant.remembered &&
                  !grantExpired(grant, time) &&
                  !(clockRegressed && grant.expiresAt !== null),
              );
        const unique = new Map<string, DesktopCapabilityGrant>();
        for (const grant of [...retained].sort((a, b) => a.grantId.localeCompare(b.grantId))) {
          if (!unique.has(grantKey(grant))) unique.set(grantKey(grant), grant);
        }
        // Always persist startup pruning/migration before exposing a single record.
        const persisted = yield* replace([...unique.values()]).pipe(Effect.result);
        if (persisted._tag === "Failure") loadError = persisted.failure;
      }
    }
  }

  const checkStorage = Effect.suspend(() =>
    loadError === null ? Effect.void : Effect.fail(loadError),
  );
  const prune = Effect.gen(function* () {
    yield* checkStorage;
    const next = grants.filter((grant) => !grantExpired(grant, now()));
    if (next.length !== grants.length) yield* replace(next);
  });

  const synchronize = Effect.fn("DesktopGrants.synchronize")(function* (
    owner: GrantOwner,
    snapshot: DesktopThreadLifecycle,
    generation: string,
  ) {
    if (snapshot.environmentId !== owner.environmentId || snapshot.threadId !== owner.threadId)
      return yield* Effect.fail(
        new DesktopGrantError("invalid-context", "Thread lifecycle does not match its source."),
      );
    yield* lock.withPermit(
      Effect.gen(function* () {
        yield* prune;
        if (
          retired.has(generation) ||
          (connections.has(owner.environmentId) &&
            connections.get(owner.environmentId) !== generation)
        )
          return yield* Effect.fail(
            new DesktopGrantError(
              "connection-changed",
              "The desktop source connection was replaced.",
            ),
          );
        connections.set(owner.environmentId, generation);
        const key = ownerKey(owner);
        const prior = sources.get(key);
        const reconnect = prior === undefined || prior.generation !== generation;
        if (!reconnect && prior.snapshot.revision > snapshot.revision) return;
        const next = grants.flatMap((grant) => {
          const reconciled = reconcileGrant(grant, snapshot, now(), reconnect);
          return reconciled === null ? [] : [reconciled];
        });
        if (next.length !== grants.length || next.some((grant, i) => grant !== grants[i]))
          yield* replace(next);
        sources.set(key, { generation, snapshot });
        yield* PubSub.publish(changes, undefined);
      }),
    );
  });

  const select = (owner: GrantOwner, capability: DesktopGrantCapability, requireSource = true) => {
    if (loadError !== null) return undefined;
    const source = sources.get(ownerKey(owner));
    if ((source === undefined && requireSource) || source?.snapshot.state === "deleted")
      return undefined;
    return selectGrant(grants, owner, capability, now());
  };

  yield* Effect.gen(function* () {
    while (true) {
      const wake = changed;
      const deadlines = grants.flatMap((grant) =>
        grant.expiresAt === null ? [] : [Date.parse(grant.expiresAt)],
      );
      if (deadlines.length === 0 || loadError !== null) yield* Deferred.await(wake);
      else {
        yield* Deferred.await(wake).pipe(
          Effect.timeoutOrElse({
            duration: Math.max(1, Math.min(60_000, Math.min(...deadlines) - now())),
            orElse: () => Effect.void,
          }),
        );
        yield* lock
          .withPermit(prune)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Desktop permission cleanup failed", error).pipe(
                Effect.andThen(Effect.sleep(60_000)),
              ),
            ),
          );
      }
    }
  }).pipe(Effect.forkScoped);

  return {
    now,
    list: () => grants.filter((grant) => !grantExpired(grant, now())),
    select,
    source: (owner: GrantOwner) => sources.get(ownerKey(owner))?.snapshot,
    generation: (environmentId: string) => connections.get(environmentId),
    synchronize,
    connect,
    disconnect,
    invalidate: (environmentId: string, generation: string, threadIds?: ReadonlyArray<string>) => {
      if (connections.get(environmentId) !== generation) return;
      for (const [key, source] of sources)
        if (
          source.snapshot.environmentId === environmentId &&
          (threadIds === undefined || threadIds.includes(source.snapshot.threadId))
        )
          sources.delete(key);
      PubSub.publishUnsafe(changes, undefined);
    },
    references: (environmentId: string) => [
      ...new Set([
        ...grants.flatMap((grant) =>
          grant.environmentId === environmentId && grant.threadId !== null ? [grant.threadId] : [],
        ),
        ...[...references.values()]
          .filter((owner) => owner.environmentId === environmentId)
          .map((owner) => ThreadId.make(owner.threadId)),
      ]),
    ],
    prune: lock.withPermit(prune),
    checkStorage,
    /** Call replace and accept work inside this permit; never hold it across a process wait. */
    withPermit: lock.withPermit,
    replace,
    changes: Stream.fromPubSub(changes),
    retain: (key: string, owner: GrantOwner) => {
      references.set(key, owner);
    },
    releaseReference: (key: string) => {
      references.delete(key);
    },
  };
});

export class DesktopGrants extends Context.Service<DesktopGrants, Effect.Success<typeof make>>()(
  "@t3tools/desktop/computer/DesktopGrants",
) {}
export const layer = Layer.effect(DesktopGrants, make);

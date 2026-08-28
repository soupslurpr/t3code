import {
  IsoDateTime,
  UserDesktopAuditEvent,
  type UserDesktopAuditLog,
  UserDesktopCapability,
  UserDesktopHostRegistration,
  UserDesktopId,
  UserDesktopLabel,
  UserDesktopPlatform,
  type UserDesktopRenameInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type UserDesktopRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/** Supplies one successful metadata-only access transition for durable recording. */
export type UserDesktopAuditWrite = Omit<UserDesktopAuditEvent, "sequence">;

/** Stores one durable user desktop independently of its live connection. */
export const UserDesktopRecord = Schema.Struct({
  desktopId: UserDesktopId,
  defaultLabel: UserDesktopLabel,
  customLabel: Schema.NullOr(UserDesktopLabel),
  platform: UserDesktopPlatform,
  capabilities: Schema.Array(UserDesktopCapability).check(Schema.isMaxLength(3)),
  lastSeenAt: IsoDateTime,
  lastActiveAt: Schema.NullOr(IsoDateTime),
});
export type UserDesktopRecord = typeof UserDesktopRecord.Type;

const UserDesktopDbRow = UserDesktopRecord.mapFields(
  Struct.assign({
    capabilities: Schema.fromJsonString(
      Schema.Array(UserDesktopCapability).check(Schema.isMaxLength(3)),
    ),
  }),
);

const RawUserDesktopDbRow = Schema.Struct({
  desktopId: Schema.Unknown,
  defaultLabel: Schema.Unknown,
  customLabel: Schema.Unknown,
  platform: Schema.Unknown,
  capabilities: Schema.Unknown,
  lastSeenAt: Schema.Unknown,
  lastActiveAt: Schema.Unknown,
});

const decodeRow = Schema.decodeUnknownEffect(UserDesktopDbRow);

/** Persists and queries the user-desktop inventory for one environment. */
export class UserDesktopRepository extends Context.Service<
  UserDesktopRepository,
  {
    readonly upsertHost: (
      host: UserDesktopHostRegistration,
      lastSeenAt: IsoDateTime,
    ) => Effect.Effect<void, UserDesktopRepositoryError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<UserDesktopRecord>,
      UserDesktopRepositoryError
    >;
    readonly rename: (
      input: UserDesktopRenameInput,
    ) => Effect.Effect<void, UserDesktopRepositoryError>;
    readonly remove: (desktopId: UserDesktopId) => Effect.Effect<void, UserDesktopRepositoryError>;
    readonly markActive: (
      desktopId: UserDesktopId,
      lastActiveAt: IsoDateTime,
    ) => Effect.Effect<void, UserDesktopRepositoryError>;
    readonly recordAudit: (
      event: UserDesktopAuditWrite,
    ) => Effect.Effect<void, UserDesktopRepositoryError>;
    readonly listAudit: (
      desktopId: UserDesktopId,
    ) => Effect.Effect<UserDesktopAuditLog, UserDesktopRepositoryError>;
  }
>()("t3/persistence/UserDesktops/UserDesktopRepository") {}

/** Maps SQL and schema failures without exposing raw database values. */
function repositoryError(operation: string) {
  return (cause: unknown): UserDesktopRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:decode`, cause)
      : new PersistenceSqlError({ operation, cause });
}

/** Creates the SQL-backed user-desktop repository. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const writeHost = SqlSchema.void({
    Request: UserDesktopDbRow,
    execute: (host) => sql`
      INSERT INTO user_desktops (
        desktop_id,
        default_label,
        custom_label,
        platform,
        capabilities_json,
        last_seen_at,
        last_active_at
      )
      VALUES (
        ${host.desktopId},
        ${host.defaultLabel},
        ${host.customLabel},
        ${host.platform},
        ${host.capabilities},
        ${host.lastSeenAt},
        ${host.lastActiveAt}
      )
      ON CONFLICT (desktop_id)
      DO UPDATE SET
        default_label = excluded.default_label,
        platform = excluded.platform,
        capabilities_json = excluded.capabilities_json,
        last_seen_at = excluded.last_seen_at
    `,
  });

  const readRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RawUserDesktopDbRow,
    execute: () => sql`
      SELECT
        desktop_id AS "desktopId",
        default_label AS "defaultLabel",
        custom_label AS "customLabel",
        platform,
        capabilities_json AS "capabilities",
        last_seen_at AS "lastSeenAt",
        last_active_at AS "lastActiveAt"
      FROM user_desktops
      ORDER BY last_seen_at DESC, desktop_id ASC
    `,
  });

  const renameRow = SqlSchema.void({
    Request: Schema.Struct({ desktopId: UserDesktopId, label: UserDesktopLabel }),
    execute: ({ desktopId, label }) => sql`
      UPDATE user_desktops
      SET custom_label = ${label}
      WHERE desktop_id = ${desktopId}
    `,
  });

  const removeRow = SqlSchema.void({
    Request: Schema.Struct({ desktopId: UserDesktopId }),
    execute: ({ desktopId }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM user_desktop_access_audit
            WHERE desktop_id = ${desktopId}
          `;
          yield* sql`
            DELETE FROM user_desktops
            WHERE desktop_id = ${desktopId}
          `;
        }),
      ),
  });

  const markActiveRow = SqlSchema.void({
    Request: Schema.Struct({ desktopId: UserDesktopId, lastActiveAt: IsoDateTime }),
    execute: ({ desktopId, lastActiveAt }) => sql`
      UPDATE user_desktops
      SET last_active_at = ${lastActiveAt}
      WHERE desktop_id = ${desktopId}
    `,
  });

  const writeAudit = SqlSchema.void({
    Request: Schema.Struct({
      desktopId: UserDesktopAuditEvent.fields.desktopId,
      occurredAt: UserDesktopAuditEvent.fields.occurredAt,
      actorKind: UserDesktopAuditEvent.fields.actorKind,
      action: UserDesktopAuditEvent.fields.action,
      threadId: UserDesktopAuditEvent.fields.threadId,
      actorLabel: UserDesktopAuditEvent.fields.actorLabel,
      takeover: UserDesktopAuditEvent.fields.takeover,
    }),
    execute: (event) => sql`
      INSERT INTO user_desktop_access_audit (
        desktop_id,
        occurred_at,
        actor_kind,
        action,
        thread_id,
        actor_label,
        takeover
      )
      VALUES (
        ${event.desktopId},
        ${event.occurredAt},
        ${event.actorKind},
        ${event.action},
        ${event.threadId ?? null},
        ${event.actorLabel ?? null},
        ${event.takeover ? 1 : 0}
      )
    `,
  });

  const RawAuditDbRow = Schema.Struct({
    sequence: Schema.Unknown,
    desktopId: Schema.Unknown,
    occurredAt: Schema.Unknown,
    actorKind: Schema.Unknown,
    action: Schema.Unknown,
    threadId: Schema.Unknown,
    actorLabel: Schema.Unknown,
    takeover: Schema.Unknown,
  });
  const readAuditRows = SqlSchema.findAll({
    Request: Schema.Struct({ desktopId: UserDesktopId }),
    Result: RawAuditDbRow,
    execute: ({ desktopId }) => sql`
      SELECT
        sequence,
        desktop_id AS "desktopId",
        occurred_at AS "occurredAt",
        actor_kind AS "actorKind",
        action,
        thread_id AS "threadId",
        actor_label AS "actorLabel",
        takeover
      FROM user_desktop_access_audit
      WHERE desktop_id = ${desktopId}
      ORDER BY sequence DESC
      LIMIT 50
    `,
  });
  const decodeAuditRow = (row: typeof RawAuditDbRow.Type) => {
    const { threadId, actorLabel, ...event } = row;
    return Schema.decodeUnknownEffect(UserDesktopAuditEvent)({
      ...event,
      takeover: event.takeover === 1,
      ...(threadId === null ? {} : { threadId }),
      ...(actorLabel === null ? {} : { actorLabel }),
    });
  };

  return UserDesktopRepository.of({
    upsertHost: (host, lastSeenAt) =>
      writeHost({ ...host, customLabel: null, lastSeenAt, lastActiveAt: null }).pipe(
        Effect.mapError(repositoryError("UserDesktopRepository.upsertHost")),
      ),
    list: () =>
      readRows(undefined).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(row))),
        Effect.mapError(repositoryError("UserDesktopRepository.list")),
      ),
    rename: (input) =>
      renameRow(input).pipe(Effect.mapError(repositoryError("UserDesktopRepository.rename"))),
    remove: (desktopId) =>
      removeRow({ desktopId }).pipe(
        Effect.mapError(repositoryError("UserDesktopRepository.remove")),
      ),
    markActive: (desktopId, lastActiveAt) =>
      markActiveRow({ desktopId, lastActiveAt }).pipe(
        Effect.mapError(repositoryError("UserDesktopRepository.markActive")),
      ),
    recordAudit: (event) =>
      writeAudit(event).pipe(Effect.mapError(repositoryError("UserDesktopRepository.recordAudit"))),
    listAudit: (desktopId) =>
      readAuditRows({ desktopId }).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, decodeAuditRow)),
        Effect.map((events) => ({ events })),
        Effect.mapError(repositoryError("UserDesktopRepository.listAudit")),
      ),
  });
});

export const layer = Layer.effect(UserDesktopRepository, make);

/** Creates an isolated in-memory inventory for focused tests and tools. */
export const makeMemory = Effect.gen(function* () {
  const records = yield* SynchronizedRef.make(new Map<UserDesktopId, UserDesktopRecord>());
  const audit = yield* SynchronizedRef.make({
    sequence: 0,
    events: [] as Array<UserDesktopAuditEvent>,
  });

  return UserDesktopRepository.of({
    upsertHost: (host, lastSeenAt) =>
      SynchronizedRef.update(records, (current) => {
        const next = new Map(current);
        const prior = next.get(host.desktopId);
        next.set(host.desktopId, {
          desktopId: host.desktopId,
          defaultLabel: host.defaultLabel,
          customLabel: prior?.customLabel ?? null,
          platform: host.platform,
          capabilities: host.capabilities,
          lastSeenAt,
          lastActiveAt: prior?.lastActiveAt ?? null,
        });
        return next;
      }),
    list: () =>
      SynchronizedRef.get(records).pipe(Effect.map((current) => Array.from(current.values()))),
    rename: ({ desktopId, label }) =>
      SynchronizedRef.update(records, (current) => {
        const prior = current.get(desktopId);
        if (prior === undefined) return current;
        const next = new Map(current);
        next.set(desktopId, { ...prior, customLabel: label });
        return next;
      }),
    remove: (desktopId) =>
      Effect.all(
        [
          SynchronizedRef.update(records, (current) => {
            if (!current.has(desktopId)) return current;
            const next = new Map(current);
            next.delete(desktopId);
            return next;
          }),
          SynchronizedRef.update(audit, (current) => ({
            ...current,
            events: current.events.filter((event) => event.desktopId !== desktopId),
          })),
        ],
        { discard: true },
      ),
    markActive: (desktopId, lastActiveAt) =>
      SynchronizedRef.update(records, (current) => {
        const prior = current.get(desktopId);
        if (prior === undefined) return current;
        const next = new Map(current);
        next.set(desktopId, { ...prior, lastActiveAt });
        return next;
      }),
    recordAudit: (event) =>
      SynchronizedRef.update(audit, (current) => {
        const sequence = current.sequence + 1;
        return { sequence, events: [...current.events, { ...event, sequence }] };
      }),
    listAudit: (desktopId) =>
      SynchronizedRef.get(audit).pipe(
        Effect.map((current) => ({
          events: current.events
            .filter((event) => event.desktopId === desktopId)
            .toReversed()
            .slice(0, 50),
        })),
      ),
  });
});

export const layerMemory = Layer.effect(UserDesktopRepository, makeMemory);

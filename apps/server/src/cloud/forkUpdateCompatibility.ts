// @effect-diagnostics nodeBuiltinImport:off - shared with the standalone launcher, without Effect.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import { FORK_UPDATE_BLOCK_REASON, forkBuildUpdateBlockReason } from "@t3tools/shared/forkUpdates";
import {
  isPreviewHistory,
  migrationManifest,
  releasedForkMigrationNames,
} from "../persistence/MigrationIdentities.ts";

const UNKNOWN_HISTORY_REASON =
  "Cannot confirm this installation's exact migration history. No update was started. Inspect the database read-only and use the build that owns its history.";

// A target's version, channel, sentinel, or self-reported preflight cannot authenticate it.
export function forkUpdateBlockReason(databasePaths: ReadonlyArray<string>): string | undefined {
  const buildReason = forkBuildUpdateBlockReason();
  if (buildReason !== undefined) return buildReason;
  for (const databasePath of databasePaths) {
    const reason = historyBlockReason(databasePath);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function historyBlockReason(databasePath: string): string | undefined {
  try {
    NodeFS.lstatSync(databasePath);
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? undefined
      : UNKNOWN_HISTORY_REASON;
  }
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    if (tables.has("effect_sql_fork_migrations")) return FORK_UPDATE_BLOCK_REASON;
    if (!tables.has("effect_sql_migrations")) return undefined;
    const rows = db
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    const identities = rows.flatMap((row) =>
      typeof row.migration_id === "number" &&
      Number.isSafeInteger(row.migration_id) &&
      typeof row.name === "string" &&
      row.name.length > 0
        ? [{ migration_id: row.migration_id, name: row.name }]
        : [],
    );
    if (identities.length !== rows.length) return UNKNOWN_HISTORY_REASON;
    if (identities.some((row) => releasedForkMigrationNames.some((name) => name === row.name)))
      return FORK_UPDATE_BLOCK_REASON;
    const preview = isPreviewHistory(identities);
    const ordinary = preview ? identities.filter((row) => row.migration_id < 53) : identities;
    if (preview && ordinary.length !== 52) return UNKNOWN_HISTORY_REASON;
    for (const [index, row] of ordinary.entries()) {
      const known = migrationManifest[index];
      // A retained upstream launcher must accept migrations added by its newer target.
      if (row.migration_id !== index + 1 || (known !== undefined && row.name !== known[1]))
        return UNKNOWN_HISTORY_REASON;
    }
    return undefined;
  } catch {
    return UNKNOWN_HISTORY_REASON;
  } finally {
    try {
      db?.close();
    } catch {
      // The read-only handle has no writes to flush.
    }
  }
}

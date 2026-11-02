import { migrationManifest, upstreamMigrationIdentities } from "./MigrationIdentities.ts";
export { migrationManifest } from "./MigrationIdentities.ts";
import ForkMigration0007 from "./Migrations/061_ProjectionThreadMessageSystemEvents.ts";
import ForkMigration0006 from "./Migrations/060_ComputerMonitorImageEncoding.ts";
import ForkMigration0005 from "./Migrations/059_AdaptiveComputerMonitors.ts";
import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { adoptForkMigrationHistory } from "./ForkMigrationHistory.ts";
import ForkMigration0004 from "./Migrations/058_ComputerMonitorEvaluationThrottle.ts";
import ForkMigration0003 from "./Migrations/057_ComputerThreadMonitors.ts";
import ForkMigration0002 from "./Migrations/056_ThreadMonitorDelivery.ts";
import ForkMigration0001 from "./Migrations/055_ThreadMonitors.ts";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0055 from "./Migrations/055_OrchestrationV2.ts";
import Migration0056 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Migration0057 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0058 from "./Migrations/058_WebhookRelayDeliveries.ts";
import Migration0059 from "./Migrations/059_McpAppModelContext.ts";
import Migration0060 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import Migration0061 from "./Migrations/061_PullRequestReviewGuides.ts";
import Migration0062 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import Migration0063 from "./Migrations/063_DropUnusedV1Projections.ts";
import Migration0064 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
import Migration0065 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import Migration0066 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import Migration0067 from "./Migrations/067_WebhookDedupe.ts";
import Migration0068 from "./Migrations/068_ShellStopRequestIndex.ts";
import Migration0069 from "./Migrations/069_ThreadMessageSearch.ts";
import Migration0070 from "./Migrations/070_PeerLinks.ts";
import Migration0071 from "./Migrations/071_PeerLinkFence.ts";
import Migration0072 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import Migration0073 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import Migration0074 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import Migration0075 from "./Migrations/075_SubagentDeliveryState.ts";
import Migration0076 from "./Migrations/076_ProjectionProjectsPinArchive.ts";

import ComputerMonitorCacheWriteUsageMigration from "./Migrations/062_ComputerMonitorCacheWriteUsage.ts";

import UserDesktopsMigration from "./Migrations/063_UserDesktops.ts";

const migrationEntries = [
  [...upstreamMigrationIdentities[0], Migration0001],
  [...upstreamMigrationIdentities[1], Migration0002],
  [...upstreamMigrationIdentities[2], Migration0003],
  [...upstreamMigrationIdentities[3], Migration0004],
  [...upstreamMigrationIdentities[4], Migration0005],
  [...upstreamMigrationIdentities[5], Migration0006],
  [...upstreamMigrationIdentities[6], Migration0007],
  [...upstreamMigrationIdentities[7], Migration0008],
  [...upstreamMigrationIdentities[8], Migration0009],
  [...upstreamMigrationIdentities[9], Migration0010],
  [...upstreamMigrationIdentities[10], Migration0011],
  [...upstreamMigrationIdentities[11], Migration0012],
  [...upstreamMigrationIdentities[12], Migration0013],
  [...upstreamMigrationIdentities[13], Migration0014],
  [...upstreamMigrationIdentities[14], Migration0015],
  [...upstreamMigrationIdentities[15], Migration0016],
  [...upstreamMigrationIdentities[16], Migration0017],
  [...upstreamMigrationIdentities[17], Migration0018],
  [...upstreamMigrationIdentities[18], Migration0019],
  [...upstreamMigrationIdentities[19], Migration0020],
  [...upstreamMigrationIdentities[20], Migration0021],
  [...upstreamMigrationIdentities[21], Migration0022],
  [...upstreamMigrationIdentities[22], Migration0023],
  [...upstreamMigrationIdentities[23], Migration0024],
  [...upstreamMigrationIdentities[24], Migration0025],
  [...upstreamMigrationIdentities[25], Migration0026],
  [...upstreamMigrationIdentities[26], Migration0027],
  [...upstreamMigrationIdentities[27], Migration0028],
  [...upstreamMigrationIdentities[28], Migration0029],
  [...upstreamMigrationIdentities[29], Migration0030],
  [...upstreamMigrationIdentities[30], Migration0031],
  [...upstreamMigrationIdentities[31], Migration0032],
  [...upstreamMigrationIdentities[32], Migration0033],
  [...upstreamMigrationIdentities[33], Migration0034],
  [...upstreamMigrationIdentities[34], Migration0035],
  [...upstreamMigrationIdentities[35], Migration0036],
  [...upstreamMigrationIdentities[36], Migration0037],
  [...upstreamMigrationIdentities[37], Migration0038],
  [...upstreamMigrationIdentities[38], Migration0039],
  [...upstreamMigrationIdentities[39], Migration0040],
  [...upstreamMigrationIdentities[40], Migration0041],
  [...upstreamMigrationIdentities[41], Migration0042],
  [...upstreamMigrationIdentities[42], Migration0043],
  [...upstreamMigrationIdentities[43], Migration0044],
  [...upstreamMigrationIdentities[44], Migration0045],
  [...upstreamMigrationIdentities[45], Migration0046],
  [...upstreamMigrationIdentities[46], Migration0047],
  [...upstreamMigrationIdentities[47], Migration0048],
  [...upstreamMigrationIdentities[48], Migration0049],
  [...upstreamMigrationIdentities[49], Migration0050],
  [...upstreamMigrationIdentities[50], Migration0051],
  [...upstreamMigrationIdentities[51], Migration0052],
  [...upstreamMigrationIdentities[52], Migration0053],
  [...upstreamMigrationIdentities[53], Migration0054],
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [...upstreamMigrationIdentities[54], Migration0055],
  [...upstreamMigrationIdentities[55], Migration0056],
  [...upstreamMigrationIdentities[56], Migration0057],
  [...upstreamMigrationIdentities[57], Migration0058],
  [...upstreamMigrationIdentities[58], Migration0059],
  [...upstreamMigrationIdentities[59], Migration0060],
  [...upstreamMigrationIdentities[60], Migration0061],
  [...upstreamMigrationIdentities[61], Migration0062],
  [...upstreamMigrationIdentities[62], Migration0063],
  [...upstreamMigrationIdentities[63], Migration0064],
  [...upstreamMigrationIdentities[64], Migration0065],
  [...upstreamMigrationIdentities[65], Migration0066],
  [...upstreamMigrationIdentities[66], Migration0067],
  [...upstreamMigrationIdentities[67], Migration0068],
  [...upstreamMigrationIdentities[68], Migration0069],
  [...upstreamMigrationIdentities[69], Migration0070],
  [...upstreamMigrationIdentities[70], Migration0071],
  [...upstreamMigrationIdentities[71], Migration0072],
  [...upstreamMigrationIdentities[72], Migration0073],
  [...upstreamMigrationIdentities[73], Migration0074],
  [...upstreamMigrationIdentities[74], Migration0075],
  [...upstreamMigrationIdentities[75], Migration0076],
] as const;

export const forkMigrationEntries = [
  [1, "ThreadMonitors", ForkMigration0001],
  [2, "ThreadMonitorDelivery", ForkMigration0002],
  [3, "ComputerThreadMonitors", ForkMigration0003],
  [4, "ComputerMonitorEvaluationThrottle", ForkMigration0004],
  [5, "AdaptiveComputerMonitors", ForkMigration0005],
  [6, "ComputerMonitorImageEncoding", ForkMigration0006],
  [7, "ProjectionThreadMessageSystemEvents", ForkMigration0007],
  [8, "ComputerMonitorCacheWriteUsage", ComputerMonitorCacheWriteUsageMigration],
  [9, "UserDesktops", UserDesktopsMigration],
] as const;
export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (
  entries: ReadonlyArray<(typeof migrationEntries)[number] | (typeof forkMigrationEntries)[number]>,
  throughId?: number,
) =>
  Migrator.fromRecord(
    Object.fromEntries(
      entries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const FIRST_V2_MIGRATION_ID = 55;

// Migrators skip ids up to the highest recorded; reject collisions that would skip V2 schema.
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = migrationEntries.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    if (recordedName === name) return [];
    return [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

const run = Migrator.make({});

const assertMigrationsCompleted = Effect.fn("assertMigrationsCompleted")(function* (
  table: "effect_sql_migrations" | "effect_sql_fork_migrations",
  manifest: ReadonlyArray<readonly [number, string]>,
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(table)}`;
  const names = new Map(rows.map((row) => [row.migration_id, row.name]));
  const missing = manifest.filter(
    ([id, name]) => (throughId === undefined || id <= throughId) && names.get(id) !== name,
  );
  if (missing.length > 0) {
    // Migrator treats insert constraints as another runner's lock and can return no work.
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `${table} did not complete: ${missing.map(([id, name]) => `${id}_${name}`).join(", ")}`,
    });
  }
});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
  readonly toForkMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
  toForkMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  const sql = yield* SqlClient.SqlClient;
  const executedMigrations = yield* sql.withTransaction(
    Effect.gen(function* () {
      const adoption = yield* adoptForkMigrationHistory(migrationManifest);
      const previewRepairs: Array<readonly [number, string]> = [];
      if (includesV2 && adoption.previewMissingFilesViewed) {
        // Preview 54 also admits a missing 53; fill it before highest-ID skipping can hide it.
        yield* Migration0053;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')`;
        previewRepairs.push([53, "PullRequestFilesViewed"]);
      }
      const previewMigrations = includesV2 ? yield* reconcileV2PreviewMigration() : [];
      if (includesV2) yield* assertV2MigrationsCanRun(toMigrationInclusive);
      const upstream = yield* run({
        loader: makeMigrationLoader(migrationEntries, toMigrationInclusive),
      });
      yield* assertMigrationsCompleted(
        "effect_sql_migrations",
        migrationManifest,
        toMigrationInclusive,
      );
      const fork =
        toMigrationInclusive === undefined || toForkMigrationInclusive !== undefined
          ? yield* run({
              table: "effect_sql_fork_migrations",
              loader: makeMigrationLoader(forkMigrationEntries, toForkMigrationInclusive),
            })
          : [];
      if (toMigrationInclusive === undefined || toForkMigrationInclusive !== undefined) {
        yield* assertMigrationsCompleted(
          "effect_sql_fork_migrations",
          forkMigrationManifest,
          toForkMigrationInclusive,
        );
      }
      return [...previewRepairs, ...previewMigrations, ...upstream, ...fork];
    }),
  );
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

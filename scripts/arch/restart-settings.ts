// @effect-diagnostics nodeBuiltinImport:off - The worker reads the installed server's files without starting services.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import {
  isRuntimeModeAbove,
  ManagedPolicyDocument,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  RuntimeMode,
  ServerSettings,
} from "@t3tools/contracts";
import { managedPolicyPath } from "@t3tools/shared/managedPolicyFile";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";
import { restartPolicy, type RestartPolicy } from "./restart-policy.js";

function readOptional(path: string): string | undefined {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const decodePolicy = Schema.decodeUnknownSync(Schema.fromJsonString(ManagedPolicyDocument), {
  onExcessProperty: "error",
});
const parseSettings = Schema.decodeUnknownSync(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);
const decodeLegacyFields = Schema.decodeUnknownSync(
  Schema.Struct({
    providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    bitbucket: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    github: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);

function normalizeStreamingMode(value: unknown): unknown {
  return typeof value === "object" &&
    value !== null &&
    "responseStreamingMode" in value &&
    value.responseStreamingMode === "token"
    ? { ...value, responseStreamingMode: "paragraph" }
    : value;
}

// Older files used providers by driver. The server restores these three formerly enabled drivers
// from V1 session history while importing those files.
function restoreLegacyInstance(
  db: NodeSqlite.DatabaseSync,
  settings: ServerSettings,
  legacy: Readonly<Record<string, unknown>> | undefined,
  instanceId: string,
  driver: string,
): ServerSettings {
  if (legacy === undefined) return settings;
  const id = ProviderInstanceId.make(instanceId);
  const existing = settings.providerInstances[id];
  let enabled: boolean | undefined;
  const blob = legacy[driver];
  if (
    existing === undefined &&
    instanceId === driver &&
    typeof blob === "object" &&
    blob !== null &&
    !Array.isArray(blob) &&
    "enabled" in blob &&
    typeof blob.enabled === "boolean"
  ) {
    enabled = blob.enabled;
  }
  if (
    enabled === undefined &&
    existing?.enabled === undefined &&
    ["cursor", "grok", "opencode"].includes(driver) &&
    (existing !== undefined || instanceId === driver)
  ) {
    const prior = db.prepare(`SELECT 1 FROM (
        SELECT provider_name, provider_instance_id FROM projection_thread_sessions
        UNION ALL SELECT provider_name, provider_instance_id FROM provider_session_runtime
      ) WHERE provider_name = ? AND (? IS NULL OR COALESCE(provider_instance_id,provider_name) = ?) LIMIT 1`);
    if (prior.get(driver, existing === undefined ? null : instanceId, instanceId)) enabled = true;
  }
  return enabled === undefined
    ? settings
    : {
        ...settings,
        providerInstances: {
          ...settings.providerInstances,
          [id]: { ...(existing ?? { driver: ProviderDriverKind.make(driver) }), enabled },
        },
      };
}

function readSettings(
  db: NodeSqlite.DatabaseSync,
  directory: string,
  managed: RestartPolicy,
  instanceId: string,
  driver: string,
) {
  let stored = managed.defaults;
  const raw = readOptional(NodePath.join(directory, "settings.json"));
  if (raw !== undefined) {
    let legacy: ReturnType<typeof decodeLegacyFields>["providers"];
    try {
      const fields = { ...parseSettings(raw) };
      legacy = decodeLegacyFields(fields).providers;
      const overrides = fields.projectSettingsOverrides;
      if (typeof overrides === "object" && overrides !== null && !Array.isArray(overrides)) {
        fields.projectSettingsOverrides = Object.fromEntries(
          Object.entries(overrides).map(([id, entry]) => [id, normalizeStreamingMode(entry)]),
        );
      }
      stored = decodeSettings(managed.withDefaults(normalizeStreamingMode(fields)));
    } catch {
      // The server falls back conservatively on decode failure, then overlays administrative locks.
      stored = { ...managed.defaults, continueThreadsAfterServerUpdate: false };
    }
    stored = restoreLegacyInstance(db, stored, legacy, instanceId, driver);
  }
  return managed.effective(stored);
}

export function assertRestartSettings(
  db: NodeSqlite.DatabaseSync,
  directory: string,
  thread: { projectId: string; instanceId: string; driver: string; runtimeMode: unknown },
  policyPath = managedPolicyPath("linux"),
): void {
  const rawPolicy = readOptional(policyPath);
  const policy = rawPolicy === undefined ? undefined : decodePolicy(rawPolicy);
  const managed = restartPolicy(policy);
  const settings = readSettings(db, directory, managed, thread.instanceId, thread.driver);
  const projectId = ProjectId.make(thread.projectId);
  NodeAssert.ok(
    resolveProjectSettings(settings, projectId).settings.continueThreadsAfterServerUpdate,
    "automatic restart continuation is disabled for this project",
  );
  const instanceId = ProviderInstanceId.make(thread.instanceId);
  const configured = settings.providerInstances[instanceId];
  if (configured)
    NodeAssert.equal(
      configured.driver,
      thread.driver,
      "stored provider driver changed since the run started",
    );
  const allowed = policy?.limits?.providers?.allowedDrivers;
  NodeAssert.ok(
    (allowed === undefined || allowed.some((driver) => driver === thread.driver)) &&
      resolveProjectProviderInstanceEnabled(settings, projectId, instanceId),
    "provider instance is disabled for this project",
  );
  NodeAssert.ok(
    !isRuntimeModeAbove(decodeRuntimeMode(thread.runtimeMode), policy?.limits?.maxRuntimeMode),
    "thread runtime mode exceeds the managed ceiling",
  );
}

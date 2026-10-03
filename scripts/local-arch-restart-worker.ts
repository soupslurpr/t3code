#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - This standalone host worker verifies and restarts an exact process.

/** Runs independently of the app and checkout, without provider credentials or database writes. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

export const INSTALLED_EXECUTABLE = "/opt/t3code-bin/t3code";
export const INSTALLED_ASAR = "/opt/t3code-bin/resources/app.asar";
export const SHUTDOWN_TIMEOUT_MS = 180_000;
const PROCESS_CHECK_INTERVAL_MS = 200;
const USER_UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]*\.(?:service|scope)$/;

export interface ProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
}

export type RestartContinuation =
  | {
      readonly type: "active-run";
      readonly runId: string;
      readonly attemptId: string;
      readonly providerThreadId: string;
      readonly providerSessionId: string;
      readonly providerTurnId: string;
      readonly nativeThreadId: string;
    }
  | {
      readonly type: "migration-monitor";
      readonly monitorId: string;
      readonly turnId: string;
      readonly wakeAt: string;
    };

export interface RestartPlan {
  readonly unit: string;
  readonly backendUnit?: string;
  readonly app: ProcessIdentity;
  readonly backend: ProcessIdentity;
  readonly sourceDatabasePath: string;
  readonly restartDatabasePath: string;
  readonly threadId: string;
  readonly continuation: RestartContinuation;
  readonly packageVersion: string;
  readonly gitCommit: string;
  readonly asarSha256: string;
  readonly executableSha256: string;
  readonly workingDirectory: string;
  readonly appEnvironment: Readonly<Record<string, string>>;
}

/** Reads Linux start ticks and parent identity without misparsing spaces in process names. */
export function parseProcessStat(stat: string): {
  readonly startTicks: string;
  readonly parentPid: number;
  readonly state: string;
} {
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  NodeAssert.match(fields[19] ?? "", /^\d+$/, "invalid process start ticks");
  const parentPid = Number(fields[1]);
  NodeAssert.ok(Number.isSafeInteger(parentPid) && parentPid >= 0, "invalid parent pid");
  return { startTicks: fields[19]!, parentPid, state: fields[0]! };
}

/** Captures a live installed executable's identity, accepting its pre-upgrade deleted inode. */
export function captureProcess(pid: number): ProcessIdentity {
  NodeAssert.ok(Number.isSafeInteger(pid) && pid > 1, "invalid desktop pid");
  const executable = NodeFS.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
  NodeAssert.equal(
    executable,
    INSTALLED_EXECUTABLE,
    "process is not the installed desktop executable",
  );
  const stat = parseProcessStat(NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8"));
  NodeAssert.notEqual(stat.state, "Z", "desktop process is a zombie");
  return { pid, startTicks: stat.startTicks };
}

/** Checks the captured incarnation rather than treating a recycled PID as the old process. */
export function isSameProcess(identity: ProcessIdentity): boolean {
  try {
    const stat = parseProcessStat(NodeFS.readFileSync(`/proc/${identity.pid}/stat`, "utf8"));
    return stat.startTicks === identity.startTicks && stat.state !== "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Reads one required command, surfacing failures without retrying or changing strategy. */
export function readCommand(command: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
}

/** Checks each process's active unit and requires the app as a service's main process. */
export function verifyUnitMembership(input: {
  readonly unit: string;
  readonly appPid: number;
  readonly properties: string;
  readonly appCgroup: string;
  readonly backendCgroup: string;
  readonly backendUnit?: { readonly name: string; readonly properties: string };
}): void {
  for (const membership of [
    { unit: input.unit, properties: input.properties, cgroup: input.appCgroup },
    {
      unit: input.backendUnit?.name ?? input.unit,
      properties: input.backendUnit?.properties ?? input.properties,
      cgroup: input.backendCgroup,
    },
  ]) {
    NodeAssert.match(membership.unit, USER_UNIT_NAME, "invalid user unit name");
    const properties = Object.fromEntries(
      membership.properties.split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    NodeAssert.equal(properties.Id, membership.unit, "user unit identity changed");
    NodeAssert.equal(properties.ActiveState, "active", "user unit is not active");
    NodeAssert.ok(
      properties.ControlGroup?.startsWith("/") && properties.ControlGroup !== "/",
      "user unit has no control group",
    );
    NodeAssert.ok(
      membership.cgroup.split("\n").some((line) => {
        const [hierarchy, controllers, ...path] = line.split(":");
        return (
          ((hierarchy === "0" && controllers === "") ||
            controllers?.split(",").includes("name=systemd")) &&
          path.join(":") === properties.ControlGroup
        );
      }),
      "user unit no longer owns the captured process",
    );
    if (membership.unit.endsWith(".service")) {
      NodeAssert.equal(properties.MainPID, String(input.appPid), "service main process changed");
    }
  }
}

/** Confirms exact unit ownership, backend ancestry, and the backend's open state database. */
export function verifyDesktopOwnership(
  plan: Pick<RestartPlan, "unit" | "backendUnit" | "app" | "backend" | "sourceDatabasePath">,
): void {
  NodeAssert.match(plan.unit, USER_UNIT_NAME, "invalid user unit name");
  if (plan.backendUnit !== undefined)
    NodeAssert.match(plan.backendUnit, USER_UNIT_NAME, "invalid user unit name");
  NodeAssert.deepEqual(captureProcess(plan.app.pid), plan.app, "app identity changed");
  NodeAssert.deepEqual(captureProcess(plan.backend.pid), plan.backend, "backend identity changed");
  verifyUnitMembership({
    unit: plan.unit,
    appPid: plan.app.pid,
    properties: readCommand("systemctl", [
      "--user",
      "show",
      plan.unit,
      "--property=Id,ActiveState,ControlGroup,MainPID",
    ]),
    appCgroup: NodeFS.readFileSync(`/proc/${plan.app.pid}/cgroup`, "utf8"),
    backendCgroup: NodeFS.readFileSync(`/proc/${plan.backend.pid}/cgroup`, "utf8"),
    ...(plan.backendUnit === undefined || plan.backendUnit === plan.unit
      ? {}
      : {
          backendUnit: {
            name: plan.backendUnit,
            properties: readCommand("systemctl", [
              "--user",
              "show",
              plan.backendUnit,
              "--property=Id,ActiveState,ControlGroup,MainPID",
            ]),
          },
        }),
  });
  const backendStat = parseProcessStat(
    NodeFS.readFileSync(`/proc/${plan.backend.pid}/stat`, "utf8"),
  );
  NodeAssert.equal(backendStat.parentPid, plan.app.pid, "backend is not a direct child of the app");
  const argumentsList = NodeFS.readFileSync(`/proc/${plan.backend.pid}/cmdline`, "utf8").split(
    "\0",
  );
  NodeAssert.ok(
    argumentsList.includes(`${INSTALLED_ASAR}/apps/server/dist/bin.mjs`),
    "backend is not running the installed ASAR",
  );
  const databasePath = NodeFS.realpathSync(plan.sourceDatabasePath);
  const ownsDatabase = NodeFS.readdirSync(`/proc/${plan.backend.pid}/fd`).some((descriptor) => {
    try {
      return NodeFS.readlinkSync(`/proc/${plan.backend.pid}/fd/${descriptor}`) === databasePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
  NodeAssert.ok(ownsDatabase, "backend does not own the continuation database");
}

/** Requires the effective project preference used by V2 recovery, including its default. */
function verifyContinuationPreference(databasePath: string, projectId: string): void {
  const settingsPath = NodePath.join(NodePath.dirname(databasePath), "settings.json");
  const settings = (
    NodeFS.existsSync(settingsPath) ? JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) : null
  ) as {
    readonly continueThreadsAfterServerUpdate?: unknown;
    readonly projectSettingsOverrides?: Readonly<
      Record<string, { readonly continueThreadsAfterServerUpdate?: unknown }>
    >;
  } | null;
  NodeAssert.equal(
    // This copied worker runs without workspace imports; match ServerSettings' default.
    settings?.projectSettingsOverrides?.[projectId]?.continueThreadsAfterServerUpdate ??
      settings?.continueThreadsAfterServerUpdate ??
      true,
    true,
    "automatic restart continuation is not enabled for this project",
  );
}

function requiredString(value: unknown, message: string): string {
  NodeAssert.ok(typeof value === "string" && value.length > 0, message);
  return value;
}

/** Checks the live-root-run subset of orchestration-v2/RestartContinuation.restartContinuationRun. */
function activeRun(
  database: NodeSqlite.DatabaseSync,
  databasePath: string,
  threadId: string,
): RestartContinuation {
  const state = database
    .prepare(`SELECT threads.project_id, threads.archived_at, threads.deleted_at,
        json_extract(threads.payload_json, '$.providerInstanceId') AS thread_instance,
        runs.run_id, runs.status AS run_status,
        json_extract(runs.payload_json, '$.providerInstanceId') AS run_instance,
        json_extract(runs.payload_json, '$.activeAttemptId') AS attempt_id,
        provider_threads.provider_thread_id, provider_threads.provider_session_id,
        json_extract(provider_threads.payload_json, '$.appThreadId') AS app_thread_id,
        json_extract(provider_threads.payload_json, '$.ownerNodeId') AS owner_node_id,
        json_extract(provider_threads.payload_json, '$.providerInstanceId') AS provider_instance,
        json_extract(provider_threads.payload_json, '$.driver') AS driver,
        json_extract(provider_threads.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        json_extract(provider_threads.payload_json, '$.nativeThreadRef.driver') AS native_driver,
        json_extract(provider_threads.payload_json, '$.nativeThreadRef.strength') AS native_strength,
        provider_threads.status AS provider_thread_status,
        sessions.status AS session_status,
        json_extract(sessions.payload_json, '$.providerInstanceId') AS session_instance,
        json_extract(sessions.payload_json, '$.driver') AS session_driver,
        bindings.thread_id AS bound_thread_id, turns.provider_turn_id
      FROM orchestration_v2_projection_threads threads
      LEFT JOIN orchestration_v2_projection_runs runs ON runs.run_id = (
        SELECT latest.run_id FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = threads.thread_id ORDER BY latest.ordinal DESC LIMIT 1
      )
      LEFT JOIN orchestration_v2_projection_provider_threads provider_threads
        ON provider_threads.provider_thread_id = runs.provider_thread_id
      LEFT JOIN orchestration_v2_projection_provider_sessions sessions
        ON sessions.provider_session_id = provider_threads.provider_session_id
      LEFT JOIN orchestration_v2_projection_provider_session_bindings bindings
        ON bindings.provider_session_id = sessions.provider_session_id
        AND bindings.thread_id = threads.thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts attempts
        ON attempts.attempt_id = json_extract(runs.payload_json, '$.activeAttemptId')
        AND attempts.run_id = runs.run_id AND attempts.thread_id = threads.thread_id
      LEFT JOIN orchestration_v2_projection_provider_turns turns
        ON turns.run_attempt_id = attempts.attempt_id
        AND turns.provider_thread_id = provider_threads.provider_thread_id
        AND turns.thread_id = threads.thread_id AND turns.status = 'running'
      WHERE threads.thread_id = ?`)
    .get(threadId);
  NodeAssert.ok(state, "thread has no V2 runtime state");
  NodeAssert.equal(state.archived_at, null, "thread is archived");
  NodeAssert.equal(state.deleted_at, null, "thread is deleted");
  verifyContinuationPreference(
    databasePath,
    requiredString(state.project_id, "thread has no project"),
  );
  const runId = requiredString(
    state.run_id,
    "thread has no V2 run; legacy turns need a migration monitor",
  );
  NodeAssert.equal(state.run_status, "running", "keep the V2 run running through restart");
  const instance = requiredString(state.run_instance, "run has no provider instance");
  NodeAssert.equal(
    state.thread_instance,
    instance,
    "thread provider changed since the run started",
  );
  NodeAssert.equal(state.app_thread_id, threadId, "provider thread belongs to another app thread");
  NodeAssert.equal(state.owner_node_id, null, "provider thread is a subagent, not the root run");
  NodeAssert.equal(
    state.provider_instance,
    instance,
    "provider thread instance does not match the run",
  );
  NodeAssert.equal(state.provider_thread_status, "active", "provider thread is not active");
  const driver = requiredString(state.driver, "provider thread has no driver");
  NodeAssert.equal(state.native_driver, driver, "native thread driver does not match");
  NodeAssert.equal(
    state.native_strength,
    "strong",
    "provider thread has no strong native identity",
  );
  const nativeThreadId = requiredString(
    state.native_id,
    "provider thread has no native resume identity",
  );
  NodeAssert.equal(
    state.session_instance,
    instance,
    "provider session instance does not match the run",
  );
  NodeAssert.equal(state.session_driver, driver, "provider session driver does not match");
  NodeAssert.equal(state.bound_thread_id, threadId, "provider session is not bound to the thread");
  NodeAssert.ok(
    typeof state.session_status === "string" &&
      !["stopped", "error"].includes(state.session_status),
    "provider session is stopped or failed",
  );
  return {
    type: "active-run",
    runId,
    attemptId: requiredString(state.attempt_id, "run has no active attempt"),
    providerThreadId: requiredString(state.provider_thread_id, "run has no provider thread"),
    providerSessionId: requiredString(state.provider_session_id, "run has no provider session"),
    providerTurnId: requiredString(
      state.provider_turn_id,
      "run has no matching running provider turn",
    ),
    nativeThreadId,
  };
}

/** Verifies the explicit one-time handoff before V1 state is copied into statev2.sqlite. */
function migrationMonitor(
  database: NodeSqlite.DatabaseSync,
  threadId: string,
  monitorId: string,
): RestartContinuation {
  const state = database
    .prepare(`SELECT threads.archived_at, threads.deleted_at,
      sessions.status, sessions.active_turn_id,
      runtime.status AS provider_status,
      json_extract(runtime.runtime_payload_json, '$.activeTurnId') AS provider_turn_id
    FROM projection_threads threads
    JOIN projection_thread_sessions sessions USING (thread_id)
    JOIN provider_session_runtime runtime USING (thread_id)
    WHERE threads.thread_id = ?`)
    .get(threadId);
  NodeAssert.ok(state, "migration thread has no active V1 provider session");
  NodeAssert.equal(state.archived_at, null, "thread is archived");
  NodeAssert.equal(state.deleted_at, null, "thread is deleted");
  NodeAssert.equal(state.status, "running", "keep the V1 thread running through migration");
  NodeAssert.equal(state.provider_status, "running", "V1 provider session is not running");
  const turnId = requiredString(state.active_turn_id, "V1 thread has no active turn");
  NodeAssert.equal(
    state.provider_turn_id,
    turnId,
    "V1 durable records disagree on the active turn",
  );
  const monitor = database
    .prepare(`SELECT thread_id, condition_type, wake_at,
      continuation_mode, resume_prompt, status, delivered_at, cancelled_at
    FROM thread_monitors WHERE monitor_id = ?`)
    .get(monitorId);
  NodeAssert.ok(monitor, "migration monitor does not exist");
  NodeAssert.equal(monitor.thread_id, threadId, "migration monitor belongs to another thread");
  NodeAssert.equal(monitor.condition_type, "time", "migration monitor must have a time condition");
  NodeAssert.equal(
    monitor.continuation_mode,
    "resume-thread",
    "migration monitor must resume the thread",
  );
  requiredString(monitor.resume_prompt, "migration monitor has no resume prompt");
  NodeAssert.ok(
    monitor.status === "active" || monitor.status === "triggered",
    "migration monitor is no longer pending",
  );
  NodeAssert.equal(monitor.delivered_at, null, "migration monitor was already delivered");
  NodeAssert.equal(monitor.cancelled_at, null, "migration monitor was cancelled");
  const wakeAt = requiredString(monitor.wake_at, "migration monitor has no deadline");
  NodeAssert.ok(Number.isFinite(Date.parse(wakeAt)), "migration monitor has an invalid deadline");
  return { type: "migration-monitor", monitorId, turnId, wakeAt };
}

/** Captures a recoverable run, or an explicitly selected pending monitor for the first V2 launch. */
export function captureRestartContinuation(
  sourceDatabasePath: string,
  restartDatabasePath: string,
  threadId: string,
  migrationMonitorId?: string,
): RestartContinuation {
  const directory = NodeFS.realpathSync(NodePath.dirname(sourceDatabasePath));
  NodeAssert.equal(
    sourceDatabasePath,
    NodePath.join(directory, migrationMonitorId === undefined ? "statev2.sqlite" : "state.sqlite"),
    migrationMonitorId === undefined
      ? "native restart requires statev2.sqlite; the first V2 upgrade needs --migration-monitor"
      : "migration monitor requires the original state.sqlite",
  );
  NodeAssert.equal(
    restartDatabasePath,
    NodePath.join(directory, "statev2.sqlite"),
    "restart must use statev2.sqlite in the same T3 home",
  );
  if (migrationMonitorId !== undefined) {
    requiredString(migrationMonitorId, "migration monitor id is empty");
    NodeAssert.equal(
      NodeFS.lstatSync(restartDatabasePath, { throwIfNoEntry: false }),
      undefined,
      "statev2.sqlite already exists; V1 state and its monitor would not be imported again",
    );
  }
  const database = new NodeSqlite.DatabaseSync(sourceDatabasePath, { readOnly: true });
  try {
    // Keep the thread and monitor checks in one read snapshot while the app writes concurrently.
    database.exec("BEGIN");
    return migrationMonitorId === undefined
      ? activeRun(database, sourceDatabasePath, threadId)
      : migrationMonitor(database, threadId, migrationMonitorId);
  } finally {
    database.close();
  }
}

/** Rechecks the same captured work and the one-time migration guard immediately before shutdown. */
export function verifyRestartContinuation(
  plan: Pick<
    RestartPlan,
    "sourceDatabasePath" | "restartDatabasePath" | "threadId" | "continuation"
  >,
): void {
  NodeAssert.ok(
    plan.continuation.type === "active-run" || plan.continuation.type === "migration-monitor",
    "invalid restart continuation",
  );
  const current = captureRestartContinuation(
    plan.sourceDatabasePath,
    plan.restartDatabasePath,
    plan.threadId,
    plan.continuation.type === "migration-monitor" ? plan.continuation.monitorId : undefined,
  );
  NodeAssert.deepEqual(
    current,
    plan.continuation,
    "captured restart continuation changed before restart",
  );
}

/** Hashes an installed payload without retaining the whole file in memory. */
export async function hashInstalledFile(filename: string, signal?: AbortSignal): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filename, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

/** Removes development overrides while retaining the user service manager's desktop environment. */
export function launchEnvironment(
  environment: NodeJS.ProcessEnv,
  appEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const preservedKeys = new Set(["T3CODE_HOME", "T3CODE_PORT", "XDG_CONFIG_HOME"]);
  NodeAssert.ok(
    Object.keys(appEnvironment).every((key) => preservedKeys.has(key)),
    "unexpected app environment override",
  );
  const omitted = new Set([
    "ELECTRON_RUN_AS_NODE",
    "T3CODE_DESKTOP_DEV",
    "VITE_DEV_SERVER_URL",
    "APPIMAGE",
    "APPDIR",
    ...preservedKeys,
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !omitted.has(entry[0]),
      ),
    ),
    ...appEnvironment,
  };
}

/** Waits for both captured processes to leave without escalating to forced termination. */
export async function waitForShutdown(identities: ReadonlyArray<ProcessIdentity>): Promise<void> {
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (identities.some(isSameProcess)) {
    NodeAssert.ok(
      Date.now() < deadline,
      "desktop did not exit gracefully; not launching a second instance",
    );
    await NodeTimersPromises.setTimeout(PROCESS_CHECK_INTERVAL_MS);
  }
}

/** Revalidates the durable handoff before shutdown and replaces this worker with the installed app. */
async function main(): Promise<void> {
  const planPath = process.argv[2];
  NodeAssert.ok(planPath, "restart plan path is required");
  const plan = JSON.parse(NodeFS.readFileSync(planPath, "utf8")) as RestartPlan;
  NodeAssert.equal(
    readCommand("pacman", ["-Q", "t3code-bin"]),
    `t3code-bin ${plan.packageVersion}`,
    "installed package changed before restart",
  );
  NodeAssert.equal(
    await hashInstalledFile(INSTALLED_ASAR),
    plan.asarSha256,
    "installed ASAR changed before restart",
  );
  NodeAssert.equal(
    await hashInstalledFile(INSTALLED_EXECUTABLE),
    plan.executableSha256,
    "installed executable changed before restart",
  );
  verifyDesktopOwnership(plan);
  NodeAssert.ok(process.execve, "node does not support independent app replacement");
  NodeAssert.ok(
    NodeFS.statSync(plan.workingDirectory).isDirectory(),
    "restart working directory is unavailable",
  );
  NodeFS.accessSync("/usr/bin/t3code", NodeFS.constants.X_OK);
  const environment = launchEnvironment(process.env, plan.appEnvironment);
  console.log(
    `restarting ${plan.unit} for commit ${plan.gitCommit}; ${plan.continuation.type} continuation for thread ${plan.threadId}`,
  );
  verifyRestartContinuation(plan);
  NodeAssert.deepEqual(
    captureProcess(plan.app.pid),
    plan.app,
    "app identity changed before shutdown",
  );
  process.kill(plan.app.pid, "SIGTERM");
  await waitForShutdown([plan.app, plan.backend]);
  process.chdir(plan.workingDirectory);
  process.execve("/usr/bin/t3code", ["/usr/bin/t3code"], environment);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

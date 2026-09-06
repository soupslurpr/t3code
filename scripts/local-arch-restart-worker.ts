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

export interface RestartContinuation {
  readonly type: "active-turn";
  readonly turnId: string;
}

export interface RestartPlan {
  readonly unit: string;
  readonly backendUnit?: string;
  readonly app: ProcessIdentity;
  readonly backend: ProcessIdentity;
  readonly databasePath: string;
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
  plan: Pick<RestartPlan, "unit" | "backendUnit" | "app" | "backend" | "databasePath">,
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
  const databasePath = NodeFS.realpathSync(plan.databasePath);
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

/** Requires native recovery to be enabled and both durable records to identify the running turn. */
export function verifyActiveTurn(
  databasePath: string,
  threadId: string,
  expectedTurnId?: string,
): string {
  const settingsPath = NodePath.join(NodePath.dirname(databasePath), "settings.json");
  const settings = (
    NodeFS.existsSync(settingsPath) ? JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) : null
  ) as {
    readonly continueThreadsAfterServerUpdate?: unknown;
    readonly projectSettingsOverrides?: Readonly<
      Record<string, { readonly continueThreadsAfterServerUpdate?: unknown }>
    >;
  } | null;
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const session = database
      .prepare(`SELECT threads.project_id, threads.archived_at, threads.deleted_at,
        sessions.status, sessions.active_turn_id,
        runtime.status AS provider_status,
        json_type(runtime.resume_cursor_json) AS resume_cursor_type,
        json_extract(runtime.runtime_payload_json, '$.activeTurnId') AS provider_turn_id
      FROM projection_threads threads
      JOIN projection_thread_sessions sessions USING (thread_id)
      JOIN provider_session_runtime runtime USING (thread_id)
      WHERE threads.thread_id = ?`)
      .get(threadId);
    NodeAssert.ok(session, "thread has no durable provider session");
    const projectPreference =
      typeof session.project_id === "string"
        ? settings?.projectSettingsOverrides?.[session.project_id]?.continueThreadsAfterServerUpdate
        : undefined;
    NodeAssert.equal(
      projectPreference ?? settings?.continueThreadsAfterServerUpdate,
      true,
      "automatic restart continuation is not enabled for this project",
    );
    NodeAssert.equal(session.archived_at, null, "thread is archived");
    NodeAssert.equal(session.deleted_at, null, "thread is deleted");
    NodeAssert.equal(session.status, "running", "keep the thread running through restart");
    NodeAssert.equal(session.provider_status, "running", "provider session is not running");
    NodeAssert.ok(
      typeof session.active_turn_id === "string" && session.active_turn_id.length > 0,
      "thread has no active turn",
    );
    NodeAssert.equal(
      session.provider_turn_id,
      session.active_turn_id,
      "durable records disagree on the active turn",
    );
    NodeAssert.ok(
      typeof session.resume_cursor_type === "string" && session.resume_cursor_type !== "null",
      "provider session has no resume cursor",
    );
    if (expectedTurnId !== undefined) {
      NodeAssert.equal(
        session.active_turn_id,
        expectedTurnId,
        "active turn changed before restart",
      );
    }
    return session.active_turn_id;
  } finally {
    database.close();
  }
}

/** Rechecks that native recovery still owns the captured unfinished turn. */
export function verifyRestartContinuation(
  plan: Pick<RestartPlan, "databasePath" | "threadId" | "continuation">,
): void {
  NodeAssert.equal(plan.continuation.type, "active-turn", "invalid restart continuation");
  NodeAssert.ok(plan.continuation.turnId, "restart plan has no captured turn");
  verifyActiveTurn(plan.databasePath, plan.threadId, plan.continuation.turnId);
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
  verifyRestartContinuation(plan);
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

#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - This standalone host worker verifies and restarts an exact process.

/** Runs independently of the app and checkout, without provider credentials or database writes. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

export const INSTALLED_EXECUTABLE = "/opt/t3code-bin/t3code";
export const INSTALLED_ASAR = "/opt/t3code-bin/resources/app.asar";
export const SHUTDOWN_TIMEOUT_MS = 180_000;
const PROCESS_CHECK_INTERVAL_MS = 200;

export interface ProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
}

export interface RestartPlan {
  readonly service: string;
  readonly app: ProcessIdentity;
  readonly backend: ProcessIdentity;
  readonly databasePath: string;
  readonly threadId: string;
  readonly monitorId: string;
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

/** Confirms exact service ownership, backend ancestry, and the backend's open state database. */
export function verifyDesktopOwnership(
  plan: Pick<RestartPlan, "service" | "app" | "backend" | "databasePath">,
): void {
  NodeAssert.match(
    plan.service,
    /^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/,
    "invalid user service name",
  );
  NodeAssert.equal(
    readCommand("systemctl", ["--user", "show", plan.service, "--property=MainPID", "--value"]),
    String(plan.app.pid),
    "service no longer owns the captured app",
  );
  NodeAssert.deepEqual(captureProcess(plan.app.pid), plan.app, "app identity changed");
  NodeAssert.deepEqual(captureProcess(plan.backend.pid), plan.backend, "backend identity changed");
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

/** Requires an undelivered future timer for this same thread, using a read-only connection. */
export function verifyContinuation(
  databasePath: string,
  threadId: string,
  monitorId: string,
  earliestWakeMs: number,
): void {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const monitor = database
      .prepare(`SELECT thread_id, continuation_mode, condition_type, status, wake_at, resume_prompt
      FROM thread_monitors WHERE monitor_id = ?`)
      .get(monitorId);
    NodeAssert.ok(monitor, "restart continuation monitor does not exist");
    NodeAssert.equal(monitor.thread_id, threadId, "restart continuation belongs to another thread");
    NodeAssert.equal(
      monitor.continuation_mode,
      "resume-thread",
      "monitor cannot resume the thread",
    );
    NodeAssert.equal(monitor.condition_type, "time", "restart requires a timer continuation");
    NodeAssert.equal(monitor.status, "active", "restart continuation is no longer pending");
    NodeAssert.ok(
      typeof monitor.resume_prompt === "string" && monitor.resume_prompt.trim().length > 0,
      "restart continuation has no verification instructions",
    );
    NodeAssert.ok(
      typeof monitor.wake_at === "string" && Date.parse(monitor.wake_at) >= earliestWakeMs,
      "restart continuation deadline is too soon",
    );
  } finally {
    database.close();
  }
}

/** Hashes an installed payload without retaining the whole file in memory. */
export async function hashInstalledFile(filename: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filename)) hash.update(chunk);
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
  verifyContinuation(
    plan.databasePath,
    plan.threadId,
    plan.monitorId,
    Date.now() + SHUTDOWN_TIMEOUT_MS,
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
    `restarting ${plan.service} for commit ${plan.gitCommit}; continuation ${plan.monitorId}`,
  );
  readCommand("systemctl", [
    "--user",
    "kill",
    "--kill-whom=main",
    "--signal=SIGTERM",
    plan.service,
  ]);
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

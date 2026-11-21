#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - This host CLI installs a verified package and schedules a supervised restart.

/** Installs a verified fork package and schedules a supervised restart with V2 continuation checks. */
import { buildSync } from "esbuild";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { extractFile } from "@electron/asar";

import { snapshotPublishedPackage, verifyPublishedPackage } from "./arch/manifest.ts";
import {
  captureProcess,
  hashInstalledFile,
  INSTALLED_ASAR,
  INSTALLED_EXECUTABLE,
  parseProcessStat,
  readCommand,
  captureRestartContinuation,
  verifyRestartContinuation,
  verifyDesktopOwnership,
  verifyPackageOwnership,
  type RestartPlan,
} from "./local-arch-restart-worker.ts";

const DEFAULT_RESTART_DELAY_SECONDS = 60;
const MAX_RESTART_DELAY_SECONDS = 600;

/** Capture the worker and its exact policy code before the installed files are replaced. */
export function writeRestartWorker(workerPath: string): void {
  const bundle = buildSync({
    entryPoints: [NodePath.join(import.meta.dirname, "local-arch-restart-worker.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire as createWorkerRequire } from "node:module"; const require = createWorkerRequire(import.meta.url);',
    },
    write: false,
  });
  NodeFS.writeFileSync(workerPath, bundle.outputFiles[0]!.contents, { flag: "wx", mode: 0o600 });
}

export function parseRestartDelaySeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RESTART_DELAY_SECONDS;
  NodeAssert.match(raw, /^[1-9]\d*$/, "restart delay must be a positive integer");
  const seconds = Number(raw);
  NodeAssert.ok(
    Number.isSafeInteger(seconds) && seconds <= MAX_RESTART_DELAY_SECONDS,
    `restart delay must be between 1 and ${MAX_RESTART_DELAY_SECONDS} seconds`,
  );
  return seconds;
}

/** The audited archive conflicts only with the two upstream package identities. */
export function pacmanUpgradeArguments(packagePath: string, replaceLegacy: boolean): string[] {
  // ALPM_QUESTION_CONFLICT_PKG (1 << 2): --noconfirm alone declines this removal.
  return ["--noconfirm", ...(replaceLegacy ? ["--ask=4"] : []), "-U", packagePath];
}

/** Checks installed metadata against the exact selected source pin. */
export function verifyInstalledBuild(raw: string, version: string, commit: string): void {
  const build = JSON.parse(raw) as {
    version?: unknown;
    buildVersion?: unknown;
    t3codeCommitHash?: unknown;
  };
  NodeAssert.match(commit, /^[0-9a-f]{40}$/, "expected a full source commit");
  NodeAssert.equal(build.version, version, "installed desktop version mismatch");
  NodeAssert.equal(build.buildVersion, version, "installed build version mismatch");
  NodeAssert.ok(
    typeof build.t3codeCommitHash === "string" &&
      /^[0-9a-f]{12,40}$/.test(build.t3codeCommitHash) &&
      commit.startsWith(build.t3codeCommitHash),
    "installed desktop commit mismatch",
  );
}

/** Reads only non-secret state-location overrides from the captured app, never provider credentials. */
function readAppEnvironment(pid: number): Readonly<Record<string, string>> {
  const keys = new Set(["T3CODE_HOME", "T3CODE_PORT", "XDG_CONFIG_HOME"]);
  return Object.fromEntries(
    NodeFS.readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .flatMap((entry) => {
        const separator = entry.indexOf("=");
        const key = entry.slice(0, separator);
        return separator > 0 && keys.has(key) ? [[key, entry.slice(separator + 1)]] : [];
      }),
  );
}

/** Validates the handoff without mutation unless installation and scheduling are explicitly requested. */
async function main(): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    options: {
      package: { type: "string" },
      commit: { type: "string" },
      unit: { type: "string" },
      "backend-unit": { type: "string" },
      "backend-pid": { type: "string" },
      "state-db": { type: "string" },
      "thread-id": { type: "string" },
      "migration-monitor": { type: "string" },
      "delay-seconds": { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      [
        "usage: node scripts/local-arch-restart.ts --package <path> --commit <sha> --unit <unit> --backend-pid <pid> --state-db <path> --thread-id <id> [--backend-unit <unit>] [--migration-monitor <id>] [--delay-seconds <1-600>] [--apply]",
        "",
        "Validates the published package, running desktop/backend ownership, and durable V2 continuation.",
        "Dry run by default; pass --apply to install via pacman if needed and queue the guarded systemd-run restart worker.",
      ].join("\n"),
    );
    return;
  }
  const restartDelaySeconds = parseRestartDelaySeconds(values["delay-seconds"]);
  NodeAssert.ok(
    NodeFS.existsSync("/proc/self/stat") && process.getuid?.() !== 0,
    "run as the desktop's Linux user, not root",
  );
  NodeAssert.ok(
    values.package &&
      values.commit &&
      values.unit &&
      values["backend-pid"] &&
      values["state-db"] &&
      values["thread-id"],
    "all handoff options are required",
  );
  NodeAssert.match(values.commit, /^[0-9a-f]{40}$/, "expected a full source commit");
  const packagePath = NodePath.resolve(values.package);
  const receipt = await verifyPublishedPackage(packagePath);
  NodeAssert.equal(
    receipt.gitCommit,
    values.commit,
    "package does not match the selected source pin",
  );
  const backend = captureProcess(Number(values["backend-pid"]));
  const app = captureProcess(
    parseProcessStat(NodeFS.readFileSync(`/proc/${backend.pid}/stat`, "utf8")).parentPid,
  );
  const appArguments = NodeFS.readFileSync(`/proc/${app.pid}/cmdline`, "utf8")
    .split("\0")
    .slice(1)
    .filter(Boolean);
  NodeAssert.ok(
    appArguments.every((argument) => argument === "--no-sandbox"),
    "app has custom launch arguments; review its relaunch manually",
  );
  const sourceDatabasePath = NodeFS.realpathSync(values["state-db"]);
  const appEnvironment = readAppEnvironment(app.pid);
  const stateDirectory = NodeFS.realpathSync(
    NodePath.join(
      appEnvironment.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3"),
      "userdata",
    ),
  );
  NodeAssert.equal(
    NodePath.dirname(sourceDatabasePath),
    stateDirectory,
    "app environment would relaunch against a different state database",
  );
  const restartDatabasePath = NodePath.join(stateDirectory, "statev2.sqlite");
  const continuation = captureRestartContinuation(
    sourceDatabasePath,
    restartDatabasePath,
    values["thread-id"],
    values["migration-monitor"],
  );
  const handoff = {
    unit: values.unit,
    ...(values["backend-unit"] === undefined ? {} : { backendUnit: values["backend-unit"] }),
    app,
    backend,
    sourceDatabasePath,
    restartDatabasePath,
    threadId: values["thread-id"],
    continuation,
  };
  const checkHandoff = () => {
    verifyDesktopOwnership(handoff);
    verifyRestartContinuation(handoff);
  };
  checkHandoff();
  const packageVersion = `${receipt.version}-${receipt.packageRelease}`;
  console.log(
    `verified ${packageVersion} at ${receipt.gitCommit}; app ${app.pid}, backend ${backend.pid}, thread ${handoff.threadId}`,
  );
  if (!values.apply) {
    console.log("dry run only; add --apply to install and queue the guarded restart");
    return;
  }
  NodeAssert.ok(process.execve, "node does not support independent app replacement");
  readCommand("/usr/bin/node", [
    "--input-type=module",
    "--eval",
    "import 'node:sqlite'; process.exit(typeof process.execve === 'function' ? 0 : 1)",
  ]);
  readCommand("systemd-run", ["--version"]);
  const stateRoot = NodePath.join(NodeOS.homedir(), ".local/state/t3code-maintenance");
  NodeFS.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const directory = NodeFS.mkdtempSync(NodePath.join(stateRoot, "restart-"));
  const workerPath = NodePath.join(directory, "worker.mts");
  writeRestartWorker(workerPath);
  console.log(`recovery directory ${directory}`);
  using packageDir = NodeFS.mkdtempDisposableSync(
    NodePath.join(NodeOS.tmpdir(), "t3-arch-install-"),
  );
  const snapshot = await snapshotPublishedPackage(packagePath, packageDir.path, receipt);
  const asarMember = INSTALLED_ASAR.slice(1);
  const executableMember = INSTALLED_EXECUTABLE.slice(1);
  NodeChildProcess.execFileSync("bsdtar", [
    "-xf",
    snapshot,
    "-C",
    packageDir.path,
    asarMember,
    executableMember,
  ]);
  const [asarSha256, executableSha256] = await Promise.all([
    hashInstalledFile(NodePath.join(packageDir.path, asarMember)),
    hashInstalledFile(NodePath.join(packageDir.path, executableMember)),
  ]);
  const installed = NodeChildProcess.spawnSync("pacman", ["-Q", "t3code-soupslurpr-bin"], {
    encoding: "utf8",
  });
  NodeAssert.ok(
    !installed.error && (installed.status === 0 || installed.status === 1),
    "could not query installed fork package",
  );
  if (
    installed.status !== 0 ||
    installed.stdout.trim() !== `t3code-soupslurpr-bin ${packageVersion}`
  ) {
    const legacy = NodeChildProcess.spawnSync("pacman", ["-Qq", "t3code-bin"], {
      encoding: "utf8",
    });
    NodeAssert.ok(
      !legacy.error && (legacy.status === 0 || legacy.status === 1),
      "could not query legacy package",
    );
    NodeChildProcess.execFileSync(
      "sudo",
      ["-n", "pacman", ...pacmanUpgradeArguments(snapshot, legacy.status === 0)],
      {
        stdio: "inherit",
      },
    );
  }
  NodeAssert.equal(
    verifyPackageOwnership(INSTALLED_ASAR, INSTALLED_EXECUTABLE),
    `t3code-soupslurpr-bin ${packageVersion}`,
    "installed package version mismatch",
  );
  verifyInstalledBuild(
    extractFile(INSTALLED_ASAR, "package.json").toString("utf8"),
    receipt.version,
    receipt.gitCommit,
  );
  NodeAssert.equal(
    await hashInstalledFile(INSTALLED_ASAR),
    asarSha256,
    "installed ASAR differs from selected package",
  );
  NodeAssert.equal(
    await hashInstalledFile(INSTALLED_EXECUTABLE),
    executableSha256,
    "installed executable differs from selected package",
  );
  checkHandoff();
  const plan: RestartPlan = {
    ...handoff,
    packageVersion,
    gitCommit: receipt.gitCommit,
    asarSha256,
    executableSha256,
    workingDirectory: NodeOS.homedir(),
    appEnvironment,
  };
  const planPath = NodePath.join(directory, "plan.json");
  NodeFS.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const unit = `t3code-${NodePath.basename(directory)}`;
  NodeChildProcess.execFileSync(
    "systemd-run",
    [
      "--user",
      `--unit=${unit}`,
      `--on-active=${restartDelaySeconds}s`,
      "--timer-property=AccuracySec=1s",
      "--service-type=exec",
      `--working-directory=${plan.workingDirectory}`,
      "/usr/bin/node",
      workerPath,
      planPath,
    ],
    { stdio: "inherit" },
  );
  console.log(`queued ${unit}.timer; recovery plan ${planPath}`);
  console.log(
    continuation.type === "migration-monitor"
      ? "save this path and unit in your work notes and keep the turn running; the imported monitor will resume this thread with a fresh provider session"
      : "save this path and unit in your work notes and keep the turn running; T3 will continue the V2 run after restart",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

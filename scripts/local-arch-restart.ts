#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - This host CLI installs a verified package and schedules a supervised restart.

/** Installs an audited package only after a durable same-thread restart handoff exists. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { extractFile } from "@electron/asar";

import { verifyPublishedPackage } from "./local-arch-artifacts.ts";
import {
  captureProcess,
  hashInstalledFile,
  INSTALLED_ASAR,
  INSTALLED_EXECUTABLE,
  readCommand,
  SHUTDOWN_TIMEOUT_MS,
  verifyContinuation,
  verifyDesktopOwnership,
  type RestartPlan,
} from "./local-arch-restart-worker.ts";

const RESTART_DELAY_SECONDS = 60;
const STARTUP_MARGIN_MS = 60_000;

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
      service: { type: "string" },
      "backend-pid": { type: "string" },
      "state-db": { type: "string" },
      "thread-id": { type: "string" },
      "monitor-id": { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "usage: node scripts/local-arch-restart.ts --package PATH --commit FULL_SHA --service NAME.service --backend-pid PID --state-db PATH --thread-id ID --monitor-id ID [--apply]",
    );
    return;
  }
  NodeAssert.ok(
    NodeFS.existsSync("/proc/self/stat") && process.getuid?.() !== 0,
    "run as the desktop's Linux user, not root",
  );
  NodeAssert.ok(
    values.package &&
      values.commit &&
      values.service &&
      values["backend-pid"] &&
      values["state-db"] &&
      values["thread-id"] &&
      values["monitor-id"],
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
  const app = captureProcess(
    Number(
      readCommand("systemctl", ["--user", "show", values.service, "--property=MainPID", "--value"]),
    ),
  );
  const backend = captureProcess(Number(values["backend-pid"]));
  const appArguments = NodeFS.readFileSync(`/proc/${app.pid}/cmdline`, "utf8")
    .split("\0")
    .slice(1)
    .filter(Boolean);
  NodeAssert.ok(
    appArguments.every((argument) => argument === "--no-sandbox"),
    "app has custom launch arguments; review its relaunch manually",
  );
  const databasePath = NodeFS.realpathSync(values["state-db"]);
  const appEnvironment = readAppEnvironment(app.pid);
  NodeAssert.equal(
    databasePath,
    NodeFS.realpathSync(
      NodePath.join(
        appEnvironment.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3"),
        "userdata/state.sqlite",
      ),
    ),
    "app environment would relaunch against a different state database",
  );
  const handoff = {
    service: values.service,
    app,
    backend,
    databasePath,
    threadId: values["thread-id"],
    monitorId: values["monitor-id"],
  };
  const checkHandoff = () => {
    verifyDesktopOwnership(handoff);
    verifyContinuation(
      databasePath,
      handoff.threadId,
      handoff.monitorId,
      Date.now() + RESTART_DELAY_SECONDS * 1_000 + SHUTDOWN_TIMEOUT_MS + STARTUP_MARGIN_MS,
    );
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
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "local-arch-restart-worker.ts"),
    workerPath,
    NodeFS.constants.COPYFILE_EXCL,
  );
  NodeFS.chmodSync(workerPath, 0o600);
  console.log(`recovery directory ${directory}`);
  NodeAssert.equal(
    (await verifyPublishedPackage(packagePath)).packageSha256,
    receipt.packageSha256,
    "package changed during handoff preparation",
  );
  if (readCommand("pacman", ["-Q", "t3code-bin"]) !== `t3code-bin ${packageVersion}`) {
    NodeChildProcess.execFileSync("sudo", ["-n", "pacman", "--noconfirm", "-U", packagePath], {
      stdio: "inherit",
    });
  }
  NodeAssert.equal(
    readCommand("pacman", ["-Q", "t3code-bin"]),
    `t3code-bin ${packageVersion}`,
    "installed package version mismatch",
  );
  NodeAssert.match(
    readCommand("pacman", ["-Qkk", "t3code-bin"]),
    /^t3code-bin: \d+ total files, 0 altered files$/m,
    "installed package has altered files",
  );
  verifyInstalledBuild(
    extractFile(INSTALLED_ASAR, "package.json").toString("utf8"),
    receipt.version,
    receipt.gitCommit,
  );
  checkHandoff();
  const plan: RestartPlan = {
    ...handoff,
    packageVersion,
    gitCommit: receipt.gitCommit,
    asarSha256: await hashInstalledFile(INSTALLED_ASAR),
    executableSha256: await hashInstalledFile(INSTALLED_EXECUTABLE),
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
      `--on-active=${RESTART_DELAY_SECONDS}s`,
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
    "record this path and unit in the thread tracker, then finish the turn; verify the new service, backend readiness, installed/running commit, and same-thread resumption after restart",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

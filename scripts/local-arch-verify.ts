#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - This host CLI inspects explicit local installations and workspaces.

/** Verifies local builds, workspaces, and completed restarts without changing runtime state. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { extractFile, uncache } from "@electron/asar";
import * as Schema from "effect/Schema";

import {
  hashInstalledFile,
  parseProcessStat,
  type ProcessIdentity,
} from "./local-arch-restart-worker.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PORT = 3774;
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Identity = Schema.Struct({
  pid: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  startTicks: Schema.String.check(Schema.isPattern(/^\d+$/)),
});
const decodeBuild = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.NonEmptyString,
    buildVersion: Schema.NonEmptyString,
    t3codeCommitHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12,40}$/)),
  }),
);
const decodePlan = Schema.decodeUnknownSync(
  Schema.Struct({
    app: Identity,
    backend: Identity,
    databasePath: Schema.String.check(Schema.makeFilter(NodePath.isAbsolute)),
    packageVersion: Schema.NonEmptyString,
    gitCommit: Commit,
    asarSha256: Hash,
    executableSha256: Hash,
  }),
);
const decodeDescriptor = Schema.decodeUnknownSync(
  Schema.Struct({ environmentId: Schema.NonEmptyString }),
);
const decodeCommit = Schema.decodeUnknownSync(Commit);
const decodePort = Schema.decodeUnknownSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
);

/** Reads current archive metadata, invalidating offsets cached before an in-place package update. */
export function readBuild(archive: string) {
  uncache(archive);
  return decodeBuild(JSON.parse(extractFile(archive, "package.json").toString("utf8")));
}

/** Captures process identity without inspecting credentials or environment variables. */
export async function processIdentity(pid: number) {
  NodeAssert.ok(Number.isSafeInteger(pid) && pid > 0, "invalid process id");
  const directory = `/proc/${pid}`;
  const [stat, executable, cwd] = await Promise.all([
    NodeFSP.readFile(NodePath.join(directory, "stat"), "utf8"),
    NodeFSP.readlink(NodePath.join(directory, "exe")),
    NodeFSP.readlink(NodePath.join(directory, "cwd")),
  ]);
  return { pid, ...parseProcessStat(stat), executable, cwd };
}

/** Treats vanished processes as exited while propagating inspection failures. */
export async function processIfPresent(pid: number) {
  try {
    return await processIdentity(pid);
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw cause;
  }
}

/** Reads the installed source, optional hashes, and processes serving one explicit local port. */
export async function checkInstallation(
  appDirectory: string,
  options: {
    readonly port: number;
    readonly expectedCommit?: string;
    readonly includeHashes?: boolean;
  },
  signal: AbortSignal,
) {
  const port = decodePort(options.port);
  const expectedCommit =
    options.expectedCommit === undefined ? undefined : decodeCommit(options.expectedCommit);
  const archive = NodePath.join(appDirectory, "resources", "app.asar");
  const executable = NodePath.join(appDirectory, "t3code");
  const manifest = readBuild(archive);
  const url = `http://127.0.0.1:${port}`;
  const [response, sockets] = await Promise.all([
    fetch(`${url}/.well-known/t3/environment`, { signal }),
    execute("ss", ["-H", "-ltnp", `sport = :${port}`], { signal, maxBuffer: MAX_COMMAND_OUTPUT }),
  ]);
  if (!response.ok) throw new Error(`server descriptor returned HTTP ${response.status}`);
  const descriptor = decodeDescriptor(await response.json());
  const pids = [
    ...new Set([...sockets.stdout.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]))),
  ];
  const listeners = await Promise.all(pids.map(processIdentity));
  const parents = await Promise.all(
    [...new Set(listeners.map((entry) => entry.parentPid))].map(processIdentity),
  );
  const ownershipMatches =
    listeners.length === 1 &&
    parents.length === 1 &&
    [...listeners, ...parents].every(
      (entry) => entry.executable === executable && entry.state !== "Z",
    );
  const hashes = options.includeHashes
    ? {
        archive: await hashInstalledFile(archive, signal),
        executable: await hashInstalledFile(executable, signal),
      }
    : null;
  return {
    checkedAt: new Date().toISOString(),
    build: {
      version: manifest.version,
      buildVersion: manifest.buildVersion,
      commit: manifest.t3codeCommitHash,
      sourceMatches:
        expectedCommit === undefined ? null : expectedCommit.startsWith(manifest.t3codeCommitHash),
    },
    server: { url, status: response.status, environmentId: descriptor.environmentId },
    processes: { ownershipMatches, listeners, parents },
    hashes,
  };
}

/** Recognizes the captured process independently of later reuse of its numeric PID. */
export function isCapturedProcess(actual: ProcessIdentity | null, captured: ProcessIdentity) {
  return (
    actual !== null && actual.pid === captured.pid && actual.startTicks === captured.startTicks
  );
}

/** Resolves the current user service or scope from the unified control group. */
async function processUnit(pid: number) {
  const groups = await NodeFSP.readFile(`/proc/${pid}/cgroup`, "utf8");
  const unified = groups.split("\n").find((line) => line.startsWith("0::"));
  return unified?.slice(3).match(/\/([^/]+\.(?:scope|service))$/)?.[1] ?? null;
}

/** Inspects the owning unit without starting, stopping, or reloading it. */
async function unitState(unit: string, signal: AbortSignal) {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`;
  const result = await execute(
    "systemctl",
    ["--user", "show", "--property=ActiveState", "--value", "--", unit],
    {
      signal,
      maxBuffer: MAX_COMMAND_OUTPUT,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDirectory,
        DBUS_SESSION_BUS_ADDRESS:
          process.env.DBUS_SESSION_BUS_ADDRESS ??
          `unix:path=${NodePath.join(runtimeDirectory, "bus")}`,
      },
    },
  );
  return { unit, state: result.stdout.trim() };
}

/** Checks database ownership through open descriptors without opening the database. */
export async function ownsDatabase(pid: number, databasePath: string) {
  const directory = `/proc/${pid}/fd`;
  const descriptors = await NodeFSP.readdir(directory);
  const targets = await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        return await NodeFSP.readlink(NodePath.join(directory, descriptor));
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
        throw cause;
      }
    }),
  );
  return targets.includes(databasePath);
}

/** Reports each restart condition, requiring both captured processes to have exited. */
export function assessRestart(
  plan: Pick<ReturnType<typeof decodePlan>, "app" | "backend" | "asarSha256" | "executableSha256">,
  installation: {
    readonly build: { readonly sourceMatches: boolean | null };
    readonly hashes: { readonly archive: string; readonly executable: string } | null;
    readonly processes: { readonly ownershipMatches: boolean };
  },
  facts: {
    readonly previousApp: ProcessIdentity | null;
    readonly previousBackend: ProcessIdentity | null;
    readonly backendEntryMatches: boolean;
    readonly databaseOwned: boolean;
    readonly appUnit: string | null;
    readonly backendUnit: string | null;
    readonly units: ReadonlyArray<{ readonly unit: string; readonly state: string }>;
  },
) {
  const checks = {
    sourceMatches: installation.build.sourceMatches === true,
    archiveMatches: installation.hashes?.archive === plan.asarSha256,
    executableMatches: installation.hashes?.executable === plan.executableSha256,
    processOwnership: installation.processes.ownershipMatches && facts.backendEntryMatches,
    databaseOwnership: facts.databaseOwned,
    previousAppExited: !isCapturedProcess(facts.previousApp, plan.app),
    previousBackendExited: !isCapturedProcess(facts.previousBackend, plan.backend),
    activeUnits:
      facts.appUnit !== null &&
      facts.backendUnit !== null &&
      facts.units.length > 0 &&
      facts.units.every((entry) => entry.state === "active"),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

/** Compares an explicit saved restart plan with current installed files and runtime owners. */
export async function checkRestart(
  appDirectory: string,
  planPath: string,
  port: number,
  signal: AbortSignal,
) {
  if (!NodePath.isAbsolute(planPath)) throw new Error("expected an absolute restart plan path");
  const plan = decodePlan(JSON.parse(await NodeFSP.readFile(planPath, "utf8")));
  const installation = await checkInstallation(
    appDirectory,
    { port, expectedCommit: plan.gitCommit, includeHashes: true },
    signal,
  );
  const backend = installation.processes.listeners[0];
  const app = installation.processes.parents[0];
  if (
    installation.processes.listeners.length !== 1 ||
    installation.processes.parents.length !== 1 ||
    !backend ||
    !app ||
    backend.parentPid !== app.pid
  ) {
    throw new Error("expected one backend listener with an identifiable parent");
  }
  const [previousApp, previousBackend, appUnit, backendUnit, databaseOwned, commandLine] =
    await Promise.all([
      processIfPresent(plan.app.pid),
      processIfPresent(plan.backend.pid),
      processUnit(app.pid),
      processUnit(backend.pid),
      ownsDatabase(backend.pid, plan.databasePath),
      NodeFSP.readFile(`/proc/${backend.pid}/cmdline`, "utf8"),
    ]);
  const units = await Promise.all(
    [...new Set([appUnit, backendUnit].filter((unit) => unit !== null))].map((unit) =>
      unitState(unit, signal),
    ),
  );
  const argumentsValue = commandLine.split("\0");
  return {
    plan: { path: planPath, packageVersion: plan.packageVersion, commit: plan.gitCommit },
    ...assessRestart(plan, installation, {
      previousApp,
      previousBackend,
      appUnit,
      backendUnit,
      databaseOwned,
      units,
      backendEntryMatches:
        argumentsValue[0] === NodePath.join(appDirectory, "t3code") &&
        argumentsValue[1] ===
          NodePath.join(appDirectory, "resources", "app.asar", "apps", "server", "dist", "bin.mjs"),
    }),
    databasePath: plan.databasePath,
    units,
    installation,
  };
}

/** Reports the exact Git source and uncommitted paths of an explicit workspace. */
export async function checkWorkspace(directory: string, signal: AbortSignal) {
  const git = async (...args: string[]) =>
    (await execute("git", args, { cwd: directory, signal, maxBuffer: MAX_COMMAND_OUTPUT })).stdout;
  const [root, commit, branch, status] = await Promise.all([
    git("rev-parse", "--show-toplevel"),
    git("rev-parse", "HEAD"),
    git("branch", "--show-current"),
    git("status", "--porcelain=v1", "-z"),
  ]);
  return {
    directory: root.trim(),
    commit: commit.trim(),
    branch: branch.trim() || null,
    clean: status.length === 0,
    changes: status.split("\0").filter(Boolean),
  };
}

/** Prints a bounded JSON report and exits unsuccessfully when a verification condition fails. */
async function main() {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: String(DEFAULT_PORT) },
      "app-dir": { type: "string", default: "/opt/t3code-bin" },
      commit: { type: "string" },
      hashes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "usage: node scripts/local-arch-verify.ts installation [--commit FULL_SHA] [--hashes] [--port PORT] [--app-dir PATH]\n       node scripts/local-arch-verify.ts restart /absolute/plan.json [--port PORT] [--app-dir PATH]\n       node scripts/local-arch-verify.ts workspace DIRECTORY",
    );
    return;
  }
  const [command, target] = positionals;
  if (positionals.length > 2 || (command === "installation" && target !== undefined))
    throw new Error("unexpected positional arguments");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
  try {
    if (command === "workspace" && target) {
      console.log(JSON.stringify(await checkWorkspace(target, signal), null, 2));
    } else if (command === "installation") {
      const report = await checkInstallation(
        NodePath.resolve(values["app-dir"]),
        {
          port: Number(values.port),
          ...(values.commit === undefined ? {} : { expectedCommit: values.commit }),
          includeHashes: values.hashes,
        },
        signal,
      );
      console.log(JSON.stringify(report, null, 2));
      if (report.build.sourceMatches === false || !report.processes.ownershipMatches)
        process.exitCode = 1;
    } else if (command === "restart" && target) {
      const report = await checkRestart(
        NodePath.resolve(values["app-dir"]),
        target,
        Number(values.port),
        signal,
      );
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    } else {
      throw new Error("expected installation, restart PLAN, or workspace DIRECTORY; use --help");
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  });
}

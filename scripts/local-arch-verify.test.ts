// @effect-diagnostics nodeBuiltinImport:off - These tests inspect disposable archives, descriptors, and child processes.

/** Exercises restart proof, archive replacement, and opt-in cleanup using disposable fixtures. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as test } from "@effect/vitest";
import { createPackage } from "@electron/asar";

import {
  assessRestart,
  cleanupRestartRecovery,
  decodeRestartPlan,
  isCapturedProcess,
  matchesBackendEntry,
  ownsDatabase,
  processIfPresent,
  processIdentity,
  readBuild,
} from "./local-arch-verify.ts";

const plan = {
  app: { pid: 120, startTicks: "1000" },
  backend: { pid: 121, startTicks: "1001" },
  asarSha256: "a".repeat(64),
  executableSha256: "b".repeat(64),
};
const installation = {
  build: { sourceMatches: true },
  hashes: { archive: plan.asarSha256, executable: plan.executableSha256 },
  processes: { ownershipMatches: true },
};
const runtime = {
  previousApp: null,
  previousBackend: null,
  backendEntryMatches: true,
  databaseOwned: true,
  appUnit: "app-t3code-200.scope",
  backendUnit: "app-t3code-200.scope",
  units: [{ unit: "app-t3code-200.scope", state: "active" }],
};

test("recognizes the installed backend with and without the compile-cache preload", () => {
  const appDirectory = "/opt/t3code-soupslurpr-bin";
  const executable = `${appDirectory}/t3code`;
  const entry = `${appDirectory}/resources/app.asar/apps/server/dist/bin.mjs`;
  const preload = `${appDirectory}/resources/app.asar/apps/desktop/dist-electron/compileCache.cjs`;
  NodeAssert.equal(
    matchesBackendEntry(appDirectory, [executable, entry, "--bootstrap-fd", "3", ""]),
    true,
  );
  NodeAssert.equal(
    matchesBackendEntry(appDirectory, [
      executable,
      "--require",
      preload,
      entry,
      "--bootstrap-fd",
      "3",
      "",
    ]),
    true,
  );
});

test("rejects unrelated preloads and server paths passed as arguments to another program", () => {
  const appDirectory = "/opt/t3code-soupslurpr-bin";
  const executable = `${appDirectory}/t3code`;
  const entry = `${appDirectory}/resources/app.asar/apps/server/dist/bin.mjs`;
  const preload = `${appDirectory}/resources/app.asar/apps/desktop/dist-electron/compileCache.cjs`;
  for (const args of [
    ["/usr/bin/node", entry],
    [executable, "--require", "/tmp/other.cjs", entry],
    [executable, "/tmp/other.mjs", entry],
    [executable, "--require", preload, "/tmp/other.mjs", entry],
  ]) {
    NodeAssert.equal(matchesBackendEntry(appDirectory, args), false);
  }
});

test("rejects matching new files until both captured processes have exited", () => {
  const before = assessRestart(plan, installation, {
    ...runtime,
    previousApp: plan.app,
    previousBackend: plan.backend,
  });
  NodeAssert.equal(before.checks.sourceMatches, true);
  NodeAssert.equal(before.checks.archiveMatches, true);
  NodeAssert.equal(before.passed, false);
  const retainedBackend = assessRestart(plan, installation, {
    ...runtime,
    previousBackend: plan.backend,
  });
  NodeAssert.equal(retainedBackend.checks.previousAppExited, true);
  NodeAssert.equal(retainedBackend.checks.previousBackendExited, false);
  NodeAssert.equal(retainedBackend.passed, false);
  NodeAssert.equal(assessRestart(plan, installation, runtime).passed, true);
});

test("does not mistake reused numeric PIDs for the captured app and backend", () => {
  const reused = {
    ...runtime,
    previousApp: { ...plan.app, startTicks: "2000" },
    previousBackend: { ...plan.backend, startTicks: "2001" },
  };
  NodeAssert.equal(assessRestart(plan, installation, reused).passed, true);
});

test("reports ownership failures alongside independent restart conditions", () => {
  const result = assessRestart(
    plan,
    { ...installation, processes: { ownershipMatches: false } },
    { ...runtime, previousApp: plan.app, previousBackend: plan.backend },
  );
  NodeAssert.equal(result.passed, false);
  NodeAssert.deepEqual(result.checks, {
    sourceMatches: true,
    archiveMatches: true,
    executableMatches: true,
    processOwnership: false,
    databaseOwnership: true,
    previousAppExited: false,
    previousBackendExited: false,
    activeUnits: true,
  });
});

test("requires the planned archive and a live app-owned database connection", () => {
  NodeAssert.equal(
    assessRestart(
      plan,
      { ...installation, hashes: { ...installation.hashes, archive: "c".repeat(64) } },
      runtime,
    ).passed,
    false,
  );
  NodeAssert.equal(
    assessRestart(plan, installation, { ...runtime, databaseOwned: false }).passed,
    false,
  );
  NodeAssert.equal(
    assessRestart(plan, installation, { ...runtime, backendEntryMatches: false }).passed,
    false,
  );
  NodeAssert.equal(
    assessRestart(plan, installation, {
      ...runtime,
      units: [{ unit: runtime.appUnit, state: "inactive" }],
    }).passed,
    false,
  );
});

test("reads actual captured process identity before and after child exit", async (context) => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready'); process.stdin.resume();"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const exited = NodeEvents.EventEmitter.once(child, "exit");
  context.onTestFinished(async () => {
    child.stdin.end();
    await exited;
  });
  await NodeEvents.EventEmitter.once(child.stdout, "data");
  NodeAssert.ok(child.pid);
  const captured = await processIdentity(child.pid);
  NodeAssert.equal(captured.parentPid, process.pid);
  NodeAssert.match(captured.startTicks, /^\d+$/);
  NodeAssert.equal(isCapturedProcess(await processIfPresent(child.pid), captured), true);
  child.stdin.end();
  await exited;
  NodeAssert.equal(isCapturedProcess(await processIfPresent(child.pid), captured), false);
});

test("proves database ownership through an open descriptor without reading its data", async (context) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-descriptors-"));
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const path = NodePath.join(directory, "state.sqlite");
  const descriptor = await NodeFSP.open(path, "wx");
  context.onTestFinished(() => descriptor.close());
  await descriptor.writeFile("unchanged fixture");
  NodeAssert.equal(await ownsDatabase(process.pid, path), true);
  NodeAssert.equal(
    await ownsDatabase(process.pid, NodePath.join(directory, "other.sqlite")),
    false,
  );
  await descriptor.close();
  NodeAssert.equal(await ownsDatabase(process.pid, path), false);
  NodeAssert.equal(await NodeFSP.readFile(path, "utf8"), "unchanged fixture");
});

test("requires the new database after migration even while the old database is still open", async (context) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-migration-"));
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const sourceDatabasePath = NodePath.join(directory, "state.sqlite");
  const restartDatabasePath = NodePath.join(directory, "statev2.sqlite");
  const decoded = decodeRestartPlan({
    ...plan,
    sourceDatabasePath,
    restartDatabasePath,
    packageVersion: "2.0.0-1",
    gitCommit: "c".repeat(40),
  });
  const oldDatabase = await NodeFSP.open(sourceDatabasePath, "wx");
  context.onTestFinished(() => oldDatabase.close());
  NodeAssert.equal(await ownsDatabase(process.pid, decoded.sourceDatabasePath), true);
  NodeAssert.equal(await ownsDatabase(process.pid, decoded.restartDatabasePath), false);
  const newDatabase = await NodeFSP.open(restartDatabasePath, "wx");
  context.onTestFinished(() => newDatabase.close());
  NodeAssert.equal(await ownsDatabase(process.pid, decoded.restartDatabasePath), true);
  NodeAssert.throws(() => decodeRestartPlan({ ...decoded, restartDatabasePath: undefined }));
});

test("reads replaced archives with different header sizes and file offsets", async (context) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-archive-"));
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const previous = { version: "1.0.0", buildVersion: "1.0.0", t3codeCommitHash: "a".repeat(40) };
  const current = { version: "2.0.0", buildVersion: "2.0.0", t3codeCommitHash: "b".repeat(40) };
  const first = NodePath.join(directory, "first");
  const second = NodePath.join(directory, "second");
  await NodeFSP.mkdir(first);
  await NodeFSP.mkdir(second);
  await NodeFSP.writeFile(NodePath.join(first, "package.json"), JSON.stringify(previous));
  await NodeFSP.writeFile(NodePath.join(second, "package.json"), JSON.stringify(current));
  await NodeFSP.writeFile(NodePath.join(second, "aaa.txt"), "different offsets".repeat(128));
  const archive = NodePath.join(directory, "app.asar");
  const replacement = NodePath.join(directory, "replacement.asar");
  await createPackage(first, archive);
  await createPackage(second, replacement);
  NodeAssert.deepEqual(readBuild(archive), previous);
  await NodeFSP.rename(replacement, archive);
  NodeAssert.deepEqual(readBuild(archive), current);
  NodeAssert.deepEqual(readBuild(archive), current);
});

/** Creates only the two recovery files expected from the guarded restart helper. */
async function writeRecoveryFixture(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true });
  const planPath = NodePath.join(directory, "plan.json");
  const workerPath = NodePath.join(directory, "worker.mts");
  await NodeFSP.writeFile(planPath, "saved recovery plan");
  await NodeFSP.writeFile(workerPath, "saved recovery worker");
  return { planPath, workerPath };
}

/** Checks that a refused cleanup leaves both recovery files byte-for-byte intact. */
async function assertRecoveryPreserved(fixture: Awaited<ReturnType<typeof writeRecoveryFixture>>) {
  NodeAssert.equal(await NodeFSP.readFile(fixture.planPath, "utf8"), "saved recovery plan");
  NodeAssert.equal(await NodeFSP.readFile(fixture.workerPath, "utf8"), "saved recovery worker");
}

test("cleanup removes exactly the recovery files, restart directory, and empty maintenance parent", async (context) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-cleanup-"));
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const stateRoot = NodePath.join(directory, "maintenance");
  const recoveryDirectory = NodePath.join(stateRoot, "restart-complete");
  const fixture = await writeRecoveryFixture(recoveryDirectory);
  const removedFiles = [
    await NodeFSP.realpath(fixture.workerPath),
    await NodeFSP.realpath(fixture.planPath),
  ];

  NodeAssert.deepEqual(await cleanupRestartRecovery(fixture.planPath, stateRoot), {
    status: "removed",
    removedFiles,
    restartDirectoryRemoved: true,
    maintenanceDirectoryRemoved: true,
  });
  NodeAssert.deepEqual(await NodeFSP.readdir(directory), []);
  await NodeAssert.rejects(NodeFSP.lstat(recoveryDirectory), { code: "ENOENT" });
  await NodeAssert.rejects(NodeFSP.lstat(stateRoot), { code: "ENOENT" });
});

test("cleanup preserves a non-empty maintenance parent and unrelated siblings", async (context) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-siblings-"));
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const stateRoot = NodePath.join(directory, "maintenance");
  const recoveryDirectory = NodePath.join(stateRoot, "restart-complete");
  const fixture = await writeRecoveryFixture(recoveryDirectory);
  const sibling = await writeRecoveryFixture(NodePath.join(stateRoot, "restart-pending"));
  await NodeFSP.writeFile(NodePath.join(stateRoot, "unrelated.txt"), "keep this");

  const result = await cleanupRestartRecovery(fixture.planPath, stateRoot);
  NodeAssert.equal(result.status, "removed");
  NodeAssert.equal(result.restartDirectoryRemoved, true);
  NodeAssert.equal(result.maintenanceDirectoryRemoved, false);
  await NodeAssert.rejects(NodeFSP.lstat(recoveryDirectory), { code: "ENOENT" });
  await assertRecoveryPreserved(sibling);
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(stateRoot, "unrelated.txt"), "utf8"),
    "keep this",
  );
  NodeAssert.deepEqual((await NodeFSP.readdir(stateRoot)).sort(), [
    "restart-pending",
    "unrelated.txt",
  ]);
});

test("cleanup canonicalizes the plan and maintenance root before removing the recovery directory", async (context) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-canonical-"));
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const stateRoot = NodePath.join(directory, "maintenance");
  const fixture = await writeRecoveryFixture(NodePath.join(stateRoot, "restart-complete"));
  const rootAlias = NodePath.join(directory, "maintenance-alias");
  await NodeFSP.symlink(stateRoot, rootAlias, "dir");

  const result = await cleanupRestartRecovery(fixture.planPath, rootAlias);
  NodeAssert.equal(result.status, "removed");
  NodeAssert.equal(result.maintenanceDirectoryRemoved, true);
  NodeAssert.equal((await NodeFSP.lstat(rootAlias)).isSymbolicLink(), true);
  await NodeAssert.rejects(NodeFSP.lstat(stateRoot), { code: "ENOENT" });
});

test.for(["file", "directory", "symlink"])(
  "cleanup refuses an extra %s without deleting recovery files",
  async (kind, context) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-extra-"));
    context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    const stateRoot = NodePath.join(directory, "maintenance");
    const recoveryDirectory = NodePath.join(stateRoot, "restart-extra");
    const fixture = await writeRecoveryFixture(recoveryDirectory);
    const extra = NodePath.join(recoveryDirectory, ".extra");
    if (kind === "file") await NodeFSP.writeFile(extra, "keep this");
    else if (kind === "directory") await NodeFSP.mkdir(extra);
    else await NodeFSP.symlink(fixture.planPath, extra);

    const result = await cleanupRestartRecovery(fixture.planPath, stateRoot);
    NodeAssert.equal(result.status, "error");
    NodeAssert.match(result.error ?? "", /exactly two regular files/);
    NodeAssert.deepEqual(result.removedFiles, []);
    NodeAssert.equal(result.restartDirectoryRemoved, false);
    NodeAssert.equal(result.maintenanceDirectoryRemoved, false);
    await assertRecoveryPreserved(fixture);
    await NodeFSP.lstat(extra);
    NodeAssert.deepEqual((await NodeFSP.readdir(recoveryDirectory)).sort(), [
      ".extra",
      "plan.json",
      "worker.mts",
    ]);
  },
);

test.for(["plan.json", "worker.mts"])(
  "cleanup refuses a symlinked %s even when its target is another valid recovery file",
  async (entry, context) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-symlink-"));
    context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    const stateRoot = NodePath.join(directory, "maintenance");
    const recoveryDirectory = NodePath.join(stateRoot, "restart-symlink");
    const fixture = await writeRecoveryFixture(recoveryDirectory);
    const siblingDirectory = NodePath.join(stateRoot, "restart-pending");
    const sibling = await writeRecoveryFixture(siblingDirectory);
    const link = NodePath.join(recoveryDirectory, entry);
    await NodeFSP.unlink(link);
    await NodeFSP.symlink(NodePath.join(siblingDirectory, entry), link);

    const result = await cleanupRestartRecovery(fixture.planPath, stateRoot);
    NodeAssert.equal(result.status, "error");
    NodeAssert.match(result.error ?? "", /symlink/);
    NodeAssert.deepEqual(result.removedFiles, []);
    NodeAssert.equal((await NodeFSP.lstat(link)).isSymbolicLink(), true);
    await assertRecoveryPreserved(fixture);
    await assertRecoveryPreserved(sibling);
  },
);

test("cleanup refuses a worker directory before deleting the plan or its contents", async (context) => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-verify-worker-directory-"),
  );
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const stateRoot = NodePath.join(directory, "maintenance");
  const fixture = await writeRecoveryFixture(NodePath.join(stateRoot, "restart-directory"));
  await NodeFSP.unlink(fixture.workerPath);
  await NodeFSP.mkdir(fixture.workerPath);
  const nestedFile = NodePath.join(fixture.workerPath, "keep.txt");
  await NodeFSP.writeFile(nestedFile, "keep this");

  const result = await cleanupRestartRecovery(fixture.planPath, stateRoot);
  NodeAssert.equal(result.status, "error");
  NodeAssert.deepEqual(result.removedFiles, []);
  NodeAssert.equal(await NodeFSP.readFile(fixture.planPath, "utf8"), "saved recovery plan");
  NodeAssert.equal(await NodeFSP.readFile(nestedFile, "utf8"), "keep this");
});

test("cleanup refuses plans outside the maintenance root or with the wrong directory shape", async (context) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-shape-"));
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const stateRoot = NodePath.join(directory, "maintenance");
  await NodeFSP.mkdir(stateRoot);
  for (const recoveryDirectory of [
    NodePath.join(directory, "restart-outside"),
    NodePath.join(stateRoot, "nested", "restart-nested"),
    NodePath.join(stateRoot, "unrelated"),
    NodePath.join(stateRoot, "restart-"),
  ]) {
    const fixture = await writeRecoveryFixture(recoveryDirectory);
    const result = await cleanupRestartRecovery(fixture.planPath, stateRoot);
    NodeAssert.equal(result.status, "error");
    NodeAssert.match(result.error ?? "", /directly inside a restart-\* maintenance directory/);
    NodeAssert.deepEqual(result.removedFiles, []);
    await assertRecoveryPreserved(fixture);
  }
  const alias = NodePath.join(stateRoot, "restart-alias");
  await NodeFSP.symlink(NodePath.join(directory, "restart-outside"), alias, "dir");
  const result = await cleanupRestartRecovery(NodePath.join(alias, "plan.json"), stateRoot);
  NodeAssert.equal(result.status, "error");
  NodeAssert.deepEqual(result.removedFiles, []);
  await assertRecoveryPreserved({
    planPath: NodePath.join(alias, "plan.json"),
    workerPath: NodePath.join(alias, "worker.mts"),
  });
});

test("cleanup rejects relative paths and a plan with the wrong filename", async (context) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-path-"));
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const stateRoot = NodePath.join(directory, "maintenance");
  const fixture = await writeRecoveryFixture(NodePath.join(stateRoot, "restart-wrong-name"));
  for (const [planPath, rootPath] of [
    [NodePath.relative(process.cwd(), fixture.planPath), stateRoot],
    [fixture.planPath, NodePath.relative(process.cwd(), stateRoot)],
  ] as const) {
    const result = await cleanupRestartRecovery(planPath, rootPath);
    NodeAssert.equal(result.status, "error");
    NodeAssert.match(result.error ?? "", /absolute/);
    NodeAssert.deepEqual(result.removedFiles, []);
    await assertRecoveryPreserved(fixture);
  }
  const renamed = {
    ...fixture,
    planPath: NodePath.join(NodePath.dirname(fixture.planPath), "other.json"),
  };
  await NodeFSP.rename(fixture.planPath, renamed.planPath);
  const result = await cleanupRestartRecovery(renamed.planPath, stateRoot);
  NodeAssert.equal(result.status, "error");
  NodeAssert.match(result.error ?? "", /named plan.json/);
  NodeAssert.deepEqual(result.removedFiles, []);
  await assertRecoveryPreserved(renamed);
});

test("the CLI shows help before validating --cleanup", () => {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      NodePath.join(import.meta.dirname, "local-arch-verify.ts"),
      "--help",
      "--cleanup",
    ],
    { encoding: "utf8" },
  );
  NodeAssert.ifError(result.error);
  NodeAssert.equal(result.status, 0);
  NodeAssert.match(result.stdout, /^usage: /);
  NodeAssert.equal(result.stderr, "");
});

test("the CLI rejects --cleanup outside restart with an explicit plan", () => {
  for (const args of [
    ["--cleanup"],
    ["installation", "--cleanup"],
    ["workspace", ".", "--cleanup"],
    ["restart", "--cleanup"],
  ]) {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        NodePath.join(import.meta.dirname, "local-arch-verify.ts"),
        ...args,
      ],
      { encoding: "utf8" },
    );
    NodeAssert.ifError(result.error);
    NodeAssert.equal(result.status, 1);
    NodeAssert.equal(result.stdout, "");
    NodeAssert.match(
      JSON.parse(result.stderr).error,
      /--cleanup is only supported for restart PLAN/,
    );
  }
});

test("the CLI preserves recovery files when restart verification cannot complete", async (context) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-verify-incomplete-"));
  context.onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const fixture = await writeRecoveryFixture(NodePath.join(directory, "restart-incomplete"));
  for (const cleanup of [false, true]) {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        NodePath.join(import.meta.dirname, "local-arch-verify.ts"),
        "restart",
        fixture.planPath,
        ...(cleanup ? ["--cleanup"] : []),
      ],
      { encoding: "utf8" },
    );
    NodeAssert.ifError(result.error);
    NodeAssert.equal(result.status, 1);
    NodeAssert.equal(result.stdout, "");
    const report = JSON.parse(result.stderr);
    NodeAssert.equal(typeof report.error, "string");
    NodeAssert.deepEqual(
      report.cleanup,
      cleanup
        ? {
            status: "skipped",
            reason: "restart verification did not complete",
          }
        : undefined,
    );
    await assertRecoveryPreserved(fixture);
  }
});

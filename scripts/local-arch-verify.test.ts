// @effect-diagnostics nodeBuiltinImport:off - These tests inspect disposable archives, descriptors, and child processes.

/** Exercises runtime restart proof and archive replacement without touching an installed app. */
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
  isCapturedProcess,
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

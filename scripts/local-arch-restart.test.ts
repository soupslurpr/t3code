// @effect-diagnostics nodeBuiltinImport:off - Tests use disposable databases and captured child processes.

/** Exercises restart identity, durable handoff, and installed-build guards without restarting T3. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { assert, describe, expect, it } from "@effect/vitest";

import { verifyInstalledBuild } from "./local-arch-restart.ts";
import {
  captureProcess,
  isSameProcess,
  launchEnvironment,
  parseProcessStat,
  captureRestartContinuation,
  verifyDesktopOwnership,
  verifyRestartContinuation,
  verifyUnitMembership,
  waitForShutdown,
} from "./local-arch-restart-worker.ts";

/** Waits for a child-process lifecycle receipt and removes the paired error listener. */
function childEvent(child: NodeChildProcess.ChildProcess, event: "spawn" | "exit"): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      child.removeListener(event, completed);
      reject(error);
    };
    const completed = () => {
      child.removeListener("error", failed);
      resolve();
    };
    child.once(event, completed);
    child.once("error", failed);
  });
}

/** Creates a disposable database outside all T3 data directories. */
function databaseFixture(filename = "statev2.sqlite") {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-restart-test-"));
  const databasePath = NodePath.join(directory, filename);
  const database = new NodeSqlite.DatabaseSync(databasePath);
  return {
    database,
    databasePath,
    restartDatabasePath: NodePath.join(directory, "statev2.sqlite"),
    [Symbol.dispose]: () => {
      database.close();
      NodeFS.rmSync(directory, { recursive: true });
    },
  };
}

/** Creates the V2 records consumed by startup recovery, including session bindings and attempts. */
function activeRunFixture() {
  const fixture = databaseFixture();
  const settingsPath = NodePath.join(NodePath.dirname(fixture.databasePath), "settings.json");
  NodeFS.writeFileSync(settingsPath, JSON.stringify({ continueThreadsAfterServerUpdate: true }));
  fixture.database.exec(`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER,
      provider_thread_id TEXT, status TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY, provider_session_id TEXT, status TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_sessions (
      provider_session_id TEXT PRIMARY KEY, status TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_session_bindings (
      provider_session_id TEXT, thread_id TEXT, PRIMARY KEY (provider_session_id, thread_id)
    );
    CREATE TABLE orchestration_v2_projection_run_attempts (
      attempt_id TEXT PRIMARY KEY, run_id TEXT, thread_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY, provider_thread_id TEXT,
      run_attempt_id TEXT, thread_id TEXT, status TEXT
    );
    INSERT INTO orchestration_v2_projection_threads VALUES (
      'same-thread', 'same-project', NULL, NULL, '{"providerInstanceId":"codex"}'
    );
    INSERT INTO orchestration_v2_projection_runs VALUES (
      'active-run', 'same-thread', 1, 'root-provider-thread', 'running',
      '{"providerInstanceId":"codex","activeAttemptId":"active-attempt"}'
    );
    INSERT INTO orchestration_v2_projection_provider_threads VALUES (
      'root-provider-thread', 'provider-session', 'active',
      '{"appThreadId":"same-thread","ownerNodeId":null,"providerInstanceId":"codex","driver":"codex", "nativeThreadRef":{"driver":"codex","nativeId":"native-thread","strength":"strong"}}'
    );
    INSERT INTO orchestration_v2_projection_provider_sessions VALUES (
      'provider-session', 'ready', '{"providerInstanceId":"codex","driver":"codex"}'
    );
    INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES ('provider-session', 'same-thread');
    INSERT INTO orchestration_v2_projection_run_attempts VALUES ('active-attempt', 'active-run', 'same-thread');
    INSERT INTO orchestration_v2_projection_provider_turns VALUES (
      'active-turn', 'root-provider-thread', 'active-attempt', 'same-thread', 'running'
    );
  `);
  return { ...fixture, settingsPath };
}

/** Creates a running legacy thread whose one-time monitor will be copied on first V2 launch. */
function migrationFixture() {
  const fixture = databaseFixture("state.sqlite");
  fixture.database.exec(`
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT, active_turn_id TEXT);
    CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY, status TEXT, runtime_payload_json TEXT
    );
    CREATE TABLE thread_monitors (
      monitor_id TEXT PRIMARY KEY, thread_id TEXT, condition_type TEXT, wake_at TEXT,
      continuation_mode TEXT, resume_prompt TEXT, status TEXT, delivered_at TEXT, cancelled_at TEXT
    );
    INSERT INTO projection_threads VALUES ('same-thread', 'same-project', NULL, NULL);
    INSERT INTO projection_thread_sessions VALUES ('same-thread', 'running', 'legacy-turn');
    INSERT INTO provider_session_runtime VALUES ('same-thread', 'running', '{"activeTurnId":"legacy-turn"}');
    INSERT INTO thread_monitors VALUES (
      'migration-monitor', 'same-thread', 'time', '2030-01-01T00:00:00.000Z',
      'resume-thread', 'Continue the saved deployment handoff.', 'active', NULL, NULL
    );
  `);
  return fixture;
}

const nativeContinuation = {
  type: "active-run" as const,
  runId: "active-run",
  attemptId: "active-attempt",
  providerThreadId: "root-provider-thread",
  providerSessionId: "provider-session",
  providerTurnId: "active-turn",
  nativeThreadId: "native-thread",
};

function capture(fixture: ReturnType<typeof databaseFixture>, migrationMonitorId?: string) {
  return captureRestartContinuation(
    fixture.databasePath,
    fixture.restartDatabasePath,
    "same-thread",
    migrationMonitorId,
  );
}

function handoff(fixture: ReturnType<typeof databaseFixture>, migrationMonitorId?: string) {
  return {
    sourceDatabasePath: fixture.databasePath,
    restartDatabasePath: fixture.restartDatabasePath,
    threadId: "same-thread",
    continuation: capture(fixture, migrationMonitorId),
  };
}

/** Describes one app and backend in an active user unit. */
function unitMembershipFixture(unit: string) {
  const controlGroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;
  return {
    unit,
    appPid: 42,
    properties: `Id=${unit}\nActiveState=active\nControlGroup=${controlGroup}${unit.endsWith(".service") ? "\nMainPID=42" : ""}`,
    appCgroup: `1:net_cls:/\n0::${controlGroup}\n`,
    backendCgroup: `1:net_cls:/\n0::${controlGroup}\n`,
  };
}

describe("guarded restart", () => {
  it("captures the V2 run and native identity without writing state or settings", () => {
    using fixture = activeRunFixture();
    const before = NodeFS.readFileSync(fixture.databasePath);
    const settingsBefore = NodeFS.readFileSync(fixture.settingsPath);
    assert.deepEqual(capture(fixture), nativeContinuation);
    verifyRestartContinuation(handoff(fixture));
    assert.deepEqual(NodeFS.readFileSync(fixture.databasePath), before);
    assert.deepEqual(NodeFS.readFileSync(fixture.settingsPath), settingsBefore);
    assert.throws(
      () =>
        captureRestartContinuation(
          fixture.databasePath,
          fixture.restartDatabasePath,
          "other-thread",
        ),
      "no V2 runtime state",
    );
  });

  it.each([{}, null])("uses default continuation for sparse settings %j", (settings) => {
    using fixture = activeRunFixture();
    if (settings === null) NodeFS.rmSync(fixture.settingsPath);
    else NodeFS.writeFileSync(fixture.settingsPath, JSON.stringify(settings));
    assert.deepEqual(capture(fixture), nativeContinuation);
  });

  it.each([
    { environment: false, project: true, enabled: true },
    { environment: true, project: false, enabled: false },
    { environment: true, project: undefined, enabled: true },
    { environment: undefined, project: false, enabled: false },
    { environment: undefined, project: undefined, enabled: true },
    { environment: false, project: undefined, enabled: false },
  ])(
    "resolves the running project's restart preference: %j",
    ({ environment, project, enabled }) => {
      using fixture = activeRunFixture();
      NodeFS.writeFileSync(
        fixture.settingsPath,
        JSON.stringify({
          continueThreadsAfterServerUpdate: environment,
          projectSettingsOverrides: {
            "same-project": { continueThreadsAfterServerUpdate: project },
            "other-project": { continueThreadsAfterServerUpdate: !enabled },
          },
        }),
      );
      if (enabled) assert.deepEqual(capture(fixture), nativeContinuation);
      else assert.throws(() => capture(fixture), "not enabled");
    },
  );

  it.each([
    [
      "UPDATE orchestration_v2_projection_threads SET archived_at = '2030-01-01'",
      "thread is archived",
    ],
    [
      "UPDATE orchestration_v2_projection_threads SET deleted_at = '2030-01-01'",
      "thread is deleted",
    ],
    ["DELETE FROM orchestration_v2_projection_runs", "no V2 run"],
    [
      "UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.providerInstanceId', 'claude')",
      "thread provider changed",
    ],
    ["UPDATE orchestration_v2_projection_runs SET status = 'completed'", "keep the V2 run running"],
    ["UPDATE orchestration_v2_projection_runs SET status = 'starting'", "keep the V2 run running"],
    [
      "UPDATE orchestration_v2_projection_runs SET payload_json = json_remove(payload_json, '$.activeAttemptId')",
      "no active attempt",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.appThreadId', 'other-thread')",
      "belongs to another app thread",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.ownerNodeId', 'subagent-node')",
      "not the root run",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.providerInstanceId', 'other')",
      "instance does not match",
    ],
    ["UPDATE orchestration_v2_projection_provider_threads SET status = 'idle'", "not active"],
    [
      "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef.strength', 'weak')",
      "no strong native identity",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef.driver', 'claude')",
      "native thread driver does not match",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_remove(payload_json, '$.nativeThreadRef.nativeId')",
      "no native resume identity",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_sessions SET status = 'stopped'",
      "stopped or failed",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_sessions SET status = 'error'",
      "stopped or failed",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_sessions SET payload_json = json_set(payload_json, '$.driver', 'claude')",
      "session driver does not match",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_sessions SET payload_json = json_set(payload_json, '$.providerInstanceId', 'other')",
      "session instance does not match",
    ],
    [
      "DELETE FROM orchestration_v2_projection_provider_session_bindings",
      "not bound to the thread",
    ],
    [
      "UPDATE orchestration_v2_projection_run_attempts SET run_id = 'older-run'",
      "no matching running provider turn",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_turns SET run_attempt_id = 'old-attempt'",
      "no matching running provider turn",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_turns SET provider_thread_id = 'subagent-thread'",
      "no matching running provider turn",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_turns SET thread_id = 'other-thread'",
      "no matching running provider turn",
    ],
    [
      "UPDATE orchestration_v2_projection_provider_turns SET status = 'completed'",
      "no matching running provider turn",
    ],
  ])("rejects unrecoverable V2 state: %s", (sql, reason) => {
    using fixture = activeRunFixture();
    fixture.database.exec(sql);
    assert.throws(() => capture(fixture), reason);
  });

  it.each(["starting", "ready", "running", "waiting"])(
    "matches recovery for a live turn with session status %s",
    (status) => {
      using fixture = activeRunFixture();
      fixture.database
        .prepare("UPDATE orchestration_v2_projection_provider_sessions SET status = ?")
        .run(status);
      assert.deepEqual(capture(fixture), nativeContinuation);
    },
  );

  it("uses the latest run and ignores copied V1 sessions", () => {
    using fixture = activeRunFixture();
    fixture.database.exec(`
      CREATE TABLE projection_thread_sessions (thread_id TEXT, status TEXT, active_turn_id TEXT);
      CREATE TABLE provider_session_runtime (thread_id TEXT, status TEXT, resume_cursor_json TEXT, runtime_payload_json TEXT);
      INSERT INTO projection_thread_sessions VALUES ('same-thread', 'running', 'stale-turn');
      INSERT INTO provider_session_runtime VALUES ('same-thread', 'running', '{"sessionId":"old"}', '{"activeTurnId":"stale-turn"}');
    `);
    assert.deepEqual(capture(fixture), nativeContinuation);
    fixture.database.exec(`
      INSERT INTO orchestration_v2_projection_runs VALUES (
        'newer-run', 'same-thread', 2, 'root-provider-thread', 'completed',
        '{"providerInstanceId":"codex","activeAttemptId":"newer-attempt"}'
      );
    `);
    assert.throws(() => capture(fixture), "keep the V2 run running");
  });

  it.each([
    "UPDATE orchestration_v2_projection_provider_turns SET provider_turn_id = 'new-turn'",
    "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef.nativeId', 'new-native-thread')",
    `UPDATE orchestration_v2_projection_runs SET run_id = 'new-run';
     UPDATE orchestration_v2_projection_run_attempts SET run_id = 'new-run';`,
    `UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.activeAttemptId', 'new-attempt');
     UPDATE orchestration_v2_projection_run_attempts SET attempt_id = 'new-attempt';
     UPDATE orchestration_v2_projection_provider_turns SET run_attempt_id = 'new-attempt';`,
  ])("refuses changed captured V2 work: %s", (sql) => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    fixture.database.exec(sql);
    assert.throws(() => verifyRestartContinuation(plan), "continuation changed");
  });

  it.each(["active", "triggered"])(
    "accepts an undelivered %s time monitor for the first V2 launch",
    (status) => {
      using fixture = migrationFixture();
      fixture.database.prepare("UPDATE thread_monitors SET status = ?").run(status);
      const before = NodeFS.readFileSync(fixture.databasePath);
      assert.deepEqual(capture(fixture, "migration-monitor"), {
        type: "migration-monitor",
        monitorId: "migration-monitor",
        turnId: "legacy-turn",
        wakeAt: "2030-01-01T00:00:00.000Z",
      });
      verifyRestartContinuation(handoff(fixture, "migration-monitor"));
      assert.deepEqual(NodeFS.readFileSync(fixture.databasePath), before);
      assert.isFalse(NodeFS.existsSync(fixture.restartDatabasePath));
    },
  );

  it("requires an explicit migration monitor instead of promising native V1 continuation", () => {
    using fixture = migrationFixture();
    assert.throws(() => capture(fixture), "first V2 upgrade needs --migration-monitor");
    assert.throws(() => capture(fixture, "missing-monitor"), "does not exist");
  });

  it.each([
    ["UPDATE projection_threads SET archived_at = '2030-01-01'", "thread is archived"],
    ["UPDATE projection_threads SET deleted_at = '2030-01-01'", "thread is deleted"],
    ["UPDATE projection_thread_sessions SET status = 'ready'", "keep the V1 thread running"],
    ["UPDATE projection_thread_sessions SET active_turn_id = NULL", "no active turn"],
    ["UPDATE provider_session_runtime SET status = 'stopped'", "not running"],
    ["UPDATE provider_session_runtime SET runtime_payload_json = '{}'", "records disagree"],
    ["UPDATE thread_monitors SET thread_id = 'other-thread'", "belongs to another thread"],
    ["UPDATE thread_monitors SET condition_type = 'signal'", "time condition"],
    ["UPDATE thread_monitors SET continuation_mode = 'record-only'", "must resume the thread"],
    ["UPDATE thread_monitors SET status = 'delivered'", "no longer pending"],
    ["UPDATE thread_monitors SET status = 'cancelled'", "no longer pending"],
    ["UPDATE thread_monitors SET status = 'failed'", "no longer pending"],
    ["UPDATE thread_monitors SET delivered_at = '2030-01-01'", "already delivered"],
    ["UPDATE thread_monitors SET cancelled_at = '2030-01-01'", "was cancelled"],
    ["UPDATE thread_monitors SET wake_at = NULL", "no deadline"],
    ["UPDATE thread_monitors SET wake_at = 'not-a-time'", "invalid deadline"],
    ["UPDATE thread_monitors SET resume_prompt = NULL", "no resume prompt"],
  ])("rejects an unsafe migration handoff: %s", (sql, reason) => {
    using fixture = migrationFixture();
    fixture.database.exec(sql);
    assert.throws(() => capture(fixture, "migration-monitor"), reason);
  });

  it("refuses a changed V1 turn before executing the migration handoff", () => {
    using fixture = migrationFixture();
    const plan = handoff(fixture, "migration-monitor");
    fixture.database.exec(`
      UPDATE projection_thread_sessions SET active_turn_id = 'new-legacy-turn';
      UPDATE provider_session_runtime SET runtime_payload_json = '{"activeTurnId":"new-legacy-turn"}';
    `);
    assert.throws(() => verifyRestartContinuation(plan), "continuation changed");
  });

  it.each(["file", "dangling-symlink"])(
    "rejects migration when the V2 destination exists as a %s",
    (kind) => {
      using fixture = migrationFixture();
      const plan = handoff(fixture, "migration-monitor");
      if (kind === "file") NodeFS.writeFileSync(fixture.restartDatabasePath, "existing V2 state");
      else NodeFS.symlinkSync("missing.sqlite", fixture.restartDatabasePath);
      assert.throws(() => verifyRestartContinuation(plan), "statev2.sqlite already exists");
    },
  );

  it("rejects the wrong restart database and migration mode on V2 state", () => {
    using fixture = activeRunFixture();
    assert.throws(
      () =>
        captureRestartContinuation(
          fixture.databasePath,
          `${fixture.restartDatabasePath}.other`,
          "same-thread",
        ),
      "restart must use statev2.sqlite",
    );
    assert.throws(() => capture(fixture, "monitor"), "requires the original state.sqlite");
  });

  it("runs the copied worker's guard outside the checkout with only Node builtins", () => {
    using fixture = activeRunFixture();
    const directory = NodePath.dirname(fixture.databasePath);
    const worker = NodePath.join(directory, "worker.mts");
    NodeFS.copyFileSync(NodePath.join(import.meta.dirname, "local-arch-restart-worker.ts"), worker);
    const result = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { captureRestartContinuation } = await import(process.argv[1]);
       process.stdout.write(JSON.stringify(captureRestartContinuation(...process.argv.slice(2))));`,
        NodeURL.pathToFileURL(worker).href,
        fixture.databasePath,
        fixture.restartDatabasePath,
        "same-thread",
      ],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.deepEqual(JSON.parse(result), nativeContinuation);
  });

  it("requires exact installed version and a sufficiently precise source pin", () => {
    const build = { version: "1.0.0", buildVersion: "1.0.0", t3codeCommitHash: "a".repeat(12) };
    verifyInstalledBuild(JSON.stringify(build), "1.0.0", "a".repeat(40));
    assert.throws(
      () => verifyInstalledBuild(JSON.stringify(build), "1.0.1", "a".repeat(40)),
      "version mismatch",
    );
    assert.throws(
      () => verifyInstalledBuild(JSON.stringify(build), "1.0.0", "b".repeat(40)),
      "commit mismatch",
    );
    assert.throws(
      () =>
        verifyInstalledBuild(
          JSON.stringify({ ...build, t3codeCommitHash: "a" }),
          "1.0.0",
          "a".repeat(40),
        ),
      "commit mismatch",
    );
  });

  it.each([{ type: "monitor", monitorId: "retired-monitor" }, { type: "active-turn" }])(
    "rejects a saved plan without a captured active turn: %j",
    (continuation) => {
      using fixture = activeRunFixture();
      const plan = JSON.parse(
        JSON.stringify({
          sourceDatabasePath: fixture.databasePath,
          restartDatabasePath: fixture.restartDatabasePath,
          threadId: "same-thread",
          continuation,
        }),
      );
      assert.throws(() => verifyRestartContinuation(plan));
    },
  );

  it("parses process names containing spaces and closing parentheses", () => {
    const stat = `123 (odd ) name) S 42 ${Array.from({ length: 17 }, () => "0").join(" ")} 456`;
    assert.deepEqual(parseProcessStat(stat), { state: "S", parentPid: 42, startTicks: "456" });
    assert.throws(() => parseProcessStat("invalid"), "invalid process start ticks");
  });

  it.skipIf(!NodeFS.existsSync("/proc/self/stat"))(
    "distinguishes live, recycled, and exited process identities",
    async () => {
      const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      await childEvent(child, "spawn");
      assert.isDefined(child.pid);
      try {
        const { startTicks } = parseProcessStat(
          NodeFS.readFileSync(`/proc/${child.pid}/stat`, "utf8"),
        );
        const identity = { pid: child.pid!, startTicks };
        assert.isTrue(isSameProcess(identity));
        assert.isFalse(isSameProcess({ ...identity, startTicks: String(BigInt(startTicks) + 1n) }));
        assert.throws(() => captureProcess(identity.pid), "not the installed desktop executable");
        const exited = childEvent(child, "exit");
        child.stdin!.end();
        await exited;
        assert.isFalse(isSameProcess(identity));
        await expect(waitForShutdown([identity])).resolves.toBeUndefined();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = childEvent(child, "exit");
          child.kill("SIGTERM");
          await exited;
        }
      }
    },
  );

  it.each(["desktop.service", "app-t3code-42.scope"])(
    "accepts an app and backend owned by %s",
    (unit) => {
      const fixture = unitMembershipFixture(unit);
      verifyUnitMembership(fixture);
      verifyUnitMembership({
        ...fixture,
        appCgroup: fixture.appCgroup.replace("0::", "2:name=systemd:"),
        backendCgroup: fixture.backendCgroup.replace("0::", "2:name=systemd:"),
      });
    },
  );

  it("rejects the wrong service main process even within the same control group", () => {
    assert.throws(
      () => verifyUnitMembership({ ...unitMembershipFixture("desktop.service"), appPid: 43 }),
      "service main process changed",
    );
  });

  it("accepts a GNOME app scope while its backend remains in the launch service", () => {
    const app = unitMembershipFixture("app-t3code-42.scope");
    const backend = unitMembershipFixture("restart.service");
    const membership = { ...app, backendCgroup: backend.backendCgroup };
    assert.throws(() => verifyUnitMembership(membership), "no longer owns");
    verifyUnitMembership({
      ...membership,
      backendUnit: { name: backend.unit, properties: backend.properties },
    });
  });

  it("rejects a separate backend unit that changed identity or ownership", () => {
    const app = unitMembershipFixture("app-t3code-42.scope");
    const backend = unitMembershipFixture("restart.service");
    for (const properties of [
      backend.properties.replace("MainPID=42", "MainPID=43"),
      backend.properties.replace("ActiveState=active", "ActiveState=inactive"),
      backend.properties.replace("Id=restart.service", "Id=other.service"),
      backend.properties.replace("/app.slice/restart.service", "/app.slice/other.service"),
    ]) {
      assert.throws(() =>
        verifyUnitMembership({
          ...app,
          backendCgroup: backend.backendCgroup,
          backendUnit: { name: backend.unit, properties },
        }),
      );
    }
  });

  it.each(["appCgroup", "backendCgroup"] as const)(
    "rejects a scope whose %s belongs to another unit",
    (field) => {
      const fixture = unitMembershipFixture("app-t3code-42.scope");
      assert.throws(
        () =>
          verifyUnitMembership({
            ...fixture,
            [field]: fixture[field].replace("app-t3code-42.scope", "other.scope"),
          }),
        "no longer owns",
      );
    },
  );

  it("rejects missing, inactive, renamed, and ungrouped units", () => {
    const fixture = unitMembershipFixture("app-t3code-42.scope");
    for (const properties of [
      "",
      fixture.properties.replace("ActiveState=active", "ActiveState=inactive"),
      fixture.properties.replace("Id=app-t3code-42.scope", "Id=other.scope"),
      "Id=app-t3code-42.scope\nActiveState=active\nControlGroup=",
      "Id=app-t3code-42.scope\nActiveState=active\nControlGroup=/",
    ]) {
      assert.throws(() => verifyUnitMembership({ ...fixture, properties }));
    }
  });

  it.each(["*.service", "*.scope", "--all", "desktop.socket"])(
    "rejects ambiguous or unsupported target %s before inspecting any process",
    (unit) => {
      assert.throws(
        () =>
          verifyDesktopOwnership({
            unit,
            app: { pid: 10, startTicks: "1" },
            backend: { pid: 11, startTicks: "2" },
            sourceDatabasePath: "/unused",
          }),
        "invalid user unit name",
      );
    },
  );

  it("rejects an ambiguous backend unit before inspecting any process", () => {
    assert.throws(
      () =>
        verifyDesktopOwnership({
          unit: "app-t3code-42.scope",
          backendUnit: "*.service",
          app: { pid: 10, startTicks: "1" },
          backend: { pid: 11, startTicks: "2" },
          sourceDatabasePath: "/unused",
        }),
      "invalid user unit name",
    );
  });

  it("removes development state overrides but preserves the original app's state location", () => {
    assert.deepEqual(
      launchEnvironment(
        {
          DISPLAY: ":0",
          ELECTRON_RUN_AS_NODE: "1",
          APPDIR: "/old",
          T3CODE_HOME: "/test",
          T3CODE_PORT: "9999",
          XDG_CONFIG_HOME: "/test/config",
          OPTIONAL: undefined,
        },
        {},
      ),
      { DISPLAY: ":0" },
    );
    assert.equal(
      launchEnvironment({ T3CODE_HOME: "/wrong" }, { T3CODE_HOME: "/original" }).T3CODE_HOME,
      "/original",
    );
    assert.throws(
      () => launchEnvironment({}, { SECRET_TOKEN: "not-allowed" }),
      "unexpected app environment override",
    );
  });
});

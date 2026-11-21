// @effect-diagnostics nodeBuiltinImport:off - Tests use disposable databases and captured child processes.

/** Exercises restart identity, durable handoff, and installed-build guards without restarting T3. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  activeRunFixture,
  capture,
  handoff,
  migrationFixture,
  nativeContinuation,
} from "./arch/restartTestkit.ts";
import * as NodeURL from "node:url";

import { assert, describe, expect, it } from "@effect/vitest";

import {
  pacmanUpgradeArguments,
  parseRestartDelaySeconds,
  verifyInstalledBuild,
  writeRestartWorker,
} from "./local-arch-restart.ts";
import {
  captureProcess,
  hashInstalledFile,
  isSameProcess,
  launchEnvironment,
  parseProcessStat,
  captureRestartContinuation,
  verifyDesktopOwnership,
  verifyRestartContinuation,
  verifyUnitMembership,
  waitForVerifiedShutdown,
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

/** Describes one app and backend in an active user unit. */
function unitMembershipFixture(unit: string) {
  const controlGroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;
  return {
    unit,
    appPid: 42,
    properties: `Id=${unit}\nActiveState=active\nControlGroup=${controlGroup}${unit.endsWith(".service") ? "\nMainPID=42\nRestart=no" : ""}`,
    appCgroup: `1:net_cls:/\n0::${controlGroup}\n`,
    backendCgroup: `1:net_cls:/\n0::${controlGroup}\n`,
  };
}

describe("guarded restart", () => {
  it("validates restart delay bounds and prints usage for --help without side effects", () => {
    expect(parseRestartDelaySeconds(undefined)).toBe(60);
    expect(parseRestartDelaySeconds("10")).toBe(10);
    expect(parseRestartDelaySeconds("600")).toBe(600);
    for (const invalid of ["", "0", "-5", "1.5", "601", "10s"]) {
      expect(() => parseRestartDelaySeconds(invalid)).toThrow();
    }
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "local-arch-restart.ts"), "--help"],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--package <path>");
    expect(result.stdout).toContain("--apply");
  });

  it("captures the V2 run and native identity without writing state or settings", () => {
    using fixture = activeRunFixture();
    const before = NodeFS.readFileSync(fixture.databasePath);
    const settingsBefore = NodeFS.readFileSync(fixture.settingsPath);
    assert.deepEqual(capture(fixture), nativeContinuation);
    verifyRestartContinuation(handoff(fixture), fixture.policyPath);
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

  it.each([
    null,
    "{}",
    "{ // default enabled\n }",
    '{"continueThreadsAfterServerUpdate":false,"projectSettingsOverrides":{"same-project":{"continueThreadsAfterServerUpdate":true}}}',
  ])("accepts effective restart settings %j", (settings) => {
    using fixture = activeRunFixture();
    if (settings === null) NodeFS.rmSync(fixture.settingsPath);
    else NodeFS.writeFileSync(fixture.settingsPath, settings);
    assert.deepEqual(capture(fixture), nativeContinuation);
  });

  it.each([
    "invalid JSON",
    '{"continueThreadsAfterServerUpdate":false}',
    '{"addProjectBaseDirectory":123}',
    '{"projectSettingsOverrides":{"same-project":{"continueThreadsAfterServerUpdate":false}}}',
    '{"providerInstances":{"codex":{"driver":"codex","enabled":false,"config":{}}}}',
  ])("rejects disabled or invalid effective settings at scheduling and at handoff: %s", (raw) => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    NodeFS.writeFileSync(fixture.settingsPath, raw);
    assert.throws(() => capture(fixture));
    assert.throws(() => verifyRestartContinuation(plan, fixture.policyPath));
  });

  it("retains a legacy provider enabled by persisted session history until the operator disables it", () => {
    using fixture = activeRunFixture();
    fixture.database.exec(`
      UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.providerInstanceId','cursor');
      UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.providerInstanceId','cursor');
      UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,
        '$.providerInstanceId','cursor','$.driver','cursor','$.nativeThreadRef.driver','cursor');
      UPDATE orchestration_v2_projection_provider_sessions SET payload_json=json_set(payload_json,
        '$.providerInstanceId','cursor','$.driver','cursor');
      UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.nativeItemRef.driver','cursor');
      CREATE TABLE projection_thread_sessions (provider_name TEXT, provider_instance_id TEXT);
      CREATE TABLE provider_session_runtime (provider_name TEXT, provider_instance_id TEXT);
      INSERT INTO projection_thread_sessions VALUES ('cursor',NULL)`);
    NodeFS.writeFileSync(fixture.settingsPath, '{"providers":{}}');
    const plan = handoff(fixture);
    NodeFS.writeFileSync(fixture.settingsPath, '{"providers":{"cursor":{"enabled":false}}}');
    assert.throws(() => verifyRestartContinuation(plan, fixture.policyPath), "disabled");
  });

  it("applies managed defaults and locks after project overrides and rereads policy for the worker", () => {
    using fixture = activeRunFixture();
    const policy = (locked: boolean, value: boolean) =>
      NodeFS.writeFileSync(
        fixture.policyPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: "Test",
          settings: { continueThreadsAfterServerUpdate: { value, locked } },
        }),
      );
    policy(false, false);
    const plan = handoff(fixture);
    NodeFS.rmSync(fixture.settingsPath);
    assert.throws(() => verifyRestartContinuation(plan, fixture.policyPath), "disabled");
    NodeFS.writeFileSync(
      fixture.settingsPath,
      JSON.stringify({
        projectSettingsOverrides: {
          "same-project": { continueThreadsAfterServerUpdate: true },
        },
      }),
    );
    assert.deepEqual(capture(fixture), nativeContinuation);
    policy(true, false);
    assert.throws(() => capture(fixture), "disabled");
    assert.throws(() => verifyRestartContinuation(plan, fixture.policyPath), "disabled");
    policy(true, true);
    NodeFS.writeFileSync(fixture.settingsPath, '{"continueThreadsAfterServerUpdate":false}');
    verifyRestartContinuation(plan, fixture.policyPath);
  });

  it.each([
    [{ providers: { allowedDrivers: ["claudeAgent"] } }, "disabled"],
    [{ maxRuntimeMode: "auto-accept-edits" }, "ceiling"],
  ] as const)("rejects a thread outside managed limits %j", (limits, message) => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    NodeFS.writeFileSync(
      fixture.policyPath,
      JSON.stringify({ schemaVersion: 1, organization: "Test", limits }),
    );
    assert.throws(() => verifyRestartContinuation(plan, fixture.policyPath), message);
  });

  it("accepts nonblocking prompts, unrelated old requests and a snooze that has elapsed", () => {
    using fixture = activeRunFixture();
    fixture.database.exec(`
      UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,'$.snoozedUntil','2000-01-01T00:00:00Z');
      INSERT INTO orchestration_v2_projection_runtime_requests VALUES
        ('same-thread','auth_refresh','pending','active-turn','{}'),
        ('same-thread','dynamic_tool_call','pending','active-turn','{}'),
        ('same-thread','user_input','pending','active-turn','{"responseCapability":{"type":"message"}}'),
        ('same-thread','approval','expired','earlier-turn','{"responseCapability":{"type":"not_resumable"}}');
      INSERT INTO orchestration_v2_projection_turn_items (thread_id,run_id,type,payload_json) VALUES ('same-thread','earlier-run','run_interrupt_request','{}');
    `);
    assert.deepEqual(capture(fixture), nativeContinuation);
  });

  it.each([
    [
      "UPDATE orchestration_v2_projection_threads SET archived_at = '2030-01-01'",
      "thread is archived",
    ],
    [
      "UPDATE orchestration_v2_projection_threads SET deleted_at = '2030-01-01'",
      "thread is deleted",
    ],
    [
      "UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.settledOverride', 'settled')",
      "thread is settled",
    ],
    [
      "UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.snoozedUntil', '2099-01-01T00:00:00.000Z')",
      "thread is snoozed",
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

  it.each([
    [
      "INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('same-thread','user_input','pending','active-turn','{\"responseCapability\":{\"type\":\"native\"}}')",
      "awaiting a response",
    ],
    [
      "INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('same-thread','approval','expired','active-turn','{\"responseCapability\":{\"type\":\"not_resumable\"}}')",
      "awaiting a response",
    ],
    [
      "INSERT INTO orchestration_v2_projection_turn_items (thread_id,run_id,type,payload_json) VALUES ('same-thread','active-run','secret_request','{\"secretStatus\":\"pending\"}')",
      "awaiting a secret",
    ],
    [
      "INSERT INTO orchestration_v2_projection_turn_items (thread_id,run_id,type,payload_json) VALUES ('same-thread','active-run','run_interrupt_request','{}')",
      "stop was requested",
    ],
    [
      "UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', '  /COMPACT  ')",
      "maintenance command",
    ],
    [
      "INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,provider_thread_id,run_attempt_id,thread_id,status,ordinal) VALUES ('newer','root-provider-thread','active-attempt','same-thread','interrupted',2)",
      "latest provider turn",
    ],
    [
      `UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,
       '$.lineage',json('{"relationshipToParent":"subagent","parentThreadId":"parent"}'),
       '$.forkedFrom',json('{"type":"node","nodeId":"delegation"}'));
       INSERT INTO orchestration_v2_projection_subagents VALUES ('parent','delegation','parent-run','running','{"result":null}');
       INSERT INTO orchestration_v2_projection_turn_items (thread_id,run_id,type,payload_json) VALUES ('parent','parent-run','run_interrupt_request','{}')`,
      "stop was requested",
    ],
  ])("refuses a newly ineligible handoff before signalling: %s", (sql, reason) => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    fixture.database.exec(sql);
    assert.throws(() => verifyRestartContinuation(plan, fixture.policyPath), reason);
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

  it("uses the latest executed run and ignores copied V1 sessions", () => {
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
        'newer-run', 'same-thread', 2, 'root-provider-thread', 'completed', NULL,
        '{"providerInstanceId":"codex","activeAttemptId":"newer-attempt","startedAt":"2030-01-01T00:00:01.000Z"}'
      );
    `);
    assert.throws(() => capture(fixture), "keep the V2 run running");
  });

  it.each(["cancelled", "queued"])(
    "keeps the active run behind newer never-started %s inputs",
    (status) => {
      using fixture = activeRunFixture();
      const plan = handoff(fixture);
      fixture.database
        .prepare(`WITH RECURSIVE ordinals(ordinal) AS (
          SELECT 2 UNION ALL SELECT ordinal + 1 FROM ordinals WHERE ordinal < 6
        ) INSERT INTO orchestration_v2_projection_runs
          SELECT 'input-' || ordinal, 'same-thread', ordinal, NULL, ?,
            CASE WHEN ? = 'cancelled' THEN '2030-01-01T00:01:00.000Z' END,
            '{"providerInstanceId":"codex","activeAttemptId":null,"startedAt":null}'
          FROM ordinals`)
        .run(status, status);
      assert.deepEqual(capture(fixture), nativeContinuation);
      verifyRestartContinuation(plan, fixture.policyPath);
    },
  );

  it("matches recovery when an unfinished run executes after higher-ordinal completed work", () => {
    using fixture = activeRunFixture();
    fixture.database.exec(`
      INSERT INTO orchestration_v2_projection_runs VALUES (
        'earlier-executed-run', 'same-thread', 2, 'root-provider-thread', 'completed',
        '2029-12-31T23:59:59.000Z',
        '{"providerInstanceId":"codex","activeAttemptId":"earlier-attempt","startedAt":"2029-12-31T23:59:58.000Z","completedAt":"2029-12-31T23:59:59.000Z"}'
      );
    `);
    assert.deepEqual(capture(fixture), nativeContinuation);
  });

  it("rejects multiple running V2 runs instead of choosing one by ordinal", () => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    fixture.database.exec(`
      INSERT INTO orchestration_v2_projection_runs VALUES (
        'second-run', 'same-thread', 2, 'root-provider-thread', 'running', NULL,
        '{"providerInstanceId":"codex","activeAttemptId":"second-attempt","startedAt":"2030-01-01T00:01:00.000Z","completedAt":null}'
      );
      INSERT INTO orchestration_v2_projection_run_attempts VALUES ('second-attempt', 'second-run', 'same-thread');
      INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, provider_thread_id, run_attempt_id, thread_id, status) VALUES (
        'second-turn', 'root-provider-thread', 'second-attempt', 'same-thread', 'running'
      );
    `);
    assert.throws(() => capture(fixture), "multiple running V2 runs");
    assert.throws(
      () => verifyRestartContinuation(plan, fixture.policyPath),
      "multiple running V2 runs",
    );
  });

  it("rejects multiple running provider turns for the captured attempt", () => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    fixture.database.exec(`
      INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, provider_thread_id, run_attempt_id, thread_id, status) VALUES (
        'second-turn', 'root-provider-thread', 'active-attempt', 'same-thread', 'running'
      );
    `);
    assert.throws(() => capture(fixture), "multiple matching running provider turns");
    assert.throws(
      () => verifyRestartContinuation(plan, fixture.policyPath),
      "multiple matching running provider turns",
    );
  });

  it.each([
    `UPDATE orchestration_v2_projection_provider_turns SET provider_turn_id = 'new-turn';
     UPDATE orchestration_v2_projection_turn_items SET provider_turn_id = 'new-turn';`,
    "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef.nativeId', 'new-native-thread')",
    `UPDATE orchestration_v2_projection_runs SET run_id = 'new-run';
     UPDATE orchestration_v2_projection_run_attempts SET run_id = 'new-run';
     UPDATE orchestration_v2_projection_turn_items SET run_id = 'new-run';
     UPDATE orchestration_v2_projection_messages SET run_id = 'new-run';`,
    `UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.activeAttemptId', 'new-attempt');
     UPDATE orchestration_v2_projection_run_attempts SET attempt_id = 'new-attempt';
     UPDATE orchestration_v2_projection_provider_turns SET run_attempt_id = 'new-attempt';`,
  ])("refuses changed captured V2 work: %s", (sql) => {
    using fixture = activeRunFixture();
    const plan = handoff(fixture);
    fixture.database.exec(sql);
    assert.throws(
      () => verifyRestartContinuation(plan, fixture.policyPath),
      "continuation changed",
    );
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
    ["UPDATE projection_thread_messages SET turn_id = 'older-turn'", "provider execution"],
    ["UPDATE projection_thread_messages SET role = 'user'", "provider execution"],
    ["UPDATE thread_monitors SET thread_id = 'other-thread'", "belongs to another thread"],
    ["UPDATE thread_monitors SET condition_type = 'signal'", "time condition"],
    ["UPDATE thread_monitors SET continuation_mode = 'record-only'", "must resume the thread"],
    ["UPDATE projection_threads SET settled_override = 'settled'", "thread is settled"],
    ["UPDATE projection_threads SET snoozed_until = '2099-01-01T00:00:00Z'", "thread is snoozed"],
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
      UPDATE projection_thread_messages SET turn_id='new-legacy-turn';
      UPDATE provider_session_runtime SET runtime_payload_json = '{"activeTurnId":"new-legacy-turn"}';
    `);
    assert.throws(
      () => verifyRestartContinuation(plan, fixture.policyPath),
      "continuation changed",
    );
  });

  it.each(["file", "dangling-symlink"])(
    "rejects migration when the V2 destination exists as a %s",
    (kind) => {
      using fixture = migrationFixture();
      const plan = handoff(fixture, "migration-monitor");
      if (kind === "file") NodeFS.writeFileSync(fixture.restartDatabasePath, "existing V2 state");
      else NodeFS.symlinkSync("missing.sqlite", fixture.restartDatabasePath);
      assert.throws(
        () => verifyRestartContinuation(plan, fixture.policyPath),
        "statev2.sqlite already exists",
      );
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
    writeRestartWorker(worker);
    const result = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { captureRestartContinuation } = await import(process.argv[1]);
       process.stdout.write(JSON.stringify(captureRestartContinuation(process.argv[2], process.argv[3], process.argv[4], undefined, process.argv[5])));`,
        NodeURL.pathToFileURL(worker).href,
        fixture.databasePath,
        fixture.restartDatabasePath,
        "same-thread",
        fixture.policyPath,
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
      assert.throws(() => verifyRestartContinuation(plan, fixture.policyPath));
    },
  );

  it("parses process names containing spaces and closing parentheses", () => {
    const stat = `123 (odd ) name) S 42 ${Array.from({ length: 17 }, () => "0").join(" ")} 456`;
    assert.deepEqual(parseProcessStat(stat), { state: "S", parentPid: 42, startTicks: "456" });
    assert.throws(() => parseProcessStat("invalid"), "invalid process start ticks");
  });

  it.skipIf(!NodeFS.existsSync("/proc/self/stat"))(
    "distinguishes process incarnations and refuses a build replaced during shutdown",
    async () => {
      using directory = NodeFS.mkdtempDisposableSync(
        NodePath.join(NodeOS.tmpdir(), "restart-install-"),
      );
      const executable = NodePath.join(directory.path, "t3code");
      NodeFS.writeFileSync(executable, "selected build");
      const expectedHash = await hashInstalledFile(executable);
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "-e",
          'process.stdin.resume().on("end", () => require("node:fs").writeFileSync(process.argv[1], "changed build"))',
          executable,
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      await childEvent(child, "spawn");
      assert.isDefined(child.pid);
      try {
        const { startTicks } = parseProcessStat(
          NodeFS.readFileSync(`/proc/${child.pid}/stat`, "utf8"),
        );
        const identity = { pid: child.pid!, startTicks };
        assert.isTrue(isSameProcess(identity));
        assert.isFalse(isSameProcess({ ...identity, startTicks: String(BigInt(startTicks) + 1n) }));
        assert.throws(
          () => captureProcess(identity.pid),
          "not a supported installed desktop executable",
        );
        const exited = childEvent(child, "exit");
        const verifyInstallation = async () => {
          assert.equal(
            await hashInstalledFile(executable),
            expectedHash,
            "installed executable changed",
          );
        };
        await verifyInstallation();
        const shutdown = waitForVerifiedShutdown([identity], verifyInstallation);
        child.stdin!.end();
        await expect(shutdown).rejects.toThrow("installed executable changed");
        await exited;
        assert.isFalse(isSameProcess(identity));
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

  it("refuses an auto-restarting app or backend service before shutdown", () => {
    const service = unitMembershipFixture("desktop.service");
    const scope = unitMembershipFixture("desktop.scope");
    for (const policy of [
      "Restart=always",
      "Restart=on-failure",
      "Restart=on-success",
      "Restart=",
      "Restart=no\nRestartForceExitStatus=SIGTERM",
    ]) {
      const properties = service.properties.replace("Restart=no", policy);
      expect(() => verifyUnitMembership({ ...service, properties })).toThrow(/restart policy/i);
      expect(() =>
        verifyUnitMembership({
          ...scope,
          backendCgroup: service.backendCgroup,
          backendUnit: { name: service.unit, properties },
        }),
      ).toThrow(/restart policy/i);
    }
  });

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

it.skipIf(
  ["pacman", "fakeroot", "bsdtar"].some(
    (command) => NodeChildProcess.spawnSync(command, ["--version"]).status !== 0,
  ),
)("replaces the legacy package in one unattended pacman transaction", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pacman-transition-"));
  try {
    for (const name of ["root", "db", "cache", "hooks", "payload"])
      NodeFS.mkdirSync(NodePath.join(directory, name));
    const config = NodePath.join(directory, "pacman.conf");
    NodeFS.writeFileSync(config, `[options]\nSigLevel = Never\nHookDir = ${directory}/hooks\n`);
    const common = [
      "--root",
      `${directory}/root`,
      "--dbpath",
      `${directory}/db`,
      "--config",
      config,
      "--cachedir",
      `${directory}/cache`,
      "--logfile",
      `${directory}/pacman.log`,
      "--hookdir",
      `${directory}/hooks`,
    ];
    const pacman = (args: string[]) =>
      NodeChildProcess.execFileSync("fakeroot", ["pacman", ...common, ...args], {
        encoding: "utf8",
      });
    const archive = (name: string, conflict?: string) => {
      NodeFS.writeFileSync(
        `${directory}/payload/.PKGINFO`,
        `pkgname = ${name}\npkgver = 1-1\npkgdesc = Disposable transition fixture\nurl = https://example.com\nbuilddate = 0\npackager = Test\nsize = 0\narch = any\nlicense = MIT\n${conflict ? `conflict = ${conflict}\n` : ""}`,
      );
      const path = `${directory}/${name}-1-1-any.pkg.tar.gz`;
      NodeChildProcess.execFileSync("bsdtar", [
        "-czf",
        path,
        "-C",
        `${directory}/payload`,
        ".PKGINFO",
      ]);
      return path;
    };
    pacman(["--dbonly", "--noconfirm", "-U", archive("t3code-bin")]);
    pacman([
      "--dbonly",
      ...pacmanUpgradeArguments(archive("t3code-soupslurpr-bin", "t3code-bin"), true),
    ]);
    assert.equal(pacman(["-Qq"]).trim(), "t3code-soupslurpr-bin");
    // Later fork upgrades need no conflict-answer override.
    pacman([
      "--dbonly",
      ...pacmanUpgradeArguments(archive("t3code-soupslurpr-bin", "t3code-bin"), false),
    ]);
    assert.equal(pacman(["-Q"]).trim(), "t3code-soupslurpr-bin 1-1");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

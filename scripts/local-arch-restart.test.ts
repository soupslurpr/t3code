// @effect-diagnostics nodeBuiltinImport:off - Tests use disposable databases and captured child processes.

/** Exercises restart identity, durable handoff, and installed-build guards without restarting T3. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, expect, it } from "@effect/vitest";

import { verifyInstalledBuild } from "./local-arch-restart.ts";
import {
  captureProcess,
  isSameProcess,
  launchEnvironment,
  parseProcessStat,
  verifyActiveTurn,
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
function databaseFixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-restart-test-"));
  const databasePath = NodePath.join(directory, "test.sqlite");
  const database = new NodeSqlite.DatabaseSync(databasePath);
  return {
    database,
    databasePath,
    [Symbol.dispose]: () => {
      database.close();
      NodeFS.rmSync(directory, { recursive: true });
    },
  };
}

/** Creates matching running-thread records and enables native restart continuation. */
function activeTurnFixture() {
  const fixture = databaseFixture();
  const settingsPath = NodePath.join(NodePath.dirname(fixture.databasePath), "settings.json");
  NodeFS.writeFileSync(settingsPath, JSON.stringify({ continueThreadsAfterServerUpdate: true }));
  fixture.database.exec(`
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT, active_turn_id TEXT);
    CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY, status TEXT, resume_cursor_json TEXT, runtime_payload_json TEXT
    );
    INSERT INTO projection_threads VALUES ('same-thread', 'same-project', NULL, NULL);
    INSERT INTO projection_thread_sessions VALUES ('same-thread', 'running', 'active-turn');
    INSERT INTO provider_session_runtime VALUES (
      'same-thread', 'running', '{"sessionId":"provider-session"}', '{"activeTurnId":"active-turn"}'
    );
  `);
  return { ...fixture, settingsPath };
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
  it("uses native continuation for a running turn without writing state", () => {
    using fixture = activeTurnFixture();
    const before = NodeFS.readFileSync(fixture.databasePath);
    const settingsBefore = NodeFS.readFileSync(fixture.settingsPath);
    assert.equal(verifyActiveTurn(fixture.databasePath, "same-thread"), "active-turn");
    verifyRestartContinuation({
      databasePath: fixture.databasePath,
      threadId: "same-thread",
      continuation: { type: "active-turn", turnId: "active-turn" },
    });
    assert.deepEqual(NodeFS.readFileSync(fixture.databasePath), before);
    assert.deepEqual(NodeFS.readFileSync(fixture.settingsPath), settingsBefore);
    assert.throws(
      () => verifyActiveTurn(fixture.databasePath, "other-thread"),
      "no durable provider session",
    );
  });

  it.each([{}, null, { continueThreadsAfterServerUpdate: false }])(
    "requires an explicit native restart preference: %j",
    (settings) => {
      using fixture = activeTurnFixture();
      NodeFS.writeFileSync(fixture.settingsPath, JSON.stringify(settings));
      assert.throws(() => verifyActiveTurn(fixture.databasePath, "same-thread"), "not enabled");
    },
  );

  it.each([
    { environment: false, project: true, enabled: true },
    { environment: true, project: false, enabled: false },
    { environment: true, project: undefined, enabled: true },
    { environment: false, project: undefined, enabled: false },
  ])(
    "resolves the running project's restart preference: %j",
    ({ environment, project, enabled }) => {
      using fixture = activeTurnFixture();
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
      if (enabled)
        assert.equal(verifyActiveTurn(fixture.databasePath, "same-thread"), "active-turn");
      else
        assert.throws(() => verifyActiveTurn(fixture.databasePath, "same-thread"), "not enabled");
    },
  );

  it.each([
    ["UPDATE projection_threads SET archived_at = '2030-01-01'", "thread is archived"],
    ["UPDATE projection_threads SET deleted_at = '2030-01-01'", "thread is deleted"],
    ["UPDATE projection_thread_sessions SET status = 'ready'", "keep the thread running"],
    ["UPDATE projection_thread_sessions SET active_turn_id = NULL", "no active turn"],
    ["UPDATE provider_session_runtime SET status = 'stopped'", "provider session is not running"],
    ["UPDATE provider_session_runtime SET runtime_payload_json = '{}'", "records disagree"],
    ["UPDATE provider_session_runtime SET resume_cursor_json = NULL", "no resume cursor"],
    ["UPDATE provider_session_runtime SET resume_cursor_json = 'null'", "no resume cursor"],
  ])("rejects an unrecoverable turn: %s", (sql, reason) => {
    using fixture = activeTurnFixture();
    fixture.database.exec(sql);
    assert.throws(() => verifyActiveTurn(fixture.databasePath, "same-thread"), reason);
  });

  it("refuses to restart a later turn after capturing the original one", () => {
    using fixture = activeTurnFixture();
    const turnId = verifyActiveTurn(fixture.databasePath, "same-thread");
    fixture.database.exec(`
      UPDATE projection_thread_sessions SET active_turn_id = 'later-turn';
      UPDATE provider_session_runtime SET runtime_payload_json = '{"activeTurnId":"later-turn"}';
    `);
    assert.throws(
      () => verifyActiveTurn(fixture.databasePath, "same-thread", turnId),
      "active turn changed",
    );
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
      using fixture = activeTurnFixture();
      const plan = JSON.parse(
        JSON.stringify({
          databasePath: fixture.databasePath,
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
            databasePath: "/unused",
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
          databasePath: "/unused",
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

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
  verifyContinuation,
  verifyDesktopOwnership,
  waitForShutdown,
} from "./local-arch-restart-worker.ts";

const CONTINUATION_WAKE = "2030-01-01T01:00:00.000Z";
const EARLIEST_WAKE = Date.parse("2030-01-01T00:00:00.000Z");

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

/** Creates a durable timer fixture outside all T3 data directories. */
function continuationFixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-restart-test-"));
  const databasePath = NodePath.join(directory, "test.sqlite");
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`CREATE TABLE thread_monitors (
    monitor_id TEXT PRIMARY KEY, thread_id TEXT, continuation_mode TEXT,
    condition_type TEXT, status TEXT, wake_at TEXT, resume_prompt TEXT
  )`);
  database
    .prepare("INSERT INTO thread_monitors VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(
      "restart-monitor",
      "same-thread",
      "resume-thread",
      "time",
      "active",
      CONTINUATION_WAKE,
      "Verify the installed commit and same thread after restart.",
    );
  return {
    database,
    databasePath,
    [Symbol.dispose]: () => {
      database.close();
      NodeFS.rmSync(directory, { recursive: true });
    },
  };
}

describe("guarded restart", () => {
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

  it("reads a persisted continuation without modifying the database", () => {
    using fixture = continuationFixture();
    const before = NodeFS.readFileSync(fixture.databasePath);
    verifyContinuation(fixture.databasePath, "same-thread", "restart-monitor", EARLIEST_WAKE);
    assert.deepEqual(NodeFS.readFileSync(fixture.databasePath), before);
    assert.throws(
      () =>
        verifyContinuation(fixture.databasePath, "other-thread", "restart-monitor", EARLIEST_WAKE),
      "another thread",
    );
    assert.throws(
      () => verifyContinuation(fixture.databasePath, "same-thread", "missing", EARLIEST_WAKE),
      "does not exist",
    );
    assert.throws(
      () =>
        verifyContinuation(
          fixture.databasePath,
          "same-thread",
          "restart-monitor",
          Date.parse(CONTINUATION_WAKE) + 1,
        ),
      "deadline is too soon",
    );
  });

  it.each(["cancelled", "delivered", "triggered", "failed"])(
    "rejects a %s continuation",
    (status) => {
      using fixture = continuationFixture();
      fixture.database.prepare("UPDATE thread_monitors SET status = ?").run(status);
      assert.throws(
        () =>
          verifyContinuation(fixture.databasePath, "same-thread", "restart-monitor", EARLIEST_WAKE),
        "no longer pending",
      );
    },
  );

  it("rejects record-only, signal-only, and instructionless monitors", () => {
    using fixture = continuationFixture();
    fixture.database.exec("UPDATE thread_monitors SET continuation_mode = 'record-only'");
    assert.throws(
      () =>
        verifyContinuation(fixture.databasePath, "same-thread", "restart-monitor", EARLIEST_WAKE),
      "cannot resume",
    );
    fixture.database.exec(
      "UPDATE thread_monitors SET continuation_mode = 'resume-thread', condition_type = 'signal'",
    );
    assert.throws(
      () =>
        verifyContinuation(fixture.databasePath, "same-thread", "restart-monitor", EARLIEST_WAKE),
      "requires a timer",
    );
    fixture.database.exec("UPDATE thread_monitors SET condition_type = 'time', resume_prompt = ''");
    assert.throws(
      () =>
        verifyContinuation(fixture.databasePath, "same-thread", "restart-monitor", EARLIEST_WAKE),
      "no verification instructions",
    );
  });

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

  it("rejects ambiguous service targets before inspecting any process", () => {
    assert.throws(
      () =>
        verifyDesktopOwnership({
          service: "*.service",
          app: { pid: 10, startTicks: "1" },
          backend: { pid: 11, startTicks: "2" },
          databasePath: "/unused",
        }),
      "invalid user service name",
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

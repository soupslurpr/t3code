// @effect-diagnostics-next-line nodeBuiltinImport:off - observes the children the launcher spawns with Node built-ins.
import type * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import {
  databaseBackupBlocker,
  Launcher,
  main,
  readServiceEnvironment,
  type BackupSpaceProbe,
  readServiceState,
  writeServiceState,
} from "./serviceLauncher.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";
import { migrationManifest } from "./persistence/MigrationIdentities.ts";

const spawnedChildren = vi.hoisted((): Array<NodeChildProcess.ChildProcess> => []);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    spawnedChildren.push(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

const writeSparseFile = (filePath: string, size: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, "");
    yield* fileSystem.truncate(filePath, size);
  });

it("accepts only exact semantic versions", () => {
  for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3-0", "1.2.3+001"]) {
    assert.isTrue(isExactServiceVersion(version), version);
  }
  for (const version of ["latest", "01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+."]) {
    assert.isFalse(isExactServiceVersion(version), version);
  }
});

it("orders exact semantic versions without treating build metadata as precedence", () => {
  assert.equal(compareExactServiceVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareExactServiceVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.2", "2.0.0-alpha.beta"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha-beta", "2.0.0-alpha-alpha"), 1);
  assert.equal(compareExactServiceVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.equal(compareExactServiceVersions("2.0.0+one", "2.0.0+two"), 0);
});

it("rejects contradictory service state", () => {
  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "0.0.31",
      update: {
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.32",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-3",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-2",
        fromVersion: "1.0.0",
        targetVersion: "0.9.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );
});

const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
) =>
  Effect.gen(function* () {
    const entryPath = path.join(versionDir, "t3");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(entryPath, `#!${process.execPath}\n${childSource}`);
    yield* fs.chmod(entryPath, 0o755);
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
    return entryPath;
  });

it.layer(NodeServices.layer)("service state persistence", (it) => {
  it.effect.each([
    {
      name: "new upstream migration",
      previousFutureMigration: false,
      addsForkHistory: false,
      outcome: "prepared",
    },
    {
      name: "recovery after newer upstream migrations",
      previousFutureMigration: true,
      addsForkHistory: false,
      outcome: "prepared",
    },
    {
      name: "trial that introduces fork history",
      previousFutureMigration: false,
      addsForkHistory: true,
      outcome: "prepared",
    },
    ...["exit", "invalid-prepared", "state-dir-owned"].map((outcome) => ({
      name: `trial that introduces fork history before ${outcome}`,
      previousFutureMigration: false,
      addsForkHistory: true,
      outcome,
    })),
    {
      name: "upstream rollback after invalid prepared",
      previousFutureMigration: false,
      addsForkHistory: false,
      outcome: "invalid-prepared",
    },
  ])(
    "N03 preserves upstream completion and fork refusal for $name",
    ({ previousFutureMigration, addsForkHistory, outcome }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        forkGuard.enabled = true;
        forkGuard.upstream = true;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            forkGuard.enabled = false;
            forkGuard.upstream = false;
          }),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-upstream-trial-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const dbPath = path.join(root, "state.sqlite");
        const replyPath = path.join(root, "committed-reply.json");
        const db = new NodeSqlite.DatabaseSync(dbPath);
        try {
          db.exec(
            "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)",
          );
          const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
          for (const [id, name] of migrationManifest) insert.run(id, name);
          if (previousFutureMigration) insert.run(77, "FutureUpstreamMigration");
          db.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('before')");
        } finally {
          db.close();
        }
        const childSource = `
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec(${JSON.stringify(
          addsForkHistory
            ? "CREATE TABLE effect_sql_fork_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)"
            : `INSERT INTO effect_sql_migrations VALUES (${previousFutureMigration ? 78 : 77}, 'NextUpstreamMigration')`,
        )});
db.exec("UPDATE sample SET value = 'after'");
db.close();
process.on("message", (message) => {
  if (message.type === "committed") {
    fs.writeFileSync(${JSON.stringify(replyPath)}, JSON.stringify(message));
    process.exit(0);
  }
});
${outcome === "exit" ? "process.exit(1);" : outcome === "state-dir-owned" ? `process.exit(${SERVER_EXIT_CODE_STATE_DIR_OWNED});` : `process.send({ type: "prepared", updateId: ${outcome === "invalid-prepared" ? '"wrong-update"' : "context.update.id"} });`}
`;
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            version === "1.1.0" ? childSource : "process.exit(0);",
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
            update: {
              id: "upstream-trial",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              dbPath,
              status: "pending",
            },
          }),
        );
        const childrenBefore = spawnedChildren.length;
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => launcher.stop("SIGTERM")));
        const idle = Promise.withResolvers<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
              if (String(chunk).includes("owns this T3 home")) idle.resolve();
              return true;
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const running = launcher.run().then(
          () => "unexpected completion",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        const failure = yield* Effect.promise(() =>
          Promise.race([
            running,
            idle.promise.then(async () => {
              await launcher.stop("SIGTERM");
              return running;
            }),
          ]),
        );
        const state = yield* Effect.promise(() => readServiceState(statePath));
        const committed = !addsForkHistory && outcome === "prepared";
        const rolledBack = !addsForkHistory && !committed;
        assert.equal(spawnedChildren.length, childrenBefore + (rolledBack ? 2 : 1));
        assert.equal(state.activeVersion, committed ? "1.1.0" : "1.0.0");
        assert.equal(
          state.update?.status,
          addsForkHistory ? "pending" : committed ? "committed" : "rolled-back",
        );
        const after = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.equal(
            after.prepare("SELECT value FROM sample").get()?.value,
            rolledBack ? "before" : "after",
          );
          assert.equal(
            after
              .prepare(
                "SELECT count(*) AS count FROM sqlite_master WHERE name = 'effect_sql_fork_migrations'",
              )
              .get()?.count,
            addsForkHistory ? 1 : 0,
          );
        } finally {
          after.close();
        }
        assert.equal(
          yield* fs.exists(path.join(root, "runtime", "db-backup", "upstream-trial")),
          addsForkHistory,
        );
        assert.equal(yield* fs.exists(replyPath), committed);
        assert.include(failure, addsForkHistory ? "fork" : "Active child exited unexpectedly");
        if (committed) {
          assert.deepEqual(JSON.parse(yield* fs.readFileString(replyPath)), {
            type: "committed",
            updateId: "upstream-trial",
          });
        }
      }),
  );

  it.effect.each([false, true])(
    "N03 refuses cached pending recovery with existing backup %s without mutation or children",
    (existingBackup) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        forkGuard.enabled = true;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            forkGuard.enabled = false;
          }),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-pending-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const dbPath = path.join(root, "state.sqlite");
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            "process.exit(1);",
          );
        }
        yield* fs.writeFileString(dbPath, "untouched database fixture");
        yield* fs.writeFileString(
          path.join(root, "runtime", SERVICE_STOP_MARKER_FILE),
          "preserve stop marker",
        );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
            update: {
              id: "pending-fork",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              dbPath,
              status: "pending",
            },
          }),
        );
        const backup = path.join(root, "runtime", "db-backup", "pending-fork");
        if (existingBackup) {
          yield* fs.makeDirectory(backup, { recursive: true });
          yield* fs.writeFileString(path.join(backup, "database"), "preserve previous database");
          yield* fs.writeFileString(
            path.join(backup, ".restore-pending"),
            "preserve restore marker",
          );
        }
        const before = yield* fs.readFileString(statePath);
        const childrenBefore = spawnedChildren.length;
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        const failure = yield* Effect.promise(() =>
          launcher.run().then(
            () => "unexpected completion",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          ),
        );
        assert.include(failure, "fork");
        assert.equal(spawnedChildren.length, childrenBefore);
        assert.equal(yield* fs.readFileString(statePath), before);
        assert.equal(yield* fs.readFileString(dbPath), "untouched database fixture");
        assert.equal(
          yield* fs.readFileString(path.join(root, "runtime", SERVICE_STOP_MARKER_FILE)),
          "preserve stop marker",
        );
        if (existingBackup) {
          assert.equal(
            yield* fs.readFileString(path.join(backup, "database")),
            "preserve previous database",
          );
          assert.equal(
            yield* fs.readFileString(path.join(backup, ".restore-pending")),
            "preserve restore marker",
          );
        } else {
          assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup")));
        }
      }),
  );

  it.effect("N03 rejects an active child's cached update before pending state or replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      forkGuard.enabled = true;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          forkGuard.enabled = false;
        }),
      );
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-request-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const dbPath = path.join(root, "state.sqlite");
      const receipt = path.join(root, "request-result.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        `
import { writeFileSync } from "node:fs";
process.once("message", (reply) => {
  writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(reply));
  process.exit(0);
});
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(dbPath)} });
`,
      );
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.1.0"),
        "process.exit(1);",
      );
      yield* fs.writeFileString(dbPath, "unchanged source");
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const before = yield* fs.readFileString(statePath);
      const childrenBefore = spawnedChildren.length;
      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() => launcher.run().catch(() => undefined));
      const result = JSON.parse(yield* fs.readFileString(receipt));
      assert.equal(result.type, "update-rejected");
      assert.include(result.reason, "fork");
      assert.equal(spawnedChildren.length, childrenBefore + 1);
      assert.equal(yield* fs.readFileString(statePath), before);
      assert.equal(yield* fs.readFileString(dbPath), "unchanged source");
      assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup")));
    }),
  );

  it.effect(
    "loads optional service.env literally without changing inherited or managed variables",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-env-" });
        const inherited = Object.freeze({
          PATH: "inherited-path",
          T3CODE_HOME: root,
          T3_BOOT_SERVICE_UNIT: "managed-unit",
          T3_SERVICE_LAUNCHER_CONTEXT: "managed-context",
          T3CODE_PORT: "ambient",
        });
        assert.deepEqual(
          yield* Effect.promise(() => readServiceEnvironment(root, inherited)),
          inherited,
        );
        yield* fs.writeFileString(
          path.join(root, SERVICE_ENV_FILE),
          [
            "# service configuration",
            "export T3CODE_PORT=1234 # inline comment",
            'T3CODE_TOKEN="literal $HOME ${USER} $(whoami) # token"',
            'MULTILINE="first\nsecond"',
            "EMPTY=",
            "PATH=/bad",
            "Path=/bad",
            "T3CODE_HOME=/bad",
            "t3code_home=/bad",
            "T3_BOOT_SERVICE_UNIT=bad",
            "t3_boot_service_unit=bad",
            "T3_SERVICE_LAUNCHER_CONTEXT=bad",
            "t3_service_launcher_context=bad",
          ].join("\n"),
        );
        assert.deepEqual(yield* Effect.promise(() => readServiceEnvironment(root, inherited)), {
          ...inherited,
          T3CODE_PORT: "1234",
          T3CODE_TOKEN: "literal $HOME ${USER} $(whoami) # token",
          MULTILINE: "first\nsecond",
          EMPTY: "",
        });
      }),
  );

  it.effect("a fresh launcher clears a restart deferred by t3 update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-restart-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const restartPending = path.join(root, "runtime", SERVICE_RESTART_PENDING_FILE);
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const run = () =>
        Effect.gen(function* () {
          const launcher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
          );
          const running = launcher.run();
          yield* Effect.promise(() => launcher.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });

      yield* fs.writeFileString(restartPending, "1.0.1\n");
      yield* run();
      assert.isTrue(yield* fs.exists(restartPending));

      yield* fs.writeFileString(restartPending, "1.0.0\n");
      yield* run();
      assert.isFalse(yield* fs.exists(restartPending));
    }),
  );

  it.effect("stays idle instead of exiting when another server owns the T3 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-refused-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        `process.exit(${SERVER_EXIT_CODE_STATE_DIR_OWNED});\n`,
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const refused = Promise.withResolvers<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            if (String(chunk).includes("owns this T3 home")) refused.resolve();
            return true;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      let completed = false;
      const running = launcher.run().finally(() => {
        completed = true;
      });
      yield* Effect.promise(() => refused.promise);
      assert.isFalse(completed);
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
    }),
  );

  it.effect("commits only after the trial reports prepared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-flow-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: context.update.id });
  process.on("message", (message) => {
    if (message.type === "committed") process.exit(0);
  });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update?.status, "committed");
    }),
  );

  it.effect("rolls back invalid trials with the startup environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-rollback-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const observationsPath = path.join(root, "environment-observations.jsonl");
      const envPath = path.join(root, SERVICE_ENV_FILE);
      yield* fs.writeFileString(envPath, "T3CODE_TEST_SERVICE_TOKEN=initial\n");
      vi.stubEnv("T3CODE_HOME", root);
      vi.stubEnv("T3CODE_TEST_SERVICE_TOKEN", "inherited");
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
import { appendFileSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({
  token: process.env.T3CODE_TEST_SERVICE_TOKEN,
  update: context.update?.status ?? "active",
}) + "\\n");
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  writeFileSync(${JSON.stringify(envPath)}, "T3CODE_TEST_SERVICE_TOKEN=changed\\n");
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      yield* Effect.promise(() =>
        main().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "invalid-prepared",
      );
      const observations = (yield* fs.readFileString(observationsPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(observations, [
        { token: "initial", update: "active" },
        { token: "initial", update: "pending" },
        { token: "initial", update: "rolled-back" },
      ]);
      assert.equal(process.env.T3CODE_TEST_SERVICE_TOKEN, "inherited");
      assert.equal(yield* fs.readFileString(envPath), "T3CODE_TEST_SERVICE_TOKEN=changed\n");
    }),
  );

  it.effect.each(["file", "symlink", "dangling symlink"] as const)(
    "restores the database when a migrating trial exits, with the database a %s",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-db-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        const databaseFile =
          kind === "file" ? databasePath : path.join(root, "data", "original.sqlite");
        const linkTarget = kind === "dangling symlink" ? "../original.sqlite" : databaseFile;
        const original = "database before migration";
        yield* fs.makeDirectory(path.dirname(databaseFile), { recursive: true });
        if (kind === "dangling symlink") {
          yield* fs.makeDirectory(path.join(root, "data", "sub"));
          yield* fs.symlink(path.join(root, "data", "sub"), path.dirname(databasePath));
        } else {
          yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        }
        yield* fs.writeFileString(databaseFile, original);
        if (kind !== "file") yield* fs.symlink(linkTarget, databasePath);
        const encodedDatabasePath = JSON.stringify(databasePath);
        const childSource = `
import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(context.update.dbPath + "-wal", "trial wal");
  writeFileSync(context.update.dbPath + "-shm", "trial shm");
  ${kind === "dangling symlink" ? "unlinkSync(realpathSync(context.update.dbPath));" : ""}
  process.exit(1);
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            childSource,
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );

        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => Promise.reject(new Error("launcher unexpectedly completed")),
            () => Promise.resolve(),
          ),
        );

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(state.update?.status, "rolled-back");
        assert.equal(yield* fs.readFileString(databaseFile), original);
        if (kind !== "file") assert.equal(yield* fs.readLink(databasePath), linkTarget);
        assert.isFalse(yield* fs.exists(path.join(root, "original.sqlite")));
        assert.isFalse(yield* fs.exists(`${databasePath}-wal`));
        assert.isFalse(yield* fs.exists(`${databasePath}-shm`));
        const updateId = state.update?.id;
        assert.isDefined(updateId);
        assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", updateId)));
      }),
  );

  const requestRejectedUpdate = (backupSpaceProbe: Partial<BackupSpaceProbe>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-space-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const replyPath = path.join(root, "rejection.txt");
      const trialMarker = path.join(root, "trial-started");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({ databasePath, replyPath, trialMarker });
      const childSource = `
import { writeFileSync } from "node:fs";
const paths = ${encoded};
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(paths.trialMarker, "started");
  process.exit(1);
} else if (context.update === undefined) {
  process.on("message", (message) => {
    if (message.type === "update-rejected") {
      writeFileSync(paths.replyPath, message.reason);
      process.exit(0);
    }
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { backupSpaceProbe },
      );
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      return {
        reason: yield* fs.readFileString(replyPath),
        trialStarted: yield* fs.exists(trialMarker),
        state: yield* Effect.promise(() => readServiceState(statePath)),
      };
    });

  it.effect("refuses a backup that cannot fit and leaves the server running", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestRejectedUpdate({
        readFreeBytes: () => Promise.resolve(0),
        canClone: () => Promise.resolve(true),
      });

      assert.include(reason, "Not enough free disk space");
      assert.include(reason, "The server was not stopped");
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("refuses the update when free space cannot be checked", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestRejectedUpdate({
        readFreeBytes: () => Promise.reject(new Error("statfs unavailable")),
      });

      assert.include(
        reason,
        "Could not check that the database backup fits before updating: statfs unavailable",
      );
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("records no update when the server exits during the backup check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-exit-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({ databasePath });
      const childSource = `
const paths = ${encoded};
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath }, () =>
  process.exit(3),
);
setInterval(() => {}, 1_000);
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        {
          backupSpaceProbe: {
            readFreeBytes: () => {
              const child = spawnedChildren.at(-1)!;
              return new Promise((resolve) => {
                if (!child.connected) resolve(Number.MAX_SAFE_INTEGER);
                else child.once("disconnect", () => resolve(Number.MAX_SAFE_INTEGER));
              });
            },
          },
        },
      );
      const failure = yield* Effect.promise(() =>
        launcher.run().then(
          () => new Error("launcher unexpectedly completed"),
          (cause: unknown) => cause as Error,
        ),
      );

      assert.include(failure.message, "Active child exited unexpectedly (3)");
      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("checks database backup space against clone or full-copy needs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-blocker-" });
      const databasePath = path.join(root, "state.sqlite");
      yield* writeSparseFile(databasePath, 10 * 1024 ** 3);
      const check = (free: number, cloneable: boolean) =>
        Effect.promise(() =>
          databaseBackupBlocker(root, databasePath, {
            readFreeBytes: () => Promise.resolve(free),
            canClone: () => Promise.resolve(cloneable),
          }),
        );

      assert.isUndefined(yield* check(11 * 1024 ** 3, false));
      assert.isUndefined(yield* check(1.5 * 1024 ** 3, true));
      assert.include((yield* check(0.5 * 1024 ** 3, true)) ?? "", "1.0 GB needed, 0.5 GB free");
      const blocker = yield* check(8 * 1024 ** 3, false);
      assert.include(blocker ?? "", "Not enough free disk space");
      assert.include(blocker ?? "", "10.5 GB needed, 8.0 GB free");
      assert.include(blocker ?? "", "The server was not stopped");
    }),
  );
});

// The original rollback fixtures intentionally use opaque database bytes. New fork tests use the real guard.
const forkGuard = vi.hoisted(() => ({ enabled: false, upstream: false }));
vi.mock("@t3tools/shared/forkBuildIdentity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/forkBuildIdentity")>();
  return {
    get forkBuildIdentity() {
      return forkGuard.upstream ? undefined : actual.forkBuildIdentity;
    },
  };
});
vi.mock("./cloud/forkUpdateCompatibility.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cloud/forkUpdateCompatibility.ts")>();
  return {
    forkUpdateBlockReason: (paths: ReadonlyArray<string>) =>
      forkGuard.enabled ? actual.forkUpdateBlockReason(paths) : undefined,
  };
});

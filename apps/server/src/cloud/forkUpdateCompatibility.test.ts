import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import {
  migrationManifest,
  releasedForkMigrationNames,
} from "../persistence/MigrationIdentities.ts";
import { forkUpdateBlockReason } from "./forkUpdateCompatibility.ts";

const buildIdentity = vi.hoisted(() => vi.fn<() => unknown>(() => undefined));
vi.mock("@t3tools/shared/forkBuildIdentity", () => ({
  get forkBuildIdentity() {
    return buildIdentity();
  },
}));

it("blocks a fresh trusted fork without revision or database and ignores display labels", () => {
  buildIdentity.mockReturnValueOnce({ repository: "https://github.com/soupslurpr/t3code" });
  expect(forkUpdateBlockReason([])).toContain("fork");
  // Display metadata is deliberately absent from the decision's inputs.
  expect(forkUpdateBlockReason([])).toBeUndefined();
});

it.layer(NodeServices.layer)("read-only update provenance", (it) => {
  it.effect.each([
    { name: "upstream V2 preview at 53", count: 52, kind: "preview53", blocked: false },
    { name: "upstream V2 preview at 54", count: 53, kind: "preview54", blocked: false },
    { name: "upstream prefix", count: 54, kind: "upstream", blocked: false },
    { name: "full upstream history", count: 76, kind: "upstream", blocked: false },
    { name: "separate fork ledger", count: 76, kind: "fork", blocked: true },
    { name: "unknown fork identity", count: 76, kind: "unknown-fork", blocked: true },
    { name: "empty fork ledger", count: 76, kind: "empty-fork", blocked: true },
    { name: "legacy fork suffix", count: 54, kind: "legacy", blocked: true },
    { name: "mixed adopted and legacy history", count: 54, kind: "mixed", blocked: true },
    { name: "wrong name below the upstream head", count: 76, kind: "wrong-name", blocked: true },
    { name: "newer upstream suffix", count: 76, kind: "newer", blocked: false },
    { name: "gap in a newer suffix", count: 76, kind: "future-gap", blocked: true },
    { name: "empty newer identity", count: 76, kind: "future-empty", blocked: true },
    { name: "legacy fork above the known upstream head", count: 76, kind: "legacy", blocked: true },
    { name: "missing upstream identity", count: 76, kind: "gap", blocked: true },
  ] as const)("handles $name without adopting or writing history", ({ count, kind, blocked }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-update-history-" });
      const databasePath = path.join(root, "state.sqlite");
      const db = new NodeSqlite.DatabaseSync(databasePath);
      try {
        db.exec(
          "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)",
        );
        const insert = db.prepare(
          "INSERT INTO effect_sql_migrations VALUES (?, ?, 'recorded-time')",
        );
        for (const [id, name] of migrationManifest.slice(0, count)) insert.run(id, name);
        if (["fork", "unknown-fork", "empty-fork", "mixed"].includes(kind)) {
          db.exec(
            "CREATE TABLE effect_sql_fork_migrations (migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)",
          );
          if (kind !== "empty-fork")
            db.prepare("INSERT INTO effect_sql_fork_migrations VALUES (1, ?, 'recorded-time')").run(
              kind === "unknown-fork" ? "Unrecognized" : releasedForkMigrationNames[0],
            );
        }
        if (kind === "preview53") insert.run(53, "OrchestrationV2");
        if (kind === "preview54") {
          insert.run(54, "OrchestrationV2");
          insert.run(55, "RemoveRedundantProjectionIndexes");
        }
        if (kind === "legacy" || kind === "mixed")
          insert.run(count + 1, releasedForkMigrationNames[0]);
        if (kind === "wrong-name")
          db.exec("UPDATE effect_sql_migrations SET name = 'WrongName' WHERE migration_id = 1");
        if (kind === "newer") insert.run(77, "UnknownFutureMigration");
        if (kind === "future-gap") insert.run(78, "UnknownFutureMigration");
        if (kind === "future-empty") insert.run(77, "");
        if (kind === "gap") db.exec("DELETE FROM effect_sql_migrations WHERE migration_id = 1");
      } finally {
        db.close();
      }
      const before = yield* fs.readFile(databasePath);
      const decision = forkUpdateBlockReason([path.join(root, "missing.sqlite"), databasePath]);
      expect(decision !== undefined).toBe(blocked);
      expect(yield* fs.readFile(databasePath)).toEqual(before);
      expect(yield* fs.readDirectory(root)).toEqual(["state.sqlite"]);
    }),
  );

  it.effect("blocks unreadable or malformed histories and checks every backend", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-update-invalid-" });
      const invalid = path.join(root, "invalid.sqlite");
      yield* fs.writeFileString(invalid, "not sqlite");
      expect(forkUpdateBlockReason([path.join(root, "missing.sqlite")])).toBeUndefined();
      expect(forkUpdateBlockReason([path.join(root, "missing.sqlite"), invalid])).toContain(
        "history",
      );
      expect(forkUpdateBlockReason([root])).toContain("history");
      expect(yield* fs.readFileString(invalid)).toBe("not sqlite");
      expect(yield* fs.readDirectory(root)).toEqual(["invalid.sqlite"]);
    }),
  );
});

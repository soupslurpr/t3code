import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "checkpoint-limit-config-" }),
  VcsProcess.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "checkpoint-limit-" });
  const driver = yield* GitVcsDriver.makeVcsDriverShape();
  const git = (args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    driver.execute({ operation: "checkpoint-limit-fixture", cwd, args, allowNonZeroExit });
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@example.invalid"]);
  yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "committed\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "fixture"]);
  yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "staged\n");
  yield* git(["add", "."]);
  yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "working\n");
  return {
    fs,
    path,
    cwd,
    git,
    driver,
    checkpointRef: CheckpointRef.make("refs/t3/checkpoints/limit"),
  };
});

it.effect.each(["bytes", "files", "paths"] as const)(
  "rejects excessive untracked %s before staging or object writes, retaining the user index",
  (limit) =>
    Effect.gen(function* () {
      const { fs, path, cwd, git, checkpointRef } = yield* fixture;
      if (limit === "bytes") {
        const oversized = path.join(cwd, "model.bin");
        yield* fs.writeFileString(oversized, "");
        yield* fs.truncate(oversized, 2 * 1024 * 1024 * 1024 + 1);
      }
      const indexBefore = yield* fs.readFile(path.join(cwd, ".git/index"));
      const process = yield* VcsProcess.VcsProcess;
      const writes: string[] = [];
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            for (const command of ["add", "write-tree", "commit-tree", "update-ref"]) {
              if (input.args.includes(command)) writes.push(command);
            }
            const preflight =
              input.args.includes("ls-files") &&
              input.args.includes("--others") &&
              !input.args.includes("--");
            if (preflight) assert.equal(input.outputMode, "truncate");
            return process.run(input).pipe(
              Effect.map((result) =>
                !preflight || limit === "bytes"
                  ? result
                  : {
                      ...result,
                      stdout:
                        limit === "files"
                          ? Array.from({ length: 10_001 }, (_, index) => `file-${index}\0`).join("")
                          : "",
                      stdoutTruncated: limit === "paths",
                    },
              ),
            );
          },
        }),
      );
      const error = yield* driver.checkpoints
        .captureCheckpoint({ cwd, checkpointRef })
        .pipe(Effect.flip);
      assert.equal(error._tag, "VcsCheckpointLimitError");
      if (error._tag === "VcsCheckpointLimitError") {
        assert.equal(
          error.kind,
          limit === "bytes"
            ? "untracked-file-bytes"
            : limit === "files"
              ? "untracked-file-count"
              : "untracked-path-output-bytes",
        );
        assert.equal(
          error.limit,
          limit === "bytes" ? 2 * 1024 * 1024 * 1024 : limit === "files" ? 10_000 : 4 * 1024 * 1024,
        );
        assert.equal(error.observed, error.limit + 1);
      }
      assert.deepEqual(writes, []);
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git/index")), indexBefore);
      assert.isFalse(
        (yield* fs.readDirectory(path.join(cwd, ".git"))).some((name) =>
          name.startsWith("t3-checkpoint-index-"),
        ),
      );
      assert.notEqual((yield* git(["show-ref", "--verify", checkpointRef], true)).exitCode, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("captures bounded files while ignoring a sparse generated artifact", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, git, driver, checkpointRef } = yield* fixture;
    yield* fs.writeFileString(path.join(cwd, ".gitignore"), "*.bin\n");
    yield* fs.writeFileString(path.join(cwd, "model.bin"), "");
    yield* fs.truncate(path.join(cwd, "model.bin"), 2 * 1024 * 1024 * 1024 + 1);
    yield* fs.writeFileString(path.join(cwd, "safe.txt"), "capture me\n");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    assert.equal((yield* git(["show", `${checkpointRef}:safe.txt`])).stdout, "capture me\n");
    assert.equal((yield* git(["show", ":tracked.txt"])).stdout, "staged\n");
    assert.notEqual(
      (yield* git(["cat-file", "-e", `${checkpointRef}:model.bin`], true)).exitCode,
      0,
    );
  }).pipe(Effect.provide(layer)),
);

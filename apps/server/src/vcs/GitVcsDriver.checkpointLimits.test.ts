import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
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
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

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
    if (symlinksSupported) yield* fs.symlink("model.bin", path.join(cwd, "model-link"));
    yield* fs.writeFileString(path.join(cwd, "safe.txt"), "capture me\n");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    if (symlinksSupported)
      assert.equal((yield* git(["show", `${checkpointRef}:model-link`])).stdout, "model.bin");
    assert.equal((yield* git(["show", `${checkpointRef}:safe.txt`])).stdout, "capture me\n");
    assert.equal((yield* git(["show", ":tracked.txt"])).stdout, "staged\n");
    assert.notEqual(
      (yield* git(["cat-file", "-e", `${checkpointRef}:model.bin`], true)).exitCode,
      0,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("enforces untracked-content limits when reusing a kept capture index", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, git, driver } = yield* fixture;
    const firstRef = CheckpointRef.make("refs/t3/checkpoints/kept/0");
    const secondRef = CheckpointRef.make("refs/t3/checkpoints/kept/1");
    const model = path.join(cwd, "model.bin");
    yield* fs.writeFileString(model, "small\n");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: firstRef });
    assert.isTrue(yield* fs.exists(path.join(cwd, ".git", "t3-checkpoint-indexes")));

    // Growing a previously-captured untracked file past 2 GiB must still fail on kept-index reuse.
    yield* fs.truncate(model, 2 * 1024 * 1024 * 1024 + 1);
    const process = yield* VcsProcess.VcsProcess;
    const writes: string[] = [];
    const guardedDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          for (const command of ["add", "write-tree", "commit-tree", "update-ref"]) {
            if (input.args.includes(command)) writes.push(command);
          }
          return process.run(input);
        },
      }),
    );
    const error = yield* guardedDriver.checkpoints
      .captureCheckpoint({ cwd, checkpointRef: secondRef })
      .pipe(Effect.flip);
    assert.equal(error._tag, "VcsCheckpointLimitError");
    if (error._tag === "VcsCheckpointLimitError") {
      assert.equal(error.kind, "untracked-file-bytes");
      assert.equal(error.limit, 2 * 1024 * 1024 * 1024);
      assert.equal(error.observed, error.limit + 1);
    }
    assert.deepEqual(writes, []);
    assert.notEqual((yield* git(["show-ref", "--verify", secondRef], true)).exitCode, 0);

    // A previously-captured regular file replaced by an embedded repo still counts in kept-index preflight.
    yield* fs.remove(model);
    yield* fs.writeFileString(path.join(cwd, "nested-slot"), "file\n");
    const thirdRef = CheckpointRef.make("refs/t3/checkpoints/kept/2");
    const fourthRef = CheckpointRef.make("refs/t3/checkpoints/kept/3");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: thirdRef });
    yield* fs.remove(path.join(cwd, "nested-slot"));
    const nestedDir = path.join(cwd, "nested-slot");
    yield* fs.makeDirectory(nestedDir);
    yield* driver.execute({
      operation: "checkpoint-limit-fixture",
      cwd: nestedDir,
      args: ["init"],
    });
    const countDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          const preflight =
            input.args.includes("ls-files") &&
            input.args.includes("--others") &&
            !input.args.includes("--");
          return process.run(input).pipe(
            Effect.map((result) =>
              !preflight
                ? result
                : {
                    ...result,
                    stdout: Array.from({ length: 10_000 }, (_, index) => `extra-${index}\0`).join(
                      "",
                    ),
                  },
            ),
          );
        },
      }),
    );
    const countError = yield* countDriver.checkpoints
      .captureCheckpoint({ cwd, checkpointRef: fourthRef })
      .pipe(Effect.flip);
    assert.equal(countError._tag, "VcsCheckpointLimitError");
    if (countError._tag === "VcsCheckpointLimitError") {
      assert.equal(countError.kind, "untracked-file-count");
      assert.equal(countError.observed, 10_001);
    }
  }).pipe(Effect.provide(layer)),
);

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { forkBuildIdentity } from "@t3tools/shared/forkBuildIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import packageJson from "../../package.json" with { type: "json" };
import { keepsRunningServer } from "./sshHelper.ts";

const runtime = (fields: Record<string, unknown>) =>
  JSON.stringify({ version: 1, pid: 42, port: 3773, ...fields });

it.live("answers the SSH identity query without initializing a T3 home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-identity-" });
    const query = (...args: string[]) =>
      ChildProcess.make(
        process.execPath,
        [path.join(import.meta.dirname, "../bin.ts"), "__ssh-fork-identity", ...args],
        { env: { HOME: home, T3CODE_HOME: path.join(home, ".t3") }, extendEnv: false },
      );
    assert.equal(
      (yield* spawner.string(query())).trim(),
      `${forkBuildIdentity.repository} ${forkBuildIdentity.channel} ${packageJson.version}`,
    );
    assert.equal(Number(yield* spawner.exitCode(query("a".repeat(40)))), 1);
    assert.deepStrictEqual(yield* fs.readDirectory(home), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("keeps a same-or-newer server and replaces an older or unidentified one", () => {
  assert.isTrue(keepsRunningServer(runtime({ serverVersion: "0.1.6" }), 42, "0.1.6"));
  assert.isTrue(
    keepsRunningServer(runtime({ serverVersion: "0.1.7-nightly.20261102.4080" }), 42, "0.1.6"),
  );
  assert.isFalse(
    keepsRunningServer(runtime({ serverVersion: "0.1.7-nightly.20261102.4080" }), 42, "0.1.7"),
  );
  assert.isFalse(keepsRunningServer(runtime({ serverVersion: "0.1.5" }), 42, "0.1.6"));
  assert.isFalse(keepsRunningServer(runtime({ serverVersion: "0.1.6" }), 7, "0.1.6"));
  assert.isFalse(keepsRunningServer(runtime({}), 42, "0.1.6"));
  assert.isFalse(keepsRunningServer(runtime({ serverVersion: "latest" }), 42, "0.1.6"));
  assert.isFalse(keepsRunningServer("", 42, "0.1.6"));
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerConfig from "../config.ts";
import { describeServerProcess, writeTriageSession } from "./triageSession.ts";

it.effect("reports the version the running server recorded, not the CLI's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-" }),
      "server-runtime.json",
    );
    const state = yield* makePersistedServerRuntimeState({
      config: { host: undefined, devUrl: undefined },
      port: 3773,
    });
    yield* persistServerRuntimeState({ path: statePath, state });

    assert.equal(
      yield* describeServerProcess(statePath),
      `running (pid ${String(process.pid)}, http://127.0.0.1:3773, version ${packageJson.version})`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("writes fork-aware CLI context and playbook without needing a source clone", () =>
  Effect.gen(function* () {
    vi.stubGlobal("__T3CODE_FORK_REVISION__", "1234567890abcdef1234567890abcdef12345678");
    try {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const session = yield* writeTriageSession({
        baseDir: config.baseDir,
        paths: config,
        entry: { kind: "cli", cliVersion: packageJson.version, launchedAs: "t3 triage" },
        server: "not running (isolated fixture)",
      });
      const context = yield* fs.readFileString(session.contextFilePath);
      const prompt = yield* fs.readFileString(session.promptFilePath);
      assert.include(context, "https://github.com/soupslurpr/t3code");
      assert.include(context, "Compiled fork revision: 1234567890abcdef1234567890abcdef12345678");
      assert.include(context, "Exact fork source is unavailable");
      assert.include(context, "This identity describes the triage CLI");
      assert.include(context, "not running (isolated fixture)");
      assert.include(prompt, session.contextFilePath);
      assert.include(
        prompt,
        "Build-specific source and filing constraints in that context take precedence",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-triage-fork-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

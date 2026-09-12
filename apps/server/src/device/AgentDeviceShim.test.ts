// @effect-diagnostics nodeBuiltinImport:off - exercises the actual managed launcher with a fixture CLI.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ensureAgentDeviceShim } from "./AgentDeviceShim.ts";

it.effect(
  "isolates managed CLI state and forwards arguments without inherited daemon overrides",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-launcher-" });
      const entryPath = path.join(stateDir, "fixture.mjs");
      yield* fs.writeFileString(
        entryPath,
        `console.log(JSON.stringify({args:process.argv.slice(2),state:process.env.AGENT_DEVICE_STATE_DIR,base:process.env.AGENT_DEVICE_DAEMON_BASE_URL??null,token:process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN??null,config:process.env.AGENT_DEVICE_CONFIG??null}));`,
      );
      const directory = yield* ensureAgentDeviceShim({ entryPath, stateDir });
      const args = [
        "snapshot",
        "-i",
        "--config",
        "/host config.json",
        "--session",
        "device-session",
      ];
      // The JS launcher is shared by the Windows and POSIX entry scripts.
      const output = yield* Effect.promise(() =>
        promisify(execFile)(
          process.execPath,
          [path.join(directory, "agent-device-launcher.mjs"), ...args],
          {
            env: {
              ...process.env,
              AGENT_DEVICE_STATE_DIR: "/standalone-state",
              AGENT_DEVICE_DAEMON_BASE_URL: "http://wrong-host",
              AGENT_DEVICE_DAEMON_AUTH_TOKEN: "wrong-token",
              AGENT_DEVICE_CONFIG: "/wrong-config",
            },
          },
        ),
      );
      const result = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            args: Schema.Array(Schema.String),
            state: Schema.String,
            base: Schema.Null,
            token: Schema.Null,
            config: Schema.Null,
          }),
        ),
      )(output.stdout);
      expect(result.args).toEqual(args);
      expect(result.state).toBe(path.join(stateDir, "device", "agent-client"));
      expect(output.stderr).toBe("");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

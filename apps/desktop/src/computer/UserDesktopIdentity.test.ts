import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { UserDesktopId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";

const decodeIdentityDocument = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      desktopId: UserDesktopId,
    }),
  ),
);

/** Creates one isolated desktop environment for identity tests. */
function environmentLayer(baseDir: string, platform: NodeJS.Platform = "linux") {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform,
    processArch: "x64",
    appVersion: "1.0.0",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.merge(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
}

/** Runs one identity test against an isolated desktop state directory. */
function withIdentityEnvironment<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  platform: NodeJS.Platform = "linux",
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-user-desktop-identity-test-",
    });
    return yield* effect.pipe(
      Effect.provide(Layer.merge(environmentLayer(baseDir, platform), NodeServices.layer)),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
}

describe("UserDesktopIdentity", () => {
  it.effect("creates one stable opaque identity for the graphical desktop", () =>
    withIdentityEnvironment(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const first = yield* UserDesktopIdentity.makeWithHostname("coolcrab");
        const second = yield* UserDesktopIdentity.makeWithHostname("coolcrab");

        assert.strictEqual(first.registration.desktopId, second.registration.desktopId);
        assert.match(first.registration.desktopId, /^user-[0-9a-f-]{36}$/u);
        assert.deepEqual(first.registration, {
          protocolVersion: 1,
          desktopId: first.registration.desktopId,
          defaultLabel: "coolcrab",
          platform: "linux",
          capabilities: ["view", "control", "availability"],
        });

        const stored = decodeIdentityDocument(
          yield* fileSystem.readFileString(
            environment.path.join(environment.stateDir, "user-desktop-identity.json"),
          ),
        );
        assert.deepEqual(stored, {
          version: 1,
          desktopId: first.registration.desktopId,
        });
      }),
    ),
  );

  it.effect("rejects a corrupt identity instead of silently changing targets", () =>
    withIdentityEnvironment(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.path.join(environment.stateDir, "user-desktop-identity.json"),
          "not-json",
        );

        const error = yield* UserDesktopIdentity.makeWithHostname("coolcrab").pipe(Effect.flip);
        assert.instanceOf(error, UserDesktopIdentity.UserDesktopIdentityError);
        assert.strictEqual(error.operation, "decode");
      }),
    ),
  );

  it.effect("does not advertise computer use on unsupported platforms", () =>
    withIdentityEnvironment(
      Effect.gen(function* () {
        const identity = yield* UserDesktopIdentity.makeWithHostname("windows-client");

        assert.strictEqual(identity.registration.platform, "windows");
        assert.deepEqual(identity.registration.capabilities, []);
      }),
      "win32",
    ),
  );
});

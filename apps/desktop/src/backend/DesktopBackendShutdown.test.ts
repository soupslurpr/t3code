/** Verifies that desktop shutdown lets the backend finalize its children first. */
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { runBackendProcess } from "./DesktopBackendManager.ts";

it.effect("lets a backend finish pending child work before terminating its group", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const outcomePath = `${directory}/outcome`;
      const entryPath = NodeURL.fileURLToPath(
        new URL("./fixtures/graceful-shutdown.mjs", import.meta.url),
      );
      const owner = yield* Scope.fork(yield* Scope.Scope);
      const ready = yield* Deferred.make<void>();
      const running = yield* runBackendProcess({
        executablePath: process.execPath,
        entryPath,
        args: [entryPath, outcomePath],
        cwd: directory,
        env: {},
        extendEnv: true,
        httpBaseUrl: new URL("http://127.0.0.1:1"),
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          port: 1,
          t3Home: directory,
          host: "127.0.0.1",
          desktopBootstrapToken: "fixture",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        },
        bootstrapDelivery: "stdin",
        desktopTelemetryStream: Stream.empty,
        captureOutput: true,
        preflightFailure: Option.none(),
        onOutput: (stream, chunk) =>
          stream === "stdout" && new TextDecoder().decode(chunk).includes("ready")
            ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
            : Effect.void,
      }).pipe(Effect.scoped, Effect.forkIn(owner));
      yield* Deferred.await(ready).pipe(Effect.raceFirst(Fiber.join(running)));
      yield* Scope.close(owner, Exit.void);
      assert.strictEqual(yield* fileSystem.readFileString(outcomePath), "0");
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
      ),
    ),
  ),
);

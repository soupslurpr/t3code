// @effect-diagnostics nodeBuiltinImport:off -- Executes the SSH bootstrap in an isolated local shell.
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { forkBuildIdentity } from "@t3tools/shared/forkBuildIdentity";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { issueRemotePairingToken, launchOrReuseRemoteServer } from "./tunnel.ts";

const target = { alias: "fixture", hostname: "fixture.invalid", username: null, port: null };
const runner = { archiveVersion: "1.2.3", releaseBaseUrl: "https://fixture.invalid/release" };

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-ssh-" });
  const bin = NodePath.join(home, "bin");
  const cache = NodePath.join(home, ".t3/runtime/versions", runner.archiveVersion);
  const userdata = NodePath.join(home, ".t3/userdata");
  for (const dir of [bin, cache, userdata]) yield* fs.makeDirectory(dir, { recursive: true });
  const writeProgram = (path: string, body: string) =>
    fs.writeFileString(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  const untrusted = (name: string) => `echo ${name} "$@" >> "$HOME/unverified"
case "$1" in
  --version) echo 't3 v1.2.3' ;;
  auth) echo '{"credential":"wrong-runtime"}' ;;
  *) exit 1 ;;
esac`;
  yield* writeProgram(NodePath.join(bin, "t3"), untrusted("on-path"));
  yield* writeProgram(NodePath.join(cache, "t3"), untrusted("cache"));
  yield* fs.writeFileString(NodePath.join(cache, ".install-complete"), "1.2.3\n");
  for (const command of ["curl", "wget", "pacman"]) {
    yield* writeProgram(
      NodePath.join(bin, command),
      command === "pacman" ? "exit 1" : untrusted(command),
    );
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const shell = (env: Record<string, string> = {}) =>
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") throw new Error("Expected one SSH command");
      const key = /exec sh -s -- ([a-f0-9]+)"/u.exec(command.args.join(" "))?.[1];
      return spawner.spawn(
        ChildProcess.make("/bin/sh", ["-s", "--", ...(key ? [key] : [])], {
          ...command.options,
          cwd: home,
          extendEnv: false,
          env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env },
        }),
      );
    });
  return { fs, home, bin, cache, userdata, shell, writeProgram };
});

const tunnelUrl = "http://127.0.0.1:45123";
const descriptorClient = (
  forkBuild?: { channel: string; revision: string | null },
  hostPairing = false,
) =>
  HttpClient.make((request) => {
    assert.equal(request.url, `${tunnelUrl}/.well-known/t3/environment`);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          environmentId: "fixture",
          label: "Fixture",
          platform: { os: "linux", arch: "x64" },
          capabilities: { userDesktopHostPairing: hostPairing },
          serverVersion: runner.archiveVersion,
          forkBuild,
        }),
      ),
    );
  });
const services = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    descriptorClient({ channel: forkBuildIdentity.channel, revision: null }),
  ),
);
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("fork SSH", () => {
  it.live(
    "rejects a same-version PATH binary, marked cache and release mirror for startup and pairing",
    () =>
      Effect.gen(function* () {
        for (const operation of ["launch", "pair"] as const) {
          const { fs, home, bin, cache, shell } = yield* fixture;
          for (const choice of ["on-path", "cache", "mirror"] as const) {
            if (choice === "cache") yield* fs.remove(NodePath.join(bin, "t3"), { force: true });
            if (choice === "mirror") yield* fs.remove(cache, { recursive: true, force: true });
            const error = yield* Effect.gen(function* () {
              if (operation === "launch")
                return yield* launchOrReuseRemoteServer(target, undefined, runner).pipe(
                  Effect.flip,
                );
              return yield* issueRemotePairingToken(target, tunnelUrl, undefined, runner).pipe(
                Effect.flip,
              );
            }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, shell()));
            assert.include(error.message, "local-arch-package.md");
            assert.isFalse(yield* fs.exists(NodePath.join(home, "unverified")));
          }
        }
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("attaches to a running environment without a verified CLI or host Node", () =>
    Effect.gen(function* () {
      const { fs, home, bin, userdata, writeProgram, shell } = yield* fixture;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const server = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "-e",
            `
        const server = require("node:http").createServer((_req, res) => res.end("fixture"));
        server.listen(0, "127.0.0.1", () => console.log(server.address().port));
      `,
          ],
          { env: { HOME: home }, extendEnv: false },
        ),
      );
      const port = Number(
        Option.getOrThrow(yield* server.stdout.pipe(Stream.decodeText(), Stream.runHead)),
      );
      yield* writeProgram(NodePath.join(bin, "node"), 'echo node >> "$HOME/unverified"; exit 1');
      yield* fs.writeFileString(
        NodePath.join(userdata, "server-runtime.json"),
        JSON.stringify({
          pid: Number(server.pid),
          port,
          origin: `http://127.0.0.1:${port}`,
        }),
      );
      const attached = yield* launchOrReuseRemoteServer(target, undefined, runner).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, shell()),
      );
      assert.deepStrictEqual(attached, { remotePort: port, remoteServerKind: "external" });
      assert.isTrue(yield* server.isRunning);
      assert.isFalse(yield* fs.exists(NodePath.join(home, "unverified")));
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("refuses an invalid runtime record without starting a replacement", () =>
    Effect.gen(function* () {
      const { fs, home, userdata, shell } = yield* fixture;
      for (const record of [
        { pid: 0, port: 45123, origin: tunnelUrl },
        { pid: process.pid, port: 45123, origin: "http://example.invalid:45123" },
        { pid: process.pid, port: 45124, origin: tunnelUrl },
      ]) {
        yield* fs.writeFileString(
          NodePath.join(userdata, "server-runtime.json"),
          JSON.stringify(record),
        );
        const error = yield* launchOrReuseRemoteServer(target, undefined, runner).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, shell()),
          Effect.flip,
        );
        assert.include(error.message, "local-arch-package.md");
      }
      assert.isFalse(yield* fs.exists(NodePath.join(home, "unverified")));
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("checks the explicitly configured development checkout before pairing", () =>
    Effect.gen(function* () {
      const { fs, home, shell } = yield* fixture;
      const script = NodePath.join(home, "dev.cjs");
      const pair = issueRemotePairingToken(target, tunnelUrl, undefined, {
        nodeScriptPath: script,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, shell()));
      const install = (identity: string) =>
        fs.writeFileString(
          script,
          `
        if (process.argv[2] === "__ssh-fork-identity") console.log(${JSON.stringify(identity)});
        else if (process.argv[2] === "auth") console.log('{"credential":"development-fixture"}');
        else process.exitCode = 1;
      `,
        );
      yield* install("t3 v1.2.3");
      assert.include((yield* pair.pipe(Effect.flip)).message, "local-arch-package.md");
      yield* install(`${forkBuildIdentity.repository} ${forkBuildIdentity.channel} 1.2.3`);
      assert.equal((yield* pair).credential, "development-fixture");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("pairs with the registered fork package only for its running build", () =>
    Effect.gen(function* () {
      const { fs, home, bin, writeProgram, shell } = yield* fixture;
      const root = NodePath.join(home, "package");
      yield* fs.makeDirectory(root);
      yield* writeProgram(
        NodePath.join(bin, "pacman"),
        `case "$1 $2" in
        "-Qlq t3code-soupslurpr-bin") echo "$HOME/package/resources/app.asar" ;;
        "-Qqo $HOME/package/t3code") cat "$HOME/executable-owner" ;;
        "-Qqo $HOME/package/resources/app.asar") cat "$HOME/archive-owner" ;;
        *) exit 1 ;;
      esac`,
      );
      const revision = "a".repeat(40);
      yield* writeProgram(
        NodePath.join(root, "t3code"),
        `[ "$ELECTRON_RUN_AS_NODE" = 1 ]
        [ "$1" = "$HOME/package/resources/app.asar/apps/server/dist/bin.mjs" ]
        shift
        echo "$1" >> "$HOME/package-calls"
        if [ "$1" = __ssh-fork-identity ]; then
          [ "$T3CODE_HOME" = /dev/null ] && [ "$2" = ${revision} ] || exit 1
          echo '${forkBuildIdentity.repository} ${forkBuildIdentity.channel} 1.2.3'
        else
          [ "$T3CODE_RESOURCE_MONITOR_PATH" = "$HOME/package/resources/resource-monitor/t3-resource-monitor" ] || exit 1
          [ -z "\${T3CODE_CLI_PATH:-}" ] || exit 1
          echo "$*" >> "$HOME/paired"
          echo '{"credential":"package-fixture"}'
        fi`,
      );
      const pair = (forkBuild?: { channel: string; revision: string }, hostPairing = false) =>
        issueRemotePairingToken(target, tunnelUrl, undefined, runner, "user-fixture").pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            shell({ T3CODE_CLI_PATH: NodePath.join(bin, "t3") }),
          ),
          Effect.provideService(HttpClient.HttpClient, descriptorClient(forkBuild, hostPairing)),
        );
      assert.include((yield* pair().pipe(Effect.flip)).message, "pairing URL");
      const owners = [
        NodePath.join(home, "executable-owner"),
        NodePath.join(home, "archive-owner"),
      ];
      for (const path of owners) yield* fs.writeFileString(path, "t3code-soupslurpr-bin");
      for (const path of owners) {
        yield* fs.writeFileString(path, "t3code-bin");
        assert.include(
          (yield* pair({ channel: forkBuildIdentity.channel, revision }).pipe(Effect.flip)).message,
          "local-arch-package.md",
        );
        assert.isFalse(yield* fs.exists(NodePath.join(home, "package-calls")));
        yield* fs.writeFileString(path, "t3code-soupslurpr-bin");
      }
      assert.include(
        (yield* pair({ channel: forkBuildIdentity.channel, revision: "b".repeat(40) }).pipe(
          Effect.flip,
        )).message,
        "local-arch-package.md",
      );
      assert.isFalse(yield* fs.exists(NodePath.join(home, "paired")));
      assert.equal(
        (yield* pair({ channel: forkBuildIdentity.channel, revision })).credential,
        "package-fixture",
      );
      assert.equal(
        yield* fs.readFileString(NodePath.join(home, "paired")),
        `auth pairing create --base-dir ${home}/.t3 --json\n`,
      );
      yield* pair({ channel: forkBuildIdentity.channel, revision }, true);
      assert.include(
        yield* fs.readFileString(NodePath.join(home, "paired")),
        `auth pairing create --base-dir ${home}/.t3 --json --user-desktop-id user-fixture ${AuthStandardClientScopes.map((scope) => `--scope ${scope}`).join(" ")}\n`,
      );
      assert.isFalse(yield* fs.exists(NodePath.join(home, "unverified")));
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("starts and pairs with the operator's pinned fork CLI and rechecks it for pairing", () =>
    Effect.gen(function* () {
      const { fs, bin, home, writeProgram, shell } = yield* fixture;
      const installed = NodePath.join(bin, "t3");
      yield* fs.copyFile("/bin/sh", installed);
      const commands = {
        "__ssh-fork-identity": `echo '${forkBuildIdentity.repository} ${forkBuildIdentity.channel} 1.2.3'`,
        "__ssh-helper": `case "$1" in
          pick-port) echo 45123 ;;
          wait-ready) read -r _ < "$HOME/served" ;;
          runtime-port) cat "$HOME/runtime-info" ;;
          *) exit 1 ;;
        esac`,
        serve:
          'echo "$$ 45123" > "$HOME/runtime-info"; echo "$*" > "$HOME/serve-args"; echo ready > "$HOME/served"',
        auth: `echo "$*" > "$HOME/pair-args"; echo '{"credential":"fixture"}'`,
      };
      for (const [name, body] of Object.entries(commands)) {
        yield* writeProgram(NodePath.join(home, name), body);
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* spawner.exitCode(ChildProcess.make("mkfifo", [NodePath.join(home, "served")]));
      const digestService = yield* Digest.Digest;
      const digest = Hex.encode(
        yield* digestService.digest(Digest.sha256, yield* fs.readFile(installed)),
      );
      const remote = shell({ T3CODE_SSH_FORK_CLI_SHA256: digest });
      const launch = yield* launchOrReuseRemoteServer(target, undefined, runner).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, remote),
      );
      assert.equal(launch.remoteServerKind, "managed");
      const pairing = issueRemotePairingToken(target, tunnelUrl, undefined, runner).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, remote),
      );
      yield* writeProgram(`${installed}.next`, 'echo replaced >> "$HOME/unverified"');
      yield* writeProgram(
        NodePath.join(bin, "od"),
        `
        if [ -f "$HOME/bin/t3.next" ]; then mv "$HOME/bin/t3.next" "$HOME/bin/t3"; fi
        PATH=/usr/bin:/bin exec od "$@"`,
      );
      assert.equal((yield* pairing).credential, "fixture");
      for (const name of ["serve", "pair"]) {
        assert.include(
          yield* fs.readFileString(NodePath.join(home, `${name}-args`)),
          `--base-dir ${home}/.t3`,
        );
      }
      assert.include((yield* pairing.pipe(Effect.flip)).message, "local-arch-package.md");
      assert.isFalse(yield* fs.exists(NodePath.join(home, "unverified")));
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

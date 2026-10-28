import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { signalOwnedProcess } from "./owned-process.mjs";

import { assert, describe, it } from "vite-plus/test";

import {
  makeDevelopmentEnvironmentScript,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacLauncherPaths,
  writeDevelopmentLauncherScript,
} from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  it("uses captured values only as fallbacks for a live runner environment", () => {
    const environmentScript = makeDevelopmentEnvironmentScript({
      VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
      T3CODE_PORT: "16566",
      T3CODE_HOME: "/tmp/t3",
      T3CODE_OTLP_PROTOCOL: "http/protobuf",
    });

    assert.include(
      environmentScript,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.include(
      environmentScript,
      "if [ -z \"${T3CODE_OTLP_PROTOCOL:-}\" ]; then export T3CODE_OTLP_PROTOCOL='http/protobuf'; fi",
    );
    assert.notInclude(environmentScript, "\nexport VITE_DEV_SERVER_URL=");
  });

  it("keeps the launcher script free of volatile environment values", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });

    assert.include(
      script,
      "if [ -f '/repo/apps/desktop/.electron-runtime/dev-environment.sh' ]; then . '/repo/apps/desktop/.electron-runtime/dev-environment.sh'; fi",
    );
    assert.notInclude(script, "VITE_DEV_SERVER_URL");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app",
      "T3 Code (Dev)",
    );

    assert.equal(paths.launcherExecutableName, "T3 Code (Dev) Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/T3 Code (Dev) Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });

  it("restores execute permissions on an unchanged launcher", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-launcher-"));
    const launcherPath = NodePath.join(directory, "launcher");
    try {
      writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron");
      NodeFS.chmodSync(launcherPath, 0o644);

      assert.isFalse(writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron"));
      assert.equal(NodeFS.statSync(launcherPath).mode & 0o777, 0o755);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

it.each([
  "/tmp/t3-feature.one/apps/desktop",
  "/tmp/t3-feature.one [two](three)+?^${four}|back\\slash*/apps/desktop",
])("dev shutdown leaves an identical sibling alive: %s", async (desktopDir) => {
  const source = NodeFS.readFileSync(new URL("./dev-electron.mjs", import.meta.url), "utf8");
  const argumentsValue = [
    "-e",
    "process.send('ready'); process.stdin.resume()",
    "--",
    `--t3code-dev-root=${desktopDir}`,
    "dist-electron/main.cjs",
  ];
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Exercise native owned process groups.
  const detached = NodeOS.platform() !== "win32";
  const children = [];
  const start = (options) => {
    const child = NodeChildProcess.spawn(process.execPath, argumentsValue, {
      detached: options.detached,
      stdio: ["pipe", "ignore", "inherit", "ipc"],
    });
    children.push(child);
    return child;
  };
  const sibling = start({ detached });
  const siblingReady = NodeEvents.once(sibling, "message");
  const handlers = new Map();
  const stopped = Promise.withResolvers();
  let ownedReady;
  try {
    await NodeVM.runInNewContext(
      `(async () => { ${source.replace(/^import\s[\s\S]*?;\n/gm, "")} })()`,
      {
        NodeChildProcess: {
          execFileSync: () => undefined,
          spawnSync: () => assert.fail("Development cleanup must not search for processes"),
          spawn: (_command, _args, options) => {
            const child = start(options);
            ownedReady = NodeEvents.once(child, "message");
            return child;
          },
        },
        NodeFS: { watch: () => ({ close: () => undefined }) },
        NodeOS,
        NodePath,
        desktopDir,
        resolveDevProtocolClient: () => null,
        resolveElectronLaunchCommand: (args) => ({ electronPath: "electron", args }),
        waitForResources: async () => undefined,
        signalOwnedProcess,
        setTimeout,
        clearTimeout,
        URL,
        process: {
          env: { VITE_DEV_SERVER_URL: "http://localhost:1234" },
          execPath: process.execPath,
          once: (signal, handler) => handlers.set(signal, handler),
          exit: stopped.resolve,
        },
      },
    );
    await Promise.all([siblingReady, ownedReady]);
    assert.lengthOf(children, 2);
    handlers.get("SIGTERM")();
    assert.equal(await stopped.promise, 143);
    assert.isNotNull(children[1].exitCode ?? children[1].signalCode);
    assert.isNull(sibling.exitCode);
    assert.isNull(sibling.signalCode);
    assert.doesNotThrow(() => process.kill(sibling.pid, 0));
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = NodeEvents.once(child, "exit");
        signalOwnedProcess(child, "SIGKILL");
        await exited;
      }),
    );
  }
});

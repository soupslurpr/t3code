import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class NativeResourceError extends Schema.TaggedError<NativeResourceError>()("NativeResourceError", {
  path: Schema.String,
}) {
  override get message() {
    return `Expected a packaged executable at ${this.path}.`;
  }
}

// node-pty searches build/Release before its Node-API prebuild and can load a newer host glibc.
export const linuxPtyExclusions = Effect.fn("linuxPtyExclusions")(function* (
  stage: string,
  arch: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prebuild = path.join(stage, "node_modules/node-pty/prebuilds", `linux-${arch}`, "pty.node");
  return (yield* fs.exists(prebuild)) ? ["!**/node_modules/node-pty/build/**/*"] : [];
});

/** The CLI archive indexes monitors by platform. Electron has one native payload per app. */
export const verifyLinuxComputerResources = Effect.fn("verifyLinuxComputerResources")(function* (
  root: string,
  cliArch?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const monitor = cliArch ? `resource-monitor/linux-${cliArch}` : "resource-monitor";
  const guest = cliArch ? "resources/agent-desktop" : "agent-desktop";
  for (const name of [
    "desktop-native/t3-desktop-frame",
    "desktop-native/t3-screen-gnome",
    `${monitor}/t3-resource-monitor`,
  ]) {
    const filename = path.join(root, name);
    const stat = yield* fs.stat(filename);
    if (stat.type !== "File" || (stat.mode & 0o111) === 0) {
      return yield* new NativeResourceError({ path: filename });
    }
  }
  for (const name of [
    "desktop-native/THIRD-PARTY-NOTICES.txt",
    "resource-monitor/THIRD-PARTY-NOTICES.txt",
    `${guest}/image-builder.mjs`,
    `${guest}/maintenance.sh`,
  ]) {
    yield* fs.access(path.join(root, name), { ok: true, readable: true });
  }
});

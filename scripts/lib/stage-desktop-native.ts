import { stageNativeNotices } from "./desktop-native-notices.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class DesktopNativeBuildError extends Schema.TaggedError<DesktopNativeBuildError>()(
  "DesktopNativeBuildError",
  { target: Schema.String, exitCode: Schema.Number },
) {}

export const stageDesktopNative = Effect.fn("stageDesktopNative")(function* (input: {
  repoRoot: string;
  destination: string;
  arch: "x64" | "arm64";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const target = input.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  const directory = path.join(input.repoRoot, "native", "desktop-native");
  const names = ["t3-desktop-frame", "t3-screen-gnome"];
  const args = [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    path.join(directory, "Cargo.toml"),
    "--target-dir",
    path.join(directory, "target"),
    "--target",
    target,
    ...names.flatMap((name) => ["-p", name]),
  ];
  const handle = yield* spawner.spawn(
    ChildProcess.make("cargo", args, { cwd: input.repoRoot, stdout: "inherit", stderr: "inherit" }),
  );
  const code = yield* handle.exitCode;
  if (code !== 0) return yield* new DesktopNativeBuildError({ target, exitCode: code });
  yield* fs.makeDirectory(input.destination, { recursive: true });
  for (const name of names) {
    const dest = path.join(input.destination, name);
    yield* fs.copyFile(path.join(directory, "target", target, "release", name), dest);
    yield* fs.chmod(dest, 0o755);
  }
  yield* stageNativeNotices(path.join(directory, "Cargo.toml"), target, names, input.destination);
});

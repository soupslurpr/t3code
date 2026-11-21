import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const Package = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  source: Schema.NullOr(Schema.String),
  manifest_path: Schema.String,
});
const Metadata = Schema.Struct({
  packages: Schema.Array(Package),
  resolve: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ id: Schema.String, dependencies: Schema.Array(Schema.String) }),
    ),
  }),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata));
class NativeNoticeError extends Schema.TaggedError<NativeNoticeError>()("NativeNoticeError", {
  detail: Schema.String,
}) {}

/** Cargo's resolved target graph selects the notice files included with each published binary. */
export const stageNativeNotices = Effect.fn("stageNativeNotices")(function* (
  manifest: string,
  target: string,
  names: readonly string[],
  dest: string,
  filename = "THIRD-PARTY-NOTICES.txt",
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cmd = ChildProcess.make(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      target,
      "--manifest-path",
      manifest,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const proc = yield* spawner.spawn(cmd);
  const meta = yield* proc.stdout.pipe(Stream.decodeText, Stream.mkString, Effect.flatMap(decode));
  if ((yield* proc.exitCode) !== 0)
    return yield* new NativeNoticeError({
      detail: "Cargo metadata failed while collecting native license notices.",
    });
  const edges = new Map(meta.resolve.nodes.map((node) => [node.id, node.dependencies]));
  const pending = meta.packages.filter((pkg) => names.includes(pkg.name)).map((pkg) => pkg.id);
  const present = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (present.has(id)) continue;
    present.add(id);
    pending.push(...(edges.get(id) ?? []));
  }
  const sections: string[] = [];
  for (const pkg of meta.packages
    .filter((p) => p.source !== null && present.has(p.id))
    .toSorted((a, b) => a.id.localeCompare(b.id))) {
    const dir = path.dirname(pkg.manifest_path);
    const notices = (yield* fs.readDirectory(dir))
      .filter((file) => /^(LICENSE|LICENCE|COPYING|NOTICE|UNLICENSE)(?:$|[-_.])/i.test(file))
      .sort();
    if (pkg.name === "libwebp-sys2") notices.push("c_src/COPYING", "c_src/PATENTS");
    const texts: string[] = [];
    for (const notice of notices) {
      const file = path.join(dir, notice);
      if ((yield* fs.stat(file)).type === "File") texts.push(yield* fs.readFileString(file));
    }
    if (!texts.length)
      return yield* new NativeNoticeError({
        detail: `Missing packaged license for ${pkg.name} ${pkg.version}`,
      });
    sections.push(
      `${pkg.name} ${pkg.version}\nhttps://crates.io/crates/${pkg.name}/${pkg.version}\n\n${texts.join("\n")}`,
    );
  }
  yield* fs.writeFileString(path.join(dest, filename), sections.join("\n\n"));
});

// @effect-diagnostics nodeBuiltinImport:off - The host owns QEMU images and publishes its manifest with rename.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { lock } from "proper-lockfile";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DesktopImage, DesktopImages } from "./MachinePorts.ts";

const component = /^[a-z0-9-]{1,128}$/u;
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  generation: Schema.String.check(Schema.isPattern(component)),
  fileName: Schema.String,
  sourceRelease: Schema.String,
  profileVersion: Schema.String,
  builtAt: Schema.String,
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));
const encode = Schema.encodeSync(Schema.fromJsonString(Manifest));
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export async function agentDesktopResource(name: string): Promise<string> {
  if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/u.test(name) || name.includes(".."))
    throw new Error("Invalid Agent desktop resource.");
  const parts = import.meta.dirname.split(NodePath.sep);
  const archive = parts.findIndex((part) => part.endsWith(".asar"));
  const dirs = [
    ...(archive < 0
      ? []
      : [NodePath.join(parts.slice(0, archive).join(NodePath.sep), "agent-desktop")]),
    NodePath.resolve(import.meta.dirname, "../../resources/agent-desktop"),
    NodePath.resolve(import.meta.dirname, "resources/agent-desktop"),
    NodePath.resolve(NodePath.dirname(process.execPath), "resources/agent-desktop"),
  ];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, name);
    if (
      await NodeFSP.access(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  throw new Error(`The packaged Agent desktop resource ${name} is missing.`);
}

async function build(output: string) {
  const builderPath = await agentDesktopResource("image-builder.mjs");
  // A file URL loads the same external ES module in Node, Electron and the standalone executable.
  const {
    buildPinnedImage,
  }: {
    buildPinnedImage: (
      path: string,
    ) => Promise<{ readonly profileVersion: string; readonly sourceRelease: string }>;
  } = await import(NodeURL.pathToFileURL(builderPath).href);
  return buildPinnedImage(output);
}

async function syncPath(file: string) {
  const handle = await NodeFSP.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function makeDesktopImages(
  root: string,
  custom?: string,
  buildImage = build,
): DesktopImages {
  const base = NodePath.join(root, "base");
  const images = NodePath.join(base, "images");
  const manifest = NodePath.join(base, "current.json");
  const current = async (): Promise<DesktopImage> => {
    const fallback = {
      path: custom ?? NodePath.join(base, "agent-desktop.qcow2"),
      managed: !custom,
      generation: null,
      profileVersion: null,
      builtAt: null,
    };
    if (custom) return fallback;
    let raw: string;
    try {
      raw = await NodeFSP.readFile(manifest, "utf8");
    } catch (error) {
      if (missing(error)) return fallback;
      throw error;
    }
    const data = decode(raw);
    if (data.fileName !== data.generation + ".qcow2")
      throw new Error("Invalid Agent desktop base manifest.");
    const selected = NodePath.join(images, data.fileName);
    await NodeFSP.access(selected);
    return {
      path: selected,
      managed: true,
      generation: data.generation,
      sourceRelease: data.sourceRelease,
      profileVersion: data.profileVersion,
      builtAt: data.builtAt,
    };
  };
  const exclusive = async <T>(operation: () => Promise<T>) => {
    await NodeFSP.mkdir(images, { recursive: true, mode: 0o700 });
    const release = await lock(base, {
      retries: { retries: 12, minTimeout: 100, maxTimeout: 5_000 },
      stale: 60_000,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  };
  let building: Promise<DesktopImage> | undefined;
  const install = (force: boolean) => {
    if (building) return building;
    building = exclusive(async () => {
      const previous = await current();
      if (
        !force &&
        (await NodeFSP.access(previous.path).then(
          () => true,
          (error) => {
            if (missing(error)) return false;
            throw error;
          },
        ))
      )
        return previous;
      if (custom) throw new Error("The custom Agent desktop base image is caller-managed.");
      const generation = `arch-gnome-${Effect.runSync(Clock.currentTimeMillis)}-${NodeCrypto.randomUUID()}`;
      const fileName = generation + ".qcow2";
      const output = NodePath.join(images, fileName);
      const temporary = manifest + "." + NodeCrypto.randomUUID();
      let published = false;
      try {
        const profile = await buildImage(output);
        await NodeFSP.chmod(output, 0o400);
        await syncPath(output);
        await syncPath(images);
        const data = {
          version: 1 as const,
          generation,
          fileName,
          ...profile,
          builtAt: DateTime.formatIso(Effect.runSync(DateTime.now)),
        };
        await NodeFSP.writeFile(temporary, encode(data), { mode: 0o600, flag: "wx", flush: true });
        await NodeFSP.rename(temporary, manifest);
        published = true;
        await syncPath(base);
        return {
          path: output,
          managed: true,
          generation,
          sourceRelease: profile.sourceRelease,
          profileVersion: profile.profileVersion,
          builtAt: data.builtAt,
        };
      } catch (cause) {
        if (!published) await NodeFSP.rm(output, { force: true });
        throw cause;
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    }).finally(() => {
      building = undefined;
    });
    return building;
  };
  return {
    current,
    ensure: () => install(false),
    refresh: () => install(true),
    async prune(references) {
      if (custom) return;
      await exclusive(async () => {
        const active = (await current()).generation;
        const candidates = (await NodeFSP.readdir(images, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".qcow2"))
          .map((entry) => entry.name.slice(0, -6))
          .filter((id) => component.test(id) && active !== id && !references.has(id));
        const dated = await Promise.all(
          candidates.map(async (id) => ({
            id,
            updated: (await NodeFSP.stat(NodePath.join(images, id + ".qcow2"))).mtimeMs,
          })),
        );
        dated.sort((a, b) => b.updated - a.updated || b.id.localeCompare(a.id));
        for (const { id } of dated.slice(1))
          await NodeFSP.unlink(NodePath.join(images, id + ".qcow2"));
      });
    },
  };
}

// @effect-diagnostics nodeBuiltinImport:off -- Walks qcow2 backing chains before changing files owned by the hypervisor.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { machinePaths } from "../MachinePaths.ts";
import type { DesktopImage, MachinePaths } from "../MachinePorts.ts";
import { command } from "./HostCommand.ts";
import { type Machine, isMissing, privateDirectory, syncDirectory } from "./Inventory.ts";

const FIRMWARE_VARS = "/usr/share/edk2/x64/OVMF_VARS.4m.fd";
const ROLLBACK = "t3-pre-update";
const imageInfo = Schema.Struct({
  filename: Schema.String,
  format: Schema.String,
  "virtual-size": Schema.Number,
  "actual-size": Schema.Number,
  "backing-filename": Schema.optional(Schema.String),
  "full-backing-filename": Schema.optional(Schema.String),
  "format-specific": Schema.optional(
    Schema.Struct({
      data: Schema.Struct({ "data-file": Schema.optional(Schema.String) }),
    }),
  ),
  snapshots: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
});
const decodeInfo = Schema.decodeUnknownSync(Schema.fromJsonString(imageInfo));
const decodeChain = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(imageInfo)));
const img = (args: string[]) => command("/usr/bin/qemu-img", args, 30 * 60_000);

async function entries(directory: string) {
  try {
    return await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
}
async function present(file: string) {
  try {
    await NodeFSP.lstat(file);
    return true;
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
}
const imageRejected = (error: unknown) =>
  error instanceof Error && "code" in error && typeof error.code === "number";

async function qcow2Dependencies(file: string) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = NodeFSP.constants;
  const handle = await NodeFSP.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return;
    const header = Buffer.alloc(80);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 16 || header.readUInt32BE(0) !== 0x514649fb) return;
    const version = header.readUInt32BE(4);
    // Truncation can drop the nonzero low bytes of a backing offset or external-data flag.
    if (version !== 2 && !(version === 3 && bytesRead === header.length)) return;
    const offset = header.readBigUInt64BE(8);
    const flags = version === 3 ? header.readBigUInt64BE(72) : 0n;
    const nameBytes = header.readUInt32BE(16);
    const clusterBits = header.readUInt32BE(20);
    const clusterBytes = clusterBits >= 9 && clusterBits <= 21 ? 2 ** clusterBits : 0;
    return {
      backed: offset !== 0n,
      external: (flags & 4n) !== 0n,
      standalone: offset === 0n && flags === 0n,
      complete:
        clusterBytes > 0 &&
        stat.size >= clusterBytes &&
        (offset === 0n ||
          (nameBytes > 0 && nameBytes <= 1023 && offset + BigInt(nameBytes) <= BigInt(stat.size))),
    };
  } finally {
    await handle.close();
  }
}

function describesDependencies(
  header: NonNullable<Awaited<ReturnType<typeof qcow2Dependencies>>>,
  info: typeof imageInfo.Type,
) {
  const dataFile = info["format-specific"]?.data["data-file"];
  // QEMU resolves relative external data names against its process working directory.
  return (
    (!header.backed || Boolean(info["backing-filename"])) &&
    (!header.external || Boolean(dataFile)) &&
    (!dataFile || NodePath.isAbsolute(dataFile))
  );
}

type RetainPath = (file: string) => void;

async function resolveImagePath(name: string, retain?: RetainPath) {
  const canonical = await NodeFSP.realpath(name);
  retain?.(canonical);
  if (!retain || canonical === name) return canonical;

  // Removing an intermediate symlink also breaks a guest's reference to the final file.
  let directory = NodePath.parse(name).root;
  const pending = name.split(NodePath.sep).reverse();
  let links = 0;
  while (pending.length) {
    const part = pending.pop();
    if (!part || part === ".") continue;
    if (part === "..") {
      directory = NodePath.dirname(directory);
      continue;
    }
    const entry = NodePath.join(directory, part);
    retain(entry);
    if ((await NodeFSP.lstat(entry)).isSymbolicLink()) {
      if (++links > 40) throw new Error("Unresolved image path.");
      const target = await NodeFSP.readlink(entry);
      if (NodePath.isAbsolute(target)) directory = NodePath.parse(target).root;
      pending.push(...target.split(NodePath.sep).reverse());
    } else {
      directory = entry;
    }
  }
  if (directory !== canonical) throw new Error("Image path changed during inspection.");
  return canonical;
}

async function chain(
  imageName: string,
  options: { allowIncomplete?: boolean; retain?: RetainPath; backingOnly?: boolean } = {},
) {
  const { allowIncomplete, retain, backingOnly } = options;
  const file = NodePath.isAbsolute(imageName)
    ? imageName
    : process.cwd() + NodePath.sep + imageName;
  let expected = await resolveImagePath(file, backingOnly ? undefined : retain);
  let output: string;
  try {
    output = await img([
      "info",
      "--force-share",
      "-f",
      "qcow2",
      "--output=json",
      "--backing-chain",
      file,
    ]);
  } catch (cause) {
    if (allowIncomplete && imageRejected(cause) && (await qcow2Dependencies(expected))?.standalone)
      return [expected];
    throw cause;
  }
  const layers = decodeChain(output);
  if (!layers.length || layers.at(-1)?.["backing-filename"] !== undefined)
    throw new Error("Incomplete backing chain.");
  const paths: string[] = [];
  for (const layer of layers) {
    if (
      !NodePath.isAbsolute(layer.filename) ||
      (await NodeFSP.realpath(layer.filename)) !== expected
    )
      throw new Error("Unresolved backing file.");
    if (layer.format === "qcow2") {
      const header = await qcow2Dependencies(expected);
      // QEMU may successfully report a single layer when the dependency name was truncated.
      if (
        !header ||
        !describesDependencies(header, layer) ||
        (!header.complete && !(allowIncomplete && header.standalone))
      )
        throw new Error("Incomplete qcow2 dependency metadata.");
    }
    const dataFile =
      layer.format === "qcow2" ? layer["format-specific"]?.data["data-file"] : undefined;
    if (dataFile) await resolveImagePath(dataFile, retain);
    paths.push(expected);
    const backing = layer["backing-filename"];
    if (backing !== undefined) {
      const name = NodePath.isAbsolute(backing)
        ? backing
        : NodePath.dirname(layer.filename) + NodePath.sep + backing;
      expected = await resolveImagePath(name, retain);
      const full = layer["full-backing-filename"];
      if (full && full !== name && (await resolveImagePath(full, retain)) !== expected)
        throw new Error("Unresolved backing file.");
    }
  }
  return paths;
}

export class DiskImages {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async info(file: string) {
    return decodeInfo(await img(["info", "--force-share", "--output=json", file]));
  }
  async baseSize(file: string) {
    const info = await this.usableInfo(file);
    const size = info?.["virtual-size"];
    if (!info || size === undefined || !Number.isSafeInteger(size) || size > 2 ** 40) {
      throw new Error("The Agent desktop base must be a readable qcow2 image of at most 1 TiB.");
    }
    if (info["backing-filename"] || info["format-specific"]?.data["data-file"]) await chain(file);
    return size;
  }
  async create(vm: MachinePaths, image: DesktopImage, size: number) {
    const base = await NodeFSP.realpath(image.path);
    const virtualBytes = Math.max(size, await this.baseSize(base));
    await this.prepare(vm);
    await img(["create", "-f", "qcow2", "-F", "qcow2", "-b", base, vm.disk, String(virtualBytes)]);
    await img(["convert", "-f", "raw", "-O", "qcow2", FIRMWARE_VARS, vm.nvram]);
    await syncDirectory(vm.directory);
    return virtualBytes;
  }
  async prepare(vm: MachinePaths) {
    await privateDirectory(NodePath.dirname(vm.directory));
    await NodeFSP.mkdir(vm.directory, { mode: 0o700 });
    await privateDirectory(vm.captureDirectory);
  }
  async copySize(vm: MachinePaths) {
    const decode = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ required: Schema.Number })),
    );
    const size = await Promise.all(
      [vm.disk, vm.nvram].map(
        async (file) =>
          decode(
            await img([
              "measure",
              "--force-share",
              "-f",
              "qcow2",
              "-O",
              "qcow2",
              "--output=json",
              file,
            ]),
          ).required,
      ),
    );
    return size.reduce((a, b) => a + b, 0);
  }
  async clone(source: MachinePaths, target: MachinePaths) {
    const backing = (await chain(source.disk))[1];
    const managed =
      backing &&
      NodePath.dirname(backing) ===
        (await NodeFSP.realpath(NodePath.join(this.root, "base", "images")).catch(
          (error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
          },
        ));
    await this.prepare(target);
    try {
      await img([
        "convert",
        "--force-share",
        "-f",
        "qcow2",
        "-O",
        "qcow2",
        ...(managed ? ["-b", backing, "-F", "qcow2"] : []),
        source.disk,
        target.disk,
      ]);
      await img([
        "convert",
        "--force-share",
        "-f",
        "qcow2",
        "-O",
        "qcow2",
        source.nvram,
        target.nvram,
      ]);
      await syncDirectory(target.directory);
    } catch (e) {
      await NodeFSP.rm(target.directory, { recursive: true, force: true });
      throw e;
    }
  }
  async snapshots(file: string) {
    return (await this.info(file)).snapshots?.map((s) => s.name) ?? [];
  }
  private async usableInfo(file: string) {
    if (!(await present(file))) return;
    try {
      const info = await this.info(file);
      if (info.format !== "qcow2" || info["virtual-size"] <= 0) return;
      const header = await qcow2Dependencies(await NodeFSP.realpath(file));
      return header?.complete && describesDependencies(header, info) ? info : undefined;
    } catch (cause) {
      if (!imageRejected(cause)) throw cause;
      return undefined;
    }
  }
  async hasPair(vm: MachinePaths) {
    return (await Promise.all([vm.disk, vm.nvram].map((file) => this.usableInfo(file)))).every(
      Boolean,
    );
  }
  async hasPark(vm: MachinePaths) {
    const pair = await Promise.all([vm.disk, vm.nvram].map((file) => this.snapshots(file)));
    return pair.every((tags) => tags.includes("t3-parked"));
  }
  private async discard(vm: MachinePaths, tag: string, allowMissing = false) {
    let complete = true;
    for (const file of [vm.disk, vm.nvram]) {
      const info = allowMissing ? await this.usableInfo(file) : await this.info(file);
      if (!info) {
        complete = false;
        continue;
      }
      if (info.snapshots?.some((snapshot) => snapshot.name === tag))
        await img(["snapshot", "-d", tag, file]);
    }
    return complete;
  }
  discardPark(vm: MachinePaths, allowMissing = false) {
    return this.discard(vm, "t3-parked", allowMissing);
  }
  async discardRollback(vm: MachinePaths) {
    await this.discard(vm, ROLLBACK);
  }
  async createRollback(vm: MachinePaths) {
    await this.discardRollback(vm);
    for (const file of [vm.disk, vm.nvram]) await img(["snapshot", "-c", ROLLBACK, file]);
  }
  async applyRollbackDisk(file: string) {
    await img(["snapshot", "-a", ROLLBACK, file]);
  }
  async restoreRollback(vm: MachinePaths) {
    // Keep both snapshots until the inventory durably acknowledges both applications.
    await this.applyRollbackDisk(vm.disk);
    await this.applyRollbackDisk(vm.nvram);
  }

  async references(rows: readonly Machine[], deleting?: MachinePaths, base?: DesktopImage) {
    const root = await NodeFSP.realpath(this.root);
    const machines = NodePath.join(root, "machines");
    const imageDir = NodePath.join(root, "base", "images");
    const images = await NodeFSP.realpath(imageDir).catch((error: unknown) => {
      if (isMissing(error)) return imageDir;
      throw error;
    });
    const deletingDir = deleting && NodePath.join(machines, deleting.id);
    const references = new Set(
      rows.flatMap((row) => (row.baseGeneration ? [row.baseGeneration] : [])),
    );
    const known = new Set(rows.map((row) => row.id));
    if ((await entries(machines)).some((e) => !e.isDirectory() || !known.has(e.name)))
      throw new Error("The machine directory and inventory disagree.");
    const retain = (file: string) => {
      if (deletingDir && (file === deletingDir || file.startsWith(deletingDir + NodePath.sep)))
        throw new Error("Another image still uses this Agent desktop as a backing file.");
      if (NodePath.dirname(file) === images && file.endsWith(".qcow2"))
        references.add(NodePath.basename(file, ".qcow2"));
    };
    for (const row of rows) {
      if (row.id === deleting?.id) continue;
      const vm = machinePaths(root, row.id);
      const incomplete = ["creating", "failed", "recoverable", "deleting"].includes(row.state);
      for (const file of [vm.disk, vm.nvram]) {
        if (incomplete && !(await present(file))) continue;
        await chain(file, { retain, allowIncomplete: incomplete });
      }
    }
    // A generation retained for rollback can itself depend on an older generation.
    for (const entry of await entries(images)) {
      if (!entry.name.endsWith(".qcow2")) continue;
      if (!entry.isFile()) throw new Error("Unresolved base image entry.");
      await chain(NodePath.join(images, entry.name), { retain, backingOnly: true });
    }
    if (base && !base.managed) await chain(base.path, { retain });
    const legacy = NodePath.join(root, "base", "agent-desktop.qcow2");
    try {
      await NodeFSP.lstat(legacy);
    } catch (error) {
      if (isMissing(error)) return references;
      throw error;
    }
    await chain(legacy, { retain });
    return references;
  }
}

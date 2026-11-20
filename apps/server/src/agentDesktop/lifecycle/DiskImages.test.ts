// @effect-diagnostics nodeBuiltinImport:off -- Backing-chain paths are resolved against real disposable files, including symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { machinePaths } from "../MachinePaths.ts";
import { DiskImages } from "./DiskImages.ts";
import * as HostCommand from "./HostCommand.ts";
import { fixture, row as retained, qcow2Image } from "./LifecycleFixture.test-support.ts";
import type { Machine } from "./Inventory.ts";

it("keeps backing generations from v1 rows, clones, trash, and base chains and fails closed on unknown or unreadable disks", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-backing-test-"));
  const root = NodePath.join(directory, "actual");
  const alias = NodePath.join(directory, "alias");
  try {
    const imageDir = NodePath.join(root, "base", "images");
    await NodeFSP.mkdir(imageDir, { recursive: true });
    await NodeFSP.symlink(root, alias);
    const base = NodePath.join(imageDir, "old.qcow2");
    const prior = NodePath.join(imageDir, "older.qcow2");
    await Promise.all([
      NodeFSP.writeFile(base, qcow2Image()),
      NodeFSP.writeFile(prior, qcow2Image()),
    ]);
    const source = machinePaths(root, "agent-" + "a".repeat(32));
    const copy = machinePaths(root, "agent-" + "b".repeat(32));
    for (const vm of [source, copy]) {
      await NodeFSP.mkdir(vm.directory, { recursive: true });
      await Promise.all([
        NodeFSP.writeFile(vm.disk, qcow2Image()),
        NodeFSP.writeFile(vm.nvram, qcow2Image()),
      ]);
    }
    const row: Machine = {
      id: source.id,
      owner: {
        environmentId: EnvironmentId.make("e"),
        threadId: ThreadId.make("t"),
        controllerId: "c",
      },
      label: "source",
      resources: { cpuCount: 2, memoryBytes: 2 ** 31, diskVirtualBytes: 2 ** 36, audio: false },
      state: "stopped",
      createdAt: "2026-01-01",
      lastActiveAt: "2026-01-01",
      recoverableUntil: null,
      routes: [],
    };
    const rows = [
      row,
      { ...row, id: copy.id, state: "recoverable" as const, baseGeneration: "legacy-flat-clone" },
    ];
    const links = new Map([
      [source.disk, base],
      [base, prior],
      [copy.disk, source.disk],
    ]);
    for (const [file, backing] of links) {
      const image = qcow2Image();
      const name = Buffer.from(backing);
      image.writeBigUInt64BE(112n, 8);
      image.writeUInt32BE(name.length, 16);
      name.copy(image, 112);
      await NodeFSP.writeFile(file, image);
    }
    let unreadable = false;
    using _qemu = vi.spyOn(HostCommand, "command").mockImplementation(async (_, args) => {
      let file: string | undefined = await NodeFSP.realpath(args.at(-1)!);
      if (unreadable && file === copy.nvram) {
        if (
          args.includes("--backing-chain") &&
          !args.includes("-f") &&
          (await NodeFSP.stat(file)).size < 8
        )
          return JSON.stringify([
            { filename: file, format: "raw", "actual-size": 0, "virtual-size": 0 },
          ]);
        throw Object.assign(new Error("unreadable firmware"), { code: 1 });
      }
      const chain = [];
      while (file) {
        const backing: string | undefined = links.get(file);
        chain.push({
          filename: file,
          format: "qcow2",
          "virtual-size": 4096,
          "actual-size": 1024,
          "backing-filename": backing,
        });
        file = backing;
      }
      return JSON.stringify(args.includes("--backing-chain") ? chain : chain[0]);
    });
    const disks = new DiskImages(alias);
    expect(await disks.references(rows)).toEqual(new Set(["old", "older", "legacy-flat-clone"]));
    await expect(disks.references(rows, machinePaths(alias, source.id))).rejects.toThrow(
      "backing file",
    );
    const partial = machinePaths(root, "agent-" + "c".repeat(32));
    await NodeFSP.mkdir(partial.directory);
    await NodeFSP.writeFile(partial.disk, qcow2Image());
    links.set(partial.disk, prior);
    const incomplete = { ...row, id: partial.id, state: "creating" as const };
    expect(await disks.references([...rows, incomplete])).toContain("older");
    expect(
      await disks.references([
        ...rows,
        { ...incomplete, state: "failed", detail: "The Agent desktop disks could not be created." },
      ]),
    ).toContain("older");
    expect(await disks.references([...rows, { ...incomplete, state: "recoverable" }])).toContain(
      "older",
    );
    await expect(
      disks.references([...rows, { ...incomplete, state: "stopped" }]),
    ).rejects.toThrow();
    await NodeFSP.rm(partial.directory, { recursive: true });
    unreadable = true;
    const header = qcow2Image().subarray(0, 100);
    // An interrupted conversion may already have written a reference to another image.
    header.writeBigUInt64BE(528n, 8);
    for (const length of [0, 4, 14, 15, 100]) {
      await NodeFSP.writeFile(copy.nvram, header.subarray(0, length));
      await expect(disks.references(rows)).rejects.toThrow("unreadable firmware");
    }
    header.writeBigUInt64BE(0n, 8);
    header.writeBigUInt64BE(4n, 72);
    for (const length of [79, 80, 100]) {
      await NodeFSP.writeFile(copy.nvram, header.subarray(0, length));
      await expect(disks.references(rows)).rejects.toThrow("unreadable firmware");
    }
    header.writeBigUInt64BE(0n, 72);
    for (const length of [80, 100]) {
      await NodeFSP.writeFile(copy.nvram, header.subarray(0, length));
      expect(await disks.hasPair(copy)).toBe(false);
      expect(await disks.references(rows)).toContain("older");
    }
    expect(await disks.discardPark(copy, true)).toBe(false);
    unreadable = false;
    for (const length of [100, 511]) {
      await NodeFSP.writeFile(copy.nvram, qcow2Image().subarray(0, length));
      expect(await disks.references(rows)).toContain("older");
      expect(await disks.hasPair(copy)).toBe(false);
    }
    await NodeFSP.writeFile(copy.nvram, qcow2Image());
    expect(await disks.hasPair(copy)).toBe(true);
    unreadable = true;
    header.writeUInt32BE(4, 4);
    await NodeFSP.writeFile(copy.nvram, header);
    await expect(disks.references(rows)).rejects.toThrow("unreadable firmware");
    header.writeUInt32BE(2, 4);
    await NodeFSP.writeFile(copy.nvram, header.subarray(0, 15));
    await expect(disks.references(rows)).rejects.toThrow("unreadable firmware");
    await NodeFSP.writeFile(copy.nvram, header.subarray(0, 16));
    expect(await disks.references(rows)).toContain("older");
    await NodeFSP.mkdir(NodePath.join(root, "machines", "unknown"));
    await expect(disks.references(rows)).rejects.toThrow("inventory disagree");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it.each([true, false])(
  "retains a QEMU-reported external data file when the on-disk flag is %s",
  async (flag) => {
    const vmRow = { ...retained, state: "stopped" as const, baseGeneration: undefined };
    const dependent = { ...vmRow, id: "agent-" + "2".repeat(32) };
    await using f = await fixture([vmRow, dependent]);
    const source = machinePaths(f.directory, vmRow.id),
      target = machinePaths(f.directory, dependent.id);
    for (const vm of [source, target]) {
      await NodeFSP.mkdir(vm.directory, { recursive: true });
      await Promise.all([vm.disk, vm.nvram].map((file) => NodeFSP.writeFile(file, qcow2Image())));
    }
    const imageDir = NodePath.join(f.directory, "base", "images");
    await NodeFSP.mkdir(imageDir, { recursive: true });
    const retainedData = NodePath.join(imageDir, "external.qcow2");
    await NodeFSP.writeFile(retainedData, qcow2Image());
    let dataFile = retainedData;
    using _qemu = vi.spyOn(HostCommand, "command").mockImplementation(async (_, args) => {
      const file = args.at(-1);
      return JSON.stringify([
        {
          filename: file,
          format: "qcow2",
          "actual-size": 4096,
          "virtual-size": 4096,
          ...(file === source.disk && {
            "format-specific": { type: "qcow2", data: { "data-file": dataFile } },
          }),
        },
      ]);
    });
    const disks = new DiskImages(f.directory);
    async function writeReference(name: string) {
      dataFile = name;
      const bytes = qcow2Image();
      if (flag) {
        bytes.writeBigUInt64BE(4n, 72);
        const extension = Buffer.from(name);
        bytes.writeUInt32BE(0x44415441, 104);
        bytes.writeUInt32BE(extension.length, 108);
        extension.copy(bytes, 112);
      }
      await NodeFSP.writeFile(source.disk, bytes);
    }
    await writeReference(retainedData);
    expect(await disks.references([vmRow, dependent])).toContain("external");
    const intermediate = NodePath.join(target.directory, "image-store");
    const alias = NodePath.join(source.directory, "shared-store");
    await NodeFSP.symlink(imageDir, intermediate);
    await NodeFSP.symlink(NodePath.relative(source.directory, intermediate), alias);
    await writeReference(NodePath.join(alias, "external.qcow2"));
    expect(await disks.references([vmRow, dependent])).toContain("external");
    await expect(disks.references([vmRow, dependent], target)).rejects.toThrow("backing file");
    const custom = {
      path: NodePath.relative(process.cwd(), NodePath.join(alias, "external.qcow2")),
      generation: null,
      managed: false,
      profileVersion: null,
      builtAt: null,
    };
    expect(await disks.references([vmRow, dependent], undefined, custom)).toContain("external");
    await writeReference(target.nvram);
    await expect(disks.references([vmRow, dependent], target)).rejects.toThrow();
    await writeReference(NodePath.relative(NodePath.dirname(source.disk), retainedData));
    await expect(disks.references([vmRow, dependent])).rejects.toThrow();
  },
);

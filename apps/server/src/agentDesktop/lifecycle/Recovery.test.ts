// @effect-diagnostics nodeBuiltinImport:off -- Fault injection exercises durable machine files across independent lifecycle instances.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { ThreadId, type AgentDesktopPortRoute } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { machinePaths } from "../MachinePaths.ts";
import { makeDesktopLifecycle } from "./DesktopLifecycle.ts";
import { Admission } from "./Admission.ts";
import { DiskImages } from "./DiskImages.ts";
import { QemuMachine } from "./QemuMachine.ts";
import { Inventory } from "./Inventory.ts";
import * as HostCommand from "./HostCommand.ts";
import {
  fixture,
  owner,
  row,
  id,
  createdAt,
  writeDiskPair,
  qcow2Image,
} from "./LifecycleFixture.test-support.ts";

const route: AgentDesktopPortRoute = {
  id: "route-from-inventory",
  protocol: "tcp",
  hostAddress: "127.0.0.1",
  hostPort: 10240,
  guestPort: 8080,
  visibility: "local",
  createdAt: createdAt,
};
const selected = { path: "", managed: true, generation: null, profileVersion: null, builtAt: null };

it("uses the durable start or park intent and requires both disks before recovering memory", async () => {
  const ids = Array.from({ length: 7 }, (_, i) => "agent-" + String(i + 1).repeat(32));
  const starts = [false, true, true, undefined].map((savedMemory) => ({
    state: "starting",
    savedMemory,
  }));
  const parks = [false, true].map((savedMemory) => ({ state: "parking", savedMemory }));
  await using f = await fixture(
    [...starts, ...parks, { state: "parked" }].map((r, i) => ({ ...row, ...r, id: ids[i] })),
  );
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(false);
  using _snapshots = vi
    .spyOn(DiskImages.prototype, "snapshots")
    .mockImplementation(async (file) =>
      file.includes(ids[2]!) && file.endsWith("nvram.qcow2") ? [] : ["t3-parked"],
    );
  const life = await makeDesktopLifecycle(f.options);
  expect((await life.list(owner)).map((item) => item.state)).toEqual([
    "stopped",
    "parked",
    "stopped",
    "stopped",
    "stopped",
    "parked",
    "parked",
  ]);
});

it("clears an old memory snapshot on both disks before another save or explicit stop", async () => {
  await using f = await fixture([row]);
  const tags = new Set(["disk.qcow2", "nvram.qcow2"]);
  using _images = await writeDiskPair(f.directory, id, (file) =>
    tags.has(NodePath.basename(file)) ? ["t3-parked"] : [],
  );
  let live = true;
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockImplementation(async () => live);
  using _attach = vi.spyOn(QemuMachine.prototype, "reattach").mockResolvedValue([]);
  using _work = vi.spyOn(Admission.prototype, "workspace").mockResolvedValue(() => {});
  vi.mocked(f.options.guest.qmp).mockImplementation(async (_vm, command, args) => {
    if (command === "blockdev-snapshot-delete-internal-sync") {
      expect(JSON.parse(await NodeFSP.readFile(f.file, "utf8")).desktops[0]).toMatchObject({
        state: "parking",
        savedMemory: false,
      });
      tags.delete(args?.device === "t3-system-disk" ? "disk.qcow2" : "nvram.qcow2");
    }
    return "";
  });
  using _save = vi.spyOn(QemuMachine.prototype, "park").mockImplementation(async () => {
    expect([...tags]).toEqual([]);
    expect(JSON.parse(await NodeFSP.readFile(f.file, "utf8")).desktops[0]).toMatchObject({
      state: "parking",
      savedMemory: true,
    });
    live = false;
  });
  const life = await makeDesktopLifecycle(f.options);
  expect(await life.manage(owner, { desktopId: id, operation: "park" })).toMatchObject({
    state: "parked",
  });
  tags.add("disk.qcow2");
  tags.add("nvram.qcow2");
  using _img = vi.spyOn(HostCommand, "command").mockImplementation(async (_, args) => {
    expect(args.slice(0, 3)).toEqual(["snapshot", "-d", "t3-parked"]);
    expect(JSON.parse(await NodeFSP.readFile(f.file, "utf8")).desktops[0]).toMatchObject({
      state: "stopping",
      savedMemory: false,
    });
    tags.delete(NodePath.basename(args.at(-1)!));
    return "";
  });
  expect(await life.manage(owner, { desktopId: id, operation: "stop" })).toMatchObject({
    state: "stopped",
  });
  expect([...tags]).toEqual([]);
});

it("allows just one same-thread controller to restore legacy trash and claim its ownership", async () => {
  await using f = await fixture([
    { ...row, state: "recoverable", recoverableUntil: "2199-01-01T00:00:00Z" },
  ]);
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(false);
  const life = await makeDesktopLifecycle(f.options);
  const peer = { ...owner, controllerId: "replacement" };
  const other = { ...peer, threadId: ThreadId.make("other") };
  await expect(life.manage(other, { desktopId: id, operation: "restore" })).rejects.toThrow(
    "different owner",
  );
  await expect(
    life.manage(peer, { desktopId: id, operation: "delete-permanently" }),
  ).rejects.toThrow("different owner");
  const restored = await Promise.allSettled(
    [peer, owner].map((o) => life.manage(o, { desktopId: id, operation: "restore" })),
  );
  expect(restored[0]).toMatchObject({
    status: "fulfilled",
    value: { owner: peer, state: "failed" },
  });
  expect(restored[1]).toMatchObject({ status: "rejected" });
  await expect(
    life.manage(owner, { desktopId: id, operation: "delete-permanently" }),
  ).rejects.toThrow("different owner");
  expect(JSON.parse(await NodeFSP.readFile(f.file, "utf8")).desktops[0].owner).toEqual(peer);
});

it.each(["backing offset", "external data flag"] as const)(
  "blocks pruning and deletion and restores trash as failed when QEMU omits the %s declared by a 104-byte header",
  async (declaration) => {
    const targetId = "agent-" + "2".repeat(32);
    const trash = {
      ...row,
      state: "recoverable" as const,
      recoverableUntil: "2199-01-01T00:00:00Z",
    };
    const target = { ...row, id: targetId, state: "stopped" as const };
    await using f = await fixture([trash, target]);
    const damaged = machinePaths(f.directory, id);
    const victim = machinePaths(f.directory, targetId);
    for (const vm of [damaged, victim]) {
      await NodeFSP.mkdir(vm.directory, { recursive: true });
      await Promise.all([vm.disk, vm.nvram].map((file) => NodeFSP.writeFile(file, qcow2Image())));
    }
    const fragment = qcow2Image().subarray(0, 104);
    if (declaration === "backing offset") fragment.writeBigUInt64BE(256n, 8);
    else fragment.writeBigUInt64BE(4n, 72);
    await NodeFSP.writeFile(damaged.nvram, fragment);
    using _img = vi.spyOn(HostCommand, "command").mockImplementation(async (_, args) => {
      const info = {
        filename: args.at(-1),
        format: "qcow2",
        "actual-size": 4096,
        "virtual-size": 4096,
      };
      return JSON.stringify(args.includes("--backing-chain") ? [info] : info);
    });
    using _stopped = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(false);
    vi.mocked(f.options.images.current).mockResolvedValue({ ...selected, path: f.file });
    const disks = new DiskImages(f.directory);
    const life = await makeDesktopLifecycle(f.options);
    await expect(disks.references([trash, target])).rejects.toThrow();
    await expect(
      life.manage(owner, { desktopId: targetId, operation: "delete-permanently" }),
    ).rejects.toThrow();
    expect(await life.manage(owner, { desktopId: id, operation: "restore" })).toMatchObject({
      state: "failed",
    });
    expect(await NodeFSP.readFile(victim.disk)).toEqual(qcow2Image());
  },
);

it("reconciles unknown and unavailable routes after restart, retries filter cleanup during leases, and removes a failed VM's desired route offline", async () => {
  const id = "agent-" + NodeCrypto.randomUUID().replaceAll("-", "");
  const lost = { ...route, id: "lost-after-failed-start" };
  const failedId = "agent-" + "2".repeat(32);
  await using f = await fixture([
    { ...row, id, routes: [route] },
    { ...row, id: failedId, state: "failed", routes: [lost] },
  ]);
  await using _runtime = {
    [Symbol.asyncDispose]: () =>
      NodeFSP.rm(machinePaths(f.directory, id).runtimeDirectory, { recursive: true, force: true }),
  };
  const installed = new Set(["orphan-from-interrupted-add"]);
  vi.mocked(f.options.network.reconcileRoutes).mockImplementation(async (_, desired) => {
    installed.clear();
    return desired.map((r) => ({
      ...r,
      state: "unavailable",
      detail: "host port is already in use",
    }));
  });
  vi.mocked(f.options.images.current).mockResolvedValue({
    ...selected,
    managed: false,
    path: f.file,
  });
  using _running = vi
    .spyOn(QemuMachine.prototype, "running")
    .mockImplementation(async (vm) => vm.id === id);
  using _usage = vi.spyOn(QemuMachine.prototype, "usage").mockResolvedValue({ memory: 0, cpu: 0 });
  using _disk = vi.spyOn(DiskImages.prototype, "info").mockResolvedValue({
    filename: "test",
    format: "qcow2",
    "actual-size": 128,
    "virtual-size": 1024,
  });
  const life = await makeDesktopLifecycle(f.options);
  await life.inspect(owner, id, false);
  expect([...installed]).toEqual([]);
  expect(vi.mocked(f.options.network.inspect).mock.calls.at(-1)?.[1]).toEqual([
    { ...route, state: "unavailable", detail: "host port is already in use" },
  ]);
  await life.lease(owner, id, "control");
  const job = await life.begin(owner, id, "owned");
  vi.mocked(f.options.network.route).mockImplementationOnce(async () => {
    installed.add("unacknowledged-route");
    throw new Error("lost control reply");
  });
  await expect(life.route(owner, id, { guestPort: 8081 })).rejects.toThrow("lost control reply");
  expect([...installed]).toEqual([]);
  const cleanups = vi.mocked(f.options.network.reconcile);
  cleanups.mockClear();
  await life.acquire(owner, { desktopId: id });
  cleanups.mockRejectedValueOnce(new Error("filter is still attached"));
  await expect(life.maintain()).rejects.toThrow();
  await Promise.all([life.maintain(), life.maintain()]);
  expect(cleanups).toHaveBeenCalledTimes(2);
  await expect(life.manage(owner, { desktopId: id, operation: "park" })).rejects.toThrow();
  await job.release();
  await life.maintain();
  expect(cleanups).toHaveBeenCalledTimes(3);
  expect((await life.list(owner)).find((item) => item.id === id)).toMatchObject({
    state: "active",
    controllerId: owner.controllerId,
  });
  await life.lease(owner, id, "release");
  using _start = vi
    .spyOn(QemuMachine.prototype, "start")
    .mockRejectedValue(new Error("failed VM must stay offline"));
  expect(await life.route(owner, failedId, lost.id)).toEqual([]);
  expect(_start).not.toHaveBeenCalled();
  expect(f.options.network.apply).not.toHaveBeenCalled();
  expect(
    JSON.parse(await NodeFSP.readFile(f.file, "utf8")).desktops.find(
      (r: { id: string }) => r.id === failedId,
    ).routes,
  ).toEqual([]);
});

it("keeps interrupted provisions and unrecorded clones out of the published backing graph", async () => {
  await using f = await fixture([{ ...row, state: "stopped" }]);
  vi.mocked(f.options.images.current).mockResolvedValue({ ...selected, path: f.file });
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(false);
  using _graphics = vi.spyOn(QemuMachine.prototype, "graphics").mockResolvedValue("virtio-gpu-2d");
  using _capacity = vi
    .spyOn(Admission.prototype, "vm")
    .mockResolvedValue({ resources: row.resources, release: () => {} });
  using _workspace = vi.spyOn(Admission.prototype, "workspace").mockResolvedValue(() => {});
  using _bytes = vi.spyOn(DiskImages.prototype, "copySize").mockResolvedValue(4096);
  using _create = vi.spyOn(DiskImages.prototype, "create").mockImplementation(async (vm) => {
    await NodeFSP.mkdir(vm.directory, { recursive: true });
    await NodeFSP.writeFile(vm.disk, "partial write");
    throw new Error("firmware conversion failed");
  });
  using _clone = vi.spyOn(QemuMachine.prototype, "clone").mockImplementation(async (_, dest) => {
    await NodeFSP.mkdir(dest.directory, { recursive: true });
    await NodeFSP.writeFile(dest.disk, qcow2Image("copied system disk"));
    await NodeFSP.writeFile(dest.nvram, qcow2Image("copied firmware"));
  });
  const life = await makeDesktopLifecycle(f.options);
  await expect(life.acquire(owner, { fresh: true })).rejects.toThrow("firmware conversion failed");
  const put = Inventory.prototype.put;
  using _crash = vi.spyOn(Inventory.prototype, "put").mockImplementation(async function (
    this: Inventory,
    item,
  ) {
    if (item.id !== id) throw new Error("inventory write interrupted");
    return put.call(this, item);
  });
  await expect(life.manage(owner, { desktopId: id, operation: "clone" })).rejects.toThrow(
    "inventory write interrupted",
  );
  _crash.mockRestore();
  const restarted = await makeDesktopLifecycle(f.options);
  await restarted.manage(owner, { desktopId: id, operation: "delete-permanently" });
  expect(await restarted.list(owner)).toEqual([]);
  const published = NodePath.dirname(machinePaths(f.directory, id).directory);
  expect(await NodeFSP.readdir(published).catch(() => [])).toEqual([]);
});

it("finishes publishing a durable disk pair after a crash on either side of rename", async () => {
  const copied = "agent-" + "2".repeat(32);
  const pending = { ...row, state: "creating", publishingDisks: true, savedMemory: false };
  await using f = await fixture([pending, { ...pending, id: copied }]);
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(false);
  const staging = NodePath.join(f.directory, "staging");
  for (const vm of [machinePaths(staging, id), machinePaths(f.directory, copied)]) {
    await NodeFSP.mkdir(vm.directory, { recursive: true });
    await NodeFSP.writeFile(vm.disk, qcow2Image("system-" + vm.id));
    await NodeFSP.writeFile(vm.nvram, qcow2Image("firmware-" + vm.id));
  }
  const life = await makeDesktopLifecycle(f.options);
  expect((await life.list(owner)).map((item) => item.state)).toEqual(["stopped", "stopped"]);
  for (const vm of [machinePaths(f.directory, id), machinePaths(f.directory, copied)]) {
    expect(await NodeFSP.readFile(vm.disk)).toEqual(qcow2Image("system-" + vm.id));
    expect(await NodeFSP.readFile(vm.nvram)).toEqual(qcow2Image("firmware-" + vm.id));
  }
  expect(await NodeFSP.readdir(NodePath.join(staging, "machines"))).toEqual([]);
  const updated = new Inventory(f.directory);
  expect((await updated.read()).desktops.some((item) => item.publishingDisks)).toBe(false);
});

it("preserves a parked source on failed reset and invalidates its memory only once the replacement is ready", async () => {
  await using f = await fixture([{ ...row, state: "parked", savedMemory: true }]);
  using _images = await writeDiskPair(f.directory, id);
  vi.mocked(f.options.images.current).mockResolvedValue({ ...selected, path: f.file });
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(false);
  using _graphics = vi.spyOn(QemuMachine.prototype, "graphics").mockResolvedValue("virtio-gpu-2d");
  using _capacity = vi
    .spyOn(Admission.prototype, "vm")
    .mockResolvedValue({ resources: row.resources, release: () => {} });
  using _create = vi.spyOn(DiskImages.prototype, "create").mockImplementation(async (vm) => {
    await NodeFSP.mkdir(vm.directory, { recursive: true });
    await Promise.all(
      [vm.disk, vm.nvram].map((file) => NodeFSP.writeFile(file, qcow2Image("replacement"))),
    );
    return row.resources.diskVirtualBytes;
  });
  const booted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  using _start = vi
    .spyOn(QemuMachine.prototype, "start")
    .mockRejectedValueOnce(new Error("launch failed"))
    .mockImplementation(async () => {
      booted.resolve();
      await finish.promise;
      return [];
    });
  using _discard = vi.spyOn(DiskImages.prototype, "discardPark").mockResolvedValue(true);
  const life = await makeDesktopLifecycle(f.options);
  await expect(life.manage(owner, { desktopId: id, operation: "reset" })).rejects.toThrow(
    "launch failed",
  );
  expect(_discard).not.toHaveBeenCalled();
  expect(await new Inventory(f.directory).get(id)).toMatchObject({
    state: "parked",
    savedMemory: true,
  });
  const replaced = life.manage(owner, { desktopId: id, operation: "reset" });
  await booted.promise;
  expect(_discard).not.toHaveBeenCalled();
  finish.resolve();
  expect((await replaced).id).not.toBe(id);
  expect(_discard.mock.calls.map(([vm]) => vm.id)).toEqual([id]);
  expect(await new Inventory(f.directory).get(id)).toMatchObject({
    state: "recoverable",
    savedMemory: false,
  });
  expect(await life.manage(owner, { desktopId: id, operation: "restore" })).toMatchObject({
    state: "stopped",
  });
});

it("deletes an unrelated machine despite two partial v1 provisions and interrupted deletion, while retaining every present backing file", async () => {
  const second = "agent-" + "2".repeat(32);
  const deleting = "agent-" + "3".repeat(32);
  const unrelated = "agent-" + "4".repeat(32);
  await using f = await fixture([
    { ...row, state: "failed" },
    { ...row, id: second, state: "creating" },
    { ...row, id: deleting, state: "deleting" },
    { ...row, id: unrelated, state: "stopped" },
  ]);
  vi.mocked(f.options.images.current).mockResolvedValue({ ...selected, path: f.file });
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(false);
  const first = machinePaths(f.directory, id);
  const partial = machinePaths(f.directory, second);
  const target = machinePaths(f.directory, unrelated);
  for (const [vm, file] of [
    [first, first.disk],
    [partial, partial.nvram],
    [target, target.disk],
  ] as const) {
    await NodeFSP.mkdir(vm.directory, { recursive: true });
    await NodeFSP.writeFile(file, qcow2Image("disk"));
  }
  await NodeFSP.writeFile(target.nvram, qcow2Image("firmware"));
  let backed = true;
  using _img = vi.spyOn(HostCommand, "command").mockImplementation(async (_, args) => {
    const filename = await NodeFSP.realpath(args.at(-1)!);
    const info = { filename, format: "qcow2", "actual-size": 512, "virtual-size": 4096 };
    if (!args.includes("--backing-chain")) return JSON.stringify(info);
    return JSON.stringify(
      backed && filename === partial.nvram
        ? [
            { ...info, "backing-filename": target.disk },
            { ...info, filename: target.disk },
          ]
        : [info],
    );
  });
  const life = await makeDesktopLifecycle(f.options);
  await expect(life.manage(owner, { desktopId: id, operation: "resume" })).rejects.toThrow();
  expect(await life.manage(owner, { desktopId: id, operation: "stop" })).toMatchObject({
    state: "failed",
  });
  const replacement = { ...owner, controllerId: "replacement" };
  await expect(
    life.manage(replacement, { desktopId: unrelated, operation: "delete" }),
  ).rejects.toThrow("different owner");
  await expect(
    life.manage(
      { ...replacement, threadId: ThreadId.make("other") },
      { desktopId: id, operation: "delete" },
    ),
  ).rejects.toThrow("different owner");
  expect(await life.manage(replacement, { desktopId: id, operation: "delete" })).toMatchObject({
    owner: replacement,
    state: "recoverable",
  });
  await expect(
    life.manage(owner, { desktopId: id, operation: "delete-permanently" }),
  ).rejects.toThrow("different owner");
  await expect(
    life.manage(owner, { desktopId: unrelated, operation: "delete-permanently" }),
  ).rejects.toThrow("backing file");
  expect(await NodeFSP.readFile(target.disk)).toEqual(qcow2Image("disk"));
  backed = false;
  await life.manage(owner, { desktopId: unrelated, operation: "delete-permanently" });
  expect((await new Inventory(f.directory).read()).desktops.map((item) => item.id)).toEqual([
    id,
    second,
    deleting,
  ]);
  expect(await life.manage(owner, { desktopId: id, operation: "restore" })).toMatchObject({
    state: "failed",
  });
});

it("cleans host routes and filters even when guest thaw is unavailable, and admits access only after thaw succeeds", async () => {
  const id = "agent-" + NodeCrypto.randomUUID().replaceAll("-", "");
  await using f = await fixture([{ ...row, id, routes: [route] }]);
  await using _runtime = {
    [Symbol.asyncDispose]: () =>
      NodeFSP.rm(machinePaths(f.directory, id).runtimeDirectory, { recursive: true, force: true }),
  };
  using _live = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(true);
  const order: string[] = [];
  vi.mocked(f.options.network.reconcileRoutes).mockImplementation(async (_, desired) => {
    order.push("routes");
    return desired;
  });
  vi.mocked(f.options.network.reconcile).mockImplementation(async () => {
    order.push("filters");
  });
  let unavailable = true;
  vi.mocked(f.options.guest.qga).mockImplementation(async (_, command) => {
    order.push(command);
    if (command === "guest-fsfreeze-status") return "frozen";
    if (unavailable) throw new Error("guest thaw failed");
    return {};
  });
  const life = await makeDesktopLifecycle(f.options);
  vi.mocked(f.options.network.reconcileRoutes).mockImplementationOnce(async () => {
    order.push("routes");
    throw new Error("pesto socket unavailable");
  });
  await expect(life.begin(owner, id, "owned")).rejects.toThrow("pesto socket unavailable");
  expect(order).toEqual(["routes", "filters"]);
  order.length = 0;
  await expect(life.begin(owner, id, "owned")).rejects.toThrow("guest thaw failed");
  expect(order).toEqual(["routes", "filters", "guest-fsfreeze-status", "guest-fsfreeze-thaw"]);
  unavailable = false;
  order.length = 0;
  const job = await life.begin(owner, id, "owned");
  expect(order).toEqual(["routes", "filters", "guest-fsfreeze-status", "guest-fsfreeze-thaw"]);
  await job.release();
});

it.each(["stop", "reset", "delete"] as const)(
  "recovers a host-verified VM with an unresponsive guest after restart using %s",
  async (operation) => {
    await using f = await fixture([row]);
    using _images = await writeDiskPair(f.directory, id);
    vi.mocked(f.options.guest.qga).mockRejectedValue(new Error("guest agent unresponsive"));
    vi.mocked(f.options.images.current).mockResolvedValue({ ...selected, path: f.file });
    let live = true;
    using identity = vi
      .spyOn(QemuMachine.prototype, "running")
      .mockImplementation(async (vm) => vm.id === id && live);
    vi.mocked(f.options.guest.qmp).mockImplementation(async (_vm, command) => {
      if (command === "system_powerdown") live = false;
      return {};
    });
    using _graphics = vi
      .spyOn(QemuMachine.prototype, "graphics")
      .mockResolvedValue("virtio-gpu-2d");
    using _admission = vi
      .spyOn(Admission.prototype, "vm")
      .mockResolvedValue({ resources: row.resources, release: () => {} });
    using _create = vi.spyOn(DiskImages.prototype, "create").mockImplementation(async (vm) => {
      await NodeFSP.mkdir(vm.directory, { recursive: true });
      await Promise.all([vm.disk, vm.nvram].map((file) => NodeFSP.writeFile(file, qcow2Image())));
      return row.resources.diskVirtualBytes;
    });
    using _start = vi.spyOn(QemuMachine.prototype, "start").mockResolvedValue([]);
    const life = await makeDesktopLifecycle(f.options);
    await expect(
      life.manage({ ...owner, threadId: ThreadId.make("foreign") }, { desktopId: id, operation }),
    ).rejects.toThrow();
    expect(identity).not.toHaveBeenCalled();
    identity.mockRejectedValueOnce(new Error("unit belongs to another VM"));
    await expect(life.manage(owner, { desktopId: id, operation })).rejects.toThrow(
      "unit belongs to another VM",
    );
    expect(live).toBe(true);
    const result = await life.manage(owner, { desktopId: id, operation });
    expect(live).toBe(false);
    expect(result.state).toBe(
      operation === "reset" ? "ready" : operation === "stop" ? "stopped" : "recoverable",
    );
    expect(f.options.guest.qga).not.toHaveBeenCalled();
  },
);

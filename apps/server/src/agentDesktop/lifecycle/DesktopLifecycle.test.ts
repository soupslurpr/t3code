import { EnvironmentId } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off -- Exercises durable inventory and interrupted disk recovery in a private directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { it as effectTest } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeGuestDisplay } from "../GuestDisplay.ts";
import { makeGuestTools } from "../GuestTools.ts";
import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { makeDesktopLifecycle } from "./DesktopLifecycle.ts";
import { QemuMachine } from "./QemuMachine.ts";
import * as Host from "../AgentDesktopHost.ts";
import * as HostAdmission from "./Admission.ts";
import { Admission } from "./Admission.ts";
import { nowIso } from "./Inventory.ts";
import { retirementCandidates } from "./Retention.ts";
import { DiskImages } from "./DiskImages.ts";

import {
  fixture,
  id,
  owner,
  row,
  createdAt,
  writeDiskPair,
  qcow2Image,
} from "./LifecycleFixture.test-support.ts";

it("reattaches a v1 machine, keeps thread views separate from ownership and holds admitted operations until release", async () => {
  await using f = await fixture([row]);
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(true);
  using _attach = vi.spyOn(QemuMachine.prototype, "reattach").mockResolvedValue([]);
  const lifecycle = await makeDesktopLifecycle(f.options);
  expect(await lifecycle.list(owner)).toMatchObject([
    { id, state: "ready", automaticParking: false, baseGeneration: row.baseGeneration },
  ]);
  const peer = { ...owner, controllerId: "second" };
  const other = { ...peer, threadId: ThreadId.make("other") };
  await lifecycle.lease(peer, id, "view");
  const operation = await lifecycle.begin(peer, id, "view");
  await expect(lifecycle.begin(peer, id, "control")).rejects.toThrow();
  await expect(lifecycle.begin(peer, id, "owned")).rejects.toThrow();
  await lifecycle.lease(peer, id, "release");
  await expect(
    lifecycle.manage(owner, { operation: "handoff", desktopId: id, owner: other }),
  ).rejects.toThrow();
  await expect(lifecycle.acquire(peer, { desktopId: id })).rejects.toThrow();
  await expect(lifecycle.manage(owner, { operation: "park", desktopId: id })).rejects.toThrow();
  await operation.release();
  await operation.release();
  await expect(lifecycle.acquire(other, { desktopId: id })).rejects.toThrow();
  expect(await lifecycle.acquire(peer, { desktopId: id })).toMatchObject({
    owner: peer,
    automaticParking: false,
  });
  await lifecycle.manage(peer, { operation: "handoff", desktopId: id, owner: other });
  await expect(lifecycle.begin(peer, id, "owned")).rejects.toThrow();
  expect(
    await lifecycle.acquire(other, { desktopId: id, requirements: { preventParking: false } }),
  ).toMatchObject({ owner: other, automaticParking: true });
  expect(JSON.parse(await NodeFSP.readFile(f.file, "utf8"))).toMatchObject({
    version: 1,
    desktops: [{ owner: other, requirements: { retention: "preserve", updatePolicy: "manual" } }],
  });
});

effectTest.live(
  "lets a human view an explicitly selected desktop while the agent controls it",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireDisposable(Effect.promise(() => fixture([row])));
      using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(true);
      using _attach = vi.spyOn(QemuMachine.prototype, "reattach").mockResolvedValue([]);
      const lifecycle = yield* Effect.promise(() => makeDesktopLifecycle(f.options));
      expect(
        yield* Effect.promise(() => lifecycle.listEnvironment(owner.environmentId)),
      ).toMatchObject([{ id, owner }]);
      const otherEnvironment = EnvironmentId.make("other");
      expect(yield* Effect.promise(() => lifecycle.listEnvironment(otherEnvironment))).toEqual([]);
      yield* Effect.promise(() =>
        expect(lifecycle.resolveOwner(otherEnvironment, id)).rejects.toThrow(),
      );
      yield* Effect.promise(() => lifecycle.lease(owner, id, "control"));
      const display = yield* makeGuestDisplay(
        lifecycle,
        f.options.guest,
        makeGuestTools(f.options.guest, f.options.resource),
      );
      const caller = { ...owner, controllerKind: "human" as const, controllerId: "human-viewer" };
      const request = { desktop: { kind: "agent" as const, desktopId: id }, observation: false };
      const observation = yield* display.invoke(caller, "computerRequestView", request, 30_000);
      expect(observation).toMatchObject({ status: { lease: { access: "view" } } });
      expect(yield* Effect.promise(() => lifecycle.list(owner))).toMatchObject([
        { owner, controllerId: owner.controllerId, viewerCount: 2 },
      ]);
      yield* display.invoke(caller, "computerRequestControl", request, 30_000);
      expect(yield* Effect.promise(() => lifecycle.list(owner))).toMatchObject([
        { owner, controllerId: caller.controllerId, viewerCount: 2 },
      ]);
      expect(
        yield* Effect.exit(
          display.invoke(
            { ...caller, controllerId: "second-human" },
            "computerRequestControl",
            request,
            30_000,
          ),
        ),
      ).toMatchObject({ _tag: "Failure" });
      const handback = { ...request, returnControlToAgent: true };
      const returned = yield* display.invoke(caller, "computerRequestControl", handback, 30_000);
      expect(returned).toMatchObject({
        status: { lease: { access: "view", controller: { kind: "agent" } } },
      });
      expect(yield* Effect.promise(() => lifecycle.list(owner))).toMatchObject([
        { owner, controllerId: owner.controllerId },
      ]);
    }),
);

it("keeps a legacy rollback marker after a second-disk failure and restores both disks before granting access after restart", async () => {
  await using f = await fixture([
    {
      ...row,
      state: "ready",
      maintenance: { status: "installing", rollbackReady: true, previousState: "stopped" },
    },
  ]);
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(false);
  using _stop = vi.spyOn(QemuMachine.prototype, "stop").mockResolvedValue();
  using _discard = vi.spyOn(DiskImages.prototype, "discardRollback").mockResolvedValue();
  const applied: string[] = [];
  let failFirmware = true;
  using _apply = vi
    .spyOn(DiskImages.prototype, "applyRollbackDisk")
    .mockImplementation(async (file) => {
      applied.push(NodePath.basename(file));
      if (file.endsWith("nvram.qcow2") && failFirmware)
        throw new Error("firmware disk temporarily unavailable");
    });
  const interrupted = await makeDesktopLifecycle(f.options);
  await expect(interrupted.begin(owner, id, "owned")).rejects.toThrow();
  expect(applied).toEqual(["disk.qcow2", "nvram.qcow2"]);
  expect(_discard).not.toHaveBeenCalled();
  expect(
    JSON.parse(await NodeFSP.readFile(f.file, "utf8")).desktops[0].maintenance.rollbackReady,
  ).toBe(true);
  failFirmware = false;
  const restarted = await makeDesktopLifecycle(f.options);
  expect(await restarted.list(owner)).toMatchObject([
    { state: "stopped", maintenance: { status: "failed" } },
  ]);
  expect(applied).toEqual(["disk.qcow2", "nvram.qcow2", "disk.qcow2", "nvram.qcow2"]);
  expect(
    JSON.parse(await NodeFSP.readFile(f.file, "utf8")).desktops[0].maintenance.rollbackReady,
  ).not.toBe(true);
  expect(_discard).toHaveBeenCalledOnce();
});

it("does no provisioning in an empty environment and refuses to prune after an unreadable inventory", async () => {
  await using f = await fixture([]);
  await NodeFSP.unlink(f.file);
  const empty = await makeDesktopLifecycle(f.options);
  expect(await empty.list(owner)).toEqual([]);
  await empty.maintain();
  expect(f.options.images.ensure).not.toHaveBeenCalled();
  expect(f.options.images.refresh).not.toHaveBeenCalled();
  await NodeFSP.writeFile(f.file, '{"version":1,"desktops":[{}]}');
  const broken = await makeDesktopLifecycle(f.options);
  await expect(broken.maintain()).rejects.toThrow();
  expect(f.options.images.prune).not.toHaveBeenCalled();
  expect(await NodeFSP.readFile(f.file, "utf8")).toBe('{"version":1,"desktops":[{}]}');
});

it("blocks access throughout an explicit upgrade of a manual, saved-memory desktop and preserves its original park point on failure", async () => {
  await using f = await fixture([{ ...row, state: "parked" }]);
  vi.mocked(f.options.resource).mockResolvedValue(f.file);
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockResolvedValue(false);
  using _start = vi.spyOn(QemuMachine.prototype, "start").mockResolvedValue([]);
  using _stop = vi.spyOn(QemuMachine.prototype, "stop").mockResolvedValue();
  using _create = vi.spyOn(DiskImages.prototype, "createRollback").mockResolvedValue();
  using _discard = vi.spyOn(DiskImages.prototype, "discardRollback").mockResolvedValue();
  using _apply = vi.spyOn(DiskImages.prototype, "applyRollbackDisk").mockResolvedValue();
  using _reservation = vi
    .spyOn(Admission.prototype, "vm")
    .mockResolvedValue({ resources: row.resources, release: vi.fn() });
  const installing = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  vi.mocked(f.options.guest.exec).mockImplementation(async () => {
    installing.resolve();
    await finish.promise;
    return { stdout: "", stderr: "", exitCode: 1 };
  });
  const lifecycle = await makeDesktopLifecycle(f.options);
  const first = vi.fn();
  const update = lifecycle.update(owner, id, first);
  await installing.promise;
  try {
    expect(
      JSON.parse(await NodeFSP.readFile(f.file, "utf8")).desktops[0].maintenance,
    ).toMatchObject({
      status: "installing",
      previousState: "parked",
      rollbackReady: true,
    });
    expect(await lifecycle.list(owner)).toMatchObject([{ maintenance: { status: "installing" } }]);
    await expect(lifecycle.begin(owner, id, "owned")).rejects.toThrow();
    await expect(
      lifecycle.manage(owner, { desktopId: id, operation: "delete-permanently" }),
    ).rejects.toThrow();
    expect(_start.mock.calls[0]?.[2]).toBe(false);
    expect(first.mock.calls).toEqual([[true]]);
    const duplicate = vi.fn();
    await lifecycle.update(owner, id, duplicate);
    expect(duplicate.mock.calls).toEqual([[false]]);
    const outsider = vi.fn();
    await expect(
      lifecycle.update({ ...owner, controllerId: "outsider" }, id, outsider),
    ).rejects.toThrow();
    expect(outsider).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
  }
  await expect(update).rejects.toThrow("exited with status 1");
  expect(_apply.mock.calls.map(([file]) => NodePath.basename(file))).toEqual([
    "disk.qcow2",
    "nvram.qcow2",
  ]);
  expect(await lifecycle.list(owner)).toMatchObject([
    { state: "parked", updatePolicy: "manual", maintenance: { status: "failed" } },
  ]);
  const stored = JSON.parse(await NodeFSP.readFile(f.file, "utf8")).desktops[0];
  expect(stored.savedMemory).toBe(true);
  expect(stored.maintenance.rollbackReady).toBe(false);
});

it("revalidates a queued operation after another controller atomically reclaims the desktop", async () => {
  await using f = await fixture([row]);
  const probing = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  using _attach = vi.spyOn(QemuMachine.prototype, "reattach").mockResolvedValue([]);
  using _running = vi.spyOn(QemuMachine.prototype, "running").mockImplementation(async () => {
    probing.resolve();
    await proceed.promise;
    return true;
  });
  const lifecycle = await makeDesktopLifecycle(f.options);
  const peer = { ...owner, controllerId: "replacement" };
  const acquire = lifecycle.acquire(peer, { desktopId: id });
  await probing.promise;
  const stale = lifecycle.begin(owner, id, "owned");
  proceed.resolve();
  expect(await acquire).toMatchObject({ owner: peer });
  await expect(stale).rejects.toThrow("different owner");
});

it("retires only eligible cold desktops and honors the seven-day recoverable window", async () => {
  const staleId = "agent-" + "2".repeat(32);
  const idleId = "agent-" + "3".repeat(32);
  const pinnedId = "agent-" + "4".repeat(32);
  const heldId = "agent-" + "5".repeat(32);
  const policy = { retention: "automatic", updatePolicy: "manual" };
  await using f = await fixture([
    { ...row, state: "stopped" },
    { ...row, id: staleId, state: "stopped", requirements: policy },
    {
      ...row,
      id: idleId,
      lastActiveAt: "2026-01-31T23:49:00Z",
      state: "ready",
      requirements: policy,
    },
    { ...row, id: pinnedId, state: "ready", requirements: { ...policy, preventParking: true } },
    { ...row, id: heldId, state: "ready", requirements: policy },
  ]);
  using _images = await writeDiskPair(f.directory, staleId);
  const at = Date.parse("2026-02-01T00:00:00Z");
  using clock = vi.spyOn(Date, "now").mockReturnValue(at);
  using _supported = vi.spyOn(HostAdmission, "supportedHost").mockReturnValue(true);
  using _space = vi.spyOn(HostAdmission, "hostCapacity").mockResolvedValue({
    cpu: 10,
    totalMemory: 16 * 2 ** 30,
    freeMemory: 12 * 2 ** 30,
    totalDisk: 128 * 2 ** 30,
    freeDisk: 100 * 2 ** 30,
  });
  using _workspace = vi.spyOn(Admission.prototype, "workspace").mockResolvedValue(() => {});
  const live = new Set([idleId, pinnedId, heldId]);
  using _running = vi
    .spyOn(QemuMachine.prototype, "running")
    .mockImplementation(async (vm) => live.has(vm.id));
  using _attach = vi.spyOn(QemuMachine.prototype, "reattach").mockResolvedValue([]);
  using _consume = vi.spyOn(QemuMachine.prototype, "consumePark").mockResolvedValue();
  using _park = vi.spyOn(QemuMachine.prototype, "park").mockImplementation(async (vm) => {
    live.delete(vm.id);
  });
  using _stop = vi.spyOn(QemuMachine.prototype, "stop").mockResolvedValue();
  using _force = vi.spyOn(QemuMachine.prototype, "forceStop").mockResolvedValue();
  using _references = vi.spyOn(DiskImages.prototype, "references").mockResolvedValue(new Set());
  vi.mocked(f.options.images.current).mockResolvedValue({
    path: "/unused",
    generation: null,
    managed: false,
    profileVersion: null,
    builtAt: null,
  });
  const lifecycle = await makeDesktopLifecycle(f.options);
  const held = await lifecycle.begin(owner, heldId, "owned");
  await lifecycle.maintain();
  const result = await lifecycle.list(owner);
  expect(result.find((r) => r.id === id)?.state).toBe("stopped");
  expect(result.find((r) => r.id === staleId)).toMatchObject({
    state: "recoverable",
    recoverableUntil: "2026-02-08T00:00:00.000Z",
  });
  expect(result.find((r) => r.id === idleId)?.state).toBe("parked");
  expect(result.find((r) => r.id === pinnedId)?.state).toBe("ready");
  expect(result.find((r) => r.id === heldId)?.state).toBe("ready");
  expect((await lifecycle.manage(owner, { operation: "restore", desktopId: staleId })).state).toBe(
    "stopped",
  );
  await lifecycle.manage(owner, { operation: "delete", desktopId: staleId });
  clock.mockReturnValue(Date.parse("2026-02-08T00:00:00Z"));
  await expect(
    lifecycle.manage(owner, { operation: "restore", desktopId: staleId }),
  ).rejects.toThrow("recovery window");
  await lifecycle.maintain();
  expect((await lifecycle.list(owner)).map((r) => r.id)).not.toContain(staleId);
  await held.release();
});

it("admits one base refresh after host and storage checks and records completion against the new generation", async () => {
  await using f = await fixture([]);
  const newImagePath = NodePath.join(f.directory, "refreshed.qcow2");
  const selected = {
    path: f.file,
    generation: "old",
    managed: true,
    profileVersion: "arch-gnome-v1",
    builtAt: createdAt,
  };
  vi.mocked(f.options.images.current).mockResolvedValue(selected);
  const building = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  vi.mocked(f.options.images.refresh).mockImplementation(async () => {
    building.resolve();
    await finish.promise;
    await NodeFSP.writeFile(newImagePath, qcow2Image());
    const next = { ...selected, path: newImagePath, generation: "new" };
    vi.mocked(f.options.images.current).mockResolvedValue(next);
    return next;
  });
  using _supported = vi.spyOn(HostAdmission, "supportedHost").mockReturnValue(true);
  using requirements = vi.spyOn(Host, "hostRequirements").mockResolvedValue([]);
  using capacity = vi
    .spyOn(Admission.prototype, "workspace")
    .mockRejectedValueOnce(new Error("insufficient capacity"))
    .mockResolvedValue(() => {});
  using validate = vi.spyOn(DiskImages.prototype, "baseSize").mockResolvedValue(2 ** 36);
  const lifecycle = await makeDesktopLifecycle(f.options);
  const reply = vi.fn();
  await expect(lifecycle.update(owner, null, reply)).rejects.toThrow("insufficient capacity");
  expect(reply).not.toHaveBeenCalled();
  const accepted = lifecycle.update(owner, null, reply);
  await building.promise;
  const setup = lifecycle.ensureBase();
  try {
    expect(JSON.parse(await NodeFSP.readFile(f.file, "utf8")).baseMaintenance).toMatchObject({
      status: "preparing",
      baseGeneration: "old",
    });
    expect(await lifecycle.baseMaintenance(selected)).toMatchObject({
      status: "preparing",
      appliedProfileVersion: "arch-gnome-v1",
    });
    expect(reply.mock.calls).toEqual([[true]]);
    await lifecycle.update(owner, null, reply);
    expect(reply.mock.calls).toEqual([[true], [false]]);
    expect(requirements).toHaveBeenCalledTimes(2);
    expect(capacity).toHaveBeenCalledTimes(2);
  } finally {
    finish.resolve();
  }
  await accepted;
  await setup;
  expect(validate.mock.calls).toEqual([[newImagePath]]);
  expect(JSON.parse(await NodeFSP.readFile(f.file, "utf8")).baseMaintenance).toMatchObject({
    status: "current",
    baseGeneration: "new",
  });
  vi.mocked(f.options.images.current).mockResolvedValue({ ...selected, generation: "new" });
  vi.mocked(f.options.images.refresh).mockRejectedValue(
    new Error("builder failed " + "x".repeat(1000) + " no space left on device"),
  );
  await expect(lifecycle.update(owner, null)).rejects.toThrow("builder failed");
  const failure = await lifecycle.baseMaintenance({ ...selected, generation: "new" });
  expect(failure.detail).toContain("builder failed");
  expect(failure.detail).toContain("no space left on device");
  expect(JSON.parse(await NodeFSP.readFile(f.file, "utf8")).baseMaintenance.detail).toBe(
    failure.detail,
  );
  expect(failure.detail!.length).toBeLessThanOrEqual(512);
  expect(failure).toMatchObject({
    status: "failed",
    appliedProfileVersion: "arch-gnome-v1",
  });
});

it("counts pending trash toward the storage reserve and selects only enough eligible cold disks", () => {
  const days = 86_400_000;
  const gib = 2 ** 30;
  const time = Date.parse("2026-02-07T12:00:00Z");
  const cold = {
    ...row,
    state: "stopped" as const,
    requirements: { retention: "automatic" as const },
  };
  const disk = (id: string, idle: number) => ({
    ...cold,
    id,
    lastActiveAt: nowIso(time - days * idle),
  });
  const rows = [
    { ...disk("trash", 14), state: "recoverable" as const },
    { ...disk("pinned", 40), requirements: { retention: "preserve" as const } },
    { ...disk("live", 40), state: "ready" as const },
    disk("expired", 31),
    disk("old", 6),
    disk("next", 5),
    disk("recent", 0.5),
  ];
  const sizes = new Map(rows.map((r) => [r.id, gib]));
  expect(
    retirementCandidates(rows, time, { totalDisk: 100 * gib, freeDisk: 2 * gib }, sizes),
  ).toEqual(new Set(["expired", "old"]));
  expect(
    retirementCandidates(rows, time, { totalDisk: 100 * gib, freeDisk: 10 * gib }, sizes),
  ).toEqual(new Set(["expired"]));
});

it("coalesces provisioning, releases a failed build reservation, and validates existing and custom images without reserving capacity", async () => {
  await using f = await fixture([]);
  const selected = {
    path: NodePath.join(f.directory, "initial.qcow2"),
    generation: null,
    managed: true,
    profileVersion: null,
    builtAt: null,
  };
  vi.mocked(f.options.images.current).mockResolvedValue(selected);
  using _supported = vi.spyOn(HostAdmission, "supportedHost").mockReturnValue(true);
  const release = vi.fn();
  using reserve = vi.spyOn(Admission.prototype, "workspace").mockResolvedValue(release);
  using validate = vi.spyOn(DiskImages.prototype, "baseSize").mockResolvedValue(2 ** 36);
  vi.mocked(f.options.images.ensure).mockRejectedValueOnce(new Error("interrupted build"));
  const lifecycle = await makeDesktopLifecycle(f.options);
  await expect(lifecycle.ensureBase()).rejects.toThrow("interrupted build");
  expect(release).toHaveBeenCalledOnce();
  const building = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  vi.mocked(f.options.images.ensure).mockImplementation(async () => {
    building.resolve();
    await finish.promise;
    await NodeFSP.writeFile(selected.path, qcow2Image());
    return selected;
  });
  const setup = [lifecycle.ensureBase(), lifecycle.ensureBase()];
  await building.promise;
  expect(release).toHaveBeenCalledOnce();
  finish.resolve();
  await Promise.all(setup);
  expect(release).toHaveBeenCalledTimes(2);
  expect(reserve.mock.calls[1]?.slice(1, 3)).toEqual([8 * 2 ** 30, 4 * 2 ** 30]);
  await lifecycle.ensureBase();
  const custom = NodePath.join(f.directory, "missing-custom.qcow2");
  vi.mocked(f.options.images.current).mockResolvedValue({
    ...selected,
    path: custom,
    managed: false,
  });
  validate.mockRejectedValueOnce(new Error("invalid custom base"));
  await expect(lifecycle.ensureBase()).rejects.toThrow("invalid custom base");
  expect(validate.mock.calls.map(([file]) => file)).toEqual([selected.path, selected.path, custom]);
  expect(reserve).toHaveBeenCalledTimes(2);
  expect(f.options.images.ensure).toHaveBeenCalledTimes(2);
});

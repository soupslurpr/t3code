// @effect-diagnostics nodeBuiltinImport:off -- The environment owns the VM inventory, QEMU disk directory and private host sockets.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";

import type {
  AgentDesktopAcquireInput,
  AgentDesktopManageInput,
  AgentDesktopCreatePortRouteInput,
} from "@t3tools/contracts";
import { hostFailure } from "../../computer/ComputerHostConnection.ts";
import { machinePaths } from "../MachinePaths.ts";
import type { DesktopLifecycle, DesktopOwner, LifecycleOptions } from "../MachinePorts.ts";
import { Admission, supportedHost } from "./Admission.ts";
import { DiskImages } from "./DiskImages.ts";
import {
  DAY,
  backend,
  Inventory,
  Serial,
  Session,
  isMissing,
  nowIso,
  nowMillis,
  pendingUpdate,
  privateDirectory,
  retryDue,
  runningState,
  savedMemory,
  summary,
  type Machine,
} from "./Inventory.ts";
import { BaseMaintenance } from "./BaseMaintenance.ts";
import { DesktopUpdates } from "./Maintenance.ts";
import { QemuMachine } from "./QemuMachine.ts";
import { MachineRuntime, type RuntimeProbe } from "./MachineRuntime.ts";
import { Provisioning } from "./Provisioning.ts";
import { acquisitionCandidates, sameOwner, sameThread, suitable, trashed } from "./Ownership.ts";
import { selectRetirements } from "./Retention.ts";

const busy = () =>
  hostFailure(
    "desktop-busy",
    "conflict",
    "Release active Agent desktop operations and leases before changing this desktop.",
  );
const wrongOwner = () =>
  hostFailure(
    "desktop-target-mismatch",
    "authorization",
    "The Agent desktop belongs to a different owner.",
  );
const invalid = (message: string) => hostFailure("invalid-action", "invalid-input", message);
const newId = () => "agent-" + NodeCrypto.randomUUID().replaceAll("-", "");
export async function makeDesktopLifecycle(options: LifecycleOptions): Promise<DesktopLifecycle> {
  const inventory = new Inventory(options.directory);
  const disks = new DiskImages(options.directory);
  const qemu = new QemuMachine(options.guest, options.network, disks);
  const admission = new Admission(inventory, qemu);
  const runtime = new MachineRuntime(inventory, qemu, admission);
  const provisioning = new Provisioning(inventory);
  const updates = new DesktopUpdates(options, inventory, qemu, admission);
  const selection = new Serial();
  const graph = new Serial();
  const sessions = new Map<string, Session>();
  let nextStorageCheck = 0;
  let maintaining: Promise<void> | undefined;
  const bases = new BaseMaintenance(options, inventory, admission, graph, disks);
  const paths = (id: string) => machinePaths(options.directory, id);
  function session(id: string) {
    let s = sessions.get(id);
    if (!s) {
      s = new Session();
      sessions.set(id, s);
    }
    return s;
  }

  async function prepare(row: Machine, s: Session, probe: RuntimeProbe = "cached") {
    if (s.updating) throw busy();
    if (row.publishingDisks) row = await graph.run(() => provisioning.recover(row.id));
    if (pendingUpdate(row.maintenance)) {
      s.attached = false;
      row = await updates.recover(row);
    }
    return runtime.prepare(row, s, probe);
  }

  async function onMachine<T>(
    id: string,
    owner: DesktopOwner,
    threadAccess: boolean,
    fn: (row: Machine, s: Session) => Promise<T>,
    probe: RuntimeProbe = "cached",
  ) {
    const existing = await inventory.get(id);
    const s = session(existing.id);
    return s.lock.run(async () => {
      const row = await inventory.get(id);
      if (!(threadAccess ? sameThread : sameOwner)(row.owner, owner)) throw wrongOwner();
      return fn(await prepare(row, s, probe), s);
    });
  }
  async function create(owner: DesktopOwner, input: AgentDesktopAcquireInput) {
    const gpu = await qemu.graphics(input.requirements?.graphics);
    await privateDirectory(options.directory);
    const id = newId();
    return session(id).lock.run(async () => {
      const reserve = await admission.vm(id, input.requirements ?? {}, gpu === "virgl");
      try {
        const row = await graph.run(async () => {
          const image = await options.images.current();
          try {
            await NodeFSP.access(image.path);
          } catch (cause) {
            if (!isMissing(cause)) throw cause;
            throw hostFailure(
              "agent-desktop-unavailable",
              "resource",
              "Set up the Agent desktop base image before creating a machine.",
            );
          }
          const at = nowIso();
          const row: Machine = {
            id,
            owner,
            label: input.label ?? `Agent desktop ${(await inventory.read()).desktops.length + 1}`,
            state: "creating",
            resources: reserve.resources,
            graphicsBackend: gpu,
            requirements: input.requirements,
            baseGeneration: image.generation ?? undefined,
            routes: [],
            createdAt: at,
            lastActiveAt: at,
            recoverableUntil: null,
            maintenance: {
              appliedProfileVersion: image.profileVersion ?? undefined,
              lastUpdatedAt: image.builtAt ?? undefined,
            },
          };
          return provisioning.build(row, (target) =>
            disks.create(target, image, row.resources.diskVirtualBytes),
          );
        });
        return await runtime.launch(row, session(id));
      } finally {
        reserve.release();
      }
    });
  }

  const acquire: DesktopLifecycle["acquire"] = (owner, input) =>
    selection.run(async () => {
      const candidates = await acquisitionCandidates(inventory, owner, input);
      for (const candidate of candidates) {
        const claimed = await session(candidate.id).lock.run(async () => {
          const s = session(candidate.id);
          const current = await inventory.get(candidate.id);
          if (!sameThread(current.owner, owner)) {
            if (input.desktopId) throw wrongOwner();
            return;
          }
          if (s.updating || (!sameOwner(current.owner, owner) && s.busy)) {
            if (input.desktopId) throw busy();
            return;
          }
          if (trashed(current) || !suitable(current, input)) {
            if (input.desktopId)
              throw invalid("This desktop cannot satisfy the requested acquisition.");
            return;
          }
          const row = await prepare(current, s, "probe");
          const requirements = { ...row.requirements, ...input.requirements };
          const extraDisk =
            (requirements.expectedTemporaryDiskBytes ?? 0) -
            (row.requirements?.expectedTemporaryDiskBytes ?? 0);
          const release =
            runningState(row.state) && extraDisk > 0
              ? await admission.workspace("resize-" + row.id, extraDisk)
              : undefined;
          try {
            const ready = await runtime.start({ ...row, requirements }, s);
            return summary(await inventory.put({ ...ready, owner, lastActiveAt: nowIso() }), s);
          } finally {
            release?.();
          }
        });
        if (claimed) return claimed;
      }
      const row = await create(owner, input);
      return summary(row, session(row.id));
    });

  async function retire(row: Machine) {
    if (row.state === "recoverable") return row;
    if (row.state === "deleting") throw invalid("This desktop is being permanently deleted.");
    await qemu.stop(paths(row.id));
    return inventory.put({
      ...row,
      state: "recoverable",
      beforeTrash: row.state === "failed" ? "failed" : undefined,
      savedMemory: savedMemory(row),
      recoverableUntil: nowIso(nowMillis() + 7 * DAY),
    });
  }
  async function remove(row: Machine) {
    return graph.run(async () => {
      const vm = paths(row.id);
      await provisioning.sweep();
      await disks.references((await inventory.read()).desktops, vm, await options.images.current());
      await qemu.forceStop(vm);
      const removing = await inventory.put({ ...row, state: "deleting" });
      await NodeFSP.rm(vm.directory, { force: true, recursive: true });
      await NodeFSP.rm(vm.runtimeDirectory, { force: true, recursive: true });
      await inventory.remove(row.id);
      sessions.delete(row.id);
      return removing;
    });
  }
  async function clone(row: Machine, label?: string) {
    const id = newId();
    return session(id).lock.run(() =>
      graph.run(async () => {
        const source = paths(row.id);
        const bytes = await disks.copySize(source);
        const release = await admission.workspace(id, bytes);
        try {
          const at = nowIso();
          return await provisioning.build(
            {
              ...row,
              id,
              label: label ?? row.label.slice(0, 251) + " copy",
              state: "creating",
              savedMemory: false,
              routes: [],
              createdAt: at,
              lastActiveAt: at,
              detail: undefined,
              recoverableUntil: null,
            },
            async (target) => {
              await qemu.clone(source, target);
              return row.resources.diskVirtualBytes;
            },
          );
        } finally {
          release();
        }
      }),
    );
  }
  async function manage(owner: DesktopOwner, input: AgentDesktopManageInput) {
    const threadAccess = input.operation === "restore" || input.operation === "delete";
    return onMachine(
      input.desktopId,
      owner,
      threadAccess,
      async (row, s) => {
        if (
          input.operation !== "delete-permanently" &&
          input.operation !== "restore" &&
          trashed(row)
        )
          throw invalid("Restore this Agent desktop before changing it.");
        if (
          !["resume", "set-update-policy"].includes(input.operation) &&
          (s.operations || (s.viewers.size && !["snapshot", "clone"].includes(input.operation)))
        )
          throw busy();
        row = { ...row, lastActiveAt: nowIso() };
        switch (input.operation) {
          case "resume":
            row = await runtime.start(row, s);
            break;
          case "park":
            row = await runtime.park(row, s);
            break;
          case "stop":
            row = await runtime.stop(row, s);
            break;
          case "snapshot": {
            row = await runtime.start(row, s);
            const memory = backend(row) !== "virgl";
            const release = await admission.workspace(
              "snapshot-" + row.id,
              memory ? row.resources.memoryBytes : 16 * 2 ** 20,
            );
            try {
              await qemu.checkpoint(paths(row.id), memory);
            } finally {
              release();
            }
            await inventory.put(row);
            break;
          }
          case "clone":
            row = await clone(row, input.label);
            break;
          case "reset": {
            const wasRunning = runningState(row.state);
            const source = wasRunning ? await runtime.stop(row, s) : row;
            try {
              row = await create(owner, { label: source.label, requirements: source.requirements });
            } catch (cause) {
              if (wasRunning) await runtime.start(source, s);
              throw cause;
            }
            await retire(wasRunning ? source : await runtime.stop(source, s));
            break;
          }
          case "delete":
            if (!sameOwner(row.owner, owner)) {
              if (
                row.state !== "failed" &&
                (runningState(row.state) || (await disks.hasPair(paths(row.id))))
              )
                throw wrongOwner();
              row = { ...row, owner, state: "failed", savedMemory: false };
            }
            row = await retire(row);
            break;
          case "restore": {
            if (
              row.state !== "recoverable" ||
              !(Date.parse(row.recoverableUntil ?? "") > nowMillis())
            )
              throw invalid("The desktop is outside its recovery window.");
            const complete = await disks.hasPair(paths(row.id));
            const state = complete
              ? (row.beforeTrash ?? (savedMemory(row) ? "parked" : "stopped"))
              : "failed";
            row = await inventory.put({
              ...row,
              owner,
              state,
              savedMemory: state === "parked",
              beforeTrash: undefined,
              detail: complete
                ? state === "failed"
                  ? row.detail
                  : undefined
                : "The Agent desktop system or firmware disk is missing or unreadable.",
              recoverableUntil: null,
              lastActiveAt: nowIso(),
            });
            break;
          }
          case "delete-permanently":
            return summary(await remove(row), s);
          case "handoff":
            if (!input.owner || input.owner.environmentId !== owner.environmentId)
              throw wrongOwner();
            row = await inventory.put({ ...row, owner: input.owner, lastActiveAt: nowIso() });
            break;
          case "set-update-policy":
            if (!input.updatePolicy) throw invalid("Choose an Agent desktop update policy.");
            row = await inventory.put({
              ...row,
              requirements: { ...row.requirements, updatePolicy: input.updatePolicy },
            });
            break;
        }
        return summary(row, session(row.id));
      },
      ["stop", "reset", "delete", "delete-permanently"].includes(input.operation)
        ? "shutdown"
        : "cached",
    );
  }

  const lease: DesktopLifecycle["lease"] = (owner, id, access) =>
    onMachine(id, owner, access !== "control", async (row, s) => {
      if (access === "control" && s.controller && s.controller !== owner.controllerId) throw busy();
      if (access !== "release") row = await runtime.start(row, s);
      row = await inventory.put({ ...row, lastActiveAt: nowIso() });
      if (access === "release") {
        s.viewers.delete(owner.controllerId);
        if (s.controller === owner.controllerId) s.controller = null;
      } else {
        s.viewers.add(owner.controllerId);
        if (access === "control") s.controller = owner.controllerId;
      }
      return summary(row, s);
    });
  const begin: DesktopLifecycle["begin"] = (owner, id, permission) =>
    onMachine(id, owner, permission === "view", async (row, s) => {
      if (
        (permission === "control" && s.controller !== owner.controllerId) ||
        (permission === "view" && !s.viewers.has(owner.controllerId))
      ) {
        throw hostFailure(
          "desktop-lease-required",
          "authorization",
          "Acquire the requested Agent desktop lease first.",
        );
      }
      row = await runtime.start(row, s);
      s.operations++;
      s.touched = nowMillis();
      let released = false;
      return {
        desktop: summary(row, s),
        paths: paths(id),
        release: () =>
          s.lock.run(async () => {
            if (released) return;
            released = true;
            s.operations--;
            s.touched = nowMillis();
            if (!s.operations) {
              const latest = await inventory.get(id);
              if (s.touched - Date.parse(latest.lastActiveAt) >= 60_000)
                await inventory.put({ ...latest, lastActiveAt: nowIso() });
            }
          }),
      };
    });
  async function route(
    owner: DesktopOwner,
    id: string,
    input: AgentDesktopCreatePortRouteInput | string,
  ) {
    return onMachine(
      id,
      owner,
      false,
      async (row, s) => {
        const vm = paths(id);
        const removing = typeof input === "string";
        const existing = removing ? row.routes.find((r) => r.id === input) : undefined;
        if (removing && !existing)
          throw invalid("The selected route does not belong to this desktop.");
        if (!removing) {
          if (row.routes.length >= 64) throw invalid("This desktop already has 64 port routes.");
          row = await runtime.start(row, s);
        }
        const live = runningState(row.state);
        try {
          const changed = removing ? existing! : await options.network.route(vm, input);
          if (live && removing) await options.network.apply(vm, changed, "remove");
          const routes = removing
            ? row.routes.filter((r) => r.id !== input)
            : [...row.routes, { ...changed, state: undefined, detail: undefined }];
          await inventory.put({ ...row, routes, lastActiveAt: nowIso() });
          const observed = s.routes ?? row.routes;
          if (live)
            s.routes = removing ? observed.filter((r) => r.id !== input) : [...observed, changed];
          s.touched = nowMillis();
          return live ? s.routes! : routes;
        } catch (cause) {
          if (live) {
            s.attached = false;
            try {
              s.routes = await options.network.reconcileRoutes(
                vm,
                (await inventory.get(id)).routes,
              );
              s.attached = true;
            } catch (cleanup) {
              throw new AggregateError(
                [cause, cleanup],
                "Could not reconcile the Agent desktop port change.",
                { cause: cleanup },
              );
            }
          }
          throw cause;
        }
      },
      "probe",
    );
  }
  const inspect: DesktopLifecycle["inspect"] = (owner, id, connections) =>
    onMachine(id, owner, false, async (row, s) => ({
      ...summary(row, s),
      resources: await qemu.resources(paths(id), row, s, connections),
    }));
  async function update(
    owner: DesktopOwner,
    id: string | null,
    onAdmitted?: (accepted: boolean) => void,
    automatic = false,
  ) {
    if (id === null) return bases.refresh(onAdmitted);
    const s = session((await inventory.get(id)).id);
    const run = await s.lock.run(async () => {
      const row = await inventory.get(id);
      if (!sameOwner(row.owner, owner)) throw wrongOwner();
      if (s.updating) return;
      return updates.queue(await prepare(row, s, "probe"), s, automatic);
    });
    if (!run) {
      onAdmitted?.(false);
      return;
    }
    try {
      onAdmitted?.(true);
    } finally {
      await run();
    }
  }

  async function list(owner: DesktopOwner) {
    const rows = (await inventory.read()).desktops.filter((r) => sameThread(r.owner, owner));
    return (
      await Promise.all(
        rows.map(async (row) => {
          const s = session(row.id);
          return s.lock.run(async () => {
            const latest = (await inventory.read()).desktops.find((r) => r.id === row.id);
            if (!latest || !sameThread(latest.owner, owner)) return [];
            if (s.updating) return [summary(latest, s)];
            try {
              return [summary(await prepare(latest, s), s)];
            } catch {
              return [
                {
                  ...summary(latest, s),
                  detail:
                    "The Agent desktop runtime could not be reconciled. Access requires successful recovery.",
                },
              ];
            }
          });
        }),
      )
    ).flat();
  }

  async function maintain() {
    if (!supportedHost()) return;
    let doc = await inventory.read();
    if (!doc.desktops.length && !(await bases.configured())) {
      await graph.run(() => provisioning.sweep());
      return;
    }
    const now = nowMillis();
    const errors: unknown[] = [];
    for (const { id } of doc.desktops) {
      const s = session(id);
      try {
        await s.lock.run(async () => {
          if (s.busy) {
            const vm = paths(id);
            if (!s.updating && (await qemu.running(vm))) await options.network.reconcile(vm);
            return;
          }
          const row = await prepare(await inventory.get(id), s, "repair-captures");
          if (
            row.state === "deleting" ||
            (row.state === "recoverable" && Date.parse(row.recoverableUntil ?? "") <= now)
          ) {
            await remove(row);
            return;
          }
          if (
            runningState(row.state) &&
            !row.requirements?.preventParking &&
            now - Math.max(s.touched, Date.parse(row.lastActiveAt)) >= 10 * 60_000
          )
            await runtime.park(row, s);
        });
      } catch (e) {
        errors.push(e);
      }
    }
    if (now >= nextStorageCheck) {
      nextStorageCheck = now + 5 * 60_000;
      for (const candidate of await selectRetirements(
        inventory,
        disks,
        now,
        (id) => session(id).touched,
      )) {
        const s = session(candidate.id);
        try {
          await s.lock.run(async () => {
            if (s.busy) return;
            const row = await prepare(await inventory.get(candidate.id), s, "probe");
            if (
              (row.state === "parked" || row.state === "stopped") &&
              row.requirements?.retention !== "preserve" &&
              Math.max(Date.parse(row.lastActiveAt), s.touched) ===
                Date.parse(candidate.lastActiveAt)
            )
              await retire(row);
          });
        } catch (e) {
          errors.push(e);
        }
      }
      try {
        await graph.run(async () => {
          await provisioning.sweep();
          const image = await options.images.current();
          if (image.managed && image.generation !== null)
            await options.images.prune(await disks.references((await inventory.read()).desktops));
        });
      } catch (e) {
        errors.push(e);
      }
    }
    doc = await inventory.read();
    try {
      await bases.refreshIfDue();
    } catch (e) {
      errors.push(e);
    }
    for (const row of doc.desktops) {
      if (
        !session(row.id).busy &&
        row.requirements?.updatePolicy !== "manual" &&
        retryDue(row.maintenance) &&
        (row.state === "stopped" || (row.state === "parked" && !savedMemory(row)))
      ) {
        try {
          await update(row.owner, row.id, undefined, true);
          break;
        } catch (e) {
          errors.push(e);
        }
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "One or more Agent desktop maintenance operations could not finish.",
      );
  }
  return {
    ensureBase: () => bases.ensure(),
    baseMaintenance: (image) => bases.status(image),
    list,
    acquire,
    manage,
    lease,
    begin,
    inspect,
    route,
    update,
    maintain: () => {
      maintaining ??= maintain().finally(() => {
        maintaining = undefined;
      });
      return maintaining;
    },
  };
}

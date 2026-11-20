// @effect-diagnostics nodeBuiltinImport:off -- Managed generation manifests and legacy base images live on the host.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import type { DesktopImage, LifecycleOptions } from "../MachinePorts.ts";
import { hostRequirements } from "../AgentDesktopHost.ts";
import { hostFailure } from "../../computer/ComputerHostConnection.ts";
import {
  type Inventory,
  Serial,
  isMissing,
  maintenanceStatus,
  nowIso,
  pendingUpdate,
  privateDirectory,
  retryDue,
} from "./Inventory.ts";
import type { DiskImages } from "./DiskImages.ts";
import { type Admission, GIB, supportedHost } from "./Admission.ts";

async function exists(file: string) {
  try {
    await NodeFSP.access(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function failureDetail(cause: unknown) {
  const message = cause instanceof Error ? cause.message.replace(/\s+/gu, " ").trim() : "";
  const detail = ("The Agent desktop base image refresh failed. " + message).trimEnd();
  return detail.length > 512 ? detail.slice(0, 192) + " … " + detail.slice(-317) : detail;
}

export class BaseMaintenance {
  readonly options: LifecycleOptions;
  readonly inventory: Inventory;
  readonly admission: Admission;
  readonly graph: Serial;
  readonly disks: DiskImages;
  private provisioning: Promise<void> | undefined;
  private readonly gate = new Serial();
  private updating = false;
  constructor(
    options: LifecycleOptions,
    inventory: Inventory,
    admission: Admission,
    graph: Serial,
    disks: DiskImages,
  ) {
    this.options = options;
    this.inventory = inventory;
    this.admission = admission;
    this.graph = graph;
    this.disks = disks;
  }
  private reserveBuilder() {
    const cpus = Math.max(2, Math.min(8, NodeOS.availableParallelism()));
    return this.admission.workspace("base-builder", 8 * GIB, 4 * GIB, cpus);
  }
  ensure() {
    this.provisioning ??= this.graph
      .run(async () => {
        const selected = await this.options.images.current();
        if (!selected.managed || (await exists(selected.path))) {
          await this.disks.baseSize(selected.path);
          return;
        }
        if (!supportedHost())
          throw hostFailure(
            "agent-desktop-unavailable",
            "resource",
            "The Agent desktop host is unsupported.",
          );
        await privateDirectory(this.options.directory);
        const release = await this.reserveBuilder();
        try {
          const built = await this.options.images.ensure();
          await this.disks.baseSize(built.path);
        } finally {
          release();
        }
      })
      .finally(() => {
        this.provisioning = undefined;
      });
    return this.provisioning;
  }
  async configured() {
    const base = NodePath.join(this.options.directory, "base");
    return (
      (await exists(NodePath.join(base, "current.json"))) ||
      (await exists(NodePath.join(base, "agent-desktop.qcow2")))
    );
  }
  private async record(image: DesktopImage) {
    const saved = (await this.inventory.read()).baseMaintenance;
    const matches =
      saved &&
      (pendingUpdate(saved) ||
        saved.status === "failed" ||
        (saved.baseGeneration ?? null) === image.generation);
    return {
      appliedProfileVersion: image.profileVersion ?? undefined,
      lastUpdatedAt: image.builtAt ?? undefined,
      ...(matches ? saved : {}),
    };
  }
  async status(image: DesktopImage) {
    return maintenanceStatus(await this.record(image));
  }
  async refreshIfDue() {
    if (this.updating) return;
    const image = await this.options.images.current();
    if (!image.managed || !(await exists(image.path))) return;
    const state = await this.record(image);
    if (retryDue(state) || pendingUpdate(state)) await this.refresh(undefined, true);
  }
  async refresh(onAdmitted?: (accepted: boolean) => void, automatic = false) {
    const release = await this.gate.run(async () => {
      if (this.updating) return;
      if (!supportedHost())
        throw hostFailure(
          "agent-desktop-unavailable",
          "resource",
          "The Agent desktop host is unsupported.",
        );
      const image = await this.options.images.current();
      if (!image.managed)
        throw hostFailure(
          "unsupported-operation",
          "unsupported-operation",
          "The configured base image is caller-managed.",
        );
      const requirements = await hostRequirements(this.options.images, {
        platform: "linux",
        arch: "x64",
      });
      if (
        requirements.some((r) => r.required && (r.status === "missing" || r.status === "unusable"))
      ) {
        if (automatic) return;
        throw hostFailure(
          "agent-desktop-unavailable",
          "resource",
          "Complete Agent desktop host setup before updating the base image.",
        );
      }
      await privateDirectory(this.options.directory);
      const release = await this.reserveBuilder();
      try {
        await this.inventory.base({
          status: "preparing",
          baseGeneration: image.generation ?? undefined,
          appliedProfileVersion: image.profileVersion ?? undefined,
          lastUpdatedAt: image.builtAt ?? undefined,
          startedAt: nowIso(),
        });
        this.updating = true;
        return release;
      } catch (cause) {
        release();
        throw cause;
      }
    });
    if (!release) {
      onAdmitted?.(false);
      return;
    }
    try {
      onAdmitted?.(true);
      const next = await this.graph.run(() => this.options.images.refresh());
      await this.inventory.base({
        status: "current",
        baseGeneration: next.generation ?? undefined,
        appliedProfileVersion: next.profileVersion ?? undefined,
        lastUpdatedAt: next.builtAt ?? nowIso(),
        completedAt: nowIso(),
      });
    } catch (cause) {
      await this.inventory.base({
        ...(await this.inventory.read()).baseMaintenance,
        status: "failed",
        completedAt: nowIso(),
        detail: failureDetail(cause),
      });
      throw cause;
    } finally {
      this.updating = false;
      release();
    }
  }
}

// @effect-diagnostics nodeBuiltinImport:off -- Inventory commits and rollback markers require durable file and directory syncs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  AgentDesktopGraphics,
  AgentDesktopLifecycleState,
  AgentDesktopMaintenance,
  AgentDesktopOwner,
  AgentDesktopPortRoute,
  AgentDesktopRequirements,
  type AgentDesktop,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { hostFailure } from "../../computer/ComputerHostConnection.ts";

export const DAY = 86_400_000;
export const PROFILE = "arch-gnome-v1";
export const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
export const nowIso = (at = nowMillis()) => DateTime.formatIso(DateTime.makeUnsafe(at));

const positive = Schema.Int.check(Schema.isGreaterThan(0));
const Resources = Schema.Struct({
  cpuCount: positive,
  memoryBytes: positive,
  diskVirtualBytes: positive,
  audio: Schema.Boolean,
});
export type Resources = typeof Resources.Type;
const Maintenance = Schema.Struct({
  status: Schema.optional(AgentDesktopMaintenance.fields.status),
  appliedProfileVersion: Schema.optional(Schema.String),
  lastUpdatedAt: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  baseGeneration: Schema.optional(Schema.String),
  previousState: Schema.optional(AgentDesktopLifecycleState),
  rollbackReady: Schema.optional(Schema.Boolean),
  detail: Schema.optional(Schema.String),
});
export type Maintenance = typeof Maintenance.Type;
const Machine = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^agent-[0-9a-f]{32}$/u)),
  owner: AgentDesktopOwner,
  label: Schema.String,
  state: AgentDesktopLifecycleState,
  resources: Resources,
  requirements: Schema.optional(AgentDesktopRequirements),
  maintenance: Schema.optional(Maintenance),
  baseGeneration: Schema.optional(Schema.String),
  graphicsBackend: Schema.optional(AgentDesktopGraphics.fields.backend),
  routes: Schema.Array(AgentDesktopPortRoute),
  createdAt: Schema.String,
  lastActiveAt: Schema.String,
  recoverableUntil: Schema.NullOr(Schema.String),
  beforeTrash: Schema.optional(Schema.Literal("failed")),
  detail: Schema.optional(Schema.String),
  savedMemory: Schema.optional(Schema.Boolean),
  publishingDisks: Schema.optional(Schema.Literal(true)),
});
export type Machine = typeof Machine.Type;
const Document = Schema.Struct({
  version: Schema.Literal(1),
  desktops: Schema.Array(Machine),
  baseMaintenance: Schema.optional(Maintenance),
});
type Document = typeof Document.Type;
const isDocument = Schema.is(Document);

export class Serial {
  private tail = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

export function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function privateDirectory(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error("The Agent desktop directory must belong to the server user.");
  }
  if ((stat.mode & 0o777) !== 0o700) await NodeFSP.chmod(directory, 0o700);
}

export async function syncDirectory(directory: string) {
  const fd = await NodeFSP.open(directory, "r");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

async function save(directory: string, value: Document) {
  await privateDirectory(directory);
  const temporary = NodePath.join(directory, `.desktops-${NodeCrypto.randomUUID()}.tmp`);
  const fd = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    try {
      await fd.writeFile(JSON.stringify(value));
      await fd.sync();
    } finally {
      await fd.close();
    }
    await NodeFSP.rename(temporary, NodePath.join(directory, "desktops.json"));
    await syncDirectory(directory);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export class Inventory {
  private document: Document | undefined;
  private readonly writes = new Serial();
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  private async load() {
    if (this.document) return this.document;
    let raw: string;
    try {
      raw = await NodeFSP.readFile(NodePath.join(this.directory, "desktops.json"), "utf8");
    } catch (e) {
      if (!isMissing(e)) throw e;
      this.document = { version: 1, desktops: [] };
      return this.document;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !isDocument(parsed) ||
      new Set(parsed.desktops.map((r) => r.id)).size !== parsed.desktops.length
    ) {
      throw new Error(
        "The Agent desktop inventory is invalid. Its machines and backing images have been retained.",
      );
    }
    this.document = parsed;
    return parsed;
  }

  async read() {
    return this.document ?? this.writes.run(() => this.load());
  }

  async get(id: string) {
    const row = (await this.read()).desktops.find((entry) => entry.id === id);
    if (!row)
      throw hostFailure(
        "desktop-target-mismatch",
        "invalid-input",
        "The requested Agent desktop does not exist.",
      );
    return row;
  }
  private async change(edit: (doc: Document) => Document) {
    await this.writes.run(async () => {
      const next = edit(await this.load());
      try {
        await save(this.directory, next);
        this.document = next;
      } catch (cause) {
        // A directory fsync can fail after rename has already published the document.
        this.document = undefined;
        throw cause;
      }
    });
  }
  async put(row: Machine) {
    await this.change((doc) => ({
      ...doc,
      desktops: doc.desktops.some((r) => r.id === row.id)
        ? doc.desktops.map((r) => (r.id === row.id ? row : r))
        : [...doc.desktops, row],
    }));
    return row;
  }
  async remove(id: string) {
    await this.change((doc) => ({ ...doc, desktops: doc.desktops.filter((r) => r.id !== id) }));
  }
  async base(baseMaintenance: Maintenance) {
    await this.change((doc) => ({ ...doc, baseMaintenance }));
  }
}

export const backend = (row: Machine) => row.graphicsBackend ?? "virtio-gpu-2d";
export const runningState = (state: Machine["state"]) =>
  state === "ready" || state === "active" || state === "starting";
export const savedMemory = (row: Machine) =>
  row.savedMemory ?? (row.state === "parked" && backend(row) !== "virgl");
export const pendingUpdate = (m?: Maintenance) =>
  m?.rollbackReady === true || (!!m?.status && !["current", "due", "failed"].includes(m.status));
export function maintenanceStatus(m?: Maintenance): AgentDesktopMaintenance {
  const fresh =
    m?.appliedProfileVersion === PROFILE &&
    nowMillis() - Date.parse(m.lastUpdatedAt ?? "") < 7 * DAY;
  return {
    status:
      m?.status && (pendingUpdate(m) || m.status === "failed")
        ? m.status
        : fresh
          ? "current"
          : "due",
    targetProfileVersion: PROFILE,
    appliedProfileVersion: m?.appliedProfileVersion ?? null,
    lastUpdatedAt: m?.lastUpdatedAt ?? null,
    startedAt: m?.startedAt ?? null,
    completedAt: m?.completedAt ?? null,
    ...(m?.detail ? { detail: m.detail.slice(0, 512) } : {}),
  };
}
export function retryDue(m?: Maintenance) {
  const status = maintenanceStatus(m).status;
  return (
    status === "due" ||
    (status === "failed" &&
      !pendingUpdate(m) &&
      !(nowMillis() - Date.parse(m?.completedAt ?? "") < DAY / 4))
  );
}

export class Session {
  readonly lock = new Serial();
  readonly viewers = new Set<string>();
  controller: string | null = null;
  displacedController: string | null = null;
  operations = 0;
  touched = 0;
  attached = false;
  updating = false;
  routes: readonly AgentDesktopPortRoute[] | undefined;
  cpuSample: { at: number; nanoseconds: number } | undefined;
  get busy() {
    return this.operations > 0 || this.viewers.size > 0 || this.updating;
  }
}

export function summary(row: Machine, s: Session): AgentDesktop {
  const gpu = backend(row);
  const virgl = gpu === "virgl";
  return {
    id: row.id,
    owner: row.owner,
    label: row.label,
    state: runningState(row.state) && s.viewers.size ? "active" : row.state,
    automaticParking: !row.requirements?.preventParking,
    updatePolicy: row.requirements?.updatePolicy ?? "automatic",
    capabilities: [
      "computer",
      "video",
      "command",
      "files",
      "network-telemetry",
      "port-routing",
      "packet-capture",
      "snapshots",
      "cloning",
      ...(virgl ? ["graphics-acceleration" as const] : []),
    ],
    controllerId: s.controller,
    canReturnControl:
      s.displacedController === row.owner.controllerId && s.viewers.has(row.owner.controllerId),
    viewerCount: s.viewers.size,
    createdAt: row.createdAt,
    lastActiveAt: s.touched > Date.parse(row.lastActiveAt) ? nowIso(s.touched) : row.lastActiveAt,
    recoverableUntil: row.recoverableUntil,
    retention: row.requirements?.retention ?? "automatic",
    baseGeneration: row.baseGeneration ?? null,
    maintenance: maintenanceStatus(row.maintenance),
    graphics: {
      backend: gpu,
      hardwareAccelerated: virgl,
      renderer: virgl ? "virgl" : gpu === "virtio-gpu-2d" ? "virtio-gpu 2D" : "compatibility VGA",
      checkpointMode: virgl ? "disk-consistent" : "full-state",
    },
    ...(row.detail ? { detail: row.detail.slice(0, 512) } : {}),
  };
}

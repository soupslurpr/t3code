// @effect-diagnostics nodeBuiltinImport:off - Completion receipts must survive loss of the enclosing native runtime.
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  DesktopProcessCompletionReceipt,
  isDesktopProcessLive,
  type DesktopProcess,
  type DesktopJobCompletionInput,
} from "@t3tools/contracts";
import type { DesktopJobAuthority, DesktopJobOptions, DesktopJobOwner } from "./port.ts";
import { denied, failure, sameOwner } from "./request.ts";

const Registration = Schema.Struct({
  waitId: Schema.String,
  processId: Schema.String,
  runtimeGeneration: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
  grants: Schema.Array(Schema.String),
  receipt: Schema.NullOr(DesktopProcessCompletionReceipt),
});
type Registration = typeof Registration.Type;
const document = Schema.Struct({
  version: Schema.Literal(1),
  registrations: Schema.Array(Registration),
});
type Wait = Pick<DesktopJobCompletionInput, "waitId" | "processId" | "runtimeGeneration">;
const key = (owner: DesktopJobOwner, input: Wait) =>
  JSON.stringify([
    owner.environmentId,
    owner.threadId,
    input.waitId,
    input.processId,
    input.runtimeGeneration,
  ]);
function result(process: DesktopProcess): DesktopProcessCompletionReceipt | null {
  if (isDesktopProcessLive(process) || !process.runtimeGeneration || !process.completedAt)
    return null;
  return {
    processId: process.processId,
    runtimeGeneration: process.runtimeGeneration,
    status: process.status as "exited" | "failed" | "lost",
    exitCode: process.exitCode,
    signal: process.signal,
    completedAt: process.completedAt,
  };
}

export class Receipts {
  private entries: readonly Registration[] = [];
  private readonly retired = new Set<string>();
  private readonly pendingRevocations = new Set<string>();
  private work = Promise.resolve();
  private readonly platform: NodeJS.Platform;
  private readonly file: string;
  private readonly now: () => number;
  constructor(options: DesktopJobOptions, storagePlatform: NodeJS.Platform) {
    this.now = options.now;
    this.platform = storagePlatform;
    const desktop = NodeCrypto.createHash("sha256")
      .update(JSON.stringify([options.desktop.kind, options.desktop.desktopId]))
      .digest("hex");
    this.file = NodePath.join(options.directory, "completion-" + desktop + ".json");
  }
  private ended(
    r: Registration,
    status: "permission-revoked" | "lost",
  ): DesktopProcessCompletionReceipt {
    return {
      processId: r.processId,
      runtimeGeneration: r.runtimeGeneration,
      status,
      exitCode: null,
      signal: null,
      completedAt: DateTime.formatIso(DateTime.makeUnsafe(this.now())),
    };
  }
  async open() {
    const release = await lockRuntime(this.file + ".lock", this.platform);
    try {
      await this.load();
      return release;
    } catch (cause) {
      await release();
      throw cause;
    }
  }
  private async load() {
    let raw: string;
    try {
      raw = await NodeFSP.readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    this.entries = Schema.decodeUnknownSync(document)(JSON.parse(raw)).registrations;
    if (this.entries.some((r) => r.receipt === null)) {
      await this.persist(
        this.entries.map((r) =>
          r.receipt === null ? { ...r, receipt: this.ended(r, "lost") } : r,
        ),
      );
    }
  }
  private async persist(entries: readonly Registration[]) {
    const temp = this.file + "." + NodeCrypto.randomUUID() + ".new";
    const h = await NodeFSP.open(temp, "wx", 0o600);
    try {
      try {
        await h.writeFile(JSON.stringify({ version: 1, registrations: entries }));
        await h.sync();
      } finally {
        await h.close();
      }
      await NodeFSP.rename(temp, this.file);
      this.entries = entries;
      if (this.platform !== "win32") {
        const dir = await NodeFSP.open(NodePath.dirname(this.file), "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
    } finally {
      await NodeFSP.rm(temp, { force: true });
    }
  }
  private queue<T>(f: () => Promise<T>): Promise<T> {
    const next = this.work.then(f);
    this.work = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  capture(process: DesktopProcess) {
    return this.queue(async () => {
      const receipt = result(process);
      if (!receipt) return;
      const matches = (r: Registration) =>
        r.receipt === null &&
        r.processId === process.processId &&
        r.runtimeGeneration === process.runtimeGeneration;
      if (this.entries.some(matches))
        await this.persist(
          this.entries.map((r) =>
            matches(r)
              ? {
                  ...r,
                  receipt: r.grants.some((id) => this.pendingRevocations.has(id))
                    ? this.ended(r, "permission-revoked")
                    : receipt,
                }
              : r,
          ),
        );
    });
  }
  revoke(grants: ReadonlySet<string>) {
    for (const id of grants) this.pendingRevocations.add(id);
    return this.queue(async () => {
      const revoked = new Set(this.pendingRevocations);
      const matches = (r: Registration) =>
        r.grants.some((g) => revoked.has(g)) && r.receipt?.status !== "permission-revoked";
      if (this.entries.some(matches))
        await this.persist(
          this.entries.map((r) =>
            matches(r) ? { ...r, receipt: this.ended(r, "permission-revoked") } : r,
          ),
        );
      for (const id of revoked) this.pendingRevocations.delete(id);
    });
  }
  invoke(
    owner: DesktopJobOwner,
    input: DesktopJobCompletionInput,
    authority: DesktopJobAuthority | undefined,
    register: () => DesktopProcess,
  ) {
    return this.queue(async () => {
      const identity = key(owner, input);
      const existing = this.entries.find((r) => r.waitId === input.waitId);
      if (existing && key(existing, existing) !== identity)
        throw failure(
          "wait-identity-conflict",
          "This wait belongs to another owner, process or runtime.",
        );
      if (input.action === "cancel" || input.action === "acknowledge") {
        if (existing) await this.persist(this.entries.filter((r) => r !== existing));
        this.retired.add(identity);
        return null;
      }
      if (input.action === "register") {
        if (!authority || !sameOwner(owner, authority.owner)) throw denied();
        if (this.retired.has(identity))
          throw failure("wait-cancelled", "This completion wait was retired.");
        const state = register();
        if (!existing) {
          const record: Registration = {
            environmentId: owner.environmentId,
            threadId: owner.threadId,
            waitId: input.waitId,
            processId: input.processId,
            runtimeGeneration: input.runtimeGeneration,
            grants: [...new Set([authority.grantId, ...(state.grantId ? [state.grantId] : [])])],
            receipt: result(state),
          };
          await this.persist([...this.entries, record]);
          return record.receipt && { ...record.receipt };
        }
      }
      if (!existing)
        throw failure("wait-not-registered", "This completion wait is not registered.");
      if (existing.grants.some((id) => this.pendingRevocations.has(id)))
        return this.ended(existing, "permission-revoked");
      return existing.receipt && { ...existing.receipt };
    });
  }
  drain() {
    return this.pendingRevocations.size ? this.revoke(this.pendingRevocations) : this.work;
  }
}

// The kernel releases the lock when a runtime dies. A second live runtime must never mark the first one's waits lost.
async function lockRuntime(path: string, platform: NodeJS.Platform): Promise<() => Promise<void>> {
  const ffi = NodeModule.createRequire(import.meta.url)("koffi") as typeof import("koffi").default;
  const busy = () =>
    failure("desktop-busy", "This desktop job storage already has an active runtime.");
  if (platform === "win32") {
    const kernel = ffi.load("kernel32.dll");
    const create = kernel.func(
      "intptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)",
    );
    const lastError = kernel.func("uint32_t __stdcall GetLastError(void)");
    const close = kernel.func("int32_t __stdcall CloseHandle(intptr_t)");
    // OPEN_ALWAYS with no sharing grants a single owner independently of the file's previous contents.
    const handle = create(NodePath.toNamespacedPath(path), 0xc0000000, 0, null, 4, 0x80, null);
    if (Number(handle) === -1) {
      const code = lastError();
      if (code === 32 || code === 33) throw busy();
      throw failure(
        "storage-unavailable",
        "Could not open the desktop job lock (Windows error " + code + ").",
      );
    }
    return async () => {
      if (!close(handle))
        throw failure("storage-unavailable", "Could not close the desktop job lock.");
    };
  }
  const lock = ffi.load(null).func("int flock(int, int)");
  const file = await NodeFSP.open(path, "a+", 0o600);
  if (lock(file.fd, 2 | 4) === 0) return () => file.close();
  const code = ffi.errno();
  await file.close();
  if (code === NodeOS.constants.errno.EWOULDBLOCK || code === NodeOS.constants.errno.EAGAIN)
    throw busy();
  throw failure("storage-unavailable", "Could not lock desktop job storage (errno " + code + ").");
}

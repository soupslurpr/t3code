/** Coordinates bounded file transfers over the selected desktop's existing connection. */
// @effect-diagnostics nodeBuiltinImport:off - Owns staged binary archives and capability tokens.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DESKTOP_TRANSFER_ROUTE_PREFIX,
  DesktopTransferManifest,
  UserDesktopTransferFailure,
  UserDesktopTransferRequestError,
  UserDesktopTransferResult,
  type UserDesktopCopyInput,
  type UserDesktopTransfer,
  type UserDesktopTransferTargetInput,
} from "@t3tools/contracts";
import {
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
} from "@t3tools/shared/agentDesktopBundle";
import {
  pruneDesktopTransferStaging,
  DesktopTransferError,
  desktopTransferArchiveChunks,
  receiveDesktopTransferArchive,
  resolveDesktopTransferWorkspacePath,
} from "@t3tools/shared/desktopTransfer";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const isFailureCode = Schema.is(UserDesktopTransferFailure.fields.code);
const decodeResult = Schema.decodeUnknownEffect(UserDesktopTransferResult);
const terminal = (state: UserDesktopTransfer["state"]) =>
  ["completed", "failed", "cancelled"].includes(state);
const requestError = (message: string) =>
  new UserDesktopTransferRequestError({ message: message.slice(0, 1024) });
const sameOwner = (a: McpInvocationScope, b: McpInvocationScope) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;

interface TransferRecord {
  readonly scope: McpInvocationScope;
  readonly fingerprint: ReadonlyArray<string>;
  readonly archivePath: string;
  readonly token: string;
  readonly abort: AbortController;
  readonly completion: Deferred.Deferred<void>;
  readonly io: Set<Promise<unknown>>;
  snapshot: UserDesktopTransfer;
  manifest: DesktopTransferManifest | null;
  claimed: boolean;
  uploaded: boolean;
  fiber: Fiber.Fiber<void> | null;
}

/** Native and filesystem errors retain useful codes without exposing transport credentials. */
function failure(
  cause: unknown,
  phase: UserDesktopTransferFailure["phase"],
): UserDesktopTransferFailure {
  const value =
    typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : {};
  const native =
    typeof value.computerFailure === "object" && value.computerFailure !== null
      ? (value.computerFailure as Record<string, unknown>)
      : value;
  const rawCode = native.backendCode ?? native.code;
  const code =
    rawCode === "request-cancelled"
      ? "cancelled"
      : rawCode === "desktop-offline"
        ? "desktop-unavailable"
        : rawCode === "source-changed" || rawCode === "ENOENT"
          ? "source-unavailable"
          : rawCode === "ENOSPC" || rawCode === "EDQUOT" || rawCode === "ENOMEM"
            ? "resource-exhausted"
            : rawCode === "EACCES" || rawCode === "EPERM"
              ? "permission-denied"
              : rawCode;
  return {
    code: isFailureCode(code)
      ? code
      : String(value._tag).includes("Timeout")
        ? "timed-out"
        : String(value._tag).includes("Unavailable") ||
            String(value._tag).includes("NoAvailableHost")
          ? "desktop-unavailable"
          : "transport-failed",
    phase,
    detail: String(
      native.message ?? (cause instanceof Error ? cause.message : "File transfer failed."),
    ).slice(0, 1024),
  };
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const broker = yield* PreviewAutomationBroker;
  const scope = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const now = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
  const directory = NodePath.join(config.stateDir, "user-desktop-transfers");
  yield* Effect.tryPromise(() => NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 }));
  yield* Effect.tryPromise(() =>
    pruneDesktopTransferStaging(directory, "session-", clock.currentTimeMillisUnsafe()),
  );
  // Each server lifetime owns one private directory, never another instance's staging files.
  const staging = yield* Effect.tryPromise(() =>
    NodeFSP.mkdtemp(NodePath.join(directory, "session-")),
  );
  const records = new Map<string, TransferRecord>();
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const record of records.values()) record.abort.abort();
      await Promise.allSettled([...records.values()].flatMap((record) => [...record.io]));
      await NodeFSP.rm(staging, { recursive: true, force: true });
    }),
  );

  const update = (record: TransferRecord, patch: Partial<UserDesktopTransfer>) => {
    if (!terminal(record.snapshot.state))
      record.snapshot = { ...record.snapshot, ...patch, updatedAt: now() };
  };
  const metadata = (record: TransferRecord, manifest: DesktopTransferManifest) => {
    record.manifest = manifest;
    const { rootType, fileCount, directoryCount, symlinkCount, logicalBytes } = manifest;
    update(record, {
      compression: manifest.compression,
      totalBytes: manifest.wireBytes,
      sha256: manifest.sha256,
      tree: { rootType, fileCount, directoryCount, symlinkCount, logicalBytes },
    });
  };
  const finish = Effect.fn("UserDesktopTransfers.finish")(function* (
    record: TransferRecord,
    state: "completed" | "failed" | "cancelled",
    error: UserDesktopTransferFailure | null,
  ) {
    update(record, { state, error, completedAt: now() });
    record.abort.abort();
    yield* Deferred.succeed(record.completion, undefined);
  });
  const io = <A>(record: TransferRecord, run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => {
        const promise = run(AbortSignal.any([signal, record.abort.signal]));
        record.io.add(promise);
        void promise.finally(() => record.io.delete(promise)).catch(() => undefined);
        return promise;
      },
      catch: (cause) => {
        const error = failure(cause, "transferring");
        return new DesktopTransferError(error.code, error.detail);
      },
    });
  const owned = (owner: McpInvocationScope, id: string) =>
    Effect.suspend(() => {
      const record = records.get(id);
      return record !== undefined && sameOwner(owner, record.scope)
        ? Effect.succeed(record)
        : Effect.fail(requestError("Transfer not found in this thread."));
    });
  const wait = Effect.fn("UserDesktopTransfers.wait")(function* (
    record: TransferRecord,
    waitMs: number,
  ) {
    if (!terminal(record.snapshot.state) && waitMs > 0)
      yield* Deferred.await(record.completion).pipe(Effect.timeoutOption(waitMs));
    return record.snapshot;
  });

  const run = Effect.fn("UserDesktopTransfers.run")(function* (
    record: TransferRecord,
    input: UserDesktopCopyInput,
    workspaceRoot: string,
  ) {
    const operation = Effect.gen(function* () {
      update(record, { state: "preparing" });
      const workspacePath = yield* io(record, () =>
        resolveDesktopTransferWorkspacePath(
          workspaceRoot,
          input.workspacePath,
          input.direction === "to-desktop",
        ),
      );
      if (input.direction === "to-desktop") {
        const manifest = yield* io(record, (signal) =>
          packAgentDesktopBundle({
            sourcePath: workspacePath,
            outputPath: record.archivePath,
            compression: input.compression ?? "auto",
            signal,
          }),
        );
        metadata(record, manifest);
      }
      const response = yield* broker.invoke({
        scope: record.scope,
        operation: "computerTransfer",
        timeoutMs: input.timeoutMs ?? 3_600_000,
        input: {
          operation: "run",
          desktop: input.desktop,
          transferId: record.snapshot.id,
          direction: input.direction,
          desktopPath: input.desktopPath,
          collision: input.collision ?? "create",
          compression: input.compression ?? "auto",
          timeoutMs: input.timeoutMs ?? 3_600_000,
          url: `${DESKTOP_TRANSFER_ROUTE_PREFIX}/${record.snapshot.id}`,
          token: record.token,
          ...(record.manifest === null ? {} : { manifest: record.manifest }),
        },
      });
      const result = yield* decodeResult(response);
      if (result.cancelled)
        return yield* Effect.fail(
          new DesktopTransferError("cancelled", "The desktop cancelled this transfer."),
        );
      const manifest = record.manifest;
      if (
        result.transferId !== record.snapshot.id ||
        result.manifest === undefined ||
        manifest === null ||
        Object.keys(DesktopTransferManifest.fields).some(
          (key) =>
            manifest[key as keyof DesktopTransferManifest] !==
            result.manifest?.[key as keyof DesktopTransferManifest],
        )
      )
        return yield* Effect.fail(
          new DesktopTransferError(
            "integrity-failed",
            "Desktop acknowledgement does not match the transferred archive.",
          ),
        );
      if (input.direction === "from-desktop") {
        if (!record.uploaded)
          return yield* Effect.fail(
            new DesktopTransferError(
              "integrity-failed",
              "The desktop did not complete its upload.",
            ),
          );
        update(record, { state: "installing" });
        // Recheck ancestors after the network wait before touching the destination.
        yield* io(record, () =>
          resolveDesktopTransferWorkspacePath(workspaceRoot, input.workspacePath, false),
        );
        yield* io(record, (signal) =>
          extractAgentDesktopBundle({
            archivePath: record.archivePath,
            destinationPath: workspacePath,
            compression: manifest.compression,
            collision: input.collision ?? "create",
            signal,
          }),
        );
      }
      yield* finish(record, "completed", null);
    });
    yield* operation.pipe(
      Effect.timeout(input.timeoutMs ?? 3_600_000),
      Effect.catchCause((cause) => {
        const phase = terminal(record.snapshot.state)
          ? "transferring"
          : (record.snapshot.state as UserDesktopTransferFailure["phase"]);
        const error = Cause.hasInterrupts(cause)
          ? {
              code: "cancelled" as const,
              phase,
              detail:
                "The transfer was cancelled. Check the destination before retrying if installation had already started.",
            }
          : failure(Cause.squash(cause), phase);
        return finish(record, error.code === "cancelled" ? "cancelled" : "failed", error);
      }),
      Effect.onInterrupt(() =>
        finish(record, "cancelled", {
          code: "cancelled",
          phase: "transferring",
          detail:
            "The transfer was cancelled. Inspect the destination if installation had started.",
        }),
      ),
      Effect.ensuring(
        Effect.promise(async () => {
          record.abort.abort();
          await Promise.allSettled(record.io);
          await NodeFSP.rm(record.archivePath, { force: true });
        }),
      ),
    );
  });

  const start = Effect.fn("UserDesktopTransfers.start")(function* (
    owner: McpInvocationScope,
    input: UserDesktopCopyInput,
  ) {
    const fingerprint = [
      input.desktop.desktopId,
      input.direction,
      input.workspacePath,
      input.desktopPath,
      input.collision ?? "create",
      input.compression ?? "auto",
      String(input.timeoutMs ?? 3_600_000),
    ];
    const projections = yield* ProjectionSnapshotQuery;
    const shell = yield* projections
      .getThreadShellById(owner.threadId)
      .pipe(Effect.mapError(() => requestError("Cannot read the transfer thread.")));
    if (Option.isNone(shell)) return yield* Effect.fail(requestError("Transfer thread not found."));
    const project = yield* projections
      .getProjectShellById(shell.value.projectId)
      .pipe(Effect.mapError(() => requestError("Cannot read the transfer workspace.")));
    if (Option.isNone(project))
      return yield* Effect.fail(requestError("Transfer workspace not found."));
    const completion = yield* Deferred.make<void>();
    // Admission and deduplication are synchronous, including across concurrent starts.
    const previous = [...records.values()].find(
      (record) => sameOwner(owner, record.scope) && record.snapshot.copyId === input.copyId,
    );
    if (previous !== undefined) {
      if (previous.fingerprint.some((value, index) => value !== fingerprint[index]))
        return yield* Effect.fail(
          requestError("This copyId already identifies a different transfer. Use a new copyId."),
        );
      return yield* wait(previous, input.waitMs ?? 15_000);
    }
    const entries = [...records.values()];
    if (
      entries.filter((record) => !terminal(record.snapshot.state)).length >= 32 ||
      entries.filter((record) => sameOwner(owner, record.scope) && !terminal(record.snapshot.state))
        .length >= 8
    )
      return yield* Effect.fail(
        requestError("Too many active desktop transfers. Wait for one to finish or cancel it."),
      );
    for (const record of entries
      .filter((record) => terminal(record.snapshot.state))
      .slice(0, Math.max(0, records.size - 255)))
      records.delete(record.snapshot.id);
    const id = `transfer-${NodeCrypto.randomUUID()}`;
    const timestamp = now();
    const record: TransferRecord = {
      scope: owner,
      fingerprint,
      token: NodeCrypto.randomBytes(32).toString("hex"),
      archivePath: NodePath.join(staging, `${id}.bundle`),
      abort: new AbortController(),
      completion,
      io: new Set(),
      manifest: null,
      claimed: false,
      uploaded: false,
      fiber: null,
      snapshot: {
        id,
        copyId: input.copyId,
        desktop: input.desktop,
        direction: input.direction,
        workspacePath: input.workspacePath,
        desktopPath: input.desktopPath,
        collision: input.collision ?? "create",
        state: "queued",
        compression: null,
        transferredBytes: 0,
        totalBytes: null,
        tree: null,
        sha256: null,
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        error: null,
      },
    };
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        records.set(id, record);
        record.fiber = yield* run(
          record,
          input,
          shell.value.worktreePath ?? project.value.workspaceRoot,
        ).pipe(Effect.interruptible, Effect.forkIn(scope));
      }),
    );
    return yield* wait(record, input.waitMs ?? 15_000);
  });
  const status = Effect.fn("UserDesktopTransfers.status")(function* (
    owner: McpInvocationScope,
    input: UserDesktopTransferTargetInput,
  ) {
    return yield* wait(yield* owned(owner, input.transferId), input.waitMs ?? 0);
  });
  const cancel = Effect.fn("UserDesktopTransfers.cancel")(function* (
    owner: McpInvocationScope,
    input: UserDesktopTransferTargetInput,
  ) {
    const record = yield* owned(owner, input.transferId);
    if (!terminal(record.snapshot.state)) {
      record.abort.abort();
      if (record.fiber !== null) yield* Fiber.interrupt(record.fiber);
    }
    return record.snapshot;
  });
  const claim = (id: string, token: string, direction: UserDesktopTransfer["direction"]) => {
    const record = records.get(id);
    if (
      record === undefined ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !NodeCrypto.timingSafeEqual(Buffer.from(token), Buffer.from(record.token)) ||
      record.snapshot.direction !== direction ||
      terminal(record.snapshot.state) ||
      record.claimed ||
      record.abort.signal.aborted
    )
      return null;
    if (direction === "to-desktop" && record.manifest === null) return null;
    record.claimed = true;
    update(record, { state: "transferring" });
    return record;
  };
  const download = (id: string, token: string) => {
    const record = claim(id, token, "to-desktop");
    if (record === null || record.manifest === null) return null;
    async function* body() {
      if (record === null) return;
      const drained = Promise.withResolvers<void>();
      record.io.add(drained.promise);
      try {
        yield* desktopTransferArchiveChunks({
          archivePath: record.archivePath,
          signal: record.abort.signal,
          onProgress: (bytes) => update(record, { transferredBytes: bytes }),
        });
      } finally {
        drained.resolve();
        record.io.delete(drained.promise);
      }
    }
    return { manifest: record.manifest, body: body() };
  };
  const upload = Effect.fn("UserDesktopTransfers.upload")(function* (
    id: string,
    token: string,
    manifest: DesktopTransferManifest,
    body: AsyncIterable<Uint8Array>,
  ) {
    const record = claim(id, token, "from-desktop");
    if (record === null) return false;
    metadata(record, manifest);
    yield* io(record, (signal) =>
      receiveDesktopTransferArchive({
        archivePath: record.archivePath,
        manifest,
        body,
        signal,
        onProgress: (bytes) => update(record, { transferredBytes: bytes }),
      }),
    );
    update(record, { state: "verifying" });
    record.uploaded = true;
    return true;
  });
  return { start, status, cancel, download, upload };
});

export class UserDesktopTransfers extends Context.Service<
  UserDesktopTransfers,
  Effect.Success<typeof make>
>()("t3/computer/UserDesktopTransfers") {}
export const layer = Layer.effect(UserDesktopTransfers, make);

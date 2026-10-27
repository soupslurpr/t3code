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
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { withWorkspaceTransfer } from "../workspace/workspaceTransferLease.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ThreadWorkspaceQuery } from "../orchestration-v2/ThreadWorkspaceQuery.ts";

const isFailureCode = Schema.is(UserDesktopTransferFailure.fields.code);
const decodeResult = Schema.decodeUnknownEffect(UserDesktopTransferResult);
const terminal = (state: UserDesktopTransfer["state"]) =>
  ["completed", "failed", "cancelled"].includes(state);
const requestError = (message: string) =>
  new UserDesktopTransferRequestError({ message: message.slice(0, 1024) });
const sameOwner = (a: McpThreadInvocationScope, b: McpThreadInvocationScope) =>
  a.environmentId === b.environmentId && a.thread.threadId === b.thread.threadId;

interface TransferRecord {
  readonly scope: McpThreadInvocationScope;
  readonly fingerprint: ReadonlyArray<string>;
  readonly archivePath: string;
  readonly token: string;
  readonly signal: AbortSignal;
  readonly cancel: Effect.Effect<void>;
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
    Effect.gen(function* () {
      for (const record of records.values()) yield* record.cancel;
      yield* Effect.promise(async () => {
        await Promise.allSettled([...records.values()].flatMap((record) => [...record.io]));
        await NodeFSP.rm(staging, { recursive: true, force: true });
      });
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
    yield* record.cancel;
    yield* Deferred.succeed(record.completion, undefined);
  });
  const io = <A>(record: TransferRecord, run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => {
        const promise = run(AbortSignal.any([signal, record.signal]));
        record.io.add(promise);
        void promise.finally(() => record.io.delete(promise)).catch(() => undefined);
        return promise;
      },
      catch: (cause) => {
        const error = failure(cause, "transferring");
        return new DesktopTransferError(error.code, error.detail);
      },
    });
  const owned = (owner: McpThreadInvocationScope, id: string) =>
    Effect.suspend(() => {
      const record = records.get(id);
      return record !== undefined && sameOwner(owner, record.scope)
        ? Effect.succeed(record)
        : requestError("Transfer not found in this thread.");
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
    yield* withWorkspaceTransfer(
      operation.pipe(
        // Keep the workspace hold until every owned I/O promise has drained.
        Effect.ensuring(
          Effect.gen(function* () {
            yield* record.cancel;
            yield* Effect.promise(async () => {
              await Promise.allSettled(record.io);
              await NodeFSP.rm(record.archivePath, { force: true });
            });
          }),
        ),
      ),
    ).pipe(
      // Waiting for cleanup admission is part of the transfer's lifetime too.
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
    );
  });

  const start = Effect.fn("UserDesktopTransfers.start")(function* (
    owner: McpThreadInvocationScope,
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
    const projections = yield* ThreadWorkspaceQuery;
    const shell = yield* projections
      .getThreadShellById(owner.thread.threadId)
      .pipe(Effect.mapError(() => requestError("Cannot read the transfer thread.")));
    if (Option.isNone(shell)) return yield* requestError("Transfer thread not found.");
    const project = yield* projections
      .getProjectShellById(shell.value.projectId)
      .pipe(Effect.mapError(() => requestError("Cannot read the transfer workspace.")));
    if (Option.isNone(project)) return yield* requestError("Transfer workspace not found.");
    const completion = yield* Deferred.make<void>();
    const cancellationScope = yield* Scope.fork(scope);
    const signal = yield* Effect.provideService(Effect.abortSignal, Scope.Scope, cancellationScope);
    // Admission and deduplication are synchronous, including across concurrent starts.
    const previous = [...records.values()].find(
      (record) => sameOwner(owner, record.scope) && record.snapshot.copyId === input.copyId,
    );
    if (previous !== undefined) {
      yield* Scope.close(cancellationScope, Exit.void);
      if (previous.fingerprint.some((value, index) => value !== fingerprint[index]))
        return yield* requestError(
          "This copyId already identifies a different transfer. Use a new copyId.",
        );
      return yield* wait(previous, input.waitMs ?? 15_000);
    }
    const entries = [...records.values()];
    if (
      entries.filter((record) => !terminal(record.snapshot.state)).length >= 32 ||
      entries.filter((record) => sameOwner(owner, record.scope) && !terminal(record.snapshot.state))
        .length >= 8
    ) {
      yield* Scope.close(cancellationScope, Exit.void);
      return yield* requestError(
        "Too many active desktop transfers. Wait for one to finish or cancel it.",
      );
    }
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
      signal,
      cancel: Scope.close(cancellationScope, Exit.void),
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
    records.set(id, record);
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
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
    owner: McpThreadInvocationScope,
    input: UserDesktopTransferTargetInput,
  ) {
    return yield* wait(yield* owned(owner, input.transferId), input.waitMs ?? 0);
  });
  const cancel = Effect.fn("UserDesktopTransfers.cancel")(function* (
    owner: McpThreadInvocationScope,
    input: UserDesktopTransferTargetInput,
  ) {
    const record = yield* owned(owner, input.transferId);
    if (!terminal(record.snapshot.state)) {
      yield* record.cancel;
      if (record.fiber !== null) yield* Fiber.interrupt(record.fiber);
      // Cancellation before the worker's first evaluation cannot run its hooks.
      yield* finish(record, "cancelled", {
        code: "cancelled",
        phase: "transferring",
        detail: "The transfer was cancelled. Inspect the destination if installation had started.",
      });
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
      record.signal.aborted
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
          signal: record.signal,
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
  const listForThread = (environmentId: string, threadId: string) =>
    Effect.sync(() =>
      Array.from(records.values())
        .filter(
          (record) =>
            record.scope.environmentId === environmentId &&
            record.scope.thread.threadId === threadId,
        )
        .map((record) => record.snapshot)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 50),
    );
  return { start, status, cancel, download, upload, listForThread };
});

export class UserDesktopTransfers extends Context.Service<
  UserDesktopTransfers,
  Effect.Success<typeof make>
>()("t3/computer/UserDesktopTransfers") {}
export const layer = Layer.effect(UserDesktopTransfers, make);

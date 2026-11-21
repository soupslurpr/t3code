/** Coordinates bounded file transfers over the selected desktop's existing connection. */
// @effect-diagnostics nodeBuiltinImport:off - Owns staged binary archives and capability tokens.
import * as NodeCrypto from "node:crypto";
import { DesktopTransferStream } from "./DesktopTransferStream.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import {
  DESKTOP_TRANSFER_ROUTE_PREFIX,
  DesktopTransferManifest,
  UserDesktopTransferFailure,
  UserDesktopTransferRequestError,
  UserDesktopTransferResult,
  type DesktopCopyInput,
  type DesktopTransfer,
  type UserDesktopTransferTargetInput,
} from "@t3tools/contracts";
import { extractAgentDesktopBundle, packAgentDesktopBundle } from "@t3tools/shared/desktopTransfer";
import {
  MAX_DESKTOP_TRANSFER_BYTES,
  isDesktopTransferCancellation,
  pruneDesktopTransferStaging,
  DesktopTransferError,
  desktopTransferArchiveChunks,
  receiveDesktopTransferArchive,
} from "@t3tools/shared/desktopTransfer";
import { bindWorkspaceTransfer, type WorkspaceTransferPath } from "@t3tools/shared/desktopTransfer";
import * as Result from "effect/Result";
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
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { withWorkspaceTransfer } from "../workspace/workspaceTransferLease.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ComputerAutomationRouter } from "./ComputerAutomationRouter.ts";
import { desktopCaller } from "./DesktopCaller.ts";
import {
  beforeDesktopTransferPublication,
  desktopTransferWorkspace,
} from "../workspace/desktopTransferAccess.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectService } from "../project/ProjectService.ts";

const isDesktopTransferError = Schema.is(DesktopTransferError);
const requireNative = NodeModule.createRequire(import.meta.url);
const loadKoffi = async () => requireNative("koffi") as typeof import("koffi").default;
const isFailureCode = Schema.is(UserDesktopTransferFailure.fields.code);
const terminal = (state: DesktopTransfer["state"]) =>
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
  readonly releaseWorkspace: Effect.Effect<void>;
  readonly io: Set<Promise<unknown>>;
  snapshot: DesktopTransfer;
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
  const policies = yield* RuntimePolicy.RuntimePolicyV2;
  const router = yield* ComputerAutomationRouter;
  const projects = yield* ProjectService;
  const projections = yield* ProjectionStoreV2;

  const scope = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const runUpload = Effect.runPromiseWith(yield* Effect.context<never>());
  const now = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
  const directory = NodePath.join(config.stateDir, "user-desktop-transfers");
  // Each server lifetime owns a private directory within the shared staging root.
  const staging = yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      await pruneDesktopTransferStaging(directory, "session-", clock.currentTimeMillisUnsafe());
      return NodeFSP.mkdtemp(NodePath.join(directory, "session-"));
    },
    catch: (cause) =>
      requestError(
        `Could not prepare desktop transfer staging: ${failure(cause, "preparing").detail}`,
      ),
  });
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

  const update = (record: TransferRecord, patch: Partial<DesktopTransfer>) => {
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
  const finish = Effect.fn("DesktopTransfers.finish")(function* (
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
        return new DesktopTransferError({ code: error.code, message: error.detail });
      },
    });
  const owned = (owner: McpThreadInvocationScope, id: string) =>
    Effect.suspend(() => {
      const record = records.get(id);
      return record !== undefined && sameOwner(owner, record.scope)
        ? Effect.succeed(record)
        : requestError("Transfer not found in this thread.");
    });
  const wait = Effect.fn("DesktopTransfers.wait")(function* (
    record: TransferRecord,
    waitMs: number,
  ) {
    if (!terminal(record.snapshot.state) && waitMs > 0)
      yield* Deferred.await(record.completion).pipe(Effect.timeoutOption(waitMs));
    return record.snapshot;
  });

  const run = Effect.fn("DesktopTransfers.run")(function* (
    record: TransferRecord,
    input: DesktopCopyInput,
    admitted: Result.Result<WorkspaceTransferPath, DesktopTransferError>,
    beforePublish: () => Promise<void>,
  ) {
    let installationCancellation: UserDesktopTransferFailure | null = null;
    const operation = Effect.gen(function* () {
      update(record, { state: "preparing" });
      if (Result.isFailure(admitted)) return yield* admitted.failure;
      const workspace = admitted.success;
      if (input.direction === "to-desktop") {
        const manifest = yield* io(record, (signal) =>
          packAgentDesktopBundle({
            sourcePath: workspace.named,
            workspace,
            outputPath: record.archivePath,
            compression: input.compression ?? "auto",
            signal,
          }),
        );
        metadata(record, manifest);
      }
      const result = yield* router
        .invoke(
          UserDesktopTransferResult,
          yield* desktopCaller(record.scope),
          "computerTransfer",
          {
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
          input.timeoutMs ?? 3_600_000,
        )
        .pipe(
          Effect.provideService(DesktopTransferStream, {
            download: () => download(record.snapshot.id, record.token),
            upload: (manifest, body, signal) =>
              runUpload(upload(record.snapshot.id, record.token, manifest, body), {
                signal,
              }),
          }),
        );
      if (result.cancelled)
        return yield* new DesktopTransferError({
          code: "cancelled",
          message: "The desktop cancelled this transfer.",
        });
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
        return yield* new DesktopTransferError({
          code: "integrity-failed",
          message: "Desktop acknowledgement does not match the transferred archive.",
        });
      if (input.direction === "from-desktop") {
        if (!record.uploaded)
          return yield* new DesktopTransferError({
            code: "integrity-failed",
            message: "The desktop did not complete its upload.",
          });
        update(record, { state: "installing" });
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // @effect-diagnostics-next-line abortControllerInEffect:off - Abort before awaiting the in-flight native receipt.
            const controller = new AbortController();
            const signal = AbortSignal.any([record.signal, controller.signal]);
            const settled = extractAgentDesktopBundle({
              archivePath: record.archivePath,
              destinationPath: workspace.named,
              workspace,
              beforePublish,
              compression: manifest.compression,
              collision: input.collision ?? "create",
              signal,
              loadKoffi,
            }).then(
              () => ({ ok: true as const }),
              (cause: unknown) => ({ ok: false as const, cause }),
            );
            record.io.add(settled);
            void settled.then(() => record.io.delete(settled));
            const complete = (outcome: Awaited<typeof settled>, interrupted = false) => {
              if (outcome.ok) return finish(record, "completed", null);
              const error = failure(outcome.cause, "installing");
              if (signal.aborted && isDesktopTransferCancellation(outcome.cause, signal.reason)) {
                if (interrupted) {
                  installationCancellation = error;
                  return Effect.void;
                }
                return finish(record, "cancelled", { ...error, code: "cancelled" });
              }
              return finish(record, "failed", error);
            };
            const outcome = yield* restore(Effect.promise(() => settled)).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  controller.abort();
                  yield* complete(yield* Effect.promise(() => settled), true);
                }),
              ),
            );
            yield* complete(outcome);
          }),
        );
      }
      yield* finish(record, "completed", null);
    });
    yield* Effect.uninterruptibleMask((restore) =>
      restore(
        withWorkspaceTransfer(
          operation.pipe(
            // Hold the checkout until every owned I/O promise has drained.
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
        ).pipe(Effect.timeout(input.timeoutMs ?? 3_600_000)),
      ).pipe(
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
          return finish(
            record,
            error.code === "cancelled" ? "cancelled" : "failed",
            installationCancellation === null
              ? error
              : { ...error, detail: installationCancellation.detail },
          );
        }),
      ),
    );
  });

  const start = Effect.fn("DesktopTransfers.start")(function (
    owner: McpThreadInvocationScope,
    input: DesktopCopyInput,
  ) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fingerprint = [
          input.desktop.kind,
          input.desktop.desktopId ?? "",
          input.direction,
          input.workspacePath,
          input.desktopPath,
          input.collision ?? "create",
          input.compression ?? "auto",
          String(input.timeoutMs ?? 3_600_000),
        ];
        const retainedCopy = () => {
          const previous = [...records.values()].find(
            (record) => sameOwner(owner, record.scope) && record.snapshot.copyId === input.copyId,
          );
          if (previous === undefined) return undefined;
          if (previous.fingerprint.some((value, index) => value !== fingerprint[index]))
            return Effect.fail(
              requestError(
                "This copyId already identifies a different transfer. Use a new copyId.",
              ),
            );
          return wait(previous, input.waitMs ?? 15_000);
        };
        const retained = retainedCopy();
        if (retained !== undefined) return yield* restore(retained);
        const access = desktopTransferWorkspace(
          owner,
          projections,
          projects,
          policies,
          input.direction === "from-desktop",
        );
        const workspace = yield* restore(
          access.pipe(Effect.mapError((error) => requestError(error.message))),
        );
        const lease = yield* Scope.fork(scope);
        const releaseWorkspace = Scope.close(lease, Exit.void);
        const boundPath = yield* Effect.acquireDisposable(
          Effect.tryPromise({
            try: () =>
              bindWorkspaceTransfer(
                workspace.root,
                input.workspacePath,
                input.direction === "to-desktop",
                loadKoffi,
                {
                  editOnly: workspace.editOnly,
                  stagingDirectory: directory,
                  archiveDirectory: staging,
                  collision: input.collision ?? "create",
                },
              ),
            catch: (cause) =>
              isDesktopTransferError(cause)
                ? cause
                : new DesktopTransferError({
                    code:
                      input.direction === "to-desktop" ? "invalid-source" : "invalid-destination",
                    message: failure(cause, "preparing").detail,
                  }),
          }),
        ).pipe(Effect.provideService(Scope.Scope, lease), Effect.result);
        if (Result.isFailure(boundPath)) {
          yield* releaseWorkspace;
          if (boundPath.failure.code === "permission-denied")
            return yield* requestError(boundPath.failure.message);
        }
        const completion = yield* Deferred.make<void>();
        const cancellationScope = yield* Scope.fork(scope);
        const signal = yield* Effect.provideService(
          Effect.abortSignal,
          Scope.Scope,
          cancellationScope,
        );
        // Another start can finish admission while this one opens the workspace.
        const concurrent = retainedCopy();
        if (concurrent !== undefined) {
          yield* releaseWorkspace;
          yield* Scope.close(cancellationScope, Exit.void);
          return yield* restore(concurrent);
        }
        if (Result.isFailure(boundPath) && boundPath.failure.code === "unsupported-entry") {
          yield* Scope.close(cancellationScope, Exit.void);
          return yield* requestError(boundPath.failure.message);
        }
        const entries = [...records.values()];
        if (
          entries.filter((record) => !terminal(record.snapshot.state)).length >= 32 ||
          entries.filter(
            (record) => sameOwner(owner, record.scope) && !terminal(record.snapshot.state),
          ).length >= 8
        ) {
          yield* releaseWorkspace;
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
          releaseWorkspace,
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
        record.fiber = yield* run(
          record,
          input,
          boundPath,
          beforeDesktopTransferPublication(access, workspace),
        ).pipe(Effect.ensuring(releaseWorkspace), Effect.interruptible, Effect.forkIn(scope));
        return yield* restore(wait(record, input.waitMs ?? 15_000));
      }),
    );
  });
  const status = Effect.fn("DesktopTransfers.status")(function* (
    owner: McpThreadInvocationScope,
    input: UserDesktopTransferTargetInput,
  ) {
    return yield* wait(yield* owned(owner, input.transferId), input.waitMs ?? 0);
  });
  const cancel = Effect.fn("DesktopTransfers.cancel")(function* (
    owner: McpThreadInvocationScope,
    input: UserDesktopTransferTargetInput,
  ) {
    const record = yield* owned(owner, input.transferId);
    if (!terminal(record.snapshot.state)) {
      yield* record.cancel;
      if (record.fiber !== null) yield* Fiber.interrupt(record.fiber);
      yield* record.releaseWorkspace;
      // Cancellation before the worker's first evaluation cannot run its hooks.
      yield* finish(record, "cancelled", {
        code: "cancelled",
        phase: "transferring",
        detail: "The transfer was cancelled. Inspect the destination if installation had started.",
      });
    }
    return record.snapshot;
  });
  const claim = (id: string, token: string, direction: DesktopTransfer["direction"]) => {
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
  const upload = Effect.fn("DesktopTransfers.upload")(function* (
    id: string,
    token: string,
    manifest: DesktopTransferManifest,
    body: AsyncIterable<Uint8Array>,
  ) {
    if (
      manifest.wireBytes > MAX_DESKTOP_TRANSFER_BYTES ||
      manifest.archiveBytes > MAX_DESKTOP_TRANSFER_BYTES ||
      manifest.logicalBytes > MAX_DESKTOP_TRANSFER_BYTES
    )
      return false;
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
  const listForDesktop = (environmentId: string, desktopId: string, threadId?: string) =>
    Effect.sync(() =>
      [...records.values()]
        .filter(
          (r) =>
            r.scope.environmentId === environmentId &&
            r.snapshot.desktop.kind === "user" &&
            r.snapshot.desktop.desktopId === desktopId &&
            !terminal(r.snapshot.state) &&
            (threadId === undefined || threadId === r.scope.thread.threadId),
        )
        .map((r) => r.snapshot)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    );
  return { start, status, cancel, download, upload, listForThread, listForDesktop };
});

export class DesktopTransfers extends Context.Service<
  DesktopTransfers,
  Effect.Success<typeof make>
>()("t3/computer/DesktopTransfers") {}
export const layer = Layer.effect(DesktopTransfers, make);

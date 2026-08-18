// @effect-diagnostics nodeBuiltinImport:off - Transfer archives are streamed by the Node boundary.
/**
 * Owns streamed workspace-to-Agent-desktop transfers.
 *
 * @module AgentDesktopTransferService
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type AgentDesktopCopyInput,
  type AgentDesktopTransfer,
  type AgentDesktopTransferFailure,
  type AgentDesktopTransferId,
  AgentDesktopTransferLookupError,
  type AgentDesktopTransferTargetInput,
} from "@t3tools/contracts";
import {
  AgentDesktopBundleError,
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
  sha256AgentDesktopBundle,
  type AgentDesktopBundleSummary,
} from "@t3tools/shared/agentDesktopBundle";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentDesktopManager from "./AgentDesktopManager.ts";

const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const TRANSFER_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_RETAINED_TRANSFERS = 256;
const MAX_ACTIVE_TRANSFERS_PER_CONTROLLER = 8;
const TRANSFER_ARCHIVE_NAME_PATTERN = /^transfer-[A-Za-z0-9_-]+\.bundle(?:\.[a-f0-9-]+\.raw)?$/;
const HOST_TRANSFER_FAILURE_CODES = new Set<string>([
  "source-unavailable",
  "invalid-destination",
  "destination-exists",
  "destination-type-mismatch",
  "unsupported-entry",
  "integrity-failed",
  "resource-exhausted",
]);
const RESOURCE_ERROR_CODES = new Set(["EDQUOT", "EFBIG", "ENOMEM", "ENOSPC"]);

type TransferPhase = AgentDesktopTransferFailure["phase"];
type TerminalTransferState = Extract<
  AgentDesktopTransfer["state"],
  "completed" | "failed" | "cancelled"
>;

interface TransferOwner {
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
}

interface TransferRecord {
  readonly owner: TransferOwner;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly snapshot: AgentDesktopTransfer;
  readonly completion: Deferred.Deferred<AgentDesktopTransfer>;
  readonly fiber: Fiber.Fiber<void, never> | null;
  readonly archivePath: string;
}

interface TransferState {
  readonly transfers: ReadonlyMap<AgentDesktopTransferId, TransferRecord>;
}

class TransferProcessError extends Data.TaggedError("TransferProcessError")<{
  readonly code: AgentDesktopTransferFailure["code"];
  readonly phase: TransferPhase;
  readonly detail: string;
}> {}

/** Returns whether a transfer state can no longer change. */
function isTerminalState(state: AgentDesktopTransfer["state"]): state is TerminalTransferState {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/** Converts a scope into the stable transfer owner used for authorization. */
function ownerFromScope(scope: McpInvocationContext.McpInvocationScope): TransferOwner {
  return {
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    providerSessionId: scope.providerSessionId,
    providerInstanceId: scope.providerInstanceId,
  };
}

/** Compares transfer owners without relying on object identity. */
function ownersMatch(left: TransferOwner, right: TransferOwner): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    left.providerSessionId === right.providerSessionId &&
    left.providerInstanceId === right.providerInstanceId
  );
}

/** Compares copied-tree summaries across the server and desktop boundary. */
function treesMatch(
  left: AgentDesktopTransfer["tree"],
  right: AgentDesktopTransfer["tree"],
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.rootType === right.rootType &&
    left.fileCount === right.fileCount &&
    left.directoryCount === right.directoryCount &&
    left.symlinkCount === right.symlinkCount &&
    left.logicalBytes === right.logicalBytes
  );
}

/** Removes transport-only fields from one portable bundle summary. */
function transferTree(
  summary: AgentDesktopBundleSummary,
): NonNullable<AgentDesktopTransfer["tree"]> {
  return {
    rootType: summary.rootType,
    fileCount: summary.fileCount,
    directoryCount: summary.directoryCount,
    symlinkCount: summary.symlinkCount,
    logicalBytes: summary.logicalBytes,
  };
}

/** Bounds all external failure detail before returning it through MCP. */
function boundedDetail(value: unknown): string {
  const detail = value instanceof Error ? value.message : String(value);
  return detail.slice(0, 1_024);
}

/** Formats one epoch millisecond value as an ISO timestamp. */
function isoTime(milliseconds: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
}

/** Parses one service-produced ISO timestamp for retention checks. */
function epochMilliseconds(value: string): number | null {
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.toEpochMillis,
  });
}

/** Maps bundle validation and filesystem failures to actionable transfer failures. */
function processError(
  phase: TransferPhase,
  cause: unknown,
  fallbackCode: AgentDesktopTransferFailure["code"],
): TransferProcessError {
  if (cause instanceof TransferProcessError) return cause;
  if (cause instanceof AgentDesktopBundleError) {
    const code: AgentDesktopTransferFailure["code"] =
      cause.code === "destination-exists"
        ? "destination-exists"
        : cause.code === "destination-type-mismatch"
          ? "destination-type-mismatch"
          : cause.code === "unsupported-entry"
            ? "unsupported-entry"
            : cause.code === "source-changed"
              ? "source-unavailable"
              : fallbackCode;
    return new TransferProcessError({ code, phase, detail: boundedDetail(cause) });
  }
  const causeRecord =
    typeof cause === "object" && cause !== null
      ? (cause as Readonly<Record<string, unknown>>)
      : undefined;
  const computerFailure =
    typeof causeRecord?.computerFailure === "object" && causeRecord.computerFailure !== null
      ? (causeRecord.computerFailure as Readonly<Record<string, unknown>>)
      : causeRecord;
  if (typeof causeRecord?.code === "string" && RESOURCE_ERROR_CODES.has(causeRecord.code)) {
    return new TransferProcessError({
      code: "resource-exhausted",
      phase,
      detail: boundedDetail(cause),
    });
  }
  const failureCode = computerFailure?.backendCode ?? computerFailure?.code;
  if (typeof failureCode === "string" && HOST_TRANSFER_FAILURE_CODES.has(failureCode)) {
    const code = failureCode as AgentDesktopTransferFailure["code"];
    const failurePhase: TransferPhase =
      code === "destination-exists" ||
      code === "destination-type-mismatch" ||
      code === "invalid-destination"
        ? "installing"
        : code === "integrity-failed"
          ? "verifying"
          : code === "source-unavailable"
            ? "preparing"
            : phase;
    return new TransferProcessError({
      code,
      phase: failurePhase,
      detail: boundedDetail(computerFailure?.detail ?? computerFailure?.message ?? cause),
    });
  }
  if (
    computerFailure?.code === "agent-desktop-unavailable" ||
    computerFailure?.code === "guest-disconnected"
  ) {
    return new TransferProcessError({
      code: "desktop-unavailable",
      phase,
      detail: boundedDetail(computerFailure?.detail ?? computerFailure?.message ?? cause),
    });
  }
  if (computerFailure?.code === "timed-out") {
    return new TransferProcessError({
      code: "timed-out",
      phase,
      detail: boundedDetail(computerFailure?.detail ?? computerFailure?.message ?? cause),
    });
  }
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String((cause as { readonly _tag: unknown })._tag)
      : "";
  const code: AgentDesktopTransferFailure["code"] = tag.includes("Timeout")
    ? "timed-out"
    : tag.includes("NoAvailableHost") || tag.includes("Unavailable")
      ? "desktop-unavailable"
      : fallbackCode;
  return new TransferProcessError({ code, phase, detail: boundedDetail(cause) });
}

/** Returns whether a resolved path remains inside a canonical workspace root. */
function pathIsWithin(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..");
}

/** Reads the first typed failure from a Cause, falling back to an internal failure. */
function failureFromCause(cause: Cause.Cause<TransferProcessError>): TransferProcessError {
  const failure = cause.reasons.find(Cause.isFailReason);
  return failure === undefined
    ? new TransferProcessError({
        code: "internal-error",
        phase: "transferring",
        detail: Cause.pretty(cause).slice(0, 1_024),
      })
    : failure.error;
}

/** Creates the in-memory transfer service. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const manager = yield* AgentDesktopManager.AgentDesktopManager;
  const state = yield* Ref.make<TransferState>({ transfers: new Map() });
  const transferDirectory = NodePath.join(config.stateDir, "agent-desktop-transfers");
  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(transferDirectory, { recursive: true, mode: 0o700 }),
    catch: (cause) => processError("preparing", cause, "internal-error"),
  }).pipe(Effect.orDie);
  yield* Effect.promise(async () => {
    const entries = await NodeFSP.readdir(transferDirectory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && TRANSFER_ARCHIVE_NAME_PATTERN.test(entry.name))
        .map((entry) =>
          NodeFSP.rm(NodePath.join(transferDirectory, entry.name), { force: true }).catch(
            () => undefined,
          ),
        ),
    );
  }).pipe(Effect.orDie);

  const updateSnapshot = Effect.fn("AgentDesktopTransfer.updateSnapshot")(function* (
    transferId: AgentDesktopTransferId,
    update: (snapshot: AgentDesktopTransfer) => AgentDesktopTransfer,
  ) {
    const completed = yield* Ref.modify(state, (current) => {
      const record = current.transfers.get(transferId);
      if (record === undefined || isTerminalState(record.snapshot.state)) {
        return [null, current] as const;
      }
      const snapshot = update(record.snapshot);
      const transfers = new Map(current.transfers);
      transfers.set(transferId, { ...record, snapshot });
      return [
        isTerminalState(snapshot.state) ? { deferred: record.completion, snapshot } : null,
        {
          ...current,
          transfers,
        },
      ] as const;
    });
    if (completed !== null) yield* Deferred.succeed(completed.deferred, completed.snapshot);
  });

  const setProgress = Effect.fn("AgentDesktopTransfer.setProgress")(function* (
    transferId: AgentDesktopTransferId,
    transferredBytes: number,
    totalBytes?: number,
  ) {
    const updatedAt = isoTime(yield* Clock.currentTimeMillis);
    yield* updateSnapshot(transferId, (snapshot) => ({
      ...snapshot,
      transferredBytes: Math.max(snapshot.transferredBytes, transferredBytes),
      totalBytes: totalBytes ?? snapshot.totalBytes,
      updatedAt,
    }));
  });

  const setPhase = Effect.fn("AgentDesktopTransfer.setPhase")(function* (
    transferId: AgentDesktopTransferId,
    phase: TransferPhase,
    fields: Partial<
      Pick<AgentDesktopTransfer, "compression" | "sha256" | "totalBytes" | "tree">
    > = {},
  ) {
    const updatedAt = isoTime(yield* Clock.currentTimeMillis);
    yield* updateSnapshot(transferId, (snapshot) => ({
      ...snapshot,
      state: phase,
      ...fields,
      updatedAt,
    }));
  });

  const finish = Effect.fn("AgentDesktopTransfer.finish")(function* (
    transferId: AgentDesktopTransferId,
    stateValue: TerminalTransferState,
    fields: Partial<
      Pick<
        AgentDesktopTransfer,
        | "compression"
        | "sha256"
        | "totalBytes"
        | "transferredBytes"
        | "tree"
        | "error"
        | "source"
        | "destination"
      >
    > = {},
  ) {
    const completedAt = isoTime(yield* Clock.currentTimeMillis);
    yield* updateSnapshot(transferId, (snapshot) => ({
      ...snapshot,
      state: stateValue,
      ...fields,
      updatedAt: completedAt,
      completedAt,
    }));
  });

  const requireOwnedRecord = Effect.fn("AgentDesktopTransfer.requireOwnedRecord")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    transferId: AgentDesktopTransferId,
  ) {
    const record = (yield* Ref.get(state)).transfers.get(transferId);
    if (record === undefined || !ownersMatch(record.owner, ownerFromScope(scope))) {
      return yield* new AgentDesktopTransferLookupError({
        transferId,
        detail: "the transfer does not exist for this agent session",
      });
    }
    return record;
  });

  const waitForSnapshot = Effect.fn("AgentDesktopTransfer.waitForSnapshot")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: AgentDesktopTransferTargetInput,
    defaultWaitMs = 0,
  ) {
    const record = yield* requireOwnedRecord(scope, input.transferId);
    const waitMs = input.waitMs ?? defaultWaitMs;
    if (!isTerminalState(record.snapshot.state) && waitMs > 0) {
      yield* Deferred.await(record.completion).pipe(Effect.timeoutOption(waitMs));
    }
    return (yield* requireOwnedRecord(scope, input.transferId)).snapshot;
  });

  const resolveWorkspaceRoot = Effect.fn("AgentDesktopTransfer.resolveWorkspaceRoot")(function* (
    scope: McpInvocationContext.McpInvocationScope,
  ) {
    const projections = yield* ProjectionSnapshotQuery;
    const shell = yield* projections
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError((cause) => processError("preparing", cause, "invalid-source")));
    if (Option.isNone(shell)) {
      return yield* new TransferProcessError({
        code: "invalid-source",
        phase: "preparing",
        detail: "the transfer thread is unavailable",
      });
    }
    const project = yield* projections
      .getProjectShellById(shell.value.projectId)
      .pipe(Effect.mapError((cause) => processError("preparing", cause, "invalid-source")));
    if (Option.isNone(project)) {
      return yield* new TransferProcessError({
        code: "invalid-source",
        phase: "preparing",
        detail: "the transfer project is unavailable",
      });
    }
    return shell.value.worktreePath ?? project.value.workspaceRoot;
  });

  const resolveWorkspacePath = Effect.fn("AgentDesktopTransfer.resolveWorkspacePath")(
    function* (input: {
      readonly root: string;
      readonly relativePath: string;
      readonly source: boolean;
    }) {
      const relativePath = input.relativePath.trim();
      if (NodePath.isAbsolute(relativePath) || relativePath.includes("\0")) {
        return yield* new TransferProcessError({
          code: input.source ? "invalid-source" : "invalid-destination",
          phase: "preparing",
          detail: "workspace transfer paths must be relative to the current thread workspace",
        });
      }
      const root = NodePath.resolve(input.root);
      const candidate = NodePath.resolve(root, relativePath);
      if (!pathIsWithin(root, candidate) || (!input.source && candidate === root)) {
        return yield* new TransferProcessError({
          code: input.source ? "invalid-source" : "invalid-destination",
          phase: "preparing",
          detail: input.source
            ? "the source path escapes the current thread workspace"
            : "the destination must be a child of the current thread workspace",
        });
      }
      const canonicalRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(root),
        catch: (cause) => processError("preparing", cause, "invalid-source"),
      });
      if (input.source) {
        const canonicalCandidate = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(candidate),
          catch: (cause) => processError("preparing", cause, "source-unavailable"),
        });
        if (!pathIsWithin(canonicalRoot, canonicalCandidate)) {
          return yield* new TransferProcessError({
            code: "invalid-source",
            phase: "preparing",
            detail: "the source resolves outside the current thread workspace",
          });
        }
        return candidate;
      }
      let ancestor = NodePath.dirname(candidate);
      while (true) {
        const info = yield* Effect.tryPromise({
          try: () => NodeFSP.lstat(ancestor),
          catch: () => null,
        });
        if (info !== null) break;
        const parent = NodePath.dirname(ancestor);
        if (parent === ancestor) {
          return yield* new TransferProcessError({
            code: "invalid-destination",
            phase: "preparing",
            detail: "no existing destination ancestor is available",
          });
        }
        ancestor = parent;
      }
      const canonicalAncestor = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(ancestor),
        catch: (cause) => processError("preparing", cause, "invalid-destination"),
      });
      if (!pathIsWithin(canonicalRoot, canonicalAncestor)) {
        return yield* new TransferProcessError({
          code: "invalid-destination",
          phase: "preparing",
          detail: "the destination resolves outside the current thread workspace",
        });
      }
      return candidate;
    },
  );

  const transferToAgent = Effect.fn("AgentDesktopTransfer.toAgent")(function* (
    record: TransferRecord,
    input: AgentDesktopCopyInput,
  ) {
    if (input.source.kind !== "workspace" || input.destination.kind !== "agent") {
      return yield* new TransferProcessError({
        code: "invalid-source",
        phase: "preparing",
        detail: "invalid workspace-to-Agent-desktop transfer direction",
      });
    }
    yield* setPhase(record.snapshot.id, "preparing");
    const workspaceRoot = yield* resolveWorkspaceRoot(record.scope);
    const sourcePath = yield* resolveWorkspacePath({
      root: workspaceRoot,
      relativePath: input.source.path,
      source: true,
    });
    const packed = yield* Effect.tryPromise({
      try: (signal) =>
        packAgentDesktopBundle({
          sourcePath,
          outputPath: record.archivePath,
          compression: input.compression ?? "auto",
          signal,
        }),
      catch: (cause) => processError("preparing", cause, "source-unavailable"),
    });
    yield* setPhase(record.snapshot.id, "transferring", {
      compression: packed.compression,
      sha256: packed.sha256,
      totalBytes: packed.wireBytes,
      tree: transferTree(packed),
    });
    const result = yield* manager
      .transfer(
        {
          environmentId: record.scope.environmentId,
          threadId: record.scope.threadId,
          controllerId: record.scope.providerSessionId,
        },
        {
          operation: "import",
          transferId: record.snapshot.id,
          ...(input.destination.desktopId === undefined
            ? {}
            : { desktopId: input.destination.desktopId }),
          archivePath: record.archivePath,
          guestPath: input.destination.path,
          collision: input.collision ?? "create",
          compression: packed.compression,
          sizeBytes: packed.wireBytes,
          sha256: packed.sha256,
          onProgress: (transferredBytes, totalBytes) =>
            setProgress(record.snapshot.id, transferredBytes, totalBytes),
        },
      )
      .pipe(Effect.mapError((cause) => processError("transferring", cause, "transport-failed")));
    yield* setPhase(record.snapshot.id, "verifying");
    if (
      result.transferId !== record.snapshot.id ||
      result.wireBytes !== packed.wireBytes ||
      result.sha256 !== packed.sha256 ||
      result.compression !== packed.compression ||
      (input.destination.desktopId !== undefined &&
        result.desktopId !== input.destination.desktopId) ||
      !treesMatch(result.tree, packed)
    ) {
      return yield* new TransferProcessError({
        code: "integrity-failed",
        phase: "verifying",
        detail: "the Agent desktop reported different bundle metadata after import",
      });
    }
    yield* finish(record.snapshot.id, "completed", {
      compression: packed.compression,
      sha256: packed.sha256,
      totalBytes: packed.wireBytes,
      transferredBytes: packed.wireBytes,
      tree: result.tree,
      destination: { ...input.destination, desktopId: result.desktopId },
      error: null,
    });
  });

  const transferFromAgent = Effect.fn("AgentDesktopTransfer.fromAgent")(function* (
    record: TransferRecord,
    input: AgentDesktopCopyInput,
  ) {
    if (input.source.kind !== "agent" || input.destination.kind !== "workspace") {
      return yield* new TransferProcessError({
        code: "invalid-source",
        phase: "preparing",
        detail: "invalid Agent-desktop-to-workspace transfer direction",
      });
    }
    yield* setPhase(record.snapshot.id, "preparing");
    const workspaceRoot = yield* resolveWorkspaceRoot(record.scope);
    const destinationPath = yield* resolveWorkspacePath({
      root: workspaceRoot,
      relativePath: input.destination.path,
      source: false,
    });
    yield* Effect.tryPromise({
      try: () =>
        NodeFSP.mkdir(NodePath.dirname(record.archivePath), { recursive: true, mode: 0o700 }),
      catch: (cause) => processError("preparing", cause, "internal-error"),
    });
    yield* setPhase(record.snapshot.id, "transferring");
    const result = yield* manager
      .transfer(
        {
          environmentId: record.scope.environmentId,
          threadId: record.scope.threadId,
          controllerId: record.scope.providerSessionId,
        },
        {
          operation: "export",
          transferId: record.snapshot.id,
          ...(input.source.desktopId === undefined ? {} : { desktopId: input.source.desktopId }),
          archivePath: record.archivePath,
          guestPath: input.source.path,
          compression: input.compression ?? "auto",
          onProgress: (transferredBytes, totalBytes) =>
            setProgress(record.snapshot.id, transferredBytes, totalBytes),
        },
      )
      .pipe(Effect.mapError((cause) => processError("transferring", cause, "transport-failed")));
    if (
      result.transferId !== record.snapshot.id ||
      (input.source.desktopId !== undefined && result.desktopId !== input.source.desktopId)
    ) {
      return yield* new TransferProcessError({
        code: "integrity-failed",
        phase: "verifying",
        detail: "the Agent desktop reported a different transfer or desktop identity",
      });
    }
    yield* setPhase(record.snapshot.id, "verifying", {
      compression: result.compression,
      sha256: result.sha256,
      totalBytes: result.wireBytes,
      tree: result.tree,
    });
    const archiveSize = yield* Effect.tryPromise({
      try: async () => (await NodeFSP.stat(record.archivePath)).size,
      catch: (cause) => processError("verifying", cause, "integrity-failed"),
    });
    if (archiveSize !== result.wireBytes) {
      return yield* new TransferProcessError({
        code: "integrity-failed",
        phase: "verifying",
        detail: "the exported bundle length did not match the Agent desktop result",
      });
    }
    const digest = yield* Effect.tryPromise({
      try: (signal) => sha256AgentDesktopBundle(record.archivePath, signal),
      catch: (cause) => processError("verifying", cause, "integrity-failed"),
    });
    if (digest !== result.sha256) {
      return yield* new TransferProcessError({
        code: "integrity-failed",
        phase: "verifying",
        detail: "the exported bundle SHA-256 did not match the Agent desktop result",
      });
    }
    yield* setPhase(record.snapshot.id, "installing");
    const extracted = yield* Effect.tryPromise({
      try: (signal) =>
        extractAgentDesktopBundle({
          archivePath: record.archivePath,
          destinationPath,
          compression: result.compression,
          collision: input.collision ?? "create",
          signal,
        }),
      catch: (cause) => processError("installing", cause, "invalid-destination"),
    });
    yield* finish(record.snapshot.id, "completed", {
      compression: result.compression,
      sha256: result.sha256,
      totalBytes: result.wireBytes,
      transferredBytes: result.wireBytes,
      tree: transferTree(extracted),
      source: { ...input.source, desktopId: result.desktopId },
      error: null,
    });
  });

  const cleanupTransfer = Effect.fn("AgentDesktopTransfer.cleanup")(function* (
    transferId: AgentDesktopTransferId,
  ) {
    const archivePath = (yield* Ref.get(state)).transfers.get(transferId)?.archivePath ?? null;
    if (archivePath !== null) {
      yield* Effect.promise(() => NodeFSP.rm(archivePath, { force: true }).catch(() => undefined));
    }
  });

  const runTransfer = Effect.fn("AgentDesktopTransfer.run")(function* (
    record: TransferRecord,
    input: AgentDesktopCopyInput,
  ) {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const operation =
      record.snapshot.direction === "to-agent"
        ? transferToAgent(record, input)
        : transferFromAgent(record, input);
    yield* operation.pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError((cause) =>
        processError(
          "transferring",
          cause,
          typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "TimeoutError"
            ? "timed-out"
            : "transport-failed",
        ),
      ),
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasInterrupts(cause)
            ? finish(record.snapshot.id, "cancelled", {
                error: {
                  code: "cancelled",
                  phase: "transferring",
                  detail: "the transfer was cancelled",
                },
              })
            : (() => {
                const failure = failureFromCause(cause);
                return finish(record.snapshot.id, "failed", {
                  error: {
                    code: failure.code,
                    phase: failure.phase,
                    detail: failure.detail,
                  },
                });
              })(),
        onSuccess: () => Effect.void,
      }),
      Effect.ensuring(cleanupTransfer(record.snapshot.id)),
    );
  });

  const prune = Effect.fn("AgentDesktopTransfer.prune")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(state, (current) => {
      const entries = Array.from(current.transfers.entries());
      const active = entries.filter(([, record]) => !isTerminalState(record.snapshot.state));
      const retainedTerminal = entries
        .filter(([, record]) => {
          if (!isTerminalState(record.snapshot.state)) return false;
          const completedAt = epochMilliseconds(
            record.snapshot.completedAt ?? record.snapshot.updatedAt,
          );
          return completedAt !== null && now - completedAt < TRANSFER_RETENTION_MS;
        })
        .sort((left, right) =>
          right[1].snapshot.updatedAt.localeCompare(left[1].snapshot.updatedAt),
        )
        .slice(0, MAX_RETAINED_TRANSFERS);
      const transfers = new Map([...active, ...retainedTerminal]);
      return { transfers };
    });
  });

  const start: AgentDesktopTransferServiceShape["start"] = (scope, input) =>
    Effect.gen(function* () {
      yield* prune();
      const owner = ownerFromScope(scope);
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const transferId = `transfer-${uuid.replaceAll("-", "")}` as AgentDesktopTransferId;
      const now = isoTime(yield* Clock.currentTimeMillis);
      const completion = yield* Deferred.make<AgentDesktopTransfer>();
      const reserved = yield* Ref.modify(state, (stateValue) => {
        const activeCount = Array.from(stateValue.transfers.values()).filter(
          (record) => ownersMatch(record.owner, owner) && !isTerminalState(record.snapshot.state),
        ).length;
        const admitted = activeCount < MAX_ACTIVE_TRANSFERS_PER_CONTROLLER;
        const snapshot: AgentDesktopTransfer = {
          id: transferId,
          state: admitted ? "queued" : "failed",
          direction: input.source.kind === "workspace" ? "to-agent" : "from-agent",
          source: input.source,
          destination: input.destination,
          collision: input.collision ?? "create",
          compression: null,
          transferredBytes: 0,
          totalBytes: null,
          tree: null,
          sha256: null,
          startedAt: now,
          updatedAt: now,
          completedAt: admitted ? null : now,
          error: admitted
            ? null
            : {
                code: "resource-exhausted",
                phase: "queued",
                detail: `this controller already has ${MAX_ACTIVE_TRANSFERS_PER_CONTROLLER} active transfers`,
              },
        };
        const record: TransferRecord = {
          owner,
          scope,
          snapshot,
          completion,
          fiber: null,
          archivePath: NodePath.join(transferDirectory, `${transferId}.bundle`),
        };
        const transfers = new Map(stateValue.transfers);
        transfers.set(transferId, record);
        return [
          { admitted, record },
          { ...stateValue, transfers },
        ] as const;
      });
      if (!reserved.admitted) {
        yield* Deferred.succeed(completion, reserved.record.snapshot);
        return reserved.record.snapshot;
      }
      const record = reserved.record;
      const fiber = yield* runTransfer(record, input).pipe(Effect.forkDetach);
      yield* Ref.update(state, (stateValue) => {
        const currentRecord = stateValue.transfers.get(transferId);
        if (currentRecord === undefined) return stateValue;
        const transfers = new Map(stateValue.transfers);
        transfers.set(transferId, { ...currentRecord, fiber });
        return { ...stateValue, transfers };
      });
      return yield* waitForSnapshot(
        scope,
        { transferId, waitMs: input.waitMs ?? DEFAULT_WAIT_MS },
        DEFAULT_WAIT_MS,
      );
    });

  const status: AgentDesktopTransferServiceShape["status"] = (scope, input) =>
    waitForSnapshot(scope, input);

  const cancel: AgentDesktopTransferServiceShape["cancel"] = (scope, input) =>
    Effect.gen(function* () {
      const record = yield* requireOwnedRecord(scope, input.transferId);
      if (isTerminalState(record.snapshot.state)) return record.snapshot;
      const agentEndpoint =
        record.snapshot.source.kind === "agent"
          ? record.snapshot.source
          : record.snapshot.destination.kind === "agent"
            ? record.snapshot.destination
            : null;
      yield* manager
        .cancelTransfer(
          {
            environmentId: scope.environmentId,
            threadId: scope.threadId,
            controllerId: scope.providerSessionId,
          },
          {
            transferId: input.transferId,
            ...(agentEndpoint?.desktopId === undefined
              ? {}
              : { desktopId: agentEndpoint.desktopId }),
          },
        )
        .pipe(Effect.ignore);
      if (record.fiber !== null) yield* Fiber.interrupt(record.fiber);
      yield* finish(input.transferId, "cancelled", {
        error: {
          code: "cancelled",
          phase: isTerminalState(record.snapshot.state) ? "transferring" : record.snapshot.state,
          detail: "the transfer was cancelled",
        },
      });
      return (yield* requireOwnedRecord(scope, input.transferId)).snapshot;
    });

  return AgentDesktopTransferService.of({ start, status, cancel });
});

export interface AgentDesktopTransferServiceShape {
  readonly start: (
    scope: McpInvocationContext.McpInvocationScope,
    input: AgentDesktopCopyInput,
  ) => Effect.Effect<
    AgentDesktopTransfer,
    AgentDesktopTransferLookupError,
    ProjectionSnapshotQuery
  >;
  readonly status: (
    scope: McpInvocationContext.McpInvocationScope,
    input: AgentDesktopTransferTargetInput,
  ) => Effect.Effect<AgentDesktopTransfer, AgentDesktopTransferLookupError>;
  readonly cancel: (
    scope: McpInvocationContext.McpInvocationScope,
    input: AgentDesktopTransferTargetInput,
  ) => Effect.Effect<AgentDesktopTransfer, AgentDesktopTransferLookupError>;
}

/** Provides one shared Agent desktop transfer registry. */
export class AgentDesktopTransferService extends Context.Service<
  AgentDesktopTransferService,
  AgentDesktopTransferServiceShape
>()("t3/agentDesktop/AgentDesktopTransferService") {}

export const layer = Layer.effect(AgentDesktopTransferService, make);

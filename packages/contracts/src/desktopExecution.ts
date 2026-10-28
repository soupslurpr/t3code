import type { DesktopProcessActivity } from "./desktopProcessActivity.ts";
/** Defines desktop command execution independently of graphical access. */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { UserDesktopTarget } from "./userDesktop.ts";
import {
  DesktopCapabilityGrant,
  DesktopGrantLifetime,
  DesktopGrantScope,
  DesktopGrantPolicy,
  DesktopPermissionSource,
} from "./desktopAuthorization.ts";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_WAIT_MS = 30_000;
const Identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Path = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(32_768),
  Schema.isPattern(/^[^\0]*$/),
);
const Argument = Schema.String.check(
  Schema.isMaxLength(MAX_INPUT_BYTES),
  Schema.isPattern(/^[^\0]*$/),
);
const DurationMs = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }));
const WaitMs = Schema.optional(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_MS })),
);
const Encoding = Schema.Literals(["utf8", "base64"]);
const TerminalSize = Schema.Struct({
  columns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
});
const OutputRead = {
  stdoutOffset: Schema.optional(NonNegativeInt),
  stderrOffset: Schema.optional(NonNegativeInt),
  maxBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: MAX_READ_BYTES })),
  ),
  encoding: Schema.optional(Encoding),
};

/** Starts a general process; commandId makes retries within an environment idempotent. */
export const UserDesktopCommandInput = Schema.Struct({
  desktop: UserDesktopTarget,
  commandId: Identifier,
  executable: Path,
  arguments: Schema.optional(Schema.Array(Argument)),
  workingDirectory: Schema.optional(Path).annotate({
    description:
      "Absolute path or path relative to the desktop account's home directory; defaults to that home directory.",
  }),
  environment: Schema.optional(
    Schema.Record(
      Schema.String.check(Schema.isNonEmpty(), Schema.isPattern(/^[^=\0]+$/)),
      Schema.NullOr(Argument),
    ),
  ),
  inheritEnvironment: Schema.optional(Schema.Boolean),
  terminal: Schema.optional(Schema.Union([Schema.Boolean, TerminalSize])),
  stdin: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_INPUT_BYTES))),
  stdinEncoding: Schema.optional(Encoding),
  keepStdinOpen: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(Schema.NullOr(DurationMs)),
  maxStoredOutputBytes: Schema.optional(Schema.NullOr(NonNegativeInt)),
  waitMs: WaitMs,
  ...OutputRead,
});
export type UserDesktopCommandInput = typeof UserDesktopCommandInput.Type;

/** Inspects or controls a continuing process without taking graphical control. */
export const UserDesktopProcessInput = Schema.Struct({
  desktop: UserDesktopTarget,
  action: Schema.Literals(["list", "read", "write", "signal", "resize", "forget"]),
  processId: Schema.optional(Identifier),
  threadId: Schema.optional(ThreadId),
  grantId: Schema.optional(Identifier),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optional(Identifier),
  data: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_INPUT_BYTES))),
  close: Schema.optional(Schema.Boolean),
  signal: Schema.optional(Identifier),
  columns: Schema.optional(TerminalSize.fields.columns),
  rows: Schema.optional(TerminalSize.fields.rows),
  waitMs: WaitMs,
  ...OutputRead,
}).check(
  Schema.makeFilter((input) => {
    if (input.action !== "list" && input.processId === undefined)
      return "processId is required for this action";
    if (input.action === "resize" && (input.columns === undefined || input.rows === undefined))
      return "columns and rows are required for resize";
    return true;
  }),
);
export type UserDesktopProcessInput = typeof UserDesktopProcessInput.Type;

/** Describes the scope of a locally approved execution grant. */
export const DesktopExecutionScope = DesktopGrantScope;
export type DesktopExecutionScope = typeof DesktopExecutionScope.Type;

/** Requests, inspects, or revokes execution permission on the selected desktop. */
export const UserDesktopExecutionAccessInput = Schema.Struct({
  action: Schema.Literals(["status", "request", "edit", "approve", "deny", "revoke"]),
  desktop: UserDesktopTarget,
  scope: Schema.optional(DesktopExecutionScope),
  durationMs: Schema.optional(DurationMs),
  lifetime: Schema.optional(DesktopGrantLifetime),
  deadline: Schema.optional(IsoDateTime),
  remembered: Schema.optional(Schema.Boolean),
  grantId: Schema.optional(Identifier),
  revision: Schema.optional(NonNegativeInt),
  requestId: Schema.optional(Identifier),
  stopProcesses: Schema.optional(Schema.Boolean),
  localPrompt: Schema.optional(Schema.Boolean).annotate({
    description:
      "Always ask the human at the destination desktop; required for all-environments administration.",
  }),
});
export type UserDesktopExecutionAccessInput = typeof UserDesktopExecutionAccessInput.Type;

/** A previously authorized wait can release only this terminal metadata. */
export const DesktopProcessCompletionReceipt = Schema.Struct({
  processId: Identifier,
  runtimeGeneration: Identifier,
  status: Schema.Literals([
    "exited",
    "failed",
    "lost",
    "permission-revoked",
    "deleted",
    "unavailable",
  ]),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  completedAt: IsoDateTime,
});
export type DesktopProcessCompletionReceipt = typeof DesktopProcessCompletionReceipt.Type;
export const UserDesktopCompletionInput = Schema.Struct({
  desktop: UserDesktopTarget,
  action: Schema.Literals(["register", "status", "cancel", "acknowledge"]),
  waitId: Identifier,
  processId: Identifier,
  runtimeGeneration: Identifier,
});
export type UserDesktopCompletionInput = typeof UserDesktopCompletionInput.Type;
export const DesktopProcessCompletionResult = Schema.Struct({
  kind: Schema.Literal("completion"),
  protocolVersion: Schema.Literal(2),
  desktop: UserDesktopTarget,
  waitId: Identifier,
  receipt: Schema.NullOr(DesktopProcessCompletionReceipt),
});
export type DesktopProcessCompletionResult = typeof DesktopProcessCompletionResult.Type;

/** Carries the complete execution operation through a desktop host connection. */
export const UserDesktopExecutionInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("completion"),
    desktop: UserDesktopTarget,
    input: UserDesktopCompletionInput,
  }),
  Schema.Struct({ operation: Schema.Literal("cancel"), desktop: UserDesktopTarget }),
  Schema.Struct({ operation: Schema.Literal("command"), ...UserDesktopCommandInput.fields }),
  Schema.Struct({
    operation: Schema.Literal("process"),
    input: UserDesktopProcessInput,
    desktop: UserDesktopTarget,
  }),
  Schema.Struct({
    operation: Schema.Literal("access"),
    input: UserDesktopExecutionAccessInput,
    desktop: UserDesktopTarget,
  }),
]);
export type UserDesktopExecutionInput = typeof UserDesktopExecutionInput.Type;

/** Describes one process and the exact host files containing its captured output. */
export const DesktopProcess = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  threadId: Schema.optional(ThreadId),
  runtimeGeneration: Schema.optional(Identifier),
  statusRevision: Schema.optional(NonNegativeInt),
  grantId: Schema.optional(Identifier),
  grantRevision: Schema.optional(NonNegativeInt),
  processId: Identifier,
  commandId: Identifier,
  executable: Schema.String,
  arguments: Schema.Array(Schema.String),
  workingDirectory: Schema.String,
  user: Schema.String,
  terminal: Schema.Boolean,
  pid: Schema.NullOr(NonNegativeInt),
  status: Schema.Literals([
    "starting",
    "running",
    "stopping",
    "unknown",
    "exited",
    "failed",
    "lost",
  ]),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timeoutMs: Schema.optional(Schema.NullOr(DurationMs)),
  timedOut: Schema.Boolean,
  stdinClosed: Schema.Boolean,
  stdoutPath: Schema.String,
  stderrPath: Schema.String,
  outputError: Schema.NullOr(Schema.String),
});
export type DesktopProcess = typeof DesktopProcess.Type;

/** Uncertain scopes still own resources until their termination is established. */
export const isDesktopProcessLive = (process: Pick<DesktopProcess, "status">) =>
  process.status === "starting" ||
  process.status === "running" ||
  process.status === "stopping" ||
  process.status === "unknown";

/** Returns a byte range with an explicit continuation offset and retention limits. */
export const DesktopProcessOutput = Schema.Struct({
  data: Schema.String,
  encoding: Encoding,
  offset: NonNegativeInt,
  nextOffset: NonNegativeInt,
  totalBytes: NonNegativeInt,
  storedBytes: NonNegativeInt,
  tailOffset: Schema.optional(NonNegativeInt),
  retainedEnd: Schema.optional(NonNegativeInt),
  truncated: Schema.Boolean,
  invalidUtf8: Schema.Boolean,
});
export type DesktopProcessOutput = typeof DesktopProcessOutput.Type;

/** Returns process status and independently addressable stdout and stderr. */
export const DesktopProcessResult = Schema.Struct({
  kind: Schema.Literal("process"),
  desktop: UserDesktopTarget,
  process: DesktopProcess,
  stdout: DesktopProcessOutput,
  stderr: DesktopProcessOutput,
});
export type DesktopProcessResult = typeof DesktopProcessResult.Type;

/** Records execution permission chosen in a local native confirmation. */
export const DesktopExecutionGrant = DesktopCapabilityGrant;
export type DesktopExecutionGrant = typeof DesktopExecutionGrant.Type;

export const DesktopExecutionPendingApproval = Schema.Struct({
  source: Schema.optional(DesktopPermissionSource),
  requestId: Identifier,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  desktop: UserDesktopTarget,
  expiresAt: IsoDateTime,
  proposedPolicy: DesktopGrantPolicy,
});
export type DesktopExecutionPendingApproval = typeof DesktopExecutionPendingApproval.Type;

/** Reports execution access without capturing or sharing the desktop. */
export const DesktopExecutionAccess = Schema.Struct({
  kind: Schema.Literal("access"),
  desktop: UserDesktopTarget,
  user: Schema.String,
  homeDirectory: Schema.String,
  platform: Schema.String,
  granted: Schema.Boolean,
  protocolVersion: Schema.optional(Schema.Literal(2)),
  selectedGrantId: Schema.optional(Schema.NullOr(Identifier)),
  pendingRequests: Schema.optional(Schema.Array(DesktopExecutionPendingApproval)),
  activeTransfers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        transferId: Identifier,
        grantId: Identifier,
        environmentId: EnvironmentId,
        threadId: ThreadId,
      }),
    ),
  ),
  remoteApprovalAvailable: Schema.optional(Schema.Boolean),
  grants: Schema.Array(DesktopExecutionGrant),
});
export type DesktopExecutionAccess = typeof DesktopExecutionAccess.Type;

/** Uses the target's latest unexpired-grant snapshot for input availability.
 * The destination still rechecks permission when accepting each operation.
 */
export const hasDesktopProcessInputGrant = (
  access: Pick<DesktopExecutionAccess, "grants"> | null,
  process: Pick<DesktopProcess, "environmentId" | "threadId">,
) =>
  process.environmentId !== undefined &&
  process.threadId !== undefined &&
  (access?.grants.some(
    (grant) =>
      grant.capability === "execution" &&
      !grant.suspended &&
      (grant.scope === "desktop" ||
        (grant.environmentId === process.environmentId &&
          (grant.scope === "environment" || grant.threadId === process.threadId))),
  ) ??
    false);

/** Returns the processes visible to the requesting environment. */
export const DesktopProcessList = Schema.Struct({
  kind: Schema.Literal("list"),
  desktop: UserDesktopTarget,
  processes: Schema.Array(DesktopProcess),
  nextCursor: Schema.optional(Schema.NullOr(Identifier)),
});
export type DesktopProcessList = typeof DesktopProcessList.Type;

/** Returns the result of a host execution operation. */
export const DesktopProcessAccepted = Schema.Struct({
  kind: Schema.Literal("permission-required"),
  desktop: UserDesktopTarget,
  processId: Identifier,
  commandId: Identifier,
  runtimeGeneration: Identifier,
  status: DesktopProcess.fields.status,
});
export type DesktopProcessAccepted = typeof DesktopProcessAccepted.Type;

const MaxOutputTokens = Schema.optional(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
).annotate({
  description:
    "Approximate combined stdout/stderr budget, default 10000 (four UTF-8 bytes per token). Metadata and omission notices are additional. Defaults to a beginning/end preview; explicit offsets, maxBytes, or base64 request sequential output pages.",
});

/** Agent presentation options stay outside the desktop execution protocol. */
export const UserDesktopCommandToolInput = UserDesktopCommandInput.mapFields((fields) => ({
  ...fields,
  maxStoredOutputBytes: fields.maxStoredOutputBytes.annotate({
    description:
      "Per-stream storage cap. Omitted/null keeps complete logs subject to the disk-space guard; a number retains the beginning and latest tail. Independent of returned output size.",
  }),
  maxOutputTokens: MaxOutputTokens,
}));
export type UserDesktopCommandToolInput = typeof UserDesktopCommandToolInput.Type;
export const UserDesktopProcessToolInput = UserDesktopProcessInput.mapFields(
  (fields) => ({ ...fields, maxOutputTokens: MaxOutputTokens }),
  // Adding an output budget leaves the action/processId/resize checks valid.
  { unsafePreserveChecks: true },
);
export type UserDesktopProcessToolInput = typeof UserDesktopProcessToolInput.Type;

const DesktopToolOutputCursor = Schema.Struct({
  offset: NonNegativeInt,
  nextOffset: NonNegativeInt,
  totalBytes: NonNegativeInt,
  tailOffset: Schema.optional(NonNegativeInt),
  tailEnd: Schema.optional(NonNegativeInt),
  truncated: Schema.optional(Schema.Literal(true)),
  storedBytes: Schema.optional(NonNegativeInt),
  retainedTailOffset: Schema.optional(NonNegativeInt),
  retainedEnd: Schema.optional(NonNegativeInt),
});

/** Compact agent results retain only state needed to act on or recover output. */
export const UserDesktopToolProcessResult = Schema.Struct({
  processId: Identifier,
  status: DesktopProcess.fields.status,
  exitCode: DesktopProcess.fields.exitCode,
  pid: Schema.optional(NonNegativeInt),
  terminal: Schema.optional(Schema.Literal(true)),
  runtimeGeneration: Schema.optional(Identifier),
  signal: Schema.optional(Schema.String),
  timedOut: Schema.optional(Schema.Literal(true)),
  stdinClosed: Schema.optional(Schema.Literal(true)),
  outputError: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  stdoutPath: Schema.optional(Schema.String),
  stderrPath: Schema.optional(Schema.String),
  encoding: Schema.optional(Schema.Literal("base64")),
  invalidUtf8: Schema.optional(Schema.Array(Schema.Literals(["stdout", "stderr"]))),
  tailUnavailable: Schema.optional(Schema.Literal(true)),
  cursor: Schema.optional(
    Schema.Struct({
      stdout: Schema.optional(DesktopToolOutputCursor),
      stderr: Schema.optional(DesktopToolOutputCursor),
    }),
  ),
});
export type UserDesktopToolProcessResult = typeof UserDesktopToolProcessResult.Type;

export const UserDesktopToolProcessAccepted = DesktopProcessAccepted.mapFields(
  ({ desktop: _desktop, commandId: _commandId, ...fields }) => fields,
);
export const UserDesktopToolProcessList = Schema.Struct({
  processes: Schema.Array(
    Schema.Struct({
      ...UserDesktopToolProcessResult.mapFields(
        ({
          processId,
          status,
          exitCode,
          pid,
          terminal,
          stdinClosed,
          runtimeGeneration,
          signal,
          timedOut,
          outputError,
        }) => ({
          processId,
          status,
          exitCode,
          pid,
          terminal,
          stdinClosed,
          runtimeGeneration,
          signal,
          timedOut,
          outputError,
        }),
      ).fields,
      commandId: Identifier,
      executable: Schema.String,
      arguments: Schema.Array(Schema.String),
      workingDirectory: Schema.String,
      startedAt: IsoDateTime,
      completedAt: Schema.optional(IsoDateTime),
      grantId: DesktopProcess.fields.grantId,
      timeoutMs: Schema.optional(DurationMs),
    }),
  ),
  nextCursor: Schema.optional(Identifier),
});
export type UserDesktopToolProcessList = typeof UserDesktopToolProcessList.Type;

export const UserDesktopExecutionResult = Schema.Union([
  DesktopProcessCompletionResult,
  DesktopProcessResult,
  DesktopProcessList,
  DesktopExecutionAccess,
  DesktopProcessAccepted,
]);
export type UserDesktopExecutionResult = typeof UserDesktopExecutionResult.Type;

/** A finite start/input or a terminal milestone, never a status-read heartbeat. */
export function desktopProcessActivity(
  desktop: DesktopProcessActivity["desktop"],
  process: DesktopProcess,
  phase: DesktopProcessActivity["phase"],
  inputId = "",
): DesktopProcessActivity | null {
  if (!process.environmentId || !process.threadId || !process.runtimeGeneration) return null;
  if (phase === "completed" ? isDesktopProcessLive(process) : process.timeoutMs == null)
    return null;
  return {
    activityId: `${process.runtimeGeneration}:${process.processId}:${phase}:${inputId}`,
    desktop,
    environmentId: process.environmentId,
    threadId: process.threadId,
    processId: process.processId,
    commandId: process.commandId,
    runtimeGeneration: process.runtimeGeneration,
    phase,
    status: process.status,
    exitCode: process.exitCode,
    signal: process.signal,
  };
}

/** Bounded lists retain exact owners. Cursors are process identities, never PIDs. */
export function desktopProcessPage(
  processes: readonly DesktopProcess[],
  input: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
) {
  const ordered = [...processes].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || b.processId.localeCompare(a.processId),
  );
  const after =
    input.cursor === undefined
      ? 0
      : ordered.findIndex((process) => process.processId === input.cursor) + 1;
  // A forgotten cursor is exhausted, rather than silently replaying the first page.
  if (input.cursor !== undefined && after === 0) return { processes: [], nextCursor: null };
  const page = ordered.slice(after, after + (input.limit ?? 50));
  return {
    processes: page,
    nextCursor: after + page.length < ordered.length ? page.at(-1)!.processId : null,
  };
}

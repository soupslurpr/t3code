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
export const DesktopExecutionScope = Schema.Literals(["thread", "environment", "desktop"]);
export type DesktopExecutionScope = typeof DesktopExecutionScope.Type;

/** Requests, inspects, or revokes execution permission on the selected desktop. */
export const UserDesktopExecutionAccessInput = Schema.Struct({
  action: Schema.Literals(["status", "request", "revoke"]),
  desktop: UserDesktopTarget,
  scope: Schema.optional(DesktopExecutionScope),
  durationMs: Schema.optional(DurationMs),
  grantId: Schema.optional(Identifier),
  stopProcesses: Schema.optional(Schema.Boolean),
});
export type UserDesktopExecutionAccessInput = typeof UserDesktopExecutionAccessInput.Type;

/** Carries the complete execution operation through a desktop host connection. */
export const UserDesktopExecutionInput = Schema.Union([
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
  processId: Identifier,
  commandId: Identifier,
  executable: Schema.String,
  arguments: Schema.Array(Schema.String),
  workingDirectory: Schema.String,
  user: Schema.String,
  terminal: Schema.Boolean,
  pid: Schema.NullOr(NonNegativeInt),
  status: Schema.Literals(["running", "exited", "failed"]),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  stdinClosed: Schema.Boolean,
  stdoutPath: Schema.String,
  stderrPath: Schema.String,
  outputError: Schema.NullOr(Schema.String),
});
export type DesktopProcess = typeof DesktopProcess.Type;

/** Returns a byte range with an explicit continuation offset and retention limits. */
export const DesktopProcessOutput = Schema.Struct({
  data: Schema.String,
  encoding: Encoding,
  offset: NonNegativeInt,
  nextOffset: NonNegativeInt,
  totalBytes: NonNegativeInt,
  storedBytes: NonNegativeInt,
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
export const DesktopExecutionGrant = Schema.Struct({
  grantId: Identifier,
  scope: DesktopExecutionScope,
  environmentId: Schema.NullOr(EnvironmentId),
  threadId: Schema.NullOr(ThreadId),
  remembered: Schema.Boolean,
  expiresAt: Schema.NullOr(IsoDateTime),
});
export type DesktopExecutionGrant = typeof DesktopExecutionGrant.Type;

/** Reports execution access without capturing or sharing the desktop. */
export const DesktopExecutionAccess = Schema.Struct({
  kind: Schema.Literal("access"),
  desktop: UserDesktopTarget,
  user: Schema.String,
  homeDirectory: Schema.String,
  platform: Schema.String,
  granted: Schema.Boolean,
  grants: Schema.Array(DesktopExecutionGrant),
});
export type DesktopExecutionAccess = typeof DesktopExecutionAccess.Type;

/** Returns the processes visible to the requesting environment. */
export const DesktopProcessList = Schema.Struct({
  kind: Schema.Literal("list"),
  desktop: UserDesktopTarget,
  processes: Schema.Array(DesktopProcess),
});
export type DesktopProcessList = typeof DesktopProcessList.Type;

/** Returns the result of a host execution operation. */
export const UserDesktopExecutionResult = Schema.Union([
  DesktopProcessResult,
  DesktopProcessList,
  DesktopExecutionAccess,
]);
export type UserDesktopExecutionResult = typeof UserDesktopExecutionResult.Type;

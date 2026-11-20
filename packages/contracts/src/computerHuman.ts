import { UserDesktopExecutionInput } from "./desktopExecution.ts";
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import {
  DesktopScreenPermissionRequest,
  isDesktopScreenPermissionRequest,
} from "./desktopAuthorization.ts";
import { ComputerAutomationLeaseId } from "./computerStatus.ts";
import { ComputerAutomationObservationOptions } from "./computerCaptureOptions.ts";
import { ComputerAutomationActionBatchInput } from "./computerActions.ts";
import { ComputerObservationId } from "./computerObservation.ts";
import { UserDesktopId, UserDesktopRenameInput, UserDesktopRemoveInput } from "./userDesktop.ts";

const UserDesktopHumanTarget = { desktopId: UserDesktopId };

/** Describes one authenticated human request for User desktop management and supervision. */
export const UserDesktopHumanRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("execution"), input: UserDesktopExecutionInput }),
  Schema.Struct({
    operation: Schema.Literal("screen-permission"),
    ...UserDesktopHumanTarget,
    ...DesktopScreenPermissionRequest.fields,
  }).check(Schema.makeFilter(isDesktopScreenPermissionRequest)),
  Schema.Struct({
    operation: Schema.Literal("list"),
    /** Opts into execution capabilities that older clients cannot decode. */
    includeExecution: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ operation: Schema.Literal("rename"), input: UserDesktopRenameInput }),
  Schema.Struct({ operation: Schema.Literal("remove"), input: UserDesktopRemoveInput }),
  Schema.Struct({ operation: Schema.Literal("status"), ...UserDesktopHumanTarget }),
  Schema.Struct({ operation: Schema.Literal("request-view"), ...UserDesktopHumanTarget }),
  Schema.Struct({
    operation: Schema.Literal("request-control"),
    ...UserDesktopHumanTarget,
    takeoverLeaseId: Schema.optional(ComputerAutomationLeaseId),
  }),
  Schema.Struct({ operation: Schema.Literal("return-control"), ...UserDesktopHumanTarget }),
  Schema.Struct({ operation: Schema.Literal("release-control"), ...UserDesktopHumanTarget }),
  Schema.Struct({
    operation: Schema.Literal("snapshot"),
    ...UserDesktopHumanTarget,
    input: ComputerAutomationObservationOptions,
  }),
  Schema.Struct({
    operation: Schema.Literal("act"),
    ...UserDesktopHumanTarget,
    input: ComputerAutomationActionBatchInput,
  }),
  Schema.Struct({ operation: Schema.Literal("remember-view"), ...UserDesktopHumanTarget }),
  Schema.Struct({ operation: Schema.Literal("remember-control"), ...UserDesktopHumanTarget }),
  Schema.Struct({ operation: Schema.Literal("release"), ...UserDesktopHumanTarget }),
  Schema.Struct({ operation: Schema.Literal("end-all-access"), ...UserDesktopHumanTarget }),
  Schema.Struct({ operation: Schema.Literal("forget"), ...UserDesktopHumanTarget }),
  Schema.Struct({ operation: Schema.Literal("audit"), ...UserDesktopHumanTarget }),
  Schema.Struct({ operation: Schema.Literal("observation-list"), ...UserDesktopHumanTarget }),
  Schema.Struct({
    operation: Schema.Literal("observation"),
    ...UserDesktopHumanTarget,
    observationId: ComputerObservationId,
  }),
]);
export type UserDesktopHumanRequest = typeof UserDesktopHumanRequest.Type;

/** Carries one User desktop management or supervision request through an environment server. */
export const UserDesktopHumanInvokeInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  request: UserDesktopHumanRequest,
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 })),
  ),
});
export type UserDesktopHumanInvokeInput = typeof UserDesktopHumanInvokeInput.Type;

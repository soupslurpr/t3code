import * as Schema from "effect/Schema";
import {
  ComputerAutomationAccessInput,
  ComputerAutomationActInput,
  ComputerAutomationAvailabilityInput,
  ComputerAutomationFailure,
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTargetInput,
} from "./computerAutomation.ts";
import {
  DesktopComputerAutomationContextSchema,
  type DesktopComputerAutomationContext,
} from "./desktopComputerContext.ts";

export const DesktopComputerAutomationAccessRequestSchema = Schema.Struct({
  input: ComputerAutomationAccessInput,
  context: Schema.optional(DesktopComputerAutomationContextSchema),
});

export const DesktopComputerAutomationAvailabilityRequestSchema = Schema.Struct({
  input: ComputerAutomationAvailabilityInput,
  context: Schema.optional(DesktopComputerAutomationContextSchema),
});

export const DesktopComputerAutomationTargetRequestSchema = Schema.Struct({
  input: ComputerAutomationTargetInput,
  context: Schema.optional(DesktopComputerAutomationContextSchema),
});

export const DesktopComputerAutomationSnapshotRequestSchema = Schema.Struct({
  input: ComputerAutomationSnapshotInput,
  context: Schema.optional(DesktopComputerAutomationContextSchema),
});

export const DesktopComputerAutomationActRequestSchema = Schema.Struct({
  input: ComputerAutomationActInput,
  context: Schema.optional(DesktopComputerAutomationContextSchema),
});

const DesktopComputerAutomationFailureSchema = Schema.Struct({
  ok: Schema.Literal(false),
  error: ComputerAutomationFailure,
});

export const makeDesktopComputerAutomationResultSchema = <Value extends Schema.Top>(value: Value) =>
  Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      value,
    }),
    DesktopComputerAutomationFailureSchema,
  ]);

export type DesktopComputerAutomationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly error: ComputerAutomationFailure;
    };

export interface DesktopComputerAutomationBridge {
  cancelPreparation?: (context: DesktopComputerAutomationContext) => Promise<void>;
  status: (
    input: ComputerAutomationTargetInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationStatus>>;
  requestAvailability: (
    input: ComputerAutomationAvailabilityInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationStatus>>;
  releaseAvailability: (
    input: ComputerAutomationAvailabilityInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationStatus>>;
  requestView: (
    input: ComputerAutomationAccessInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationObservation>>;
  requestControl: (
    input: ComputerAutomationAccessInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationObservation>>;
  rememberView: (
    input: ComputerAutomationAccessInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationObservation>>;
  rememberControl: (
    input: ComputerAutomationAccessInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationObservation>>;
  /** Cancels agent input and authorization while retaining existing viewing and availability. */
  interrupt?: (
    input: ComputerAutomationTargetInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationStatus>>;
  forceRelease: (
    input: ComputerAutomationTargetInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationStatus>>;
  forceForgetControl: (
    input: ComputerAutomationTargetInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<void>>;
  snapshot: (
    input: ComputerAutomationSnapshotInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationSnapshot>>;
  act: (
    input: ComputerAutomationActInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationObservation>>;
  release: (
    input: ComputerAutomationTargetInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<ComputerAutomationStatus>>;
  forgetControl: (
    input: ComputerAutomationTargetInput,
    context?: DesktopComputerAutomationContext,
  ) => Promise<DesktopComputerAutomationResult<void>>;
}

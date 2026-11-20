import type {
  ComputerAutomationAccessInput,
  ComputerAutomationActionBatchInput,
  ComputerAutomationActionResult,
  ComputerAutomationControllerKind,
  ComputerAutomationObservationOptions,
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  DesktopComputerAutomationContext,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as ComputerUse from "./ComputerUse.ts";

export const HUMAN_LEASE_TTL = Duration.seconds(30);
export const HUMAN_LEASE_SWEEP_INTERVAL = Duration.seconds(5);

interface ControllerContext extends DesktopComputerAutomationContext {
  readonly controllerKind: ComputerAutomationControllerKind;
}

export interface LeaseHolder {
  readonly key: string;
  readonly context: ControllerContext;
  readonly leaseId: string;
  readonly expiresAtMs: number | null;
}

export interface AcquisitionIntent {
  readonly key: string;
  readonly cancellation: Deferred.Deferred<never, ComputerUse.ComputerUseLeaseError>;
  readonly finished: Deferred.Deferred<void>;
  cancelled: boolean;
}

interface PendingAcquisition {
  readonly holder: LeaseHolder;
  readonly access: "view" | "control";
  readonly native: boolean;
}

export interface LeaseState {
  readonly viewers: ReadonlyMap<string, LeaseHolder>;
  readonly controller: LeaseHolder | null;
  readonly displacedController: LeaseHolder | null;
  readonly pending: PendingAcquisition | null;
  readonly explicitAvailability: ReadonlySet<string>;
  readonly humanAvailability: ReadonlySet<string>;
  readonly sequence: number;
  readonly activeTransitions: number;
}

export interface NativeAcquisitionPlan {
  readonly _tag: "native";
  readonly holder: LeaseHolder;
  readonly access: "view" | "control";
  readonly nativeAccess: "view" | "control" | null;
  readonly requestNativeAvailability: boolean;
}

export interface HandoffPlan {
  readonly _tag: "handoff";
  readonly holder: LeaseHolder;
  readonly displaced: LeaseHolder;
  readonly requestNativeAvailability: boolean;
}

export interface HeldPlan {
  readonly _tag: "held";
}

export type AcquisitionPlan = NativeAcquisitionPlan | HandoffPlan | HeldPlan;

type ControlOptions = Pick<
  ComputerAutomationAccessInput,
  "returnControlToAgent" | "takeoverLeaseId" | "permissionPolicy" | "permission" | "acquireLease"
>;
type ViewOptions = Pick<
  ComputerAutomationAccessInput,
  "releaseControlToView" | "permissionPolicy" | "permission" | "acquireLease"
>;

/** Expands a remembered control grant to the view capability it necessarily includes. */
export function effectiveRememberedAccess(
  access: ComputerAutomationStatus["rememberedAccess"],
): ComputerAutomationStatus["rememberedAccess"] {
  return access.includes("control") ? ["view", "control"] : access;
}

/** Normalizes older remote contexts while keeping context-free renderer calls explicit. */
export function normalizeContext(context: DesktopComputerAutomationContext): ControllerContext {
  return {
    controllerId: context.controllerId,
    controllerKind: context.controllerKind ?? "agent",
    ...(context.environmentId === undefined ? {} : { environmentId: context.environmentId }),
    ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
    ...(context.lifecycle === undefined ? {} : { lifecycle: context.lifecycle }),
    ...(context.connectionGeneration === undefined
      ? {}
      : { connectionGeneration: context.connectionGeneration }),
  };
}

/** Builds a collision-free host-wide key for one logical controller. */
export function controllerKey(context: ControllerContext): string {
  return JSON.stringify([
    context.controllerKind,
    context.environmentId ?? null,
    context.controllerId,
  ]);
}

/** Tests whether two controllers arrived through the same environment route. */
export function sameEnvironment(left: ControllerContext, right: ControllerContext): boolean {
  return left.environmentId !== undefined && left.environmentId === right.environmentId;
}

/** Creates an empty logical lease state without resetting lease-token uniqueness. */
export function emptyLeaseState(sequence = 0, activeTransitions = 0): LeaseState {
  return {
    viewers: new Map(),
    controller: null,
    displacedController: null,
    pending: null,
    explicitAvailability: new Set(),
    humanAvailability: new Set(),
    sequence,
    activeTransitions,
  };
}

/** Creates or refreshes the lease identity carried by one controller. */
export function leaseHolder(
  state: LeaseState,
  context: ControllerContext,
  nowMs: number,
): readonly [LeaseHolder, number] {
  const key = controllerKey(context);
  const existing =
    state.viewers.get(key) ?? (state.controller?.key === key ? state.controller : undefined);
  const expiresAtMs =
    context.controllerKind === "human" ? nowMs + Duration.toMillis(HUMAN_LEASE_TTL) : null;
  if (existing !== undefined) {
    return [{ ...existing, context, expiresAtMs }, state.sequence] as const;
  }
  return [
    {
      key,
      context,
      leaseId: `computer-lease-${state.sequence}`,
      expiresAtMs,
    },
    state.sequence + 1,
  ] as const;
}

/** Starts a human holder's lease from successful access completion. */
export function renewHumanLeaseHolder(holder: LeaseHolder, nowMs: number): LeaseHolder {
  return holder.context.controllerKind === "human"
    ? { ...holder, expiresAtMs: nowMs + Duration.toMillis(HUMAN_LEASE_TTL) }
    : holder;
}

/** Reports a logical lease conflict with a bounded public error. */
export function leaseConflict(cause: string): ComputerUse.ComputerUseLeaseError {
  return new ComputerUse.ComputerUseLeaseError({ code: "desktop-busy", cause });
}

/** Reports that a controller attempted an operation without the required lease. */
export function leaseRequired(cause: string): ComputerUse.ComputerUseLeaseError {
  return new ComputerUse.ComputerUseLeaseError({ code: "desktop-lease-required", cause });
}

export interface ComputerUseCoordinatorShape {
  readonly status: (
    context: DesktopComputerAutomationContext,
  ) => Effect.Effect<ComputerAutomationStatus>;
  readonly requestView: (
    context: DesktopComputerAutomationContext,
    options?: ViewOptions,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly requestControl: (
    context: DesktopComputerAutomationContext,
    options?: ControlOptions,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly rememberView: (
    context: DesktopComputerAutomationContext,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly rememberControl: (
    context: DesktopComputerAutomationContext,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly forceRelease: (
    context: DesktopComputerAutomationContext,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly interrupt: (
    context: DesktopComputerAutomationContext,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly forceForget: (
    context: DesktopComputerAutomationContext,
  ) => Effect.Effect<void, ComputerUse.ComputerUseError>;
  readonly requestAvailability: (
    context: DesktopComputerAutomationContext,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly releaseAvailability: (
    context: DesktopComputerAutomationContext,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly snapshot: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationObservationOptions,
  ) => Effect.Effect<ComputerAutomationSnapshot, ComputerUse.ComputerUseError>;
  readonly act: (
    context: DesktopComputerAutomationContext,
    input: ComputerAutomationActionBatchInput,
  ) => Effect.Effect<ReadonlyArray<ComputerAutomationActionResult>, ComputerUse.ComputerUseError>;
  readonly release: (
    context: DesktopComputerAutomationContext,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly forget: (
    context: DesktopComputerAutomationContext,
    permission?: ComputerAutomationAccessInput["permission"],
  ) => Effect.Effect<void, ComputerUse.ComputerUseError>;
}

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
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as DesktopScreenPermissions from "./DesktopScreenPermissions.ts";
import * as Semaphore from "effect/Semaphore";

import * as ComputerUse from "./ComputerUse.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";

const HUMAN_LEASE_TTL = Duration.seconds(30);
const HUMAN_LEASE_SWEEP_INTERVAL = Duration.seconds(5);

interface ControllerContext extends DesktopComputerAutomationContext {
  readonly controllerKind: ComputerAutomationControllerKind;
}

interface LeaseHolder {
  readonly key: string;
  readonly context: ControllerContext;
  readonly leaseId: string;
  readonly expiresAtMs: number | null;
}

interface AcquisitionIntent {
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

interface LeaseState {
  readonly viewers: ReadonlyMap<string, LeaseHolder>;
  readonly controller: LeaseHolder | null;
  readonly displacedController: LeaseHolder | null;
  readonly pending: PendingAcquisition | null;
  readonly explicitAvailability: ReadonlySet<string>;
  readonly humanAvailability: ReadonlySet<string>;
  readonly sequence: number;
  // Each native cleanup keeps acquisitions fenced until its own finalizer runs.
  readonly cleanupCount: number;
}

interface NativeAcquisitionPlan {
  readonly _tag: "native";
  readonly holder: LeaseHolder;
  readonly access: "view" | "control";
  readonly nativeAccess: "view" | "control" | null;
  readonly requestNativeAvailability: boolean;
}

interface HandoffPlan {
  readonly _tag: "handoff";
  readonly holder: LeaseHolder;
  readonly displaced: LeaseHolder;
  readonly requestNativeAvailability: boolean;
}

interface HeldPlan {
  readonly _tag: "held";
}

type AcquisitionPlan = NativeAcquisitionPlan | HandoffPlan | HeldPlan;

type ControlOptions = Pick<
  ComputerAutomationAccessInput,
  "returnControlToAgent" | "takeoverLeaseId" | "permissionPolicy" | "permission"
>;
type ViewOptions = Pick<
  ComputerAutomationAccessInput,
  "releaseControlToView" | "permissionPolicy" | "permission"
>;

/** Expands a remembered control grant to the view capability it necessarily includes. */
function effectiveRememberedAccess(
  access: ComputerAutomationStatus["rememberedAccess"],
): ComputerAutomationStatus["rememberedAccess"] {
  return access.includes("control") ? ["view", "control"] : access;
}

/** Normalizes older remote contexts while keeping context-free renderer calls explicit. */
function normalizeContext(context: DesktopComputerAutomationContext): ControllerContext {
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
function controllerKey(context: ControllerContext): string {
  return JSON.stringify([
    context.controllerKind,
    context.environmentId ?? null,
    context.controllerId,
  ]);
}

/** Tests whether two controllers arrived through the same environment route. */
function sameEnvironment(left: ControllerContext, right: ControllerContext): boolean {
  return left.environmentId !== undefined && left.environmentId === right.environmentId;
}

/** Creates an empty logical lease state without resetting lease-token uniqueness. */
function emptyLeaseState(sequence = 0, cleanupCount = 0): LeaseState {
  return {
    viewers: new Map(),
    controller: null,
    displacedController: null,
    pending: null,
    explicitAvailability: new Set(),
    humanAvailability: new Set(),
    sequence,
    cleanupCount,
  };
}

/** Creates or refreshes the lease identity carried by one controller. */
function leaseHolder(
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
function renewHumanLeaseHolder(holder: LeaseHolder, nowMs: number): LeaseHolder {
  return holder.context.controllerKind === "human"
    ? { ...holder, expiresAtMs: nowMs + Duration.toMillis(HUMAN_LEASE_TTL) }
    : holder;
}

/** Reports a logical lease conflict with a bounded public error. */
function leaseConflict(cause: string): ComputerUse.ComputerUseLeaseError {
  return new ComputerUse.ComputerUseLeaseError({ code: "desktop-busy", cause });
}

/** Reports that a controller attempted an operation without the required lease. */
function leaseRequired(cause: string): ComputerUse.ComputerUseLeaseError {
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

export class ComputerUseCoordinator extends Context.Service<
  ComputerUseCoordinator,
  ComputerUseCoordinatorShape
>()("@t3tools/desktop/computer/ComputerUseCoordinator") {}

/** Creates exclusive control and shared viewing leases for one user desktop. */
export const make = Effect.gen(function* () {
  const computer = yield* ComputerUse.ComputerUse;
  const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const userDesktop = {
    id: identity.registration.desktopId,
    kind: "user" as const,
    label: identity.registration.defaultLabel,
  };
  const state = yield* Ref.make<LeaseState>(emptyLeaseState());
  const leaseSemaphore = yield* Semaphore.make(1);
  const actionSemaphore = yield* Semaphore.make(1);
  const actionGeneration = yield* Ref.make(0);
  const acquisitions = new Set<AcquisitionIntent>();
  const cancelAcquisitions = (key?: string) => {
    const cancelled = [...acquisitions].filter((intent) => key === undefined || intent.key === key);
    for (const intent of cancelled) intent.cancelled = true;
    // The caller first clears lease state, so interruption cannot duplicate its native cleanup.
    return Effect.gen(function* () {
      for (const intent of cancelled)
        yield* Deferred.fail(
          intent.cancellation,
          new ComputerUse.ComputerUseLeaseError({
            code: "request-cancelled",
            cause: "desktop access was released while authorization was pending",
          }),
        );
      yield* Effect.forEach(cancelled, (intent) => Deferred.await(intent.finished), {
        discard: true,
      });
    });
  };
  const activeAction = yield* Ref.make<Fiber.Fiber<
    ReadonlyArray<ComputerAutomationActionResult>,
    ComputerUse.ComputerUseError
  > | null>(null);

  const withLeaseState = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    leaseSemaphore.withPermits(1)(effect);

  const removePendingAcquisition = (holder: LeaseHolder, access: "view" | "control") =>
    withLeaseState(
      Ref.update(state, (current) =>
        current.pending?.holder === holder && current.pending.access === access
          ? { ...current, pending: null }
          : current,
      ),
    );

  const finishTransition = Ref.update(state, (current) => ({
    ...current,
    cleanupCount: current.cleanupCount - 1,
  }));

  const cancelActiveAction = Effect.fn("ComputerUseCoordinator.cancelActiveAction")(function* () {
    yield* Ref.update(actionGeneration, (generation) => generation + 1);
    const action = yield* Ref.get(activeAction);
    if (action !== null) yield* Fiber.interrupt(action);
  });

  const reconcileAuthority = Effect.fn("ComputerUseCoordinator.reconcileAuthority")(function* () {
    const cleanup = yield* withLeaseState(
      Ref.modify(state, (current) => {
        if (current.cleanupCount > 0) return [null, current] as const;
        const viewers = new Map(
          [...current.viewers].filter(([, holder]) => permissions.has(holder.context, "view")),
        );
        const controlLost =
          current.controller !== null && !permissions.has(current.controller.context, "control");
        const controller = controlLost ? null : current.controller;
        const displacedController =
          current.displacedController !== null &&
          permissions.has(current.displacedController.context, "control")
            ? current.displacedController
            : null;
        if (
          !controlLost &&
          viewers.size === current.viewers.size &&
          displacedController === current.displacedController
        )
          return [null, current] as const;
        for (const key of current.viewers.keys()) if (!viewers.has(key)) permissions.release(key);
        const releaseNative = viewers.size === 0 && controller === null && current.pending === null;
        return [
          { controlLost, releaseNative },
          {
            ...current,
            viewers,
            controller,
            displacedController,
            cleanupCount: current.cleanupCount + 1,
          },
        ] as const;
      }),
    );
    if (cleanup === null) return;
    yield* Effect.gen(function* () {
      if (cleanup.controlLost) yield* cancelActiveAction();
      if (cleanup.releaseNative) yield* computer.release;
      else if (cleanup.controlLost) yield* actionSemaphore.withPermits(1)(computer.releaseInputs);
    }).pipe(Effect.ensuring(finishTransition));
  });

  const readNativeStatus = Effect.fn("ComputerUseCoordinator.readNativeStatus")(function* () {
    const observed = yield* Ref.get(state);
    const status = yield* computer.status;
    if (!status.available || status.permission === "pending") return status;
    const canView = status.permission === "granted" || status.permission === "view-only";
    const cleanup = yield* withLeaseState(
      Ref.modify(state, (current) => {
        // Ignore status captured before another lease transition completed.
        if (current !== observed || current.pending !== null || current.cleanupCount > 0) {
          return [null, current] as const;
        }
        const revokeControl = current.controller !== null && status.permission !== "granted";
        const revokeView = !canView && current.viewers.size > 0;
        if (revokeView) for (const key of current.viewers.keys()) permissions.release(key);
        if (!revokeControl && !revokeView) return [null, current] as const;
        const releaseAvailability =
          !canView && current.humanAvailability.size > 0 && current.explicitAvailability.size === 0;
        return [
          { revokeControl, releaseAvailability },
          {
            ...current,
            viewers: canView ? current.viewers : new Map<string, LeaseHolder>(),
            controller: revokeControl ? null : current.controller,
            displacedController: null,
            humanAvailability: canView ? current.humanAvailability : new Set<string>(),
            cleanupCount: current.cleanupCount + 1,
          },
        ] as const;
      }),
    );
    if (cleanup === null) return status;
    return yield* Effect.gen(function* () {
      if (cleanup.revokeControl) yield* cancelActiveAction();
      if (!cleanup.releaseAvailability) return status;
      return yield* computer.releaseAvailability.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("could not release revoked human desktop availability", {
            detail: String(cause).slice(0, 500),
          }).pipe(Effect.as(status)),
        ),
      );
    }).pipe(Effect.ensuring(finishTransition));
  });

  const expireHumanLeases = Effect.fn("ComputerUseCoordinator.expireHumanLeases")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const cleanup = yield* withLeaseState(
      Ref.modify(state, (current) => {
        if (current.cleanupCount > 0) {
          return [
            { releaseInputs: false, releaseNative: false, releaseAvailability: false },
            current,
          ] as const;
        }
        const expiredKeys = new Set(
          Array.from(current.viewers)
            .filter(([, holder]) => holder.expiresAtMs !== null && holder.expiresAtMs <= nowMs)
            .map(([key]) => key),
        );
        if (expiredKeys.size === 0) {
          return [
            { releaseInputs: false, releaseNative: false, releaseAvailability: false },
            current,
          ] as const;
        }
        for (const key of expiredKeys) permissions.release(key);
        const hadAccess = current.controller !== null || current.viewers.size > 0;
        const viewers = new Map(
          Array.from(current.viewers).filter(([key]) => !expiredKeys.has(key)),
        );
        const controllerExpired =
          current.controller !== null && expiredKeys.has(current.controller.key);
        const controller = controllerExpired ? null : current.controller;
        const humanAvailability = new Set(
          Array.from(current.humanAvailability).filter((key) => !expiredKeys.has(key)),
        );
        const releaseNative =
          hadAccess && controller === null && viewers.size === 0 && current.pending === null;
        const releaseAvailability =
          humanAvailability.size !== current.humanAvailability.size &&
          humanAvailability.size === 0 &&
          current.explicitAvailability.size === 0;
        return [
          {
            releaseInputs: controllerExpired && !releaseNative,
            releaseNative,
            releaseAvailability,
          },
          {
            ...current,
            viewers,
            controller,
            displacedController: controllerExpired ? null : current.displacedController,
            humanAvailability,
            cleanupCount:
              current.cleanupCount +
              (releaseNative || controllerExpired || releaseAvailability ? 1 : 0),
          },
        ] as const;
      }),
    );
    if (!cleanup.releaseInputs && !cleanup.releaseNative && !cleanup.releaseAvailability) return;
    yield* Effect.gen(function* () {
      if (cleanup.releaseInputs || cleanup.releaseNative) yield* cancelActiveAction();
      if (cleanup.releaseInputs) {
        yield* actionSemaphore.withPermits(1)(computer.releaseInputs);
      }
      if (cleanup.releaseNative) yield* computer.release;
      if (cleanup.releaseAvailability) yield* computer.releaseAvailability;
    }).pipe(Effect.ensuring(finishTransition));
  });

  const refreshHumanLease = Effect.fn("ComputerUseCoordinator.refreshHumanLease")(function* (
    input: DesktopComputerAutomationContext,
  ) {
    const context = normalizeContext(input);
    if (context.controllerKind !== "human") return;
    const nowMs = yield* Clock.currentTimeMillis;
    const key = controllerKey(context);
    const expiresAtMs = nowMs + Duration.toMillis(HUMAN_LEASE_TTL);
    yield* withLeaseState(
      Ref.update(state, (current) => {
        const viewer = current.viewers.get(key);
        if (viewer === undefined && current.controller?.key !== key) return current;
        const refresh = (holder: LeaseHolder): LeaseHolder => ({
          ...holder,
          context,
          expiresAtMs,
        });
        const viewers = new Map(current.viewers);
        if (viewer !== undefined) viewers.set(key, refresh(viewer));
        return {
          ...current,
          viewers,
          controller:
            current.controller?.key === key ? refresh(current.controller) : current.controller,
        };
      }),
    );
  });

  const presentStatus = Effect.fn("ComputerUseCoordinator.presentStatus")(function* (
    input: DesktopComputerAutomationContext,
  ) {
    yield* reconcileAuthority().pipe(Effect.ignore);
    yield* expireHumanLeases().pipe(Effect.ignore);
    yield* refreshHumanLease(input);
    const context = normalizeContext(input);
    const key = controllerKey(context);
    const status = yield* readNativeStatus();
    const leases = yield* Ref.get(state);
    const rememberedAccess = effectiveRememberedAccess(status.rememberedAccess);
    const hasView = leases.viewers.has(key) || leases.controller?.key === key;
    const permission =
      leases.controller?.key === key
        ? status.permission
        : hasView && (status.permission === "granted" || status.permission === "view-only")
          ? ("view-only" as const)
          : status.permission === "granted" || status.permission === "view-only"
            ? rememberedAccess.length > 0
              ? ("remembered" as const)
              : ("prompt-required" as const)
            : status.permission;
    const controller = leases.controller;
    const controllerSameEnvironment =
      controller === null ? false : sameEnvironment(context, controller.context);
    const requiresTakeoverConfirmation =
      context.controllerKind === "human" &&
      controller !== null &&
      controller.key !== key &&
      (controller.context.controllerKind !== "agent" || !controllerSameEnvironment);
    const canReturnControl =
      context.controllerKind === "human" &&
      controller?.key === key &&
      leases.displacedController?.context.controllerKind === "agent" &&
      leases.viewers.has(leases.displacedController.key);
    return {
      ...status,
      desktop: userDesktop,
      authorization: permissions.authorization(context),
      permission,
      rememberedAccess,
      lease: {
        access:
          controller?.key === key ? "control" : hasView ? ("view" as const) : ("none" as const),
        controller:
          controller === null
            ? null
            : {
                kind: controller.context.controllerKind,
                sameEnvironment: controllerSameEnvironment,
                ...(controllerSameEnvironment && controller.context.threadId !== undefined
                  ? { threadId: controller.context.threadId }
                  : {}),
              },
        ...(requiresTakeoverConfirmation ? { takeoverLeaseId: controller.leaseId } : {}),
        canReturnControl,
      },
    } satisfies ComputerAutomationStatus;
  });

  const requireView = Effect.fn("ComputerUseCoordinator.requireView")(function* (
    input: DesktopComputerAutomationContext,
  ) {
    yield* permissions.require(input, "view");
    yield* expireHumanLeases().pipe(Effect.ignore);
    yield* refreshHumanLease(input);
    const key = controllerKey(normalizeContext(input));
    const leases = yield* Ref.get(state);
    if (leases.controller?.key === key || leases.viewers.has(key)) return;
    return yield* leaseRequired("the controller has no view lease for this desktop");
  });

  const startAction = Effect.fn("ComputerUseCoordinator.startAction")(function* (
    input: DesktopComputerAutomationContext,
    batch: ComputerAutomationActionBatchInput,
    generation: number,
  ) {
    yield* permissions.require(input, "control");
    yield* expireHumanLeases().pipe(Effect.ignore);
    yield* refreshHumanLease(input);
    return yield* withLeaseState(
      Effect.gen(function* () {
        if ((yield* Ref.get(actionGeneration)) !== generation) {
          return yield* new ComputerUse.ComputerUseLeaseError({
            code: "request-cancelled",
            cause: "desktop control changed while an action was queued",
          });
        }
        const key = controllerKey(normalizeContext(input));
        const leases = yield* Ref.get(state);
        if (leases.pending?.access === "control" && leases.pending.holder.key !== key) {
          return yield* leaseConflict("desktop control is being transferred to another controller");
        }
        if (leases.controller?.key !== key) {
          return yield* leases.controller === null
            ? leaseRequired("the controller has no control lease for this desktop")
            : leaseConflict("another controller holds the desktop control lease");
        }
        const action = yield* Effect.forkChild(
          computer.act(batch, permissions.require(input, "control")),
        );
        yield* Ref.set(activeAction, action);
        return action;
      }),
    );
  });

  const beginAcquisition = Effect.fn("ComputerUseCoordinator.beginAcquisition")(function* (
    input: DesktopComputerAutomationContext,
    access: "view" | "control",
    intent: AcquisitionIntent,
    takeoverLeaseId?: string,
  ) {
    yield* expireHumanLeases().pipe(Effect.ignore);
    yield* readNativeStatus();
    const context = normalizeContext(input);
    const nowMs = yield* Clock.currentTimeMillis;
    return yield* withLeaseState(
      Effect.gen(function* () {
        if (intent.cancelled)
          return yield* new ComputerUse.ComputerUseLeaseError({
            code: "request-cancelled",
            cause: "desktop access was released while authorization was pending",
          });
        const current = yield* Ref.get(state);
        const key = controllerKey(context);
        const alreadyHeld =
          access === "view"
            ? current.viewers.has(key) || current.controller?.key === key
            : current.controller?.key === key;
        if (alreadyHeld) return { _tag: "held" } as const;
        if (current.cleanupCount > 0 || current.pending !== null) {
          return yield* leaseConflict("another controller holds or is changing desktop access");
        }
        const [holder, sequence] = leaseHolder(current, context, nowMs);
        if (access === "control" && current.controller !== null) {
          if (context.controllerKind !== "human") {
            return yield* leaseConflict("another controller holds the desktop control lease");
          }
          const confirmationRequired =
            current.controller.context.controllerKind !== "agent" ||
            !sameEnvironment(context, current.controller.context);
          if (confirmationRequired && takeoverLeaseId !== current.controller.leaseId) {
            return yield* leaseConflict(
              "confirmed takeover of the current desktop lease is required",
            );
          }
          const plan: HandoffPlan = {
            _tag: "handoff",
            holder,
            displaced: current.controller,
            requestNativeAvailability:
              current.explicitAvailability.size === 0 && current.humanAvailability.size === 0,
          };
          yield* Ref.set(state, {
            ...current,
            sequence,
            pending: { holder, access, native: false },
          });
          return plan;
        }
        const priorAccessEmpty = current.controller === null && current.viewers.size === 0;
        const plan: NativeAcquisitionPlan = {
          _tag: "native",
          holder,
          access,
          nativeAccess: access === "control" || priorAccessEmpty ? access : null,
          requestNativeAvailability:
            context.controllerKind === "human" &&
            current.explicitAvailability.size === 0 &&
            current.humanAvailability.size === 0,
        };
        yield* Ref.set(state, {
          ...current,
          sequence,
          pending: { holder, access, native: plan.nativeAccess !== null },
          explicitAvailability:
            context.controllerKind === "human"
              ? current.explicitAvailability
              : new Set(current.explicitAvailability).add(holder.key),
        });
        return plan;
      }),
    );
  });

  const completeNativeAcquisition = Effect.fn("ComputerUseCoordinator.completeNativeAcquisition")(
    function* (plan: NativeAcquisitionPlan) {
      yield* permissions.require(plan.holder.context, plan.access);
      const holder = renewHumanLeaseHolder(plan.holder, yield* Clock.currentTimeMillis);
      const completed = yield* withLeaseState(
        Ref.modify(state, (current) => {
          if (current.pending?.holder !== plan.holder || current.pending.access !== plan.access) {
            return [false, current] as const;
          }
          const viewers = new Map(current.viewers).set(holder.key, holder);
          const explicitAvailability = new Set(current.explicitAvailability);
          const humanAvailability = new Set(current.humanAvailability);
          if (holder.context.controllerKind === "human") {
            humanAvailability.add(holder.key);
          } else {
            explicitAvailability.add(holder.key);
          }
          return [
            true,
            {
              ...current,
              viewers,
              controller: plan.access === "control" ? holder : current.controller,
              pending: null,
              explicitAvailability,
              humanAvailability,
            },
          ] as const;
        }),
      );
      if (completed) return;
      return yield* new ComputerUse.ComputerUseLeaseError({
        code: "request-cancelled",
        cause: "desktop access was released while authorization was pending",
      });
    },
  );

  const completeHandoff = Effect.fn("ComputerUseCoordinator.completeHandoff")(function* (
    plan: HandoffPlan,
  ) {
    yield* permissions.require(plan.holder.context, "control");
    const holder = renewHumanLeaseHolder(plan.holder, yield* Clock.currentTimeMillis);
    const completed = yield* withLeaseState(
      Ref.modify(state, (current) => {
        if (
          current.pending?.holder !== plan.holder ||
          current.pending.access !== "control" ||
          current.controller?.key !== plan.displaced.key
        ) {
          return [false, current] as const;
        }
        const viewers = new Map(current.viewers)
          .set(plan.displaced.key, plan.displaced)
          .set(holder.key, holder);
        const displacedController =
          plan.displaced.context.controllerKind === "agent"
            ? plan.displaced
            : current.displacedController !== null && viewers.has(current.displacedController.key)
              ? current.displacedController
              : null;
        return [
          true,
          {
            ...current,
            viewers,
            controller: holder,
            displacedController,
            pending: null,
            humanAvailability: new Set(current.humanAvailability).add(holder.key),
          },
        ] as const;
      }),
    );
    if (completed) return;
    return yield* new ComputerUse.ComputerUseLeaseError({
      code: "request-cancelled",
      cause: "desktop control changed while takeover was pending",
    });
  });

  const cancelAcquisition = Effect.fn("ComputerUseCoordinator.cancelAcquisition")(function* (
    plan: Exclude<AcquisitionPlan, HeldPlan>,
  ) {
    const cleanup = yield* withLeaseState(
      Ref.modify(state, (current) => {
        if (current.pending?.holder !== plan.holder) return [null, current] as const;
        return [
          {
            releaseNative:
              plan._tag === "native" &&
              plan.nativeAccess !== null &&
              current.viewers.size === 0 &&
              current.controller === null,
            cancelNative: plan._tag === "native" && plan.nativeAccess !== null,
            releaseAvailability:
              plan.holder.context.controllerKind === "human" &&
              current.humanAvailability.size === 0 &&
              current.explicitAvailability.size === 0,
          },
          { ...current, pending: null, cleanupCount: current.cleanupCount + 1 },
        ] as const;
      }),
    );
    if (cleanup === null) return;
    yield* Effect.gen(function* () {
      if (cleanup.releaseNative) yield* computer.release;
      else if (cleanup.cancelNative) yield* computer.cancelPendingAccess;
      if (cleanup.releaseAvailability) yield* computer.releaseAvailability;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("could not clean up desktop authorization", {
          detail: String(cause).slice(0, 500),
        }),
      ),
      Effect.ensuring(finishTransition),
    );
  });

  const acquire = Effect.fn("ComputerUseCoordinator.acquire")(
    function* (
      context: DesktopComputerAutomationContext,
      access: "view" | "control",
      takeoverLeaseId?: string,
      policy?: ComputerAutomationAccessInput["permissionPolicy"],
      permission?: ComputerAutomationAccessInput["permission"],
    ) {
      const key = controllerKey(normalizeContext(context));
      const cancellation = yield* Deferred.make<never, ComputerUse.ComputerUseLeaseError>();
      const finished = yield* Deferred.make<void>();
      const intent = { key, cancelled: false, cancellation, finished };
      acquisitions.add(intent);
      permissions.retain(key, context);
      return yield* Effect.gen(function* () {
        yield* permissions.request(context, access, policy, permission);
        yield* permissions.require(context, access);
        const plan = yield* beginAcquisition(context, access, intent, takeoverLeaseId);
        if (plan._tag === "held") {
          yield* refreshHumanLease(context);
          return yield* presentStatus(context);
        }
        const cleanupPending = removePendingAcquisition(plan.holder, access);
        return yield* Effect.gen(function* () {
          if (plan._tag === "handoff") {
            yield* cancelActiveAction();
            if (plan.requestNativeAvailability) yield* computer.requestAvailability;
            yield* actionSemaphore.withPermits(1)(
              computer.releaseInputs.pipe(Effect.andThen(completeHandoff(plan))),
            );
            return yield* presentStatus(context);
          }
          if (plan.nativeAccess === "control") yield* computer.requestControl;
          if (plan.nativeAccess === "view") {
            yield* computer.status.pipe(
              Effect.flatMap((status) =>
                status.permission === "remembered" &&
                status.rememberedAccess.includes("control") &&
                !status.rememberedAccess.includes("view")
                  ? computer.requestControl
                  : computer.requestView,
              ),
            );
          }
          if (plan.requestNativeAvailability) {
            yield* computer.requestAvailability;
          }
          yield* completeNativeAcquisition(plan);
          return yield* presentStatus(context);
        }).pipe(
          Effect.onError(() => cancelAcquisition(plan)),
          Effect.ensuring(cleanupPending),
        );
      }).pipe(
        (acquisition) => Effect.raceFirst(acquisition, Deferred.await(cancellation)),
        Effect.ensuring(
          Effect.sync(() => acquisitions.delete(intent)).pipe(
            Effect.andThen(Deferred.succeed(finished, undefined)),
          ),
        ),
      );
    },
    (effect, context) =>
      effect.pipe(
        Effect.onError(() =>
          Ref.get(state).pipe(
            Effect.map((leases) => {
              const key = controllerKey(normalizeContext(context));
              if (
                !leases.viewers.has(key) &&
                leases.controller?.key !== key &&
                ![...acquisitions].some((intent) => intent.key === key && !intent.cancelled)
              )
                permissions.release(key);
            }),
          ),
        ),
      ),
  );

  const returnControlToAgent = Effect.fn("ComputerUseCoordinator.returnControlToAgent")(function* (
    input: DesktopComputerAutomationContext,
  ) {
    yield* expireHumanLeases().pipe(Effect.ignore);
    const context = normalizeContext(input);
    if (context.controllerKind !== "human") {
      return yield* leaseConflict("only a human controller can return displaced agent control");
    }
    const key = controllerKey(context);
    const plan = yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.cleanupCount > 0 || current.pending !== null) {
          return yield* leaseConflict("desktop control is already changing");
        }
        if (current.controller?.key !== key) {
          return yield* current.controller === null
            ? leaseRequired("the human does not hold desktop control")
            : leaseConflict("another controller holds the desktop control lease");
        }
        const displaced = current.displacedController;
        if (
          displaced === null ||
          displaced.context.controllerKind !== "agent" ||
          !current.viewers.has(displaced.key) ||
          !permissions.has(displaced.context, "control")
        ) {
          return yield* leaseRequired(
            "there is no still-viewing displaced agent to receive control",
          );
        }
        yield* Ref.set(state, {
          ...current,
          pending: { holder: displaced, access: "control", native: false },
        });
        return { human: current.controller, agent: displaced };
      }),
    );
    yield* cancelActiveAction();
    yield* actionSemaphore
      .withPermits(1)(
        Effect.gen(function* () {
          yield* computer.releaseInputs;
          const completed = yield* withLeaseState(
            Ref.modify(state, (current) => {
              if (
                current.pending?.holder.key !== plan.agent.key ||
                current.controller?.key !== plan.human.key ||
                !current.viewers.has(plan.agent.key)
              ) {
                return [false, current] as const;
              }
              return [
                true,
                {
                  ...current,
                  controller: plan.agent,
                  displacedController: null,
                  pending: null,
                },
              ] as const;
            }),
          );
          if (completed) return;
          return yield* new ComputerUse.ComputerUseLeaseError({
            code: "request-cancelled",
            cause: "desktop control changed while return was pending",
          });
        }),
      )
      .pipe(Effect.ensuring(removePendingAcquisition(plan.agent, "control")));
    return yield* presentStatus(context);
  });

  const releaseControlToView = Effect.fn("ComputerUseCoordinator.releaseControlToView")(function* (
    input: DesktopComputerAutomationContext,
  ) {
    yield* expireHumanLeases().pipe(Effect.ignore);
    const context = normalizeContext(input);
    if (context.controllerKind !== "human") {
      return yield* leaseConflict("only a human controller can release control to view");
    }
    const key = controllerKey(context);
    const shouldReleaseInputs = yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.cleanupCount > 0 || current.pending !== null) {
          return yield* leaseConflict("desktop control is already changing");
        }
        if (current.controller?.key !== key) {
          if (current.controller === null && current.viewers.has(key)) return false;
          return yield* current.controller === null
            ? leaseRequired("the human has no desktop access lease")
            : leaseConflict("another controller holds the desktop control lease");
        }
        yield* Ref.set(state, {
          ...current,
          controller: null,
          displacedController: null,
          cleanupCount: current.cleanupCount + 1,
        });
        return true;
      }),
    );
    if (shouldReleaseInputs) {
      yield* cancelActiveAction().pipe(
        Effect.andThen(actionSemaphore.withPermits(1)(computer.releaseInputs)),
        Effect.ensuring(finishTransition),
      );
    }
    return yield* presentStatus(context);
  });

  const remember = Effect.fn("ComputerUseCoordinator.remember")(function* (
    input: DesktopComputerAutomationContext,
    access: "view" | "control",
  ) {
    const context = normalizeContext(input);
    yield* permissions.confirmShared(
      context,
      "Remember operating-system screen consent on this desktop?",
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const holder = yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (
          current.cleanupCount > 0 ||
          current.pending !== null ||
          current.controller !== null ||
          current.viewers.size > 0
        ) {
          return yield* leaseConflict("another controller holds or is changing desktop access");
        }
        const [holder, sequence] = leaseHolder(current, context, nowMs);
        yield* Ref.set(state, { ...current, sequence, pending: { holder, access, native: true } });
        return holder;
      }),
    );
    yield* (access === "control" ? computer.rememberControl : computer.rememberView).pipe(
      Effect.ensuring(removePendingAcquisition(holder, access)),
    );
    return yield* presentStatus(context);
  });

  const requestView: ComputerUseCoordinatorShape["requestView"] = (context, options) =>
    options?.releaseControlToView === true
      ? releaseControlToView(context)
      : acquire(context, "view", undefined, options?.permissionPolicy, options?.permission);

  const requestControl: ComputerUseCoordinatorShape["requestControl"] = (context, options) =>
    options?.returnControlToAgent === true
      ? returnControlToAgent(context)
      : acquire(
          context,
          "control",
          options?.takeoverLeaseId,
          options?.permissionPolicy,
          options?.permission,
        );

  const rememberView: ComputerUseCoordinatorShape["rememberView"] = (context) =>
    remember(context, "view");

  const rememberControl: ComputerUseCoordinatorShape["rememberControl"] = (context) =>
    remember(context, "control");

  const requestAvailability: ComputerUseCoordinatorShape["requestAvailability"] = Effect.fn(
    "ComputerUseCoordinator.requestAvailability",
  )(function* (...[input]: Parameters<ComputerUseCoordinatorShape["requestAvailability"]>) {
    const context = normalizeContext(input);
    const key = controllerKey(context);
    yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.cleanupCount > 0) {
          return yield* leaseConflict("desktop access is changing");
        }
        yield* computer.requestAvailability;
        if (current.explicitAvailability.has(key)) return;
        yield* Ref.set(state, {
          ...current,
          explicitAvailability: new Set(current.explicitAvailability).add(key),
        });
      }),
    );
    return yield* presentStatus(context);
  });

  const releaseAvailability: ComputerUseCoordinatorShape["releaseAvailability"] = Effect.fn(
    "ComputerUseCoordinator.releaseAvailability",
  )(function* (...[input]: Parameters<ComputerUseCoordinatorShape["releaseAvailability"]>) {
    const context = normalizeContext(input);
    const key = controllerKey(context);
    yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (!current.explicitAvailability.has(key)) return;
        const explicitAvailability = new Set(current.explicitAvailability);
        explicitAvailability.delete(key);
        if (explicitAvailability.size === 0 && current.humanAvailability.size === 0) {
          yield* computer.releaseAvailability;
        }
        yield* Ref.set(state, { ...current, explicitAvailability });
      }),
    );
    return yield* presentStatus(context);
  });

  const snapshot: ComputerUseCoordinatorShape["snapshot"] = (context, input) =>
    requireView(context).pipe(
      Effect.andThen(computer.snapshot(input)),
      Effect.tap(() => permissions.require(context, "view")),
    );

  const act: ComputerUseCoordinatorShape["act"] = Effect.fn("ComputerUseCoordinator.act")(
    function* (...[context, input]: Parameters<ComputerUseCoordinatorShape["act"]>) {
      const generation = yield* Ref.get(actionGeneration);
      return yield* actionSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const action = yield* startAction(context, input, generation);
          const result = yield* Fiber.await(action).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(action)),
            Effect.ensuring(Ref.set(activeAction, null)),
          );
          if (Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)) {
            return yield* new ComputerUse.ComputerUseLeaseError({
              code: "request-cancelled",
              cause: "desktop control was released while an action was running",
            });
          }
          return yield* result;
        }),
      );
    },
  );

  const interrupt: ComputerUseCoordinatorShape["interrupt"] = Effect.fn(
    "ComputerUseCoordinator.interrupt",
  )(function* (input) {
    const context = normalizeContext(input);
    if (context.controllerKind !== "agent") {
      return yield* leaseConflict("only agent desktop access can be interrupted by a turn stop");
    }
    const cancelAcquiring = cancelAcquisitions(controllerKey(context));
    yield* permissions.cancel(context);
    const key = controllerKey(context);
    const cleanup = yield* withLeaseState(
      Ref.modify(state, (current) => {
        const pending = current.pending?.holder.key === key ? current.pending : null;
        const releasedControl = current.controller?.key === key;
        const displaced = current.displacedController?.key === key;
        if (pending === null && !releasedControl && !displaced) return [null, current] as const;
        return [
          { releasedControl, cancelNative: pending?.native === true },
          {
            ...current,
            controller: releasedControl ? null : current.controller,
            displacedController: releasedControl || displaced ? null : current.displacedController,
            pending: pending === null ? current.pending : null,
            cleanupCount:
              current.cleanupCount + (releasedControl || pending?.native === true ? 1 : 0),
          },
        ] as const;
      }),
    );
    yield* Effect.gen(function* () {
      yield* cancelAcquiring;
      if (cleanup !== null) {
        if (cleanup.releasedControl) yield* cancelActiveAction();
        if (cleanup.cancelNative) yield* computer.cancelPendingAccess;
        if (cleanup.releasedControl) {
          yield* actionSemaphore.withPermits(1)(computer.releaseInputs);
        }
      }
    }).pipe(
      Effect.ensuring(
        cleanup?.releasedControl || cleanup?.cancelNative ? finishTransition : Effect.void,
      ),
    );
    return yield* presentStatus(context);
  });

  const release: ComputerUseCoordinatorShape["release"] = Effect.fn(
    "ComputerUseCoordinator.release",
  )(function* (...[input]: Parameters<ComputerUseCoordinatorShape["release"]>) {
    const context = normalizeContext(input);
    const cancelAcquiring = cancelAcquisitions(controllerKey(context));
    yield* permissions.cancel(context);
    const key = controllerKey(context);
    permissions.release(key);
    const cleanup = yield* withLeaseState(
      Ref.modify(state, (current) => {
        const cancelledPending = current.pending?.holder.key === key;
        const releasedControl = current.controller?.key === key;
        const viewers = new Map(current.viewers);
        viewers.delete(key);
        const humanAvailability = new Set(current.humanAvailability);
        humanAvailability.delete(key);
        const controller = releasedControl ? null : current.controller;
        const pending = cancelledPending ? null : current.pending;
        const releaseNative =
          (cancelledPending || releasedControl || current.viewers.has(key)) &&
          controller === null &&
          viewers.size === 0 &&
          pending === null;
        const releaseAvailability =
          (current.humanAvailability.has(key) ||
            (cancelledPending && current.pending?.holder.context.controllerKind === "human")) &&
          humanAvailability.size === 0 &&
          current.explicitAvailability.size === 0;
        const transitioning =
          cancelledPending || releasedControl || releaseNative || releaseAvailability;
        return [
          {
            cancelNative: cancelledPending && current.pending?.native === true,
            releaseInputs: releasedControl && !releaseNative,
            releaseNative,
            releaseAvailability,
            ownsTransition: transitioning,
          },
          {
            ...current,
            viewers,
            controller,
            displacedController: releasedControl ? null : current.displacedController,
            pending,
            humanAvailability,
            cleanupCount: current.cleanupCount + (transitioning ? 1 : 0),
          },
        ] as const;
      }),
    );
    yield* Effect.gen(function* () {
      yield* cancelAcquiring;
      if (cleanup.releaseInputs || cleanup.releaseNative) yield* cancelActiveAction();
      if (cleanup.releaseNative) yield* computer.release;
      else {
        if (cleanup.cancelNative) yield* computer.cancelPendingAccess;
        if (cleanup.releaseInputs) {
          yield* actionSemaphore.withPermits(1)(computer.releaseInputs);
        }
      }
      if (cleanup.releaseAvailability) yield* computer.releaseAvailability;
    }).pipe(Effect.ensuring(cleanup.ownsTransition ? finishTransition : Effect.void));
    return yield* presentStatus(context);
  });

  const forceRelease: ComputerUseCoordinatorShape["forceRelease"] = Effect.fn(
    "ComputerUseCoordinator.forceRelease",
  )(function* (...[context]: Parameters<ComputerUseCoordinatorShape["forceRelease"]>) {
    yield* permissions.confirmShared(context, "End all screen access on this desktop?");
    const cancelAcquiring = cancelAcquisitions();
    yield* permissions.cancelAll;
    yield* withLeaseState(
      Ref.update(state, (current) => {
        for (const key of current.viewers.keys()) permissions.release(key);
        return emptyLeaseState(current.sequence, current.cleanupCount + 1);
      }),
    );
    yield* cancelAcquiring.pipe(
      Effect.andThen(cancelActiveAction()),
      Effect.andThen(computer.release),
      Effect.ensuring(computer.releaseAvailability.pipe(Effect.ignore)),
      Effect.ensuring(finishTransition),
    );
    return yield* presentStatus(context);
  });

  const forceForget: ComputerUseCoordinatorShape["forceForget"] = Effect.fn(
    "ComputerUseCoordinator.forceForget",
  )(function* (...[context]: Parameters<ComputerUseCoordinatorShape["forceForget"]>) {
    yield* permissions.confirmShared(
      context,
      "Remove all T3 screen permissions and remembered operating-system consent?",
    );
    const cancelAcquiring = cancelAcquisitions();
    yield* permissions.cancelAll;
    yield* permissions.revokeAll;
    yield* withLeaseState(
      Ref.update(state, (current) => {
        for (const key of current.viewers.keys()) permissions.release(key);
        return emptyLeaseState(current.sequence, current.cleanupCount + 1);
      }),
    );
    yield* cancelAcquiring.pipe(
      Effect.andThen(cancelActiveAction()),
      Effect.andThen(computer.forget),
      Effect.ensuring(computer.releaseAvailability.pipe(Effect.ignore)),
      Effect.ensuring(finishTransition),
    );
  });

  const forget: ComputerUseCoordinatorShape["forget"] = (context, permission) =>
    permission !== undefined
      ? permissions.revoke(context, permission)
      : context.controllerKind === "local"
        ? forceForget(context)
        : permissions.revokeOwn(context).pipe(Effect.andThen(release(context)), Effect.asVoid);

  yield* permissions.changes.pipe(
    Stream.runForEach(() => reconcileAuthority().pipe(Effect.ignore)),
    Effect.forkScoped,
  );

  yield* Effect.sleep(HUMAN_LEASE_SWEEP_INTERVAL).pipe(
    Effect.andThen(
      reconcileAuthority().pipe(
        Effect.andThen(expireHumanLeases()),
        Effect.catch((cause) =>
          Effect.logWarning("could not expire User desktop human leases", {
            detail: String(cause).slice(0, 500),
          }),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  return ComputerUseCoordinator.of({
    status: presentStatus,
    requestView,
    requestControl,
    rememberView,
    rememberControl,
    forceRelease,
    interrupt,
    forceForget,
    requestAvailability,
    releaseAvailability,
    snapshot,
    act,
    release,
    forget,
  });
});

export const layer = Layer.effect(ComputerUseCoordinator, make);

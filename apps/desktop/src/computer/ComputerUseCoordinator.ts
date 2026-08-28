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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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

interface PendingAcquisition {
  readonly holder: LeaseHolder;
  readonly access: "view" | "control";
}

interface LeaseState {
  readonly viewers: ReadonlyMap<string, LeaseHolder>;
  readonly controller: LeaseHolder | null;
  readonly displacedController: LeaseHolder | null;
  readonly pending: PendingAcquisition | null;
  readonly explicitAvailability: ReadonlySet<string>;
  readonly humanAvailability: ReadonlySet<string>;
  readonly sequence: number;
  readonly transitioning: boolean;
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
  "returnControlToAgent" | "takeoverLeaseId"
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
function emptyLeaseState(sequence = 0, transitioning = false): LeaseState {
  return {
    viewers: new Map(),
    controller: null,
    displacedController: null,
    pending: null,
    explicitAvailability: new Set(),
    humanAvailability: new Set(),
    sequence,
    transitioning,
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
  ) => Effect.Effect<void, ComputerUse.ComputerUseError>;
}

export class ComputerUseCoordinator extends Context.Service<
  ComputerUseCoordinator,
  ComputerUseCoordinatorShape
>()("@t3tools/desktop/computer/ComputerUseCoordinator") {}

/** Creates exclusive control and shared viewing leases for one user desktop. */
export const make = Effect.gen(function* () {
  const computer = yield* ComputerUse.ComputerUse;
  const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
  const userDesktop = {
    id: identity.registration.desktopId,
    kind: "user" as const,
    label: identity.registration.defaultLabel,
  };
  const state = yield* Ref.make<LeaseState>(emptyLeaseState());
  const leaseSemaphore = yield* Semaphore.make(1);
  const actionSemaphore = yield* Semaphore.make(1);
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

  const finishTransition = Ref.update(state, (current) =>
    current.transitioning ? { ...current, transitioning: false } : current,
  );

  const cancelActiveAction = Effect.fn("ComputerUseCoordinator.cancelActiveAction")(function* () {
    const action = yield* Ref.get(activeAction);
    if (action !== null) yield* Fiber.interrupt(action);
  });

  const readNativeStatus = Effect.fn("ComputerUseCoordinator.readNativeStatus")(function* () {
    const observed = yield* Ref.get(state);
    const status = yield* computer.status;
    if (!status.available || status.permission === "pending") return status;
    const canView = status.permission === "granted" || status.permission === "view-only";
    const cleanup = yield* withLeaseState(
      Ref.modify(state, (current) => {
        // Ignore status captured before another lease transition completed.
        if (current !== observed || current.pending !== null || current.transitioning) {
          return [null, current] as const;
        }
        const revokeControl = current.controller !== null && status.permission !== "granted";
        const revokeView = !canView && current.viewers.size > 0;
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
            transitioning: true,
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
        if (current.transitioning) {
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
            transitioning: releaseNative || controllerExpired || releaseAvailability,
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
  ) {
    yield* expireHumanLeases().pipe(Effect.ignore);
    yield* refreshHumanLease(input);
    return yield* withLeaseState(
      Effect.gen(function* () {
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
        const action = yield* Effect.forkChild(computer.act(batch));
        yield* Ref.set(activeAction, action);
        return action;
      }),
    );
  });

  const beginAcquisition = Effect.fn("ComputerUseCoordinator.beginAcquisition")(function* (
    input: DesktopComputerAutomationContext,
    access: "view" | "control",
    takeoverLeaseId?: string,
  ) {
    yield* expireHumanLeases().pipe(Effect.ignore);
    yield* readNativeStatus();
    const context = normalizeContext(input);
    const nowMs = yield* Clock.currentTimeMillis;
    return yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const key = controllerKey(context);
        const alreadyHeld =
          access === "view"
            ? current.viewers.has(key) || current.controller?.key === key
            : current.controller?.key === key;
        if (alreadyHeld) return { _tag: "held" } as const;
        if (current.transitioning || current.pending !== null) {
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
            pending: { holder, access },
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
          pending: { holder, access },
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
            releaseNative: plan._tag === "native" && plan.nativeAccess !== null,
            releaseAvailability:
              plan.holder.context.controllerKind === "human" &&
              current.humanAvailability.size === 0 &&
              current.explicitAvailability.size === 0,
          },
          { ...current, pending: null, transitioning: true },
        ] as const;
      }),
    );
    if (cleanup === null) return;
    yield* Effect.gen(function* () {
      if (cleanup.releaseNative) yield* computer.release;
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

  const acquire = Effect.fn("ComputerUseCoordinator.acquire")(function* (
    context: DesktopComputerAutomationContext,
    access: "view" | "control",
    takeoverLeaseId?: string,
  ) {
    const plan = yield* beginAcquisition(context, access, takeoverLeaseId);
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
  });

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
        if (current.transitioning || current.pending !== null) {
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
          !current.viewers.has(displaced.key)
        ) {
          return yield* leaseRequired(
            "there is no still-viewing displaced agent to receive control",
          );
        }
        yield* Ref.set(state, {
          ...current,
          pending: { holder: displaced, access: "control" },
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

  const remember = Effect.fn("ComputerUseCoordinator.remember")(function* (
    input: DesktopComputerAutomationContext,
    access: "view" | "control",
  ) {
    const context = normalizeContext(input);
    const nowMs = yield* Clock.currentTimeMillis;
    const holder = yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (
          current.transitioning ||
          current.pending !== null ||
          current.controller !== null ||
          current.viewers.size > 0
        ) {
          return yield* leaseConflict("another controller holds or is changing desktop access");
        }
        const [holder, sequence] = leaseHolder(current, context, nowMs);
        yield* Ref.set(state, { ...current, sequence, pending: { holder, access } });
        return holder;
      }),
    );
    yield* (access === "control" ? computer.rememberControl : computer.rememberView).pipe(
      Effect.ensuring(removePendingAcquisition(holder, access)),
    );
    return yield* presentStatus(context);
  });

  const requestView: ComputerUseCoordinatorShape["requestView"] = (context) =>
    acquire(context, "view");

  const requestControl: ComputerUseCoordinatorShape["requestControl"] = (context, options) =>
    options?.returnControlToAgent === true
      ? returnControlToAgent(context)
      : acquire(context, "control", options?.takeoverLeaseId);

  const rememberView: ComputerUseCoordinatorShape["rememberView"] = (context) =>
    remember(context, "view");

  const rememberControl: ComputerUseCoordinatorShape["rememberControl"] = (context) =>
    remember(context, "control");

  const requestAvailability: ComputerUseCoordinatorShape["requestAvailability"] = (input) =>
    Effect.gen(function* () {
      const context = normalizeContext(input);
      const key = controllerKey(context);
      yield* withLeaseState(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.transitioning) {
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

  const releaseAvailability: ComputerUseCoordinatorShape["releaseAvailability"] = (input) =>
    Effect.gen(function* () {
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
    requireView(context).pipe(Effect.andThen(computer.snapshot(input)));

  const act: ComputerUseCoordinatorShape["act"] = (context, input) =>
    actionSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const action = yield* startAction(context, input);
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

  const release: ComputerUseCoordinatorShape["release"] = (input) =>
    Effect.gen(function* () {
      const context = normalizeContext(input);
      const key = controllerKey(context);
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
              cancelledPending,
              releaseInputs: releasedControl && !releaseNative,
              releaseNative,
              releaseAvailability,
            },
            {
              ...current,
              viewers,
              controller,
              displacedController: releasedControl ? null : current.displacedController,
              pending,
              humanAvailability,
              transitioning,
            },
          ] as const;
        }),
      );
      yield* Effect.gen(function* () {
        if (cleanup.releaseInputs || cleanup.releaseNative) yield* cancelActiveAction();
        if (cleanup.cancelledPending || cleanup.releaseNative) yield* computer.release;
        else if (cleanup.releaseInputs) {
          yield* actionSemaphore.withPermits(1)(computer.releaseInputs);
        }
        if (cleanup.releaseAvailability) yield* computer.releaseAvailability;
      }).pipe(Effect.ensuring(finishTransition));
      return yield* presentStatus(context);
    });

  const forceRelease: ComputerUseCoordinatorShape["forceRelease"] = (context) =>
    Effect.gen(function* () {
      const sequence = yield* withLeaseState(
        Ref.modify(state, (current) => [current.sequence, emptyLeaseState(current.sequence, true)]),
      );
      yield* cancelActiveAction().pipe(
        Effect.andThen(computer.release),
        Effect.ensuring(computer.releaseAvailability.pipe(Effect.ignore)),
        Effect.ensuring(finishTransition),
      );
      yield* Ref.update(state, (current) => ({ ...current, sequence }));
      return yield* presentStatus(context);
    });

  const forceForget: ComputerUseCoordinatorShape["forceForget"] = () =>
    Effect.gen(function* () {
      yield* withLeaseState(
        Ref.update(state, (current) => emptyLeaseState(current.sequence, true)),
      );
      yield* cancelActiveAction().pipe(
        Effect.andThen(computer.forget),
        Effect.ensuring(computer.releaseAvailability.pipe(Effect.ignore)),
        Effect.ensuring(finishTransition),
      );
    });

  const forget: ComputerUseCoordinatorShape["forget"] = (input) =>
    Effect.gen(function* () {
      const context = normalizeContext(input);
      const key = controllerKey(context);
      yield* withLeaseState(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (
            current.transitioning ||
            (current.controller !== null && current.controller.key !== key) ||
            (current.pending !== null && current.pending.holder.key !== key)
          ) {
            return yield* leaseConflict("another controller holds or is changing desktop access");
          }
          yield* Ref.set(state, emptyLeaseState(current.sequence, true));
        }),
      );
      yield* cancelActiveAction().pipe(
        Effect.andThen(computer.forget),
        Effect.ensuring(computer.releaseAvailability.pipe(Effect.ignore)),
        Effect.ensuring(finishTransition),
      );
    });

  yield* Effect.sleep(HUMAN_LEASE_SWEEP_INTERVAL).pipe(
    Effect.andThen(
      expireHumanLeases().pipe(
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

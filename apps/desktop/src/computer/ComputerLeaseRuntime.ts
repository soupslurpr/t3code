import type {
  ComputerAutomationActionBatchInput,
  ComputerAutomationActionResult,
  ComputerAutomationStatus,
  DesktopComputerAutomationContext,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as DesktopScreenPermissions from "./DesktopScreenPermissions.ts";
import * as Semaphore from "effect/Semaphore";
import * as ComputerUse from "./ComputerUse.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";
import {
  type AcquisitionIntent,
  type ComputerUseCoordinatorShape,
  HUMAN_LEASE_TTL,
  type LeaseHolder,
  type LeaseState,
  controllerKey,
  effectiveRememberedAccess,
  emptyLeaseState,
  leaseConflict,
  leaseRequired,
  normalizeContext,
  sameEnvironment,
} from "./ComputerLeases.ts";

export const makeLeaseRuntime = Effect.gen(function* () {
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

  const finishTransition = withLeaseState(
    Ref.update(state, (current) => ({
      ...current,
      activeTransitions: current.activeTransitions - 1,
    })),
  );

  const cancelActiveAction = Effect.fn("ComputerUseCoordinator.cancelActiveAction")(function* () {
    yield* Ref.update(actionGeneration, (generation) => generation + 1);
    const action = yield* Ref.get(activeAction);
    if (action !== null) yield* Fiber.interrupt(action);
  });

  const reconcileAuthority = Effect.fn("ComputerUseCoordinator.reconcileAuthority")(function* () {
    const cleanup = yield* withLeaseState(
      Ref.modify(state, (current) => {
        if (current.activeTransitions > 0) return [null, current] as const;
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
            activeTransitions: current.activeTransitions + 1,
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
        if (current !== observed || current.pending !== null || current.activeTransitions > 0) {
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
            activeTransitions: current.activeTransitions + 1,
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
        if (current.activeTransitions > 0) {
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
            activeTransitions:
              current.activeTransitions +
              Number(releaseNative || controllerExpired || releaseAvailability),
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
      status.available &&
      status.permission === "granted" &&
      leases.activeTransitions === 0 &&
      leases.pending === null &&
      context.controllerKind === "human" &&
      controller?.key === key &&
      leases.displacedController?.context.controllerKind === "agent" &&
      leases.viewers.has(leases.displacedController.key);
    const authorization = permissions.authorization(context);
    return {
      ...status,
      desktop: userDesktop,
      authorization,
      threadGrant: {
        view: permissions.has(context, "view")
          ? ("granted" as const)
          : ("approval-required" as const),
        control: permissions.has(context, "control")
          ? ("granted" as const)
          : ("approval-required" as const),
      },
      ...(authorization === undefined
        ? {
            detail: [
              status.detail,
              "Screen permissions are unavailable because permission publication could not be confirmed. Saved permissions may have changed; reload the permission store before granting access.",
            ]
              .filter(Boolean)
              .join(" "),
          }
        : {}),
      permission,
      rememberedAccess,
      lease: {
        holdsExplicitAvailability: leases.explicitAvailability.has(key),
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
    yield* permissions.admit(input, "view");
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
        if (
          leases.activeTransitions > 0 ||
          (leases.pending?.access === "control" && leases.pending.holder.key !== key)
        ) {
          return yield* leaseConflict("desktop control is being transferred to another controller");
        }
        if (leases.controller?.key !== key) {
          return yield* leases.controller === null
            ? leaseRequired("the controller has no control lease for this desktop")
            : leaseConflict("another controller holds the desktop control lease");
        }
        if (
          leases.controller.expiresAtMs !== null &&
          leases.controller.expiresAtMs <= (yield* Clock.currentTimeMillis)
        ) {
          return yield* leaseRequired("the desktop control lease expired while input was queued");
        }
        const action = yield* Effect.forkChild(
          computer.act(batch, permissions.require(input, "control")),
        );
        yield* Ref.set(activeAction, action);
        return action;
      }),
    );
  });

  const requestAvailability: ComputerUseCoordinatorShape["requestAvailability"] = Effect.fn(
    "ComputerUseCoordinator.requestAvailability",
  )(function* (...[input]: Parameters<ComputerUseCoordinatorShape["requestAvailability"]>) {
    const context = normalizeContext(input);
    const key = controllerKey(context);
    yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.activeTransitions > 0) {
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

  return {
    acquisitions,
    actionGeneration,
    actionSemaphore,
    activeAction,
    cancelAcquisitions,
    cancelActiveAction,
    computer,
    expireHumanLeases,
    finishTransition,
    permissions,
    presentStatus,
    readNativeStatus,
    reconcileAuthority,
    refreshHumanLease,
    releaseAvailability,
    removePendingAcquisition,
    requestAvailability,
    requireView,
    startAction,
    state,
    withLeaseState,
  };
});
export type LeaseRuntime = Effect.Success<typeof makeLeaseRuntime>;

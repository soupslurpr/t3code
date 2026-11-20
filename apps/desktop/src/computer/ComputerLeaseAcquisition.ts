import { toComputerAutomationFailure } from "@t3tools/shared/computerAutomationFailure";
import { msg } from "gt-i18n";
import { m } from "../i18n/messages.ts";
import type {
  ComputerAutomationAccessInput,
  DesktopComputerAutomationContext,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as ComputerUse from "./ComputerUse.ts";
import {
  type AcquisitionIntent,
  type AcquisitionPlan,
  type ComputerUseCoordinatorShape,
  type HandoffPlan,
  type HeldPlan,
  type LeaseHolder,
  type NativeAcquisitionPlan,
  controllerKey,
  leaseConflict,
  leaseHolder,
  leaseRequired,
  normalizeContext,
  renewHumanLeaseHolder,
  sameEnvironment,
} from "./ComputerLeases.ts";
import type { LeaseRuntime } from "./ComputerLeaseRuntime.ts";

export function makeLeaseAcquisitions(runtime: LeaseRuntime) {
  const {
    computer,
    permissions,
    state,
    actionSemaphore,
    acquisitions,
    withLeaseState,
    removePendingAcquisition,
    finishTransition,
    cancelActiveAction,
    readNativeStatus,
    expireHumanLeases,
    refreshHumanLease,
    presentStatus,
    requestAvailability,
  } = runtime;
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
        if (current.activeTransitions > 0 || current.pending !== null) {
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
            cancelNative: plan._tag === "native" && plan.nativeAccess !== null,
            releaseNative:
              plan._tag === "native" &&
              plan.nativeAccess !== null &&
              current.controller === null &&
              current.viewers.size === 0,
            releaseAvailability:
              plan.holder.context.controllerKind === "human" &&
              current.humanAvailability.size === 0 &&
              current.explicitAvailability.size === 0,
          },
          { ...current, pending: null, activeTransitions: current.activeTransitions + 1 },
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
      acquireLease = true,
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
        if (!acquireLease) return yield* requestAvailability(context);
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
                  ? computer.requestControl.pipe(
                      Effect.catchIf(
                        (error) => {
                          const code = toComputerAutomationFailure(error).code;
                          return (
                            code !== "permission-denied" &&
                            code !== "request-cancelled" &&
                            code !== "display-locked" &&
                            code !== "display-inactive" &&
                            code !== "timed-out"
                          );
                        },
                        () => computer.requestView,
                      ),
                    )
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

  const requireNativeControl = Effect.fn("ComputerUseCoordinator.requireNativeControl")(
    function* () {
      const status = yield* readNativeStatus();
      if (!status.available || status.permission !== "granted") {
        return yield* leaseRequired("native desktop control is not currently authorized");
      }
    },
  );

  const returnControlToAgent = Effect.fn("ComputerUseCoordinator.returnControlToAgent")(function* (
    input: DesktopComputerAutomationContext,
  ) {
    yield* expireHumanLeases().pipe(Effect.ignore);
    const context = normalizeContext(input);
    if (context.controllerKind !== "human") {
      return yield* leaseConflict("only a human controller can return displaced agent control");
    }
    yield* requireNativeControl();
    const key = controllerKey(context);
    const plan = yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.activeTransitions > 0 || current.pending !== null) {
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
    yield* cancelActiveAction().pipe(
      Effect.andThen(
        actionSemaphore.withPermits(1)(
          Effect.gen(function* () {
            yield* computer.releaseInputs;
            yield* requireNativeControl();
            const nowMs = yield* Clock.currentTimeMillis;
            const completed = yield* withLeaseState(
              Ref.modify(state, (current) => {
                if (
                  current.pending?.holder !== plan.agent ||
                  current.controller?.leaseId !== plan.human.leaseId ||
                  (current.controller.expiresAtMs !== null &&
                    current.controller.expiresAtMs <= nowMs) ||
                  current.displacedController?.leaseId !== plan.agent.leaseId ||
                  current.viewers.get(plan.agent.key)?.leaseId !== plan.agent.leaseId
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
        ),
      ),
      Effect.ensuring(removePendingAcquisition(plan.agent, "control")),
    );
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
        if (current.activeTransitions > 0 || current.pending !== null) {
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
          activeTransitions: current.activeTransitions + 1,
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
    const key = controllerKey(context);
    const cancellation = yield* Deferred.make<never, ComputerUse.ComputerUseLeaseError>();
    const finished = yield* Deferred.make<void>();
    const intent: AcquisitionIntent = { key, cancelled: false, cancellation, finished };
    acquisitions.add(intent);
    let releaseAttempted = false;
    const beginPendingRelease = (holder: LeaseHolder) =>
      withLeaseState(
        Ref.modify(state, (current) => {
          if (current.pending?.holder !== holder || current.pending.access !== access) {
            return [false, current] as const;
          }
          return [
            true,
            {
              ...current,
              activeTransitions: current.activeTransitions + 1,
            },
          ] as const;
        }),
      );
    return yield* Effect.gen(function* () {
      yield* permissions.confirmShared(
        context,
        m(msg("Remember operating-system screen consent on this desktop?")),
      );
      yield* expireHumanLeases().pipe(Effect.ignore);
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Effect.acquireUseRelease(
        withLeaseState(
          Effect.gen(function* () {
            if (intent.cancelled) {
              return yield* new ComputerUse.ComputerUseLeaseError({
                code: "request-cancelled",
                cause: "desktop access was released while authorization was pending",
              });
            }
            const current = yield* Ref.get(state);
            if (
              current.activeTransitions > 0 ||
              current.pending !== null ||
              current.controller !== null ||
              current.viewers.size > 0
            ) {
              return yield* leaseConflict("another controller holds or is changing desktop access");
            }
            const [holder, sequence] = leaseHolder(current, context, nowMs);
            yield* Ref.set(state, {
              ...current,
              sequence,
              pending: { holder, access, native: true },
            });
            return holder;
          }),
        ),
        (holder) =>
          Effect.gen(function* () {
            yield* access === "control" ? computer.rememberControl : computer.rememberView;
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const shouldRelease = yield* beginPendingRelease(holder);
                if (!shouldRelease) {
                  return yield* new ComputerUse.ComputerUseLeaseError({
                    code: "request-cancelled",
                    cause: "desktop access was released while authorization was pending",
                  });
                }
                releaseAttempted = true;
                yield* computer.release.pipe(
                  Effect.andThen(removePendingAcquisition(holder, access)),
                  Effect.ensuring(finishTransition),
                );
              }),
            );
          }),
        (holder, exit) =>
          Effect.gen(function* () {
            if (releaseAttempted) return;
            const isPermissionDenied =
              Exit.isFailure(exit) &&
              !Cause.hasInterruptsOnly(exit.cause) &&
              toComputerAutomationFailure(Cause.squash(exit.cause)).code === "permission-denied";
            if (isPermissionDenied) {
              yield* removePendingAcquisition(holder, access);
              return;
            }
            const shouldRelease = yield* beginPendingRelease(holder);
            if (!shouldRelease) return;
            yield* computer.release.pipe(
              Effect.andThen(removePendingAcquisition(holder, access)),
              Effect.catch((cause) =>
                Effect.logWarning("could not release temporary desktop consent session", {
                  detail: String(cause).slice(0, 500),
                }),
              ),
              Effect.ensuring(finishTransition),
            );
          }),
      );
      return yield* presentStatus(context);
    }).pipe(
      (remembering) => Effect.raceFirst(remembering, Deferred.await(cancellation)),
      Effect.ensuring(
        Effect.sync(() => acquisitions.delete(intent)).pipe(
          Effect.andThen(Deferred.succeed(finished, undefined)),
        ),
      ),
    );
  });

  const requestView: ComputerUseCoordinatorShape["requestView"] = (context, options) =>
    options?.releaseControlToView === true
      ? releaseControlToView(context)
      : acquire(
          context,
          "view",
          undefined,
          options?.permissionPolicy,
          options?.permission,
          options?.acquireLease,
        );

  const requestControl: ComputerUseCoordinatorShape["requestControl"] = (context, options) =>
    options?.returnControlToAgent === true
      ? returnControlToAgent(context)
      : acquire(
          context,
          "control",
          options?.takeoverLeaseId,
          options?.permissionPolicy,
          options?.permission,
          options?.acquireLease,
        );

  const rememberView: ComputerUseCoordinatorShape["rememberView"] = (context) =>
    remember(context, "view");

  const rememberControl: ComputerUseCoordinatorShape["rememberControl"] = (context) =>
    remember(context, "control");

  return { requestView, requestControl, rememberView, rememberControl };
}

import { msg } from "gt-i18n";
import { m } from "../i18n/messages.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ComputerUse from "./ComputerUse.ts";
import {
  type ComputerUseCoordinatorShape,
  HUMAN_LEASE_SWEEP_INTERVAL,
  controllerKey,
  emptyLeaseState,
  leaseConflict,
  normalizeContext,
} from "./ComputerLeases.ts";
import { makeLeaseRuntime } from "./ComputerLeaseRuntime.ts";
import { makeLeaseAcquisitions } from "./ComputerLeaseAcquisition.ts";
import * as Context from "effect/Context";

export class ComputerUseCoordinator extends Context.Service<
  ComputerUseCoordinator,
  ComputerUseCoordinatorShape
>()("@t3tools/desktop/computer/ComputerUseCoordinator") {}

const make = Effect.gen(function* () {
  const runtime = yield* makeLeaseRuntime;
  const {
    computer,
    permissions,
    state,
    actionSemaphore,
    actionGeneration,
    cancelAcquisitions,
    activeAction,
    withLeaseState,
    finishTransition,
    cancelActiveAction,
    reconcileAuthority,
    expireHumanLeases,
    refreshHumanLease,
    presentStatus,
    requireView,
    startAction,
    requestAvailability,
    releaseAvailability,
  } = runtime;
  const { requestView, requestControl, rememberView, rememberControl } =
    makeLeaseAcquisitions(runtime);
  const snapshot: ComputerUseCoordinatorShape["snapshot"] = (context, input) =>
    requireView(context).pipe(
      Effect.andThen(computer.snapshot(input)),
      Effect.tap(() => permissions.require(context, "view")),
    );

  const act: ComputerUseCoordinatorShape["act"] = Effect.fn("ComputerUseCoordinator.act")(
    function* (...[context, input]: Parameters<ComputerUseCoordinatorShape["act"]>) {
      const generation = yield* Ref.get(actionGeneration);
      yield* permissions.admit(context, "control");
      yield* expireHumanLeases().pipe(Effect.ignore);
      yield* refreshHumanLease(context);
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
    yield* permissions.cancel(context);
    const key = controllerKey(context);
    const [cancelAcquiring, cleanup] = yield* withLeaseState(
      Effect.gen(function* () {
        const cancelAcquiring = cancelAcquisitions(key);
        const cleanup = yield* Ref.modify(state, (current) => {
          const pending = current.pending?.holder.key === key ? current.pending : null;
          const releasedControl = current.controller?.key === key;
          const displaced = current.displacedController?.key === key;
          if (pending === null && !releasedControl && !displaced) return [null, current] as const;
          return [
            { releasedControl, cancelNative: pending?.native === true },
            {
              ...current,
              controller: releasedControl ? null : current.controller,
              displacedController:
                releasedControl || displaced ? null : current.displacedController,
              pending: pending === null ? current.pending : null,
              activeTransitions:
                current.activeTransitions + Number(releasedControl || pending?.native === true),
            },
          ] as const;
        });
        return [cancelAcquiring, cleanup] as const;
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
    yield* permissions.cancel(context);
    const key = controllerKey(context);
    permissions.release(key);
    const [cancelAcquiring, cleanup] = yield* withLeaseState(
      Effect.gen(function* () {
        const cancelAcquiring = cancelAcquisitions(key);
        const cleanup = yield* Ref.modify(state, (current) => {
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
          const hasCleanup =
            cancelledPending || releasedControl || releaseNative || releaseAvailability;
          return [
            {
              hasCleanup,
              cancelNative: cancelledPending && current.pending?.native === true,
              releaseInputs: releasedControl && !releaseNative,
              releaseNative,
              releaseAvailability,
            },
            {
              ...current,
              viewers,
              controller,
              displacedController:
                releasedControl || current.displacedController?.key === key
                  ? null
                  : current.displacedController,
              pending,
              humanAvailability,
              activeTransitions: current.activeTransitions + Number(hasCleanup),
            },
          ] as const;
        });
        return [cancelAcquiring, cleanup] as const;
      }),
    );
    yield* Effect.gen(function* () {
      yield* cancelAcquiring;
      if (cleanup.releaseInputs || cleanup.releaseNative) yield* cancelActiveAction();
      if (cleanup.releaseNative) yield* computer.release;
      else {
        if (cleanup.cancelNative) yield* computer.cancelPendingAccess;
        if (cleanup.releaseInputs) yield* actionSemaphore.withPermits(1)(computer.releaseInputs);
      }
      if (cleanup.releaseAvailability) yield* computer.releaseAvailability;
    }).pipe(Effect.ensuring(cleanup.hasCleanup ? finishTransition : Effect.void));
    return yield* presentStatus(context);
  });

  const forceRelease: ComputerUseCoordinatorShape["forceRelease"] = Effect.fn(
    "ComputerUseCoordinator.forceRelease",
  )(function* (...[context]: Parameters<ComputerUseCoordinatorShape["forceRelease"]>) {
    yield* permissions.confirmShared(
      context,
      m(msg("End screen access for everyone and release all keep-awake requests on this desktop?")),
    );
    yield* permissions.cancelAll;
    const cancelAcquiring = yield* withLeaseState(
      Effect.gen(function* () {
        const cancelAcquiring = cancelAcquisitions();
        yield* Ref.update(state, (current) => {
          for (const key of current.viewers.keys()) permissions.release(key);
          return emptyLeaseState(current.sequence, current.activeTransitions + 1);
        });
        return cancelAcquiring;
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
      m(msg("Remove all T3 screen permissions and remembered operating-system consent?")),
    );
    yield* permissions.cancelAll;
    yield* permissions.revokeAll;
    const cancelAcquiring = yield* withLeaseState(
      Effect.gen(function* () {
        const cancelAcquiring = cancelAcquisitions();
        yield* Ref.update(state, (current) => {
          for (const key of current.viewers.keys()) permissions.release(key);
          return emptyLeaseState(current.sequence, current.activeTransitions + 1);
        });
        return cancelAcquiring;
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

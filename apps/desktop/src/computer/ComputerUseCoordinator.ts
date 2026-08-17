import type {
  ComputerAutomationActionBatchInput,
  ComputerAutomationActionResult,
  ComputerAutomationSnapshot,
  ComputerAutomationObservationOptions,
  ComputerAutomationStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ComputerUse from "./ComputerUse.ts";

const USER_DESKTOP = {
  id: "user",
  kind: "user",
  label: "Your desktop",
} as const;

interface LeaseState {
  readonly viewers: ReadonlySet<string>;
  readonly controllerId: string | null;
  readonly pending: {
    readonly controllerId: string;
    readonly access: "view" | "control";
  } | null;
}

/** Expands a remembered control grant to the view capability it necessarily includes. */
function effectiveRememberedAccess(
  access: ComputerAutomationStatus["rememberedAccess"],
): ComputerAutomationStatus["rememberedAccess"] {
  return access.includes("control") ? ["view", "control"] : access;
}

export interface ComputerUseCoordinatorShape {
  readonly status: (controllerId: string) => Effect.Effect<ComputerAutomationStatus>;
  readonly requestView: (
    controllerId: string,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly requestControl: (
    controllerId: string,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly requestAvailability: (
    controllerId: string,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly releaseAvailability: (
    controllerId: string,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly snapshot: (
    controllerId: string,
    input: ComputerAutomationObservationOptions,
  ) => Effect.Effect<ComputerAutomationSnapshot, ComputerUse.ComputerUseError>;
  readonly act: (
    controllerId: string,
    input: ComputerAutomationActionBatchInput,
  ) => Effect.Effect<ReadonlyArray<ComputerAutomationActionResult>, ComputerUse.ComputerUseError>;
  readonly release: (
    controllerId: string,
  ) => Effect.Effect<ComputerAutomationStatus, ComputerUse.ComputerUseError>;
  readonly forget: (controllerId: string) => Effect.Effect<void, ComputerUse.ComputerUseError>;
}

export class ComputerUseCoordinator extends Context.Service<
  ComputerUseCoordinator,
  ComputerUseCoordinatorShape
>()("@t3tools/desktop/computer/ComputerUseCoordinator") {}

/** Creates exclusive control and shared viewing leases for the user's desktop. */
export const make = Effect.gen(function* () {
  const computer = yield* ComputerUse.ComputerUse;
  const state = yield* Ref.make<LeaseState>({
    viewers: new Set(),
    controllerId: null,
    pending: null,
  });
  const leaseSemaphore = yield* Semaphore.make(1);

  const withLeaseState = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    leaseSemaphore.withPermits(1)(effect);

  const presentStatus = Effect.fn("ComputerUseCoordinator.presentStatus")(function* (
    controllerId: string,
  ) {
    const [status, leases] = yield* Effect.all([computer.status, Ref.get(state)]);
    const rememberedAccess = effectiveRememberedAccess(status.rememberedAccess);
    const hasView = leases.viewers.has(controllerId) || leases.controllerId === controllerId;
    const permission =
      leases.controllerId === controllerId
        ? status.permission
        : hasView && (status.permission === "granted" || status.permission === "view-only")
          ? ("view-only" as const)
          : status.permission === "granted" || status.permission === "view-only"
            ? rememberedAccess.length > 0
              ? ("remembered" as const)
              : ("prompt-required" as const)
            : status.permission;
    return { ...status, desktop: USER_DESKTOP, permission, rememberedAccess };
  });

  const requireView = Effect.fn("ComputerUseCoordinator.requireView")(function* (
    controllerId: string,
  ) {
    const leases = yield* Ref.get(state);
    if (leases.controllerId === controllerId || leases.viewers.has(controllerId)) return;
    return yield* new ComputerUse.ComputerUseLeaseError({
      code: "desktop-lease-required",
      cause: "the controller has no view lease for this desktop",
    });
  });

  const requireControl = Effect.fn("ComputerUseCoordinator.requireControl")(function* (
    controllerId: string,
  ) {
    const leases = yield* Ref.get(state);
    if (leases.controllerId === controllerId) return;
    return yield* new ComputerUse.ComputerUseLeaseError({
      code: leases.controllerId === null ? "desktop-lease-required" : "desktop-busy",
      cause:
        leases.controllerId === null
          ? "the controller has no control lease for this desktop"
          : "another controller holds the desktop control lease",
    });
  });

  const beginAcquisition = Effect.fn("ComputerUseCoordinator.beginAcquisition")(function* (
    controllerId: string,
    access: "view" | "control",
  ) {
    return yield* withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const alreadyHeld =
          access === "view"
            ? current.viewers.has(controllerId) || current.controllerId === controllerId
            : current.controllerId === controllerId;
        if (alreadyHeld) return false;
        if (
          current.pending !== null ||
          (access === "control" &&
            current.controllerId !== null &&
            current.controllerId !== controllerId)
        ) {
          return yield* new ComputerUse.ComputerUseLeaseError({
            code: "desktop-busy",
            cause: "another controller holds or is acquiring desktop access",
          });
        }
        yield* Ref.set(state, {
          ...current,
          pending: { controllerId, access },
        });
        return true;
      }),
    );
  });

  const removePendingAcquisition = (controllerId: string, access: "view" | "control") =>
    withLeaseState(
      Ref.update(state, (current) =>
        current.pending?.controllerId === controllerId && current.pending.access === access
          ? { ...current, pending: null }
          : current,
      ),
    );

  const finishAcquisition = Effect.fn("ComputerUseCoordinator.finishAcquisition")(function* (
    controllerId: string,
    access: "view" | "control",
  ) {
    const completed = yield* withLeaseState(
      Ref.modify(state, (current) => {
        if (current.pending?.controllerId !== controllerId || current.pending.access !== access) {
          return [false, current] as const;
        }
        return [
          true,
          {
            viewers: new Set(current.viewers).add(controllerId),
            controllerId: access === "control" ? controllerId : current.controllerId,
            pending: null,
          },
        ] as const;
      }),
    );
    if (completed) return;
    yield* computer.release.pipe(Effect.ignore);
    return yield* new ComputerUse.ComputerUseLeaseError({
      code: "request-cancelled",
      cause: "desktop access was released while authorization was pending",
    });
  });

  const acquire = Effect.fn("ComputerUseCoordinator.acquire")(function* (
    controllerId: string,
    access: "view" | "control",
  ) {
    const shouldAcquire = yield* beginAcquisition(controllerId, access);
    if (!shouldAcquire) return yield* presentStatus(controllerId);
    const nativeAccess =
      access === "control"
        ? computer.requestControl
        : computer.status.pipe(
            Effect.flatMap((status) =>
              status.permission === "remembered" &&
              status.rememberedAccess.includes("control") &&
              !status.rememberedAccess.includes("view")
                ? computer.requestControl
                : computer.requestView,
            ),
          );
    yield* nativeAccess.pipe(
      Effect.tap(() => finishAcquisition(controllerId, access)),
      Effect.ensuring(removePendingAcquisition(controllerId, access)),
    );
    return yield* presentStatus(controllerId);
  });

  const requestView: ComputerUseCoordinatorShape["requestView"] = (controllerId) =>
    acquire(controllerId, "view");

  const requestControl: ComputerUseCoordinatorShape["requestControl"] = (controllerId) =>
    acquire(controllerId, "control");

  const requestAvailability: ComputerUseCoordinatorShape["requestAvailability"] = (controllerId) =>
    computer.requestAvailability.pipe(Effect.andThen(presentStatus(controllerId)));

  const releaseAvailability: ComputerUseCoordinatorShape["releaseAvailability"] = (controllerId) =>
    computer.releaseAvailability.pipe(Effect.andThen(presentStatus(controllerId)));

  const snapshot: ComputerUseCoordinatorShape["snapshot"] = (controllerId, input) =>
    requireView(controllerId).pipe(Effect.andThen(computer.snapshot(input)));

  const act: ComputerUseCoordinatorShape["act"] = (controllerId, input) =>
    requireControl(controllerId).pipe(Effect.andThen(computer.act(input)));

  const release: ComputerUseCoordinatorShape["release"] = (controllerId) =>
    Effect.gen(function* () {
      const released = yield* withLeaseState(
        Ref.modify(state, (current) => {
          const cancelledPending = current.pending?.controllerId === controllerId;
          const releasedControl = current.controllerId === controllerId;
          const viewers = new Set(current.viewers);
          viewers.delete(controllerId);
          const next: LeaseState = cancelledPending
            ? { viewers: new Set(), controllerId: null, pending: null }
            : {
                viewers,
                controllerId: releasedControl ? null : current.controllerId,
                pending: current.pending,
              };
          return [
            {
              cancelledPending,
              releasedControl,
              releaseNative:
                cancelledPending ||
                (next.pending === null && next.controllerId === null && next.viewers.size === 0),
            },
            next,
          ] as const;
        }),
      );
      if (released.cancelledPending) {
        yield* computer.release;
      } else {
        if (released.releasedControl) yield* computer.releaseInputs;
        if (released.releaseNative) yield* computer.release;
      }
      return yield* presentStatus(controllerId);
    });

  const forget: ComputerUseCoordinatorShape["forget"] = (controllerId) =>
    withLeaseState(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (
          (current.controllerId !== null && current.controllerId !== controllerId) ||
          (current.pending !== null && current.pending.controllerId !== controllerId)
        ) {
          return yield* new ComputerUse.ComputerUseLeaseError({
            code: "desktop-busy",
            cause: "another controller holds the desktop control lease",
          });
        }
        yield* Ref.set(state, {
          viewers: new Set<string>(),
          controllerId: null,
          pending: null,
        });
        yield* computer.forget;
      }),
    );

  return ComputerUseCoordinator.of({
    status: presentStatus,
    requestView,
    requestControl,
    requestAvailability,
    releaseAvailability,
    snapshot,
    act,
    release,
    forget,
  });
});

export const layer = Layer.effect(ComputerUseCoordinator, make);

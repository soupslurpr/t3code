// @effect-diagnostics nodeBuiltinImport:off - Private QEMU sockets and per-observation identifiers belong to the host adapter.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  ComputerAutomationAccessInput,
  ComputerAutomationActInput,
  type ComputerAutomationDisplay,
  type ComputerAutomationObservationOptions,
  type ComputerAutomationActionResult,
  type ComputerAutomationStatus,
  type AgentDesktop,
} from "@t3tools/contracts";
import {
  captureComputerTemporalFrame,
  captureComputerTemporalSequence,
} from "@t3tools/shared/computerTemporalCapture";
import { captureAgentFrame, type AgentDesktopRuntimePort } from "../computer/AgentComputerHost.ts";
import { connectPrivateFrameSocket } from "../computer/DesktopFrame.ts";
import { hostFailure, type DesktopCaller } from "../computer/ComputerHostConnection.ts";
import { agentIo, ownerOf } from "./AgentEffects.ts";
import { makeGuestAccessibility, type GuestAccessibility } from "./GuestAccessibility.ts";
import { makeGuestActions, type InputState } from "./GuestActions.ts";
import type { DesktopLifecycle, DesktopLease, GuestIo } from "./MachinePorts.ts";
import type { GuestTools } from "./GuestTools.ts";

const decodeAccess = Schema.decodeEffect(ComputerAutomationAccessInput);
const decodeAct = Schema.decodeUnknownEffect(ComputerAutomationActInput);
type ControllerState = InputState & {
  semantics: GuestAccessibility;
  view: boolean;
};
const defaultDisplay = (): ComputerAutomationDisplay => ({
  id: "agent-display",
  label: "Agent desktop",
  primary: true,
  bounds: { x: 0, y: 0, width: 1600, height: 900 },
  scaleFactor: 1,
});
export const makeGuestDisplay = Effect.fn("GuestDisplay.make")(function* (
  lifecycle: DesktopLifecycle,
  guest: GuestIo,
  tools: GuestTools,
): Effect.fn.Return<AgentDesktopRuntimePort, never, Scope.Scope> {
  const serial = yield* KeyedLock.make<string>();
  const sessions = new Map<string, ControllerState>();
  const humanLeases = new Map<string, { caller: DesktopCaller; id: string; renewedAt: number }>();
  const identity = (caller: DesktopCaller, id: string) =>
    [id, caller.environmentId, caller.threadId, ownerOf(caller).controllerId].join("\0");
  const stateFor = (caller: DesktopCaller, lease: DesktopLease) => {
    const key = identity(caller, lease.desktop.id);
    let state = sessions.get(key);
    if (!state) {
      state = {
        display: defaultDisplay(),
        frames: new Map(),
        held: new Map(),
        pointer: null,
        semantics: makeGuestAccessibility(tools, lease.paths),
        view: false,
      };
      sessions.set(key, state);
    }
    return state;
  };
  const status = (caller: DesktopCaller, desktop: AgentDesktop): ComputerAutomationStatus => {
    const state = sessions.get(identity(caller, desktop.id));
    const control = desktop.controllerId === ownerOf(caller).controllerId;
    const view = control || state?.view === true;
    return {
      desktop: { id: desktop.id, label: desktop.label, kind: "agent" },
      available: true,
      backend: "qemu-agent-desktop",
      permission: control ? "granted" : view ? "view-only" : "remembered",
      rememberedAccess: ["view", "control"],
      displayState: desktop.state === "active" || desktop.state === "ready" ? "active" : "unknown",
      keepAwake: !desktop.automaticParking,
      displays: [state?.display ?? defaultDisplay()],
      cursor: state?.pointer ?? null,
      lease: {
        access: control ? "control" : view ? "view" : "none",
        controller: desktop.controllerId
          ? {
              kind: desktop.controllerId === desktop.owner.controllerId ? "agent" : "human",
              sameEnvironment: true,
              threadId: desktop.owner.threadId,
            }
          : null,
        canReturnControl:
          control && caller.controllerKind === "human" && desktop.canReturnControl === true,
      },
    };
  };
  const begin = (caller: DesktopCaller, id: string, permission: "owned" | "view" | "control") =>
    Effect.acquireRelease(
      agentIo(() =>
        lifecycle.begin(ownerOf(caller), id, permission, caller.controllerKind === "human"),
      ),
      (lease) => Effect.promise(() => lease.release()),
    );
  const releaseHeld = Effect.fn("GuestDisplay.releaseHeld")(function* (
    caller: DesktopCaller,
    id: string,
  ) {
    const state = sessions.get(identity(caller, id));
    if (state?.held.size) {
      const lease = yield* begin(caller, id, "control");
      yield* agentIo((signal) =>
        makeGuestActions(guest, lease.paths, state, state.semantics, tools, signal).release(),
      );
    }
  });
  const release = Effect.fn("GuestDisplay.release")(function* (caller: DesktopCaller, id: string) {
    yield* releaseHeld(caller, id);
    const desktop = yield* agentIo(() =>
      lifecycle.lease(ownerOf(caller), id, "release", caller.controllerKind === "human"),
    );
    const key = identity(caller, id);
    sessions.delete(key);
    humanLeases.delete(key);
    return status(caller, desktop);
  });
  const renew = Effect.fn("GuestDisplay.renew")(function* (caller: DesktopCaller, id: string) {
    if (caller.controllerKind === "human")
      humanLeases.set(identity(caller, id), {
        caller,
        id,
        renewedAt: yield* Clock.currentTimeMillis,
      });
  });
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [key, lease] of humanLeases) {
      if (now - lease.renewedAt < 30_000) continue;
      yield* serial
        .withLock(
          lease.id,
          Effect.suspend(() =>
            humanLeases.get(key) === lease
              ? Effect.scoped(release(lease.caller, lease.id))
              : Effect.void,
          ),
        )
        .pipe(Effect.ignore);
    }
  }).pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.forkScoped);
  const frame = Effect.fn("GuestDisplay.frame")(function* (
    lease: DesktopLease,
    state: ControllerState,
    options: ComputerAutomationObservationOptions,
  ) {
    if (options.displayId && options.displayId !== state.display.id)
      return yield* hostFailure("capture-failed", "invalid-input", "Unknown Agent display.");
    const accessibility =
      options.includeAccessibility === false
        ? undefined
        : yield* agentIo(() => state.semantics.snapshot());
    const socket = yield* connectPrivateFrameSocket(lease.paths.vncSocket).pipe(
      Effect.mapError((e) => hostFailure("capture-failed", "resource", e.message)),
    );
    return {
      socket,
      display: state.display,
      frameId: "agent-frame-" + NodeCrypto.randomUUID(),
      pointer: state.pointer,
      sourceFrames: [...state.frames.values()],
      ...(accessibility ? { accessibility } : {}),
      remember: (
        frames: readonly import("@t3tools/contracts").ComputerAutomationFrame[],
        display: ComputerAutomationDisplay,
      ) =>
        Effect.sync(() => {
          if (
            state.display.bounds.width !== display.bounds.width ||
            state.display.bounds.height !== display.bounds.height
          )
            state.frames.clear();
          state.display = display;
          for (const f of frames) state.frames.set(f.id, f);
          while (state.frames.size > 40) {
            const first = state.frames.keys().next();
            if (first.done) break;
            state.frames.delete(first.value);
          }
        }),
    };
  });
  const openCapture: AgentDesktopRuntimePort["openCapture"] = Effect.fn("GuestDisplay.openCapture")(
    function* (caller, input) {
      const id = input.desktop.desktopId;
      return yield* serial.withLock(
        id,
        Effect.gen(function* () {
          const lease = yield* begin(caller, id, "view");
          yield* renew(caller, id);
          return yield* frame(lease, stateFor(caller, lease), input);
        }),
      );
    },
  );
  const snap = Effect.fn("GuestDisplay.snapshot")(function* (
    lease: DesktopLease,
    state: ControllerState,
    options: ComputerAutomationObservationOptions,
  ) {
    if (options.delayMs) yield* Effect.sleep(options.delayMs);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        return yield* captureAgentFrame(
          lease.desktop.id,
          options,
          yield* frame(lease, state, options),
        );
      }),
    );
  });
  const invalid = () =>
    hostFailure("invalid-action", "invalid-input", "Invalid Agent desktop request.");
  const invoke: AgentDesktopRuntimePort["invoke"] = Effect.fn("GuestDisplay.invoke")(
    function* (caller, operation, params) {
      if (params.desktop.kind !== "agent") return yield* invalid();
      const owner = ownerOf(caller);
      if (operation === "computerRequestView" || operation === "computerRequestControl") {
        const input = yield* decodeAccess(params).pipe(Effect.mapError(invalid));
        if (input.desktop.kind !== "agent") return yield* invalid();
        const access = operation === "computerRequestControl" ? "control" : "view";
        const selection = input.desktop;
        const id = yield* agentIo(async () => {
          if (caller.controllerKind === "human") {
            if (!selection.desktopId) throw invalid();
            return selection.desktopId;
          }
          let id = access === "view" ? selection.desktopId : undefined;
          if (access === "view" && !id && !selection.fresh) {
            const available = (await lifecycle.list(owner)).filter(
              (row) => !["recoverable", "deleting", "failed"].includes(row.state),
            );
            id = available.find((row) => row.owner.controllerId === owner.controllerId)?.id;
            if (!id && available.length > 1)
              throw hostFailure(
                "invalid-action",
                "invalid-input",
                "Select the Agent desktop to view by id.",
              );
            id ??= available[0]?.id;
          }
          return id ?? (await lifecycle.acquire(owner, selection)).id;
        });
        return yield* serial.withLock(
          id,
          Effect.scoped(
            Effect.gen(function* () {
              const human = caller.controllerKind === "human";
              if (human && access === "control") {
                if (input.returnControlToAgent) yield* releaseHeld(caller, id);
                else {
                  const assigned = yield* agentIo(() =>
                    lifecycle.resolveOwner(owner.environmentId, id),
                  );
                  if (assigned.threadId !== caller.threadId) return yield* invalid();
                  yield* releaseHeld({ ...assigned, controllerKind: "agent" }, id);
                }
              }
              const change = human && input.returnControlToAgent ? "return-control" : access;
              const desktop = yield* agentIo(() => lifecycle.lease(owner, id, change, human));
              yield* renew(caller, id);
              const lease = yield* begin(caller, id, change === "return-control" ? "view" : access);
              const state = stateFor(caller, lease);
              state.view = true;
              const snapshot =
                input.observation === false
                  ? undefined
                  : yield* snap(lease, state, input.observation ?? {});
              return { status: status(caller, desktop), ...(snapshot ? { snapshot } : {}) };
            }),
          ),
        );
      }
      const id = params.desktop.desktopId;
      if (!id) return yield* invalid();
      if (operation === "computerRelease" || operation === "computerForgetControl") {
        const released = yield* serial.withLock(id, Effect.scoped(release(caller, id)));
        return operation === "computerForgetControl" ? undefined : released;
      }
      if (operation === "computerStatus") {
        const desktop = (yield* agentIo(() => lifecycle.list(owner))).find((d) => d.id === id);
        if (!desktop)
          return yield* hostFailure(
            "permission-denied",
            "authorization",
            "Agent desktop unavailable to this thread.",
          );
        return status(caller, desktop);
      }
      if (operation !== "computerAct") return yield* invalid();
      const input = yield* decodeAct(params).pipe(Effect.mapError(invalid));
      const key = identity(caller, id);
      const state = sessions.get(key);
      if (!state)
        return yield* hostFailure(
          "desktop-lease-required",
          "authorization",
          "Acquire control of this Agent desktop first.",
        );
      return yield* serial.withLock(
        id,
        Effect.scoped(
          Effect.gen(function* () {
            if (sessions.get(key) !== state)
              return yield* hostFailure(
                "desktop-lease-required",
                "authorization",
                "The Agent desktop control lease has ended.",
              );
            const lease = yield* begin(caller, id, "control");
            yield* renew(caller, id);
            const signal = yield* Effect.abortSignal;
            const actions = makeGuestActions(
              guest,
              lease.paths,
              state,
              state.semantics,
              tools,
              signal,
            );
            const temporal = input.temporalObservation;
            const capture = temporal
              ? {
                  capture: temporal,
                  snapshot: snap(lease, state, {
                    includeAccessibility: false,
                    ...(temporal.screenshot ? { screenshot: temporal.screenshot } : {}),
                    ...(temporal.displayId ? { displayId: temporal.displayId } : {}),
                  }),
                }
              : undefined;
            const startedAtMs = yield* Clock.currentTimeMillis;
            const firstFrame =
              capture && temporal?.start !== "after-actions"
                ? yield* captureComputerTemporalFrame({ ...capture, index: 0, startedAtMs })
                : undefined;
            const results: ComputerAutomationActionResult[] = [];
            for (const [index, a] of input.actions.entries()) {
              if (a.type !== "wait_for_change") {
                results.push(
                  yield* agentIo(() => actions.run(a, index)).pipe(
                    Effect.onError(() => agentIo(() => actions.release()).pipe(Effect.ignore)),
                  ),
                );
                continue;
              }
              const { frameId, x, y, width, height } = a;
              const source = state.frames.get(frameId);
              if (!source) return yield* invalid();
              // Use a stable desktop region so samples do not evict the input frame mid-wait.
              const t = source.toDesktopLogical;
              if (x + width > source.width || y + height > source.height) return yield* invalid();
              const region = {
                coordinateSpace: "desktop-logical" as const,
                displayId: source.displayId,
                x: Math.floor(x * t.scaleX + t.offsetX),
                y: Math.floor(y * t.scaleY + t.offsetY),
                width: Math.max(1, Math.round(width * t.scaleX)),
                height: Math.max(1, Math.round(height * t.scaleY)),
              };
              const sample = snap(lease, state, {
                includeAccessibility: false,
                screenshot: { region, maxWidth: 480, maxHeight: 270 },
              });
              const hash = (yield* sample).screenshot?.contentHash;
              const start = yield* Clock.currentTimeMillis;
              let elapsedMs = 0,
                samples = 1,
                changed = false;
              while (elapsedMs < a.timeoutMs && !changed) {
                yield* Effect.sleep(Math.min(a.pollIntervalMs ?? 250, a.timeoutMs - elapsedMs));
                changed = (yield* sample).screenshot?.contentHash !== hash;
                samples++;
                elapsedMs = Math.min(a.timeoutMs, (yield* Clock.currentTimeMillis) - start);
              }
              results.push({ index, type: a.type, changed, elapsedMs, samples });
            }
            const sequence = capture
              ? yield* captureComputerTemporalSequence({
                  ...capture,
                  ...(firstFrame ? { firstFrame, startedAtMs } : {}),
                })
              : undefined;
            const snapshot =
              input.observation === false
                ? undefined
                : yield* snap(lease, state, { delayMs: 250, ...input.observation });
            return {
              actionResults: results,
              ...(snapshot ? { snapshot } : {}),
              ...(sequence ? { temporalSequence: sequence } : {}),
            };
          }),
        ),
      );
    },
  );
  return { invoke, openCapture };
});

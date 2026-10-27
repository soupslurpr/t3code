import type {
  ComputerAutomationAction,
  ComputerAutomationLeaseId,
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  ComputerObservation,
  ComputerObservationId,
  ComputerObservationList,
  ComputerObservationUpdate,
  UserDesktopHumanInvokeInput,
} from "@t3tools/contracts";
import { retainMobileDesktopImage } from "./UserDesktopSupervisionRouteScreen.logic";

export interface MobileDesktopSupervisionState {
  readonly status: ComputerAutomationStatus | null;
  readonly liveStarted: boolean;
  readonly mode: "live" | "lens";
  readonly snapshot: ComputerAutomationSnapshot | null;
  readonly observations: ComputerObservationList["observations"];
  readonly selectedObservationId: ComputerObservationId | null;
  readonly agentObservation: ComputerObservation | null;
  readonly selectedDisplayId: string | null;
  readonly busy: boolean;
  readonly error: string | null;
}

export const emptyMobileDesktopSupervision: MobileDesktopSupervisionState = {
  status: null,
  liveStarted: false,
  mode: "lens",
  snapshot: null,
  observations: [],
  selectedObservationId: null,
  agentObservation: null,
  selectedDisplayId: null,
  busy: true,
  error: null,
};

type Request = <Value>(input: UserDesktopHumanInvokeInput) => Promise<Value>;
export function createMobileDesktopSupervision(input: {
  readonly desktopId: string;
  readonly accessQueue: { current: Promise<void> };
  readonly run: Request;
  readonly onChange: (state: MobileDesktopSupervisionState) => void;
  readonly isGestureActive: () => boolean;
  readonly foreground: boolean;
}) {
  const { desktopId, run } = input;
  let state = emptyMobileDesktopSupervision;
  let disposed = false;
  let foreground = input.foreground;
  let generation = 0;
  let actionQueue = Promise.resolve();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const current = (token: number) => !disposed && foreground && token === generation;
  const update = (change: Partial<MobileDesktopSupervisionState>) => {
    if (disposed) return;
    state = { ...state, ...change };
    input.onChange(state);
  };
  const enqueueAccess = (operation: () => Promise<void>) => {
    const next = input.accessQueue.current.then(operation, operation);
    input.accessQueue.current = next.catch(() => undefined);
    return next;
  };
  const release = () =>
    run({ request: { operation: "release", desktopId } }).catch(() => undefined);
  const command = async (operation: (token: number) => Promise<void>, busy = true) => {
    const token = generation;
    if (!current(token)) return;
    if (busy) update({ busy: true, error: null });
    try {
      await operation(token);
    } catch (cause) {
      if (current(token))
        update({
          error: cause instanceof Error ? cause.message : "The User desktop request failed.",
        });
    } finally {
      if (current(token) && busy) update({ busy: false });
    }
  };
  const refresh = () =>
    command(async (token) => {
      const [status, list] = await Promise.all([
        run<ComputerAutomationStatus>({ request: { operation: "status", desktopId } }),
        run<ComputerObservationList>({ request: { operation: "observation-list", desktopId } }),
      ]);
      if (!current(token)) return;
      const controller = status.lease?.controller;
      const selected =
        list.observations.find((item) => item.id === state.selectedObservationId) ??
        list.observations.find(
          (item) =>
            controller?.kind === "agent" &&
            controller.sameEnvironment &&
            item.threadId === controller.threadId,
        ) ??
        list.observations[0];
      const agentObservation =
        selected === undefined
          ? null
          : selected.id === state.selectedObservationId && state.agentObservation !== null
            ? state.agentObservation
            : ((
                await run<ComputerObservationUpdate>({
                  request: { operation: "observation", desktopId, observationId: selected.id },
                })
              ).observation ?? null);
      if (!current(token)) return;
      update({
        status,
        observations: list.observations,
        selectedObservationId: selected?.id ?? null,
        agentObservation,
        selectedDisplayId:
          state.selectedDisplayId ??
          status.displays.find((display) => display.primary)?.id ??
          status.displays[0]?.id ??
          null,
        mode: agentObservation === null && !state.liveStarted ? "live" : state.mode,
        busy: false,
      });
    }, false);
  const capture = async (token: number) => {
    const displayId = state.selectedDisplayId;
    const contentHash =
      state.snapshot?.screenshot?.state === "image"
        ? state.snapshot.screenshot.contentHash
        : undefined;
    const next = await run<ComputerAutomationSnapshot>({
      request: {
        operation: "snapshot",
        desktopId,
        input: {
          ...(displayId === null ? {} : { displayId }),
          includeAccessibility: false,
          screenshot: {
            maxWidth: 1280,
            maxHeight: 720,
            ...(contentHash === undefined ? {} : { unchangedIfContentHash: contentHash }),
          },
        },
      },
    });
    if (current(token) && state.liveStarted && displayId === state.selectedDisplayId)
      update({
        snapshot: retainMobileDesktopImage(state.snapshot, next),
        selectedDisplayId: next.display.id,
      });
  };
  const startLive = (displayId?: string) =>
    command((token) =>
      enqueueAccess(async () => {
        if (!current(token)) return;
        const status = await run<ComputerAutomationStatus>({
          request: { operation: "request-view", desktopId },
          timeoutMs: 120000,
        });
        if (!current(token)) return;
        update({
          status,
          liveStarted: true,
          mode: "live",
          snapshot: null,
          selectedDisplayId:
            displayId ??
            state.selectedDisplayId ??
            status.displays.find((display) => display.primary)?.id ??
            status.displays[0]?.id ??
            null,
        });
        try {
          await capture(token);
        } catch (cause) {
          await release();
          if (current(token)) update({ liveStarted: false, snapshot: null });
          throw cause;
        }
      }),
    );
  const stop = async () => {
    generation++;
    update({ liveStarted: false, snapshot: null, status: null, busy: false });
    await enqueueAccess(async () => {
      await release();
    });
  };
  const schedule = (operation: () => Promise<void>, delay: number) => {
    if (disposed) return;
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (disposed) return;
      await operation();
      schedule(operation, delay);
    }, delay);
    timers.add(timer);
  };
  input.onChange(state);
  void refresh();
  schedule(refresh, 2000);
  schedule(
    () =>
      state.liveStarted && !input.isGestureActive() ? command(capture, false) : Promise.resolve(),
    750,
  );
  return {
    read: () => state,
    refresh,
    startLive,
    stop,
    setMode: (mode: "live" | "lens") => update({ mode }),
    selectDisplay: (displayId: string) =>
      !state.liveStarted
        ? startLive(displayId)
        : command(async (token) => {
            update({ selectedDisplayId: displayId, snapshot: null, mode: "live" });
            await capture(token);
          }),
    selectObservation: (observationId: ComputerObservationId) =>
      command(async (token) => {
        const result = await run<ComputerObservationUpdate>({
          request: { operation: "observation", desktopId, observationId },
        });
        if (current(token))
          update({
            selectedObservationId: observationId,
            agentObservation: result.observation ?? null,
            mode: "lens",
          });
      }),
    takeControl: (takeoverLeaseId?: ComputerAutomationLeaseId) =>
      command((token) =>
        enqueueAccess(async () => {
          if (!current(token)) return;
          if (!state.liveStarted) return;
          const status = await run<ComputerAutomationStatus>({
            request: {
              operation: "request-control",
              desktopId,
              ...(takeoverLeaseId === undefined ? {} : { takeoverLeaseId }),
            },
            timeoutMs: 120000,
          });
          if (!current(token)) return;
          update({ status });
        }),
      ),
    changeControl: (operation: "release-control" | "return-control") =>
      command((token) =>
        enqueueAccess(async () => {
          if (!current(token)) return;
          const status = await run<ComputerAutomationStatus>({ request: { operation, desktopId } });
          if (current(token)) update({ status });
        }),
      ),
    endAllAccess: () =>
      command(async (token) => {
        await run({ request: { operation: "end-all-access", desktopId } });
        if (current(token)) {
          await stop();
          await refresh();
        }
      }),
    act: (actions: ReadonlyArray<ComputerAutomationAction>) => {
      const token = generation;
      const execute = () =>
        command(async () => {
          if (!current(token) || state.status?.lease?.access !== "control") return;
          await run({
            request: {
              operation: "act",
              desktopId,
              input: { actions: [...actions], observation: false },
            },
          });
          if (current(token) && state.liveStarted) await capture(token);
        }, false);
      actionQueue = actionQueue.then(execute, execute);
      return actionQueue;
    },
    setForeground: (active: boolean) => {
      if (active === foreground || disposed) return;
      foreground = active;
      if (active) void refresh();
      else void stop();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation++;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      void enqueueAccess(async () => {
        await release();
      });
    },
  };
}

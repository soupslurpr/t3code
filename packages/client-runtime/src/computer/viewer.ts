// @effect-diagnostics globalTimers:off - The visible desktop viewer schedules browser and native captures outside an Effect runtime.
import type {
  ComputerAutomationAccess,
  ComputerAutomationAction,
  ComputerAutomationSnapshot,
  ComputerObservationSummary,
} from "@t3tools/contracts";
import { createViewerKeys } from "./viewerKeys.ts";

export function selectDesktopObservation(
  rows: readonly ComputerObservationSummary[],
  selectedId: string | null,
) {
  return selectedId === null ? rows[0] : rows.find((row) => row.id === selectedId);
}

interface ViewerTransport {
  request(access: ComputerAutomationAccess): Promise<unknown>;
  snapshot(knownHash?: string): Promise<ComputerAutomationSnapshot>;
  act(actions: readonly ComputerAutomationAction[]): Promise<unknown>;
  release(): Promise<unknown>;
  onFrame(snapshot: ComputerAutomationSnapshot): void;
  onError(error: unknown): void;
}

/** One instance owns one visible viewer, its in-flight capture and its input queue. */
export function createDesktopViewer(transport: ViewerTransport) {
  let access: ComputerAutomationAccess | null = null;
  let closed = false;
  let acceptingKeys = false;
  let epoch = 0;
  let hash: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => {
    const result = tail.then(work);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const keys = createViewerKeys(async (action) => {
    await transport.act([action]);
  });
  const capture = async (generation: number) => {
    const frame = await transport.snapshot(hash);
    if (closed || epoch !== generation) return;
    if (frame.screenshot) hash = frame.screenshot.contentHash;
    transport.onFrame(frame);
    // A successful snapshot renews the human lease without reacquiring displaced control.
    timer = setTimeout(() => {
      void serial(async () => {
        if (!closed && epoch === generation) await capture(generation);
      }).catch(transport.onError);
    }, 1500);
  };
  return {
    keys: {
      down(physicalKey: string, key: string) {
        return acceptingKeys ? keys.down(physicalKey, key) : Promise.resolve();
      },
      up: keys.up,
    },
    blur: keys.blur,
    open(requested: ComputerAutomationAccess) {
      acceptingKeys = false;
      const generation = ++epoch;
      clearTimeout(timer);
      return serial(async () => {
        if (closed || epoch !== generation) return;
        await keys.blur();
        await transport.request(requested);
        access = requested;
        acceptingKeys = !closed && epoch === generation && access === "control";
        if (!closed && epoch === generation) await capture(generation);
      });
    },
    act(actions: readonly ComputerAutomationAction[]) {
      return serial(async () => {
        if (!closed && access === "control") await transport.act(actions);
      });
    },
    close() {
      closed = true;
      acceptingKeys = false;
      ++epoch;
      clearTimeout(timer);
      return serial(async () => {
        try {
          await keys.close();
        } finally {
          if (access !== null) await transport.release();
          access = null;
        }
      });
    },
  };
}

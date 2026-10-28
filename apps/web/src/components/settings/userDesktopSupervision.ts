import type {
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  ComputerObservationList,
  ComputerObservationUpdate,
  UserDesktopHumanInvokeInput,
} from "@t3tools/contracts";

export type UserDesktopSupervisionRequest = <Value>(
  input: UserDesktopHumanInvokeInput,
) => Promise<Value>;

export async function readUserDesktopSupervision(
  run: UserDesktopSupervisionRequest,
  desktopId: string,
) {
  const [status, list] = await Promise.all([
    run<ComputerAutomationStatus>({ request: { operation: "status", desktopId } }),
    run<ComputerObservationList>({ request: { operation: "observation-list", desktopId } }),
  ]);
  const controller = status.lease?.controller;
  const selectedObservation =
    list.observations.find(
      (item) =>
        controller?.kind === "agent" &&
        controller.sameEnvironment &&
        item.threadId === controller.threadId,
    ) ?? list.observations[0];
  const agentObservation =
    selectedObservation === undefined
      ? null
      : ((
          await run<ComputerObservationUpdate>({
            request: {
              operation: "observation",
              desktopId,
              observationId: selectedObservation.id,
            },
          })
        ).observation ?? null);
  return { status, list, selectedObservation, agentObservation };
}

export function retainUnchangedImage(
  current: ComputerAutomationSnapshot | null,
  next: ComputerAutomationSnapshot,
): ComputerAutomationSnapshot {
  return next.screenshot?.state === "unchanged" &&
    current?.screenshot?.state === "image" &&
    next.screenshot.contentHash === current.screenshot.contentHash
    ? { ...next, screenshot: current.screenshot }
    : next;
}

export async function requestUserDesktopLive(
  run: UserDesktopSupervisionRequest,
  desktopId: string,
  displayId: string | null,
  isCurrent: () => boolean,
) {
  const release = () =>
    run({ request: { operation: "release", desktopId } }).catch(() => undefined);
  const status = await run<ComputerAutomationStatus>({
    request: { operation: "request-view", desktopId },
    timeoutMs: 120_000,
  });
  if (!isCurrent()) {
    await release();
    return null;
  }
  try {
    const selectedDisplay =
      displayId ?? status.displays.find((display) => display.primary)?.id ?? status.displays[0]?.id;
    const observation = await run<ComputerAutomationSnapshot>({
      request: {
        operation: "snapshot",
        desktopId,
        input: {
          ...(selectedDisplay === undefined ? {} : { displayId: selectedDisplay }),
          includeAccessibility: false,
          screenshot: { maxWidth: 1_280, maxHeight: 720 },
        },
      },
    });
    if (!isCurrent()) {
      await release();
      return null;
    }
    return { status, observation };
  } catch (cause) {
    await release();
    throw cause;
  }
}

export function mountUserDesktopSupervision(input: {
  readonly document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  readonly isLive: () => boolean;
  readonly capture: () => Promise<void>;
  readonly metadata: () => Promise<void>;
  readonly release: () => Promise<void>;
  readonly onHidden: () => void;
  readonly onError: (cause: unknown) => void;
}) {
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const schedule = (operation: () => Promise<void>, delay: number) => {
    if (disposed) return;
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (disposed) return;
      try {
        await operation();
      } catch (cause) {
        if (!disposed) input.onError(cause);
      }
      schedule(operation, delay);
    }, delay);
    timers.add(timer);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    input.document.removeEventListener("visibilitychange", onVisibility);
    void input.release().catch(() => undefined);
  };
  const onVisibility = () => {
    if (input.document.visibilityState !== "hidden") return;
    dispose();
    input.onHidden();
  };
  input.document.addEventListener("visibilitychange", onVisibility);
  schedule(async () => {
    if (input.document.visibilityState === "visible" && input.isLive()) await input.capture();
  }, 750);
  schedule(async () => {
    if (input.document.visibilityState === "visible") await input.metadata();
  }, 2_000);
  return dispose;
}

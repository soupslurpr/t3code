import type { ComputerAutomationAccess } from "@t3tools/contracts";

interface Viewer {
  open(access: ComputerAutomationAccess): Promise<void>;
  close(): Promise<void>;
}

/** The next route cannot acquire a lease while the previous screen is draining input. */
export function createMobileViewerSlot() {
  let current: Viewer | null = null;
  let closing: Promise<void> = Promise.resolve();
  const close = (viewer: Viewer) => {
    if (current !== viewer) return closing;
    current = null;
    const previous = closing;
    const drain = viewer.close();
    const released = Promise.allSettled([previous, drain]);
    closing = released.then(([, result]) => {
      if (result.status === "rejected") throw result.reason;
    });
    return closing;
  };
  return {
    close,
    async open(viewer: Viewer, access: ComputerAutomationAccess) {
      if (current && current !== viewer) void close(current).catch(() => {});
      current = viewer;
      await closing;
      if (current === viewer) await viewer.open(access);
    },
  };
}

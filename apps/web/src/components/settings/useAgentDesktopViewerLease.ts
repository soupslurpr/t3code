import type { AgentDesktop, AgentDesktopHumanInvokeInput, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";

export interface AgentViewerLease {
  readonly desktop: Pick<AgentDesktop, "id" | "owner">;
}
type Run = (environmentId: EnvironmentId, input: AgentDesktopHumanInvokeInput) => Promise<unknown>;

/** Serializes lease changes so closing also releases an acquisition still in flight. */
export function useAgentDesktopViewerLease(run: Run, onClose: () => void) {
  const mounted = useRef(false);
  const selected = useRef<AgentViewerLease | null>(null);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useStableCallback(<T>(operation: () => Promise<T>) => {
    const result = pending.current.then(operation, operation);
    pending.current = result;
    return result;
  });
  const isCurrent = useStableCallback(
    (lease: AgentViewerLease) => mounted.current && selected.current === lease,
  );
  const release = useStableCallback(async (lease: AgentViewerLease) => {
    const { desktop } = lease;
    await run(desktop.owner.environmentId, {
      threadId: desktop.owner.threadId,
      request: { operation: "release", owner: desktop.owner, desktopId: desktop.id },
    }).catch(() => undefined);
  });
  const close = useStableCallback(() => {
    const lease = selected.current;
    selected.current = null;
    onClose();
    return lease === null ? Promise.resolve() : enqueue(() => release(lease));
  });
  const request = useStableCallback(
    (lease: AgentViewerLease, operation: "request-view" | "request-control" | "return-control") =>
      enqueue(async () => {
        if (!isCurrent(lease)) return false;
        const { desktop } = lease;
        await run(desktop.owner.environmentId, {
          threadId: desktop.owner.threadId,
          request: { operation, owner: desktop.owner, desktopId: desktop.id },
        });
        if (!isCurrent(lease)) {
          await release(lease);
          return false;
        }
        return true;
      }),
  );
  const open = useStableCallback(async (desktop: AgentViewerLease["desktop"]) => {
    void close();
    if (!mounted.current || document.visibilityState === "hidden") return null;
    const lease = { desktop };
    selected.current = lease;
    try {
      return (await request(lease, "request-view")) ? lease : null;
    } catch (cause) {
      if (isCurrent(lease)) await close();
      throw cause;
    }
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Human access follows document visibility and the mounted supervisor lifetime.
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      if (document.visibilityState === "hidden") void close();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", hidden);
      void close();
    };
  }, [close]);
  return { open, close, request, isCurrent };
}

import type { AgentDesktop, AgentDesktopHumanInvokeInput, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

export interface AgentViewerLease {
  readonly desktop: Pick<AgentDesktop, "id" | "owner">;
}
type Run = (environmentId: EnvironmentId, input: AgentDesktopHumanInvokeInput) => Promise<unknown>;

/** Serializes lease changes so closing also releases an acquisition still in flight. */
export function useAgentDesktopViewerLease(run: Run, onClose: () => void) {
  const mounted = useRef(false);
  const selected = useRef<AgentViewerLease | null>(null);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T>(operation: () => Promise<T>) => {
    const result = pending.current.then(operation, operation);
    pending.current = result;
    return result;
  }, []);
  const isCurrent = useCallback(
    (lease: AgentViewerLease) => mounted.current && selected.current === lease,
    [],
  );
  const release = useCallback(
    async (lease: AgentViewerLease) => {
      const { desktop } = lease;
      await run(desktop.owner.environmentId, {
        threadId: desktop.owner.threadId,
        request: { operation: "release", owner: desktop.owner, desktopId: desktop.id },
      }).catch(() => undefined);
    },
    [run],
  );
  const close = useCallback(() => {
    const lease = selected.current;
    selected.current = null;
    onClose();
    return lease === null ? Promise.resolve() : enqueue(() => release(lease));
  }, [enqueue, onClose, release]);
  const request = useCallback(
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
    [enqueue, isCurrent, release, run],
  );
  const open = useCallback(
    async (desktop: AgentViewerLease["desktop"]) => {
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
    },
    [close, isCurrent, request],
  );
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

import type {
  ComputerAutomationStatus,
  UserDesktopHumanInvokeInput,
  UserDesktopId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

type Run = (input: UserDesktopHumanInvokeInput) => Promise<ComputerAutomationStatus>;

/** Release after pending grants settle, and invalidate work when supervision leaves the app. */
export function useDesktopSupervisionAccess(
  desktopId: UserDesktopId,
  run: Run,
  onClose: () => void,
) {
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const currentGeneration = useCallback(() => generation.current, []);
  const isCurrent = useCallback(
    (value: number) =>
      mounted.current && AppState.currentState === "active" && generation.current === value,
    [],
  );
  const enqueue = useCallback(<T>(operation: () => Promise<T>) => {
    const result = pending.current.then(operation, operation);
    pending.current = result;
    return result;
  }, []);
  const close = useCallback(() => {
    generation.current += 1;
    onClose();
    return enqueue(async () => {
      // Expiry remains the backstop if backgrounding disconnects the transport.
      await run({ request: { operation: "release", desktopId } }).catch(() => undefined);
    });
  }, [desktopId, enqueue, onClose, run]);
  const request = useCallback(
    (input: UserDesktopHumanInvokeInput, value: number) =>
      enqueue(async () => {
        if (!isCurrent(value)) return null;
        try {
          const status = await run(input);
          return isCurrent(value) ? status : null;
        } catch (cause) {
          if (!isCurrent(value)) return null;
          throw cause;
        }
      }),
    [enqueue, isCurrent, run],
  );
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void close();
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      void close();
    };
  }, [close]);
  return { currentGeneration, isCurrent, request, close };
}

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";

export interface DesktopThreadScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Keeps supervision on its destination and subscribes to command permission changes. */
export function useDesktopEnvironments(kind: "user" | "agent", thread?: DesktopThreadScope) {
  const { environments: connected, isReady } = useEnvironments();
  const destinationId = thread?.environmentId;
  const candidates = useMemo(
    () =>
      connected.filter(
        (environment) => destinationId === undefined || environment.environmentId === destinationId,
      ),
    [connected, destinationId],
  );
  const command =
    kind === "user"
      ? previewEnvironment.invokeUserDesktopHuman
      : previewEnvironment.invokeAgentDesktopHuman;
  const permitted = useAtomValue(
    useMemo(
      () =>
        Atom.make(
          (get) =>
            new Set(
              candidates
                .filter((environment) => get(command.permissionAtom(environment.environmentId)))
                .map((environment) => environment.environmentId),
            ),
        ),
      [candidates, command],
    ),
  );
  const environments = useMemo(
    () => candidates.filter((environment) => permitted.has(environment.environmentId)),
    [candidates, permitted],
  );
  return { environments, isReady, permissionDenied: candidates.length > environments.length };
}

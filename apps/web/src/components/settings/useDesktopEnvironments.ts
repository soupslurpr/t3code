import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";

export interface DesktopThreadScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const permittedEnvironments = Atom.family((key: string) => {
  const [kind, ids] = JSON.parse(key) as ["user" | "agent", EnvironmentId[]];
  const command =
    kind === "user"
      ? previewEnvironment.invokeUserDesktopHuman
      : previewEnvironment.invokeAgentDesktopHuman;
  return Atom.make((get) => new Set(ids.filter((id) => get(command.permissionAtom(id)))));
});

export function useDesktopEnvironments(kind: "user" | "agent", thread?: DesktopThreadScope) {
  const { environments: connected, isReady } = useEnvironments();
  const candidates = connected.filter(
    (environment) => thread === undefined || environment.environmentId === thread.environmentId,
  );
  const permitted = useAtomValue(
    permittedEnvironments(
      JSON.stringify([kind, candidates.map((environment) => environment.environmentId)]),
    ),
  );
  const environments = candidates.filter((environment) => permitted.has(environment.environmentId));
  return { environments, isReady, permissionDenied: candidates.length > environments.length };
}

// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  environments: [] as Array<{ environmentId: EnvironmentId; label: string }>,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ isReady: true, environments: state.environments }),
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    invokeAgentDesktopHuman: { permissionAtom: (id: EnvironmentId) => permissions.agent[id] },
    invokeUserDesktopHuman: { permissionAtom: (id: EnvironmentId) => permissions.user[id] },
  },
}));
import { useDesktopEnvironments } from "./useDesktopEnvironments";
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const permissions = {
  agent: { [local]: Atom.make(true), [remote]: Atom.make(false) },
  user: { [local]: Atom.make(true), [remote]: Atom.make(false) },
};
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;
function Subject({ kind }: { kind: "user" | "agent" }) {
  const { environments, permissionDenied } = useDesktopEnvironments(kind, {
    environmentId: remote,
    threadId: ThreadId.make("thread"),
  });
  return (
    <div>
      {permissionDenied
        ? "Permission required"
        : environments.map((environment) => environment.label).join(", ")}
    </div>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  state.environments = [
    { environmentId: local, label: "Local desktop" },
    { environmentId: remote, label: "Remote desktop" },
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});
it.each(["user", "agent"] as const)(
  "uses the destination %s permission and reacts to revocation",
  async (kind) => {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Subject kind={kind} />
        </RegistryContext.Provider>,
      ),
    );
    expect(container.textContent).toBe("Permission required");
    await act(async () => registry.set(permissions[kind][remote]!, true));
    expect(container.textContent).toBe("Remote desktop");
    await act(async () => registry.set(permissions[kind][remote]!, false));
    expect(container.textContent).toBe("Permission required");
  },
);

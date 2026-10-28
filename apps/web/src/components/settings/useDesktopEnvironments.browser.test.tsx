import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as Array<{ environmentId: EnvironmentId; label: string }>,
  permissions: {
    agent: {} as Record<string, Atom.Writable<boolean>>,
    user: {} as Record<string, Atom.Writable<boolean>>,
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ isReady: true, environments: state.environments }),
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    invokeAgentDesktopHuman: { permissionAtom: (id: EnvironmentId) => state.permissions.agent[id] },
    invokeUserDesktopHuman: { permissionAtom: (id: EnvironmentId) => state.permissions.user[id] },
  },
}));
import { useDesktopEnvironments } from "./useDesktopEnvironments";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
function Subject({ kind }: { kind: "user" | "agent" }) {
  const { environments, permissionDenied } = useDesktopEnvironments(kind, {
    environmentId: remote,
    threadId: ThreadId.make("owner"),
  });
  return (
    <div>
      {permissionDenied
        ? "Permission required"
        : environments.map((environment) => environment.label).join(", ")}
    </div>
  );
}
it.each(["user", "agent"] as const)(
  "uses the destination %s permission and reacts to revocation",
  async (kind) => {
    const registry = AtomRegistry.make();
    state.environments = [
      { environmentId: local, label: "Local desktop" },
      { environmentId: remote, label: "Remote desktop" },
    ];
    for (const entry of ["agent", "user"] as const)
      state.permissions[entry] = { [local]: Atom.make(true), [remote]: Atom.make(false) };
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <Subject kind={kind} />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText("Permission required")).toBeVisible();
    await act(async () => registry.set(state.permissions[kind][remote]!, true));
    await expect.element(screen.getByText("Remote desktop")).toBeVisible();
    await act(async () => registry.set(state.permissions[kind][remote]!, false));
    await expect.element(screen.getByText("Permission required")).toBeVisible();
  },
);

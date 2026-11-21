import {
  AuthAdministrativeClientScopes,
  AuthFilesystemReadScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  AuthUserDesktopHostScopes,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DesktopEnrollment } from "./DesktopEnrollment";

const { issue, current, Children } = vi.hoisted(() => ({
  issue: vi.fn(),
  current: new Set<string>(),
  Children: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "config"
      ? { environment: { capabilities: { userDesktopHostPairing: true } } }
      : AsyncResult.success({ authenticated: true, permissions: [...current], scopes: [] }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "session" },
  readEnvironmentSessionState: () => ({
    authenticated: true,
    permissions: [...current],
    scopes: [],
  }),
}));
vi.mock("../../state/auth", () => ({ authEnvironment: { createPairingCredential: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => issue }));
vi.mock("./desktopRequests", () => ({
  commandValue: (r: { value: unknown }) => r.value,
  useDesktopAction: () => ({ run: (work: () => Promise<void>) => work() }),
}));
vi.mock("./SupervisionLayout", () => ({
  Panel: Children,
  Errors: ({ error }: { error?: string | null }) =>
    error ? <div role="alert">{error}</div> : null,
}));
vi.mock("../threads/CopyTextButton", () => ({ CopyTextButton: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: Children,
  AppTextInput: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (value: string) => void;
  }) => <input value={value} onInput={(e) => onChangeText(e.currentTarget.value)} />,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: ({
    label,
    selected,
    disabled,
    onPress,
  }: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button role="radio" aria-checked={selected} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));

it("requires an explicit access preset, issues standard or host scopes, and rechecks grants at submission", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  current.clear();
  issue.mockReset();
  for (const scope of AuthAdministrativeClientScopes) current.add(scope);
  issue.mockResolvedValue({ value: { credential: "test credential" } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const environmentId = EnvironmentId.make("test");
  const getRadio = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find((el) =>
      el.textContent?.includes(label),
    )!;
  const getCreate = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (el) => el.getAttribute("role") !== "radio",
    )!;
  try {
    await act(async () => root.render(<DesktopEnrollment environmentId={environmentId} />));
    const id = container.querySelector("input")!;
    const enterDesktop = (value: string) =>
      act(() => {
        id.value = value;
        id.dispatchEvent(new Event("input", { bubbles: true }));
      });
    enterDesktop("desktop");
    expect(getCreate().disabled).toBe(true);

    act(() => getRadio("Standard desktop").click());
    expect(getCreate().disabled).toBe(false);
    await act(async () => getCreate().click());
    expect(issue.mock.lastCall?.[0].input.scopes).toEqual(AuthStandardClientScopes);
    expect(container.textContent).toContain("test credential");

    act(() => getRadio("Desktop hosting + commands").click());
    expect(container.textContent).not.toContain("test credential");
    current.delete(AuthTerminalOperateScope);
    await act(async () => getCreate().click());
    expect(issue).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Your permissions changed.",
    );

    current.add(AuthTerminalOperateScope);
    await act(async () => root.render(<DesktopEnrollment environmentId={environmentId} />));
    await act(async () => getCreate().click());
    expect(issue).toHaveBeenCalledTimes(2);
    expect(issue.mock.lastCall?.[0].input.scopes).toEqual([
      ...AuthUserDesktopHostScopes,
      AuthTerminalOperateScope,
    ]);

    current.delete(AuthTerminalOperateScope);
    current.delete(AuthFilesystemReadScope);
    enterDesktop("another-desktop");
    expect(getCreate().disabled).toBe(true);
    expect(getRadio("Desktop hosting + commands").disabled).toBe(true);
    expect(getRadio("Standard desktop (limited)")).toBeDefined();
    expect(container.textContent).not.toContain("test credential");

    act(() => getRadio("Standard desktop (limited)").click());
    expect(container.textContent).toContain(
      "This desktop will not be able to open host files in the built-in file viewer.",
    );

    // Gaining filesystem:read before rerender must also pause submission so the code isn't issued stale.
    current.add(AuthFilesystemReadScope);
    await act(async () => getCreate().click());
    expect(issue).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Your permissions changed.",
    );

    await act(async () => root.render(<DesktopEnrollment environmentId={environmentId} />));
    await act(async () => getCreate().click());
    expect(issue).toHaveBeenCalledTimes(3);
    expect(issue.mock.lastCall?.[0].input.scopes).toContain(AuthFilesystemReadScope);

    act(() => getRadio("Desktop hosting only").click());
    await act(async () => getCreate().click());
    expect(issue).toHaveBeenCalledTimes(4);
    expect(issue.mock.lastCall?.[0].input).toMatchObject({
      userDesktopId: "another-desktop",
      scopes: AuthUserDesktopHostScopes,
    });
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

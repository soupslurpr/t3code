import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
const state = vi.hoisted(() => ({
  invoke: vi.fn(),
  response: null as unknown,
  error: null as Error | null,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (x: unknown) => new Error(String(x)),
}));
vi.mock("../ui/button.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children: React.ReactNode;
      onClick: () => void;
      disabled?: boolean;
    }) => createElement("button", { onClick, disabled }, children),
  };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render.tsx";
vi.mock("../../state/preview.ts", () => ({
  previewEnvironment: { invokeUserDesktopHuman: { permissionAtom: () => true } },
}));
vi.mock("../../state/use-atom-command.ts", () => ({ useAtomCommand: () => state.invoke }));
import { DesktopScreenPermissionsPanel } from "./DesktopScreenPermissionsPanel.tsx";
const fault =
  "Screen permissions are unavailable because permission publication could not be confirmed.";
const base = {
  available: true,
  backend: "gnome-wayland-portal",
  permission: "prompt-required",
  rememberedAccess: [],
  displayState: "active",
  keepAwake: false,
  displays: [],
  cursor: null,
};
const grant = {
  grantId: "saved-control",
  revision: 1,
  capability: "control",
  scope: "thread",
  environmentId: "env",
  threadId: "thread",
  lifetime: "until-revoked",
  remembered: true,
  issuedAt: "2026-11-01T00:00:00.000Z",
  deadline: null,
  expiresAt: null,
  absoluteExpiresAt: null,
  idleExpiresAt: null,
  settledExpiresAt: null,
  sourceRevision: 1,
  activityRevision: 1,
  sourceState: "active",
  suspended: false,
  migrated: false,
};
const healthy = {
  ...base,
  authorization: {
    protocolVersion: 2,
    grants: [grant],
    pendingRequests: [],
    remoteApprovalAvailable: true,
  },
};
function setup() {
  state.invoke.mockReset();
  state.response = healthy;
  state.error = null;
  state.invoke.mockImplementation(async () => {
    if (state.error) throw state.error;
    return { _tag: "Success", value: state.response };
  });
}

it.each(["unavailable", "throw"] as const)(
  "clears remembered rows and edit controls after %s, then restores only a fresh snapshot",
  async (failure) => {
    setup();
    await using screen = await render(
      <DesktopScreenPermissionsPanel
        environmentId={EnvironmentId.make("env")}
        desktopId="desk"
        desktopLabel="Desk"
        threadId={ThreadId.make("thread")}
      />,
    );
    await userEvent.click(screen.getByText("Screen permissions", { exact: true }));
    await expect.element(screen.getByText(/Remembered/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Change permission", exact: true }));
    if (failure === "throw") state.error = new Error(fault);
    else state.response = { ...base, detail: fault };
    await userEvent.click(screen.getByRole("button", { name: "Refresh permissions" }));
    await expect.element(screen.getByRole("alert")).toHaveTextContent(fault);
    expect(screen.container.textContent).not.toContain("Remembered");
    expect(screen.container.textContent).not.toContain("compatible desktop");
    expect(screen.container.textContent).not.toContain("Allow viewing");
    expect(screen.container.querySelector("button")).toBeTruthy();
    expect(
      [...screen.container.querySelectorAll("button")].some(
        (b) => b.textContent === "Change permission",
      ),
    ).toBe(false);
    state.error = null;
    state.response = healthy;
    await userEvent.click(screen.getByRole("button", { name: "Refresh permissions" }));
    await expect.element(screen.getByText(/Remembered/)).toBeVisible();
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
    expect(screen.container.textContent).not.toContain("Confirm permission");
  },
);
it("keeps healthy unsupported-host guidance", async () => {
  setup();
  state.response = base;
  await using screen = await render(
    <DesktopScreenPermissionsPanel
      environmentId={EnvironmentId.make("env")}
      desktopId="desk"
      desktopLabel="Desk"
    />,
  );
  await userEvent.click(screen.getByText("Screen permissions", { exact: true }));
  await expect
    .element(screen.getByText("Scoped screen permissions require a compatible desktop."))
    .toBeVisible();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
});
it("keeps known-empty healthy permissions usable", async () => {
  setup();
  state.response = { ...healthy, authorization: { ...healthy.authorization, grants: [] } };
  await using screen = await render(
    <DesktopScreenPermissionsPanel
      environmentId={EnvironmentId.make("env")}
      desktopId="desk"
      desktopLabel="Desk"
    />,
  );
  await userEvent.click(screen.getByText("Screen permissions", { exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Allow viewing", exact: true }))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("compatible desktop");
});
it("an accepted request followed by unavailable refresh is not retried or presented as an unsaved edit", async () => {
  setup();
  await using screen = await render(
    <DesktopScreenPermissionsPanel
      environmentId={EnvironmentId.make("env")}
      desktopId="desk"
      desktopLabel="Desk"
      threadId={ThreadId.make("thread")}
    />,
  );
  await userEvent.click(screen.getByText("Screen permissions", { exact: true }));
  await expect.element(screen.getByText(/Remembered/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Change permission", exact: true }));
  state.invoke.mockImplementation(async ({ input }) =>
    input.request.operation === "screen-permission"
      ? { _tag: "Success", value: healthy.authorization }
      : { _tag: "Success", value: { ...base, detail: fault } },
  );
  await userEvent.click(screen.getByRole("button", { name: "Confirm permission", exact: true }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent(fault);
  expect(
    state.invoke.mock.calls.filter(([x]) => x.input.request.operation === "screen-permission"),
  ).toHaveLength(1);
  expect(screen.container.textContent).not.toContain("Remembered");
  expect(screen.container.textContent).not.toContain("Confirm permission");
});

it.each(
  (["unavailable", "throw"] as const).flatMap((failure) =>
    (["same-fault", "new-fault", "healthy", "known-empty", "unsupported"] as const).map(
      (outcome) => ({ failure, outcome }),
    ),
  ),
)(
  "keeps unavailable diagnosis while retry is pending after $failure, then $outcome",
  async ({ failure, outcome }) => {
    setup();
    await using screen = await render(
      <DesktopScreenPermissionsPanel
        environmentId={EnvironmentId.make("env")}
        desktopId="desk"
        desktopLabel="Desk"
        threadId={ThreadId.make("thread")}
      />,
    );
    await userEvent.click(screen.getByText("Screen permissions", { exact: true }));
    await expect.element(screen.getByText(/Remembered/)).toBeVisible();
    if (failure === "throw") state.error = new Error(fault);
    else state.response = { ...base, detail: fault };
    await userEvent.click(screen.getByRole("button", { name: "Refresh permissions" }));
    await expect.element(screen.getByRole("alert")).toHaveTextContent(fault);
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    state.error = null;
    state.invoke.mockImplementation(async () => ({ _tag: "Success", value: await pending }));
    try {
      await userEvent.click(screen.getByRole("button", { name: "Refresh permissions" }));
      const observed = screen.container.textContent ?? "";
      expect(observed).not.toContain("Scoped screen permissions require a compatible desktop.");
      expect(observed).toContain(fault);
      expect(observed).not.toContain("Remembered");
      expect(observed).not.toContain("Confirm permission");
      expect(
        [...screen.container.querySelectorAll("button")].find(
          (b) => b.textContent === "Refresh permissions",
        )?.disabled,
      ).toBe(true);
    } finally {
      const next =
        outcome === "healthy"
          ? healthy
          : outcome === "known-empty"
            ? { ...healthy, authorization: { ...healthy.authorization, grants: [] } }
            : outcome === "unsupported"
              ? base
              : { ...base, detail: outcome === "new-fault" ? "New storage fault" : fault };
      finish(next);
      if (outcome === "healthy") {
        await expect.element(screen.getByText(/Remembered/)).toBeVisible();
        expect(screen.container.querySelector('[role="alert"]')).toBeNull();
      } else if (outcome === "known-empty") {
        await expect
          .element(screen.getByRole("button", { name: "Allow viewing", exact: true }))
          .toBeVisible();
        expect(screen.container.querySelector('[role="alert"]')).toBeNull();
        expect(screen.container.textContent).not.toContain("Remembered");
      } else if (outcome === "unsupported") {
        await expect
          .element(screen.getByText("Scoped screen permissions require a compatible desktop."))
          .toBeVisible();
        expect(screen.container.querySelector('[role="alert"]')).toBeNull();
      } else
        await expect
          .element(screen.getByRole("alert"))
          .toHaveTextContent(outcome === "new-fault" ? "New storage fault" : fault);
    }
  },
);

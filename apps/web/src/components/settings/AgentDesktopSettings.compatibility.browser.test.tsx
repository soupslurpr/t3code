import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Atom } from "effect/reactivity";
import {
  AgentDesktopControllerId,
  AgentDesktopId,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const commands = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("~/state/entities", () => ({
  useThreadShells: () => [],
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments,
  }),
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { invokeAgentDesktopHuman: { permissionAtom: () => Atom.make(true) } },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => commands.invoke,
}));

import { AgentDesktopSettings } from "./AgentDesktopSettings";

const environmentId = EnvironmentId.make("remote-device");
const environments = [{ environmentId, label: "Laptop" }];

let container: HTMLDivElement;
let root: Root;

describe("AgentDesktopSettings compatibility", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    commands.invoke.mockReset().mockResolvedValue({
      _tag: "Success",
      value: {
        available: true,
        desktops: [
          {
            id: AgentDesktopId.make("legacy-desktop"),
            label: "Existing desktop",
            owner: {
              environmentId,
              threadId: ThreadId.make("legacy-thread"),
              controllerId: AgentDesktopControllerId.make("legacy-controller"),
            },
            state: "parked",
            automaticParking: true,
            capabilities: ["computer"],
            controllerId: null,
            viewerCount: 0,
            createdAt: "2026-08-18T00:00:00.000Z",
            lastActiveAt: "2026-08-18T00:00:00.000Z",
            recoverableUntil: null,
            graphics: {
              backend: "virtio-gpu-2d",
              hardwareAccelerated: false,
              renderer: "software",
              checkpointMode: "disk-consistent",
            },
          },
        ],
        requirements: [],
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders an older environment response without maintenance fields", async () => {
    await act(async () => root.render(<AgentDesktopSettings />));
    expect(container.textContent).toContain(
      "Update this environment's T3 Code server to manage Agent desktop system updates.",
    );
    expect(container.textContent).toContain("Existing desktop");
  });
});

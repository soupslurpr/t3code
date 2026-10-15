import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Atom } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const commands = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const environmentState = vi.hoisted(() => ({
  environments: [] as Array<{ readonly environmentId: EnvironmentId; readonly label: string }>,
}));

const environmentId = EnvironmentId.make("remote-environment");
const localEnvironmentId = EnvironmentId.make("local-environment");
const inventoryRefreshIntervalMs = 5_000;

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: environmentState.environments,
  }),
}));

vi.mock("~/state/entities", () => ({
  useThreadShells: () => [],
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { invokeUserDesktopHuman: { permissionAtom: () => Atom.make(true) } },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => commands.invoke,
}));

import { UserDesktopSettings } from "./UserDesktopSettings";

const onlineDesktop = {
  desktop: { kind: "user" as const, desktopId: "user-workstation" },
  label: "Workstation",
  defaultLabel: "coolcrab",
  platform: "linux" as const,
  capabilities: ["view" as const, "control" as const, "availability" as const],
  connectionState: "online" as const,
  lastSeenAt: "2026-08-23T18:00:00.000Z",
  t3Focused: true,
  lastActiveAt: "2026-08-23T17:59:00.000Z",
};

const unsupportedDesktop = {
  desktop: { kind: "user" as const, desktopId: "user-unsupported" },
  label: "Unsupported client",
  defaultLabel: "unsupported-client",
  platform: "unknown" as const,
  capabilities: [],
  connectionState: "online" as const,
  lastSeenAt: "2026-08-22T18:00:00.000Z",
  t3Focused: false,
  lastActiveAt: null,
};

const status = {
  desktop: { id: "user-workstation", kind: "user" as const, label: "Workstation" },
  available: true,
  backend: "gnome-wayland-portal" as const,
  permission: "granted" as const,
  rememberedAccess: ["view" as const, "control" as const],
  displayState: "active" as const,
  keepAwake: true,
  displays: [],
  cursor: null,
  lease: { access: "none" as const, controller: null, canReturnControl: false },
};

const snapshot = {
  display: {
    id: "display-1",
    label: "Primary display",
    primary: true,
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    scaleFactor: 1,
  },
  cursor: null,
  captureSource: "screen-cast-stream" as const,
  frame: {
    id: "frame-1",
    displayId: "display-1",
    coordinateSpace: "image-pixels" as const,
    width: 1280,
    height: 720,
    toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  },
  screenshot: {
    state: "image" as const,
    contentHash: `sha256-bgra8-v1:${"A".repeat(43)}`,
    mimeType: "image/webp" as const,
    data: "dGVzdA==",
    width: 1280,
    height: 720,
    sizeBytes: 4,
    encoding: { format: "webp" as const, mode: "lossless" as const },
  },
};

let container: HTMLDivElement;
let root: Root;

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === label,
  );
}
async function mount() {
  await act(async () => root.render(<UserDesktopSettings />));
}
async function click(label: string) {
  const button = buttons(label).find((button) => !button.disabled);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
describe("UserDesktopSettings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    environmentState.environments = [{ environmentId, label: "Remote environment" }];
    commands.invoke.mockReset().mockImplementation(async ({ input }) => {
      const request = input.request;
      if (request.operation === "list") {
        return {
          _tag: "Success",
          value: {
            desktops: [onlineDesktop, unsupportedDesktop],
            incompatibleClientCount: 1,
          },
        };
      }
      if (request.operation === "status") {
        if (request.desktopId === "user-unsupported") {
          throw new Error("unsupported test desktop");
        }
        return { _tag: "Success", value: status };
      }
      if (request.operation === "audit") {
        return {
          _tag: "Success",
          value: {
            events:
              request.desktopId === "user-workstation"
                ? [
                    {
                      sequence: 1,
                      desktopId: "user-workstation",
                      occurredAt: "2026-08-23T17:58:00.000Z",
                      actorKind: "agent",
                      action: "control-granted",
                      threadId: "thread-1",
                      actorLabel: "codex",
                      takeover: true,
                    },
                  ]
                : [],
          },
        };
      }
      if (request.operation === "observation-list") {
        return { _tag: "Success", value: { observations: [] } };
      }
      if (request.operation === "request-view" || request.operation === "release-control") {
        return { _tag: "Success", value: status };
      }
      if (request.operation === "snapshot") {
        return { _tag: "Success", value: snapshot };
      }
      return { _tag: "Success", value: null };
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders concrete targets and exposes owner force controls", async () => {
    await mount();
    const text = container.textContent!.replace(/\s+/gu, " ");
    for (const expected of [
      "Workstation",
      "user-workstation",
      "T3 focused",
      "1 connected desktop client cannot identify a user desktop",
      "Screen sharing is unavailable for this desktop",
      "Recent access",
      "Took control",
      "codex",
      "Takeover",
    ])
      expect(text).toContain(expected);
    expect(buttons("Remember view")).toHaveLength(2);
    expect(buttons("Remember view").some((button) => button.disabled)).toBe(true);
    await click("End all access");
    expect(commands.invoke).toHaveBeenCalledWith({
      environmentId,
      input: {
        request: { operation: "end-all-access", desktopId: "user-workstation" },
        timeoutMs: 120_000,
      },
    });
  });

  it("groups routes to the same physical desktop", async () => {
    environmentState.environments = [
      { environmentId, label: "Remote environment" },
      { environmentId: localEnvironmentId, label: "Local environment" },
    ];
    await mount();
    const text = container.textContent!;
    expect(text.match(/Workstation/gu)).toHaveLength(1);
    expect(text.match(/user-workstation/gu)).toHaveLength(1);
    expect(text).toContain("Via Remote environment, Local environment");
    expect(buttons("Remember view")).toHaveLength(2);
  });

  it("remembers approval without a separate release request", async () => {
    await mount();
    commands.invoke.mockClear();
    await click("Remember view");
    const operations = commands.invoke.mock.calls.map(
      ([request]) => request.input.request.operation,
    );
    expect(operations).toContain("remember-view");
    expect(operations).not.toContain("release");
  });

  it("opens supervision passively and starts Live only when requested", async () => {
    await mount();
    commands.invoke.mockClear();
    await click("Supervise");
    const passiveOperations = commands.invoke.mock.calls.map(
      ([request]) => request.input.request.operation,
    );
    expect(passiveOperations).toEqual(expect.arrayContaining(["status", "observation-list"]));
    expect(passiveOperations).not.toContain("request-view");
    expect(passiveOperations).not.toContain("snapshot");
    commands.invoke.mockClear();
    await click("Start Live");
    const liveOperations = commands.invoke.mock.calls.map(
      ([request]) => request.input.request.operation,
    );
    expect(liveOperations).toEqual(expect.arrayContaining(["request-view", "snapshot"]));
    expect(document.querySelector('img[alt="Workstation screen"]')).not.toBeNull();
  });

  it("queues a fresh inventory read after a mutation races with polling", async () => {
    await mount();
    let releaseList!: () => void;
    const blockedList = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listCalls = 0;
    commands.invoke.mockReset().mockImplementation(async ({ input }) => {
      const request = input.request;
      if (request.operation === "list") {
        listCalls += 1;
        if (listCalls === 1) await blockedList;
        return {
          _tag: "Success",
          value: { desktops: [onlineDesktop, unsupportedDesktop], incompatibleClientCount: 1 },
        };
      }
      if (request.operation === "status") {
        return request.desktopId === "user-unsupported"
          ? Promise.reject(new Error("unsupported test desktop"))
          : { _tag: "Success", value: status };
      }
      return { _tag: "Success", value: null };
    });
    await act(async () => vi.advanceTimersByTimeAsync(inventoryRefreshIntervalMs));
    await click("Forget approval");
    expect(commands.invoke).toHaveBeenCalledWith({
      environmentId,
      input: {
        request: { operation: "forget", desktopId: "user-workstation" },
        timeoutMs: 120_000,
      },
    });
    expect(listCalls).toBe(1);
    await act(async () => {
      releaseList();
      await blockedList;
    });
    expect(listCalls).toBe(2);
  });
});

import type { ReactElement } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const effects = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  pending: [] as Array<() => void | (() => void)>,
}));

const commands = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const environmentState = vi.hoisted(() => ({
  environments: [] as Array<{ readonly environmentId: EnvironmentId; readonly label: string }>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => effects.pending.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

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
  previewEnvironment: { invokeUserDesktopHuman: Symbol("invokeUserDesktopHuman") },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => commands.invoke,
}));

import { ComputerDesktopViewer } from "./AgentDesktopSettings";
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

/** Runs one deterministic hook-harness render. */
function renderSettings(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return UserDesktopSettings() as ReactElement<Record<string, unknown>>;
}

/** Flattens JSX children for focused copy assertions. */
function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (node === null || typeof node !== "object" || !("props" in node)) return "";
  return textContent((node as ReactElement<Record<string, unknown>>).props.children);
}

/** Finds unrendered JSX elements matching one predicate. */
function findElements(
  node: unknown,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReadonlyArray<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [
    ...(predicate(element) ? [element] : []),
    ...findElements(element.props.children, predicate),
  ];
}

/** Runs queued effects and lets their command promises settle. */
async function applyEffects(): Promise<void> {
  const pending = effects.pending.splice(0);
  for (const effect of pending) {
    const cleanup = effect();
    if (typeof cleanup === "function") effects.cleanups.push(cleanup);
  }
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

/** Lets queued command continuations settle without advancing timers. */
async function flushCommands(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

describe("UserDesktopSettings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearInterval: globalThis.clearInterval,
      setInterval: globalThis.setInterval,
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    hooks.reset();
    effects.cleanups = [];
    effects.pending = [];
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

  afterEach(() => {
    for (const cleanup of effects.cleanups.splice(0)) cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders concrete targets and exposes owner force controls", async () => {
    const loadingSettings = renderSettings();
    expect(textContent(loadingSettings)).toContain("Loading user desktops…");
    expect(textContent(loadingSettings)).not.toContain("No user desktops known");
    await applyEffects();

    const settings = renderSettings();
    const text = textContent(settings).replace(/\s+/gu, " ");
    expect(text).toContain("Workstation");
    expect(text).toContain("user-workstation");
    expect(text).toContain("T3 focused");
    expect(text).toContain("1 connected desktop client cannot identify a user desktop");
    expect(text).toContain("Computer use is unavailable for this desktop");
    expect(text).toContain("Recent access");
    expect(text).toContain("Took control");
    expect(text).toContain("codex");
    expect(text).toContain("Takeover");

    const rememberViewButtons = findElements(
      settings,
      (element) => textContent(element.props.children).trim() === "Remember view",
    );
    expect(rememberViewButtons).toHaveLength(2);
    expect(rememberViewButtons.some((button) => button.props.disabled === true)).toBe(true);

    const endAccess = findElements(
      settings,
      (element) => textContent(element.props.children).trim() === "End all access",
    );
    expect(endAccess).toHaveLength(1);
    const onClick = endAccess[0]?.props.onClick;
    expect(onClick).toBeTypeOf("function");
    if (typeof onClick === "function") onClick();
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();

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

    renderSettings();
    await applyEffects();

    const settings = renderSettings();
    const text = textContent(settings).replace(/\s+/gu, " ");
    expect(text.match(/Workstation/gu)).toHaveLength(1);
    expect(text.match(/user-workstation/gu)).toHaveLength(1);
    expect(text).toContain("Available through Remote environment, Local environment");

    const rememberViewButtons = findElements(
      settings,
      (element) => textContent(element.props.children).trim() === "Remember view",
    );
    expect(rememberViewButtons).toHaveLength(2);
  });

  it("remembers approval without a separate release request", async () => {
    renderSettings();
    await applyEffects();

    const settings = renderSettings();
    const rememberView = findElements(
      settings,
      (element) => textContent(element.props.children).trim() === "Remember view",
    ).find((button) => button.props.disabled !== true);
    expect(rememberView?.props.onClick).toBeTypeOf("function");
    commands.invoke.mockClear();
    if (typeof rememberView?.props.onClick === "function") rememberView.props.onClick();
    await flushCommands();

    const operations = commands.invoke.mock.calls.map(
      ([request]) => request.input.request.operation,
    );
    expect(operations).toContain("remember-view");
    expect(operations).not.toContain("release");
  });

  it("opens supervision passively and starts Live only when requested", async () => {
    renderSettings();
    await applyEffects();

    const settings = renderSettings();
    const supervise = findElements(
      settings,
      (element) =>
        textContent(element.props.children).trim() === "Supervise" &&
        typeof element.props.onClick === "function",
    )[0];
    expect(supervise?.props.onClick).toBeTypeOf("function");
    commands.invoke.mockClear();
    if (typeof supervise?.props.onClick === "function") supervise.props.onClick();
    await flushCommands();

    const passiveOperations = commands.invoke.mock.calls.map(
      ([request]) => request.input.request.operation,
    );
    expect(passiveOperations).toEqual(expect.arrayContaining(["status", "observation-list"]));
    expect(passiveOperations).not.toContain("request-view");
    expect(passiveOperations).not.toContain("snapshot");

    const passiveViewer = findElements(
      renderSettings(),
      (element) => element.type === ComputerDesktopViewer,
    )[0];
    expect(passiveViewer?.props.liveStarted).toBe(false);
    expect(passiveViewer?.props.liveDisabledReason).toBeNull();
    expect(passiveViewer?.props.onStartLive).toBeTypeOf("function");
    await applyEffects();

    commands.invoke.mockClear();
    if (typeof passiveViewer?.props.onStartLive === "function") {
      await passiveViewer.props.onStartLive();
    }
    const liveOperations = commands.invoke.mock.calls.map(
      ([request]) => request.input.request.operation,
    );
    expect(liveOperations).toEqual(expect.arrayContaining(["request-view", "snapshot"]));

    const liveViewer = findElements(
      renderSettings(),
      (element) => element.type === ComputerDesktopViewer,
    )[0];
    expect(liveViewer?.props.liveStarted).toBe(true);
    expect(liveViewer?.props.onRelease).toBeTypeOf("function");
    commands.invoke.mockClear();
    if (typeof liveViewer?.props.onRelease === "function") await liveViewer.props.onRelease();
    expect(commands.invoke).toHaveBeenCalledWith({
      environmentId,
      input: {
        request: { operation: "release-control", desktopId: "user-workstation" },
      },
    });
  });

  it("queues a fresh inventory read after a mutation races with polling", async () => {
    renderSettings();
    await applyEffects();

    let releaseList: (() => void) | undefined;
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

    await vi.advanceTimersByTimeAsync(inventoryRefreshIntervalMs);
    const settings = renderSettings();
    const forget = findElements(
      settings,
      (element) => textContent(element.props.children).trim() === "Forget approval",
    )[0];
    expect(forget?.props.onClick).toBeTypeOf("function");
    if (typeof forget?.props.onClick === "function") forget.props.onClick();
    await flushCommands();
    expect(commands.invoke).toHaveBeenCalledWith({
      environmentId,
      input: {
        request: { operation: "forget", desktopId: "user-workstation" },
        timeoutMs: 120_000,
      },
    });
    expect(listCalls).toBe(1);

    releaseList?.();
    await flushCommands(40);
    expect(listCalls).toBe(2);
  });
});

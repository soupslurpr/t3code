import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const effects = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  pending: [] as Array<() => void | (() => void)>,
}));

const keyboardCapture = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
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

vi.mock("./agentDesktopKeyboardCapture", () => ({
  acquireAgentDesktopKeyboardCapture: keyboardCapture.acquire,
}));

import { ComputerDesktopViewer } from "./AgentDesktopSettings";

/** Renders the shared desktop viewer with one pending control request. */
function renderViewer({
  onTakeControl,
  onRelease,
}: {
  readonly onTakeControl: () => Promise<boolean>;
  readonly onRelease: () => Promise<boolean>;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ComputerDesktopViewer({
    label: "Test desktop",
    description: "Test viewer",
    observation: null,
    agentObservation: null,
    controlling: false,
    busy: false,
    error: null,
    liveStarted: true,
    onTakeControl,
    onRelease,
    onAction: vi.fn(async () => undefined),
  }) as ReactElement<Record<string, unknown>>;
}

/** Flattens JSX children for focused status assertions. */
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

/** Runs queued effects and retains their cleanups. */
async function applyEffects(): Promise<void> {
  for (const effect of effects.pending.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === "function") effects.cleanups.push(cleanup);
  }
  await flushCommands();
}

/** Lets queued control continuations settle deterministically. */
async function flushCommands(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

describe("ComputerDesktopViewer", () => {
  let fullscreenDocument: {
    fullscreenElement: unknown | null;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };
  let fullscreenListeners: Set<() => void>;

  beforeEach(() => {
    hooks.reset();
    effects.cleanups = [];
    effects.pending = [];
    fullscreenListeners = new Set();
    fullscreenDocument = {
      fullscreenElement: null,
      addEventListener: vi.fn((name: string, listener: () => void) => {
        if (name === "fullscreenchange") fullscreenListeners.add(listener);
      }),
      removeEventListener: vi.fn((name: string, listener: () => void) => {
        if (name === "fullscreenchange") fullscreenListeners.delete(listener);
      }),
    };
    vi.stubGlobal("document", fullscreenDocument);
    keyboardCapture.release.mockReset().mockResolvedValue(undefined);
    keyboardCapture.acquire.mockReset().mockImplementation(async () => {
      fullscreenDocument.fullscreenElement = { active: true };
      return { release: keyboardCapture.release };
    });
  });

  afterEach(() => {
    for (const cleanup of effects.cleanups.splice(0)) cleanup();
    vi.unstubAllGlobals();
  });

  it("releases a pending grant when full screen ends before control becomes active", async () => {
    let resolveGrant: ((granted: boolean) => void) | undefined;
    const onTakeControl = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveGrant = resolve;
        }),
    );
    const onRelease = vi.fn(async () => true);
    const viewer = renderViewer({ onTakeControl, onRelease });
    await applyEffects();

    const takeControl = findElements(
      viewer,
      (element) =>
        textContent(element.props.children).trim() === "Take control" &&
        typeof element.props.onClick === "function",
    )[0];
    expect(takeControl?.props.onClick).toBeTypeOf("function");
    if (typeof takeControl?.props.onClick === "function") takeControl.props.onClick();
    await flushCommands();

    expect(keyboardCapture.acquire).toHaveBeenCalledOnce();
    expect(onTakeControl).toHaveBeenCalledOnce();
    expect(fullscreenListeners.size).toBe(1);

    fullscreenDocument.fullscreenElement = null;
    for (const listener of fullscreenListeners) listener();
    await flushCommands();

    expect(keyboardCapture.release).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledOnce();

    resolveGrant?.(true);
    await flushCommands(40);

    expect(keyboardCapture.release).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledOnce();
    expect(textContent(renderViewer({ onTakeControl, onRelease }))).toContain(
      "Full screen ended before desktop control became active.",
    );
  });
});

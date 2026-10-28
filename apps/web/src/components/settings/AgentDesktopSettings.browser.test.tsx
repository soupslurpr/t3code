import * as Schema from "effect/Schema";
import { createRuntimeCommand, type AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { Effect, Layer } from "effect";
import { RegistryContext } from "@effect/atom-react";
import {
  AgentDesktopId,
  EnvironmentId,
  ComputerAutomationActionResult,
  type ComputerAutomationAction,
  ThreadId,
  type AgentDesktopHumanInvokeInput,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent, cdp } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";

type Invocation = { environmentId: EnvironmentId; input: AgentDesktopHumanInvokeInput };

const state = vi.hoisted(() => ({
  command: null as AtomCommand<Invocation, unknown, never> | null,
  listing: null as Atom.Atom<unknown> | null,
  allowed: null as Atom.Writable<boolean> | null,
  releaseCapture: vi.fn(async () => undefined),
  invoke:
    vi.fn<
      (input: {
        environmentId: EnvironmentId;
        input: AgentDesktopHumanInvokeInput;
      }) => Promise<{ _tag: "Success"; value: unknown }>
    >(),
}));
vi.mock("./agentDesktopListing", () => ({ agentDesktopListingAtom: () => state.listing }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: [{ environmentId: "remote", label: "Remote" }],
  }),
}));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    invokeUserDesktopHuman: { label: "test.unused-user" },
    invokeAgentDesktopHuman: {
      label: "test.agent",
      permissionAtom: () => state.allowed,
      run: (...args: Parameters<NonNullable<typeof state.command>["run"]>) =>
        state.command!.run(...args),
    },
  },
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./agentDesktopKeyboardCapture", async (original) => ({
  ...(await original<typeof import("./agentDesktopKeyboardCapture")>()),
  acquireAgentDesktopKeyboardCapture: async () => ({ release: state.releaseCapture }),
}));
import {
  AgentDesktopSettings,
  ComputerDesktopViewer,
  type ViewerActionOutcome,
} from "./AgentDesktopSettings";
import { Dialog } from "../ui/dialog";
const decodeEvidenceActionResult = Schema.decodeSync(ComputerAutomationActionResult);

const owner = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("owner"),
  controllerId: "agent",
};
const desktopId = AgentDesktopId.make("isolated");
function setup(registry: AtomRegistry.AtomRegistry) {
  state.command = createRuntimeCommand(Atom.runtime(Layer.empty), {
    label: "test.agent-viewer",
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }: Invocation) =>
        JSON.stringify([environmentId, input.threadId]),
    },
    execute: (input: Invocation) => Effect.promise(async () => (await state.invoke(input)).value),
  });
  const allowed = Atom.make(true);
  state.allowed = allowed;
  state.releaseCapture.mockReset().mockResolvedValue(undefined);
  state.listing = Atom.make(
    AsyncResult.success({
      desktops: [
        {
          id: desktopId,
          label: "Agent desktop",
          owner,
          state: "ready",
          automaticParking: true,
          lastActiveAt: "2026-10-28T00:00:00.000Z",
          recoverableUntil: null,
        },
      ],
      availability: new Map(),
      error: null,
    }),
  );
  state.invoke.mockReset().mockImplementation(async ({ input }) => {
    if (!registry.get(allowed) && input.request.operation !== "release")
      throw new Error("Operate permission withdrawn");
    return {
      _tag: "Success",
      value:
        input.request.operation === "observation"
          ? { latestId: null }
          : input.request.operation === "snapshot"
            ? {
                display: { id: "primary" },
                screenshot: { state: "unavailable", detail: "Synthetic capture" },
              }
            : undefined,
    };
  });
  return allowed;
}

it("closes the Agent viewer on permission loss and requires a fresh Watch after restoration", async () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const allowed = setup(registry);
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <AgentDesktopSettings />
    </RegistryContext.Provider>,
  );
  using _timers = fakeTimers();
  await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await act(async () => registry.set(allowed, false));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(
    state.invoke.mock.calls
      .filter(([call]) => call.input.request.operation === "release")
      .map(([call]) => call),
  ).toContainEqual({
    environmentId: owner.environmentId,
    input: { threadId: owner.threadId, request: { operation: "release", owner, desktopId } },
  });
  const calls = state.invoke.mock.calls.length;
  await act(async () => registry.set(allowed, true));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(state.invoke).toHaveBeenCalledTimes(calls);
  await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(
    state.invoke.mock.calls.slice(calls).map(([call]) => call.input.request.operation),
  ).toContain("snapshot");
});

it.each(["request-view", "request-control", "return-control"] as const)(
  "releases a late Agent %s after permission loss without reviving the viewer",
  async (operation) => {
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const allowed = setup(registry);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <AgentDesktopSettings />
      </RegistryContext.Provider>,
    );
    using _timers = fakeTimers();
    using _fullscreen = vi
      .spyOn(document, "fullscreenElement", "get")
      .mockReturnValue(document.documentElement);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const invoke = state.invoke.getMockImplementation()!;
    state.invoke.mockImplementation(async (call) => {
      const result = await invoke(call);
      if (call.input.request.operation === operation) await pending;
      return result;
    });
    await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
    if (operation !== "request-view")
      await userEvent.click(page.getByRole("button", { name: "Take control", exact: true }));
    if (operation === "return-control")
      await userEvent.click(page.getByRole("button", { name: "Release control", exact: true }));
    await vi.waitFor(() =>
      expect(
        state.invoke.mock.calls.some(([call]) => call.input.request.operation === operation),
      ).toBe(true),
    );
    await act(async () => registry.set(allowed, false));
    await act(async () => registry.set(allowed, true));
    await act(async () => finish());
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(state.invoke.mock.calls.at(-1)?.[0]).toEqual({
      environmentId: owner.environmentId,
      input: { threadId: owner.threadId, request: { operation: "release", owner, desktopId } },
    });
    const calls = state.invoke.mock.calls.length;
    await act(async () => registry.set(allowed, true));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(state.invoke).toHaveBeenCalledTimes(calls);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  },
);

it.each(["act", "snapshot", "request-view", "request-control", "return-control"] as const)(
  "cancels queued Agent %s after permission restoration while keeping cleanup runnable",
  async (operation) => {
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const allowed = setup(registry);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <AgentDesktopSettings />
      </RegistryContext.Provider>,
    );
    using _timers = fakeTimers();
    using _fullscreen = vi
      .spyOn(document, "fullscreenElement", "get")
      .mockReturnValue(document.documentElement);
    if (operation !== "request-view")
      await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
    if (operation === "act" || operation === "return-control")
      await userEvent.click(page.getByRole("button", { name: "Take control", exact: true }));
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    using _pending = { [Symbol.dispose]: () => finish() };
    const invoke = state.invoke.getMockImplementation()!;
    state.invoke.mockImplementation(async (call) => {
      if (call.input.request.operation === "status") await pending;
      return invoke(call);
    });
    const held = state.command!.run(registry, {
      environmentId: owner.environmentId,
      input: { threadId: owner.threadId, request: { operation: "status", owner, desktopId } },
    });
    using scheduled = vi.spyOn(state.command!, "run");
    if (operation === "act")
      await act(() =>
        page
          .getByRole("application")
          .element()
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", bubbles: true }),
          ),
      );
    else if (operation === "request-view")
      await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
    else if (operation === "snapshot") await act(() => vi.advanceTimersByTimeAsync(750));
    else
      await userEvent.click(
        page.getByRole("button", {
          name: operation === "request-control" ? "Take control" : "Release control",
          exact: true,
        }),
      );
    await vi.waitFor(() =>
      expect(
        scheduled.mock.calls.some(([, call]) => call.input.request.operation === operation),
      ).toBe(true),
    );
    const before = state.invoke.mock.calls.length;
    await act(async () => registry.set(allowed, false));
    await act(async () => registry.set(allowed, true));
    await act(async () => {
      finish();
      await held;
    });
    await vi.waitFor(() =>
      expect(state.invoke.mock.calls.at(-1)?.[0].input.request.operation).toBe("release"),
    );
    const dispatched = state.invoke.mock.calls
      .slice(before)
      .map(([call]) => call.input.request.operation);
    expect(dispatched).not.toContain(operation);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  },
);

type ActionCallback = (
  actions: ReadonlyArray<ComputerAutomationAction>,
  current?: () => boolean,
) => Promise<ViewerActionOutcome | void>;
type NativeInputStep =
  | {
      method: "Input.dispatchKeyEvent";
      params: {
        type: "keyDown" | "keyUp";
        key: string;
        code: string;
        text?: string;
        autoRepeat?: boolean;
      };
    }
  | {
      method: "Input.imeSetComposition";
      params: { text: string; selectionStart: number; selectionEnd: number };
    }
  | { method: "Input.insertText"; params: { text: string } };
type InputTrace = {
  type: string;
  isTrusted: boolean;
  value: string;
  key?: string;
  code?: string;
  data?: string | null;
  inputType?: string;
  isComposing?: boolean;
};
async function nativeLayoutInput(steps: ReadonlyArray<NativeInputStep>) {
  const session = cdp();
  for (const step of steps) {
    switch (step.method) {
      case "Input.dispatchKeyEvent":
        await session.send(step.method, step.params);
        break;
      case "Input.imeSetComposition":
        await session.send(step.method, step.params);
        break;
      case "Input.insertText":
        await session.send(step.method, step.params);
        break;
    }
  }
}

function inputView(
  onAction: ActionCallback,
  controlling = true,
  session = 1,
  error: string | null = null,
) {
  return (
    <Dialog open>
      <ComputerDesktopViewer
        label="Layout"
        description="Remote screen input"
        observation={null}
        agentObservation={null}
        controlling={controlling}
        busy={false}
        error={error}
        inputSession={session}
        onTakeControl={async () => true}
        onRelease={async () => true}
        onAction={onAction}
      />
    </Dialog>
  );
}
function receiptFor(
  actions: ReadonlyArray<ComputerAutomationAction>,
  confirmed = true,
): Extract<ViewerActionOutcome, { status: "completed" }> {
  return {
    status: "completed",
    results: actions.map((a, index) =>
      a.type === "insert_text"
        ? {
            index,
            type: a.type,
            requestedCodePoints: [...a.text].length,
            acceptedCodePoints: [...a.text].length,
            confirmedCodePoints: confirmed ? [...a.text].length : 0,
            verification: confirmed ? "exact" : "unavailable",
            delivery: confirmed ? "accessibility" : "input-method",
            focusedEditable: confirmed,
            submission: "not-requested",
          }
        : a.type === "key_down" || a.type === "key_up"
          ? { index, type: a.type }
          : (() => {
              throw new Error(`Unexpected input action ${a.type}`);
            })(),
    ),
  };
}
function inputOf() {
  const input = page.getByRole("textbox").element();
  expect(input).not.toBeNull();
  return input as HTMLTextAreaElement;
}
async function commitInput(input: HTMLTextAreaElement, text: string, options: InputEventInit = {}) {
  await act(() => {
    input.value = text;
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: text, inputType: "insertText", ...options }),
    );
  });
}
async function keyEvents(
  surface: Element,
  ...events: Array<KeyboardEventInit & { type?: string; altGraph?: boolean }>
) {
  await act(() => {
    for (const value of events) {
      const event = new KeyboardEvent(value.type ?? "keydown", {
        bubbles: true,
        cancelable: true,
        ...value,
      });
      if (value.altGraph !== undefined)
        Object.defineProperty(event, "getModifierState", {
          value: (name: string) => (name === "AltGraph" ? value.altGraph : false),
        });
      surface.dispatchEvent(event);
    }
  });
}
function inputs(onAction: ReturnType<typeof vi.fn<ActionCallback>>) {
  return onAction.mock.calls.flatMap(([a]) => a);
}
const stroke = (key: string, code: string): NativeInputStep[] => [
  {
    method: "Input.dispatchKeyEvent",
    params: { type: "keyDown", key, code, text: key },
  },
  { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key, code } },
];
it.each(
  (
    [
      [
        "US text",
        "human_g5_v4",
        [
          "KeyH",
          "KeyU",
          "KeyM",
          "KeyA",
          "KeyN",
          "Minus",
          "KeyG",
          "Digit5",
          "Minus",
          "KeyV",
          "Digit4",
        ],
      ],
      [
        "Colemak text",
        "human_g5_v4",
        [
          "KeyH",
          "KeyI",
          "KeyM",
          "KeyA",
          "KeyJ",
          "Minus",
          "KeyT",
          "Digit5",
          "Minus",
          "KeyV",
          "Digit4",
        ],
      ],
      ["Colemak o/O and semicolon/colon", "oO;:", ["Semicolon", "Semicolon", "KeyP", "KeyP"]],
      ["Shift-derived digits and Caps intent", "!@aA", ["Digit1", "Digit2", "KeyA", "KeyA"]],
    ] as const
  ).map(
    ([name, text, codes]) =>
      [`expanded input: trusted Chromium ${name}`, { name, text, codes }] as const,
  ),
)("%s", async (_title, { text, codes }) => {
  const onAction = vi.fn<ActionCallback>(async (actions) => receiptFor(actions));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer, no route.
  const input = inputOf();
  const trace: InputTrace[] = [];
  for (const type of ["keydown", "keyup", "beforeinput", "input"])
    input.addEventListener(type, (event) =>
      trace.push({
        type,
        isTrusted: event.isTrusted,
        key: (event as KeyboardEvent).key,
        code: (event as KeyboardEvent).code,
        data: (event as InputEvent).data,
        value: input.value,
      }),
    );
  await act(() => input.focus());
  await act(async () => nativeLayoutInput([...text].flatMap((key, i) => stroke(key, codes[i]!))));
  expect(
    inputs(onAction)
      .filter((a) => a.type === "insert_text")
      .map((a) => a.text)
      .join(""),
  ).toBe(text);
  expect(inputs(onAction).filter((a) => a.type === "key_down" || a.type === "key_up")).toEqual([]);
  expect(trace.filter((e) => e.type === "input").every((e) => e.isTrusted)).toBe(true);
  expect(input.value).toBe("");
});
it.each(
  [false, true].map(
    (cancel) =>
      [
        `expanded input: Chromium CDP composition ${cancel ? "cancel" : "commit"}`,
        { cancel },
      ] as const,
  ),
)("%s", async (_title, { cancel }) => {
  const onAction = vi.fn<ActionCallback>(async (actions) => receiptFor(actions));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  const input = inputOf(),
    trace: InputTrace[] = [];
  for (const type of [
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "beforeinput",
    "input",
  ])
    input.addEventListener(type, (event) =>
      trace.push({
        type,
        isTrusted: event.isTrusted,
        data: (event as CompositionEvent).data,
        inputType: (event as InputEvent).inputType,
        isComposing: (event as InputEvent).isComposing,
        value: input.value,
      }),
    );
  await act(() => input.focus());
  await act(async () =>
    nativeLayoutInput([
      {
        method: "Input.imeSetComposition",
        params: { text: "雪", selectionStart: 1, selectionEnd: 1 },
      },
      {
        method: "Input.imeSetComposition",
        params: { text: "雪😀", selectionStart: 3, selectionEnd: 3 },
      },
    ]),
  );
  expect(onAction).not.toHaveBeenCalled();
  await act(async () =>
    nativeLayoutInput(
      cancel
        ? [
            {
              method: "Input.imeSetComposition",
              params: { text: "", selectionStart: 0, selectionEnd: 0 },
            },
          ]
        : [{ method: "Input.insertText", params: { text: "雪😀" } }],
    ),
  );
  expect(inputs(onAction)).toEqual(cancel ? [] : [{ type: "insert_text", text: "雪😀" }]);
  expect(input.value).toBe("");
  expect(trace.filter((e) => e.type === "compositionend").map((e) => e.data)).toEqual([
    cancel ? "" : "雪😀",
  ]);
  expect(trace.some((e) => e.type === "compositionstart" && e.isTrusted)).toBe(true);
  expect(trace.filter((e) => e.type === "input").every((e) => e.isTrusted)).toBe(true);
});
it("expanded input: trusted printable repeat commits exactly repeated text", async () => {
  const onAction = vi.fn<ActionCallback>(async (a) => receiptFor(a));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  const input = inputOf();
  await act(() => input.focus());
  await act(async () =>
    nativeLayoutInput([
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "o", code: "Semicolon", text: "o" },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "o", code: "Semicolon", text: "o", autoRepeat: true },
      },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "o", code: "Semicolon" } },
    ]),
  );
  expect(inputs(onAction)).toEqual([
    { type: "insert_text", text: "o" },
    { type: "insert_text", text: "o" },
  ]);
});
it.each(
  ["ControlLeft", "MetaLeft"].map(
    (modifier) =>
      [`expanded input: ${modifier} shortcut policy and captured release`, { modifier }] as const,
  ),
)("%s", async (_title, { modifier }) => {
  const onAction = vi.fn<ActionCallback>(async (a) => receiptFor(a));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  const surface = page.getByRole("application").element();
  const key = modifier.startsWith("Control") ? "Control" : "Meta",
    flag = key === "Control" ? "ctrlKey" : "metaKey";
  await keyEvents(
    surface,
    { key, code: modifier, [flag]: true },
    { key: "u", code: "KeyI", [flag]: true },
    { type: "keyup", key, code: modifier },
    { type: "keyup", key: "i", code: "KeyI" },
  );
  const shortcut = "i";
  expect(inputs(onAction)).toEqual([
    { type: "key_down", key: modifier },
    { type: "key_down", key: shortcut },
    { type: "key_up", key: modifier },
    { type: "key_up", key: shortcut },
  ]);
});
it("expanded input: two physical owners, repeat and unmatched up cannot steal one hold", async () => {
  const onAction = vi.fn<ActionCallback>(async (a) => receiptFor(a));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  const surface = page.getByRole("application").element();
  await keyEvents(
    surface,
    { key: "Enter", code: "Enter" },
    { key: "Enter", code: "Enter", repeat: true },
    { key: "Enter", code: "NumpadEnter" },
    { type: "keyup", key: "Enter", code: "Enter" },
    { type: "keyup", key: "Enter", code: "Enter" },
  );
  expect(inputs(onAction)).toEqual([{ type: "key_down", key: "Enter" }]);
  await keyEvents(surface, { type: "keyup", key: "Enter", code: "NumpadEnter" });
  expect(inputs(onAction)).toEqual([
    { type: "key_down", key: "Enter" },
    { type: "key_up", key: "Enter" },
  ]);
});
it("expanded input: AltGraph committed text is distinct from Ctrl+Alt shortcut", async () => {
  const onAction = vi.fn<ActionCallback>(async (a) => receiptFor(a));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  const input = inputOf();
  await keyEvents(input, { key: "@", code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true });
  await commitInput(input, "@");
  await keyEvents(
    input,
    { type: "keyup", key: "@", code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true },
    { key: "q", code: "KeyQ", ctrlKey: true, altKey: true, altGraph: false },
    { type: "keyup", key: "q", code: "KeyQ" },
  );
  expect(inputs(onAction)).toEqual([
    { type: "insert_text", text: "@" },
    { type: "key_down", key: "q" },
    { type: "key_up", key: "q" },
  ]);
});
it("expanded input: dead-key intermediate stays local and commit is sent once", async () => {
  const onAction = vi.fn<ActionCallback>(async (a) => receiptFor(a));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  const input = inputOf();
  await keyEvents(
    input,
    { key: "Dead", code: "Quote" },
    { type: "keyup", key: "Dead", code: "Quote" },
  );
  expect(onAction).not.toHaveBeenCalled();
  await commitInput(input, "é");
  expect(inputs(onAction)).toEqual([{ type: "insert_text", text: "é" }]);
});
it.each(
  ["blur", "control-loss", "session-change", "unmount"].map(
    (transition) =>
      [
        `expanded input: ${transition} invalidates owned keys and pending composition`,
        { transition },
      ] as const,
  ),
)("%s", async (_title, { transition }) => {
  const onAction = vi.fn<ActionCallback>(async (a) => receiptFor(a));
  await using screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  const input = inputOf();
  await keyEvents(input, { key: "Shift", code: "ShiftLeft", shiftKey: true });
  await act(() => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "雪";
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        isComposing: true,
        data: "雪",
      }),
    );
  });
  if (transition === "blur")
    await act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  else if (transition === "control-loss") await screen.rerender(inputView(onAction, false));
  else if (transition === "session-change") await screen.rerender(inputView(onAction, true, 2));
  else await screen.rerender(<div />);
  if (transition !== "unmount") {
    if (transition === "control-loss") await screen.rerender(inputView(onAction, true));
    await act(() => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "雪" }));
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "雪",
        }),
      );
    });
  }
  expect(inputs(onAction).filter((a) => a.type === "insert_text")).toEqual([]);
  expect(inputs(onAction)).toEqual([
    { type: "key_down", key: "ShiftLeft" },
    { type: "key_up", key: "ShiftLeft" },
  ]);
});
it("expanded input: completed composition tail notification cannot duplicate DOM text", async () => {
  const onAction = vi.fn<ActionCallback>(async (a) => receiptFor(a));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  const input = inputOf();
  await act(() => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "é";
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        isComposing: true,
        data: "é",
        inputType: "insertCompositionText",
      }),
    );
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "é" }));
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: "é", inputType: "insertFromComposition" }),
    );
  });
  await commitInput(input, "é");
  expect(inputs(onAction)).toEqual([
    { type: "insert_text", text: "é" },
    { type: "insert_text", text: "é" },
  ]);
});
it.each(
  ["confirmed", "accepted", "partial", "failed", "cancelled"].map(
    (outcome) => [`expanded input: ${outcome} receipt never retries`, { outcome }] as const,
  ),
)("%s", async (_title, { outcome }) => {
  const onAction = vi.fn<ActionCallback>(async (actions) => {
    if (outcome === "failed")
      return { status: "failed", detail: "Some text may already have been inserted" };
    if (outcome === "cancelled") return { status: "cancelled" };
    const receipt = receiptFor(actions, outcome === "confirmed");
    if (outcome !== "partial") return receipt;
    const first = receipt.results[0];
    if (first?.type !== "insert_text") throw new Error("Expected a committed text receipt");
    return { status: "completed", results: [{ ...first, acceptedCodePoints: 1 }] };
  });
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  await commitInput(inputOf(), "雪😀");
  expect(onAction).toHaveBeenCalledTimes(1);
  if (outcome === "confirmed")
    await expect
      .element(page.getByText("Text insertion confirmed by application readback."))
      .toBeVisible();
  if (outcome === "accepted")
    await expect
      .element(
        page.getByText(
          "Text accepted; application readback is unavailable. It has not been retried.",
        ),
      )
      .toBeVisible();
  if (outcome === "partial")
    await expect
      .element(page.getByText("Text outcome is unavailable or partial. It has not been retried."))
      .toBeVisible();
  if (outcome === "failed")
    await expect.element(page.getByText("Some text may already have been inserted")).toBeVisible();
  expect(inputOf().value).toBe("");
});
it("expanded input: queued invocation predicate cannot revive after control return", async () => {
  let finish!: (x: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  using _cleanup = { [Symbol.dispose]: () => finish({ status: "cancelled" }) };
  const onAction = vi.fn<ActionCallback>(async (_a, current) => {
    await pending;
    return current?.()
      ? { status: "failed", detail: "Unexpected dispatch" }
      : { status: "cancelled" };
  });
  await using screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  await commitInput(inputOf(), "old");
  const predicate = onAction.mock.calls[0]![1]!;
  expect(predicate()).toBe(true);
  await screen.rerender(inputView(onAction, false));
  await screen.rerender(inputView(onAction, true));
  expect(predicate()).toBe(false);
  await act(() => finish({ status: "cancelled" }));
  expect(onAction).toHaveBeenCalledTimes(1);
});

it.each(
  (["confirmed", "accepted", "partial-readback", "failed"] as const).map(
    (outcome) =>
      [`Agent parent preserves ${outcome} text outcome without retry`, { outcome }] as const,
  ),
)("%s", async (_title, { outcome }) => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  setup(registry);
  const native = state.invoke.getMockImplementation()!;
  state.invoke.mockImplementation(async (call) => {
    if (call.input.request.operation === "act") {
      if (outcome === "failed") throw new Error("Prefix may already be inserted; do not retry");
      const results = [
        decodeEvidenceActionResult({
          index: 0,
          type: "insert_text",
          requestedCodePoints: 2,
          acceptedCodePoints: 2,
          confirmedCodePoints: outcome === "confirmed" ? 2 : outcome === "partial-readback" ? 1 : 0,
          verification:
            outcome === "confirmed"
              ? "exact"
              : outcome === "partial-readback"
                ? "partial"
                : "unavailable",
          delivery: outcome !== "accepted" ? "accessibility" : "input-method",
          focusedEditable: outcome !== "accepted",
          submission: "not-requested",
        }),
      ];
      return { _tag: "Success", value: results };
    }

    return native(call);
  });
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <AgentDesktopSettings />
    </RegistryContext.Provider>,
  );
  using _timers = fakeTimers();
  using _fullscreen = vi
    .spyOn(document, "fullscreenElement", "get")
    .mockReturnValue(document.documentElement);
  await userEvent.click(screen.getByRole("button", { name: "Watch", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Take control", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Release control", exact: true }))
    .toBeVisible();
  const node = page.getByRole("textbox").element() as HTMLTextAreaElement;
  await act(() => {
    node.value = "雪😀";
    node.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: "雪😀", inputType: "insertText" }),
    );
  });
  if (outcome === "confirmed")
    await expect
      .element(page.getByText("Text insertion confirmed by application readback."))
      .toBeVisible();
  else if (outcome === "accepted")
    await expect
      .element(
        page.getByText(
          "Text accepted; application readback is unavailable. It has not been retried.",
        ),
      )
      .toBeVisible();
  else if (outcome === "partial-readback")
    await expect
      .element(
        page.getByText(
          "Text accepted; only part was confirmed by application readback. It has not been retried.",
        ),
      )
      .toBeVisible();
  else
    await expect
      .element(page.getByText("Prefix may already be inserted; do not retry").first())
      .toBeVisible();
  expect(
    state.invoke.mock.calls.filter(([call]) => call.input.request.operation === "act"),
  ).toHaveLength(1);
});

it("expanded input: release for an old destination never dispatches in a replacement session", async () => {
  const dispatched: unknown[] = [];
  const onAction = vi.fn<ActionCallback>(async (actions, current) => {
    if (current?.()) dispatched.push(...actions);
    return receiptFor(actions);
  });
  await using screen = await render(inputView(onAction, true, 1), { router: false }); // Isolated generation-dispatch boundary.
  await keyEvents(inputOf(), { key: "Shift", code: "ShiftLeft", shiftKey: true });
  expect(dispatched).toEqual([{ type: "key_down", key: "ShiftLeft" }]);
  await screen.rerender(inputView(onAction, true, 2));
  expect(dispatched).toEqual([{ type: "key_down", key: "ShiftLeft" }]);
  await commitInput(inputOf(), "new");
  expect(dispatched).toEqual([
    { type: "key_down", key: "ShiftLeft" },
    { type: "insert_text", text: "new" },
  ]);
});

it.each(
  (
    [
      ["punctuation", "/", "Slash", "/"],
      ["ideograph", "雪", "KeyA", "a"],
      ["long-s", "ſ", "KeyS", "s"],
      ["kelvin-sign", "K", "KeyK", "k"],
      ["combining-sequence", "e\u0301", "KeyE", "e"],
      ["multi-ascii", "ab", "KeyA", "a"],
      ["unidentified", "Unidentified", "KeyA", "a"],
      ["joined-emoji", "👩‍💻", "KeyA", "a"],
    ] as const
  ).flatMap(([label, key, code, physical]) =>
    (["ctrlKey", "metaKey"] as const).map(
      (flag) =>
        [
          `physical shortcut boundary: ${label} ${flag}`,
          { label, key, code, physical, flag },
        ] as const,
    ),
  ),
)("%s", async (_title, { key, code, physical, flag }) => {
  const onAction = vi.fn<ActionCallback>(async (actions) => receiptFor(actions));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated shortcut policy comparison.
  await keyEvents(inputOf(), { key, code, [flag]: true }, { type: "keyup", key, code });
  expect(inputs(onAction)).toEqual([
    { type: "key_down", key: physical },
    { type: "key_up", key: physical },
  ]);
});
it.each(
  (
    [
      ["u", "KeyI", "i", "u"],
      ["U", "KeyI", "i", "u"],
      ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowLeft"],
      ["Enter", "NumpadEnter", "Enter", "Enter"],
      ["F12", "F12", "F12", "F12"],
      ["CapsLock", "CapsLock", "CapsLock", "CapsLock"],
      ["Control", "ControlRight", "ControlRight", "ControlRight"],
      ["Meta", "MetaRight", "MetaRight", "MetaRight"],
      ["Shift", "ShiftLeft", "ShiftLeft", "ShiftLeft"],
    ] as const
  ).flatMap(([key, code, physical, logical]) =>
    (["ctrlKey", "metaKey"] as const).map(
      (flag) =>
        [
          `shortcut supported boundary: ${key} ${code} ${flag}`,
          { key, code, physical, logical, flag },
        ] as const,
    ),
  ),
)("%s", async (_title, { key, code, physical, flag }) => {
  const onAction = vi.fn<ActionCallback>(async (actions) => receiptFor(actions));
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated supported shortcut and captured release.
  const input = inputOf();
  await keyEvents(
    input,
    { key, code, [flag]: true },
    { key, code, [flag]: true, repeat: true },
    { type: "keyup", key: "Unidentified", code },
    { type: "keyup", key, code },
  );
  const expected = physical;
  expect(inputs(onAction)).toEqual([
    { type: "key_down", key: expected },
    { type: "key_up", key: expected },
  ]);
});
it.each(
  (
    [
      ["Control", "ControlLeft", "ctrlKey"],
      ["Meta", "MetaLeft", "metaKey"],
    ] as const
  ).map(
    ([key, code, flag]) =>
      [
        `physical shortcut boundary: ${key} keeps its captured release`,
        { key, code, flag },
      ] as const,
  ),
)("%s", async (_title, { key, code, flag }) => {
  const onAction = vi.fn<ActionCallback>(async (actions) => receiptFor(actions));
  await using _screen = await render(inputView(onAction), { router: false }); // Refused text must not consume the held modifier.
  const input = inputOf();
  await keyEvents(
    input,
    { key, code, [flag]: true },
    { key: "ſ", code: "KeyS", [flag]: true },
    { type: "keyup", key: "s", code: "KeyS" },
    { type: "keyup", key, code },
  );
  expect(inputs(onAction)).toEqual([
    { type: "key_down", key: code },
    { type: "key_down", key: "s" },
    { type: "key_up", key: "s" },
    { type: "key_up", key: code },
  ]);
});

function committedTextOutcome(text: string, confirmed = true): ViewerActionOutcome {
  const count = Array.from(text).length;
  return {
    status: "completed",
    results: [
      {
        index: 0,
        type: "insert_text",
        requestedCodePoints: count,
        acceptedCodePoints: count,
        confirmedCodePoints: confirmed ? count : 0,
        verification: confirmed ? "exact" : "unavailable",
        delivery: confirmed ? "accessibility" : "input-method",
        focusedEditable: confirmed,
        submission: "not-requested",
      },
    ],
  };
}

function pendingTextOutcome() {
  let resolve!: (outcome: ViewerActionOutcome) => void;
  const promise = new Promise<ViewerActionOutcome>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it("text receipt lifecycle: a new pending request does not display the previous confirmation", async () => {
  const pending = pendingTextOutcome();
  using _cleanup = { [Symbol.dispose]: () => pending.resolve({ status: "cancelled" }) };
  const onAction = vi.fn<ActionCallback>(async (actions): Promise<ViewerActionOutcome> =>
    onAction.mock.calls.length === 1 ? receiptFor(actions) : pending.promise,
  );
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  await commitInput(inputOf(), "first");
  await expect
    .element(page.getByText("Text insertion confirmed by application readback."))
    .toBeVisible();
  await commitInput(inputOf(), "second");
  await expect
    .element(page.getByText("Text insertion requested; awaiting a result."))
    .toBeVisible();
  await expect
    .element(page.getByText("Text insertion confirmed by application readback."))
    .not.toBeInTheDocument();
  await act(() => pending.resolve({ status: "cancelled" }));
  await expect
    .element(
      page.getByText(
        "Text request cancelled; insertion is not confirmed. It has not been retried.",
      ),
    )
    .toBeVisible();
  expect(onAction).toHaveBeenCalledTimes(2);
});

it("text receipt lifecycle: older success cannot replace the newer unconfirmed receipt", async () => {
  const first = pendingTextOutcome();
  const second = pendingTextOutcome();
  using _cleanup = {
    [Symbol.dispose]: () => {
      first.resolve({ status: "cancelled" });
      second.resolve({ status: "cancelled" });
    },
  };
  const onAction = vi.fn<ActionCallback>(async (): Promise<ViewerActionOutcome> =>
    onAction.mock.calls.length === 1 ? first.promise : second.promise,
  );
  await using _screen = await render(inputView(onAction), { router: false }); // Isolated viewer.
  await commitInput(inputOf(), "first");
  await commitInput(inputOf(), "second");
  await act(() => second.resolve(committedTextOutcome("second", false)));
  await expect
    .element(
      page.getByText(
        "Text accepted; application readback is unavailable. It has not been retried.",
      ),
    )
    .toBeVisible();
  await act(() => first.resolve(committedTextOutcome("first")));
  await expect
    .element(
      page.getByText(
        "Text accepted; application readback is unavailable. It has not been retried.",
      ),
    )
    .toBeVisible();
  expect(onAction).toHaveBeenCalledTimes(2);
});

it.each(
  (["control", "session"] as const).map(
    (loss) =>
      [
        `text receipt lifecycle: ${loss} loss clears old confirmation without another insertion`,
        { loss },
      ] as const,
  ),
)("%s", async (_title, { loss }) => {
  const onAction = vi.fn<ActionCallback>(async (actions) => receiptFor(actions));
  await using screen = await render(inputView(onAction, true, 1), { router: false }); // Isolated viewer.
  await commitInput(inputOf(), "first");
  await expect
    .element(page.getByText("Text insertion confirmed by application readback."))
    .toBeVisible();
  await screen.rerender(inputView(onAction, loss !== "control", loss === "session" ? 2 : 1));
  await expect
    .element(page.getByText("Text insertion confirmed by application readback."))
    .not.toBeInTheDocument();
  expect(onAction).toHaveBeenCalledTimes(1);
});

it.each(
  (["confirmed", "accepted", "partial-readback"] as const).map(
    (outcome) =>
      [
        `capture receipt separation: shared viewer keeps ${outcome} text beside a later observation error`,
        { outcome },
      ] as const,
  ),
)("%s", async (_title, { outcome }) => {
  const onAction = vi.fn<ActionCallback>(async (actions) => {
    const receipt = receiptFor(actions, outcome === "confirmed");
    return {
      ...receipt,
      results: receipt.results.map((result) =>
        decodeEvidenceActionResult(
          outcome === "partial-readback" && result.type === "insert_text"
            ? {
                ...result,
                confirmedCodePoints: 1,
                verification: "partial",
                delivery: "accessibility",
                focusedEditable: true,
              }
            : result,
        ),
      ),
    };
  });
  await using screen = await render(inputView(onAction), { router: false }); // Isolated shared viewer, no route.
  await commitInput(inputOf(), "雪😀");
  const message =
    outcome === "confirmed"
      ? "Text insertion confirmed by application readback."
      : outcome === "partial-readback"
        ? "Text accepted; only part was confirmed by application readback. It has not been retried."
        : "Text accepted; application readback is unavailable. It has not been retried.";
  await expect.element(page.getByText(message)).toBeVisible();
  await screen.rerender(inputView(onAction, true, 1, "LATER OBSERVATION FAILED"));
  await expect.element(page.getByText("LATER OBSERVATION FAILED")).toBeVisible();
  await expect.element(page.getByText(message)).toBeVisible();
  expect(onAction).toHaveBeenCalledTimes(1);
  await screen.rerender(inputView(onAction, false));
  await expect.element(page.getByText(message)).not.toBeInTheDocument();
  expect(onAction).toHaveBeenCalledTimes(1);
});

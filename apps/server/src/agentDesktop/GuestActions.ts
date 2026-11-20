// @effect-diagnostics nodeBuiltinImport:off - QEMU hardware events need wall-clock key and pointer transitions.
import * as NodeTimersPromises from "node:timers/promises";
import type {
  ComputerAutomationAction,
  ComputerAutomationActionResult,
  ComputerAutomationDisplay,
  ComputerAutomationFrame,
  ComputerAutomationPoint,
  ComputerAutomationTypeActionResult,
} from "@t3tools/contracts";
import type { GuestAccessibility } from "./GuestAccessibility.ts";
import type { GuestIo, MachinePaths } from "./MachinePorts.ts";
import { guestWheel } from "./GuestWheel.ts";
import type { GuestTools } from "./GuestTools.ts";
import * as Key from "./QemuInput.ts";

type TextAction = Extract<ComputerAutomationAction, { type: "type" | "insert_text" }>;
export async function typeGuestText(
  action: TextAction,
  index: number,
  semantic: GuestAccessibility,
  chord: (keys: readonly string[]) => Promise<void>,
  delay: (ms: number) => Promise<void>,
): Promise<ComputerAutomationTypeActionResult> {
  const text = action.text.replaceAll(/\r\n?/g, "\n");
  const n = Array.from(text).length,
    interval = action.type === "type" ? (action.intervalMs ?? 0) : 0;
  let confirmed = 0;
  let delivery: ComputerAutomationTypeActionResult["delivery"] = "none";
  if (n) {
    let result = await semantic.insert(text, interval);
    if (result.status === "replace-selection" && action.type === "type") {
      await chord(Key.qemuPressQcodes("Backspace"));
      await delay(25);
      result = await semantic.insert(text, interval);
    }
    if (result.status === "inserted") {
      if (result.injectedCodePoints !== n || result.confirmedCodePoints !== n)
        throw new Error(
          "The guest could not confirm exact insertion. The text may already be present.",
        );
      confirmed = n;
      delivery = "accessibility";
    } else if (
      result.status === "replace-selection" ||
      action.type === "insert_text" ||
      /[\n\t]/u.test(text)
    ) {
      throw new Error("Exact text insertion requires a focused accessible editable control.");
    } else if (Key.canTypeExactlyWithQemu(text)) {
      for (const keys of Key.qemuTextChords(text)) {
        await chord(keys);
        if (interval) await delay(interval);
      }
      delivery = "key-events";
    } else {
      if ((await semantic.ibus(text, interval)) !== n)
        throw new Error("IBus could not confirm full delivery. The text may already be present.");
      delivery = "input-method";
    }
  }
  const submit = action.type === "type" && action.submit;
  const withhold = submit && action.verification === "required" && confirmed !== n;
  if (submit && !withhold) {
    await delay(250);
    await chord(Key.qemuPressQcodes("Enter"));
    await delay(250);
  }
  return {
    index,
    type: action.type,
    requestedCodePoints: n,
    acceptedCodePoints: n,
    confirmedCodePoints: confirmed,
    verification: confirmed === n ? "exact" : "unavailable",
    delivery,
    focusedEditable: delivery === "accessibility",
    submission: !submit ? "not-requested" : withhold ? "withheld-unverified" : "submitted",
  };
}
export interface InputState {
  display: ComputerAutomationDisplay;
  frames: Map<string, ComputerAutomationFrame>;
  pointer: ComputerAutomationPoint | null;
  held: Map<string, readonly string[]>;
}
export function makeGuestActions(
  guest: GuestIo,
  vm: MachinePaths,
  state: InputState,
  semantic: GuestAccessibility,
  tools: GuestTools,
  signal: AbortSignal,
) {
  const delay = async (ms: number) => {
    if (ms > 0) await NodeTimersPromises.setTimeout(ms, undefined, { signal });
  };
  const events = async (events: readonly Key.QemuInputEvent[]) => {
    if (events.length) await guest.qmp(vm, "input-send-event", { events });
  };
  const keyEvent = (data: string, down: boolean): Key.QemuInputEvent => ({
    type: "key",
    data: { down, key: { type: "qcode", data } },
  });
  const chord = async (keys: readonly string[]) => {
    const end = keys.at(-1);
    if (!end) return;
    const down = new Set([...state.held.values()].flat());
    const mods = keys.slice(0, -1).filter((k) => !down.has(k));
    try {
      await events(mods.map((k) => keyEvent(k, true)));
      if (mods.length) await delay(25);
      await guest.qmp(vm, "send-key", { keys: [{ type: "qcode", data: end }], "hold-time": 25 });
      await delay(45);
    } finally {
      await events(
        [...(down.has(end) ? [] : [end]), ...mods.toReversed()].map((k) => keyEvent(k, false)),
      );
    }
  };
  const point = (frameId: string, x: number, y: number) => {
    const f = state.frames.get(frameId);
    if (!f || x >= f.width || y >= f.height)
      throw new Error("The point is outside a current desktop frame.");
    return {
      x: x * f.toDesktopLogical.scaleX + f.toDesktopLogical.offsetX,
      y: y * f.toDesktopLogical.scaleY + f.toDesktopLogical.offsetY,
    };
  };
  const move = async (p: ComputerAutomationPoint) => {
    const bounds = state.display.bounds;
    const absolute = (v: number, extent: number) =>
      Math.max(0, Math.min(32767, Math.round((v * 32767) / Math.max(1, extent - 1))));
    await events([
      { type: "abs", data: { axis: "x", value: absolute(p.x, bounds.width) } },
      { type: "abs", data: { axis: "y", value: absolute(p.y, bounds.height) } },
    ]);
    state.pointer = p;
  };
  const glide = async (
    to: ComputerAutomationPoint,
    ms: number,
    steps = Math.max(1, Math.ceil(ms / 16)),
  ) => {
    const from = state.pointer;
    if (!from || !ms) return move(to);
    for (let i = 1; i <= steps; i++) {
      await delay(ms / steps);
      await move({
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
    }
  };
  const btn = (button: string, down: boolean) => events([{ type: "btn", data: { button, down } }]);
  const release = async () => {
    const keys = [...new Set([...state.held.values()].flat())];
    await events(Key.qemuKeyUpEvents(keys));
    state.held.clear();
  };
  const activate = semantic.consume();
  const run = async (
    action: Exclude<ComputerAutomationAction, { type: "wait_for_change" }>,
    index: number,
  ): Promise<ComputerAutomationActionResult> => {
    signal.throwIfAborted();
    switch (action.type) {
      case "activate":
        if (await activate(action.targetId, false)) await chord(Key.qemuPressQcodes("Space"));
        break;
      case "activate_window":
        await activate(action.windowId, true);
        break;
      case "type":
      case "insert_text":
        return typeGuestText(action, index, semantic, chord, delay);
      case "hotkey":
        await chord(Key.qemuHotkeyQcodes(action.keys));
        break;
      case "press":
        await chord(Key.qemuPressQcodes(action.key, action.modifiers));
        break;
      case "key_down": {
        const id = Key.qemuLogicalKeyId(action.key);
        if (!state.held.has(id)) {
          const keys = Key.qemuKeyDownEvents(action.key).heldQcodes;
          const down = new Set([...state.held.values()].flat());
          state.held.set(id, keys);
          await events(keys.filter((k) => !down.has(k)).map((k) => keyEvent(k, true)));
        }
        break;
      }
      case "key_up": {
        const id = Key.qemuLogicalKeyId(action.key);
        const keys = state.held.get(id) ?? Key.qemuKeyDownEvents(action.key).heldQcodes;
        const remaining = new Set(
          [...state.held].filter(([name]) => name !== id).flatMap(([, list]) => list),
        );
        await events(Key.qemuKeyUpEvents(keys.filter((k) => !remaining.has(k))));
        state.held.delete(id);
        break;
      }
      case "move":
        await glide(point(action.frameId, action.x, action.y), action.durationMs ?? 0);
        await delay(action.settleMs ?? 250);
        break;
      case "click": {
        await move(point(action.frameId, action.x, action.y));
        const button = action.button ?? "left";
        for (let i = 0; i < (action.count ?? 1); i++) {
          try {
            await btn(button, true);
            await delay(10);
          } finally {
            await btn(button, false);
          }
          await delay(10);
        }
        break;
      }
      case "drag": {
        const end = point(action.frameId, action.endX, action.endY);
        await move(point(action.frameId, action.startX, action.startY));
        const button = action.button ?? "left";
        try {
          await btn(button, true);
          await glide(end, action.durationMs ?? 500, action.steps);
        } finally {
          await btn(button, false);
        }
        break;
      }
      case "wheel": {
        if (action.frameId !== undefined && action.x !== undefined && action.y !== undefined)
          await move(point(action.frameId, action.x, action.y));
        const h = action.horizontalTicks ?? 0,
          v = action.verticalTicks ?? 0;
        if (h !== 0) {
          await guestWheel(guest, vm, tools, h, v, signal);
        } else {
          const button = v < 0 ? "wheel-up" : "wheel-down";
          for (let i = 0; i < Math.abs(v); i++) {
            await btn(button, true);
            await btn(button, false);
          }
        }
        return { index, type: action.type, horizontalTicks: h, verticalTicks: v };
      }
      case "wait":
        await delay(action.durationMs);
        break;
    }
    return { index, type: action.type };
  };
  return { run, release };
}

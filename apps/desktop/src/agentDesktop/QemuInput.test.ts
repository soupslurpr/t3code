import { assert, describe, it } from "@effect/vitest";

import {
  QemuInputValidationError,
  qemuHotkeyQcodes,
  qemuKeyDownEvents,
  qemuKeyUpEvents,
  qemuPressQcodes,
  qemuTextChords,
  resolveQemuKey,
} from "./QemuInput.ts";

describe("QemuInput", () => {
  it("normalizes named keys and printable characters", () => {
    assert.deepEqual(resolveQemuKey("CTRL"), { qcode: "ctrl", implicitModifiers: [] });
    assert.deepEqual(resolveQemuKey("ArrowDown"), { qcode: "down", implicitModifiers: [] });
    assert.deepEqual(resolveQemuKey("A"), { qcode: "a", implicitModifiers: ["shift"] });
    assert.deepEqual(resolveQemuKey("?"), { qcode: "slash", implicitModifiers: ["shift"] });
    let error: unknown;
    try {
      resolveQemuKey("Hyper");
    } catch (cause) {
      error = cause;
    }
    assert.instanceOf(error, QemuInputValidationError);
    assert.deepInclude(error, {
      code: "unsupported-key",
      field: "key",
      received: "Hyper",
      expected: ["named key", "single printable ASCII character"],
      phase: "validation",
    });
  });

  it("presses and releases hotkeys atomically", () => {
    assert.deepEqual(qemuHotkeyQcodes(["Control", "Shift", "N"]), ["ctrl", "shift", "n"]);
    let error: unknown;
    try {
      qemuHotkeyQcodes(["Control", "Ctrl", "N"]);
    } catch (cause) {
      error = cause;
    }
    assert.instanceOf(error, QemuInputValidationError);
    assert.deepInclude(error, {
      code: "duplicate-hotkey-key",
      field: "keys[1]",
      received: "Ctrl",
      expected: ["key not already present in this chord"],
      phase: "validation",
    });
  });

  it("holds implicit modifiers until the matching key release", () => {
    const held = qemuKeyDownEvents("A");
    assert.deepEqual(held.heldQcodes, ["shift", "a"]);
    assert.deepEqual(qemuKeyUpEvents(held.heldQcodes), [
      { type: "key", data: { down: false, key: { type: "qcode", data: "a" } } },
      { type: "key", data: { down: false, key: { type: "qcode", data: "shift" } } },
    ]);
  });

  it("builds timed text chords with a Unicode fallback", () => {
    const chords = qemuTextChords("A’→");
    assert.deepEqual(chords[0], ["shift", "a"]);
    assert(chords.some((chord) => chord.join("+") === "ctrl+shift+u"));
    assert(chords.some((chord) => chord.includes("2")));
    assert(chords.some((chord) => chord.includes("1")));
    assert.deepEqual(qemuPressQcodes("Enter"), ["ret"]);
  });
});

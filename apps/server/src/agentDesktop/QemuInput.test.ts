import { assert, describe, it } from "@effect/vitest";

import {
  canTypeExactlyWithQemu,
  QemuInputValidationError,
  qemuHotkeyQcodes,
  qemuKeyDownEvents,
  qemuKeyUpEvents,
  qemuLogicalKeyId,
  qemuPressQcodes,
  qemuTextChords,
  resolveQemuKey,
} from "./QemuInput.ts";

describe("QemuInput", () => {
  it("normalizes named keys and printable characters", () => {
    assert.deepEqual(resolveQemuKey("CTRL"), { qcode: "ctrl", implicitModifiers: [] });
    assert.deepEqual(resolveQemuKey("ArrowDown"), { qcode: "down", implicitModifiers: [] });
    assert.deepEqual(resolveQemuKey("LEFT"), { qcode: "left", implicitModifiers: [] });
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

  it("keeps keypad keys distinct from the main keyboard", () => {
    for (const digit of "0123456789") {
      assert.deepEqual(qemuPressQcodes(`Numpad${digit}`), [`kp_${digit}`]);
      assert.deepEqual(qemuPressQcodes(digit), [digit]);
    }
    for (const [key, qcode] of [
      ["NumpadEnter", "kp_enter"],
      ["NumpadMultiply", "kp_multiply"],
      ["NumpadAdd", "kp_add"],
      ["NumpadSubtract", "kp_subtract"],
      ["NumpadDecimal", "kp_decimal"],
      ["NumpadDivide", "kp_divide"],
      ["NumpadEqual", "kp_equals"],
      ["NumLock", "num_lock"],
    ] as const) {
      assert.deepEqual(qemuPressQcodes(key), [qcode]);
    }
    assert.deepEqual(qemuHotkeyQcodes(["Enter", "NumpadEnter"]), ["ret", "kp_enter"]);
    assert.throws(() => resolveQemuKey("Numpad10"), QemuInputValidationError);
    assert.throws(() => resolveQemuKey("constructor"), QemuInputValidationError);
  });

  it("supports keypad camera chords and pairs held-key aliases without implicit modifiers", () => {
    assert.deepEqual(qemuHotkeyQcodes(["Numpad0", "Alt", "Control"]), ["ctrl", "alt", "kp_0"]);
    const held = qemuKeyDownEvents("Numpad4");
    assert.deepEqual(held.events, [
      { type: "key", data: { down: true, key: { type: "qcode", data: "kp_4" } } },
    ]);
    assert.deepEqual(qemuKeyUpEvents(held.heldQcodes), [
      { type: "key", data: { down: false, key: { type: "qcode", data: "kp_4" } } },
    ]);
    assert.equal(qemuLogicalKeyId("Numpad4"), qemuLogicalKeyId("NUMPAD4"));
    assert.throws(() => qemuHotkeyQcodes(["Numpad4", "numpad4"]), QemuInputValidationError);
  });

  it("builds exact ASCII text chords and rejects unsafe Unicode fallback", () => {
    assert.isTrue(canTypeExactlyWithQemu("A->"));
    assert.isFalse(canTypeExactlyWithQemu("A->\n"));
    assert.isFalse(canTypeExactlyWithQemu("A->\t"));
    assert.isFalse(canTypeExactlyWithQemu("A’→"));
    const chords = qemuTextChords("A->");
    assert.deepEqual(chords[0], ["shift", "a"]);
    assert.deepEqual(chords.slice(1), [["minus"], ["shift", "dot"]]);
    let error: unknown;
    try {
      qemuTextChords("A’→");
    } catch (cause) {
      error = cause;
    }
    assert.instanceOf(error, QemuInputValidationError);
    assert.equal(error.code, "unsupported-text");
    assert.throws(() => qemuTextChords("first\nsecond"), QemuInputValidationError);
    assert.deepEqual(qemuPressQcodes("Enter"), ["ret"]);
  });
});

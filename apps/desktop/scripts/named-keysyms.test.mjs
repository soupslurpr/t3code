import { assert, describe, it } from "vite-plus/test";

import { keypadEvdevCode, resolveNamedKeysym } from "../resources/computer-use/named-keysyms.js";

describe("named keyboard symbols", () => {
  it("keeps keypad digits distinct from top-row digits and navigation keys", () => {
    for (const digit of "0123456789") {
      assert.equal(resolveNamedKeysym(`Numpad${digit}`), 0xffb0 + Number(digit));
      assert.notEqual(resolveNamedKeysym(`Numpad${digit}`), digit.codePointAt(0));
    }
    assert.notEqual(resolveNamedKeysym("Numpad1"), resolveNamedKeysym("End"));
    assert.notEqual(resolveNamedKeysym("Numpad7"), resolveNamedKeysym("Home"));
  });

  it("resolves keypad operators and Enter without collapsing them into printable keys", () => {
    for (const [key, keysym] of [
      ["NumpadEnter", 0xff8d],
      ["NumpadMultiply", 0xffaa],
      ["NumpadAdd", 0xffab],
      ["NumpadSubtract", 0xffad],
      ["NumpadDecimal", 0xffae],
      ["NumpadDivide", 0xffaf],
      ["NumpadEqual", 0xffbd],
      ["NumLock", 0xff7f],
    ]) {
      assert.equal(resolveNamedKeysym(key), keysym);
    }
    assert.notEqual(resolveNamedKeysym("NumpadEnter"), resolveNamedKeysym("Enter"));
  });

  it("normalizes camera chords and held-key aliases to the same key identities", () => {
    assert.deepEqual(
      ["Control", "Alt", "Numpad0"].map(resolveNamedKeysym),
      [0xffe3, 0xffe9, 0xffb0],
    );
    assert.equal(resolveNamedKeysym("Numpad4"), resolveNamedKeysym("NUMPAD4"));
    assert.equal(resolveNamedKeysym("Ctrl"), resolveNamedKeysym("Control"));
    assert.equal(resolveNamedKeysym("Return"), resolveNamedKeysym("Enter"));
    assert.equal(resolveNamedKeysym("ArrowLeft"), resolveNamedKeysym("Left"));
  });

  it("leaves invalid names for the caller to reject", () => {
    for (const key of ["Numpad10", "Numpad-1", "Numpad", "constructor", "__proto__", "Hyper"]) {
      assert.isUndefined(resolveNamedKeysym(key));
    }
  });

  it("routes keypad symbols to physical events without implicit Shift or Num Lock changes", () => {
    for (const [key, code] of [
      ["Numpad0", 82],
      ["Numpad1", 79],
      ["Numpad2", 80],
      ["Numpad3", 81],
      ["Numpad4", 75],
      ["Numpad5", 76],
      ["Numpad6", 77],
      ["Numpad7", 71],
      ["Numpad8", 72],
      ["Numpad9", 73],
      ["NumpadEnter", 96],
      ["NumpadMultiply", 55],
      ["NumpadAdd", 78],
      ["NumpadSubtract", 74],
      ["NumpadDecimal", 83],
      ["NumpadDivide", 98],
      ["NumpadEqual", 117],
      ["NumLock", 69],
    ]) {
      assert.equal(keypadEvdevCode(resolveNamedKeysym(key)), code);
    }
    for (const key of ["Control", "Shift", "Alt", "Enter", "End", "Home"]) {
      assert.isUndefined(keypadEvdevCode(resolveNamedKeysym(key)));
    }
    for (const character of "0123456789.+-*/=") {
      assert.isUndefined(keypadEvdevCode(character.codePointAt(0)));
    }
  });
});

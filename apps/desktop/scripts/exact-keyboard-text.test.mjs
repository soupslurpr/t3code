import { assert, describe, it } from "vite-plus/test";

import { canTypeExactlyWithKeyboardEvents } from "../resources/computer-use/exact-keyboard-text.js";

describe("canTypeExactlyWithKeyboardEvents", () => {
  it("accepts exact ASCII keyboard text", () => {
    assert.isTrue(canTypeExactlyWithKeyboardEvents("ASCII -> exact"));
  });

  it("rejects literal Newline and Tab before keyboard fallback", () => {
    assert.isFalse(canTypeExactlyWithKeyboardEvents("prefix\nnext line"));
    assert.isFalse(canTypeExactlyWithKeyboardEvents("prefix\tfield"));
  });

  it("rejects text that would need an application input method", () => {
    assert.isFalse(canTypeExactlyWithKeyboardEvents("That’s exact → 😀"));
    assert.isFalse(canTypeExactlyWithKeyboardEvents("e\u0301"));
    assert.isFalse(canTypeExactlyWithKeyboardEvents("\ud800"));
  });
});

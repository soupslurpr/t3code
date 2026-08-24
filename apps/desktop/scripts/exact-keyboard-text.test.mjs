import { assert, describe, it } from "vite-plus/test";

import {
  canTypeExactlyWithKeyboardEvents,
  exactTextFallback,
} from "../resources/computer-use/exact-keyboard-text.js";

describe("canTypeExactlyWithKeyboardEvents", () => {
  it("accepts printable ASCII without control characters", () => {
    assert.isTrue(canTypeExactlyWithKeyboardEvents("ASCII -> exact"));
    assert.isFalse(canTypeExactlyWithKeyboardEvents("next\nline"));
    assert.isFalse(canTypeExactlyWithKeyboardEvents("next\tfield"));
  });

  it("rejects text that would need an application input method", () => {
    assert.isFalse(canTypeExactlyWithKeyboardEvents("That’s exact → 😀"));
    assert.isFalse(canTypeExactlyWithKeyboardEvents("e\u0301"));
    assert.isFalse(canTypeExactlyWithKeyboardEvents("\ud800"));
  });

  it("requires semantic insertion for newline and tab before fallback", () => {
    assert.equal(exactTextFallback("ASCII -> exact"), "key-events");
    assert.equal(exactTextFallback("That’s exact → 😀"), "input-method");
    assert.equal(exactTextFallback("prefix\nsecond line"), "semantic-required");
    assert.equal(exactTextFallback("prefix\tfield"), "semantic-required");
  });
});

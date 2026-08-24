/** Verifies readback independently of an application's text-insertion interface. */
import { assert, describe, it } from "vite-plus/test";

import {
  captureTextInsertion,
  confirmTextInsertion,
} from "../resources/computer-use/text-insertion-verification.js";

/** Creates a readable control without an EditableText interface. */
function makeControl(value = "", caret = Array.from(value).length) {
  const state = { value, caret, selection: null };
  const text = {
    get_character_count: () => Array.from(state.value).length,
    get_caret_offset: () => state.caret,
    get_n_selections: () => (state.selection === null ? 0 : 1),
    get_selection: () => state.selection,
  };
  const accessible = {
    path: "/accessible/entry",
    get_process_id: () => 42,
    get_text_iface: () => text,
  };
  return {
    accessible,
    state,
    read: (_text, start, end) => Array.from(state.value).slice(start, end).join(""),
  };
}

describe("text insertion verification", () => {
  it("confirms Unicode inserted into the middle of a readable control", () => {
    const control = makeControl("before  after", 7);
    const before = captureTextInsertion(control.accessible, (text) => text.get_selection(0));
    const value = "雪😀";

    control.state.value = "before 雪😀 after";
    control.state.caret = 9;

    assert.equal(confirmTextInsertion(before, control.accessible, value, control.read), 2);
  });

  it("confirms replacement of the previously selected text", () => {
    const control = makeControl("old suffix", 3);
    control.state.selection = { start_offset: 0, end_offset: 3 };
    const before = captureTextInsertion(control.accessible, (text) => text.get_selection(0));

    control.state.value = "new text suffix";
    control.state.caret = 8;
    control.state.selection = null;

    assert.equal(confirmTextInsertion(before, control.accessible, "new text", control.read), 8);
  });

  it("does not mistake existing matching text for a successful insertion", () => {
    const control = makeControl("same", 4);
    const before = captureTextInsertion(control.accessible, (text) => text.get_selection(0));

    assert.equal(confirmTextInsertion(before, control.accessible, "same", control.read), 0);
  });

  it("rejects changed focus, altered text, and unexpected caret movement", () => {
    const control = makeControl();
    const before = captureTextInsertion(control.accessible, (text) => text.get_selection(0));
    control.state.value = "text";
    control.state.caret = 4;
    const otherControl = { ...control.accessible, path: "/accessible/other" };

    assert.equal(confirmTextInsertion(before, otherControl, "text", control.read), 0);
    assert.equal(confirmTextInsertion(before, control.accessible, "TEXT", control.read), 0);
    control.state.caret = 0;
    assert.equal(confirmTextInsertion(before, control.accessible, "text", control.read), 0);
    assert.equal(confirmTextInsertion(before, null, "text", control.read), 0);
  });

  it("rejects unreadable or invalid insertion ranges", () => {
    const control = makeControl("text", -1);
    assert.isNull(captureTextInsertion(control.accessible, (text) => text.get_selection(0)));
    control.state.caret = 4;
    control.state.selection = { start_offset: 2, end_offset: 8 };
    assert.isNull(captureTextInsertion(control.accessible, (text) => text.get_selection(0)));
    assert.isNull(captureTextInsertion(null));
    assert.isNull(
      captureTextInsertion({
        get_text_iface: () => {
          throw new Error("unreadable");
        },
      }),
    );
  });

  it("rejects an empty range when the application reports a selection", () => {
    const control = makeControl("Readback 雪😀");
    control.state.selection = { start_offset: 0, end_offset: 0 };
    assert.isNull(captureTextInsertion(control.accessible, (text) => text.get_selection(0)));
  });

  it("returns no confirmation when the control disappears during readback", () => {
    const control = makeControl();
    const before = captureTextInsertion(control.accessible, (text) => text.get_selection(0));
    control.state.value = "text";
    control.state.caret = 4;

    assert.equal(
      confirmTextInsertion(before, control.accessible, "text", () => {
        throw new Error("control disappeared");
      }),
      0,
    );
  });
});

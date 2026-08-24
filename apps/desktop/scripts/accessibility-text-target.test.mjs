import { assert, describe, it } from "vite-plus/test";

import { findAccessibilityTextTarget } from "../resources/computer-use/accessibility-text-target.js";

const atspi = {
  StateType: Object.fromEntries(
    ["FOCUSED", "EDITABLE", "SHOWING", "VISIBLE", "ENABLED", "SENSITIVE", "DEFUNCT"].map(
      (state) => [state, state],
    ),
  ),
  Role: { COMBO_BOX: "combo" },
  RelationType: { CONTROLLER_FOR: "controls" },
};
const limits = { nodes: 100, children: 20 };

/** Creates a small AT-SPI tree with explicit focus and control relationships. */
function node(
  path,
  { children = [], states = [], controls = [], role = "entry", processId = 1 } = {},
) {
  return {
    path,
    get_process_id: () => processId,
    get_state_set: () => ({ contains: (state) => states.includes(state) }),
    get_interfaces: () => ["Text"],
    get_role: () => role,
    get_child_count: () => children.length,
    get_child_at_index: (index) => children[index],
    get_relation_set: () => [
      {
        get_relation_type: () => "controls",
        get_n_targets: () => controls.length,
        get_target: (index) => controls[index],
      },
    ],
  };
}

/** Creates a combobox whose selected result owns accessibility focus. */
function palette() {
  const option = node("/option", { states: ["FOCUSED"] });
  const list = node("/list", { children: [option] });
  const input = node("/input", {
    states: ["EDITABLE", "VISIBLE", "SHOWING", "ENABLED"],
    role: "combo",
    controls: [list],
  });
  return { input, list, option, root: node("/window", { children: [input, list] }) };
}

describe("findAccessibilityTextTarget", () => {
  it("reserves indirect combobox focus for readback", () => {
    const { root, input } = palette();
    assert.isNull(findAccessibilityTextTarget(root, atspi, limits));
    assert.equal(findAccessibilityTextTarget(root, atspi, limits, true), input);
  });

  it("prefers a directly focused editor over related controls", () => {
    const { input, list } = palette();
    const editor = node("/editor", {
      states: ["EDITABLE", "VISIBLE", "SHOWING", "ENABLED", "FOCUSED"],
    });
    const root = node("/window", { children: [input, list, editor] });
    assert.equal(findAccessibilityTextTarget(root, atspi, limits, true), editor);
  });

  it("rejects multiple comboboxes controlling the same focused result", () => {
    const { input, list } = palette();
    const other = { ...input, path: "/other" };
    assert.isNull(
      findAccessibilityTextTarget(
        node("/window", { children: [input, other, list] }),
        atspi,
        limits,
        true,
      ),
    );
  });

  it("rejects conflicting focused editors and cyclic trees", () => {
    const states = ["EDITABLE", "VISIBLE", "SHOWING", "ENABLED", "FOCUSED"];
    const first = node("/first", { states });
    const second = node("/second", { states });
    const children = [first, second];
    const root = node("/window", { children });
    assert.isNull(findAccessibilityTextTarget(root, atspi, limits, true));
    children.splice(1, 1, root);
    assert.isNull(findAccessibilityTextTarget(root, atspi, limits, true));
  });

  it("does not follow remembered focus outside the selected window", () => {
    const { input } = palette();
    assert.isNull(
      findAccessibilityTextTarget(node("/window", { children: [input] }), atspi, limits, true),
    );
  });

  it("does not confuse equal object paths from different processes", () => {
    const { input } = palette();
    const foreignList = node("/list", { processId: 2, states: ["FOCUSED"] });
    assert.isNull(
      findAccessibilityTextTarget(
        node("/window", { children: [input, foreignList] }),
        atspi,
        limits,
        true,
      ),
    );
  });

  it("rejects truncated or disappearing trees instead of assuming unique focus", () => {
    const { root } = palette();
    assert.isNull(findAccessibilityTextTarget(root, atspi, { ...limits, nodes: 2 }, true));
    assert.isNull(findAccessibilityTextTarget(root, atspi, { ...limits, children: 1 }, true));
    assert.isNull(
      findAccessibilityTextTarget(
        {
          ...root,
          get_child_count: () => {
            throw new Error("window disappeared");
          },
        },
        atspi,
        limits,
        true,
      ),
    );
  });

  it("rejects hidden editors and non-combobox controllers", () => {
    const { input, root } = palette();
    input.get_role = () => "entry";
    assert.isNull(findAccessibilityTextTarget(root, atspi, limits, true));
    input.get_role = () => "combo";
    input.get_state_set = () => ({ contains: () => false });
    assert.isNull(findAccessibilityTextTarget(root, atspi, limits, true));
  });
});

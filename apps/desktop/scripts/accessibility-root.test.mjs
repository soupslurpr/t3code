import { assert, describe, it } from "vite-plus/test";

import {
  prepareAccessibilityRoot,
  readAccessibilityWindowFocus,
} from "../resources/computer-use/accessibility-root.js";

describe("prepareAccessibilityRoot", () => {
  it("exposes lazy window content after discarding its previously cached children", () => {
    const entry = { role: "entry" };
    let children = [];
    let cachedChildren = children;
    const window = {
      get_attributes: () => {
        children = [entry];
        return {};
      },
      clear_cache: () => {
        cachedChildren = children;
      },
      get_child_at_index: (index) => cachedChildren[index] ?? null,
    };

    assert.isNull(window.get_child_at_index(0));
    prepareAccessibilityRoot(window);
    assert.equal(window.get_child_at_index(0), entry);
  });

  it("refreshes cached content when attributes are unavailable", () => {
    let refreshed = false;
    prepareAccessibilityRoot({
      get_attributes: () => {
        throw new Error("attributes unavailable");
      },
      clear_cache: () => {
        refreshed = true;
      },
    });
    assert.isTrue(refreshed);
  });

  it("tolerates a window disappearing during preparation", () => {
    assert.doesNotThrow(() =>
      prepareAccessibilityRoot({
        get_attributes: () => {
          throw new Error("window disappeared");
        },
        clear_cache: () => {
          throw new Error("window disappeared");
        },
      }),
    );
  });
});

describe("readAccessibilityWindowFocus", () => {
  const stateTypes = { ACTIVE: "active", FOCUSED: "focused", DEFUNCT: "defunct" };

  it("rejects remembered child focus after the window loses desktop focus", () => {
    let active = true;
    let cachedActive = active;
    const entry = { get_state_set: () => ({ contains: (state) => state === "focused" }) };
    const window = {
      clear_cache: () => {
        cachedActive = active;
      },
      get_state_set: () => ({ contains: (state) => state === "active" && cachedActive }),
      get_child_count: () => 1,
      get_child_at_index: () => entry,
    };

    assert.isTrue(readAccessibilityWindowFocus(window, stateTypes));
    active = false;
    assert.isTrue(window.get_child_at_index(0).get_state_set().contains("focused"));
    assert.isFalse(readAccessibilityWindowFocus(window, stateTypes));
  });

  it("accepts focus on the top-level window itself", () => {
    assert.isTrue(
      readAccessibilityWindowFocus(
        {
          clear_cache: () => undefined,
          get_state_set: () => ({ contains: (state) => state === "focused" }),
        },
        stateTypes,
      ),
    );
  });

  it("rejects stale state from a defunct window", () => {
    assert.isFalse(
      readAccessibilityWindowFocus(
        {
          clear_cache: () => undefined,
          get_state_set: () => ({ contains: (state) => state === "active" || state === "defunct" }),
        },
        stateTypes,
      ),
    );
  });
});

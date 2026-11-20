import Atspi from "gi://Atspi?version=2.0";
import GLib from "gi://GLib";
import {
  MAX_NODES,
  MAX_CHILDREN,
  MAX_OBJECT_PATH_LENGTH,
  MAX_TEXT_INSERTION_LENGTH,
  MAX_TEXT_INSERTION_INTERVAL_MS,
  TEXT_FOCUS_TIMEOUT_MS,
  TEXT_FOCUS_INTERVAL_MS,
  TEXT_VERIFY_SETTLE_MS,
  WINDOW_FOCUS_SETTLE_MS,
  WINDOW_RESOLVE_TIMEOUT_MS,
  WINDOW_RESOLVE_INTERVAL_MS,
  PREFERRED_ACTIONS,
  PREFERRED_WINDOW_ACTIONS,
  errorDetail,
  accessibilityText,
  hasState,
  readTextRange,
  initializeAccessibility,
  listRoots,
  rootContainsFocus,
  tryAccessibilityFocus,
  trySelectKeyboardTarget,
  selectFocusedRoot,
  readActivation,
  snapshot,
} from "./atspi-tree.js";
/** Resolves one bounded child-index path below a top-level window. */
function resolvePath(root, path) {
  let accessible = root;
  for (const childIndex of path) {
    if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex >= MAX_CHILDREN) return null;
    accessible = accessible.get_child_at_index(childIndex);
    if (accessible === null) return null;
  }
  return accessible;
}

/** Re-resolves and activates one semantic target locator. */
function activate(locator) {
  const matchingRoots = listRoots().filter(
    (root) =>
      root.application === locator.application &&
      root.processId === locator.processId &&
      root.objectPath === locator.objectPath,
  );
  if (matchingRoots.length !== 1) {
    throw Object.assign(new Error("the semantic target window is no longer unique"), {
      code: "stale-accessibility-target",
    });
  }
  const root = matchingRoots[0];
  const active = hasState(root.accessible.get_state_set(), Atspi.StateType.ACTIVE);
  if (!active && !rootContainsFocus(root.accessible, MAX_NODES).focused) {
    throw Object.assign(new Error("the semantic target window is no longer focused"), {
      code: "stale-accessibility-target",
    });
  }
  const accessible = resolvePath(root.accessible, locator.path);
  if (accessible === null) {
    throw Object.assign(new Error("the semantic target path no longer exists"), {
      code: "stale-accessibility-target",
    });
  }
  const role = accessibilityText(accessible.get_role_name(), 128).toLowerCase();
  const name = accessibilityText(accessible.get_name(), 512);
  if (role !== locator.role || name !== locator.name) {
    throw Object.assign(new Error("the semantic target changed since the observation"), {
      code: "stale-accessibility-target",
    });
  }
  const states = accessible.get_state_set();
  if (
    hasState(states, Atspi.StateType.DEFUNCT) ||
    !hasState(states, Atspi.StateType.VISIBLE) ||
    !hasState(states, Atspi.StateType.SHOWING) ||
    (!hasState(states, Atspi.StateType.ENABLED) && !hasState(states, Atspi.StateType.SENSITIVE))
  ) {
    throw Object.assign(new Error("the semantic target is no longer visible and enabled"), {
      code: "stale-accessibility-target",
    });
  }
  const interfaces = Array.from(accessible.get_interfaces() ?? []);
  const currentActivation = readActivation(accessible, role, states, interfaces);
  if (
    currentActivation === null ||
    currentActivation.activation !== locator.activation ||
    currentActivation.actionName !== locator.actionName
  ) {
    throw Object.assign(new Error("the semantic target activation changed since the observation"), {
      code: "stale-accessibility-target",
    });
  }

  let activated = false;
  let keyboard = false;
  if (locator.activation === "action" && typeof locator.actionName === "string") {
    const action = accessible.get_action_iface();
    const matchingActionIndices = [];
    const actionCount = Math.max(0, action.get_n_actions());
    for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
      if (
        accessibilityText(action.get_action_name(actionIndex), 128).toLowerCase() ===
        locator.actionName
      ) {
        matchingActionIndices.push(actionIndex);
      }
    }
    if (matchingActionIndices.length !== 1) {
      throw Object.assign(new Error("the semantic target action changed since the observation"), {
        code: "stale-accessibility-target",
      });
    }
    activated = action.do_action(matchingActionIndices[0]);
  } else if (locator.activation === "keyboard") {
    const selectable = hasState(states, Atspi.StateType.SELECTABLE);
    activated =
      (selectable && trySelectKeyboardTarget(accessible)) ||
      tryAccessibilityFocus(accessible) ||
      (!selectable && trySelectKeyboardTarget(accessible));
    keyboard = activated;
  } else {
    activated = tryAccessibilityFocus(accessible);
  }
  if (!activated) {
    throw Object.assign(new Error("the application rejected semantic activation"), {
      code: "accessibility-activation-failed",
    });
  }
  return { keyboard };
}

/** Re-resolves and focuses one top-level semantic window. */
function activateWindow(locator) {
  const attemptCount = Math.ceil(WINDOW_RESOLVE_TIMEOUT_MS / WINDOW_RESOLVE_INTERVAL_MS);
  let matchingRoots = [];
  for (let attempt = 0; attempt <= attemptCount; attempt += 1) {
    matchingRoots = listRoots().filter(
      (root) =>
        root.application === locator.application &&
        root.processId === locator.processId &&
        root.objectPath === locator.objectPath,
    );
    if (matchingRoots.length > 0 || attempt === attemptCount) break;
    GLib.usleep(WINDOW_RESOLVE_INTERVAL_MS * 1_000);
  }
  if (matchingRoots.length !== 1) {
    throw Object.assign(new Error("the semantic window is no longer unique"), {
      code: "stale-accessibility-target",
    });
  }
  const root = matchingRoots[0].accessible;
  const interfaces = new Set(root.get_interfaces() ?? []);
  let activated =
    hasState(root.get_state_set(), Atspi.StateType.ACTIVE) ||
    rootContainsFocus(root, MAX_NODES).focused;
  if (!activated && interfaces.has("Action")) {
    try {
      const action = root.get_action_iface();
      const actionCount = Math.max(0, action.get_n_actions());
      for (const preferredName of PREFERRED_WINDOW_ACTIONS) {
        for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
          if (
            accessibilityText(action.get_action_name(actionIndex), 128).toLowerCase() ===
            preferredName
          ) {
            activated = action.do_action(actionIndex);
            break;
          }
        }
        if (activated) break;
      }
    } catch {
      activated = false;
    }
  }
  if (!activated && interfaces.has("Component")) {
    try {
      activated = root.get_component_iface().grab_focus();
    } catch {
      activated = false;
    }
  }
  if (activated) {
    GLib.usleep(WINDOW_FOCUS_SETTLE_MS * 1_000);
    activated =
      hasState(root.get_state_set(), Atspi.StateType.ACTIVE) ||
      rootContainsFocus(root, MAX_NODES).focused;
  }
  return { activated };
}

/** Finds the single editable target that owns the current text focus. */
function findTextInsertionTarget() {
  const selection = selectFocusedRoot(listRoots());
  if (selection.root === null) return null;
  const queue = [selection.root.accessible];
  const focusedTargets = [];
  let queueIndex = 0;
  let scanned = 0;
  while (queueIndex < queue.length && scanned < MAX_NODES) {
    const accessible = queue[queueIndex];
    queueIndex += 1;
    scanned += 1;
    try {
      const states = accessible.get_state_set();
      const focused = hasState(states, Atspi.StateType.FOCUSED);
      if (!hasState(states, Atspi.StateType.DEFUNCT)) {
        const interfaces = new Set(accessible.get_interfaces() ?? []);
        if (
          interfaces.has("EditableText") &&
          interfaces.has("Text") &&
          hasState(states, Atspi.StateType.EDITABLE) &&
          hasState(states, Atspi.StateType.SHOWING) &&
          hasState(states, Atspi.StateType.VISIBLE) &&
          (hasState(states, Atspi.StateType.ENABLED) || hasState(states, Atspi.StateType.SENSITIVE))
        ) {
          if (focused) focusedTargets.push(accessible);
        }
        const childCount = Math.min(MAX_CHILDREN, Math.max(0, accessible.get_child_count()));
        for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
          const child = accessible.get_child_at_index(childIndex);
          if (child !== null) queue.push(child);
        }
      }
    } catch {
      // The active accessibility tree can change while it is traversed.
    }
  }
  return focusedTargets.length === 1 ? focusedTargets[0] : null;
}

/** Waits briefly for a newly focused editable control to reach AT-SPI. */
function waitForTextInsertionTarget() {
  const attemptCount = Math.ceil(TEXT_FOCUS_TIMEOUT_MS / TEXT_FOCUS_INTERVAL_MS);
  for (let attempt = 0; attempt <= attemptCount; attempt += 1) {
    const target = findTextInsertionTarget();
    if (target !== null) return target;
    if (attempt < attemptCount) GLib.usleep(TEXT_FOCUS_INTERVAL_MS * 1_000);
  }
  return null;
}

/** Inserts exact UTF-8 text into the active editable target without using the clipboard. */
function insertText(input) {
  const accessible = waitForTextInsertionTarget();
  if (accessible === null) return { status: "unavailable" };
  const states = accessible.get_state_set();
  if (/\n/u.test(input.text) && !hasState(states, Atspi.StateType.MULTI_LINE)) {
    return { status: "unavailable" };
  }
  const text = accessible.get_text_iface();
  if (text.get_n_selections() > 0) return { status: "replace-selection" };
  const editable = accessible.get_editable_text_iface();
  let position = text.get_caret_offset();
  const startPosition = position;
  const insert = (value) => {
    if (!Number.isInteger(position) || position < 0) return false;
    if (!editable.insert_text(position, value, new TextEncoder().encode(value).length))
      return false;
    position += Array.from(value).length;
    return text.set_caret_offset(position);
  };
  if (input.intervalMs === 0) {
    if (!insert(input.text)) {
      throw Object.assign(new Error("the focused control rejected exact text insertion"), {
        code: "accessibility-insertion-failed",
      });
    }
  } else {
    for (const character of input.text) {
      if (!insert(character)) {
        throw Object.assign(new Error("the focused control rejected exact text insertion"), {
          code: "accessibility-insertion-failed",
        });
      }
      GLib.usleep(input.intervalMs * 1_000);
    }
  }
  GLib.usleep(TEXT_VERIFY_SETTLE_MS * 1_000);
  let insertedText;
  try {
    insertedText = readTextRange(text, startPosition, position);
  } catch {
    insertedText = null;
  }
  if (insertedText !== input.text) {
    throw Object.assign(new Error("the focused control did not confirm the exact inserted text"), {
      code: "accessibility-insertion-failed",
    });
  }
  const codePointCount = Array.from(input.text).length;
  return {
    status: "inserted",
    injectedCodePoints: codePointCount,
    confirmedCodePoints: codePointCount,
  };
}

/** Decodes one host-provided base64 JSON locator. */
function decodeLocator(encoded) {
  const decoded = new TextDecoder().decode(GLib.base64_decode(encoded));
  const locator = JSON.parse(decoded);
  if (
    typeof locator !== "object" ||
    locator === null ||
    typeof locator.application !== "string" ||
    locator.application.length > 256 ||
    !Number.isSafeInteger(locator.processId) ||
    locator.processId <= 0 ||
    typeof locator.objectPath !== "string" ||
    locator.objectPath.length > MAX_OBJECT_PATH_LENGTH ||
    !locator.objectPath.startsWith("/") ||
    !Array.isArray(locator.path) ||
    locator.path.length > 128 ||
    typeof locator.role !== "string" ||
    typeof locator.name !== "string" ||
    !["action", "keyboard", "focus"].includes(locator.activation) ||
    !(
      locator.actionName === null ||
      (typeof locator.actionName === "string" &&
        PREFERRED_ACTIONS.includes(locator.actionName) &&
        locator.activation === "action")
    ) ||
    (locator.activation === "action") !== (typeof locator.actionName === "string")
  ) {
    throw new Error("the semantic target locator is invalid");
  }
  return locator;
}

/** Decodes one host-provided base64 JSON window locator. */
function decodeWindowLocator(encoded) {
  const decoded = new TextDecoder().decode(GLib.base64_decode(encoded));
  const locator = JSON.parse(decoded);
  if (
    typeof locator !== "object" ||
    locator === null ||
    typeof locator.application !== "string" ||
    locator.application.length > 256 ||
    !Number.isSafeInteger(locator.processId) ||
    locator.processId <= 0 ||
    typeof locator.objectPath !== "string" ||
    locator.objectPath.length > MAX_OBJECT_PATH_LENGTH ||
    !locator.objectPath.startsWith("/")
  ) {
    throw new Error("the semantic window locator is invalid");
  }
  return locator;
}

/** Decodes one bounded exact-text insertion request. */
function decodeTextInsertion(encoded) {
  const decoded = new TextDecoder().decode(GLib.base64_decode(encoded));
  const input = JSON.parse(decoded);
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.text !== "string" ||
    Array.from(input.text).length > MAX_TEXT_INSERTION_LENGTH ||
    /\r/u.test(input.text) ||
    !Number.isInteger(input.intervalMs) ||
    input.intervalMs < 0 ||
    input.intervalMs > MAX_TEXT_INSERTION_INTERVAL_MS
  ) {
    throw new Error("the text insertion request is invalid");
  }
  return input;
}

/** Runs the requested one-shot guest accessibility operation. */
function main() {
  initializeAccessibility();
  const operation = ARGV[0] ?? "";
  if (operation === "probe") return { available: true };
  if (operation === "snapshot") return snapshot();
  if (operation === "activate") return activate(decodeLocator(ARGV[1] ?? ""));
  if (operation === "activate-window") {
    return activateWindow(decodeWindowLocator(ARGV[1] ?? ""));
  }
  if (operation === "insert-text") return insertText(decodeTextInsertion(ARGV[1] ?? ""));
  throw new Error(`unsupported guest accessibility operation ${operation}`);
}

try {
  print(JSON.stringify({ ok: true, result: main() }));
} catch (error) {
  print(
    JSON.stringify({
      ok: false,
      code:
        typeof error === "object" && error !== null && typeof error.code === "string"
          ? error.code
          : "accessibility-unavailable",
      detail: errorDetail(error),
    }),
  );
}

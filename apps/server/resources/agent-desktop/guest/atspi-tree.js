import Atspi from "gi://Atspi?version=2.0";
import GLib from "gi://GLib";

export const MAX_NODES = 4_000;
const MAX_TARGETS = 256;
const MAX_WINDOWS = 128;
export const MAX_CHILDREN = 500;
const MAX_TEXT_LENGTH = 1_024;
export const MAX_OBJECT_PATH_LENGTH = 1_024;
export const MAX_TEXT_INSERTION_LENGTH = 10_000;
export const MAX_TEXT_INSERTION_INTERVAL_MS = 250;
const CALL_TIMEOUT_MS = 250;
const STARTUP_TIMEOUT_MS = 1_000;
export const TEXT_FOCUS_TIMEOUT_MS = 250;
export const TEXT_FOCUS_INTERVAL_MS = 25;
export const TEXT_VERIFY_SETTLE_MS = 50;
const KEYBOARD_SELECTION_SETTLE_MS = 50;
export const WINDOW_FOCUS_SETTLE_MS = 50;
export const WINDOW_RESOLVE_TIMEOUT_MS = 500;
export const WINDOW_RESOLVE_INTERVAL_MS = 50;
const EXCLUDED_APPLICATIONS = new Set([
  "gnome-shell",
  "xdg-desktop-portal-gnome",
  "xdg-desktop-portal-gtk",
]);
const ROOT_ROLES = new Set(["alert", "dialog", "frame", "window"]);
const TARGET_ROLES = new Set([
  "button",
  "check box",
  "check menu item",
  "combo box",
  "entry",
  "icon",
  "link",
  "list item",
  "menu item",
  "page tab",
  "password text",
  "push button",
  "radio button",
  "radio menu item",
  "slider",
  "spin button",
  "table cell",
  "text",
  "toggle button",
  "tree item",
]);
export const PREFERRED_ACTIONS = ["click", "press", "activate", "open", "toggle", "select"];
export const PREFERRED_WINDOW_ACTIONS = ["activate", "raise", "present"];
const FOCUS_ONLY_ROLES = new Set(["entry", "password text", "slider", "spin button"]);

/** Converts one thrown value to a bounded error message. */
export function errorDetail(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

/** Normalizes one optional AT-SPI string to a bounded single-line value. */
export function accessibilityText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

/** Tests one AT-SPI state without propagating a stale-node exception. */
export function hasState(states, state) {
  try {
    return states?.contains(state) === true;
  } catch {
    return false;
  }
}

/** Reads an AT-SPI text range without invoking Accessible.get_text in GJS. */
export function readTextRange(text, startPosition, endPosition) {
  return Atspi.Text.prototype.get_text.call(text, startPosition, endPosition);
}

/** Returns the visible intersection of two same-space rectangles. */
function intersectBounds(first, second) {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/** Initializes the guest AT-SPI client with bounded synchronous calls. */
export function initializeAccessibility() {
  const result = Atspi.init();
  if (result !== 0 && result !== 1) throw new Error(`AT-SPI initialization failed with ${result}`);
  Atspi.set_timeout(CALL_TIMEOUT_MS, STARTUP_TIMEOUT_MS);
}

/** Lists eligible top-level windows with enough identity to re-resolve them. */
export function listRoots() {
  const desktop = Atspi.get_desktop(0);
  if (desktop === null) return [];
  const roots = [];
  const applicationCount = Math.max(0, desktop.get_child_count());
  for (let applicationIndex = 0; applicationIndex < applicationCount; applicationIndex += 1) {
    try {
      const application = desktop.get_child_at_index(applicationIndex);
      if (application === null) continue;
      const applicationName = accessibilityText(application.get_name(), 256);
      if (EXCLUDED_APPLICATIONS.has(applicationName.toLowerCase())) continue;
      const childCount = Math.min(MAX_CHILDREN, Math.max(0, application.get_child_count()));
      for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
        const accessible = application.get_child_at_index(childIndex);
        if (accessible === null) continue;
        const role = accessibilityText(accessible.get_role_name(), 128).toLowerCase();
        if (!ROOT_ROLES.has(role)) continue;
        const processId = accessible.get_process_id();
        const objectPath = accessibilityText(accessible.path, MAX_OBJECT_PATH_LENGTH);
        if (!Number.isSafeInteger(processId) || processId <= 0 || !objectPath.startsWith("/")) {
          continue;
        }
        roots.push({
          accessible,
          application: applicationName,
          processId,
          objectPath,
          window: accessibilityText(accessible.get_name(), 512),
        });
      }
    } catch {
      // Applications can disappear while the registry is traversed.
    }
  }
  return roots;
}

/** Searches one top-level window for the focused accessible node. */
export function rootContainsFocus(root, maxNodes) {
  const queue = [root];
  let queueIndex = 0;
  let scanned = 0;
  while (queueIndex < queue.length && scanned < maxNodes) {
    const accessible = queue[queueIndex];
    queueIndex += 1;
    scanned += 1;
    try {
      const states = accessible.get_state_set();
      if (hasState(states, Atspi.StateType.FOCUSED)) {
        return { focused: true, scanned, truncated: false };
      }
      if (hasState(states, Atspi.StateType.DEFUNCT)) continue;
      const childCount = Math.min(MAX_CHILDREN, Math.max(0, accessible.get_child_count()));
      for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
        const child = accessible.get_child_at_index(childIndex);
        if (child !== null) queue.push(child);
      }
    } catch {
      // Treat a disappearing subtree as unfocused.
    }
  }
  return { focused: false, scanned, truncated: queueIndex < queue.length };
}

/** Tries to move keyboard focus without trusting a declared Component interface. */
export function tryAccessibilityFocus(accessible) {
  try {
    if (hasState(accessible.get_state_set(), Atspi.StateType.FOCUSED)) return true;
    if (!Array.from(accessible.get_interfaces() ?? []).includes("Component")) return false;
    return accessible.get_component_iface().grab_focus();
  } catch {
    return false;
  }
}

/** Selects one keyboard target through its focused parent selection model. */
export function trySelectKeyboardTarget(accessible) {
  try {
    const parent = accessible.get_parent();
    const childIndex = accessible.get_index_in_parent();
    if (
      parent === null ||
      childIndex < 0 ||
      !Array.from(parent.get_interfaces() ?? []).includes("Selection")
    ) {
      return false;
    }
    if (!rootContainsFocus(parent, MAX_NODES).focused && !tryAccessibilityFocus(parent)) {
      return false;
    }
    const selection = parent.get_selection_iface();
    const selected = selection.is_child_selected(childIndex);
    const selectedCount = Math.max(0, selection.get_n_selected_children());
    if (selected && selectedCount === 1) return true;
    if (selectedCount > 0 && !selection.clear_selection()) return false;
    if (!selection.select_child(childIndex)) return false;
    GLib.usleep(KEYBOARD_SELECTION_SETTLE_MS * 1_000);
    return (
      (hasState(accessible.get_state_set(), Atspi.StateType.SELECTED) ||
        selection.is_child_selected(childIndex)) &&
      selection.get_n_selected_children() === 1
    );
  } catch {
    return false;
  }
}

/** Selects the single active or focused top-level accessibility window. */
export function selectFocusedRoot(roots) {
  const active = roots.filter(({ accessible }) => {
    try {
      return hasState(accessible.get_state_set(), Atspi.StateType.ACTIVE);
    } catch {
      return false;
    }
  });
  if (active.length === 1) return { root: active[0], truncated: false, ambiguous: false };

  const focused = [];
  let remainingNodes = MAX_NODES;
  let truncated = false;
  for (const root of active.length > 1 ? active : roots) {
    if (remainingNodes <= 0) {
      truncated = true;
      break;
    }
    const result = rootContainsFocus(root.accessible, remainingNodes);
    remainingNodes -= result.scanned;
    truncated ||= result.truncated;
    if (result.focused) focused.push(root);
  }
  return {
    root: focused.length === 1 ? focused[0] : null,
    truncated,
    ambiguous: focused.length > 1,
  };
}

/** Chooses a user-equivalent activation path for one accessible control. */
export function readActivation(accessible, role, states, interfaces) {
  const component = interfaces.includes("Component") ? accessible.get_component_iface() : null;
  if (
    component !== null &&
    (FOCUS_ONLY_ROLES.has(role) || hasState(states, Atspi.StateType.EDITABLE))
  ) {
    return { activation: "focus", actionName: null };
  }
  if (interfaces.includes("Action")) {
    try {
      const action = accessible.get_action_iface();
      const actionCount = Math.max(0, action.get_n_actions());
      for (const preferredName of PREFERRED_ACTIONS) {
        for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
          if (
            accessibilityText(action.get_action_name(actionIndex), 128).toLowerCase() ===
            preferredName
          ) {
            return { activation: "action", actionName: preferredName };
          }
        }
      }
    } catch {
      // Fall back to keyboard activation for focusable controls.
    }
  }
  return component !== null && hasState(states, Atspi.StateType.FOCUSABLE)
    ? { activation: "keyboard", actionName: null }
    : null;
}

/** Reads one visible interactive target in focused-window coordinates. */
function readTarget(accessible, root, windowBounds, path) {
  const states = accessible.get_state_set();
  if (
    hasState(states, Atspi.StateType.DEFUNCT) ||
    !hasState(states, Atspi.StateType.SHOWING) ||
    !hasState(states, Atspi.StateType.VISIBLE)
  ) {
    return null;
  }
  const role = accessibilityText(accessible.get_role_name(), 128).toLowerCase();
  if (role.length === 0 || !TARGET_ROLES.has(role)) return null;
  if (role === "text" && !hasState(states, Atspi.StateType.EDITABLE)) return null;
  const interfaces = Array.from(accessible.get_interfaces() ?? []);
  const activation = readActivation(accessible, role, states, interfaces);
  if (activation === null || !interfaces.includes("Component")) return null;

  const rectangle = accessible.get_component_iface().get_extents(Atspi.CoordType.WINDOW);
  if (
    rectangle === null ||
    !Number.isFinite(rectangle.x) ||
    !Number.isFinite(rectangle.y) ||
    !Number.isFinite(rectangle.width) ||
    !Number.isFinite(rectangle.height) ||
    rectangle.width <= 0 ||
    rectangle.height <= 0
  ) {
    return null;
  }
  const bounds = intersectBounds(
    {
      x: Math.round(rectangle.x),
      y: Math.round(rectangle.y),
      width: Math.round(rectangle.width),
      height: Math.round(rectangle.height),
    },
    windowBounds,
  );
  if (bounds === null) return null;

  const name = accessibilityText(accessible.get_name(), 512);
  const description = accessibilityText(accessible.get_description());
  return {
    target: {
      application: root.application,
      role,
      name,
      ...(description.length === 0 ? {} : { description }),
      bounds,
      activation: activation.activation,
      enabled:
        hasState(states, Atspi.StateType.ENABLED) || hasState(states, Atspi.StateType.SENSITIVE),
      focused: hasState(states, Atspi.StateType.FOCUSED),
      selected: hasState(states, Atspi.StateType.SELECTED),
      checked: hasState(states, Atspi.StateType.CHECKED),
      expanded: hasState(states, Atspi.StateType.EXPANDED),
    },
    locator: {
      application: root.application,
      processId: root.processId,
      objectPath: root.objectPath,
      path,
      role,
      name,
      activation: activation.activation,
      actionName: activation.actionName,
    },
  };
}

/** Captures bounded targets from the focused accessible window. */
export function snapshot() {
  const roots = listRoots();
  const selection = selectFocusedRoot(roots);
  const windows = roots.slice(0, MAX_WINDOWS).map((root) => ({
    window: {
      application: root.application,
      name: root.window,
      focused: selection.root?.accessible === root.accessible,
    },
    locator: {
      application: root.application,
      processId: root.processId,
      objectPath: root.objectPath,
    },
  }));
  const windowsTruncated = roots.length > MAX_WINDOWS;
  if (selection.root === null) {
    return {
      available: true,
      coordinateSpace: "focused-window",
      window: null,
      windows,
      targets: [],
      truncated: selection.truncated || windowsTruncated,
      detail: selection.ambiguous
        ? "the active accessible window is ambiguous"
        : "the focused application does not expose an AT-SPI window",
    };
  }

  const rootRectangle = selection.root.accessible
    .get_component_iface()
    .get_extents(Atspi.CoordType.WINDOW);
  if (
    rootRectangle === null ||
    !Number.isFinite(rootRectangle.width) ||
    !Number.isFinite(rootRectangle.height) ||
    rootRectangle.width <= 0 ||
    rootRectangle.height <= 0
  ) {
    throw new Error("the focused accessible window did not expose its size");
  }
  const windowBounds = {
    x: 0,
    y: 0,
    width: Math.round(rootRectangle.width),
    height: Math.round(rootRectangle.height),
  };
  const queue = [{ accessible: selection.root.accessible, path: [] }];
  const candidates = [];
  let queueIndex = 0;
  let scanned = 0;
  while (queueIndex < queue.length && scanned < MAX_NODES) {
    const current = queue[queueIndex];
    queueIndex += 1;
    scanned += 1;
    try {
      const candidate = readTarget(current.accessible, selection.root, windowBounds, current.path);
      if (candidate !== null) candidates.push(candidate);
      const states = current.accessible.get_state_set();
      if (hasState(states, Atspi.StateType.DEFUNCT)) continue;
      const childCount = Math.min(MAX_CHILDREN, Math.max(0, current.accessible.get_child_count()));
      for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
        const child = current.accessible.get_child_at_index(childIndex);
        if (child !== null) {
          queue.push({ accessible: child, path: [...current.path, childIndex] });
        }
      }
    } catch {
      // Ignore one stale node and continue through the remaining tree.
    }
  }

  candidates.sort(
    (first, second) =>
      first.target.bounds.y - second.target.bounds.y ||
      first.target.bounds.x - second.target.bounds.x ||
      first.target.bounds.width * first.target.bounds.height -
        second.target.bounds.width * second.target.bounds.height,
  );
  const truncated =
    selection.truncated ||
    windowsTruncated ||
    queueIndex < queue.length ||
    candidates.length > MAX_TARGETS;
  const targets = candidates.slice(0, MAX_TARGETS);
  return {
    available: true,
    coordinateSpace: "focused-window",
    window: {
      application: selection.root.application,
      name: selection.root.window,
      size: { width: windowBounds.width, height: windowBounds.height },
    },
    windows,
    targets,
    truncated,
    ...(targets.length === 0
      ? { detail: "the focused application exposed no visible actionable targets" }
      : {}),
  };
}

/**
 * Keeps one XDG ScreenCast or RemoteDesktop portal session alive for the
 * Electron parent.
 *
 * The helper intentionally uses only GJS and native GNOME media APIs shipped
 * with this host. It accepts newline-delimited JSON commands on stdin and
 * emits exactly one JSON response per command on stdout.
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import System from "system";

import { AccessibilityStatusLease } from "./accessibility-status-lease.js";
import {
  mapDesktopPointToStream,
  mapRelativePointerDelta,
  relativePointerAnchor,
  streamRequiresRelativePointerMotion,
} from "./pointer-coordinate-transform.js";
import { isMissingPortalSessionError } from "./portal-session.js";
import {
  createBatchedIdleCollector,
  createStreamCaptureCompletion,
} from "./stream-capture-completion.js";

let Atspi = null;
let accessibilityImportError = null;
try {
  imports.gi.versions.Atspi = "2.0";
  Atspi = imports.gi.Atspi;
} catch (error) {
  accessibilityImportError = error instanceof Error ? error.message : String(error);
}

let Gst = null;
let gstreamerImportError = null;
try {
  imports.gi.versions.Gst = "1.0";
  Gst = imports.gi.Gst;
  Gst.init(null);
} catch (error) {
  gstreamerImportError = error instanceof Error ? error.message : String(error);
}

const PORTAL_BUS_NAME = "org.freedesktop.portal.Desktop";
const PORTAL_OBJECT_PATH = "/org/freedesktop/portal/desktop";
const ACCESSIBILITY_BUS_NAME = "org.a11y.Bus";
const ACCESSIBILITY_BUS_OBJECT_PATH = "/org/a11y/bus";
const ACCESSIBILITY_STATUS_INTERFACE = "org.a11y.Status";
const REGISTRY_INTERFACE = "org.freedesktop.host.portal.Registry";
const INHIBIT_INTERFACE = "org.freedesktop.portal.Inhibit";
const REMOTE_DESKTOP_INTERFACE = "org.freedesktop.portal.RemoteDesktop";
const SCREEN_CAST_INTERFACE = "org.freedesktop.portal.ScreenCast";
const SCREEN_SAVER_BUS_NAME = "org.gnome.ScreenSaver";
const SCREEN_SAVER_OBJECT_PATH = "/org/gnome/ScreenSaver";
const SCREEN_SAVER_INTERFACE = "org.gnome.ScreenSaver";
const REQUEST_INTERFACE = "org.freedesktop.portal.Request";
const SESSION_INTERFACE = "org.freedesktop.portal.Session";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const LOGIN_MANAGER_BUS_NAME = "org.freedesktop.login1";
const LOGIN_MANAGER_OBJECT_PATH = "/org/freedesktop/login1";
const LOGIN_MANAGER_INTERFACE = "org.freedesktop.login1.Manager";
const LOGIN_SESSION_INTERFACE = "org.freedesktop.login1.Session";
const KEYBOARD_DEVICE = 1;
const POINTER_DEVICE = 2;
const MONITOR_SOURCE = 1;
const HIDDEN_CURSOR_MODE = 1;
const INHIBIT_SUSPEND = 4;
const INHIBIT_IDLE = 8;
const DESKTOP_ACCESS_INHIBIT_FLAGS = INHIBIT_SUSPEND | INHIBIT_IDLE;
const AGENT_WORK_INHIBIT_FLAGS = INHIBIT_SUSPEND;
const REQUEST_TIMEOUT_MS = 120_000;
const DISPLAY_WAKE_TIMEOUT_MS = 2_000;
const DISPLAY_WAKE_POLL_MS = 50;
const STREAM_CAPTURE_TIMEOUT_MS = 5_000;
const STREAM_CAPTURE_POLL_MS = 10;
const STREAM_CAPTURE_GC_INTERVAL = 32;
const MAX_SCREENSHOT_BYTES = 64 * 1_024 * 1_024;
const MAX_RESTORE_TOKEN_LENGTH = 4_096;
const MAX_ACCESSIBILITY_NODES = 4_000;
const MAX_ACCESSIBILITY_TARGETS = 256;
const MAX_ACCESSIBILITY_CHILDREN = 500;
const MAX_ACCESSIBILITY_TEXT_LENGTH = 1_024;
const ACCESSIBILITY_CALL_TIMEOUT_MS = 250;
const ACCESSIBILITY_STARTUP_TIMEOUT_MS = 1_000;
const ACCESSIBILITY_FOCUS_RETURN_TIMEOUT_MS = 2_000;
const ACCESSIBILITY_FOCUS_RETURN_INTERVAL_MS = 50;
const ACCESSIBILITY_FOCUS_SETTLE_MS = 50;
const UNICODE_ENTRY_MODIFIER_SETTLE_MS = 30;
const UNICODE_ENTRY_PREFIX_SETTLE_MS = 30;
const UNICODE_ENTRY_DIGIT_SETTLE_MS = 10;
const UNICODE_ENTRY_COMMIT_SETTLE_MS = 30;
const EXCLUDED_ACCESSIBILITY_APPLICATIONS = new Set([
  "gnome-shell",
  "xdg-desktop-portal-gnome",
  "xdg-desktop-portal-gtk",
]);
const ACCESSIBILITY_ROOT_ROLES = new Set(["alert", "dialog", "frame", "window"]);
const ACCESSIBILITY_TARGET_ROLES = new Set([
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
  "toggle button",
  "tree item",
]);
const PREFERRED_ACCESSIBILITY_ACTIONS = ["click", "press", "activate", "open", "toggle", "select"];
const ACCESSIBILITY_FOCUS_ONLY_ROLES = new Set(["entry", "password text", "slider", "spin button"]);
const BUTTON_CODES = {
  left: 0x110,
  right: 0x111,
  middle: 0x112,
};
const MODIFIER_KEYSYMS = {
  Alt: 0xffe9,
  Control: 0xffe3,
  Meta: 0xffeb,
  Shift: 0xffe1,
};
const NAMED_KEYSYMS = {
  alt: MODIFIER_KEYSYMS.Alt,
  control: MODIFIER_KEYSYMS.Control,
  ctrl: MODIFIER_KEYSYMS.Control,
  meta: MODIFIER_KEYSYMS.Meta,
  super: MODIFIER_KEYSYMS.Meta,
  cmd: MODIFIER_KEYSYMS.Meta,
  command: MODIFIER_KEYSYMS.Meta,
  win: MODIFIER_KEYSYMS.Meta,
  windows: MODIFIER_KEYSYMS.Meta,
  shift: MODIFIER_KEYSYMS.Shift,
  option: MODIFIER_KEYSYMS.Alt,
  backspace: 0xff08,
  tab: 0xff09,
  enter: 0xff0d,
  return: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  home: 0xff50,
  arrowleft: 0xff51,
  left: 0xff51,
  arrowup: 0xff52,
  up: 0xff52,
  arrowright: 0xff53,
  right: 0xff53,
  arrowdown: 0xff54,
  down: 0xff54,
  pageup: 0xff55,
  pagedown: 0xff56,
  end: 0xff57,
  insert: 0xff63,
  delete: 0xffff,
  space: 0x20,
};
const INPUT_METHODS = new Set([
  "move",
  "click",
  "activate",
  "drag",
  "wheel",
  "type",
  "press",
  "hotkey",
  "keyDown",
  "keyUp",
]);

Gio._promisify(Gio.DBusConnection.prototype, "call", "call_finish");

const connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
let systemConnection = null;
let loginSessionPath = null;
const senderToken = connection.get_unique_name().slice(1).replaceAll(".", "_");
const appId = ARGV[0] ?? "";
const restoreTokenPath = ARGV[1] ?? "";
let requestSequence = 0;
let sessionHandle = null;
let sessionAccess = null;
let sessionClosedSubscription = 0;
let desktopAccessInhibitHandle = null;
let agentWorkInhibitHandle = null;
let powerProtectionEnabled = true;
let agentWorking = false;
let grantedDevices = 0;
let screenStreams = [];
let pointerPosition = null;
let permission = "prompt-required";
let accessGeneration = 0;
let accessibilityInitialized = false;
let accessibilityGeneration = 0;
let accessibilityTargets = new Map();
const heldKeysyms = new Set();
const heldButtons = new Set();
const pendingPortalRequests = new Map();
const activeStreamCaptures = new Set();
const noteCompletedStreamCapture = createBatchedIdleCollector({
  interval: STREAM_CAPTURE_GC_INTERVAL,
  schedule: (collect) => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      collect();
      return GLib.SOURCE_REMOVE;
    });
  },
  collect: () => System.gc(),
});
let restoreTokens = { view: null, control: null };
let shuttingDown = false;

/** Converts nested GLib variants to their JavaScript values. */
function unpack(value) {
  let current = value;
  while (current instanceof GLib.Variant) {
    current = current.deepUnpack();
  }
  return current;
}

/** Returns one result field from a portal response dictionary. */
function resultField(results, name) {
  return unpack(results[name]);
}

/** Writes a protocol response without allowing diagnostic text onto stdout. */
function respond(response) {
  print(JSON.stringify(response));
}

/** Normalizes an exception into the bounded helper protocol error shape. */
function normalizeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "portal-error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.field === "string" ? { field: error.field } : {}),
    ...(typeof error?.received === "string" ? { received: error.received.slice(0, 128) } : {}),
    ...(Array.isArray(error?.expected)
      ? { expected: error.expected.filter((value) => typeof value === "string").slice(0, 32) }
      : {}),
    ...(typeof error?.phase === "string" ? { phase: error.phase } : {}),
    ...(typeof error?.cleanup === "object" && error.cleanup !== null
      ? { cleanup: error.cleanup }
      : {}),
  };
}

/** Returns one mutable error object for protocol annotations. */
function mutableError(error) {
  return typeof error === "object" && error !== null ? error : new Error(String(error));
}

/** Bounds untrusted accessibility text before it enters the helper protocol. */
function accessibilityText(value, maxLength = MAX_ACCESSIBILITY_TEXT_LENGTH) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, maxLength) : "";
}

/** Creates one accessibility-specific protocol error. */
function accessibilityError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

/** Reads one boolean desktop accessibility status property. */
async function readAccessibilityStatus(name) {
  const reply = await connection.call(
    ACCESSIBILITY_BUS_NAME,
    ACCESSIBILITY_BUS_OBJECT_PATH,
    PROPERTIES_INTERFACE,
    "Get",
    new GLib.Variant("(ss)", [ACCESSIBILITY_STATUS_INTERFACE, name]),
    new GLib.VariantType("(v)"),
    Gio.DBusCallFlags.NONE,
    ACCESSIBILITY_STARTUP_TIMEOUT_MS,
    null,
  );
  const [value] = reply.deepUnpack();
  return unpack(value) === true;
}

/** Writes one boolean desktop accessibility status property. */
async function writeAccessibilityStatus(name, enabled) {
  await connection.call(
    ACCESSIBILITY_BUS_NAME,
    ACCESSIBILITY_BUS_OBJECT_PATH,
    PROPERTIES_INTERFACE,
    "Set",
    new GLib.Variant("(ssv)", [
      ACCESSIBILITY_STATUS_INTERFACE,
      name,
      new GLib.Variant("b", enabled),
    ]),
    new GLib.VariantType("()"),
    Gio.DBusCallFlags.NONE,
    ACCESSIBILITY_STARTUP_TIMEOUT_MS,
    null,
  );
}

const accessibilityStatusLease = new AccessibilityStatusLease({
  read: readAccessibilityStatus,
  write: writeAccessibilityStatus,
  report: (operation, error) =>
    printerr(
      `computer-use accessibility status ${operation} failed: ${normalizeError(error).message}`,
    ),
});

/** Adds one bounded execution phase without replacing a more specific phase. */
async function runInputPhase(phase, operation) {
  try {
    return await operation();
  } catch (error) {
    const failure = mutableError(error);
    if (typeof failure.phase !== "string") failure.phase = phase;
    throw failure;
  }
}

/** Initializes the optional system AT-SPI client once. */
function ensureAccessibility() {
  if (Atspi === null) {
    throw accessibilityError(
      "accessibility-unavailable",
      accessibilityImportError ?? "the system AT-SPI typelib is unavailable",
    );
  }
  if (!accessibilityInitialized) {
    const result = Atspi.init();
    if (result !== 0 && result !== 1) {
      throw accessibilityError(
        "accessibility-unavailable",
        `AT-SPI initialization failed with code ${result}`,
      );
    }
    Atspi.set_timeout(ACCESSIBILITY_CALL_TIMEOUT_MS, ACCESSIBILITY_STARTUP_TIMEOUT_MS);
    accessibilityInitialized = true;
  }
  return Atspi;
}

/** Requires the host GStreamer runtime used for portal stream snapshots. */
function ensureGstreamer() {
  if (Gst !== null) return Gst;
  const error = new Error(gstreamerImportError ?? "the system GStreamer typelib is unavailable");
  error.code = "stream-capture-unavailable";
  throw error;
}

/** Tests one AT-SPI state without leaking a defunct-object exception. */
function hasAccessibilityState(states, state) {
  try {
    return states?.contains(state) === true;
  } catch {
    return false;
  }
}

/** Returns the intersection of two rectangles in one coordinate space. */
function intersectAccessibilityBounds(first, second) {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/** Lists eligible top-level windows without traversing their content. */
function listAccessibilityRoots(atspi) {
  const desktop = atspi.get_desktop(0);
  if (desktop === null) return [];
  const roots = [];
  const applicationCount = Math.max(0, desktop.get_child_count());
  for (let applicationIndex = 0; applicationIndex < applicationCount; applicationIndex += 1) {
    try {
      const application = desktop.get_child_at_index(applicationIndex);
      if (application === null) continue;
      const applicationName = accessibilityText(application.get_name(), 256);
      if (EXCLUDED_ACCESSIBILITY_APPLICATIONS.has(applicationName.toLowerCase())) continue;
      const childCount = Math.min(
        MAX_ACCESSIBILITY_CHILDREN,
        Math.max(0, application.get_child_count()),
      );
      for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
        const accessible = application.get_child_at_index(childIndex);
        if (accessible === null) continue;
        const role = accessibilityText(accessible.get_role_name(), 128).toLowerCase();
        if (!ACCESSIBILITY_ROOT_ROLES.has(role)) continue;
        roots.push({ accessible, application: applicationName });
      }
    } catch {
      // Applications can disappear while the registry is being traversed.
    }
  }
  return roots;
}

/** Searches a top-level window for the currently focused accessible. */
function accessibilityRootContainsFocus(root, maxNodes) {
  const queue = [root];
  let queueIndex = 0;
  let scanned = 0;
  while (queueIndex < queue.length && scanned < maxNodes) {
    const accessible = queue[queueIndex];
    queueIndex += 1;
    scanned += 1;
    try {
      const states = accessible.get_state_set();
      if (hasAccessibilityState(states, Atspi.StateType.FOCUSED)) {
        return { focused: true, scanned, truncated: false };
      }
      if (hasAccessibilityState(states, Atspi.StateType.DEFUNCT)) continue;
      const childCount = Math.min(
        MAX_ACCESSIBILITY_CHILDREN,
        Math.max(0, accessible.get_child_count()),
      );
      for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
        const child = accessible.get_child_at_index(childIndex);
        if (child !== null) queue.push(child);
      }
    } catch {
      // A disappearing subtree is not the focused window.
    }
  }
  return { focused: false, scanned, truncated: queueIndex < queue.length };
}

/** Waits for GNOME to return focus after closing its control-consent dialog. */
async function waitForAccessibilityRootFocus(root) {
  const attemptCount = Math.ceil(
    ACCESSIBILITY_FOCUS_RETURN_TIMEOUT_MS / ACCESSIBILITY_FOCUS_RETURN_INTERVAL_MS,
  );
  for (let attempt = 0; attempt <= attemptCount; attempt += 1) {
    try {
      if (hasAccessibilityState(root.get_state_set(), Atspi.StateType.ACTIVE)) return true;
    } catch {
      return false;
    }
    if (attempt < attemptCount) await delay(ACCESSIBILITY_FOCUS_RETURN_INTERVAL_MS);
  }
  return accessibilityRootContainsFocus(root, MAX_ACCESSIBILITY_NODES).focused;
}

/** Selects only the active or focused top-level accessibility windows. */
function selectFocusedAccessibilityRoots(roots) {
  const active = roots.filter(({ accessible }) => {
    try {
      return hasAccessibilityState(accessible.get_state_set(), Atspi.StateType.ACTIVE);
    } catch {
      return false;
    }
  });
  if (active.length === 1) return { roots: active, truncated: false };

  const focused = [];
  let remainingNodes = MAX_ACCESSIBILITY_NODES;
  let truncated = false;
  for (const root of active.length > 1 ? active : roots) {
    if (remainingNodes <= 0) {
      truncated = true;
      break;
    }
    const result = accessibilityRootContainsFocus(root.accessible, remainingNodes);
    remainingNodes -= result.scanned;
    truncated ||= result.truncated;
    if (result.focused) focused.push(root);
  }
  return { roots: focused, truncated };
}

/** Chooses a user-equivalent activation path for one accessible control. */
function readAccessibilityActivation(accessible, role, states, interfaces) {
  const component = interfaces.includes("Component") ? accessible.get_component_iface() : null;
  if (
    component !== null &&
    (ACCESSIBILITY_FOCUS_ONLY_ROLES.has(role) ||
      hasAccessibilityState(states, Atspi.StateType.EDITABLE))
  ) {
    return { activation: "focus", actionIndex: null };
  }
  if (interfaces.includes("Action")) {
    try {
      const action = accessible.get_action_iface();
      const actionCount = Math.max(0, action.get_n_actions());
      let actionIndex = -1;
      for (const preferredName of PREFERRED_ACCESSIBILITY_ACTIONS) {
        for (let index = 0; index < actionCount; index += 1) {
          if (
            accessibilityText(action.get_action_name(index), 128).toLowerCase() === preferredName
          ) {
            actionIndex = index;
            break;
          }
        }
        if (actionIndex >= 0) break;
      }
      if (actionIndex >= 0) return { activation: "action", actionIndex };
    } catch {
      // Fall back to keyboard activation for focusable controls.
    }
  }
  return component !== null && hasAccessibilityState(states, Atspi.StateType.FOCUSABLE)
    ? { activation: "keyboard", actionIndex: null }
    : null;
}

/** Reads one visible interactive target in focused-window coordinates. */
function readAccessibilityTarget(accessible, root, windowBounds, id) {
  const states = accessible.get_state_set();
  if (
    hasAccessibilityState(states, Atspi.StateType.DEFUNCT) ||
    !hasAccessibilityState(states, Atspi.StateType.SHOWING) ||
    !hasAccessibilityState(states, Atspi.StateType.VISIBLE)
  ) {
    return null;
  }

  const role = accessibilityText(accessible.get_role_name(), 128).toLowerCase();
  if (role.length === 0 || !ACCESSIBILITY_TARGET_ROLES.has(role)) return null;
  const interfaces = Array.from(accessible.get_interfaces() ?? []);
  const activation = readAccessibilityActivation(accessible, role, states, interfaces);
  if (activation === null) return null;
  if (!interfaces.includes("Component")) return null;

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
  const bounds = intersectAccessibilityBounds(
    {
      x: Math.round(rectangle.x),
      y: Math.round(rectangle.y),
      width: Math.round(rectangle.width),
      height: Math.round(rectangle.height),
    },
    windowBounds,
  );
  if (bounds === null) return null;

  const description = accessibilityText(accessible.get_description());
  return {
    target: {
      id,
      application: root.application,
      role,
      name: accessibilityText(accessible.get_name(), 512),
      ...(description.length === 0 ? {} : { description }),
      bounds,
      activation: activation.activation,
      enabled:
        hasAccessibilityState(states, Atspi.StateType.ENABLED) ||
        hasAccessibilityState(states, Atspi.StateType.SENSITIVE),
      focused: hasAccessibilityState(states, Atspi.StateType.FOCUSED),
      selected: hasAccessibilityState(states, Atspi.StateType.SELECTED),
      checked: hasAccessibilityState(states, Atspi.StateType.CHECKED),
      expanded: hasAccessibilityState(states, Atspi.StateType.EXPANDED),
    },
    stored: {
      accessible,
      root: root.accessible,
      application: root.application,
      windowBounds,
      actionIndex: activation.actionIndex,
    },
  };
}

/** Invalidates every ephemeral semantic target. */
function invalidateAccessibilityTargets() {
  accessibilityGeneration += 1;
  accessibilityTargets = new Map();
}

/** Captures bounded semantic targets from the focused accessible window. */
function captureAccessibility() {
  invalidateAccessibilityTargets();
  try {
    const atspi = ensureAccessibility();
    const roots = listAccessibilityRoots(atspi);
    const selection = selectFocusedAccessibilityRoots(roots);
    if (selection.roots.length === 0) {
      return {
        available: true,
        coordinateSpace: "focused-window",
        window: null,
        targets: [],
        truncated: selection.truncated,
        detail: accessibilityStatusLease.enabledByLease
          ? "the focused application does not expose an AT-SPI window; restart applications opened before semantic accessibility was enabled"
          : "the focused application does not expose an AT-SPI window",
      };
    }

    if (selection.roots.length !== 1) {
      return {
        available: true,
        coordinateSpace: "focused-window",
        window: null,
        targets: [],
        truncated: selection.truncated,
        detail: "the active accessible window is ambiguous",
      };
    }
    const [selectedRoot] = selection.roots;
    const rootRectangle = selectedRoot.accessible
      .get_component_iface()
      .get_extents(Atspi.CoordType.WINDOW);
    if (
      rootRectangle === null ||
      !Number.isFinite(rootRectangle.width) ||
      !Number.isFinite(rootRectangle.height) ||
      rootRectangle.width <= 0 ||
      rootRectangle.height <= 0
    ) {
      throw accessibilityError(
        "accessibility-unavailable",
        "the focused accessible window did not expose its size",
      );
    }
    const windowBounds = {
      x: 0,
      y: 0,
      width: Math.round(rootRectangle.width),
      height: Math.round(rootRectangle.height),
    };
    const window = {
      application: selectedRoot.application,
      name: accessibilityText(selectedRoot.accessible.get_name(), 512),
      size: { width: windowBounds.width, height: windowBounds.height },
    };

    const candidates = [];
    let scanned = 0;
    let truncated = selection.truncated;
    for (const root of selection.roots) {
      const queue = [root.accessible];
      let queueIndex = 0;
      while (queueIndex < queue.length && scanned < MAX_ACCESSIBILITY_NODES) {
        const accessible = queue[queueIndex];
        queueIndex += 1;
        scanned += 1;
        try {
          const candidate = readAccessibilityTarget(accessible, root, windowBounds, "pending");
          if (candidate !== null) candidates.push(candidate);
          const states = accessible.get_state_set();
          if (hasAccessibilityState(states, Atspi.StateType.DEFUNCT)) continue;
          const childCount = Math.min(
            MAX_ACCESSIBILITY_CHILDREN,
            Math.max(0, accessible.get_child_count()),
          );
          for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
            const child = accessible.get_child_at_index(childIndex);
            if (child !== null) queue.push(child);
          }
        } catch {
          // Ignore one stale node and continue through the remaining tree.
        }
      }
      truncated ||= queueIndex < queue.length;
      if (scanned >= MAX_ACCESSIBILITY_NODES) break;
    }

    candidates.sort(
      (first, second) =>
        first.target.bounds.y - second.target.bounds.y ||
        first.target.bounds.x - second.target.bounds.x ||
        first.target.bounds.width * first.target.bounds.height -
          second.target.bounds.width * second.target.bounds.height,
    );
    truncated ||= candidates.length > MAX_ACCESSIBILITY_TARGETS;
    const targets = candidates.slice(0, MAX_ACCESSIBILITY_TARGETS).map((candidate, index) => {
      const id = `a11y-${accessibilityGeneration}-${index + 1}`;
      accessibilityTargets.set(id, candidate.stored);
      return { ...candidate.target, id };
    });
    return {
      available: true,
      coordinateSpace: "focused-window",
      window,
      targets,
      truncated,
      ...(targets.length === 0
        ? { detail: "the focused application exposed no visible actionable targets" }
        : {}),
    };
  } catch (error) {
    return {
      available: false,
      coordinateSpace: "focused-window",
      window: null,
      targets: [],
      truncated: false,
      detail: accessibilityText(
        error instanceof Error ? error.message : "AT-SPI target discovery failed",
        512,
      ),
    };
  }
}

/** Creates the error returned when access is released during authorization. */
function portalCancellationError() {
  const error = new Error("desktop access was released while portal permission was pending");
  error.code = "request-cancelled";
  return error;
}

/** Produces a unique object-path-safe portal request token. */
function nextToken(prefix) {
  requestSequence += 1;
  return `${prefix}${requestSequence}`;
}

/** Resolves after a short delay while keeping the GLib main loop responsive. */
function delay(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

/** Returns a valid bounded portal restore token or null. */
function decodeRestoreToken(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_RESTORE_TOKEN_LENGTH
    ? value
    : null;
}

/** Reads persisted view and control restore tokens, migrating the version-one control token. */
function readRestoreTokens() {
  const empty = { view: null, control: null };
  if (restoreTokenPath.length === 0) return empty;
  try {
    const file = Gio.File.new_for_path(restoreTokenPath);
    if (!file.query_exists(null)) return empty;
    const [loaded, contents] = file.load_contents(null);
    if (!loaded || contents.byteLength > MAX_RESTORE_TOKEN_LENGTH * 4) return empty;
    const document = JSON.parse(new TextDecoder().decode(contents));
    if (document?.version === 1) {
      return { view: null, control: decodeRestoreToken(document.restoreToken) };
    }
    if (document?.version !== 2 || document.restoreTokens === null) return empty;
    return {
      view: decodeRestoreToken(document.restoreTokens?.view),
      control: decodeRestoreToken(document.restoreTokens?.control),
    };
  } catch (error) {
    printerr(`computer-use restore token load failed: ${normalizeError(error).message}`);
    return empty;
  }
}

/** Persists both rotating portal restore tokens with owner-only access. */
function persistRestoreTokens() {
  if (restoreTokenPath.length === 0) return;
  if (restoreTokens.view === null && restoreTokens.control === null) {
    try {
      const file = Gio.File.new_for_path(restoreTokenPath);
      if (file.query_exists(null)) file.delete(null);
    } catch (error) {
      printerr(`computer-use restore token removal failed: ${normalizeError(error).message}`);
    }
    return;
  }
  try {
    const file = Gio.File.new_for_path(restoreTokenPath);
    try {
      file.get_parent()?.make_directory_with_parents(null);
    } catch (error) {
      if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) throw error;
    }
    file.replace_contents(
      new TextEncoder().encode(JSON.stringify({ version: 2, restoreTokens })),
      null,
      false,
      Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
    );
  } catch (error) {
    printerr(`computer-use restore token save failed: ${normalizeError(error).message}`);
  }
}

/** Stores the latest rotating portal restore token for one access level. */
function saveRestoreToken(access, token) {
  restoreTokens = { ...restoreTokens, [access]: token };
  persistRestoreTokens();
}

/** Consumes one current single-use restore token before reconnecting. */
function consumeRestoreToken(access) {
  const token = restoreTokens[access];
  restoreTokens = { ...restoreTokens, [access]: null };
  persistRestoreTokens();
  return token;
}

/** Forgets every local capability used to restore portal permission. */
function forgetRestoreTokens() {
  restoreTokens = { view: null, control: null };
  persistRestoreTokens();
}

/** Lists access levels that can attempt a prompt-free portal restore. */
function rememberedAccess() {
  return ["view", "control"].filter((access) => restoreTokens[access] !== null);
}

/** Returns the inactive permission state represented by local restore tokens. */
function inactivePermission() {
  return rememberedAccess().length === 0 ? "prompt-required" : "remembered";
}

/** Reads all public logind properties for one candidate session. */
function readLoginSessionProperties(sessionPath) {
  const reply = systemConnection.call_sync(
    LOGIN_MANAGER_BUS_NAME,
    sessionPath,
    PROPERTIES_INTERFACE,
    "GetAll",
    new GLib.Variant("(s)", [LOGIN_SESSION_INTERFACE]),
    new GLib.VariantType("(a{sv})"),
    Gio.DBusCallFlags.NONE,
    2_000,
    null,
  );
  const [properties] = reply.deepUnpack();
  return properties;
}

/** Finds the sole active local graphical logind session for this user. */
function findActiveLoginSession() {
  const reply = systemConnection.call_sync(
    LOGIN_MANAGER_BUS_NAME,
    LOGIN_MANAGER_OBJECT_PATH,
    LOGIN_MANAGER_INTERFACE,
    "ListSessions",
    null,
    new GLib.VariantType("(a(susso))"),
    Gio.DBusCallFlags.NONE,
    2_000,
    null,
  );
  const [sessions] = reply.deepUnpack();
  const userId = new Gio.Credentials().get_unix_user();
  const candidates = sessions.filter((entry) => {
    if (!Array.isArray(entry) || entry.length !== 5) return false;
    const [_id, sessionUserId, _user, seat, sessionPath] = entry;
    if (sessionUserId !== userId || typeof seat !== "string" || seat.length === 0) return false;
    if (typeof sessionPath !== "string") return false;
    try {
      const properties = readLoginSessionProperties(sessionPath);
      const type = unpack(properties.Type);
      return (
        unpack(properties.Active) === true &&
        unpack(properties.Remote) === false &&
        unpack(properties.Class) === "user" &&
        (type === "wayland" || type === "x11")
      );
    } catch {
      return false;
    }
  });
  if (candidates.length !== 1) {
    throw new Error(`found ${candidates.length} active local graphical logind sessions`);
  }
  return candidates[0][4];
}

/** Connects this helper process to its owning logind session when available. */
function connectLoginSession() {
  try {
    systemConnection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
    const processId = new Gio.Credentials().get_unix_pid();
    try {
      const reply = systemConnection.call_sync(
        LOGIN_MANAGER_BUS_NAME,
        LOGIN_MANAGER_OBJECT_PATH,
        LOGIN_MANAGER_INTERFACE,
        "GetSessionByPID",
        new GLib.Variant("(u)", [processId]),
        new GLib.VariantType("(o)"),
        Gio.DBusCallFlags.NONE,
        2_000,
        null,
      );
      const [sessionPath] = reply.deepUnpack();
      loginSessionPath = typeof sessionPath === "string" ? sessionPath : null;
    } catch {
      loginSessionPath = findActiveLoginSession();
    }
    if (loginSessionPath === null) throw new Error("logind returned no graphical session path");
  } catch (error) {
    systemConnection = null;
    loginSessionPath = null;
    printerr(`computer-use logind session lookup failed: ${normalizeError(error).message}`);
  }
}

/** Reads GNOME's current screen-shield state, or null when unavailable. */
function readScreenSaverActive() {
  try {
    const reply = connection.call_sync(
      SCREEN_SAVER_BUS_NAME,
      SCREEN_SAVER_OBJECT_PATH,
      SCREEN_SAVER_INTERFACE,
      "GetActive",
      null,
      new GLib.VariantType("(b)"),
      Gio.DBusCallFlags.NONE,
      2_000,
      null,
    );
    const [active] = reply.deepUnpack();
    return typeof active === "boolean" ? active : null;
  } catch {
    return null;
  }
}

/** Reads whether logind considers this graphical session locked. */
function readLockedHint() {
  if (systemConnection === null || loginSessionPath === null) return null;
  try {
    const reply = systemConnection.call_sync(
      LOGIN_MANAGER_BUS_NAME,
      loginSessionPath,
      PROPERTIES_INTERFACE,
      "Get",
      new GLib.Variant("(ss)", [LOGIN_SESSION_INTERFACE, "LockedHint"]),
      new GLib.VariantType("(v)"),
      Gio.DBusCallFlags.NONE,
      2_000,
      null,
    );
    const [value] = reply.deepUnpack();
    const locked = unpack(value);
    return typeof locked === "boolean" ? locked : null;
  } catch {
    return null;
  }
}

/** Returns the current display state without changing it. */
function displayState() {
  const locked = readLockedHint();
  if (locked === true) return "locked";
  const screenSaverActive = readScreenSaverActive();
  if (screenSaverActive === false) return "active";
  if (screenSaverActive === true && locked === false) return "blanked";
  return "unknown";
}

/** Creates a bounded display-state protocol error. */
function displayError(state) {
  const locked = state === "locked";
  const error = new Error(
    locked
      ? "unlock the desktop before requesting computer access"
      : "the blank display could not be woken safely",
  );
  error.code = locked ? "display-locked" : "display-inactive";
  throw error;
}

/** Wakes a blank, unlocked display without attempting to bypass a lock. */
async function wakeDisplay() {
  const initialState = displayState();
  if (initialState === "active") return;
  if (initialState !== "blanked") displayError(initialState);

  await connection.call(
    SCREEN_SAVER_BUS_NAME,
    SCREEN_SAVER_OBJECT_PATH,
    SCREEN_SAVER_INTERFACE,
    "SetActive",
    new GLib.Variant("(b)", [false]),
    null,
    Gio.DBusCallFlags.NONE,
    DISPLAY_WAKE_TIMEOUT_MS,
    null,
  );
  const attemptCount = Math.ceil(DISPLAY_WAKE_TIMEOUT_MS / DISPLAY_WAKE_POLL_MS);
  for (let attempt = 0; attempt <= attemptCount; attempt += 1) {
    const state = displayState();
    if (state === "active") return;
    if (state === "locked") displayError(state);
    if (attempt < attemptCount) await delay(DISPLAY_WAKE_POLL_MS);
  }
  displayError(displayState());
}

/** Closes one outstanding portal request without waiting for a response signal. */
async function closePortalRequest(requestPath) {
  try {
    await connection.call(
      PORTAL_BUS_NAME,
      requestPath,
      REQUEST_INTERFACE,
      "Close",
      null,
      null,
      Gio.DBusCallFlags.NONE,
      5_000,
      null,
    );
  } catch {
    // The request may have completed or disappeared before Close reached it.
  }
}

/** Acquires one portal-owned inhibitor and returns its request handle. */
async function acquireInhibitor(prefix, flags, reason) {
  const token = nextToken(prefix);
  const expectedHandle = `${PORTAL_OBJECT_PATH}/request/${senderToken}/${token}`;
  const reply = await connection.call(
    PORTAL_BUS_NAME,
    PORTAL_OBJECT_PATH,
    INHIBIT_INTERFACE,
    "Inhibit",
    new GLib.Variant("(sua{sv})", [
      "",
      flags,
      {
        handle_token: new GLib.Variant("s", token),
        reason: new GLib.Variant("s", reason),
      },
    ]),
    new GLib.VariantType("(o)"),
    Gio.DBusCallFlags.NONE,
    5_000,
    null,
  );
  const [handle] = reply.deepUnpack();
  if (handle !== expectedHandle) {
    if (typeof handle === "string") await closePortalRequest(handle);
    const error = new Error("the desktop portal returned an unexpected inhibitor handle");
    error.code = "portal-protocol";
    throw error;
  }
  return handle;
}

/** Releases one active inhibitor handle. */
async function releaseInhibitor(closingHandle) {
  if (closingHandle !== null) await closePortalRequest(closingHandle);
}

/** Acquires idle and suspend inhibition for active desktop access. */
async function acquireDesktopAccessInhibitor() {
  if (desktopAccessInhibitHandle !== null || !powerProtectionEnabled) return;
  desktopAccessInhibitHandle = await acquireInhibitor(
    "desktop_access_inhibit",
    DESKTOP_ACCESS_INHIBIT_FLAGS,
    "Agent desktop access is active.",
  );
}

/** Releases idle and suspend inhibition for desktop access. */
async function releaseDesktopAccessInhibitor() {
  const closingHandle = desktopAccessInhibitHandle;
  desktopAccessInhibitHandle = null;
  await releaseInhibitor(closingHandle);
}

/** Reconciles suspend-only inhibition with current agent activity. */
async function syncAgentWorkInhibitor() {
  if (powerProtectionEnabled && agentWorking) {
    if (agentWorkInhibitHandle === null) {
      agentWorkInhibitHandle = await acquireInhibitor(
        "agent_work_inhibit",
        AGENT_WORK_INHIBIT_FLAGS,
        "An agent is working.",
      );
    }
    return;
  }
  const closingHandle = agentWorkInhibitHandle;
  agentWorkInhibitHandle = null;
  await releaseInhibitor(closingHandle);
}

/** Applies the persistent power policy without ending desktop access. */
async function configurePowerProtection(enabled) {
  powerProtectionEnabled = enabled;
  if (enabled) {
    if (sessionHandle !== null) await acquireDesktopAccessInhibitor();
    await syncAgentWorkInhibitor();
    return;
  }
  await Promise.all([releaseDesktopAccessInhibitor(), syncAgentWorkInhibitor()]);
}

/** Updates whether any attached T3 backend has active agent work. */
async function setAgentWorking(active, enabled) {
  agentWorking = active;
  powerProtectionEnabled = enabled;
  await syncAgentWorkInhibitor();
  if (!enabled) await releaseDesktopAccessInhibitor();
}

/** Cancels portal interactions of one kind, or every kind when omitted. */
async function cancelPendingPortalRequests(kind = null) {
  const pending = Array.from(pendingPortalRequests.values()).filter(
    (request) => kind === null || request.kind === kind,
  );
  for (const request of pending) request.cancel();
  await Promise.allSettled(pending.map((request) => closePortalRequest(request.requestPath)));
}

/** Calls one portal method and awaits its cancellable Request.Response signal. */
async function portalRequest(
  interfaceName,
  method,
  signature,
  values,
  prefix,
  cancellationKind = "access",
) {
  const token = nextToken(prefix);
  const requestPath = `${PORTAL_OBJECT_PATH}/request/${senderToken}/${token}`;
  let subscription = 0;
  let timeout = 0;
  let settled = false;
  let cancelled = false;
  let settle;
  const response = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Cancellation can happen while the initial D-Bus method call is still pending.
  void response.catch(() => {});
  const cleanup = () => {
    if (subscription !== 0) {
      connection.signal_unsubscribe(subscription);
      subscription = 0;
    }
    if (timeout !== 0) {
      GLib.source_remove(timeout);
      timeout = 0;
    }
    pendingPortalRequests.delete(requestPath);
  };
  const resolveResponse = (results) => {
    if (settled) return;
    settled = true;
    cleanup();
    settle.resolve(results);
  };
  const rejectResponse = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    settle.reject(error);
  };
  if (cancellationKind !== null) {
    pendingPortalRequests.set(requestPath, {
      requestPath,
      kind: cancellationKind,
      cancel: () => {
        cancelled = true;
        rejectResponse(portalCancellationError());
      },
    });
  }
  subscription = connection.signal_subscribe(
    PORTAL_BUS_NAME,
    REQUEST_INTERFACE,
    "Response",
    requestPath,
    null,
    Gio.DBusSignalFlags.NONE,
    (_connection, _sender, _path, _interface, _signal, parameters) => {
      const [responseCode, results] = parameters.deepUnpack();
      if (responseCode === 0) {
        resolveResponse(results);
        return;
      }
      const error = new Error(
        responseCode === 1
          ? "desktop access was cancelled by the user"
          : "the desktop portal rejected the access request",
      );
      error.code = responseCode === 1 ? "permission-denied" : "portal-rejected";
      rejectResponse(error);
    },
  );
  timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
    const error = new Error("the desktop portal did not answer the access request");
    error.code = "portal-timeout";
    rejectResponse(error);
    return GLib.SOURCE_REMOVE;
  });

  try {
    const options = values.at(-1);
    options.handle_token = new GLib.Variant("s", token);
    const reply = await connection.call(
      PORTAL_BUS_NAME,
      PORTAL_OBJECT_PATH,
      interfaceName,
      method,
      new GLib.Variant(signature, values),
      new GLib.VariantType("(o)"),
      Gio.DBusCallFlags.NONE,
      REQUEST_TIMEOUT_MS,
      null,
    );
    const [returnedPath] = reply.deepUnpack();
    if (returnedPath !== requestPath) {
      const error = new Error("the desktop portal returned an unexpected request handle");
      error.code = "portal-protocol";
      rejectResponse(error);
    }
    if (cancelled) await closePortalRequest(requestPath);
    return await response;
  } catch (error) {
    rejectResponse(error);
    throw error;
  }
}

/** Calls one non-request portal method. */
async function portalCall(method, signature, values) {
  await connection.call(
    PORTAL_BUS_NAME,
    PORTAL_OBJECT_PATH,
    REMOTE_DESKTOP_INTERFACE,
    method,
    new GLib.Variant(signature, values),
    null,
    Gio.DBusCallFlags.NONE,
    30_000,
    null,
  );
}

/** Closes one portal session handle. */
async function closePortalSession(closingHandle, reportFailure) {
  try {
    await connection.call(
      PORTAL_BUS_NAME,
      closingHandle,
      SESSION_INTERFACE,
      "Close",
      null,
      null,
      Gio.DBusCallFlags.NONE,
      5_000,
      null,
    );
    return true;
  } catch (error) {
    const message = normalizeError(error).message;
    const alreadyClosed = isMissingPortalSessionError(message);
    if (reportFailure && !alreadyClosed) {
      printerr(`computer-use session close failed: ${normalizeError(error).message}`);
    }
    return alreadyClosed;
  }
}

/** Detaches and closes the active session after local input state is settled. */
async function detachSession() {
  const closingHandle = sessionHandle;
  sessionHandle = null;
  sessionAccess = null;
  grantedDevices = 0;
  screenStreams = [];
  pointerPosition = null;
  if (sessionClosedSubscription !== 0) {
    connection.signal_unsubscribe(sessionClosedSubscription);
    sessionClosedSubscription = 0;
  }
  return closingHandle === null || (await closePortalSession(closingHandle, true));
}

/** Closes the active portal session, if any. */
async function closeSession() {
  cancelActiveStreamCaptures();
  await releaseHeldKeysyms();
  await releaseHeldButtons();
  heldKeysyms.clear();
  heldButtons.clear();
  return await detachSession();
}

/** Cancels authorization and closes the active view or control session. */
async function releaseAccess() {
  accessGeneration += 1;
  permission = inactivePermission();
  invalidateAccessibilityTargets();
  await Promise.all([
    cancelPendingPortalRequests("access"),
    closeSession(),
    releaseDesktopAccessInhibitor(),
    accessibilityStatusLease.restore(),
  ]);
}

/** Rejects work invalidated by a concurrent release request. */
function requireAccessGeneration(expectedGeneration) {
  if (accessGeneration === expectedGeneration) return;
  throw portalCancellationError();
}

/** Decodes the monitor streams returned when a portal session starts. */
function decodeScreenStreams(value) {
  const entries = unpack(value);
  if (!Array.isArray(entries)) {
    const error = new Error("the desktop portal did not return screen streams");
    error.code = "portal-protocol";
    throw error;
  }
  return entries.map((entry) => {
    const unpackedEntry = unpack(entry);
    if (!Array.isArray(unpackedEntry) || unpackedEntry.length !== 2) {
      const error = new Error("the desktop portal returned an invalid screen stream");
      error.code = "portal-protocol";
      throw error;
    }
    const [nodeId, properties] = unpackedEntry;
    if (
      !Number.isInteger(nodeId) ||
      nodeId < 0 ||
      properties === null ||
      typeof properties !== "object"
    ) {
      const error = new Error("the desktop portal returned an invalid screen stream");
      error.code = "portal-protocol";
      throw error;
    }
    const position = properties.position === undefined ? null : unpack(properties.position);
    const size = properties.size === undefined ? null : unpack(properties.size);
    const pipewireSerial =
      properties["pipewire-serial"] === undefined ? null : unpack(properties["pipewire-serial"]);
    return {
      nodeId,
      pipewireSerial:
        typeof pipewireSerial === "bigint" || Number.isSafeInteger(pipewireSerial)
          ? String(pipewireSerial)
          : null,
      position:
        Array.isArray(position) && position.length === 2 ? [position[0], position[1]] : null,
      size: Array.isArray(size) && size.length === 2 ? [size[0], size[1]] : null,
    };
  });
}

/** Returns the selected monitor stream for one Electron display rectangle. */
function resolveDisplayStream(displayBounds) {
  if (
    displayBounds === null ||
    typeof displayBounds !== "object" ||
    !Number.isFinite(displayBounds.x) ||
    !Number.isFinite(displayBounds.y) ||
    !Number.isFinite(displayBounds.width) ||
    !Number.isFinite(displayBounds.height) ||
    displayBounds.width <= 0 ||
    displayBounds.height <= 0
  ) {
    const error = new Error("desktop stream capture requires valid display bounds");
    error.code = "invalid-display-bounds";
    throw error;
  }
  const stream = screenStreams.find((candidate) => {
    if (candidate.position === null || candidate.size === null) return false;
    const [left, top] = candidate.position;
    const [width, height] = candidate.size;
    const centerX = displayBounds.x + displayBounds.width / 2;
    const centerY = displayBounds.y + displayBounds.height / 2;
    return centerX >= left && centerY >= top && centerX < left + width && centerY < top + height;
  });
  const selected = stream ?? (screenStreams.length === 1 ? screenStreams[0] : null);
  if (selected === null) {
    const error = new Error("the requested display is not on a shared monitor");
    error.code = "screen-not-shared";
    throw error;
  }
  return selected;
}

/** Returns the selected monitor stream for one Electron display rectangle. */
function resolveSnapshotStream(displayBounds) {
  return resolveDisplayStream(displayBounds);
}

/** Opens the session-scoped PipeWire remote provided by the desktop portal. */
function openPipeWireRemote() {
  const result = connection.call_with_unix_fd_list_sync(
    PORTAL_BUS_NAME,
    PORTAL_OBJECT_PATH,
    SCREEN_CAST_INTERFACE,
    "OpenPipeWireRemote",
    new GLib.Variant("(oa{sv})", [sessionHandle, {}]),
    new GLib.VariantType("(h)"),
    Gio.DBusCallFlags.NONE,
    5_000,
    null,
    null,
  );
  if (!Array.isArray(result) || result.length !== 2) {
    const error = new Error("the desktop portal returned an invalid PipeWire response");
    error.code = "portal-protocol";
    throw error;
  }
  const [reply, fileDescriptors] = result;
  const [fileDescriptorIndex] = reply.deepUnpack();
  if (!Number.isInteger(fileDescriptorIndex) || fileDescriptorIndex < 0) {
    const error = new Error("the desktop portal returned an invalid PipeWire file descriptor");
    error.code = "portal-protocol";
    throw error;
  }
  return fileDescriptors.get(fileDescriptorIndex);
}

/** Creates an error for a stream snapshot interrupted by access release. */
function streamCaptureCancellationError() {
  const error = new Error("desktop stream capture was cancelled when access was released");
  error.code = "request-cancelled";
  return error;
}

/** Cancels every in-flight session-stream snapshot immediately. */
function cancelActiveStreamCaptures() {
  for (const cancel of Array.from(activeStreamCaptures)) cancel();
}

/** Captures one PNG frame from the active portal PipeWire stream. */
function capturePortalStream(displayBounds) {
  const gstreamer = ensureGstreamer();
  const captureSource =
    sessionAccess === "control" ? "remote-desktop-stream" : "screen-cast-stream";
  const stream = resolveSnapshotStream(displayBounds);
  const fileDescriptor = openPipeWireRemote();

  return new Promise((resolve, reject) => {
    let pipeline = null;
    let source = null;
    let sink = null;
    let bus = null;
    let pollSource = 0;
    let cancel = null;
    const finish = createStreamCaptureCompletion({
      clearPoll: () => {
        if (pollSource === 0) return;
        GLib.source_remove(pollSource);
        pollSource = 0;
      },
      unregister: () => {
        if (cancel === null) return;
        activeStreamCaptures.delete(cancel);
        cancel = null;
      },
      stopPipeline: () => {
        const completedPipeline = pipeline;
        pipeline = null;
        source = null;
        sink = null;
        bus = null;
        if (completedPipeline !== null) completedPipeline.set_state(gstreamer.State.NULL);
      },
      closeRemote: () => GLib.close(fileDescriptor),
      resolve: (data) => {
        noteCompletedStreamCapture();
        resolve(data);
      },
      reject: (error) => {
        noteCompletedStreamCapture();
        reject(error);
      },
    });
    cancel = () => finish(streamCaptureCancellationError());
    try {
      pipeline = gstreamer.parse_launch(
        "pipewiresrc name=source do-timestamp=true num-buffers=1 " +
          "! videoconvert ! video/x-raw,format=RGBA " +
          "! pngenc snapshot=true compression-level=3 " +
          "! appsink name=sink sync=false max-buffers=1",
      );
      source = pipeline.get_by_name("source");
      source.set_property("fd", fileDescriptor);
      if (stream.pipewireSerial !== null && source.find_property("target-object") !== null) {
        source.set_property("target-object", stream.pipewireSerial);
      } else {
        source.set_property("path", String(stream.nodeId));
      }

      sink = pipeline.get_by_name("sink");
      bus = pipeline.get_bus();
      const deadline = GLib.get_monotonic_time() + STREAM_CAPTURE_TIMEOUT_MS * 1_000;
      activeStreamCaptures.add(cancel);

      const stateChange = pipeline.set_state(gstreamer.State.PLAYING);
      if (stateChange === gstreamer.StateChangeReturn.FAILURE) {
        const error = new Error("GStreamer rejected the desktop stream capture pipeline");
        error.code = "stream-capture-failed";
        finish(error);
        return;
      }

      pollSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STREAM_CAPTURE_POLL_MS, () => {
        try {
          const sample = sink.emit("try-pull-sample", 0);
          if (sample !== null) {
            const buffer = sample.get_buffer();
            const size = buffer?.get_size() ?? 0;
            if (size <= 0 || size > MAX_SCREENSHOT_BYTES) {
              const error = new Error("the desktop stream returned an invalid PNG frame size");
              error.code = size > MAX_SCREENSHOT_BYTES ? "capture-too-large" : "capture-failed";
              finish(error);
            } else {
              finish(null, {
                data: GLib.base64_encode(buffer.extract_dup(0, size)),
                source: captureSource,
              });
            }
            return GLib.SOURCE_REMOVE;
          }
          const message = bus.pop_filtered(gstreamer.MessageType.ERROR);
          if (message !== null) {
            const [failure] = message.parse_error();
            const error = new Error(`desktop stream capture failed: ${failure.message}`);
            error.code = "stream-capture-failed";
            finish(error);
            return GLib.SOURCE_REMOVE;
          }
          if (GLib.get_monotonic_time() >= deadline) {
            const error = new Error("the desktop stream did not produce a frame in time");
            error.code = "stream-capture-timeout";
            finish(error);
            return GLib.SOURCE_REMOVE;
          }
          return GLib.SOURCE_CONTINUE;
        } catch (error) {
          finish(error);
          return GLib.SOURCE_REMOVE;
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

/** Captures through the active view or control stream. */
async function captureDesktop(displayBounds) {
  if (sessionHandle !== null && sessionAccess !== null && screenStreams.length > 0) {
    try {
      await wakeDisplay();
      return await capturePortalStream(displayBounds);
    } catch (error) {
      if (error?.code === "display-locked") await releaseAccess();
      throw error;
    }
  }
  const error = new Error("desktop capture requires an active view or control session");
  error.code = "view-required";
  throw error;
}

/** Returns the public state of the current and remembered desktop access. */
function accessStatus() {
  return {
    devices: grantedDevices,
    permission,
    rememberedAccess: rememberedAccess(),
    displayState: displayState(),
    keepAwake: desktopAccessInhibitHandle !== null,
  };
}

/** Creates and starts one user-authorized view or control session. */
async function ensureSession(requestedAccess, preventSleep = powerProtectionEnabled) {
  await configurePowerProtection(preventSleep);
  if (
    sessionHandle !== null &&
    (sessionAccess === "control" || sessionAccess === requestedAccess)
  ) {
    try {
      await wakeDisplay();
      return accessStatus();
    } catch (error) {
      await releaseAccess();
      throw error;
    }
  }
  const generation = accessGeneration;
  permission = "pending";
  const sessionInterface =
    requestedAccess === "control" ? REMOTE_DESKTOP_INTERFACE : SCREEN_CAST_INTERFACE;
  const sessionToken = nextToken("session");
  const expectedSessionHandle = `${PORTAL_OBJECT_PATH}/session/${senderToken}/${sessionToken}`;
  try {
    if (desktopAccessInhibitHandle === null && powerProtectionEnabled) {
      await acquireDesktopAccessInhibitor();
      requireAccessGeneration(generation);
    }
    await wakeDisplay();
    requireAccessGeneration(generation);
    if (sessionHandle !== null) await closeSession();
    const createResults = await portalRequest(
      sessionInterface,
      "CreateSession",
      "(a{sv})",
      [
        {
          session_handle_token: new GLib.Variant("s", sessionToken),
        },
      ],
      "create",
      null,
    );
    requireAccessGeneration(generation);
    const createdHandle = resultField(createResults, "session_handle");
    if (createdHandle !== expectedSessionHandle) {
      const error = new Error("the desktop portal returned an unexpected session handle");
      error.code = "portal-protocol";
      throw error;
    }
    sessionHandle = createdHandle;
    sessionClosedSubscription = connection.signal_subscribe(
      PORTAL_BUS_NAME,
      SESSION_INTERFACE,
      "Closed",
      createdHandle,
      null,
      Gio.DBusSignalFlags.NONE,
      () => {
        if (sessionHandle !== createdHandle) return;
        accessGeneration += 1;
        void cancelPendingPortalRequests("access");
        cancelActiveStreamCaptures();
        sessionHandle = null;
        sessionAccess = null;
        grantedDevices = 0;
        screenStreams = [];
        pointerPosition = null;
        heldKeysyms.clear();
        heldButtons.clear();
        permission = inactivePermission();
        invalidateAccessibilityTargets();
        void releaseDesktopAccessInhibitor();
        void accessibilityStatusLease.restore();
        if (sessionClosedSubscription !== 0) {
          connection.signal_unsubscribe(sessionClosedSubscription);
          sessionClosedSubscription = 0;
        }
      },
    );
    const reconnectToken = consumeRestoreToken(requestedAccess);
    if (requestedAccess === "control") {
      await portalRequest(
        REMOTE_DESKTOP_INTERFACE,
        "SelectDevices",
        "(oa{sv})",
        [
          createdHandle,
          {
            types: new GLib.Variant("u", KEYBOARD_DEVICE | POINTER_DEVICE),
            persist_mode: new GLib.Variant("u", 2),
            ...(reconnectToken === null
              ? {}
              : { restore_token: new GLib.Variant("s", reconnectToken) }),
          },
        ],
        "select",
      );
      requireAccessGeneration(generation);
    }
    await portalRequest(
      SCREEN_CAST_INTERFACE,
      "SelectSources",
      "(oa{sv})",
      [
        createdHandle,
        {
          types: new GLib.Variant("u", MONITOR_SOURCE),
          multiple: new GLib.Variant("b", true),
          cursor_mode: new GLib.Variant("u", HIDDEN_CURSOR_MODE),
          ...(requestedAccess === "view"
            ? {
                persist_mode: new GLib.Variant("u", 2),
                ...(reconnectToken === null
                  ? {}
                  : { restore_token: new GLib.Variant("s", reconnectToken) }),
              }
            : {}),
        },
      ],
      "sources",
    );
    requireAccessGeneration(generation);
    const startResults = await portalRequest(
      sessionInterface,
      "Start",
      "(osa{sv})",
      [createdHandle, "", {}],
      "start",
    );
    requireAccessGeneration(generation);
    screenStreams = decodeScreenStreams(resultField(startResults, "streams"));
    if (screenStreams.length === 0) {
      const error = new Error("the desktop portal did not grant a monitor stream");
      error.code = "permission-denied";
      throw error;
    }
    const devices = requestedAccess === "control" ? resultField(startResults, "devices") : 0;
    const controlGranted =
      typeof devices === "number" &&
      (devices & (KEYBOARD_DEVICE | POINTER_DEVICE)) === (KEYBOARD_DEVICE | POINTER_DEVICE);
    const effectiveAccess = requestedAccess === "control" && controlGranted ? "control" : "view";
    sessionAccess = effectiveAccess;
    grantedDevices = effectiveAccess === "control" ? devices : 0;
    const nextRestoreToken = resultField(startResults, "restore_token");
    if (
      typeof nextRestoreToken === "string" &&
      nextRestoreToken.length > 0 &&
      nextRestoreToken.length <= MAX_RESTORE_TOKEN_LENGTH &&
      requestedAccess === effectiveAccess
    ) {
      saveRestoreToken(effectiveAccess, nextRestoreToken);
    }
    permission = effectiveAccess === "control" ? "granted" : "view-only";
    return accessStatus();
  } catch (error) {
    if (generation !== accessGeneration) {
      await closePortalSession(expectedSessionHandle, false);
      throw portalCancellationError();
    }
    permission = error?.code === "permission-denied" ? "denied" : inactivePermission();
    await closeSession();
    await releaseDesktopAccessInhibitor();
    throw error;
  }
}

/** Requires one granted portal device before sending input. */
function requireDevice(device, name) {
  if ((grantedDevices & device) !== 0) return;
  const error = new Error(`the desktop portal did not grant ${name} control`);
  error.code = "permission-denied";
  throw error;
}

/** Sends one keysym press or release. */
async function sendKeysym(keysym, pressed) {
  requireDevice(KEYBOARD_DEVICE, "keyboard");
  await portalCall("NotifyKeyboardKeysym", "(oa{sv}iu)", [
    sessionHandle,
    {},
    keysym,
    pressed ? 1 : 0,
  ]);
}

/** Holds one keysym while tracking it for automatic cleanup. */
async function holdKeysym(keysym) {
  if (heldKeysyms.has(keysym)) return;
  await sendKeysym(keysym, true);
  heldKeysyms.add(keysym);
}

/** Releases one keysym only when this helper currently holds it. */
async function releaseKeysym(keysym) {
  if (!heldKeysyms.has(keysym)) return;
  await sendKeysym(keysym, false);
  heldKeysyms.delete(keysym);
}

/** Presses and releases one keysym without disturbing an explicitly held key. */
async function tapKeysym(keysym, detail = {}) {
  if (heldKeysyms.has(keysym)) {
    throw accessibilityError(
      "key-already-held",
      "the desktop key is already held; release it before pressing it",
      detail,
    );
  }
  await holdKeysym(keysym);
  await releaseKeysym(keysym);
}

/** Enters one code point through GNOME's layout-independent Unicode input method. */
async function typeUnicodeCharacter(character) {
  const codePoint = character.codePointAt(0);
  const hexadecimal = codePoint.toString(16);
  const controlWasHeld = heldKeysyms.has(MODIFIER_KEYSYMS.Control);
  const shiftWasHeld = heldKeysyms.has(MODIFIER_KEYSYMS.Shift);
  try {
    await holdKeysym(MODIFIER_KEYSYMS.Control);
    await holdKeysym(MODIFIER_KEYSYMS.Shift);
    await delay(UNICODE_ENTRY_MODIFIER_SETTLE_MS);
    await tapKeysym(resolveKeysym("u", "text"), { field: "text" });
    await delay(UNICODE_ENTRY_PREFIX_SETTLE_MS);
    await releaseKeysym(MODIFIER_KEYSYMS.Shift);
    await releaseKeysym(MODIFIER_KEYSYMS.Control);
    for (const digit of hexadecimal) {
      await tapKeysym(resolveKeysym(digit, "text"), { field: "text" });
      await delay(UNICODE_ENTRY_DIGIT_SETTLE_MS);
    }
    await tapKeysym(NAMED_KEYSYMS.enter, { field: "text" });
    await delay(UNICODE_ENTRY_COMMIT_SETTLE_MS);
  } finally {
    if (!shiftWasHeld) await releaseKeysym(MODIFIER_KEYSYMS.Shift);
    if (!controlWasHeld) await releaseKeysym(MODIFIER_KEYSYMS.Control);
    if (controlWasHeld) await holdKeysym(MODIFIER_KEYSYMS.Control);
    if (shiftWasHeld) await holdKeysym(MODIFIER_KEYSYMS.Shift);
  }
}

/** Best-effort releases every tracked keysym before the portal session closes. */
async function releaseHeldKeysyms() {
  const keysyms = Array.from(heldKeysyms);
  if (keysyms.length === 0) return true;
  if (sessionHandle === null || (grantedDevices & KEYBOARD_DEVICE) === 0) {
    heldKeysyms.clear();
    return true;
  }
  let released = true;
  for (let keyIndex = keysyms.length - 1; keyIndex >= 0; keyIndex -= 1) {
    try {
      await sendKeysym(keysyms[keyIndex], false);
      heldKeysyms.delete(keysyms[keyIndex]);
    } catch (error) {
      released = false;
      printerr(`computer-use held key release failed: ${normalizeError(error).message}`);
    }
  }
  return released;
}

/** Resolves a public key name or printable ASCII character to an X11 keysym. */
function resolveKeysym(key, field = "key") {
  if (typeof key !== "string") {
    throw accessibilityError("unsupported-key", "desktop key names must be strings", {
      field,
      received: String(key),
      expected: ["named key", "F1-F24", "single printable ASCII character"],
      phase: "validation",
    });
  }
  const named = NAMED_KEYSYMS[key.toLowerCase()];
  if (named !== undefined) return named;
  const functionMatch = /^f([1-9]|1[0-9]|2[0-4])$/iu.exec(key);
  if (functionMatch) return 0xffbd + Number(functionMatch[1]);
  const characters = Array.from(key);
  if (characters.length !== 1) {
    const error = new Error(`unsupported desktop key ${JSON.stringify(key)}`);
    error.code = "unsupported-key";
    error.field = field;
    if (field !== "text") error.received = key;
    error.expected = ["named key", "F1-F24", "single printable ASCII character"];
    error.phase = "validation";
    throw error;
  }
  const character = field === "text" ? characters[0] : characters[0].toLowerCase();
  const codePoint = character.codePointAt(0);
  if (codePoint < 0x20 || codePoint > 0x7e) {
    throw accessibilityError(
      "unsupported-key",
      "non-ASCII characters are supported only by desktop text actions",
      {
        field,
        ...(field === "text" ? {} : { received: key }),
        expected: ["named key", "F1-F24", "single printable ASCII character"],
        phase: "validation",
      },
    );
  }
  return codePoint;
}

/** Resolves and validates one public key chord before requesting access. */
function resolveKeyChord(keys) {
  const resolvedKeys = keys.map(({ key, field }) => ({
    key,
    field,
    keysym: resolveKeysym(key, field),
  }));
  const seen = new Set();
  for (const resolved of resolvedKeys) {
    if (seen.has(resolved.keysym)) {
      throw accessibilityError("duplicate-hotkey-key", "desktop hotkey keys must be unique", {
        field: resolved.field,
        received: resolved.key,
        expected: ["key not already present in this chord"],
        phase: "validation",
      });
    }
    seen.add(resolved.keysym);
  }
  return resolvedKeys;
}

/** Presses and reliably releases one resolved key chord. */
async function sendKeyChord(resolvedKeys) {
  const pressedKeys = [];
  for (const resolved of resolvedKeys.slice(0, -1)) {
    if (heldKeysyms.has(resolved.keysym)) continue;
    await runInputPhase("key-down", () => holdKeysym(resolved.keysym));
    pressedKeys.push(resolved.keysym);
  }
  const finalKey = resolvedKeys[resolvedKeys.length - 1];
  await runInputPhase("key-press", () =>
    tapKeysym(finalKey.keysym, { field: finalKey.field, received: finalKey.key }),
  );
  for (let keyIndex = pressedKeys.length - 1; keyIndex >= 0; keyIndex -= 1) {
    await runInputPhase("key-up", () => releaseKeysym(pressedKeys[keyIndex]));
  }
}

/** Maps one desktop-logical position to its selected monitor stream. */
function resolveStreamPosition(x, y, displayBounds, capturedStreamSize) {
  const selected = resolveDisplayStream(displayBounds);
  if (
    capturedStreamSize === null ||
    typeof capturedStreamSize !== "object" ||
    !Number.isFinite(capturedStreamSize.width) ||
    !Number.isFinite(capturedStreamSize.height) ||
    capturedStreamSize.width <= 0 ||
    capturedStreamSize.height <= 0
  ) {
    const error = new Error("desktop input requires valid captured stream dimensions");
    error.code = "invalid-stream-size";
    throw error;
  }
  const portalStreamSize =
    selected.size === null
      ? { width: displayBounds.width, height: displayBounds.height }
      : { width: selected.size[0], height: selected.size[1] };
  const { x: localX, y: localY } = mapDesktopPointToStream(
    { x, y },
    displayBounds,
    portalStreamSize,
  );
  if (
    localX < 0 ||
    localY < 0 ||
    localX >= portalStreamSize.width ||
    localY >= portalStreamSize.height
  ) {
    const error = new Error(`desktop position (${x}, ${y}) is not on the shared monitor`);
    error.code = "screen-not-shared";
    throw error;
  }
  return {
    stream: selected,
    x: localX,
    y: localY,
    relativeAnchor: relativePointerAnchor(portalStreamSize, capturedStreamSize),
    relativeMotion: streamRequiresRelativePointerMotion(portalStreamSize, capturedStreamSize),
  };
}

/** Sends one absolute pointer position in a selected monitor stream. */
async function sendAbsolutePointer(position) {
  await portalCall("NotifyPointerMotionAbsolute", "(oa{sv}udd)", [
    sessionHandle,
    {},
    position.stream.nodeId,
    position.x,
    position.y,
  ]);
  pointerPosition = position;
}

/** Sends one relative pointer delta from the last commanded position. */
async function sendRelativePointer(position) {
  if (pointerPosition === null || pointerPosition.stream.nodeId !== position.stream.nodeId) {
    const error = new Error("desktop relative pointer motion requires a known stream position");
    error.code = "pointer-position-unavailable";
    throw error;
  }
  const delta = mapRelativePointerDelta(pointerPosition, position);
  if (delta.x !== 0 || delta.y !== 0) {
    await portalCall("NotifyPointerMotion", "(oa{sv}dd)", [sessionHandle, {}, delta.x, delta.y]);
  }
  pointerPosition = position;
}

/** Anchors a scaled stream away from desktop edge actions. */
async function anchorRelativePointer(position) {
  await sendAbsolutePointer({
    ...position,
    x: position.relativeAnchor.portal.x,
    y: position.relativeAnchor.portal.y,
  });
  pointerPosition = {
    ...position,
    x: position.relativeAnchor.logical.x,
    y: position.relativeAnchor.logical.y,
  };
}

/** Moves the pointer to a compositor position, optionally interpolating a known path. */
async function movePointer(x, y, durationMs, requestedSteps, displayBounds, streamSize) {
  requireDevice(POINTER_DEVICE, "pointer");
  const target = resolveStreamPosition(x, y, displayBounds, streamSize);
  if (!target.relativeMotion) {
    if (pointerPosition === null || pointerPosition.stream.nodeId !== target.stream.nodeId) {
      await sendAbsolutePointer(target);
      return;
    }
    const stepCount =
      requestedSteps === undefined
        ? Math.max(1, Math.min(120, Math.ceil(durationMs / 16)))
        : Math.max(1, Math.min(120, requestedSteps));
    const start = pointerPosition;
    for (let step = 1; step <= stepCount; step += 1) {
      await sendAbsolutePointer({
        stream: target.stream,
        x: start.x + ((target.x - start.x) * step) / stepCount,
        y: start.y + ((target.y - start.y) * step) / stepCount,
        relativeAnchor: target.relativeAnchor,
        relativeMotion: false,
      });
      if (step < stepCount) await delay(durationMs / stepCount);
    }
    return;
  }

  const hasKnownPosition =
    pointerPosition !== null &&
    pointerPosition.stream.nodeId === target.stream.nodeId &&
    pointerPosition.relativeAnchor.portal.x === target.relativeAnchor.portal.x &&
    pointerPosition.relativeAnchor.portal.y === target.relativeAnchor.portal.y &&
    pointerPosition.relativeAnchor.logical.x === target.relativeAnchor.logical.x &&
    pointerPosition.relativeAnchor.logical.y === target.relativeAnchor.logical.y &&
    pointerPosition.relativeMotion === true;
  if (!hasKnownPosition && heldButtons.size > 0) {
    const error = new Error("desktop pointer position changed during a scaled drag");
    error.code = "pointer-position-unavailable";
    throw error;
  }
  if (!hasKnownPosition || (durationMs === 0 && heldButtons.size === 0)) {
    await anchorRelativePointer(target);
  }
  if (pointerPosition === null) {
    const error = new Error("desktop relative pointer anchor was not retained");
    error.code = "pointer-position-unavailable";
    throw error;
  }
  const stepCount =
    requestedSteps === undefined
      ? Math.max(1, Math.min(120, Math.ceil(durationMs / 16)))
      : Math.max(1, Math.min(120, requestedSteps));
  const start = pointerPosition;
  for (let step = 1; step <= stepCount; step += 1) {
    await sendRelativePointer({
      stream: target.stream,
      x: start.x + ((target.x - start.x) * step) / stepCount,
      y: start.y + ((target.y - start.y) * step) / stepCount,
      relativeAnchor: target.relativeAnchor,
      relativeMotion: true,
    });
    if (step < stepCount) await delay(durationMs / stepCount);
  }
}

/** Sends one mouse-button state change. */
async function sendButton(button, pressed) {
  requireDevice(POINTER_DEVICE, "pointer");
  const buttonCode = BUTTON_CODES[button];
  if (buttonCode === undefined) {
    const error = new Error(`unsupported desktop mouse button ${JSON.stringify(button)}`);
    error.code = "unsupported-button";
    error.field = "button";
    error.received = String(button);
    error.expected = Object.keys(BUTTON_CODES);
    throw error;
  }
  await portalCall("NotifyPointerButton", "(oa{sv}iu)", [
    sessionHandle,
    {},
    buttonCode,
    pressed ? 1 : 0,
  ]);
}

/** Holds one mouse button while tracking it for automatic cleanup. */
async function holdButton(button) {
  if (heldButtons.has(button)) {
    throw accessibilityError("button-already-held", "the desktop mouse button is already held", {
      field: "button",
      received: String(button),
    });
  }
  await sendButton(button, true);
  heldButtons.add(button);
}

/** Releases one mouse button only when this helper currently holds it. */
async function releaseButton(button) {
  if (!heldButtons.has(button)) return;
  await sendButton(button, false);
  heldButtons.delete(button);
}

/** Best-effort releases every tracked mouse button. */
async function releaseHeldButtons() {
  const buttons = Array.from(heldButtons);
  if (buttons.length === 0) return true;
  if (sessionHandle === null || (grantedDevices & POINTER_DEVICE) === 0) {
    heldButtons.clear();
    return true;
  }
  let released = true;
  for (let buttonIndex = buttons.length - 1; buttonIndex >= 0; buttonIndex -= 1) {
    try {
      await sendButton(buttons[buttonIndex], false);
      heldButtons.delete(buttons[buttonIndex]);
    } catch (error) {
      released = false;
      printerr(`computer-use held button release failed: ${normalizeError(error).message}`);
    }
  }
  return released;
}

/** Restores a safe input state after one input command fails. */
async function recoverHeldInputs() {
  const hadKeys = heldKeysyms.size > 0;
  const hadButtons = heldButtons.size > 0;
  const keysReleased = await releaseHeldKeysyms();
  const buttonsReleased = await releaseHeldButtons();
  if (keysReleased && buttonsReleased) {
    return {
      keys: hadKeys ? "released" : "not-needed",
      buttons: hadButtons ? "released" : "not-needed",
    };
  }
  cancelActiveStreamCaptures();
  const sessionClosed = await detachSession();
  heldKeysyms.clear();
  heldButtons.clear();
  invalidateAccessibilityTargets();
  permission = inactivePermission();
  await releaseDesktopAccessInhibitor();
  return {
    keys: keysReleased
      ? hadKeys
        ? "released"
        : "not-needed"
      : sessionClosed
        ? "session-closed"
        : "release-failed",
    buttons: buttonsReleased
      ? hadButtons
        ? "released"
        : "not-needed"
      : sessionClosed
        ? "session-closed"
        : "release-failed",
  };
}

/** Activates one current semantic target after requiring desktop-control consent. */
async function activateAccessibilityTarget(targetId) {
  const staleTargetDetail = {
    field: "targetId",
    received: targetId,
    phase: "validation",
  };
  const stored = accessibilityTargets.get(targetId);
  if (stored === undefined) {
    throw accessibilityError(
      "stale-accessibility-target",
      "the semantic target is stale; capture a new computer snapshot",
      staleTargetDetail,
    );
  }
  await runInputPhase("authorization", () => ensureSession("control"));
  const rootContainsFocus = await waitForAccessibilityRootFocus(stored.root);
  if (!rootContainsFocus) {
    throw accessibilityError(
      "stale-accessibility-target",
      "the semantic target's window is no longer focused",
      staleTargetDetail,
    );
  }
  const current = readAccessibilityTarget(
    stored.accessible,
    { accessible: stored.root, application: stored.application },
    stored.windowBounds,
    targetId,
  );
  if (current === null || !current.target.enabled) {
    throw accessibilityError(
      "stale-accessibility-target",
      "the semantic target is no longer visible and enabled",
      staleTargetDetail,
    );
  }
  const activation = current.target.activation;
  const activated = await runInputPhase("execution", async () => {
    if (activation === "action" && current.stored.actionIndex !== null) {
      return current.stored.accessible.get_action_iface().do_action(current.stored.actionIndex);
    }
    const focused = current.stored.accessible.get_component_iface().grab_focus();
    if (focused && activation === "keyboard") {
      await delay(ACCESSIBILITY_FOCUS_SETTLE_MS);
      await runInputPhase("key-press", () => tapKeysym(NAMED_KEYSYMS.enter));
    }
    return focused;
  });
  if (!activated) {
    throw accessibilityError(
      "accessibility-activation-failed",
      "the focused application rejected semantic activation",
      { field: "targetId", received: targetId, phase: "execution" },
    );
  }
  invalidateAccessibilityTargets();
  return { target: current.target };
}

/** Sends bounded wheel steps through the portal's discrete-axis method. */
async function sendWheelTicks(deltaX, deltaY) {
  requireDevice(POINTER_DEVICE, "pointer");
  if (!Number.isInteger(deltaX) || !Number.isInteger(deltaY)) {
    throw accessibilityError("invalid-wheel", "desktop wheel deltas must be integer ticks", {
      field: "deltaX/deltaY",
      expected: ["integer wheel ticks"],
    });
  }
  if (deltaY !== 0) {
    await portalCall("NotifyPointerAxisDiscrete", "(oa{sv}ui)", [sessionHandle, {}, 0, deltaY]);
  }
  if (deltaX !== 0) {
    await portalCall("NotifyPointerAxisDiscrete", "(oa{sv}ui)", [sessionHandle, {}, 1, deltaX]);
  }
}

/** Dispatches one validated command from the Electron parent. */
async function handleCommand(message) {
  switch (message.method) {
    case "status": {
      return accessStatus();
    }
    case "snapshot": {
      const generation = accessGeneration;
      const screenshot = await captureDesktop(message.params.displayBounds);
      if (message.params.includeAccessibility !== true) {
        invalidateAccessibilityTargets();
        return screenshot;
      }
      await accessibilityStatusLease.acquire();
      if (generation !== accessGeneration || sessionHandle === null) {
        await accessibilityStatusLease.restore();
        throw portalCancellationError();
      }
      return {
        ...screenshot,
        accessibility: captureAccessibility(),
      };
    }
    case "configurePower": {
      await configurePowerProtection(message.params.enabled === true);
      return null;
    }
    case "setAgentWorking": {
      await setAgentWorking(message.params.active === true, message.params.enabled === true);
      return null;
    }
    case "start": {
      return await ensureSession("control", message.params.preventSleep === true);
    }
    case "view": {
      return await ensureSession("view", message.params.preventSleep === true);
    }
    case "move": {
      await runInputPhase("authorization", () => ensureSession("control"));
      await runInputPhase("pointer-move", () =>
        movePointer(
          message.params.x,
          message.params.y,
          message.params.durationMs,
          undefined,
          message.params.displayBounds,
          message.params.streamSize,
        ),
      );
      return null;
    }
    case "click": {
      await runInputPhase("authorization", () => ensureSession("control"));
      const button = message.params.button;
      for (let count = 0; count < message.params.count; count += 1) {
        await runInputPhase("button-down", () => holdButton(button));
        await runInputPhase("button-up", () => releaseButton(button));
        if (count + 1 < message.params.count) await delay(80);
      }
      return null;
    }
    case "activate": {
      return await activateAccessibilityTarget(message.params.targetId);
    }
    case "drag": {
      await runInputPhase("authorization", () => ensureSession("control"));
      const button = message.params.button;
      await runInputPhase("button-down", () => holdButton(button));
      await runInputPhase("pointer-move", () =>
        movePointer(
          message.params.x,
          message.params.y,
          message.params.durationMs,
          message.params.steps,
          message.params.displayBounds,
          message.params.streamSize,
        ),
      );
      await runInputPhase("button-up", () => releaseButton(button));
      return null;
    }
    case "wheel": {
      await runInputPhase("authorization", () => ensureSession("control"));
      await runInputPhase("execution", () =>
        sendWheelTicks(message.params.deltaX, message.params.deltaY),
      );
      return null;
    }
    case "type": {
      await runInputPhase("authorization", () => ensureSession("control"));
      const normalizedText = message.params.text.replace(/\r\n|\r/gu, "\n");
      for (const character of normalizedText) {
        if (character === "\n") {
          await runInputPhase("key-press", () => tapKeysym(NAMED_KEYSYMS.enter, { field: "text" }));
        } else if (character === "\t") {
          await runInputPhase("key-press", () => tapKeysym(NAMED_KEYSYMS.tab, { field: "text" }));
        } else if (/^[\x20-\x7e]$/u.test(character)) {
          const keysym = resolveKeysym(character, "text");
          await runInputPhase("key-press", () => tapKeysym(keysym, { field: "text" }));
        } else {
          await runInputPhase("key-press", () => typeUnicodeCharacter(character));
        }
        await delay(message.params.intervalMs);
      }
      return null;
    }
    case "keyDown": {
      const keysym = resolveKeysym(message.params.key, "key");
      if (heldKeysyms.has(keysym)) return null;
      await runInputPhase("authorization", () => ensureSession("control"));
      await runInputPhase("key-down", () => holdKeysym(keysym));
      return null;
    }
    case "keyUp": {
      const keysym = resolveKeysym(message.params.key, "key");
      await runInputPhase("key-up", () => releaseKeysym(keysym));
      return null;
    }
    case "press": {
      const keysyms = resolveKeyChord([
        ...(message.params.modifiers ?? []).map((key, index) => ({
          key,
          field: `modifiers[${index}]`,
        })),
        { key: message.params.key, field: "key" },
      ]);
      await runInputPhase("authorization", () => ensureSession("control"));
      await sendKeyChord(keysyms);
      return null;
    }
    case "hotkey": {
      const keysyms = resolveKeyChord(
        message.params.keys.map((key, index) => ({ key, field: `keys[${index}]` })),
      );
      await runInputPhase("authorization", () => ensureSession("control"));
      await sendKeyChord(keysyms);
      return null;
    }
    case "stop": {
      await releaseAccess();
      return null;
    }
    case "forget": {
      await releaseAccess();
      forgetRestoreTokens();
      permission = "prompt-required";
      return null;
    }
    default: {
      const error = new Error(`unsupported computer-use helper method ${message.method}`);
      error.code = "unsupported-method";
      throw error;
    }
  }
}

/** Registers this unsandboxed helper connection as the parent T3 application. */
function registerHostApplication() {
  if (appId.length === 0) return;
  try {
    connection.call_sync(
      PORTAL_BUS_NAME,
      PORTAL_OBJECT_PATH,
      REGISTRY_INTERFACE,
      "Register",
      new GLib.Variant("(sa{sv})", [appId, {}]),
      null,
      Gio.DBusCallFlags.NONE,
      5_000,
      null,
    );
  } catch (error) {
    printerr(`computer-use portal registration skipped: ${normalizeError(error).message}`);
  }
}

/** Verifies that the current portal advertises pointer and keyboard devices. */
function verifyPortalCapabilities() {
  const reply = connection.call_sync(
    PORTAL_BUS_NAME,
    PORTAL_OBJECT_PATH,
    PROPERTIES_INTERFACE,
    "Get",
    new GLib.Variant("(ss)", [REMOTE_DESKTOP_INTERFACE, "AvailableDeviceTypes"]),
    new GLib.VariantType("(v)"),
    Gio.DBusCallFlags.NONE,
    5_000,
    null,
  );
  const [value] = reply.deepUnpack();
  const devices = unpack(value);
  if ((devices & (KEYBOARD_DEVICE | POINTER_DEVICE)) !== (KEYBOARD_DEVICE | POINTER_DEVICE)) {
    throw new Error("the desktop portal does not advertise pointer and keyboard control");
  }
  const sourceReply = connection.call_sync(
    PORTAL_BUS_NAME,
    PORTAL_OBJECT_PATH,
    PROPERTIES_INTERFACE,
    "Get",
    new GLib.Variant("(ss)", [SCREEN_CAST_INTERFACE, "AvailableSourceTypes"]),
    new GLib.VariantType("(v)"),
    Gio.DBusCallFlags.NONE,
    5_000,
    null,
  );
  const [sourceValue] = sourceReply.deepUnpack();
  const sources = unpack(sourceValue);
  if ((sources & MONITOR_SOURCE) !== MONITOR_SOURCE) {
    throw new Error("the desktop portal does not advertise monitor sharing");
  }
}

/** Queues access revocation after a manual lock or forced suspend. */
function queueSystemRevocation() {
  if (shuttingDown) return;
  releaseQueue = releaseQueue.then(() => releaseAccess());
  releaseBarrier = releaseQueue;
}

/** Revokes access when logind reports a lock or a forced system sleep. */
function registerSystemRevocationSignals() {
  if (systemConnection === null || loginSessionPath === null) return;
  systemConnection.signal_subscribe(
    LOGIN_MANAGER_BUS_NAME,
    PROPERTIES_INTERFACE,
    "PropertiesChanged",
    loginSessionPath,
    LOGIN_SESSION_INTERFACE,
    Gio.DBusSignalFlags.NONE,
    (_connection, _sender, _path, _interface, _signal, parameters) => {
      const [_changedInterface, changedProperties] = parameters.deepUnpack();
      if (unpack(changedProperties.LockedHint) === true) queueSystemRevocation();
    },
  );
  systemConnection.signal_subscribe(
    LOGIN_MANAGER_BUS_NAME,
    LOGIN_MANAGER_INTERFACE,
    "PrepareForSleep",
    LOGIN_MANAGER_OBJECT_PATH,
    null,
    Gio.DBusSignalFlags.NONE,
    (_connection, _sender, _path, _interface, _signal, parameters) => {
      const [preparing] = parameters.deepUnpack();
      if (preparing === true) queueSystemRevocation();
    },
  );
}

restoreTokens = readRestoreTokens();
permission = inactivePermission();
connectLoginSession();
registerHostApplication();
verifyPortalCapabilities();

const input = GLib.IOChannel.unix_new(0);
input.set_encoding("UTF-8");
const mainLoop = new GLib.MainLoop(null, false);
let commandQueue = Promise.resolve();
let releaseQueue = Promise.resolve();
let releaseBarrier = Promise.resolve();
registerSystemRevocationSignals();

/** Executes one decoded helper command and emits its protocol response. */
async function processCommand(message) {
  try {
    const result = await handleCommand(message);
    respond({ id: message.id, ok: true, result });
  } catch (error) {
    const failure = mutableError(error);
    if (INPUT_METHODS.has(message?.method)) {
      try {
        failure.cleanup = await recoverHeldInputs();
      } catch (cleanupError) {
        printerr(`computer-use input cleanup failed: ${normalizeError(cleanupError).message}`);
        failure.cleanup = { keys: "release-failed", buttons: "release-failed" };
      }
    }
    respond({ id: message?.id ?? null, ok: false, error: normalizeError(failure) });
  }
}

/** Dispatches status and release without placing them behind pending authorization. */
function dispatchCommand(message) {
  if (message.method === "status") {
    void processCommand(message);
    return;
  }
  if (message.method === "stop" || message.method === "forget") {
    releaseQueue = releaseQueue.then(() => processCommand(message));
    releaseBarrier = releaseQueue;
    return;
  }
  const precedingRelease = releaseBarrier;
  commandQueue = Promise.all([commandQueue, precedingRelease]).then(() => processCommand(message));
}

GLib.io_add_watch(
  input,
  GLib.PRIORITY_DEFAULT,
  GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR,
  (channel, condition) => {
    if ((condition & (GLib.IOCondition.HUP | GLib.IOCondition.ERR)) !== 0) {
      if (!shuttingDown) {
        shuttingDown = true;
        const shutdown = Promise.all([
          releaseAccess(),
          (async () => {
            agentWorking = false;
            await syncAgentWorkInhibitor();
          })(),
        ]);
        void Promise.allSettled([shutdown, commandQueue, releaseQueue]).then(() => mainLoop.quit());
      }
      return GLib.SOURCE_REMOVE;
    }
    const [status, line] = channel.read_line();
    if (status !== GLib.IOStatus.NORMAL || line === null) return GLib.SOURCE_CONTINUE;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      respond({ id: null, ok: false, error: normalizeError(error) });
      return GLib.SOURCE_CONTINUE;
    }
    dispatchCommand(message);
    return GLib.SOURCE_CONTINUE;
  },
);

mainLoop.run();

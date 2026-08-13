import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ComputerAutomationActivateInput,
  ComputerAutomationActInput,
  ComputerAutomationClickInput,
  ComputerAutomationFailure,
  ComputerAutomationAccessInput,
  ComputerAutomationHotkeyInput,
  ComputerAutomationKeyInput,
  ComputerAutomationWheelInput,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTargetInput,
  ComputerAutomationTypeInput,
  findComputerAutomationFailureKind,
} from "./computerAutomation.ts";

const decodeClick = Schema.decodeUnknownSync(ComputerAutomationClickInput);
const decodeAccess = Schema.decodeUnknownSync(ComputerAutomationAccessInput);
const decodeKey = Schema.decodeUnknownSync(ComputerAutomationKeyInput);
const decodeActivate = Schema.decodeUnknownSync(ComputerAutomationActivateInput);
const decodeAct = Schema.decodeUnknownSync(ComputerAutomationActInput);
const decodeWheel = Schema.decodeUnknownSync(ComputerAutomationWheelInput);
const decodeHotkey = Schema.decodeUnknownSync(ComputerAutomationHotkeyInput);
const decodeFailure = Schema.decodeUnknownSync(ComputerAutomationFailure);
const decodeSnapshot = Schema.decodeUnknownSync(ComputerAutomationSnapshot);
const decodeSnapshotInput = Schema.decodeUnknownSync(ComputerAutomationSnapshotInput);
const decodeStatus = Schema.decodeUnknownSync(ComputerAutomationStatus);
const decodeTarget = Schema.decodeUnknownSync(ComputerAutomationTargetInput);
const decodeType = Schema.decodeUnknownSync(ComputerAutomationTypeInput);

describe("computer automation contracts", () => {
  it("selects user or independently managed agent desktops", () => {
    expect(decodeAccess({ desktop: { kind: "user" }, observation: false })).toEqual({
      desktop: { kind: "user" },
      observation: false,
    });
    expect(decodeAccess({ desktop: { kind: "agent" } })).toEqual({
      desktop: { kind: "agent" },
    });
    expect(decodeAccess({ desktop: { kind: "agent", desktopId: "desktop-1" } })).toEqual({
      desktop: { kind: "agent", desktopId: "desktop-1" },
    });
    expect(() => decodeAccess({ desktop: { kind: "agent", desktopId: "" } })).toThrow();
    expect(() =>
      decodeAccess({
        desktop: { kind: "agent", desktopId: "desktop-1", fresh: true },
      }),
    ).toThrow();
    expect(decodeTarget({ desktop: { kind: "agent", desktopId: "desktop-1" } })).toEqual({
      desktop: { kind: "agent", desktopId: "desktop-1" },
    });
    expect(() => decodeTarget({ desktop: { kind: "agent" } })).toThrow();
  });

  it("accepts display-relative coordinates and bounded click options", () => {
    expect(decodeClick({ frameId: "frame-1", x: 120.5, y: 80, button: "right", count: 2 })).toEqual(
      {
        frameId: "frame-1",
        x: 120.5,
        y: 80,
        button: "right",
        count: 2,
      },
    );

    expect(() => decodeClick({ frameId: "frame-1", x: -1, y: 80 })).toThrow();
    expect(() => decodeClick({ frameId: "frame-1", x: 120, y: 80, count: 4 })).toThrow();
  });

  it("requires a complete optional wheel target and at least one tick delta", () => {
    expect(decodeWheel({ deltaY: 3, unit: "ticks" })).toEqual({ deltaY: 3, unit: "ticks" });
    expect(decodeWheel({ frameId: "frame-1", x: 100, y: 200, deltaX: -10, deltaY: 50 })).toEqual({
      frameId: "frame-1",
      x: 100,
      y: 200,
      deltaX: -10,
      deltaY: 50,
    });

    expect(() => decodeWheel({ frameId: "frame-1", x: 100, deltaY: 50 })).toThrow();
    expect(() => decodeWheel({ deltaY: 0.5 })).toThrow();
    expect(() => decodeWheel({ deltaY: 101 })).toThrow();
    expect(() => decodeWheel({})).toThrow();
  });

  it("accepts ephemeral semantic targets and pointer feedback", () => {
    expect(decodeActivate({ targetId: "a11y-2-3" })).toEqual({ targetId: "a11y-2-3" });
    expect(() => decodeActivate({ targetId: "" })).toThrow();

    expect(
      decodeSnapshot({
        display: {
          id: "42",
          label: "Main display",
          primary: true,
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          scaleFactor: 1,
        },
        cursor: null,
        pointer: {
          frameId: "frame-1",
          position: { x: 120, y: 80 },
          source: "last-commanded",
        },
        frame: {
          id: "frame-1",
          displayId: "42",
          coordinateSpace: "image-pixels",
          width: 800,
          height: 600,
          toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
        },
        accessibility: {
          available: true,
          coordinateSpace: "focused-window",
          window: {
            application: "Calculator",
            name: "Calculator",
            size: { width: 400, height: 500 },
          },
          targets: [
            {
              id: "a11y-2-3",
              application: "Calculator",
              role: "push button",
              name: "Equals",
              bounds: { x: 100, y: 60, width: 80, height: 40 },
              activation: "action",
              enabled: true,
              focused: false,
              selected: false,
              checked: false,
              expanded: false,
            },
          ],
          truncated: false,
        },
        captureSource: "remote-desktop-stream",
        screenshot: {
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
          width: 800,
          height: 600,
        },
      }).pointer,
    ).toMatchObject({ source: "last-commanded" });
  });

  it("accepts semantic-only snapshots", () => {
    expect(
      decodeSnapshot({
        display: {
          id: "42",
          label: "Main display",
          primary: true,
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          scaleFactor: 1,
        },
        cursor: null,
        accessibility: {
          available: true,
          coordinateSpace: "focused-window",
          window: null,
          targets: [],
          truncated: false,
        },
        captureSource: "remote-desktop-stream",
      }).screenshot,
    ).toBeUndefined();
    expect(decodeSnapshotInput({ screenshot: false })).toEqual({
      screenshot: false,
    });
    expect(
      decodeSnapshotInput({
        desktop: { kind: "agent", desktopId: "desktop-1" },
        screenshot: false,
      }),
    ).toEqual({ desktop: { kind: "agent", desktopId: "desktop-1" }, screenshot: false });
    expect(() => decodeSnapshotInput({ includeAccessibility: false, screenshot: false })).toThrow();
    expect(
      decodeSnapshotInput({
        screenshot: {
          region: { frameId: "frame-1", x: 10, y: 20, width: 100, height: 80 },
          maxWidth: 1_200,
          maxHeight: 900,
        },
        includeAccessibility: false,
        delayMs: 50,
      }),
    ).toMatchObject({ screenshot: { maxWidth: 1_200 }, delayMs: 50 });
    expect(() =>
      decodeSnapshotInput({
        displayId: "42",
        screenshot: { region: { frameId: "frame-1", x: 0, y: 0, width: 10, height: 10 } },
      }),
    ).toThrow();
  });

  it("represents an unsupported host without inventing a backend", () => {
    expect(
      decodeStatus({
        available: false,
        backend: null,
        permission: "unavailable",
        rememberedAccess: [],
        displayState: "unknown",
        keepAwake: false,
        displays: [],
        cursor: null,
        detail: "GNOME Wayland is required",
      }),
    ).toMatchObject({ available: false, backend: null, permission: "unavailable" });
  });

  it("represents control authorization that is waiting for the native prompt", () => {
    expect(
      decodeStatus({
        available: true,
        backend: "gnome-wayland-portal",
        permission: "pending",
        rememberedAccess: [],
        displayState: "active",
        keepAwake: false,
        displays: [],
        cursor: null,
      }),
    ).toMatchObject({ available: true, permission: "pending" });
  });

  it("represents remembered consent without claiming a session is active", () => {
    expect(
      decodeStatus({
        available: true,
        backend: "gnome-wayland-portal",
        permission: "remembered",
        rememberedAccess: ["view", "control"],
        displayState: "active",
        keepAwake: false,
        displays: [],
        cursor: null,
      }),
    ).toMatchObject({ available: true, permission: "remembered" });
  });

  it("represents an active view-only session", () => {
    expect(
      decodeStatus({
        available: true,
        backend: "gnome-wayland-portal",
        permission: "view-only",
        rememberedAccess: ["view"],
        displayState: "active",
        keepAwake: true,
        displays: [],
        cursor: null,
      }),
    ).toMatchObject({ available: true, permission: "view-only" });
  });

  it("reports a locked display separately from its keep-awake lease", () => {
    expect(
      decodeStatus({
        available: true,
        backend: "gnome-wayland-portal",
        permission: "remembered",
        rememberedAccess: ["control"],
        displayState: "locked",
        keepAwake: false,
        displays: [],
        cursor: null,
      }),
    ).toMatchObject({ displayState: "locked", keepAwake: false });
  });

  it("finds only bounded public failure kinds in an error chain", () => {
    expect(
      findComputerAutomationFailureKind({
        cause: { code: "display-locked", cause: "private lock diagnostic" },
      }),
    ).toBe("display-locked");
    expect(findComputerAutomationFailureKind({ code: "permission-denied" })).toBeUndefined();
    expect(
      findComputerAutomationFailureKind({
        cause: { cause: { cause: { cause: { code: "display-inactive" } } } },
      }),
    ).toBeUndefined();
  });

  it("bounds the total requested typing delay", () => {
    expect(decodeType({ text: "hello", intervalMs: 100, submit: true })).toEqual({
      text: "hello",
      intervalMs: 100,
      submit: true,
    });
    expect(() => decodeType({ text: "x".repeat(1_000), intervalMs: 100 })).toThrow();
    expect(decodeType({ text: "That’s exact → and ASCII ->" })).toEqual({
      text: "That’s exact → and ASCII ->",
    });
    expect(() => decodeType({ text: "’\n".repeat(601) })).toThrow();
  });

  it("accepts bounded action batches and protects semantic target lifetime", () => {
    expect(
      decodeAct({
        desktop: { kind: "agent", desktopId: "desktop-1" },
        actions: [
          { type: "press", key: "Meta" },
          { type: "type", text: "Calculator", submit: true },
          { type: "wait", durationMs: 500 },
        ],
      }),
    ).toEqual({
      desktop: { kind: "agent", desktopId: "desktop-1" },
      actions: [
        { type: "press", key: "Meta" },
        { type: "type", text: "Calculator", submit: true },
        { type: "wait", durationMs: 500 },
      ],
    });
    expect(() => decodeAct({ actions: [] })).toThrow();
    expect(() =>
      decodeAct({
        actions: [
          { type: "press", key: "Tab" },
          { type: "activate", targetId: "a11y-1-1" },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeAct({
        actions: [
          { type: "activate", targetId: "a11y-1-1" },
          { type: "activate", targetId: "a11y-1-2" },
        ],
      }),
    ).toThrow();
    expect(() => decodeAct({ actions: [{ type: "wait", durationMs: 5_001 }] })).toThrow();
    expect(() =>
      decodeAct({ actions: [{ type: "wheel", frameId: "frame-1", x: 100, deltaY: 3 }] }),
    ).toThrow();
    expect(() => decodeAct({ actions: [{ type: "wheel" }] })).toThrow();
    expect(() =>
      decodeAct({
        actions: Array.from({ length: 33 }, () => ({ type: "press" as const, key: "Tab" })),
      }),
    ).toThrow();
    expect(() =>
      decodeAct({ actions: [{ type: "type", text: "x".repeat(1_000), intervalMs: 100 }] }),
    ).toThrow();
  });

  it("accepts named modifiers for held-key transitions", () => {
    expect(decodeKey({ key: "Alt" })).toEqual({ key: "Alt" });
    expect(decodeKey({ key: "Tab" })).toEqual({ key: "Tab" });
    expect(() => decodeKey({ key: "" })).toThrow();
  });

  it("accepts explicit key chords and structured execution failures", () => {
    expect(decodeHotkey({ keys: ["CTRL", "Shift", "N"] })).toEqual({
      keys: ["CTRL", "Shift", "N"],
    });
    expect(() => decodeHotkey({ keys: ["Control"] })).toThrow();
    expect(
      decodeFailure({
        code: "invalid-key-name",
        category: "invalid-input",
        message: "The key is unsupported.",
        actionIndex: 0,
        completedActionCount: 0,
        field: "actions[0].keys[0]",
        received: "CTRL+NOPE",
        expected: ["named key", "single printable ASCII character"],
        phase: "validation",
        cleanup: { keys: "released", buttons: "not-needed" },
      }),
    ).toMatchObject({ code: "invalid-key-name", actionIndex: 0 });
    expect(
      decodeFailure({
        code: "semantic-activation-failed",
        category: "input-injection",
        message: "The application rejected semantic activation.",
        field: "actions[0].targetId",
        received: "a11y-1-1",
        phase: "execution",
      }),
    ).toMatchObject({ code: "semantic-activation-failed", phase: "execution" });
  });
});

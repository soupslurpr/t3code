import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { Display } from "electron";
import { vi } from "vite-plus/test";

const { nativeImage, screen } = vi.hoisted(() => ({
  nativeImage: { createFromBuffer: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(),
    getPrimaryDisplay: vi.fn(),
  },
}));

vi.mock("electron", () => ({ nativeImage, screen }));

import * as GnomeRemoteDesktop from "./GnomeRemoteDesktop.ts";
import * as ComputerUse from "./ComputerUse.ts";

const display = {
  id: 7,
  label: "Main display",
  bounds: { x: -100, y: 50, width: 800, height: 600 },
  scaleFactor: 1.25,
} as unknown as Display;

interface InputRecord {
  readonly operation: string;
  readonly input?: unknown;
}

const accessibleTarget: GnomeRemoteDesktop.GnomeRemoteDesktopAccessibilityTarget = {
  id: "a11y-1-1",
  application: "Calculator",
  role: "push button",
  name: "Equals",
  bounds: { x: 200, y: 100, width: 100, height: 100 },
  activation: "action",
  enabled: true,
  focused: false,
  selected: false,
  checked: false,
  expanded: false,
};

/** Creates an in-memory portal controller while retaining its call order. */
function makeController(records: Array<InputRecord>, onStart: () => void = () => {}) {
  const record = (operation: string, input?: unknown) =>
    Effect.sync(() => {
      records.push({ operation, ...(input === undefined ? {} : { input }) });
    });
  return GnomeRemoteDesktop.GnomeRemoteDesktop.of({
    status: Effect.succeed({
      available: true,
      permission: "prompt-required",
      rememberedAccess: [],
      displayState: "active",
      keepAwake: false,
    }),
    snapshot: (input) =>
      record("snapshot", input).pipe(
        Effect.as({
          data: new Uint8Array([137, 80, 78, 71]),
          source: "remote-desktop-stream" as const,
        }),
      ),
    view: record("view"),
    start: Effect.sync(() => {
      records.push({ operation: "start" });
      onStart();
    }),
    configurePowerProtection: (enabled) => record("configurePowerProtection", enabled),
    setAgentWorking: (active) => record("setAgentWorking", active),
    requestAvailability: record("requestAvailability"),
    releaseAvailability: record("releaseAvailability"),
    move: (input) => record("move", input),
    click: (input) => record("click", input),
    activate: (input) => record("activate", input).pipe(Effect.as({ target: accessibleTarget })),
    activateWindow: (input) => record("activateWindow", input),
    drag: (input) => record("drag", input),
    wheel: (input) => record("wheel", input),
    type: (input) =>
      record("type", input).pipe(
        Effect.as({
          requestedCodePoints: Array.from(input.text).length,
          injectedCodePoints: Array.from(input.text).length,
          delivery: "key-events" as const,
          focusedEditable: false,
        }),
      ),
    press: (input) => record("press", input),
    hotkey: (input) => record("hotkey", input),
    keyDown: (input) => record("keyDown", input),
    keyUp: (input) => record("keyUp", input),
    releaseInputs: record("releaseInputs"),
    stop: record("stop"),
    forget: record("forget"),
  });
}

/** Creates the Electron calls used by the pure computer-use service. */
function makePlatform(
  options: {
    readonly decode?: ComputerUse.ComputerUsePlatform["decodePng"];
    readonly encode?: ComputerUse.ComputerUsePlatform["encodePng"];
    readonly displays?: ReadonlyArray<Display>;
  } = {},
): ComputerUse.ComputerUsePlatform {
  const displays = options.displays ?? [display];
  return {
    getDisplays: () => displays,
    getPrimaryDisplay: () => display,
    decodePng: options.decode ?? (() => makeImage(800, 600)),
    encodePng: options.encode ?? ((image) => image.toPNG()),
  };
}

/** Creates one in-memory image with deterministic encoded bytes. */
function makeImage(width: number, height: number): ComputerUse.ComputerUseImage {
  const image: ComputerUse.ComputerUseImage = {
    isEmpty: () => false,
    crop: (rectangle) => makeImage(rectangle.width, rectangle.height),
    resize: (options) => makeImage(options.width, options.height),
    getSize: () => ({ width, height }),
    toBitmap: () => new Uint8Array(width * height * 4),
    toPNG: () => new Uint8Array([1, 2, 3]),
  };
  return image;
}

/** Captures one frame for subsequent frame-relative pointer actions. */
const captureFrame = (computer: ComputerUse.ComputerUseShape) =>
  computer.snapshot({ displayId: "7", includeAccessibility: false }).pipe(
    Effect.map((snapshot) => {
      if (snapshot.frame === undefined) throw new Error("test snapshot did not return a frame");
      return snapshot.frame;
    }),
  );

describe("ComputerUse", () => {
  it.effect("controls desktop availability without opening access", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const controller = makeController(records);
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), controller);

      yield* computer.requestAvailability;
      yield* computer.releaseAvailability;

      assert.deepEqual(records, [
        { operation: "requestAvailability" },
        { operation: "releaseAvailability" },
      ]);
    }),
  );

  it.effect("reports logical displays and the controller permission state", () =>
    Effect.gen(function* () {
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController([]));

      const status = yield* computer.status;

      assert.isTrue(status.available);
      assert.equal(status.backend, "gnome-wayland-portal");
      assert.equal(status.permission, "prompt-required");
      assert.deepEqual(status.rememberedAccess, []);
      assert.equal(status.displayState, "active");
      assert.isFalse(status.keepAwake);
      assert.isNull(status.cursor);
      assert.deepEqual(status.displays[0], {
        id: "7",
        label: "Main display",
        primary: true,
        bounds: { x: -100, y: 50, width: 800, height: 600 },
        scaleFactor: 1.25,
      });
    }),
  );

  it.effect("normalizes portal captures while control is granted", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      let resizeInput: unknown;
      const resizedImage: ComputerUse.ComputerUseImage = {
        isEmpty: () => false,
        crop: () => resizedImage,
        resize: () => resizedImage,
        getSize: () => ({ width: 800, height: 600 }),
        toBitmap: () => new Uint8Array(800 * 600 * 4),
        toPNG: () => new Uint8Array([1, 2, 3]),
      };
      const sourceImage: ComputerUse.ComputerUseImage = {
        isEmpty: () => false,
        crop: () => {
          throw new Error("single-display captures should not be cropped");
        },
        resize: (input) => {
          resizeInput = input;
          return resizedImage;
        },
        getSize: () => ({ width: 1_000, height: 750 }),
        toBitmap: () => new Uint8Array(1_000 * 750 * 4),
        toPNG: () => new Uint8Array(),
      };
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController(records),
        status: Effect.succeed({
          available: true,
          permission: "granted",
          rememberedAccess: ["control"],
          displayState: "active",
          keepAwake: true,
        }),
      });
      const computer = yield* ComputerUse.makeWithOptions(
        makePlatform({
          decode: (data) => {
            assert.deepEqual(data, new Uint8Array([137, 80, 78, 71]));
            return sourceImage;
          },
        }),
        controller,
      );

      const snapshot = yield* computer.snapshot({ displayId: "7" });
      const screenshot = snapshot.screenshot;

      assert.deepEqual(resizeInput, { width: 800, height: 600, quality: "best" });
      assert.equal(snapshot.captureSource, "remote-desktop-stream");
      assert.isNull(snapshot.cursor);
      assert.isDefined(screenshot);
      assert.equal(screenshot.width, 800);
      assert.equal(screenshot.height, 600);
      assert.equal(screenshot.data, Buffer.from([1, 2, 3]).toString("base64"));
      assert.deepEqual(records, [
        {
          operation: "snapshot",
          input: {
            includeAccessibility: true,
            displayBounds: display.bounds,
          },
        },
      ]);
    }),
  );

  it.effect("downscales large captures and maps their pointer coordinates", () =>
    Effect.gen(function* () {
      const largeDisplay = {
        ...display,
        bounds: { x: -100, y: 50, width: 1920, height: 1080 },
      } as unknown as Display;
      const records: Array<InputRecord> = [];
      let resizeInput: unknown;
      let encodedPointer: { readonly x: number; readonly y: number } | null = null;
      const image: ComputerUse.ComputerUseImage = {
        isEmpty: () => false,
        crop: () => image,
        resize: (input) => {
          resizeInput = input;
          return image;
        },
        getSize: () => ({ width: 1600, height: 900 }),
        toBitmap: () => new Uint8Array(1600 * 900 * 4),
        toPNG: () => new Uint8Array([1]),
      };
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController(records),
        status: Effect.succeed({
          available: true,
          permission: "granted",
          rememberedAccess: ["control"],
          displayState: "active",
          keepAwake: true,
        }),
      });
      const computer = yield* ComputerUse.makeWithOptions(
        makePlatform({
          displays: [largeDisplay],
          decode: () => image,
          encode: (_image, pointer) => {
            encodedPointer = pointer;
            return new Uint8Array([2]);
          },
        }),
        controller,
      );

      const sourceFrame = yield* captureFrame(computer);
      records.length = 0;
      yield* computer.act({
        actions: [{ type: "move", frameId: sourceFrame.id, x: 800, y: 450, settleMs: 0 }],
      });
      const snapshot = yield* computer.snapshot({ displayId: "7" });

      assert.isUndefined(resizeInput);
      assert.deepEqual(records.slice(0, 2), [
        { operation: "start" },
        { operation: "move", input: { x: 860, y: 590, durationMs: 0 } },
      ]);
      assert.deepEqual(snapshot.pointer?.position, { x: 800, y: 450 });
      assert.deepEqual(encodedPointer, { x: 800, y: 450 });
      assert.equal(snapshot.screenshot?.width, 1600);
      assert.equal(snapshot.screenshot?.height, 900);
    }),
  );

  it.effect("returns a high-resolution crop with an explicit frame transform", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      let cropInput: unknown;
      let resizeInput: unknown;
      const croppedImage: ComputerUse.ComputerUseImage = {
        isEmpty: () => false,
        crop: () => croppedImage,
        resize: (input) => {
          resizeInput = input;
          return makeImage(input.width, input.height);
        },
        getSize: () => ({ width: 800, height: 600 }),
        toBitmap: () => new Uint8Array(800 * 600 * 4),
        toPNG: () => new Uint8Array([1]),
      };
      const sourceImage: ComputerUse.ComputerUseImage = {
        isEmpty: () => false,
        crop: (input) => {
          cropInput = input;
          return croppedImage;
        },
        resize: (input) => makeImage(input.width, input.height),
        getSize: () => ({ width: 1_600, height: 1_200 }),
        toBitmap: () => new Uint8Array(1_600 * 1_200 * 4),
        toPNG: () => new Uint8Array([1]),
      };
      const computer = yield* ComputerUse.makeWithOptions(
        makePlatform({ decode: () => sourceImage }),
        makeController(records),
      );
      const overview = yield* computer.snapshot({ displayId: "7" });
      if (overview.frame === undefined) throw new Error("overview did not return a frame");

      const detail = yield* computer.snapshot({
        includeAccessibility: false,
        screenshot: {
          region: {
            frameId: overview.frame.id,
            x: 100,
            y: 150,
            width: 400,
            height: 300,
          },
          maxWidth: 800,
          maxHeight: 600,
        },
      });

      assert.deepEqual(cropInput, { x: 200, y: 300, width: 800, height: 600 });
      assert.isUndefined(resizeInput);
      assert.deepEqual(detail.frame, {
        id: "frame-2",
        displayId: "7",
        coordinateSpace: "image-pixels",
        width: 800,
        height: 600,
        toDesktopLogical: {
          scaleX: 0.5,
          scaleY: 0.5,
          offsetX: 0,
          offsetY: 200,
        },
      });

      records.length = 0;
      yield* computer.act({
        actions: [{ type: "click", frameId: detail.frame!.id, x: 400, y: 300 }],
      });
      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "move", input: { x: 200, y: 350, durationMs: 0 } },
        { operation: "click", input: { button: "left", count: 1 } },
      ]);
    }),
  );

  it.effect("captures a durable desktop-logical region without a source frame", () =>
    Effect.gen(function* () {
      let cropInput: unknown;
      const sourceImage: ComputerUse.ComputerUseImage = {
        isEmpty: () => false,
        crop: (input) => {
          cropInput = input;
          return makeImage(input.width, input.height);
        },
        resize: (input) => makeImage(input.width, input.height),
        getSize: () => ({ width: 1_600, height: 1_200 }),
        toBitmap: () => new Uint8Array(1_600 * 1_200 * 4),
        toPNG: () => new Uint8Array([1]),
      };
      const computer = yield* ComputerUse.makeWithOptions(
        makePlatform({ decode: () => sourceImage }),
        makeController([]),
      );

      const snapshot = yield* computer.snapshot({
        includeAccessibility: false,
        screenshot: {
          region: {
            coordinateSpace: "desktop-logical",
            displayId: "7",
            x: 0,
            y: 100,
            width: 400,
            height: 300,
          },
          maxWidth: 800,
          maxHeight: 600,
        },
      });

      assert.deepEqual(cropInput, { x: 200, y: 100, width: 800, height: 600 });
      assert.deepInclude(snapshot.frame, {
        displayId: "7",
        width: 800,
        height: 600,
        toDesktopLogical: {
          scaleX: 0.5,
          scaleY: 0.5,
          offsetX: 0,
          offsetY: 100,
        },
      });
    }),
  );

  it.effect("reports the exact invalid crop field", () =>
    Effect.gen(function* () {
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController([]));
      const frame = yield* captureFrame(computer);

      const error = yield* computer
        .snapshot({
          includeAccessibility: false,
          screenshot: {
            region: { frameId: frame.id, x: 799, y: 0, width: 2, height: 10 },
          },
        })
        .pipe(Effect.flip);

      assert.deepEqual(ComputerUse.toComputerAutomationFailure(error), {
        code: "invalid-coordinate",
        category: "invalid-input",
        message: "The requested point or region is outside its referenced frame.",
        field: "screenshot.region.width",
        received: "2",
        expected: ["integer from 1 through 1"],
        phase: "validation",
      });
    }),
  );

  it.effect("rejects frames after control is released", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));
      const frame = yield* captureFrame(computer);
      yield* computer.release;
      const replacementFrame = yield* captureFrame(computer);
      assert.notEqual(replacementFrame.id, frame.id);
      records.length = 0;

      const error = yield* computer
        .act({ actions: [{ type: "click", frameId: frame.id, x: 10, y: 10 }] })
        .pipe(Effect.flip);

      assert.instanceOf(error, ComputerUse.ComputerUseActionError);
      assert.deepEqual(ComputerUse.toComputerAutomationFailure(error), {
        code: "stale-frame",
        category: "stale-target",
        message: "The referenced screenshot frame is stale; capture a new observation.",
        actionIndex: 0,
        completedActionCount: 0,
        field: "actions[0].frameId",
        received: frame.id,
        phase: "validation",
        cleanup: { keys: "not-needed", buttons: "not-needed" },
      });
      assert.deepEqual(records, []);
    }),
  );

  it.effect("runs ordered actions under one control lease", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      const resultFiber = yield* computer
        .act({
          actions: [
            { type: "press", key: "Meta" },
            { type: "type", text: "Calculator", intervalMs: 20, submit: true },
            { type: "wait", durationMs: 500 },
          ],
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(resultFiber);

      assert.deepEqual(results, [
        { index: 0, type: "press" },
        {
          index: 1,
          type: "type",
          requestedCodePoints: 10,
          injectedCodePoints: 10,
          delivery: "key-events",
          focusedEditable: false,
        },
        { index: 2, type: "wait" },
      ]);

      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "press", input: { key: "Meta", modifiers: [] } },
        { operation: "type", input: { text: "Calculator", intervalMs: 20 } },
        { operation: "press", input: { key: "Enter", modifiers: [] } },
      ]);
    }),
  );

  it.effect("forwards mixed Unicode through one exact text action", () =>
    Effect.gen(function* () {
      const inputRecords: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(
        makePlatform(),
        makeController(inputRecords),
      );
      const resultsFiber = yield* computer
        .act({ actions: [{ type: "type", text: "That’s right →\nASCII -> done" }] })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("250 millis");
      const results = yield* Fiber.join(resultsFiber);

      assert.deepInclude(results[0], {
        index: 0,
        type: "type",
        requestedCodePoints: Array.from("That’s right →\nASCII -> done").length,
        delivery: "key-events",
      });

      assert.deepEqual(inputRecords, [
        { operation: "start" },
        {
          operation: "type",
          input: { text: "That’s right →\nASCII -> done", intervalMs: 0 },
        },
      ]);
    }),
  );

  it.effect("reports a text input-injection failure with its field and cleanup", () =>
    Effect.gen(function* () {
      const helperError = new GnomeRemoteDesktop.GnomeRemoteDesktopCommandError({
        operation: "type",
        code: "portal-error",
        field: "text",
        phase: "key-press",
        cleanup: { keys: "released", buttons: "not-needed" },
        cause: "private portal diagnostic",
      });
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController([]),
        type: () => Effect.fail(helperError),
      });
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), controller);

      const error = yield* computer
        .act({ actions: [{ type: "type", text: "curly ’ and arrow →" }] })
        .pipe(Effect.flip);

      assert.deepInclude(ComputerUse.toComputerAutomationFailure(error), {
        code: "input-injection-failed",
        actionIndex: 0,
        completedActionCount: 0,
        field: "actions[0].text",
        phase: "key-press",
        cleanup: { keys: "released", buttons: "not-needed" },
      });
    }),
  );

  it.effect("forwards atomic hotkeys and discrete wheel ticks", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));
      const frame = yield* captureFrame(computer);
      records.length = 0;

      yield* computer.act({
        actions: [
          { type: "hotkey", keys: ["CTRL", "Shift", "N"] },
          { type: "wheel", frameId: frame.id, x: 200, y: 100, deltaY: 3, unit: "ticks" },
        ],
      });

      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "hotkey", input: { keys: ["CTRL", "Shift", "N"] } },
        { operation: "move", input: { x: 100, y: 150, durationMs: 0 } },
        { operation: "wheel", input: { deltaX: 0, deltaY: 3 } },
      ]);
    }),
  );

  it.effect("identifies a drag failure while moving to its start point", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const helperError = new GnomeRemoteDesktop.GnomeRemoteDesktopCommandError({
        operation: "move",
        code: "portal-error",
        phase: "pointer-move",
        cleanup: { keys: "not-needed", buttons: "not-needed" },
        cause: "private portal diagnostic",
      });
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController(records),
        move: (input) =>
          Effect.sync(() => records.push({ operation: "move", input })).pipe(
            Effect.andThen(Effect.fail(helperError)),
          ),
      });
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), controller);
      const frame = yield* captureFrame(computer);
      records.length = 0;

      const error = yield* computer
        .act({
          actions: [
            {
              type: "drag",
              frameId: frame.id,
              startX: 100,
              startY: 100,
              endX: 200,
              endY: 200,
            },
          ],
        })
        .pipe(Effect.flip);

      assert.deepInclude(ComputerUse.toComputerAutomationFailure(error), {
        code: "input-injection-failed",
        actionIndex: 0,
        completedActionCount: 0,
        phase: "move-to-start",
        cleanup: { keys: "not-needed", buttons: "not-needed" },
      });
    }),
  );

  it.effect("reports completed actions and bounded helper diagnostics", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const helperError = new GnomeRemoteDesktop.GnomeRemoteDesktopCommandError({
        operation: "hotkey",
        code: "unsupported-key",
        field: "keys[1]",
        received: "NOPE",
        expected: ["named key", "single printable ASCII character"],
        phase: "key-press",
        cleanup: { keys: "released", buttons: "not-needed" },
        cause: "private portal diagnostic",
      });
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController(records),
        hotkey: (input) =>
          Effect.sync(() => records.push({ operation: "hotkey", input })).pipe(
            Effect.andThen(Effect.fail(helperError)),
          ),
      });
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), controller);

      const error = yield* computer
        .act({
          actions: [
            { type: "press", key: "Meta" },
            { type: "hotkey", keys: ["Control", "NOPE"] },
          ],
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ComputerUse.ComputerUseActionError);
      assert.deepEqual(ComputerUse.toComputerAutomationFailure(error), {
        code: "invalid-key-name",
        category: "invalid-input",
        message: "The action contains an unsupported or duplicate key name.",
        actionIndex: 1,
        completedActionCount: 1,
        field: "actions[1].keys[1]",
        received: "NOPE",
        expected: ["named key", "single printable ASCII character"],
        phase: "key-press",
        cleanup: { keys: "released", buttons: "not-needed" },
      });
      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "press", input: { key: "Meta", modifiers: [] } },
        { operation: "hotkey", input: { keys: ["Control", "NOPE"] } },
      ]);
    }),
  );

  it.effect("returns semantic targets without decoding an omitted screenshot", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController(records),
        snapshot: (input) =>
          Effect.sync(() => records.push({ operation: "snapshot", input })).pipe(
            Effect.as({
              data: new Uint8Array([137, 80, 78, 71]),
              source: "remote-desktop-stream" as const,
              accessibility: {
                available: true,
                coordinateSpace: "focused-window" as const,
                window: null,
                windows: [],
                targets: [],
                truncated: false,
              },
            }),
          ),
      });
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), controller);

      const snapshot = yield* computer.snapshot({
        displayId: "7",
        screenshot: false,
      });

      assert.isUndefined(snapshot.screenshot);
      assert.isTrue(snapshot.accessibility?.available);
      assert.deepEqual(records, [
        {
          operation: "snapshot",
          input: {
            includeAccessibility: true,
            displayBounds: display.bounds,
          },
        },
      ]);
    }),
  );

  it.effect("does not crop a selected monitor stream on a multi-display desktop", () =>
    Effect.gen(function* () {
      let cropInput: unknown;
      const resizedImage: ComputerUse.ComputerUseImage = {
        isEmpty: () => false,
        crop: () => resizedImage,
        resize: () => resizedImage,
        getSize: () => ({ width: 800, height: 600 }),
        toBitmap: () => new Uint8Array(800 * 600 * 4),
        toPNG: () => new Uint8Array([1]),
      };
      const sourceImage: ComputerUse.ComputerUseImage = {
        isEmpty: () => false,
        crop: (input) => {
          cropInput = input;
          return sourceImage;
        },
        resize: () => sourceImage,
        getSize: () => ({ width: 800, height: 600 }),
        toBitmap: () => new Uint8Array(800 * 600 * 4),
        toPNG: () => new Uint8Array(),
      };
      const leftDisplay = {
        ...display,
        id: 8,
        label: "Left display",
        bounds: { x: -900, y: 50, width: 800, height: 600 },
      } as unknown as Display;
      const records: Array<InputRecord> = [];
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController(records),
        snapshot: (input) =>
          Effect.sync(() => records.push({ operation: "snapshot", input })).pipe(
            Effect.as({
              data: new Uint8Array([137, 80, 78, 71]),
              source: "remote-desktop-stream" as const,
              accessibility: {
                available: true,
                coordinateSpace: "focused-window" as const,
                window: null,
                windows: [
                  {
                    id: "window-1-1",
                    application: "Calculator",
                    name: "Calculator",
                    focused: true,
                  },
                ],
                targets: [],
                truncated: false,
              },
            }),
          ),
      });
      const computer = yield* ComputerUse.makeWithOptions(
        makePlatform({ displays: [leftDisplay, display], decode: () => sourceImage }),
        controller,
      );

      const snapshot = yield* computer.snapshot({ displayId: "7" });

      assert.isUndefined(cropInput);
      assert.isTrue(snapshot.accessibility?.available);
      assert.equal(snapshot.accessibility?.windows[0]?.id, "window-1-1");
      assert.deepEqual(snapshot.accessibility?.targets, []);
      assert.deepEqual(records, [
        {
          operation: "snapshot",
          input: {
            includeAccessibility: true,
            includeAccessibilityTargets: false,
            displayBounds: display.bounds,
          },
        },
      ]);
    }),
  );

  it.effect("does not capture on an unsupported desktop", () =>
    Effect.gen(function* () {
      const capture = vi.fn(() => new Uint8Array());
      const decode = vi.fn();
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController([]),
        snapshot: () =>
          Effect.sync(capture).pipe(
            Effect.map((data) => ({ data, source: "remote-desktop-stream" as const })),
          ),
        status: Effect.succeed({
          available: false,
          permission: "unavailable",
          rememberedAccess: [],
          displayState: "unknown",
          keepAwake: false,
          detail: "GNOME Wayland is required",
        }),
      });
      const computer = yield* ComputerUse.makeWithOptions(makePlatform({ decode }), controller);

      const error = yield* computer.snapshot({}).pipe(Effect.flip);

      assert.instanceOf(error, ComputerUse.ComputerUseOperationError);
      assert.strictEqual(capture.mock.calls.length, 0);
      assert.strictEqual(decode.mock.calls.length, 0);
    }),
  );

  it.effect("uses compositor coordinates for batched clicking", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      const frame = yield* captureFrame(computer);
      records.length = 0;
      yield* computer.act({
        actions: [{ type: "click", frameId: frame.id, x: 350, y: 100 }],
      });

      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "move", input: { x: 250, y: 150, durationMs: 0 } },
        { operation: "click", input: { button: "left", count: 1 } },
      ]);
    }),
  );

  it.effect("runs a right-button drag with explicit movement steps", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));
      const frame = yield* captureFrame(computer);
      records.length = 0;

      yield* computer.act({
        actions: [
          {
            type: "drag",
            frameId: frame.id,
            startX: 100,
            startY: 100,
            endX: 500,
            endY: 400,
            button: "right",
            durationMs: 800,
            steps: 40,
          },
        ],
      });

      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "move", input: { x: 0, y: 150, durationMs: 0 } },
        {
          operation: "drag",
          input: { button: "right", x: 400, y: 450, durationMs: 800, steps: 40 },
        },
      ]);
    }),
  );

  it.effect("moves without clicking and marks the settled pointer", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      let encodedPointer: { readonly x: number; readonly y: number } | null = null;
      const image: ComputerUse.ComputerUseImage = {
        isEmpty: () => false,
        crop: () => image,
        resize: () => image,
        getSize: () => ({ width: 800, height: 600 }),
        toBitmap: () => new Uint8Array(800 * 600 * 4),
        toPNG: () => new Uint8Array([1]),
      };
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController(records),
        status: Effect.succeed({
          available: true,
          permission: "granted",
          rememberedAccess: ["control"],
          displayState: "active",
          keepAwake: true,
        }),
        snapshot: (input) =>
          Effect.sync(() => records.push({ operation: "snapshot", input })).pipe(
            Effect.as({
              data: new Uint8Array([137, 80, 78, 71]),
              source: "remote-desktop-stream" as const,
              accessibility: {
                available: true,
                coordinateSpace: "focused-window",
                window: {
                  application: "Calculator",
                  name: "Calculator",
                  size: { width: 400, height: 500 },
                },
                windows: [
                  {
                    id: "window-1-1",
                    application: "Calculator",
                    name: "Calculator",
                    focused: true,
                  },
                ],
                targets: [accessibleTarget],
                truncated: false,
              },
            }),
          ),
      });
      const computer = yield* ComputerUse.makeWithOptions(
        makePlatform({
          decode: () => image,
          encode: (_image, pointer) => {
            encodedPointer = pointer;
            return new Uint8Array([2]);
          },
        }),
        controller,
      );

      const frame = yield* captureFrame(computer);
      records.length = 0;
      yield* computer.act({
        actions: [{ type: "move", frameId: frame.id, x: 350, y: 100, settleMs: 0 }],
      });
      const snapshot = yield* computer.snapshot({ displayId: "7" });

      assert.deepEqual(snapshot.pointer, {
        frameId: snapshot.frame?.id,
        position: { x: 350, y: 100 },
        source: "last-commanded",
      });
      assert.equal(snapshot.captureSource, "remote-desktop-stream");
      assert.deepEqual(snapshot.accessibility?.targets[0]?.bounds, {
        x: 200,
        y: 100,
        width: 100,
        height: 100,
      });
      assert.deepEqual(encodedPointer, { x: 350, y: 100 });
      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "move", input: { x: 250, y: 150, durationMs: 0 } },
        {
          operation: "snapshot",
          input: {
            includeAccessibility: true,
            displayBounds: display.bounds,
          },
        },
      ]);
    }),
  );

  it.effect("waits for a bounded image region to change", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      let decodeCount = 0;
      const imageWithByte = (
        width: number,
        height: number,
        byte: number,
      ): ComputerUse.ComputerUseImage => ({
        isEmpty: () => false,
        crop: (rectangle) => imageWithByte(rectangle.width, rectangle.height, byte),
        resize: (options) => imageWithByte(options.width, options.height, byte),
        getSize: () => ({ width, height }),
        toBitmap: () => new Uint8Array(width * height * 4).fill(byte),
        toPNG: () => new Uint8Array([byte]),
      });
      const computer = yield* ComputerUse.makeWithOptions(
        makePlatform({
          decode: () => {
            decodeCount += 1;
            return imageWithByte(800, 600, decodeCount >= 3 ? 1 : 0);
          },
        }),
        makeController(records),
      );
      const frame = yield* captureFrame(computer);
      records.length = 0;

      const resultFiber = yield* computer
        .act({
          actions: [
            {
              type: "wait_for_change",
              frameId: frame.id,
              x: 100,
              y: 100,
              width: 200,
              height: 100,
              timeoutMs: 1_000,
              pollIntervalMs: 100,
            },
          ],
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("100 millis");

      assert.deepEqual(yield* Fiber.join(resultFiber), [
        {
          index: 0,
          type: "wait_for_change",
          changed: true,
          elapsedMs: 100,
          samples: 2,
        },
      ]);
      assert.deepEqual(records, [
        { operation: "start" },
        {
          operation: "snapshot",
          input: { includeAccessibility: false, displayBounds: display.bounds },
        },
        {
          operation: "snapshot",
          input: { includeAccessibility: false, displayBounds: display.bounds },
        },
      ]);
    }),
  );

  it.effect("rechecks and activates a semantic target in a batch", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      yield* computer.act({
        actions: [{ type: "activate", targetId: "a11y-1-1" }],
      });
      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "activate", input: { targetId: "a11y-1-1" } },
      ]);
    }),
  );

  it.effect("activates a top-level semantic window in a batch", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      const results = yield* computer.act({
        actions: [{ type: "activate_window", windowId: "window-1-1" }],
      });
      assert.deepEqual(results, [{ index: 0, type: "activate_window" }]);
      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "activateWindow", input: { windowId: "window-1-1" } },
      ]);
    }),
  );

  it.effect("rejects out-of-bounds coordinates before requesting control", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      const frame = yield* captureFrame(computer);
      records.length = 0;
      const error = yield* computer
        .act({ actions: [{ type: "click", frameId: frame.id, x: 800, y: 0 }] })
        .pipe(Effect.flip);

      assert.instanceOf(error, ComputerUse.ComputerUseActionError);
      assert.instanceOf(error.cause, ComputerUse.ComputerUseCoordinateOutOfBoundsError);
      assert.deepEqual(ComputerUse.toComputerAutomationFailure(error), {
        code: "invalid-coordinate",
        category: "invalid-input",
        message: "The requested point or region is outside its referenced frame.",
        actionIndex: 0,
        completedActionCount: 0,
        field: "actions[0].x",
        received: "800",
        expected: ["number from 0 through 799"],
        phase: "validation",
        cleanup: { keys: "not-needed", buttons: "not-needed" },
      });
      assert.deepEqual(records, []);
    }),
  );

  it.effect("validates every coordinate before sending any batched input", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      const frame = yield* captureFrame(computer);
      records.length = 0;
      const error = yield* computer
        .act({
          actions: [
            { type: "press", key: "Meta" },
            { type: "click", frameId: frame.id, x: 800, y: 0 },
          ],
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ComputerUse.ComputerUseActionError);
      assert.equal(error.actionIndex, 1);
      assert.equal(error.completedActionCount, 0);
      assert.deepEqual(records, []);
    }),
  );

  it.effect("releases the active portal session", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      yield* computer.release;

      assert.deepEqual(records, [{ operation: "stop" }]);
    }),
  );

  it.effect("requests control without sending input", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      const result = yield* computer.requestControl;

      assert.equal(result.permission, "prompt-required");
      assert.deepEqual(records, [{ operation: "start" }]);
    }),
  );

  it.effect("requests view access without sending input", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      const result = yield* computer.requestView;

      assert.equal(result.permission, "prompt-required");
      assert.deepEqual(records, [{ operation: "view" }]);
    }),
  );

  it.effect("forgets remembered portal consent", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      yield* computer.forget;

      assert.deepEqual(records, [{ operation: "forget" }]);
    }),
  );

  it.effect("holds and releases keys without reopening control for key-up", () =>
    Effect.gen(function* () {
      const records: Array<InputRecord> = [];
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), makeController(records));

      yield* computer.act({
        actions: [
          { type: "key_down", key: "Alt" },
          { type: "press", key: "Tab" },
          { type: "key_up", key: "Alt" },
        ],
      });

      assert.deepEqual(records, [
        { operation: "start" },
        { operation: "keyDown", input: { key: "Alt" } },
        { operation: "press", input: { key: "Tab", modifiers: [] } },
        { operation: "keyUp", input: { key: "Alt" } },
      ]);
    }),
  );

  it.effect("releases while control authorization is pending", () =>
    Effect.gen(function* () {
      const authorizationStarted = yield* Deferred.make<void>();
      const cancelAuthorization = yield* Deferred.make<void>();
      const records: Array<InputRecord> = [];
      const cancellationError = new GnomeRemoteDesktop.GnomeRemoteDesktopCommandError({
        operation: "start",
        code: "request-cancelled",
        cause: "computer control was released",
      });
      const controller = GnomeRemoteDesktop.GnomeRemoteDesktop.of({
        ...makeController(records),
        start: Deferred.succeed(authorizationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(cancelAuthorization)),
          Effect.andThen(Effect.fail(cancellationError)),
        ),
        stop: Effect.sync(() => records.push({ operation: "stop" })).pipe(
          Effect.andThen(Deferred.succeed(cancelAuthorization, undefined)),
          Effect.asVoid,
        ),
      });
      const computer = yield* ComputerUse.makeWithOptions(makePlatform(), controller);
      const inputFiber = yield* computer
        .act({ actions: [{ type: "hotkey", keys: ["Alt", "F2"] }] })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(authorizationStarted);

      yield* computer.release;
      const inputError = yield* Fiber.join(inputFiber);

      assert.instanceOf(inputError, ComputerUse.ComputerUseActionError);
      assert.strictEqual(inputError.cause, cancellationError);
      assert.deepEqual(ComputerUse.toComputerAutomationFailure(inputError), {
        code: "request-cancelled",
        category: "cancelled",
        message: "The desktop operation was cancelled.",
        actionIndex: 0,
        completedActionCount: 0,
      });
      assert.deepEqual(records, [{ operation: "stop" }]);
    }),
  );
});

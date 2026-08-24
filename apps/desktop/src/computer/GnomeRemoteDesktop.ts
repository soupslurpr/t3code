import {
  ComputerAutomationInputCleanup,
  type ComputerAutomationAction,
  type ComputerAutomationDisplayState,
  type ComputerAutomationPermission,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const HELPER_RESOURCE_PATH = "computer-use/gnome-remote-desktop.js";
const RESTORE_TOKEN_FILE_NAME = "computer-control-grant.json";
const GJS_EXECUTABLE_PATH = "/usr/bin/gjs";
const HELPER_HANDSHAKE_TIMEOUT = Duration.seconds(5);
const HELPER_CONTROL_TIMEOUT = Duration.minutes(2);
const MAX_SCREENSHOT_BYTES = 64 * 1_024 * 1_024;
const MAX_SCREENSHOT_BASE64_LENGTH = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4;
const MAX_ACCESSIBILITY_TARGETS = 256;
const MAX_ACCESSIBILITY_WINDOWS = 128;
const MAX_TYPE_CODE_POINTS = 10_000;

const HelperResponse = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    id: Schema.NullOr(Schema.String),
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      field: Schema.optional(Schema.String),
      received: Schema.optional(Schema.String),
      expected: Schema.optional(Schema.Array(Schema.String)),
      phase: Schema.optional(
        Schema.Literals([
          "validation",
          "authorization",
          "move-to-start",
          "button-down",
          "pointer-move",
          "button-up",
          "key-down",
          "key-press",
          "key-up",
          "execution",
          "observation",
        ]),
      ),
      actionIndex: Schema.optional(Schema.Int),
      actionType: Schema.optional(Schema.String),
      cleanup: Schema.optional(
        Schema.Struct({
          keys: Schema.Literals(["not-needed", "released", "session-closed", "release-failed"]),
          buttons: Schema.Literals(["not-needed", "released", "session-closed", "release-failed"]),
        }),
      ),
    }),
  }),
]);
type HelperResponse = typeof HelperResponse.Type;

const HelperStatus = Schema.Struct({
  permission: Schema.Literals([
    "prompt-required",
    "remembered",
    "pending",
    "view-only",
    "granted",
    "denied",
  ]),
  devices: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rememberedAccess: Schema.Array(Schema.Literals(["view", "control"])).check(Schema.isMaxLength(2)),
  displayState: Schema.Literals(["active", "blanked", "locked", "unknown"]),
  keepAwake: Schema.Boolean,
});

const HelperBounds = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});

const HelperAccessibilityTarget = Schema.Struct({
  id: Schema.String,
  application: Schema.String,
  role: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  bounds: HelperBounds,
  activation: Schema.Literals(["action", "keyboard", "focus"]),
  enabled: Schema.Boolean,
  focused: Schema.Boolean,
  selected: Schema.Boolean,
  checked: Schema.Boolean,
  expanded: Schema.Boolean,
});

const HelperAccessibilityWindow = Schema.Struct({
  id: Schema.String,
  application: Schema.String,
  name: Schema.String,
  focused: Schema.Boolean,
});

const HelperAccessibilitySnapshot = Schema.Struct({
  available: Schema.Boolean,
  coordinateSpace: Schema.Literal("focused-window"),
  window: Schema.NullOr(
    Schema.Struct({
      application: Schema.String,
      name: Schema.String,
      size: Schema.Struct({
        width: Schema.Int.check(Schema.isGreaterThan(0)),
        height: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
    }),
  ),
  windows: Schema.Array(HelperAccessibilityWindow).check(
    Schema.isMaxLength(MAX_ACCESSIBILITY_WINDOWS),
  ),
  targets: Schema.Array(HelperAccessibilityTarget).check(
    Schema.isMaxLength(MAX_ACCESSIBILITY_TARGETS),
  ),
  truncated: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});

const HelperSnapshot = Schema.Struct({
  data: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_SCREENSHOT_BASE64_LENGTH)),
  source: Schema.Literals(["screen-cast-stream", "remote-desktop-stream"]),
  accessibility: Schema.optional(HelperAccessibilitySnapshot),
});

const HelperActivateResult = Schema.Struct({
  target: HelperAccessibilityTarget,
});

const HelperTypeResult = Schema.Struct({
  requestedCodePoints: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_TYPE_CODE_POINTS }),
  ),
  injectedCodePoints: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_TYPE_CODE_POINTS }),
  ),
  confirmedCodePoints: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_TYPE_CODE_POINTS })),
  ),
  delivery: Schema.Literals(["none", "accessibility", "key-events", "mixed"]),
  focusedEditable: Schema.Boolean,
});

const HelperMethod = Schema.Literals([
  "status",
  "snapshot",
  "configurePower",
  "setAgentWorking",
  "requestAvailability",
  "releaseAvailability",
  "view",
  "start",
  "rememberView",
  "rememberControl",
  "move",
  "click",
  "activate",
  "activateWindow",
  "drag",
  "wheel",
  "validateActions",
  "type",
  "press",
  "hotkey",
  "keyDown",
  "keyUp",
  "releaseInputs",
  "stop",
  "forget",
]);
type HelperMethod = typeof HelperMethod.Type;

const HelperCommand = Schema.Struct({
  id: Schema.String,
  method: HelperMethod,
  params: Schema.Unknown,
});

export class GnomeRemoteDesktopUnavailableError extends Schema.TaggedErrorClass<GnomeRemoteDesktopUnavailableError>()(
  "GnomeRemoteDesktopUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `computer control on GNOME Wayland is unavailable: ${this.reason}`;
  }
}

export class GnomeRemoteDesktopCommandError extends Schema.TaggedErrorClass<GnomeRemoteDesktopCommandError>()(
  "GnomeRemoteDesktopCommandError",
  {
    operation: HelperMethod,
    code: Schema.String,
    field: Schema.optional(Schema.String),
    received: Schema.optional(Schema.String),
    expected: Schema.optional(Schema.Array(Schema.String)),
    phase: Schema.optional(Schema.String),
    actionIndex: Schema.optional(Schema.Int),
    actionType: Schema.optional(Schema.String),
    cleanup: Schema.optional(Schema.Defect()),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `computer-control operation ${this.operation} on GNOME Wayland failed (${this.code}).`;
  }
}

export class GnomeRemoteDesktopProtocolError extends Schema.TaggedErrorClass<GnomeRemoteDesktopProtocolError>()(
  "GnomeRemoteDesktopProtocolError",
  {
    operation: HelperMethod,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `computer-control helper for GNOME Wayland returned an invalid ${this.operation} response.`;
  }
}

export class GnomeRemoteDesktopTimeoutError extends Schema.TaggedErrorClass<GnomeRemoteDesktopTimeoutError>()(
  "GnomeRemoteDesktopTimeoutError",
  {
    operation: HelperMethod,
    timeoutMs: Schema.Int,
  },
) {
  override get message(): string {
    return `computer-control operation ${this.operation} on GNOME Wayland timed out after ${this.timeoutMs}ms.`;
  }
}

export const GnomeRemoteDesktopError = Schema.Union([
  GnomeRemoteDesktopUnavailableError,
  GnomeRemoteDesktopCommandError,
  GnomeRemoteDesktopProtocolError,
  GnomeRemoteDesktopTimeoutError,
]);
export type GnomeRemoteDesktopError = typeof GnomeRemoteDesktopError.Type;
const isGnomeRemoteDesktopError = Schema.is(GnomeRemoteDesktopError);

export interface GnomeRemoteDesktopStatus {
  readonly available: boolean;
  readonly permission: ComputerAutomationPermission;
  readonly rememberedAccess: ReadonlyArray<"view" | "control">;
  readonly displayState: ComputerAutomationDisplayState;
  readonly keepAwake: boolean;
  readonly detail?: string | undefined;
}

export interface GnomeRemoteDesktopDisplayBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GnomeRemoteDesktopStreamSize {
  readonly width: number;
  readonly height: number;
}

export interface GnomeRemoteDesktopSnapshotInput {
  readonly includeAccessibility: boolean;
  readonly includeAccessibilityTargets?: boolean | undefined;
  readonly displayBounds: GnomeRemoteDesktopDisplayBounds;
}

export interface GnomeRemoteDesktopAccessibilityTarget {
  readonly id: string;
  readonly application: string;
  readonly role: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly activation: "action" | "keyboard" | "focus";
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly selected: boolean;
  readonly checked: boolean;
  readonly expanded: boolean;
}

export interface GnomeRemoteDesktopSnapshot {
  readonly data: Uint8Array;
  readonly source: "screen-cast-stream" | "remote-desktop-stream";
  readonly accessibility?: {
    readonly available: boolean;
    readonly coordinateSpace: "focused-window";
    readonly window: {
      readonly application: string;
      readonly name: string;
      readonly size: { readonly width: number; readonly height: number };
    } | null;
    readonly windows: ReadonlyArray<{
      readonly id: string;
      readonly application: string;
      readonly name: string;
      readonly focused: boolean;
    }>;
    readonly targets: ReadonlyArray<GnomeRemoteDesktopAccessibilityTarget>;
    readonly truncated: boolean;
    readonly detail?: string | undefined;
  };
}

export interface GnomeRemoteDesktopActivateResult {
  readonly target: GnomeRemoteDesktopAccessibilityTarget;
}

export interface GnomeRemoteDesktopTypeResult {
  readonly requestedCodePoints: number;
  readonly injectedCodePoints: number;
  readonly confirmedCodePoints?: number | undefined;
  readonly delivery: "none" | "accessibility" | "key-events" | "mixed";
  readonly focusedEditable: boolean;
}

export interface GnomeRemoteDesktopShape {
  readonly status: Effect.Effect<GnomeRemoteDesktopStatus>;
  readonly snapshot: (
    input: GnomeRemoteDesktopSnapshotInput,
  ) => Effect.Effect<GnomeRemoteDesktopSnapshot, GnomeRemoteDesktopError>;
  readonly view: Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly start: Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly rememberView: Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly rememberControl: Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly configurePowerProtection: (
    enabled: boolean,
  ) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly setAgentWorking: (active: boolean) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly requestAvailability: Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly releaseAvailability: Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly move: (input: {
    readonly x: number;
    readonly y: number;
    readonly durationMs: number;
    readonly displayBounds: GnomeRemoteDesktopDisplayBounds;
    readonly streamSize: GnomeRemoteDesktopStreamSize;
  }) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly click: (input: {
    readonly button: "left" | "right" | "middle";
    readonly count: number;
  }) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly activate: (input: {
    readonly targetId: string;
  }) => Effect.Effect<GnomeRemoteDesktopActivateResult, GnomeRemoteDesktopError>;
  readonly activateWindow: (input: {
    readonly windowId: string;
  }) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly drag: (input: {
    readonly button: "left" | "right" | "middle";
    readonly x: number;
    readonly y: number;
    readonly durationMs: number;
    readonly displayBounds: GnomeRemoteDesktopDisplayBounds;
    readonly streamSize: GnomeRemoteDesktopStreamSize;
    readonly steps?: number | undefined;
  }) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly wheel: (input: {
    readonly deltaX: number;
    readonly deltaY: number;
  }) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly validateActions: (
    actions: ReadonlyArray<ComputerAutomationAction>,
  ) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly type: (input: {
    readonly text: string;
    readonly intervalMs: number;
  }) => Effect.Effect<GnomeRemoteDesktopTypeResult, GnomeRemoteDesktopError>;
  readonly press: (input: {
    readonly key: string;
    readonly modifiers: ReadonlyArray<string>;
  }) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly hotkey: (input: {
    readonly keys: ReadonlyArray<string>;
  }) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly keyDown: (input: {
    readonly key: string;
  }) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly keyUp: (input: { readonly key: string }) => Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly releaseInputs: Effect.Effect<ComputerAutomationInputCleanup, GnomeRemoteDesktopError>;
  readonly stop: Effect.Effect<void, GnomeRemoteDesktopError>;
  readonly forget: Effect.Effect<void, GnomeRemoteDesktopError>;
}

export class GnomeRemoteDesktop extends Context.Service<
  GnomeRemoteDesktop,
  GnomeRemoteDesktopShape
>()("@t3tools/desktop/computer/GnomeRemoteDesktop") {}

interface PendingRequest {
  readonly operation: HelperMethod;
  readonly deferred: Deferred.Deferred<unknown, GnomeRemoteDesktopError>;
}

type RequestRegistration =
  | { readonly _tag: "registered"; readonly id: string }
  | { readonly _tag: "unavailable"; readonly detail: string | undefined };

interface ClientState {
  readonly available: boolean;
  readonly permission: ComputerAutomationPermission;
  readonly detail?: string;
  readonly nextRequestId: number;
  readonly pending: ReadonlyMap<string, PendingRequest>;
}

const unavailable = (reason: string): GnomeRemoteDesktopShape => {
  const error = new GnomeRemoteDesktopUnavailableError({ reason });
  const fail = Effect.fail(error);
  return GnomeRemoteDesktop.of({
    status: Effect.succeed({
      available: false,
      permission: "unavailable",
      rememberedAccess: [],
      displayState: "unknown",
      keepAwake: false,
      detail: error.message,
    }),
    snapshot: () => fail,
    view: fail,
    start: fail,
    rememberView: fail,
    rememberControl: fail,
    configurePowerProtection: () => Effect.void,
    setAgentWorking: () => Effect.void,
    requestAvailability: fail,
    releaseAvailability: Effect.void,
    move: () => fail,
    click: () => fail,
    activate: () => fail,
    activateWindow: () => fail,
    drag: () => fail,
    wheel: () => fail,
    validateActions: () => fail,
    type: () => fail,
    press: () => fail,
    hotkey: () => fail,
    keyDown: () => fail,
    keyUp: () => fail,
    releaseInputs: Effect.succeed({ keys: "not-needed", buttons: "not-needed" }),
    stop: Effect.void,
    forget: fail,
  });
};

const helperResponseError = (
  operation: HelperMethod,
  error: Extract<HelperResponse, { readonly ok: false }>["error"],
) =>
  new GnomeRemoteDesktopCommandError({
    operation,
    code: error.code,
    ...(error.field === undefined ? {} : { field: error.field }),
    ...(error.received === undefined ? {} : { received: error.received }),
    ...(error.expected === undefined ? {} : { expected: error.expected }),
    ...(error.phase === undefined ? {} : { phase: error.phase }),
    ...(error.actionIndex === undefined ? {} : { actionIndex: error.actionIndex }),
    ...(error.actionType === undefined ? {} : { actionType: error.actionType }),
    ...(error.cleanup === undefined ? {} : { cleanup: error.cleanup }),
    cause: error.message,
  });

const helperCommandError = (operation: HelperMethod, code: string, cause: unknown) =>
  new GnomeRemoteDesktopCommandError({ operation, code, cause });

const decodeHelperResponse = Schema.decodeUnknownEffect(HelperResponse);
const decodeHelperStatus = Schema.decodeUnknownEffect(HelperStatus);
const decodeHelperSnapshot = Schema.decodeUnknownEffect(HelperSnapshot);
const decodeHelperActivateResult = Schema.decodeUnknownEffect(HelperActivateResult);
const decodeHelperTypeResult = Schema.decodeUnknownEffect(HelperTypeResult);
const decodeHelperInputCleanup = Schema.decodeUnknownEffect(ComputerAutomationInputCleanup);
const encodeHelperCommand = Schema.encodeEffect(Schema.fromJsonString(HelperCommand));

const sessionEnvironment = Config.all({
  currentDesktop: Config.option(Config.string("XDG_CURRENT_DESKTOP")),
  sessionType: Config.option(Config.string("XDG_SESSION_TYPE")),
});

/** Creates the persistent GJS sidecar used for GNOME Wayland portal input. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "linux") {
    return unavailable(`platform ${environment.platform} is not supported`);
  }
  const desktopSession = yield* sessionEnvironment;
  const sessionType = Option.getOrElse(desktopSession.sessionType, () => "");
  const currentDesktop = Option.getOrElse(desktopSession.currentDesktop, () => "");
  if (sessionType.toLowerCase() !== "wayland" || !currentDesktop.toLowerCase().includes("gnome")) {
    return unavailable("the current session is not GNOME on Wayland");
  }
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;

  const assets = yield* DesktopAssets.DesktopAssets;
  // Give the external GJS process a real file; it cannot traverse Electron's
  // app.asar virtual filesystem.
  const helperPath = environment.isPackaged
    ? yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const externalPath = environment.path.join(environment.resourcesPath, HELPER_RESOURCE_PATH);
        return (yield* fileSystem.exists(externalPath))
          ? Option.some(externalPath)
          : Option.none<string>();
      })
    : yield* assets.resolveResourcePath(HELPER_RESOURCE_PATH);
  if (Option.isNone(helperPath)) {
    return unavailable("the bundled GNOME portal helper is missing");
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(
    GJS_EXECUTABLE_PATH,
    [
      "-m",
      helperPath.value,
      environment.isDevelopment
        ? "t3code"
        : environment.linuxDesktopEntryName.replace(/\.desktop$/u, ""),
      environment.path.join(environment.stateDir, RESTORE_TOKEN_FILE_NAME),
    ],
    {
      stdin: { stream: "pipe", endOnDone: false },
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: Duration.seconds(2),
    },
  );
  const handle = yield* spawner.spawn(command).pipe(
    Effect.mapError(
      (cause) =>
        new GnomeRemoteDesktopUnavailableError({
          reason: `failed to start ${GJS_EXECUTABLE_PATH}: ${String(cause)}`,
        }),
    ),
  );
  const state = yield* Ref.make<ClientState>({
    available: true,
    permission: "prompt-required",
    nextRequestId: 0,
    pending: new Map(),
  });
  const writeSemaphore = yield* Semaphore.make(1);
  const authorizationSemaphore = yield* Semaphore.make(1);
  const authorizationGeneration = yield* Ref.make(0);

  const failPending = Effect.fn("GnomeRemoteDesktop.failPending")(function* (
    error: GnomeRemoteDesktopError,
  ) {
    const pending = yield* Ref.modify(state, (current) => [
      current.pending,
      {
        ...current,
        available: false,
        permission: "unavailable" as const,
        detail: error.message,
        pending: new Map(),
      },
    ]);
    yield* Effect.forEach(pending.values(), ({ deferred }) => Deferred.fail(deferred, error), {
      discard: true,
    });
  });

  yield* handle.stdout.pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.mapEffect((value) =>
      decodeHelperResponse(value).pipe(
        Effect.mapError(
          (cause) => new GnomeRemoteDesktopProtocolError({ operation: "status", cause }),
        ),
      ),
    ),
    Stream.runForEach((response) =>
      Effect.gen(function* () {
        if (response.id === null) return;
        const pending = yield* Ref.modify(state, (current) => {
          const request = current.pending.get(response.id!);
          if (!request) return [undefined, current] as const;
          const next = new Map(current.pending);
          next.delete(response.id!);
          return [request, { ...current, pending: next }] as const;
        });
        if (!pending) return;
        if (response.ok) {
          yield* Deferred.succeed(pending.deferred, response.result);
        } else {
          yield* Deferred.fail(
            pending.deferred,
            helperResponseError(pending.operation, response.error),
          );
        }
      }),
    ),
    Effect.catch((cause) =>
      failPending(
        isGnomeRemoteDesktopError(cause)
          ? cause
          : new GnomeRemoteDesktopProtocolError({ operation: "status", cause }),
      ),
    ),
    Effect.andThen(
      failPending(new GnomeRemoteDesktopUnavailableError({ reason: "the portal helper stopped" })),
    ),
    Effect.forkScoped,
  );
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.runForEach((line) =>
      Effect.logWarning("GNOME computer-control helper diagnostic", {
        detail: line.slice(0, 500),
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const request = Effect.fn("GnomeRemoteDesktop.request")(function* <A>(
    operation: HelperMethod,
    params: unknown,
    timeout: Duration.Duration,
    expectedAuthorizationGeneration?: number,
  ): Effect.fn.Return<A, GnomeRemoteDesktopError> {
    const deferred = yield* Deferred.make<unknown, GnomeRemoteDesktopError>();
    const registration = yield* Ref.modify(
      state,
      (latest): readonly [RequestRegistration, ClientState] => {
        if (!latest.available) {
          return [{ _tag: "unavailable" as const, detail: latest.detail }, latest] as const;
        }
        const id = `computer-${latest.nextRequestId}`;
        const pending = new Map(latest.pending);
        pending.set(id, { operation, deferred });
        return [
          { _tag: "registered" as const, id },
          { ...latest, nextRequestId: latest.nextRequestId + 1, pending },
        ] as const;
      },
    );
    if (registration._tag === "unavailable") {
      return yield* new GnomeRemoteDesktopUnavailableError({
        reason: registration.detail ?? "the portal helper is not running",
      });
    }
    const requestId = registration.id;
    const removePending = Ref.update(state, (latest) => {
      if (!latest.pending.has(requestId)) return latest;
      const pending = new Map(latest.pending);
      pending.delete(requestId);
      return { ...latest, pending };
    });
    const result = yield* Effect.gen(function* () {
      const encoded = yield* encodeHelperCommand({
        id: requestId,
        method: operation,
        params,
      }).pipe(
        Effect.mapError((cause) => new GnomeRemoteDesktopProtocolError({ operation, cause })),
        Effect.map((line) => `${line}\n`),
      );
      yield* writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if (
            expectedAuthorizationGeneration !== undefined &&
            (yield* Ref.get(authorizationGeneration)) !== expectedAuthorizationGeneration
          ) {
            return yield* helperCommandError(
              operation,
              "request-cancelled",
              "desktop access was released while authorization was pending",
            );
          }
          yield* Stream.run(Stream.encodeText(Stream.make(encoded)), handle.stdin).pipe(
            Effect.mapError((cause) => helperCommandError(operation, "helper-write-failed", cause)),
          );
        }),
      );
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new GnomeRemoteDesktopTimeoutError({
                  operation,
                  timeoutMs: Duration.toMillis(timeout),
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    }).pipe(Effect.ensuring(removePending));
    return result as A;
  });

  const readStatus = request<unknown>("status", {}, HELPER_HANDSHAKE_TIMEOUT).pipe(
    Effect.flatMap((response) =>
      decodeHelperStatus(response).pipe(
        Effect.mapError(
          (cause) =>
            new GnomeRemoteDesktopProtocolError({
              operation: "status",
              cause,
            }),
        ),
      ),
    ),
    Effect.tap((status) =>
      Ref.update(state, (current) => ({ ...current, permission: status.permission })),
    ),
  );
  yield* readStatus.pipe(Effect.tapError(() => handle.kill().pipe(Effect.ignore)));

  const control = <A>(operation: HelperMethod, params: A) =>
    request<void>(operation, params, HELPER_CONTROL_TIMEOUT);

  const releaseInputs = request<unknown>("releaseInputs", {}, HELPER_CONTROL_TIMEOUT).pipe(
    Effect.flatMap((response) =>
      decodeHelperInputCleanup(response).pipe(
        Effect.mapError(
          (cause) => new GnomeRemoteDesktopProtocolError({ operation: "releaseInputs", cause }),
        ),
      ),
    ),
  );

  const requestSessionStatus = (
    operation: "view" | "start" | "rememberView" | "rememberControl",
    params: unknown,
    expectedGeneration: number,
  ) =>
    request<unknown>(operation, params, HELPER_CONTROL_TIMEOUT, expectedGeneration).pipe(
      Effect.flatMap((response) =>
        decodeHelperStatus(response).pipe(
          Effect.mapError((cause) => new GnomeRemoteDesktopProtocolError({ operation, cause })),
        ),
      ),
      Effect.tap((status) =>
        Ref.update(state, (current) => ({ ...current, permission: status.permission })),
      ),
    );

  const cancelPendingAuthorization = Effect.fn("GnomeRemoteDesktop.cancelPendingAuthorization")(
    function* () {
      yield* Ref.update(authorizationGeneration, (generation) => generation + 1);
    },
  );

  const stop = cancelPendingAuthorization().pipe(Effect.andThen(control("stop", {})));
  const forget = cancelPendingAuthorization().pipe(Effect.andThen(control("forget", {})));

  const requestAccess = Effect.fn("GnomeRemoteDesktop.requestAccess")(function* (
    access: "view" | "control",
    remember = false,
  ) {
    yield* authorizationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const generation = yield* Ref.get(authorizationGeneration);
        yield* readStatus;
        const settings = yield* appSettings.get;
        const operation = remember
          ? access === "control"
            ? "rememberControl"
            : "rememberView"
          : access === "control"
            ? "start"
            : "view";
        yield* requestSessionStatus(
          operation,
          { preventSleep: settings.keepAwakeWhileAgentsWork },
          generation,
        );
      }),
    );
  });

  const configurePowerProtection: GnomeRemoteDesktopShape["configurePowerProtection"] = (enabled) =>
    control("configurePower", { enabled });

  const setAgentWorking: GnomeRemoteDesktopShape["setAgentWorking"] = (active) =>
    appSettings.get.pipe(
      Effect.flatMap((settings) =>
        control("setAgentWorking", {
          active,
          enabled: settings.keepAwakeWhileAgentsWork,
        }),
      ),
    );

  const requestAvailability = appSettings.get.pipe(
    Effect.flatMap((settings) =>
      control("requestAvailability", { enabled: settings.keepAwakeWhileAgentsWork }),
    ),
  );

  const releaseAvailability = control("releaseAvailability", {});

  const snapshot: GnomeRemoteDesktopShape["snapshot"] = (input) =>
    request<unknown>("snapshot", input, HELPER_CONTROL_TIMEOUT).pipe(
      Effect.flatMap((response) =>
        decodeHelperSnapshot(response).pipe(
          Effect.mapError(
            (cause) => new GnomeRemoteDesktopProtocolError({ operation: "snapshot", cause }),
          ),
        ),
      ),
      Effect.flatMap(({ data, source, accessibility }) =>
        Effect.fromResult(Encoding.decodeBase64(data)).pipe(
          Effect.mapError(
            (cause) => new GnomeRemoteDesktopProtocolError({ operation: "snapshot", cause }),
          ),
          Effect.map((decoded) => ({
            data: decoded,
            source,
            ...(accessibility === undefined ? {} : { accessibility }),
          })),
        ),
      ),
    );

  const activate: GnomeRemoteDesktopShape["activate"] = (input) =>
    request<unknown>("activate", input, HELPER_CONTROL_TIMEOUT).pipe(
      Effect.flatMap((response) =>
        decodeHelperActivateResult(response).pipe(
          Effect.mapError(
            (cause) => new GnomeRemoteDesktopProtocolError({ operation: "activate", cause }),
          ),
        ),
      ),
    );

  const typeText: GnomeRemoteDesktopShape["type"] = (input) =>
    request<unknown>("type", input, HELPER_CONTROL_TIMEOUT).pipe(
      Effect.flatMap((response) =>
        decodeHelperTypeResult(response).pipe(
          Effect.mapError(
            (cause) => new GnomeRemoteDesktopProtocolError({ operation: "type", cause }),
          ),
        ),
      ),
    );

  const revocationEvents = yield* Queue.sliding<void>(1);
  const revoke = () => Queue.offerUnsafe(revocationEvents, undefined);
  yield* Effect.all(
    [
      powerMonitor.onSimpleEvent("lock-screen", revoke),
      powerMonitor.onSimpleEvent("suspend", revoke),
    ],
    { concurrency: "unbounded" },
  );
  yield* Effect.forever(
    Queue.take(revocationEvents).pipe(
      Effect.andThen(stop),
      Effect.catch((error) => Effect.logWarning("computer access revocation failed", { error })),
    ),
  ).pipe(Effect.forkScoped);

  return GnomeRemoteDesktop.of({
    status: readStatus.pipe(
      Effect.map((helperStatus) => ({
        available: true,
        permission: helperStatus.permission,
        rememberedAccess: helperStatus.rememberedAccess,
        displayState: helperStatus.displayState,
        keepAwake: helperStatus.keepAwake,
      })),
      Effect.catch((error) =>
        Effect.succeed({
          available: false,
          permission: "unavailable" as const,
          rememberedAccess: [],
          displayState: "unknown" as const,
          keepAwake: false,
          detail: error.message,
        }),
      ),
    ),
    snapshot,
    view: requestAccess("view"),
    start: requestAccess("control"),
    rememberView: requestAccess("view", true),
    rememberControl: requestAccess("control", true),
    configurePowerProtection,
    setAgentWorking,
    requestAvailability,
    releaseAvailability,
    move: (input) => control("move", input),
    click: (input) => control("click", input),
    activate,
    activateWindow: (input) => control("activateWindow", input),
    drag: (input) => control("drag", input),
    wheel: (input) => control("wheel", input),
    validateActions: (actions) => control("validateActions", { actions }),
    type: typeText,
    press: (input) => control("press", input),
    hotkey: (input) => control("hotkey", input),
    keyDown: (input) => control("keyDown", input),
    keyUp: (input) => control("keyUp", input),
    releaseInputs,
    stop,
    forget,
  });
}).pipe(
  Effect.catch((error) =>
    Effect.succeed(
      unavailable(error instanceof Error ? error.message : "the portal helper failed to start"),
    ),
  ),
);

export const layer = Layer.effect(GnomeRemoteDesktop, make);

// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/**
 * The preview manager owns the tab's single debugger session and hands it here;
 * the relay shares it.
 */
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserEvent as DesktopBrowserEventType,
  type DesktopPreviewCaptureRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";
import { sendPageCommand } from "./GuestInput.ts";
import type { PreviewManagerError } from "./Manager.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
  /** Shares the manager's recording/PiP throttling lease while preparing a still frame. */
  readonly withCaptureActivity: <A, E>(
    capture: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | PreviewManagerError>;
}

class DesktopBrowserCaptureError extends Schema.TaggedError<DesktopBrowserCaptureError>()(
  "DesktopBrowserCaptureError",
  {
    reason: Schema.Literals(["pending", "changed", "paint-timeout", "capture-timeout", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const details = {
      pending: "a previous capture is still pending.",
      changed: "the browser tab changed during capture.",
      "paint-timeout": "the browser surface did not become paintable within 2 seconds.",
      "capture-timeout": "the compositor did not supply a screenshot within 8 seconds.",
      failed: "the compositor could not capture a frame.",
    };
    return `Desktop browser screenshot failed: ${details[this.reason]}`;
  }
}

const isDesktopBrowserCaptureError = Schema.is(DesktopBrowserCaptureError);

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  relayAbort: AbortController | null;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    readonly events: Stream.Stream<Uint8Array>;
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    readonly detach: (key: DesktopBrowserTabKey) => void;
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    readonly captureRequests: Stream.Stream<DesktopPreviewCaptureRequest>;
    readonly acknowledgeCapture: (requestId: string) => void;
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export const make = Effect.gen(function* () {
  const outbox = yield* PubSub.unbounded<DesktopBrowserEventType>();
  const pointers = yield* PubSub.sliding<{
    readonly key: DesktopBrowserTabKey;
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }>(16);
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const tabs = new Map<string, AttachedTab>();
  const captureRequests = yield* PubSub.unbounded<DesktopPreviewCaptureRequest>();
  const pendingCaptures = new Map<string, Deferred.Deferred<void>>();
  // Both APIs are uncancellable, so bound each independently. A hung native
  // warmup must not prevent further CDP screenshots from succeeding.
  const capturing = new WeakSet<Electron.WebContents>();
  const warming = new WeakSet<Electron.WebContents>();
  const capture = async (
    tab: AttachedTab,
    parameters: Readonly<Record<string, unknown>>,
    relaySignal: AbortSignal,
  ) => {
    const { webContents, debugger: debuggee } = tab.debuggee;
    if (capturing.has(webContents)) {
      throw new DesktopBrowserCaptureError({ reason: "pending" });
    }
    capturing.add(webContents);
    let pending: Promise<unknown> | undefined;
    const requireCurrent = (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (tabs.get(keyOf(tab.key)) !== tab || webContents.isDestroyed()) {
        throw new DesktopBrowserCaptureError({ reason: "changed" });
      }
    };
    try {
      return await runPromise(
        tab.debuggee.withCaptureActivity(
          Effect.acquireUseRelease(
            Effect.gen(function* () {
              const ready = yield* Deferred.make<void>();
              const requestId = NodeCrypto.randomUUID();
              pendingCaptures.set(requestId, ready);
              return { requestId, ready, webContentsId: webContents.id };
            }),
            ({ requestId, ready, webContentsId }) =>
              Effect.gen(function* () {
                yield* PubSub.publish(captureRequests, {
                  requestId,
                  webContentsId,
                  active: true,
                });
                yield* Deferred.await(ready).pipe(
                  Effect.timeoutOrElse({
                    duration: "2 seconds",
                    orElse: () =>
                      Effect.fail(
                        new DesktopBrowserCaptureError({
                          reason: "paint-timeout",
                        }),
                      ),
                  }),
                );
                return yield* Effect.tryPromise({
                  try: async (signal) => {
                    requireCurrent(signal);
                    // CDP may resize the surface for a scaled clip. Request its
                    // screenshot first, then produce an initial frame and, if
                    // CDP is still waiting, a frame after that capture setup.
                    let screenshotSettled = false;
                    const screenshotRequest = Promise.resolve()
                      .then(() => debuggee.sendCommand("Page.captureScreenshot", parameters))
                      .finally(() => {
                        screenshotSettled = true;
                      });
                    pending = screenshotRequest;
                    if (!warming.has(webContents)) {
                      warming.add(webContents);
                      const releaseWarmup = () => warming.delete(webContents);
                      void Promise.resolve()
                        .then(async () => {
                          await webContents.capturePage(undefined, {
                            stayHidden: true,
                            stayAwake: false,
                          });
                          requireCurrent(signal);
                          if (!screenshotSettled) {
                            await webContents.capturePage(undefined, {
                              stayHidden: true,
                              stayAwake: false,
                            });
                          }
                        })
                        .then(releaseWarmup, releaseWarmup);
                    }
                    // Native capture only requests paint; its unused image must
                    // not delay or replace CDP's screenshot result.
                    const screenshot = await screenshotRequest;
                    requireCurrent(signal);
                    return screenshot;
                  },
                  catch: (cause) =>
                    isDesktopBrowserCaptureError(cause)
                      ? cause
                      : new DesktopBrowserCaptureError({
                          reason: "failed",
                          cause,
                        }),
                }).pipe(
                  Effect.timeoutOrElse({
                    duration: "8 seconds",
                    orElse: () =>
                      Effect.fail(
                        new DesktopBrowserCaptureError({
                          reason: "capture-timeout",
                        }),
                      ),
                  }),
                );
              }),
            ({ requestId, webContentsId }) =>
              Effect.gen(function* () {
                pendingCaptures.delete(requestId);
                yield* PubSub.publish(captureRequests, {
                  requestId,
                  webContentsId,
                  active: false,
                });
              }),
          ),
        ),
        { signal: relaySignal },
      );
    } finally {
      const release = () => {
        capturing.delete(webContents);
      };
      if (pending) void pending.then(release, release);
      else release();
    }
  };
  const releaseRelay = (tab: AttachedTab) => {
    tab.relayAbort?.abort();
    tab.relayAbort = null;
    tab.relay = null;
  };
  const emit = (event: DesktopBrowserEventType) => runFork(PubSub.publish(outbox, event));

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const controller = new AbortController();
    tab.relayAbort = controller;
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId) =>
          method === "Page.captureScreenshot" && sessionId === undefined
            ? capture(tab, params, controller.signal)
            : sessionId === undefined
              ? sendPageCommand(webContents, debuggee, method, params)
              : debuggee.sendCommand(method, params, sessionId),
        targetId: () =>
          debuggee
            .sendCommand("Target.getTargetInfo")
            .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        userAgent: () => webContents.getUserAgent(),
        setDownloadDirectory: (directory) => {
          tab.downloadDirectory = directory;
        },
      },
      (message) => {
        if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
          emit({ type: "cdp", ...tab.key, message });
        }
      },
    );
    tab.relay = relay;
    return relay;
  };

  /**
   * Without a path Electron would open its Save dialog over the app for a file
   * the agent asked for. CDP names the download just before this runs.
   */
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
    const tab = [...tabs.values()].find(
      (candidate) => candidate.debuggee.webContents === source && candidate.downloadDirectory,
    );
    if (!tab?.downloadDirectory || !tab.pendingDownloadGuid) return false;
    item.setSavePath(NodePath.join(tab.downloadDirectory, tab.pendingDownloadGuid));
    tab.pendingDownloadGuid = null;
    return true;
  };

  const detach = (key: DesktopBrowserTabKey) => {
    const id = keyOf(key);
    const tab = tabs.get(id);
    if (!tab) return;
    releaseRelay(tab);
    tabs.delete(id);
    tab.debuggee.debugger.off("message", tab.onMessage);
    emit({ type: "detached", ...key });
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      relay: null,
      relayAbort: null,
      downloadDirectory: null,
      pendingDownloadGuid: null,
      agentInputAt: Number.NEGATIVE_INFINITY,
      onMessage: (_event, method, params, sessionId) => {
        if (method === "Browser.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    emit({ type: "attached", ...key });
  };

  const handleCommandLine = (line: string) =>
    Effect.sync(() => {
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      const tab = tabs.get(keyOf(command.value));
      if (!tab) return;
      if (command.value.type === "pointer") {
        const { threadId, tabId, phase, x, y } = command.value;
        runFork(PubSub.publish(pointers, { key: { threadId, tabId }, phase, x, y }));
        return;
      }
      if (command.value.type === "release") {
        releaseRelay(tab);
        return;
      }
      if (AGENT_INPUT_COMMAND.test(command.value.message)) tab.agentInputAt = performance.now();
      relayFor(tab).receive(command.value.message);
    });

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS;
  };

  const announceAll = Effect.suspend(() =>
    Effect.forEach(
      [...tabs.values()],
      (tab) => {
        releaseRelay(tab);
        return PubSub.publish(outbox, { type: "attached", ...tab.key });
      },
      { discard: true },
    ),
  );

  return DesktopBrowserHost.of({
    captureRequests: Stream.fromPubSub(captureRequests),
    acknowledgeCapture: (requestId) => {
      const ready = pendingCaptures.get(requestId);
      if (ready) runFork(Deferred.succeed(ready, undefined));
    },
    pointers: Stream.fromPubSub(pointers),
    // Subscribes before announcing, so no attach falls between the two.
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(outbox);
        yield* announceAll;
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(Stream.map((event) => lineEncoder.encode(`${encodeEvent(event)}\n`))),
    handleCommandLine,
    attach,
    detach,
    placeDownload,
    humanStartedDownload,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);

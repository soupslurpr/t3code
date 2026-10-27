/** Verifies browser recording lifecycle, format selection, and saved artifacts. */

import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  EnvironmentId,
  ThreadId,
  type DesktopPreviewBridge,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  captureScreenshot,
  clientSettings,
  events,
  getDisplayMedia,
  registrySet,
  requestDisplayMediaCapture,
  save,
  startScreencast,
  stopScreencast,
} = vi.hoisted(() => {
  const events: string[] = [];
  return {
    captureScreenshot: vi.fn<DesktopPreviewBridge["captureScreenshot"]>(),
    clientSettings: { browserRecordingFrameRate: 30 as 30 | 60 },
    events,
    getDisplayMedia: vi.fn(),
    requestDisplayMediaCapture: vi.fn((_tabId: string) => undefined),
    registrySet: vi.fn((_atom: unknown, value: { readonly tabIds: ReadonlySet<string> }) => {
      events.push(
        value.tabIds.size === 0 ? "clear" : `publish:${Array.from(value.tabIds).join(",")}`,
      );
    }),
    save: vi.fn(async (tabId: string, _mimeType: string, _data: Uint8Array) => ({
      id: "recording-test",
      tabId,
      path: "/tmp/recording-test.webm",
      mimeType: "video/webm" as const,
      sizeBytes: 0,
      createdAt: "2026-06-26T00:00:00.000Z",
    })),
    startScreencast: vi.fn<DesktopPreviewBridge["recording"]["startScreencast"]>(async (_tabId) => {
      events.push("start-screencast");
    }),
    stopScreencast: vi.fn(async () => undefined),
  };
});

vi.mock(import("~/components/preview/previewBridge"), async (original) => {
  vi.stubGlobal("window", {
    desktopBridge: {
      preview: {
        captureScreenshot,
        recording: {
          onFrame: vi.fn(),
          save,
          startScreencast: async (tabId: string) => {
            const result = await startScreencast(tabId);
            if (result === undefined) requestDisplayMediaCapture(tabId);
            return result;
          },
          stopScreencast,
        },
      },
    },
  });
  try {
    return await original();
  } finally {
    vi.unstubAllGlobals();
  }
});

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { set: registrySet },
}));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => clientSettings,
}));

import {
  BrowserRecordingConflictError,
  findActiveBrowserRecordingRuntimeTabId,
  readActiveBrowserRecordingTabIds,
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
  stopBrowserRecordingForUpload,
} from "./browserRecording";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

class FakeMediaRecorder {
  static readonly instances: FakeMediaRecorder[] = [];
  static supportedTypes = new Set(["video/webm;codecs=vp9"]);
  static outputMimeType: string | undefined;
  static stopError: unknown;
  static isTypeSupported(type: string): boolean {
    return this.supportedTypes.has(type);
  }

  state: RecordingState = "inactive";
  readonly mimeType: string;
  readonly stream: MediaStream;
  readonly options: MediaRecorderOptions | undefined;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.options = options;
    this.mimeType =
      FakeMediaRecorder.outputMimeType ?? options?.mimeType ?? "video/browser-default";
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    this.state = "recording";
  }

  /** Delivers encoded bytes through the recorder's data event. */
  emitData(data: Blob): void {
    const event = Object.assign(new Event("dataavailable"), { data });
    for (const listener of this.listeners.get("dataavailable") ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }

  stop(): void {
    if (FakeMediaRecorder.stopError !== undefined) throw FakeMediaRecorder.stopError;
    this.state = "inactive";
    for (const listener of this.listeners.get("stop") ?? []) {
      if (typeof listener === "function") listener(new Event("stop"));
      else listener.handleEvent(new Event("stop"));
    }
  }
}

describe("browser recording", () => {
  let animationFrameCount = 0;

  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    FakeMediaRecorder.instances.length = 0;
    FakeMediaRecorder.supportedTypes = new Set(["video/webm;codecs=vp9"]);
    FakeMediaRecorder.outputMimeType = undefined;
    FakeMediaRecorder.stopError = undefined;
    clientSettings.browserRecordingFrameRate = 30;
    animationFrameCount = 0;
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrameCount += 1;
      callback(animationFrameCount);
      return animationFrameCount;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
    getDisplayMedia.mockResolvedValue({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: vi.fn() }],
    });
    requestDisplayMediaCapture.mockImplementation((tabId: string) => {
      const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
      if (typeof trigger !== "function" || trigger(tabId) !== true) {
        throw new Error(`No pending display-media capture for ${tabId}.`);
      }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "saves media duration excluding startup and finalization delays (ended: %s)",
    async (ended) => {
      const now = vi.spyOn(performance, "now").mockReturnValue(100);
      getDisplayMedia.mockImplementationOnce(async () => {
        now.mockReturnValue(1_100);
        return { getVideoTracks: () => [], getTracks: () => [{ stop: vi.fn() }] };
      });
      await startBrowserRecording("duration-tab");
      const recorder = FakeMediaRecorder.instances[0]!;
      recorder.emitData(
        new Blob(
          [
            new Uint8Array([
              0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0xff, 0x15, 0x49, 0xa9, 0x66,
              0x80, 0x1f, 0x43, 0xb6, 0x75, 0xff, 0xe7, 0x81, 0,
            ]),
          ],
          { type: recorder.mimeType },
        ),
      );
      now.mockReturnValue(2_600);
      if (ended) {
        recorder.stop();
        now.mockReturnValue(9_000);
      } else {
        const stop = recorder.stop.bind(recorder);
        vi.spyOn(recorder, "stop").mockImplementation(() => {
          now.mockReturnValue(9_000);
          stop();
        });
      }

      await stopBrowserRecording("duration-tab");

      const data = save.mock.calls[0]![2];
      expect(data.subarray(15, 26)).toEqual(
        new Uint8Array([0x44, 0x89, 0x88, 0x40, 0x97, 0x70, 0, 0, 0, 0, 0]),
      );
      expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    },
  );

  it("saves locally and releases capture before transferring the encoded recording once", async () => {
    const stopTrack = vi.fn();
    getDisplayMedia.mockResolvedValue({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    });
    await startBrowserRecording("transfer-tab");
    let finishUpload!: () => void;
    const uploaded = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const transfer = vi.fn(async (artifact, blob: Blob) => {
      expect(save).toHaveBeenCalledOnce();
      expect(stopTrack).toHaveBeenCalled();
      expect(artifact.path).toBe("/tmp/recording-test.webm");
      expect(blob.type).toBe("video/webm;codecs=vp9");
      await uploaded;
      return "uploaded-recording";
    });
    const localStop = stopBrowserRecording("transfer-tab");
    const firstStop = stopBrowserRecordingForUpload("transfer-tab", transfer);
    const secondStop = stopBrowserRecordingForUpload("transfer-tab", transfer);
    finishUpload();
    expect(await firstStop).toEqual(await secondStop);
    expect((await firstStop)?.uploadedAttachmentId).toBe("uploaded-recording");
    expect((await localStop)?.path).toBe("/tmp/recording-test.webm");
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("keeps the saved desktop file and releases the recording when transfer fails", async () => {
    await startBrowserRecording("failed-transfer-tab");
    await expect(
      stopBrowserRecordingForUpload("failed-transfer-tab", async () => {
        throw new Error("Connection interrupted");
      }),
    ).rejects.toThrow("Connection interrupted");
    expect(save).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds().has("failed-transfer-tab")).toBe(false);
    await startBrowserRecording("failed-transfer-tab");
    await stopBrowserRecording("failed-transfer-tab");
  });

  it("stops the native stream when MediaRecorder cleanup fails", async () => {
    const stopTrack = vi.fn();
    getDisplayMedia.mockResolvedValueOnce({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    });

    await startBrowserRecording("recording-tab");
    const cleanupCause = new DOMException("Could not start video source", "NotReadableError");
    FakeMediaRecorder.stopError = cleanupCause;

    await expect(stopBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "cleanup",
      tabId: "recording-tab",
      message: "Browser recording operation cleanup failed for tab recording-tab.",
    });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("releases the native capture lease when stream acquisition fails", async () => {
    const cause = new Error("capture failed");
    cause.name = "NotReadableError";
    getDisplayMedia.mockRejectedValueOnce(cause);

    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "capture-media-stream",
      tabId: "recording-tab",
      cause,
      message: "Browser recording operation capture-media-stream failed for tab recording-tab.",
    });

    expect(stopScreencast).toHaveBeenCalledWith("recording-tab");
    expect(events.at(-1)).toBe("clear");
  });

  it("records separate tabs concurrently", async () => {
    const firstThreadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-first"),
    };
    const secondThreadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-second"),
    };
    await Promise.all([
      startBrowserRecording("recording-tab", firstThreadRef),
      startBrowserRecording("recording-tab-2", secondThreadRef),
    ]);

    expect(startScreencast).toHaveBeenCalledTimes(2);
    expect(events).toContain("publish:recording-tab,recording-tab-2");
    expect(readActiveBrowserRecordingTabIds()).toEqual(
      new Set(["recording-tab", "recording-tab-2"]),
    );
    expect(readActiveBrowserRecordingTabIds(firstThreadRef)).toEqual(new Set(["recording-tab"]));
    expect(readActiveBrowserRecordingTabIds(secondThreadRef)).toEqual(new Set(["recording-tab-2"]));

    await stopBrowserRecording("recording-tab");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab-2"]));
    await stopBrowserRecording("recording-tab-2");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps a recording reachable through its runtime id after a server epoch changes", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-scoped"),
    };
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-a", "tab_1");
    await startBrowserRecording(runtimeTabId, threadRef, "tab_1");

    expect(startScreencast).toHaveBeenCalledWith(runtimeTabId);
    expect(readActiveBrowserRecordingTabIds(threadRef)).toEqual(new Set([runtimeTabId]));
    expect(readActiveBrowserRecordingTargets(threadRef)).toEqual([
      { runtimeTabId, serverTabId: "tab_1" },
    ]);
    expect(findActiveBrowserRecordingRuntimeTabId(threadRef, "tab_1")).toBe(runtimeTabId);

    const replacementRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-b", "tab_1");
    await expect(
      startBrowserRecording(replacementRuntimeTabId, threadRef, "tab_1"),
    ).rejects.toBeInstanceOf(BrowserRecordingConflictError);
    expect(startScreencast).toHaveBeenCalledTimes(1);

    await stopBrowserRecording(runtimeTabId);
  });
});

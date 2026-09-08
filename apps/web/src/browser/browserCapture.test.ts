/** Verifies capture preparation, serialization, and presentation cleanup. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { captureBrowserSurface } from "./browserCapture";

/** Creates an explicitly settled asynchronous operation. */
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Models attachment independently of Electron's native rendering. */
class CaptureElement {
  readonly attributes = new Map<string, string>();
  readonly style = { cssText: "", pointerEvents: "" };
  isConnected = false;
  className = "";
  src = "";
  alt = "";
  draggable = true;
  textContent = "";
  decode = vi.fn(async () => undefined);

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  after(element: CaptureElement) {
    element.isConnected = true;
  }

  remove() {
    this.isConnected = false;
  }
}

const image = { toDataURL: () => "data:image/png;base64,capture" };
let webview: CaptureElement & {
  capturePage: ReturnType<typeof vi.fn<() => Promise<typeof image>>>;
};
let created: CaptureElement[];
let scale: number;

beforeEach(() => {
  vi.useFakeTimers();
  scale = 0.3;
  created = [];
  webview = Object.assign(new CaptureElement(), { capturePage: vi.fn(async () => image) });
  webview.isConnected = true;
  webview.setAttribute("data-preview-tab", "tab-capture");
  vi.stubGlobal("document", {
    querySelectorAll: () => [webview],
    createElement: () => {
      const element = new CaptureElement();
      created.push(element);
      return element;
    },
    head: { append: (element: CaptureElement) => (element.isConnected = true) },
  });
  vi.stubGlobal("getComputedStyle", () => ({ transform: "matrix" }));
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      readonly a = scale;
      readonly d = scale;
      readonly b = 0;
      readonly c = 0;
      readonly e = 0;
      readonly f = 0;
      readonly is2D = true;
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 1));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});

afterEach(() => {
  expect(created.every((element) => !element.isConnected)).toBe(true);
  expect(webview.getAttribute("data-preview-capture")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("captureBrowserSurface", () => {
  it("restores presentation after a failed capture and allows the next capture", async () => {
    const failure = new Error("native capture failed");
    const first = captureBrowserSurface("tab-capture", async () => {
      expect(created.filter((element) => element.isConnected)).toHaveLength(2);
      throw failure;
    });
    const rejected = expect(first).rejects.toBe(failure);
    const second = captureBrowserSurface("tab-capture", async () => "next image");
    await vi.runAllTimersAsync();
    await rejected;
    await expect(second).resolves.toBe("next image");
  });

  it("keeps concurrent captures separate until each presentation is restored", async () => {
    const pending = deferred<string>();
    const first = captureBrowserSurface("tab-capture", () => pending.promise);
    const secondCapture = vi.fn(async () => "second image");
    const second = captureBrowserSurface("tab-capture", secondCapture);
    await vi.runAllTimersAsync();
    expect(webview.capturePage).toHaveBeenCalledOnce();
    expect(secondCapture).not.toHaveBeenCalled();

    pending.resolve("first image");
    await vi.runAllTimersAsync();
    await expect(Promise.all([first, second])).resolves.toEqual(["first image", "second image"]);
    expect(webview.capturePage).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled preliminary capture without changing presentation", async () => {
    const delayed = deferred<typeof image>();
    webview.capturePage.mockReturnValue(delayed.promise);
    const capture = vi.fn(async () => "image");
    const result = captureBrowserSurface("tab-capture", capture);
    const rejected = expect(result).rejects.toThrow("browser capture preparation timed out");
    await vi.runAllTimersAsync();
    await rejected;
    expect(capture).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);

    delayed.resolve(image);
    await vi.runAllTimersAsync();
    expect(created).toHaveLength(0);
  });

  it("recovers when a cold Chromium surface rejects its first capture", async () => {
    webview.capturePage.mockRejectedValueOnce(new Error("Current display surface not available"));
    const result = captureBrowserSurface("tab-capture", async () => "ready image");
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("ready image");
    expect(webview.capturePage).toHaveBeenCalledTimes(2);
  });

  it("continues capturing when a hidden window stops delivering animation frames", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const result = captureBrowserSurface("tab-capture", async () => "hidden image");
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("hidden image");
  });

  it("does not add a preliminary capture to a guest already rendered at full size", async () => {
    scale = 1;
    await expect(captureBrowserSurface("tab-capture", async () => "image")).resolves.toBe("image");
    expect(webview.capturePage).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});

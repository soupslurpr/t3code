/** Captures fitted Electron guests at their original rendering resolution. */

interface CapturableWebview extends HTMLElement {
  capturePage(): Promise<{ toDataURL(): string }>;
}

const CAPTURE_PREPARATION_TIMEOUT_MS = 1_000;
const CAPTURE_PAINT_TIMEOUT_MS = 250;
const CAPTURE_PREPARATION_ATTEMPTS = 3;
const captureTails = new WeakMap<CapturableWebview, Promise<unknown>>();
let nextCaptureId = 0;

/** Bounds preparation before changing the visible browser presentation. */
async function prepareWithTimeout<A>(operation: Promise<A>): Promise<A> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("browser capture preparation timed out")),
          CAPTURE_PREPARATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Settles presentation changes without waiting indefinitely on a hidden window. */
async function waitForCapturePaint(): Promise<void> {
  let frameId: number | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, CAPTURE_PAINT_TIMEOUT_MS);
      frameId = requestAnimationFrame(() => {
        frameId = requestAnimationFrame(() => resolve());
      });
    });
  } finally {
    if (frameId !== undefined) cancelAnimationFrame(frameId);
    clearTimeout(timeoutId);
  }
}

/** Retries cold Chromium surfaces before changing their presentation. */
async function readCapturePoster(webview: CapturableWebview) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prepareWithTimeout(webview.capturePage());
    } catch (error) {
      if (attempt === CAPTURE_PREPARATION_ATTEMPTS || !webview.isConnected) throw error;
      await waitForCapturePaint();
    }
  }
}

/** Holds the fitted image in place while Chromium renders an unscaled capture. */
async function captureUnscaled<A>(webview: CapturableWebview, capture: () => Promise<A>) {
  if (!webview.isConnected) return await capture();
  const transform = new DOMMatrixReadOnly(getComputedStyle(webview).transform);
  const scale = transform.a;
  if (
    scale >= 1 ||
    scale <= 0 ||
    !transform.is2D ||
    transform.d !== scale ||
    transform.b !== 0 ||
    transform.c !== 0 ||
    transform.e !== 0 ||
    transform.f !== 0
  ) {
    return await capture();
  }

  const currentImage = await readCapturePoster(webview);
  const poster = document.createElement("img");
  poster.src = currentImage.toDataURL();
  poster.alt = "";
  poster.draggable = false;
  poster.setAttribute("aria-hidden", "true");
  await prepareWithTimeout(poster.decode());
  if (!webview.isConnected) return await capture();

  poster.className = webview.className;
  poster.style.cssText = webview.style.cssText;
  // Block pointer input while the guest temporarily uses different presentation coordinates.
  poster.style.pointerEvents = "auto";
  const captureId = String(++nextCaptureId);
  const style = document.createElement("style");
  style.textContent = `webview[data-preview-capture="${captureId}"] {
    transform: none !important;
    clip-path: inset(0 ${100 * (1 - scale)}% ${100 * (1 - scale)}% 0) !important;
  }`;
  try {
    webview.after(poster);
    document.head.append(style);
    webview.setAttribute("data-preview-capture", captureId);
    await waitForCapturePaint();
    return await capture();
  } finally {
    webview.removeAttribute("data-preview-capture");
    style.remove();
    poster.remove();
  }
}

/** Serializes captures of one guest and restores its fitted view after success or failure. */
export function captureBrowserSurface<A>(tabId: string, capture: () => Promise<A>): Promise<A> {
  const webview =
    typeof document === "undefined"
      ? undefined
      : Array.from(document.querySelectorAll<CapturableWebview>("webview[data-preview-tab]")).find(
          (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
        );
  if (!webview) return capture();
  const previous = captureTails.get(webview) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => captureUnscaled(webview, capture));
  captureTails.set(webview, result);
  const clear = () => {
    if (captureTails.get(webview) === result) captureTails.delete(webview);
  };
  void result.then(clear, clear);
  return result;
}

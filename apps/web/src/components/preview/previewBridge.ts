/**
 * Module-level handle to the desktop preview bridge.
 *
 * Resolved once at import time so React hooks don't pay for repeated
 * `window.desktopBridge?.preview` lookups on every render. `null` on the web
 * build where there's no Electron host.
 */
import { captureBrowserSurface } from "~/browser/browserCapture";

const desktopPreview =
  typeof window === "undefined" ? null : (window.desktopBridge?.preview ?? null);

export const previewBridge = desktopPreview
  ? {
      ...desktopPreview,
      captureScreenshot: (...args: Parameters<typeof desktopPreview.captureScreenshot>) =>
        captureBrowserSurface(args[0], () => desktopPreview.captureScreenshot(...args)),
      automation: {
        ...desktopPreview.automation,
        snapshot: (...args: Parameters<typeof desktopPreview.automation.snapshot>) =>
          captureBrowserSurface(args[0], () => desktopPreview.automation.snapshot(...args)),
      },
    }
  : null;

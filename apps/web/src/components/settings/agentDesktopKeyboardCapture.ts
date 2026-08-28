interface KeyboardLock {
  readonly lock: (keyCodes?: ReadonlyArray<string>) => Promise<void>;
  readonly unlock: () => void;
}

interface FullscreenRoot {
  readonly requestFullscreen: (options?: FullscreenOptions) => Promise<void>;
}

interface FullscreenDocument {
  readonly documentElement: FullscreenRoot;
  readonly fullscreenElement: unknown | null;
  readonly exitFullscreen: () => Promise<void>;
}

interface KeyboardCaptureEnvironment {
  readonly document: FullscreenDocument;
  readonly keyboard: KeyboardLock | null;
}

const FULLSCREEN_REQUEST_TIMEOUT_MS = 3_000;

export interface AgentDesktopKeyboardCapture {
  readonly release: () => Promise<void>;
}

/** Returns Chromium's optional physical-keyboard capture interface. */
function browserKeyboardLock(): KeyboardLock | null {
  const keyboard = (navigator as Navigator & { readonly keyboard?: Partial<KeyboardLock> })
    .keyboard;
  return typeof keyboard?.lock === "function" && typeof keyboard.unlock === "function"
    ? (keyboard as KeyboardLock)
    : null;
}

/** Enters full screen without letting a stalled browser request block control forever. */
async function enterFullscreen(fullscreenDocument: FullscreenDocument): Promise<void> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = fullscreenDocument.documentElement.requestFullscreen({ navigationUI: "hide" });

  void request.then(
    () => {
      if (!timedOut || fullscreenDocument.fullscreenElement === null) return;
      void fullscreenDocument.exitFullscreen().catch(() => undefined);
    },
    () => undefined,
  );

  try {
    await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error("full screen request timed out"));
        }, FULLSCREEN_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  if (fullscreenDocument.fullscreenElement === null) {
    throw new Error("full screen request completed without entering full screen");
  }
}

/** Enters browser fullscreen and captures host-reserved keys until explicitly released. */
export async function acquireAgentDesktopKeyboardCapture(
  environment: KeyboardCaptureEnvironment = {
    document,
    keyboard: browserKeyboardLock(),
  },
): Promise<AgentDesktopKeyboardCapture> {
  const { document: fullscreenDocument, keyboard } = environment;
  if (keyboard === null) {
    throw new Error("Full keyboard capture is unavailable in this client.");
  }
  const enteredFullscreen = fullscreenDocument.fullscreenElement === null;
  if (enteredFullscreen) {
    try {
      await enterFullscreen(fullscreenDocument);
    } catch (cause) {
      throw new Error("T3 Code could not enter full screen for desktop control.", { cause });
    }
  }
  try {
    await keyboard.lock();
  } catch (cause) {
    if (enteredFullscreen && fullscreenDocument.fullscreenElement !== null) {
      await fullscreenDocument.exitFullscreen().catch(() => undefined);
    }
    throw new Error("T3 Code could not capture host shortcuts for desktop control.", {
      cause,
    });
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      keyboard.unlock();
      if (enteredFullscreen && fullscreenDocument.fullscreenElement !== null) {
        await fullscreenDocument.exitFullscreen();
      }
    },
  };
}

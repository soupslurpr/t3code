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
      await fullscreenDocument.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch (cause) {
      throw new Error("T3 Code could not enter full screen for Agent desktop control.", { cause });
    }
  }
  try {
    await keyboard.lock();
  } catch (cause) {
    if (enteredFullscreen && fullscreenDocument.fullscreenElement !== null) {
      await fullscreenDocument.exitFullscreen().catch(() => undefined);
    }
    throw new Error("T3 Code could not capture host shortcuts for Agent desktop control.", {
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

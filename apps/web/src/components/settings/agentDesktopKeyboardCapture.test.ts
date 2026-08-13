import { describe, expect, it, vi } from "@effect/vitest";

import { acquireAgentDesktopKeyboardCapture } from "./agentDesktopKeyboardCapture";

function makeEnvironment(fullscreenElement: unknown | null = null) {
  const environment = {
    document: {
      documentElement: {
        requestFullscreen: vi.fn(async () => {
          environment.document.fullscreenElement = environment.document.documentElement;
        }),
      },
      fullscreenElement,
      exitFullscreen: vi.fn(async () => {
        environment.document.fullscreenElement = null;
      }),
    },
    keyboard: {
      lock: vi.fn(async () => undefined),
      unlock: vi.fn(),
    },
  };
  return environment;
}

describe("Agent desktop keyboard capture", () => {
  it("owns and releases a new full-screen keyboard capture once", async () => {
    const environment = makeEnvironment();
    const capture = await acquireAgentDesktopKeyboardCapture(environment);

    expect(environment.document.documentElement.requestFullscreen).toHaveBeenCalledWith({
      navigationUI: "hide",
    });
    expect(environment.keyboard.lock).toHaveBeenCalledOnce();

    await capture.release();
    await capture.release();

    expect(environment.keyboard.unlock).toHaveBeenCalledOnce();
    expect(environment.document.exitFullscreen).toHaveBeenCalledOnce();
  });

  it("preserves full screen that another feature already owns", async () => {
    const environment = makeEnvironment({ existing: true });
    const capture = await acquireAgentDesktopKeyboardCapture(environment);

    expect(environment.document.documentElement.requestFullscreen).not.toHaveBeenCalled();
    await capture.release();
    expect(environment.document.exitFullscreen).not.toHaveBeenCalled();
  });

  it("leaves full screen when keyboard locking fails", async () => {
    const environment = makeEnvironment();
    environment.keyboard.lock.mockRejectedValueOnce(new Error("denied"));

    await expect(acquireAgentDesktopKeyboardCapture(environment)).rejects.toThrow(
      "could not capture host shortcuts",
    );
    expect(environment.document.exitFullscreen).toHaveBeenCalledOnce();
  });

  it("times out a stalled full-screen request and exits a late entry", async () => {
    vi.useFakeTimers();
    try {
      const environment = makeEnvironment();
      let finishFullscreen: (() => void) | undefined;
      environment.document.documentElement.requestFullscreen.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFullscreen = () => {
              environment.document.fullscreenElement = environment.document.documentElement;
              resolve();
            };
          }),
      );

      const failure = expect(acquireAgentDesktopKeyboardCapture(environment)).rejects.toThrow(
        "could not enter full screen",
      );
      await vi.advanceTimersByTimeAsync(3_000);
      await failure;

      expect(environment.keyboard.lock).not.toHaveBeenCalled();
      finishFullscreen?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(environment.document.exitFullscreen).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsupported clients before entering full screen", async () => {
    const environment = makeEnvironment();

    await expect(
      acquireAgentDesktopKeyboardCapture({ ...environment, keyboard: null }),
    ).rejects.toThrow("unavailable");
    expect(environment.document.documentElement.requestFullscreen).not.toHaveBeenCalled();
  });
});

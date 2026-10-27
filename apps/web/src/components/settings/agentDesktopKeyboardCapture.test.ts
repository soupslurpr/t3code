import { describe, expect, it, vi } from "@effect/vitest";

import {
  acquireAgentDesktopKeyboardCapture,
  createDesktopControlLease,
} from "./agentDesktopKeyboardCapture";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

describe("desktop control grant lifetime", () => {
  it("releases a late grant after fullscreen exit without waiting to unlock keys", async () => {
    const grant = deferred<boolean>();
    const capture = { release: vi.fn(async () => undefined) };
    const releaseControl = vi.fn(async () => true);
    const lease = createDesktopControlLease({
      capture,
      takeControl: () => grant.promise,
      releaseControl,
    });
    await lease.release();
    expect(capture.release).toHaveBeenCalledOnce();
    expect(releaseControl).not.toHaveBeenCalled();
    grant.resolve(true);
    expect(await lease.ready).toBe(false);
    await lease.release();
    expect(releaseControl).toHaveBeenCalledOnce();
    expect(capture.release).toHaveBeenCalledOnce();
  });

  it("releases active control once across repeated close notifications", async () => {
    const capture = { release: vi.fn(async () => undefined) };
    const releaseControl = vi.fn(async () => true);
    const lease = createDesktopControlLease({
      capture,
      takeControl: async () => true,
      releaseControl,
    });
    expect(await lease.ready).toBe(true);
    await Promise.all([lease.release(), lease.release()]);
    expect(capture.release).toHaveBeenCalledOnce();
    expect(releaseControl).toHaveBeenCalledOnce();
  });

  it("unlocks keys when a pending request is rejected without releasing another holder", async () => {
    const grant = deferred<boolean>();
    const capture = { release: vi.fn(async () => undefined) };
    const releaseControl = vi.fn(async () => true);
    const lease = createDesktopControlLease({
      capture,
      takeControl: () => grant.promise,
      releaseControl,
    });
    const failure = expect(lease.ready).rejects.toThrow("denied");
    await lease.release();
    grant.reject(new Error("denied"));
    await failure;
    expect(capture.release).toHaveBeenCalledOnce();
    expect(releaseControl).not.toHaveBeenCalled();
  });
  it("unlocks after control is returned without releasing the new holder", async () => {
    const capture = { release: vi.fn(async () => undefined) };
    const releaseControl = vi.fn(async () => true);
    const lease = createDesktopControlLease({
      capture,
      takeControl: async () => true,
      releaseControl,
    });
    expect(await lease.ready).toBe(true);
    await lease.revoke();
    await lease.release();
    expect(capture.release).toHaveBeenCalledOnce();
    expect(releaseControl).not.toHaveBeenCalled();
  });
});

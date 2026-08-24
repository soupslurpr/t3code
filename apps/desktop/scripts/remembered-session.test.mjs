import { describe, expect, it, vi } from "vite-plus/test";

import { rememberAndRelease } from "../resources/computer-use/remembered-session.js";

describe("remembered desktop sessions", () => {
  it("closes the live session after remembered authorization succeeds", async () => {
    const calls = [];

    await rememberAndRelease(
      async () => calls.push("start"),
      async () => calls.push("release"),
    );

    expect(calls).toEqual(["start", "release"]);
  });

  it("closes the live session when remembered authorization fails", async () => {
    const failure = new Error("authorization failed");
    const release = vi.fn(async () => undefined);

    await expect(rememberAndRelease(async () => Promise.reject(failure), release)).rejects.toBe(
      failure,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("surfaces cleanup failures instead of claiming the session closed", async () => {
    const failure = new Error("session close failed");

    await expect(
      rememberAndRelease(
        async () => undefined,
        async () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
  });
});

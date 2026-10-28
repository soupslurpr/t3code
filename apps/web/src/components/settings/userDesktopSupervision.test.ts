import { type ComputerAutomationSnapshot, type ComputerAutomationStatus } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  mountUserDesktopSupervision,
  readUserDesktopSupervision,
  requestUserDesktopLive,
  retainUnchangedImage,
  type UserDesktopSupervisionRequest,
} from "./userDesktopSupervision";

const status: ComputerAutomationStatus = {
  available: true,
  backend: "gnome-wayland-portal",
  permission: "view-only",
  rememberedAccess: [],
  displayState: "active",
  keepAwake: true,
  displays: [],
  cursor: null,
  lease: { access: "view", controller: null, canReturnControl: false },
};
const snapshot: ComputerAutomationSnapshot = {
  display: {
    id: "primary",
    label: "Primary",
    primary: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    scaleFactor: 1,
  },
  cursor: null,
  captureSource: "screen-cast-stream",
  screenshot: {
    state: "image",
    contentHash: `sha256-bgra8-v2:${"A".repeat(43)}`,
    mimeType: "image/webp",
    data: "exact",
    width: 800,
    height: 600,
    sizeBytes: 5,
    encoding: { format: "webp", mode: "lossless" },
  },
};
const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("opens a passive lens using only retained evidence and starts capture explicitly", async () => {
  const request = vi.fn(
    async (input: Parameters<UserDesktopSupervisionRequest>[0]): Promise<unknown> => {
      switch (input.request.operation) {
        case "status":
          return status;
        case "observation-list":
          return { observations: [] };
        case "request-view":
          return status;
        case "snapshot":
          return snapshot;
        default:
          return null;
      }
    },
  );
  const run: UserDesktopSupervisionRequest = async <Value>(
    input: Parameters<UserDesktopSupervisionRequest>[0],
  ) => (await request(input)) as Value;
  expect((await readUserDesktopSupervision(run, "selected")).agentObservation).toBeNull();
  expect(request.mock.calls.map(([input]) => input.request.operation)).toEqual([
    "status",
    "observation-list",
  ]);
  expect(await requestUserDesktopLive(run, "selected", "secondary", () => true)).toEqual({
    status,
    observation: snapshot,
  });
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
    request: { operation: "snapshot", desktopId: "selected", input: { displayId: "secondary" } },
  });
});

it("releases a late view grant after the selected supervisor closes without capturing", async () => {
  const grant = deferred<ComputerAutomationStatus>();
  let current = true;
  const request = vi.fn(
    async (input: Parameters<UserDesktopSupervisionRequest>[0]): Promise<unknown> =>
      input.request.operation === "request-view" ? grant.promise : null,
  );
  const run: UserDesktopSupervisionRequest = async <Value>(
    input: Parameters<UserDesktopSupervisionRequest>[0],
  ) => (await request(input)) as Value;
  const pending = requestUserDesktopLive(run, "selected", null, () => current);
  current = false;
  grant.resolve(status);
  expect(await pending).toBeNull();
  expect(request.mock.calls.map(([input]) => input.request.operation)).toEqual([
    "request-view",
    "release",
  ]);
});

it("preserves exact image bytes only for a matching unchanged fingerprint", () => {
  const previous = snapshot.screenshot!;
  const unchanged = {
    ...snapshot,
    screenshot: {
      state: "unchanged" as const,
      contentHash: previous.contentHash,
      width: 800,
      height: 600,
    },
  };
  expect(retainUnchangedImage(snapshot, unchanged).screenshot).toBe(previous);
  const different = {
    ...unchanged,
    screenshot: { ...unchanged.screenshot, contentHash: `sha256-bgra8-v2:${"B".repeat(43)}` },
  };
  expect(retainUnchangedImage(snapshot, different)).toBe(different);
});

it("keeps passive refresh image-free and releases once on hide without restarting late work", async () => {
  vi.useFakeTimers();
  try {
    class Visibility extends EventTarget {
      visibilityState: DocumentVisibilityState = "visible";
    }
    const document = new Visibility();
    let live = false;
    const capture = vi.fn(async () => undefined);
    const metadataDone = deferred<void>();
    const metadata = vi.fn(() => metadataDone.promise);
    const release = vi.fn(async () => undefined);
    const onHidden = vi.fn();
    const dispose = mountUserDesktopSupervision({
      document,
      isLive: () => live,
      capture,
      metadata,
      release,
      onHidden,
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(capture).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledOnce();
    live = true;
    await vi.advanceTimersByTimeAsync(750);
    expect(capture).toHaveBeenCalledOnce();
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onHidden).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    metadataDone.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    dispose();
    expect(metadata).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

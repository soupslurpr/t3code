import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const keyboardCapture = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
vi.mock("./agentDesktopKeyboardCapture", () => ({
  acquireAgentDesktopKeyboardCapture: keyboardCapture.acquire,
}));
import { ComputerDesktopViewer } from "./AgentDesktopSettings";

let container: HTMLDivElement;
let root: Root;
let fullscreenElement: Element | null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fullscreenElement = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  keyboardCapture.release.mockReset().mockResolvedValue(undefined);
  keyboardCapture.acquire.mockReset().mockImplementation(async () => {
    fullscreenElement = container;
    return { release: keyboardCapture.release };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ComputerDesktopViewer", () => {
  it("releases a pending grant when full screen ends before control becomes active", async () => {
    let resolveGrant!: (granted: boolean) => void;
    const granted = new Promise<boolean>((resolve) => {
      resolveGrant = resolve;
    });
    const onTakeControl = vi.fn(() => granted);
    const onRelease = vi.fn(async () => true);
    await act(async () =>
      root.render(
        <ComputerDesktopViewer
          embedded
          label="Test desktop"
          description="Test viewer"
          observation={null}
          agentObservation={null}
          controlling={false}
          busy={false}
          error={null}
          liveStarted
          onTakeControl={onTakeControl}
          onRelease={onRelease}
          onAction={async () => undefined}
        />,
      ),
    );
    const takeControl = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Take control",
    );
    expect(takeControl).toBeDefined();
    await act(async () => takeControl!.click());
    expect(keyboardCapture.acquire).toHaveBeenCalledOnce();
    expect(onTakeControl).toHaveBeenCalledOnce();
    await act(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(keyboardCapture.release).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledOnce();
    await act(async () => {
      resolveGrant(true);
      await granted;
    });
    expect(keyboardCapture.release).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      "Full screen ended before desktop control became active.",
    );
  });
});

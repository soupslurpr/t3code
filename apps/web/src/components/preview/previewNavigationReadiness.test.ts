import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  readThreadPreviewState: mocks.readThreadPreviewState,
  reconcilePreviewServerSessions: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    automation: {
      evaluate: vi.fn(),
      status: vi.fn(),
    },
  },
}));

import { previewBridge } from "./previewBridge";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { PreviewAutomationTargetUnavailableError } from "./previewAutomationErrors";
import { waitForNavigationReadiness } from "./previewNavigationReadiness";

describe("waitForNavigationReadiness", () => {
  it("accepts DOM readiness returned in an evaluation success envelope", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: { [tabId]: { tabId } },
    });
    vi.mocked(previewBridge!.automation.evaluate).mockResolvedValue({
      ok: true,
      value: "interactive",
    });
    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        previewRuntimeTabId(threadRef, "epoch-1", tabId),
        "navigate",
        "domContentLoaded",
        100,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a replaced runtime target even when readiness polling is disabled", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const staleRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-2",
      sessions: {
        [tabId]: { tabId },
      },
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        staleRuntimeTabId,
        "navigate",
        "none",
        100,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });
});

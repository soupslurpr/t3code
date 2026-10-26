import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationStatus,
} from "./previewAutomation.ts";

const decodeAutomationError = Schema.decodeUnknownSync(PreviewAutomationError);
const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize", "computerStatus"],
      }).supportedOperations,
    ).toEqual(["status", "resize", "computerStatus"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});

describe("PreviewAutomationError", () => {
  it("preserves a structured missing user-desktop host failure", () => {
    const error = decodeAutomationError({
      _tag: "PreviewAutomationNoAvailableHostError",
      operation: "computerStatus",
      environmentId: "environment-1",
      threadId: "thread-1",
      providerSessionId: "provider-session-1",
      providerInstanceId: "codex",
      computerFailure: {
        code: "agent-desktop-unavailable",
        category: "resource",
        message: "No user-desktop host is connected.",
        backendCode: "no-connected-automation-host",
      },
    });

    expect(error._tag).toBe("PreviewAutomationNoAvailableHostError");
    if (error._tag === "PreviewAutomationNoAvailableHostError") {
      expect(error.computerFailure?.backendCode).toBe("no-connected-automation-host");
      expect(error.message).toBe("No user-desktop host is connected.");
    }
  });
});

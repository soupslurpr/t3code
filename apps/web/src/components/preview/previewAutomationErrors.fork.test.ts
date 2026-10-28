import { expect, it } from "vite-plus/test";
import {
  PreviewAutomationComputerControllerRequiredError,
  resolveDesktopComputerAutomation,
  serializeComputerAutomationError,
} from "./previewAutomationErrors.ts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

it("reports a missing controller as an incompatible server before native access", () => {
  const error = new PreviewAutomationComputerControllerRequiredError({
    requestId: "request",
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  });
  expect(serializeComputerAutomationError(error)).toEqual({
    _tag: "PreviewAutomationUnsupportedClientError",
    message: error.message,
    detail: { requestId: "request", environmentId: "environment", threadId: "thread" },
  });
});

it("retains structured guest failures without exposing unrelated renderer errors", async () => {
  const failure = {
    code: "timed-out" as const,
    category: "timeout" as const,
    message: "The Agent desktop command timed out.",
    backendCode: "timed-out",
    detail: "guest process 42 exceeded its timeout",
  };
  const cause = await resolveDesktopComputerAutomation(
    Promise.resolve({ ok: false, error: failure }),
  ).catch((error: unknown) => error);
  expect(serializeComputerAutomationError(cause)).toEqual({
    _tag: "PreviewAutomationExecutionError",
    message: failure.message,
    detail: { computerFailure: failure },
  });
  expect(
    JSON.stringify(serializeComputerAutomationError(new Error("private renderer log"))),
  ).not.toContain("private renderer log");
});

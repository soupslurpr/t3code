import {
  ComputerAutomationFailure,
  EnvironmentId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type {
  DesktopComputerAutomationResult,
  PreviewAutomationResponse,
} from "@t3tools/contracts";

class DesktopComputerAutomationError extends Schema.TaggedError<DesktopComputerAutomationError>()(
  "DesktopComputerAutomationError",
  { failure: ComputerAutomationFailure },
) {
  override get message() {
    return this.failure.message;
  }
}

export async function resolveDesktopComputerAutomation<Value>(
  result: Promise<DesktopComputerAutomationResult<Value>> | undefined,
): Promise<Value> {
  if (result === undefined) throw new Error("Computer automation is unavailable on this desktop.");
  const resolved = await result;
  if (resolved.ok) return resolved.value;
  throw new DesktopComputerAutomationError({ failure: resolved.error });
}

export function serializeComputerAutomationError(
  error: unknown,
): NonNullable<PreviewAutomationResponse["error"]> {
  if (isControllerRequiredError(error)) {
    return {
      _tag: error.responseTag,
      message: error.message,
      detail: {
        requestId: error.requestId,
        environmentId: error.environmentId,
        threadId: error.threadId,
      },
    };
  }
  if (isDesktopComputerAutomationError(error)) {
    const failure = error.failure;
    const failureKind =
      failure.code === "display-inactive" ||
      failure.code === "display-locked" ||
      failure.code === "keep-awake-denied"
        ? failure.code
        : undefined;
    return {
      _tag: "PreviewAutomationExecutionError",
      message: failure.message,
      detail: { computerFailure: failure, ...(failureKind === undefined ? {} : { failureKind }) },
    };
  }
  return {
    _tag: "PreviewAutomationExecutionError",
    // oxlint-disable-next-line t3code/no-untranslated-copy -- This RPC failure is returned to the requesting agent.
    message: "The desktop computer operation failed.",
  };
}

export class PreviewAutomationComputerControllerRequiredError extends Schema.TaggedError<PreviewAutomationComputerControllerRequiredError>()(
  "PreviewAutomationComputerControllerRequiredError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  get responseTag() {
    return "PreviewAutomationUnsupportedClientError" as const;
  }

  override get message(): string {
    return `Computer request ${this.requestId} has no controller identity. Update the T3 environment server.`;
  }
}

const isDesktopComputerAutomationError = Schema.is(DesktopComputerAutomationError);
const isControllerRequiredError = Schema.is(PreviewAutomationComputerControllerRequiredError);

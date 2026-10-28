import type {
  ComputerAutomationFailure,
  DesktopComputerAutomationResult,
  PreviewAutomationResponse,
} from "@t3tools/contracts";

class DesktopComputerAutomationError extends Error {
  constructor(readonly failure: ComputerAutomationFailure) {
    super(failure.message);
  }
}

export async function resolveDesktopComputerAutomation<Value>(
  result: Promise<DesktopComputerAutomationResult<Value>> | undefined,
): Promise<Value> {
  if (result === undefined) throw new Error("Computer automation is unavailable on this desktop.");
  const resolved = await result;
  if (resolved.ok) return resolved.value;
  throw new DesktopComputerAutomationError(resolved.error);
}

export function serializeComputerAutomationError(
  error: unknown,
): NonNullable<PreviewAutomationResponse["error"]> {
  if (error instanceof DesktopComputerAutomationError) {
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
    message: "The desktop computer operation failed.",
  };
}

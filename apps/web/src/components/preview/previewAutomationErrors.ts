import {
  ComputerAutomationFailure,
  ComputerAutomationFailureKind,
  type DesktopComputerAutomationResult,
  EnvironmentId,
  findComputerAutomationFailureKind,
  type PreviewAutomationHost,
  PreviewAutomationOperation,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  PreviewTabId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

class DesktopComputerAutomationError extends Error {
  readonly code: ComputerAutomationFailure["code"];
  readonly failure: ComputerAutomationFailure;

  constructor(failure: ComputerAutomationFailure) {
    super(failure.message);
    this.code = failure.code;
    this.failure = failure;
  }
}

/** Resolves and unwraps one optional desktop computer-use IPC operation. */
export async function resolveDesktopComputerAutomation<Value>(
  result: Promise<DesktopComputerAutomationResult<Value>> | undefined,
): Promise<Value | undefined> {
  if (result === undefined) return undefined;
  const resolved = await result;
  if (resolved.ok) return resolved.value;
  throw new DesktopComputerAutomationError(resolved.error);
}

export interface PreviewAutomationOperationContext {
  readonly requestId: PreviewAutomationRequest["requestId"];
  readonly operation: PreviewAutomationRequest["operation"];
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly threadId: PreviewAutomationRequest["threadId"];
  readonly tabId: Exclude<PreviewAutomationRequest["tabId"], undefined> | null;
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

export class PreviewAutomationOperationError extends Schema.TaggedError<PreviewAutomationOperationError>()(
  "PreviewAutomationOperationError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    failureKind: Schema.optional(ComputerAutomationFailureKind),
    computerFailure: Schema.optional(ComputerAutomationFailure),
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    input: PreviewAutomationOperationContext & { readonly cause: unknown },
  ): PreviewAutomationHostError {
    if (isPreviewAutomationHostError(input.cause)) return input.cause;
    const computerFailure =
      input.cause instanceof DesktopComputerAutomationError ? input.cause.failure : undefined;
    const kind =
      computerFailure !== undefined &&
      (computerFailure.code === "display-inactive" ||
        computerFailure.code === "display-locked" ||
        computerFailure.code === "keep-awake-denied")
        ? computerFailure.code
        : input.operation.startsWith("computer")
          ? findComputerAutomationFailureKind(input.cause)
          : undefined;
    return new PreviewAutomationOperationError({
      ...input,
      ...(kind === undefined ? {} : { failureKind: kind }),
      ...(computerFailure === undefined ? {} : { computerFailure }),
    });
  }

  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} failed on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"}).`;
  }
}

export const PreviewAutomationHostError = Schema.Union([
  PreviewAutomationComputerControllerRequiredError,
  PreviewAutomationOperationError,
]);
export type PreviewAutomationHostError = typeof PreviewAutomationHostError.Type;

const isPreviewAutomationHostError = Schema.is(PreviewAutomationHostError);

export function serializePreviewAutomationHostError(
  error: PreviewAutomationHostError,
): NonNullable<PreviewAutomationResponse["error"]> {
  const detail = Object.fromEntries(
    Object.entries(error).filter(
      ([key]) =>
        key !== "_tag" && key !== "cause" && key !== "name" && key !== "message" && key !== "stack",
    ),
  );
  return {
    _tag: error.responseTag,
    message: error.message,
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}

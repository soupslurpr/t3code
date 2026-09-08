import {
  ComputerAutomationFailure,
  ComputerAutomationFailureKind,
  type DesktopComputerAutomationResult,
  DesktopPreviewAutomationFailureTag,
  type DesktopPreviewAutomationEvaluationResult,
  PreviewAutomationEvaluationMessage,
  type DesktopPreviewAutomationCommandResult,
  EnvironmentId,
  findComputerAutomationFailureKind,
  type PreviewAutomationHost,
  PreviewAutomationOperation,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  PreviewTabId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Recognizes the bounded failure tags preserved by the desktop bridge. */
const isDesktopPreviewAutomationFailureTag = Schema.is(DesktopPreviewAutomationFailureTag);

/** Validates the exception summary explicitly preserved by the desktop bridge. */
const decodeEvaluationFailure = Schema.decodeUnknownOption(
  Schema.TaggedStruct("PreviewAutomationEvaluationError", {
    evaluationMessage: PreviewAutomationEvaluationMessage,
  }),
);

/** Unwraps evaluation values without interpreting objects returned by page JavaScript. */
export async function resolveDesktopPreviewAutomationEvaluation(
  result: Promise<DesktopPreviewAutomationEvaluationResult>,
): Promise<unknown> {
  const resolved = await result;
  if (resolved.ok) return resolved.value;
  throw resolved.error;
}

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

/** Unwraps target failures in the renderer after the context bridge copies their data. */
export async function resolveDesktopPreviewAutomation(
  result: Promise<DesktopPreviewAutomationCommandResult>,
): Promise<void> {
  const resolved = await result;
  if (resolved !== undefined) throw resolved.error;
}

export interface PreviewAutomationOperationContext {
  readonly requestId: PreviewAutomationRequest["requestId"];
  readonly operation: PreviewAutomationRequest["operation"];
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly threadId: PreviewAutomationRequest["threadId"];
  readonly tabId: Exclude<PreviewAutomationRequest["tabId"], undefined> | null;
}

export class PreviewAutomationOverlayTimeoutError extends Schema.TaggedError<PreviewAutomationOverlayTimeoutError>()(
  "PreviewAutomationOverlayTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview webview for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} did not register within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationNavigationTimeoutError extends Schema.TaggedError<PreviewAutomationNavigationTimeoutError>()(
  "PreviewAutomationNavigationTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    readiness: Schema.Literals(["domContentLoaded", "load"]),
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview navigation for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} tab ${this.tabId} did not reach ${this.readiness} readiness within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationViewportTimeoutError extends Schema.TaggedError<PreviewAutomationViewportTimeoutError>()(
  "PreviewAutomationViewportTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview viewport for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} tab ${this.tabId} was not rendered within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationTargetUnavailableError extends Schema.TaggedError<PreviewAutomationTargetUnavailableError>()(
  "PreviewAutomationTargetUnavailableError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    bridgeAvailable: Schema.Boolean,
  },
) {
  get responseTag() {
    return "PreviewAutomationTabNotFoundError" as const;
  }

  override get message(): string {
    return `Preview automation target for ${this.operation} request ${this.requestId} is unavailable on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"}, bridge ${this.bridgeAvailable ? "available" : "unavailable"}).`;
  }
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

export class PreviewAutomationRecordingNotActiveError extends Schema.TaggedError<PreviewAutomationRecordingNotActiveError>()(
  "PreviewAutomationRecordingNotActiveError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
  },
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation request ${this.requestId} found no active recording for tab ${this.tabId ?? "unassigned"} on environment ${this.environmentId} thread ${this.threadId}.`;
  }
}

export class PreviewAutomationTargetNotEditableHostError extends Schema.TaggedError<PreviewAutomationTargetNotEditableHostError>()(
  "PreviewAutomationTargetNotEditableHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  get responseTag() {
    return "PreviewAutomationTargetNotEditableError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} requires an editable target in tab ${this.tabId ?? "unassigned"}.`;
  }
}

const targetNotEditableDiagnostics = (
  cause: unknown,
): {
  readonly selectorKind?: "focused-element" | "locator" | "selector";
  readonly selectorLength?: number;
} | null => {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("_tag" in cause) ||
    cause._tag !== "PreviewAutomationTargetNotEditableError"
  ) {
    return null;
  }
  const selectorKind =
    "selectorKind" in cause &&
    (cause.selectorKind === "focused-element" ||
      cause.selectorKind === "locator" ||
      cause.selectorKind === "selector")
      ? cause.selectorKind
      : undefined;
  const selectorLength =
    "selectorLength" in cause &&
    typeof cause.selectorLength === "number" &&
    Number.isInteger(cause.selectorLength) &&
    cause.selectorLength >= 0
      ? cause.selectorLength
      : undefined;
  return {
    ...(selectorKind === undefined ? {} : { selectorKind }),
    ...(selectorLength === undefined ? {} : { selectorLength }),
  };
};

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
    evaluationMessage: Schema.optional(PreviewAutomationEvaluationMessage),
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    input: PreviewAutomationOperationContext & { readonly cause: unknown },
  ): PreviewAutomationHostError {
    if (isPreviewAutomationHostError(input.cause)) return input.cause;
    const diagnostics = targetNotEditableDiagnostics(input.cause);
    if (diagnostics) {
      return new PreviewAutomationTargetNotEditableHostError({
        requestId: input.requestId,
        operation: input.operation,
        environmentId: input.environmentId,
        threadId: input.threadId,
        tabId: input.tabId,
        ...diagnostics,
      });
    }
    const evaluationFailure = Option.getOrUndefined(decodeEvaluationFailure(input.cause));
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
      ...(evaluationFailure === undefined
        ? {}
        : { evaluationMessage: evaluationFailure.evaluationMessage }),
      ...(kind === undefined ? {} : { failureKind: kind }),
      ...(computerFailure === undefined ? {} : { computerFailure }),
    });
  }

  get responseTag() {
    if (
      typeof this.cause === "object" &&
      this.cause !== null &&
      "_tag" in this.cause &&
      isDesktopPreviewAutomationFailureTag(this.cause._tag)
    ) {
      return this.cause._tag;
    }
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} failed on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"}).`;
  }
}

export const PreviewAutomationHostError = Schema.Union([
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationViewportTimeoutError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationComputerControllerRequiredError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetNotEditableHostError,
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
    _tag: "responseTag" in error ? error.responseTag : error._tag,
    message: error.message,
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}

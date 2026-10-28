/** Only a native same-account child receives these private authorization descriptors. */
import * as Schema from "effect/Schema";
import { AuthSessionId, EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopThreadLifecycle } from "./desktopAuthorization.ts";
import { UserDesktopExecutionInput, UserDesktopExecutionResult } from "./desktopExecution.ts";
import { UserDesktopTarget } from "./userDesktop.ts";

export class DesktopAuthorizationError extends Schema.TaggedError<DesktopAuthorizationError>()(
  "DesktopAuthorizationError",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

export const DesktopExecutionAuthorizationCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), environmentId: EnvironmentId }),
  Schema.Struct({
    type: Schema.Literal("invoke"),
    invocationId: TrimmedNonEmptyString,
    generation: TrimmedNonEmptyString,
    sessionId: AuthSessionId,
    threadId: ThreadId,
    lifecycle: Schema.optional(DesktopThreadLifecycle),
    input: UserDesktopExecutionInput,
  }),
]);
export type DesktopExecutionAuthorizationCommand = typeof DesktopExecutionAuthorizationCommand.Type;

export const DesktopExecutionAuthorizationEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    generation: TrimmedNonEmptyString,
    desktop: UserDesktopTarget,
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    invocationId: TrimmedNonEmptyString,
    value: UserDesktopExecutionResult,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    invocationId: TrimmedNonEmptyString,
    code: Schema.String,
    message: Schema.String,
  }),
]);
export type DesktopExecutionAuthorizationEvent = typeof DesktopExecutionAuthorizationEvent.Type;

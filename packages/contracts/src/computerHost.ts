import { DesktopProcessActivity } from "./desktopProcessActivity.ts";
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopThreadLifecycle } from "./desktopAuthorization.ts";
import {
  ComputerAutomationControllerKind,
  ComputerAutomationFailure,
  COMPUTER_AUTOMATION_OPERATIONS,
} from "./computerStatus.ts";
import { PreviewAutomationClientId, PreviewAutomationConnectionId } from "./previewAutomation.ts";
import { UserDesktopHostRegistration } from "./userDesktop.ts";

export const ComputerHostOperation = Schema.Literals(COMPUTER_AUTOMATION_OPERATIONS);
export type ComputerHostOperation = typeof ComputerHostOperation.Type;

const HostIdentity = { clientId: PreviewAutomationClientId, environmentId: EnvironmentId };

export const ComputerHostRegistration = Schema.Struct({
  ...HostIdentity,
  supportsPermissionPreparation: Schema.optionalKey(Schema.Literal(true)),
  authorizationVersion: Schema.optionalKey(Schema.Literal(2)),
  userDesktop: UserDesktopHostRegistration,
  // Older attached hosts also advertise browser operations on this wire method.
  supportedOperations: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(128),
  ),
});
export type ComputerHostRegistration = typeof ComputerHostRegistration.Type;

export const ComputerHostFocus = Schema.Struct({
  ...HostIdentity,
  connectionId: PreviewAutomationConnectionId,
  focused: Schema.Boolean,
  processActivities: Schema.optionalKey(
    Schema.Array(DesktopProcessActivity).check(Schema.isMaxLength(256)),
  ),
  authorizationThreads: Schema.optionalKey(Schema.Array(ThreadId).check(Schema.isMaxLength(4096))),
});
export type ComputerHostFocus = typeof ComputerHostFocus.Type;

export const ComputerHostRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  controllerId: TrimmedNonEmptyString,
  controllerKind: ComputerAutomationControllerKind,
  connectionGeneration: PreviewAutomationConnectionId,
  lifecycle: Schema.optionalKey(DesktopThreadLifecycle),
  operation: ComputerHostOperation,
  input: Schema.Unknown,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ComputerHostRequest = typeof ComputerHostRequest.Type;

export const ComputerHostEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: PreviewAutomationConnectionId }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: PreviewAutomationConnectionId,
    request: ComputerHostRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("cancel"),
    connectionId: PreviewAutomationConnectionId,
    requestId: TrimmedNonEmptyString,
    preserveDesktopAccess: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    type: Schema.Literal("lifecycle"),
    connectionId: PreviewAutomationConnectionId,
    snapshots: Schema.Array(DesktopThreadLifecycle),
    unavailableThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
    unavailable: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type ComputerHostEvent = typeof ComputerHostEvent.Type;

export class ComputerHostError extends Schema.TaggedError<ComputerHostError>()(
  "ComputerHostError",
  {
    computerFailure: ComputerAutomationFailure,
  },
) {
  override get message() {
    return this.computerFailure.message;
  }
}

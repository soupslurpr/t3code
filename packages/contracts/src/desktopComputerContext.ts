import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ComputerAutomationControllerKind } from "./computerStatus.ts";
import { DesktopThreadLifecycle } from "./desktopAuthorization.ts";

export const DesktopComputerAutomationContextSchema = Schema.Struct({
  controllerId: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  controllerKind: Schema.optionalKey(ComputerAutomationControllerKind),
  environmentId: Schema.optionalKey(EnvironmentId),
  threadId: Schema.optionalKey(ThreadId),
  lifecycle: Schema.optionalKey(DesktopThreadLifecycle),
  connectionGeneration: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DesktopComputerAutomationContext = typeof DesktopComputerAutomationContextSchema.Type;

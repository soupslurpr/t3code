/** A status-only milestone; neither output traffic nor reads produce activity. */
import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopProcessActivity = Schema.Struct({
  activityId: TrimmedNonEmptyString,
  desktop: Schema.Struct({
    kind: Schema.Literals(["user", "agent"]),
    desktopId: TrimmedNonEmptyString,
  }),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  processId: TrimmedNonEmptyString,
  commandId: TrimmedNonEmptyString,
  runtimeGeneration: TrimmedNonEmptyString,
  phase: Schema.Literals(["started", "input", "completed"]),
  status: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
});
export type DesktopProcessActivity = typeof DesktopProcessActivity.Type;

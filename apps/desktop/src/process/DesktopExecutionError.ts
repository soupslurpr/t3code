import * as Schema from "effect/Schema";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
export interface ProcessOwner {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}
export class DesktopExecutionError extends Schema.TaggedError<DesktopExecutionError>()(
  "DesktopExecutionError",
  { code: Schema.String, message: Schema.String },
) {}

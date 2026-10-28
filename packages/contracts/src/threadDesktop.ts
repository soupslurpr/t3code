import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";

/** Bounded command history and live transfer progress for one owning conversation. */
export const ThreadDesktopCommand = Schema.Struct({
  id: Schema.String,
  tool: Schema.String,
  status: Schema.String,
  updatedAt: IsoDateTime,
  input: Schema.String,
  output: Schema.String,
});
export const ThreadDesktopActivity = Schema.Struct({
  commands: Schema.Array(ThreadDesktopCommand),
  transfers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      state: Schema.String,
      transferredBytes: Schema.Number,
      totalBytes: Schema.NullOr(Schema.Number),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ThreadDesktopActivity = typeof ThreadDesktopActivity.Type;
export class ThreadDesktopActivityError extends Schema.TaggedError<ThreadDesktopActivityError>()(
  "ThreadDesktopActivityError",
  { message: Schema.String },
) {}

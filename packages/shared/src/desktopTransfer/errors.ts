import * as Schema from "effect/Schema";
import { UserDesktopTransferFailure } from "@t3tools/contracts";

export class DesktopTransferError extends Schema.TaggedError<DesktopTransferError>()(
  "DesktopTransferError",
  { code: UserDesktopTransferFailure.fields.code, message: Schema.String },
) {}

export const isDesktopTransferError = Schema.is(DesktopTransferError);

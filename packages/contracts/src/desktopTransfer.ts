/** Copies files through an explicitly selected desktop's existing connection. */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  AgentDesktopTransfer,
  AgentDesktopTransferFailure,
  AgentDesktopTransferTree,
} from "./agentDesktop.ts";
import { UserDesktopTarget } from "./userDesktop.ts";

export const DESKTOP_TRANSFER_ROUTE_PREFIX = "/api/user-desktop-transfers";
export const DESKTOP_TRANSFER_MANIFEST_HEADER = "x-t3-transfer-manifest";
const Identifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
const Path = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(32_768),
  Schema.isPattern(/^[^\0]*$/),
);
const Direction = Schema.Literals(["to-desktop", "from-desktop"]);
const Collision = Schema.Literals(["create", "replace", "merge"]);
const Compression = Schema.Literals(["auto", "none", "gzip"]);
const WaitMs = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })));
const TimeoutMs = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 21_600_000 }));

export const UserDesktopCopyInput = Schema.Struct({
  desktop: UserDesktopTarget,
  copyId: Identifier.annotate({
    description:
      "Unique retry ID. Repeating the same ID and copy returns the original transfer; different paths or options are rejected.",
  }),
  direction: Direction,
  workspacePath: Path.annotate({ description: "Path relative to this thread's workspace." }),
  desktopPath: Path.annotate({
    description:
      "Absolute path or a path relative to the selected desktop account's home directory.",
  }),
  collision: Schema.optional(Collision),
  compression: Schema.optional(Compression),
  waitMs: WaitMs,
  timeoutMs: Schema.optional(TimeoutMs),
});
export type UserDesktopCopyInput = typeof UserDesktopCopyInput.Type;

export const UserDesktopTransferTargetInput = Schema.Struct({
  transferId: Identifier,
  waitMs: WaitMs,
});
export type UserDesktopTransferTargetInput = typeof UserDesktopTransferTargetInput.Type;

export const UserDesktopTransferFailure = Schema.Struct({
  ...AgentDesktopTransferFailure.fields,
  code: Schema.Union([
    AgentDesktopTransferFailure.fields.code,
    Schema.Literal("permission-denied"),
  ]),
});
export type UserDesktopTransferFailure = typeof UserDesktopTransferFailure.Type;

export const UserDesktopTransfer = Schema.Struct({
  id: Identifier,
  copyId: Identifier,
  desktop: UserDesktopTarget,
  direction: Direction,
  workspacePath: Path,
  desktopPath: Path,
  collision: Collision,
  state: AgentDesktopTransfer.fields.state,
  compression: AgentDesktopTransfer.fields.compression,
  transferredBytes: NonNegativeInt,
  totalBytes: Schema.NullOr(NonNegativeInt),
  tree: Schema.NullOr(AgentDesktopTransferTree),
  sha256: AgentDesktopTransfer.fields.sha256,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(UserDesktopTransferFailure),
});
export type UserDesktopTransfer = typeof UserDesktopTransfer.Type;

export class UserDesktopTransferRequestError extends Schema.TaggedError<UserDesktopTransferRequestError>()(
  "UserDesktopTransferRequestError",
  { message: Schema.String.check(Schema.isMaxLength(1024)) },
) {}

/** Metadata is small; archive bytes travel only on the streaming HTTP connection. */
export const DesktopTransferManifest = Schema.Struct({
  ...AgentDesktopTransferTree.fields,
  archiveBytes: NonNegativeInt,
  wireBytes: NonNegativeInt,
  compression: Schema.Literals(["none", "gzip"]),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type DesktopTransferManifest = typeof DesktopTransferManifest.Type;

/** The renderer resolves this path against its current authenticated environment. */
export const UserDesktopTransferRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("run"),
    desktop: UserDesktopTarget,
    transferId: Identifier,
    direction: Direction,
    desktopPath: Path,
    collision: Collision,
    compression: Compression,
    timeoutMs: TimeoutMs,
    url: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8192)),
    token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    manifest: Schema.optional(DesktopTransferManifest),
  }),
  Schema.Struct({
    operation: Schema.Literal("cancel"),
    desktop: UserDesktopTarget,
    transferId: Identifier,
  }),
]);
export type UserDesktopTransferRequest = typeof UserDesktopTransferRequest.Type;

export const UserDesktopTransferResult = Schema.Struct({
  transferId: Identifier,
  cancelled: Schema.Boolean,
  manifest: Schema.optional(DesktopTransferManifest),
});
export type UserDesktopTransferResult = typeof UserDesktopTransferResult.Type;

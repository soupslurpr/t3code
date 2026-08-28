import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MAX_USER_DESKTOPS = 256;

/** Identifies one durable user desktop exposed by a T3 desktop client. */
export const UserDesktopId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type UserDesktopId = typeof UserDesktopId.Type;

/** Names one user desktop without treating the label as its identity. */
export const UserDesktopLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type UserDesktopLabel = typeof UserDesktopLabel.Type;

/** Describes the operating system hosting a user desktop. */
export const UserDesktopPlatform = Schema.Literals(["linux", "macos", "windows", "unknown"]);
export type UserDesktopPlatform = typeof UserDesktopPlatform.Type;

/** Advertises coarse computer-use capabilities without granting access. */
export const UserDesktopCapability = Schema.Literals(["view", "control", "availability"]);
export type UserDesktopCapability = typeof UserDesktopCapability.Type;

/** Registers one current user-desktop protocol host with an environment. */
export const UserDesktopHostRegistration = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  desktopId: UserDesktopId,
  defaultLabel: UserDesktopLabel,
  platform: UserDesktopPlatform,
  capabilities: Schema.Array(UserDesktopCapability).check(Schema.isMaxLength(3)),
});
export type UserDesktopHostRegistration = typeof UserDesktopHostRegistration.Type;

/** Selects one concrete user desktop for computer use. */
export const UserDesktopTarget = Schema.Struct({
  kind: Schema.Literal("user"),
  desktopId: UserDesktopId,
});
export type UserDesktopTarget = typeof UserDesktopTarget.Type;

/** Presents one known user desktop without exposing screen or network contents. */
export const UserDesktopView = Schema.Struct({
  desktop: UserDesktopTarget,
  label: UserDesktopLabel,
  defaultLabel: UserDesktopLabel,
  platform: UserDesktopPlatform,
  capabilities: Schema.Array(UserDesktopCapability).check(Schema.isMaxLength(3)),
  connectionState: Schema.Literals(["online", "offline", "identity-conflict"]),
  lastSeenAt: IsoDateTime,
  t3Focused: Schema.Boolean,
  lastActiveAt: Schema.NullOr(IsoDateTime),
});
export type UserDesktopView = typeof UserDesktopView.Type;

/** Lists durable user desktops and incompatible connected clients. */
export const UserDesktopList = Schema.Struct({
  desktops: Schema.Array(UserDesktopView).check(Schema.isMaxLength(MAX_USER_DESKTOPS)),
  incompatibleClientCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type UserDesktopList = typeof UserDesktopList.Type;

/** Renames one user desktop within an environment. */
export const UserDesktopRenameInput = Schema.Struct({
  desktopId: UserDesktopId,
  label: UserDesktopLabel,
});
export type UserDesktopRenameInput = typeof UserDesktopRenameInput.Type;

/** Removes one offline user desktop from an environment's known inventory. */
export const UserDesktopRemoveInput = Schema.Struct({
  desktopId: UserDesktopId,
});
export type UserDesktopRemoveInput = typeof UserDesktopRemoveInput.Type;

/** Reports that the environment could not read its durable user-desktop inventory. */
export class UserDesktopInventoryError extends Schema.TaggedErrorClass<UserDesktopInventoryError>()(
  "UserDesktopInventoryError",
  {
    code: Schema.Literal("user-desktop-inventory-unavailable"),
    detail: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Reports a rejected user-desktop inventory mutation. */
export class UserDesktopManagementError extends Schema.TaggedErrorClass<UserDesktopManagementError>()(
  "UserDesktopManagementError",
  {
    code: Schema.Literals(["user-desktop-not-found", "user-desktop-online"]),
    desktopId: UserDesktopId,
    detail: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

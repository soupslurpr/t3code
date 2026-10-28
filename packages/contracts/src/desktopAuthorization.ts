import { DesktopProcessActivity } from "./desktopProcessActivity.ts";
/** T3 capability grants are separate from native screen consent and process ownership. */
import * as Schema from "effect/Schema";
import { UserDesktopTarget } from "./userDesktop.ts";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const DesktopGrantScope = Schema.Literals(["thread", "environment", "desktop"]);
export type DesktopGrantScope = typeof DesktopGrantScope.Type;
export const DesktopGrantCapability = Schema.Literals(["execution", "view", "control"]);
export type DesktopGrantCapability = typeof DesktopGrantCapability.Type;
export const DesktopGrantLifetime = Schema.Literals(["automatic", "until-time", "until-revoked"]);
export type DesktopGrantLifetime = typeof DesktopGrantLifetime.Type;

/** Display metadata never participates in permission identity or coverage. */
export const DesktopPermissionSource = Schema.Struct({
  environmentLabel: Schema.String.check(Schema.isMaxLength(256)),
  threadTitle: Schema.String.check(Schema.isMaxLength(256)),
  projectName: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
});
export type DesktopPermissionSource = typeof DesktopPermissionSource.Type;

/** Committed source state, translated by elapsed age rather than comparing machine clocks. */
export const DesktopThreadLifecycle = Schema.Struct({
  source: Schema.optional(DesktopPermissionSource),
  version: Schema.Literal(2),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  revision: NonNegativeInt,
  activityRevision: NonNegativeInt,
  state: Schema.Literals(["active", "settled", "deleted"]),
  serverNow: IsoDateTime,
  activityAt: Schema.NullOr(IsoDateTime),
  settledAt: Schema.NullOr(IsoDateTime),
});
export type DesktopThreadLifecycle = typeof DesktopThreadLifecycle.Type;

export const DesktopGrantPolicy = Schema.Struct({
  scope: DesktopGrantScope,
  lifetime: DesktopGrantLifetime,
  remembered: Schema.Boolean,
  /** A deliberate absolute bound, also usable with automatic and until-revoked access. */
  deadline: Schema.NullOr(IsoDateTime),
});
export type DesktopGrantPolicy = typeof DesktopGrantPolicy.Type;

/** Only the current logical revision is active; accepted jobs retain their own provenance. */
export const DesktopCapabilityGrant = Schema.Struct({
  source: Schema.optional(DesktopPermissionSource),
  grantId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  capability: DesktopGrantCapability,
  ...DesktopGrantPolicy.fields,
  environmentId: Schema.NullOr(EnvironmentId),
  threadId: Schema.NullOr(ThreadId),
  issuedAt: IsoDateTime,
  expiresAt: Schema.NullOr(IsoDateTime),
  absoluteExpiresAt: Schema.NullOr(IsoDateTime),
  idleExpiresAt: Schema.NullOr(IsoDateTime),
  settledExpiresAt: Schema.NullOr(IsoDateTime),
  sourceRevision: Schema.NullOr(NonNegativeInt),
  activityRevision: Schema.NullOr(NonNegativeInt),
  sourceState: Schema.NullOr(Schema.Literals(["active", "settled"])),
  suspended: Schema.Boolean,
  migrated: Schema.Boolean,
});
export type DesktopCapabilityGrant = typeof DesktopCapabilityGrant.Type;

export const DesktopScreenPendingApproval = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  source: Schema.optional(DesktopPermissionSource),
  capability: Schema.Literals(["view", "control"]),
  expiresAt: IsoDateTime,
  proposedPolicy: DesktopGrantPolicy,
  requiresLocalApproval: Schema.optional(Schema.Boolean),
});
export type DesktopScreenPendingApproval = typeof DesktopScreenPendingApproval.Type;

export const DesktopScreenAuthorization = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  grants: Schema.Array(DesktopCapabilityGrant),
  pendingRequests: Schema.optional(Schema.Array(DesktopScreenPendingApproval)),
  remoteApprovalAvailable: Schema.optional(Schema.Boolean),
});
export type DesktopScreenAuthorization = typeof DesktopScreenAuthorization.Type;

export const DesktopScreenPermissionRequest = Schema.Struct({
  action: Schema.Literals(["status", "request", "edit", "remove", "approve", "deny"]),
  capability: Schema.optional(Schema.Literals(["view", "control"])),
  permission: Schema.optional(
    Schema.Struct({ grantId: TrimmedNonEmptyString, revision: NonNegativeInt }),
  ),
  policy: Schema.optional(DesktopGrantPolicy),
  requestId: Schema.optional(TrimmedNonEmptyString),
  localPrompt: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((input) => {
    if (input.action === "status") return true;
    if (input.action === "approve" || input.action === "deny")
      return (
        input.requestId !== undefined && (input.action === "deny" || input.policy !== undefined)
      );
    if ((input.action === "edit" || input.action === "remove") && input.permission === undefined)
      return false;
    return (
      input.action === "remove" || (input.capability !== undefined && input.policy !== undefined)
    );
  }),
);
export type DesktopScreenPermissionRequest = typeof DesktopScreenPermissionRequest.Type;
export const isDesktopScreenPermissionRequest = Schema.is(DesktopScreenPermissionRequest);
export const DesktopScreenPermissionInput = Schema.Struct({
  desktop: UserDesktopTarget,
  ...DesktopScreenPermissionRequest.fields,
}).check(Schema.makeFilter(isDesktopScreenPermissionRequest));
export type DesktopScreenPermissionInput = typeof DesktopScreenPermissionInput.Type;

/** Desktop-host lifecycle synchronization, separate from human policy decisions. */
export const DesktopAuthorizationSyncInput = Schema.Struct({
  operation: Schema.Literals([
    "connected",
    "reconcile",
    "disconnected",
    "unavailable",
    "references",
    "acknowledge",
  ]),
  environmentId: EnvironmentId,
  connectionGeneration: TrimmedNonEmptyString,
  activityIds: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(256))),
  snapshots: Schema.optional(Schema.Array(DesktopThreadLifecycle).check(Schema.isMaxLength(256))),
  threadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(256))),
});
export type DesktopAuthorizationSyncInput = typeof DesktopAuthorizationSyncInput.Type;
export const DesktopAuthorizationReferences = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
  activities: Schema.optional(Schema.Array(DesktopProcessActivity)),
});
export type DesktopAuthorizationReferences = typeof DesktopAuthorizationReferences.Type;

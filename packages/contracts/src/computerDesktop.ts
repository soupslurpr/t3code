import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UserDesktopId, UserDesktopTarget } from "./userDesktop.ts";
/** Identifies one durable desktop owned by the local T3 desktop runtime. */
export const AgentDesktopId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type AgentDesktopId = typeof AgentDesktopId.Type;

/** Identifies one agent controller without exposing provider credentials. */
export const AgentDesktopControllerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type AgentDesktopControllerId = typeof AgentDesktopControllerId.Type;

/** Selects one explicit user desktop or an independently managed Agent desktop. */
export const ComputerDesktopSelector = Schema.Union([
  UserDesktopTarget,
  Schema.Struct({
    kind: Schema.Literal("agent"),
    desktopId: Schema.optional(AgentDesktopId),
    fresh: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Create a clean desktop instead of reusing a suitable prior desktop from this thread.",
      }),
    ),
  }).check(
    Schema.makeFilter(
      (input) =>
        input.desktopId === undefined ||
        input.fresh !== true ||
        "desktopId and fresh cannot be combined.",
    ),
  ),
]).annotate({
  description:
    "Desktop to use. An agent target without desktopId prefers this controller's assignment, then a suitable idle desktop from the same thread.",
});
export type ComputerDesktopSelector = typeof ComputerDesktopSelector.Type;

/** Targets one existing desktop without creating or changing an assignment. */
export const ComputerDesktopTarget = Schema.Union([
  UserDesktopTarget,
  Schema.Struct({
    kind: Schema.Literal("agent"),
    desktopId: AgentDesktopId,
  }),
]).annotate({
  description: "Select a concrete desktop using the ID from the listing or access response.",
});
export type ComputerDesktopTarget = typeof ComputerDesktopTarget.Type;

/** Describes the concrete desktop selected for one computer-use session. */
export const ComputerDesktopIdentity = Schema.Struct({
  id: Schema.Union([UserDesktopId, AgentDesktopId]),
  kind: Schema.Literals(["user", "agent"]),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type ComputerDesktopIdentity = typeof ComputerDesktopIdentity.Type;

/** Records the durable thread boundary and the controller currently claiming a desktop. */
export const AgentDesktopOwner = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  controllerId: AgentDesktopControllerId,
});
export type AgentDesktopOwner = typeof AgentDesktopOwner.Type;

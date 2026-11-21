import * as Schema from "effect/Schema";
import {
  AgentDesktopCreatePortRouteInput,
  AgentDesktopManageInput,
  AgentDesktopRemovePortRouteInput,
  AgentDesktopUpdateInput,
} from "./agentDesktop.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  ComputerAutomationActionBatchInput,
  ComputerAutomationObservationOptions,
} from "./computerAutomation.ts";
import { AgentDesktopId } from "./computerDesktop.ts";
import { ComputerObservationId } from "./computerObservation.ts";

const target = { desktopId: AgentDesktopId };

export const AgentDesktopHumanRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literals(["list", "setup"]) }),
  Schema.Struct({
    operation: Schema.Literal("inspect"),
    ...target,
    includeConnections: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    operation: Schema.Literal("manage"),
    input: AgentDesktopManageInput.check(
      Schema.makeFilter(
        (input) =>
          input.operation !== "handoff" || "Use return-control to hand input back to the agent.",
      ),
    ),
  }),
  Schema.Struct({ operation: Schema.Literal("update"), input: AgentDesktopUpdateInput }),
  Schema.Struct({
    operation: Schema.Literal("create-route"),
    input: Schema.Struct({ ...AgentDesktopCreatePortRouteInput.fields, ...target }),
  }),
  Schema.Struct({
    operation: Schema.Literal("remove-route"),
    input: Schema.Struct({ ...AgentDesktopRemovePortRouteInput.fields, ...target }),
  }),
  Schema.Struct({
    operation: Schema.Literals([
      "status",
      "request-view",
      "request-control",
      "return-control",
      "release",
      "observation-list",
    ]),
    ...target,
  }),
  Schema.Struct({
    operation: Schema.Literal("observation"),
    ...target,
    observationId: ComputerObservationId,
  }),
  Schema.Struct({
    operation: Schema.Literal("snapshot"),
    ...target,
    input: ComputerAutomationObservationOptions,
  }),
  Schema.Struct({
    operation: Schema.Literal("act"),
    ...target,
    input: ComputerAutomationActionBatchInput,
  }),
]);
export type AgentDesktopHumanRequest = typeof AgentDesktopHumanRequest.Type;
export const AgentDesktopHumanInvokeInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  request: AgentDesktopHumanRequest,
});
export type AgentDesktopHumanInvokeInput = typeof AgentDesktopHumanInvokeInput.Type;

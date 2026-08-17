/** Describes the exact visual and semantic computer input delivered to a model. */
import * as Schema from "effect/Schema";

import { AgentDesktopId } from "./agentDesktop.ts";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ComputerAutomationAccessibilitySnapshot,
  ComputerAutomationDesktopRegion,
  ComputerAutomationFrame,
  ComputerAutomationScreenshot,
} from "./computerAutomation.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ComputerObservationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerObservationId = typeof ComputerObservationId.Type;

export const ComputerObservationRecipient = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("controller"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("watch-evaluator"),
    monitorId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    modelSelection: ModelSelection,
  }),
]);
export type ComputerObservationRecipient = typeof ComputerObservationRecipient.Type;

export const ComputerObservationImage = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  role: Schema.Literals(["overview", "detail", "watch-region"]),
  purpose: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  generation: Schema.optional(
    Schema.Literals(["baseline", "previous", "current", "terminal", "fresh"]),
  ),
  capturedAt: IsoDateTime,
  frame: Schema.optional(ComputerAutomationFrame),
  region: Schema.optional(ComputerAutomationDesktopRegion),
  frameIndex: Schema.optional(NonNegativeInt),
  elapsedMs: Schema.optional(NonNegativeInt),
  screenshot: ComputerAutomationScreenshot,
}).check(
  Schema.makeFilter(
    (image) =>
      image.frame !== undefined ||
      image.region !== undefined ||
      "An observed image must include a frame or durable desktop region.",
  ),
);
export type ComputerObservationImage = typeof ComputerObservationImage.Type;

export const ComputerObservation = Schema.Struct({
  id: ComputerObservationId,
  desktopId: AgentDesktopId,
  threadId: ThreadId,
  observedAt: IsoDateTime,
  source: Schema.Literals([
    "request-view",
    "request-control",
    "snapshot",
    "act",
    "sequence",
    "watch-evaluation",
    "watch-inspection",
  ]),
  recipient: ComputerObservationRecipient,
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  images: Schema.Array(ComputerObservationImage).check(Schema.isMaxLength(256)),
  accessibility: Schema.optional(ComputerAutomationAccessibilitySnapshot),
});
export type ComputerObservation = typeof ComputerObservation.Type;

/** Returns only changed observation bytes while preserving the current cache identity. */
export const ComputerObservationUpdate = Schema.Struct({
  latestId: Schema.NullOr(ComputerObservationId),
  observation: Schema.optional(ComputerObservation),
});
export type ComputerObservationUpdate = typeof ComputerObservationUpdate.Type;

import type {
  ComputerAutomationObservation,
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  PreviewAutomationOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { ComputerImageToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

const STATUS_TIMEOUT_MS = 5_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 120_000;

const invoke = Effect.fn("ComputerToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs: number,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({ scope, operation, input, timeoutMs });
});

const handlers = {
  computer_status: McpToolAccess.readsAsCaller((input) =>
    invoke<ComputerAutomationStatus>("computerStatus", input, STATUS_TIMEOUT_MS),
  ),
  computer_request_availability: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationStatus>("computerRequestAvailability", input, CONTROL_TIMEOUT_MS),
  ),
  computer_release_availability: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationStatus>("computerReleaseAvailability", input, CONTROL_TIMEOUT_MS),
  ),
  computer_request_view: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationObservation>("computerRequestView", input, CONTROL_TIMEOUT_MS),
  ),
  computer_request_control: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationObservation>("computerRequestControl", input, CONTROL_TIMEOUT_MS),
  ),
  computer_snapshot: McpToolAccess.readsAsCaller((input) =>
    invoke<ComputerAutomationSnapshot>("computerSnapshot", input, SNAPSHOT_TIMEOUT_MS),
  ),
  computer_act: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationObservation>("computerAct", input, CONTROL_TIMEOUT_MS),
  ),
  computer_release: McpToolAccess.actsAsCaller((input) =>
    invoke<ComputerAutomationStatus>("computerRelease", input, CONTROL_TIMEOUT_MS),
  ),
  computer_forget_control: McpToolAccess.actsAsCaller((input) =>
    invoke<void>("computerForgetControl", input, CONTROL_TIMEOUT_MS).pipe(Effect.as(null)),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerToolkit.tools>;

const {
  computer_request_view,
  computer_request_control,
  computer_snapshot,
  computer_act,
  ...standardHandlers
} = handlers;

const imageHandlers = {
  computer_snapshot,
  computer_request_view,
  computer_request_control,
  computer_act,
};

export const ComputerStandardToolkitHandlersLive = McpToolAccess.toLayer(
  ComputerStandardToolkit,
  standardHandlers,
);

export const ComputerImageToolkitHandlersLive = McpToolAccess.toLayer(
  ComputerImageToolkit,
  imageHandlers,
);

export const ComputerToolkitHandlersLive = McpToolAccess.toLayer(ComputerToolkit, handlers);

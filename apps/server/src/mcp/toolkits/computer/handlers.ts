import * as Effect from "effect/Effect";
import * as ComputerAutomationRouter from "../../../computer/ComputerAutomationRouter.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerImageToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

const handlers = {
  computer_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.status(scope, input);
    }),
  ),
  computer_request_availability: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.requestAvailability(scope, input);
    }),
  ),
  computer_release_availability: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.releaseAvailability(scope, input);
    }),
  ),
  computer_request_view: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.requestView(scope, input);
    }),
  ),
  computer_request_control: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.requestControl(scope, input);
    }),
  ),
  computer_snapshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.snapshot(scope, input);
    }),
  ),
  computer_observe_sequence: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.observeSequence(scope, input);
    }),
  ),
  computer_act: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.act(scope, input);
    }),
  ),
  computer_release: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.release(scope, input);
    }),
  ),
  computer_forget_control: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer");
      const router = yield* ComputerAutomationRouter.ComputerAutomationRouter;
      return yield* router.forget(scope, input).pipe(Effect.as(null));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerToolkit.tools>;

const {
  computer_request_view,
  computer_request_control,
  computer_snapshot,
  computer_observe_sequence,
  computer_act,
  ...standardHandlers
} = handlers;

const imageHandlers = {
  computer_snapshot,
  computer_observe_sequence,
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

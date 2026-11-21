import {
  ThreadId,
  type AgentDesktopHumanInvokeInput,
  type AuthSessionId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { humanDesktopCaller } from "../computer/DesktopCaller.ts";
import { ComputerAutomationRouter } from "../computer/ComputerAutomationRouter.ts";
import { ComputerObservationStore } from "../computer/ComputerObservationStore.ts";
import { hostFailure } from "../computer/ComputerHostConnection.ts";
import { AgentDesktopService } from "./AgentDesktopService.ts";

export const invoke = Effect.fn("AgentDesktopHuman.invoke")(function* (
  environmentId: EnvironmentId,
  sessionId: AuthSessionId,
  { request, threadId }: AgentDesktopHumanInvokeInput,
) {
  const service = yield* AgentDesktopService;
  const session = yield* humanDesktopCaller(
    environmentId,
    sessionId,
    threadId ?? ThreadId.make("agent-desktop-settings"),
  );
  switch (request.operation) {
    case "list":
      return yield* service.list(session, true);
    case "setup":
      return yield* service.setup(session);
    case "update": {
      if (request.input.target.kind === "base-image")
        return yield* service.update(session, request.input);
      const owner = yield* service.resolveOwner(environmentId, request.input.target.desktopId);
      if (threadId !== undefined && owner.threadId !== threadId) return yield* wrongThread();
      return yield* service.update({ ...session, threadId: owner.threadId }, request.input, owner);
    }
  }
  const id = "desktopId" in request ? request.desktopId : request.input.desktopId;
  const owner = yield* service.resolveOwner(environmentId, id);
  if (threadId !== undefined && owner.threadId !== threadId) return yield* wrongThread();
  switch (request.operation) {
    case "manage":
    case "inspect":
    case "create-route":
    case "remove-route":
      return yield* service.superviseMachine(owner, request);
    case "observation-list":
    case "observation": {
      const store = yield* ComputerObservationStore;
      const target = { environmentId, desktopId: id };
      return "observationId" in request
        ? yield* store.readById({ ...target, observationId: request.observationId })
        : yield* store.list(target);
    }
  }
  const caller = { ...session, threadId: owner.threadId };
  const desktop = { kind: "agent", desktopId: id } as const;
  const router = yield* ComputerAutomationRouter;
  switch (request.operation) {
    case "status":
      return yield* router.status(caller, { desktop });
    case "snapshot":
      return yield* router.snapshot(caller, { desktop, ...request.input });
    case "act":
      return yield* router.act(caller, { desktop, ...request.input });
    case "release":
      return yield* router.release(caller, { desktop });
    case "request-view":
    case "request-control":
    case "return-control": {
      const params = { desktop, observation: false } as const;
      const result =
        request.operation === "request-view"
          ? yield* router.requestView(caller, params)
          : yield* router.requestControl(
              caller,
              request.operation === "return-control"
                ? { ...params, returnControlToAgent: true }
                : params,
            );
      return result.status ?? (yield* router.status(caller, { desktop }));
    }
  }
});
const wrongThread = () =>
  hostFailure(
    "desktop-target-mismatch",
    "authorization",
    "The selected Agent desktop belongs to another thread.",
  );

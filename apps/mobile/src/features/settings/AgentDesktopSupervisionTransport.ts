import type {
  AgentDesktopHumanInvokeInput,
  AgentDesktopId,
  AgentDesktopOwner,
  ComputerObservation,
  ComputerObservationUpdate,
  UserDesktopHumanInvokeInput,
} from "@t3tools/contracts";

/** Adapts the shared native viewer to isolated desktops without changing its input handling. */
export function createAgentDesktopSupervisionTransport(
  owner: AgentDesktopOwner,
  desktopId: AgentDesktopId,
  invoke: (input: AgentDesktopHumanInvokeInput) => Promise<unknown>,
) {
  let observation: ComputerObservation | null = null;
  const target = { owner, desktopId };
  const run = (request: AgentDesktopHumanInvokeInput["request"]) =>
    invoke({ threadId: owner.threadId, request });
  return async (input: UserDesktopHumanInvokeInput): Promise<unknown> => {
    const request = input.request;
    switch (request.operation) {
      case "observation-list": {
        const update = (await run({
          operation: "observation",
          ...target,
          ...(observation === null ? {} : { afterId: observation.id }),
        })) as ComputerObservationUpdate;
        if (update.observation) observation = update.observation;
        else if (update.latestId === null) observation = null;
        return {
          observations:
            observation === null
              ? []
              : [
                  {
                    id: observation.id,
                    desktopId,
                    threadId: owner.threadId,
                    observedAt: observation.observedAt,
                    source: observation.source,
                    recipient: observation.recipient,
                    imageCount: observation.images.length,
                    hasAccessibility: observation.accessibility !== undefined,
                  },
                ],
        };
      }
      case "observation":
        if (observation?.id !== request.observationId)
          throw new Error(
            "This Agent lens observation has expired. Select the latest observation.",
          );
        return { latestId: observation.id, observation };
      case "status":
      case "request-view":
      case "request-control":
      case "return-control":
      case "release":
        return run({ operation: request.operation, ...target });
      case "release-control":
        await run({ operation: "release", ...target });
        return run({ operation: "request-view", ...target });
      case "snapshot":
      case "act":
        return run({ ...request, ...target });
      default:
        throw new Error("This action is available in User desktop settings.");
    }
  };
}

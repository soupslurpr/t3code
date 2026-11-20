import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ComputerHostError, type AgentDesktopOwner } from "@t3tools/contracts";
import { toComputerAutomationFailure } from "@t3tools/shared/computerAutomationFailure";
import type { DesktopCaller } from "../computer/ComputerHostConnection.ts";

export const ownerOf = (caller: DesktopCaller): AgentDesktopOwner => ({
  environmentId: caller.environmentId,
  threadId: caller.threadId,
  controllerId: caller.controllerId,
});
const isHostError = Schema.is(ComputerHostError);

export const agentIo = <A>(fn: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      isHostError(cause)
        ? cause
        : new ComputerHostError({ computerFailure: toComputerAutomationFailure(cause) }),
  });

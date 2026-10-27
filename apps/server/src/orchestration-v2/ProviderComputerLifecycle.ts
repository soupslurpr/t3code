/** Optional desktop side effects at the provider lifecycle boundary. */
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";

export class ProviderComputerLifecycle extends Context.Reference<{
  readonly resume: (threadId: ThreadId) => Effect.Effect<void>;
  readonly beginInterruption: (input: {
    threadId: ThreadId;
    providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<Effect.Effect<void>>;
}>("t3/orchestration-v2/ProviderComputerLifecycle", {
  defaultValue: () => ({
    resume: () => Effect.void,
    beginInterruption: () => Effect.succeed(Effect.void),
  }),
}) {}

export const layer = Layer.effect(
  ProviderComputerLifecycle,
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    return {
      resume: (threadId) => broker.resumeThread({ environmentId, threadId }),
      beginInterruption: (input) =>
        broker.beginThreadInterruption({ environmentId, ...input }).pipe(
          Effect.map((cleanup) =>
            cleanup.pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("computer.turn.interrupt.failed", {
                      threadId: input.threadId,
                      cause,
                    }),
              ),
            ),
          ),
        ),
    };
  }),
);

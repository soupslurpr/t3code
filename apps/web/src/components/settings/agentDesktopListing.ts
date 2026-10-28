import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AgentDesktopList, EnvironmentId, ThreadId, type AgentDesktop } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";

const decodeEnvironmentIds = Schema.decodeSync(Schema.fromJsonString(Schema.Array(EnvironmentId)));
const decodeListing = Schema.decodeUnknownSync(AgentDesktopList);

export const agentDesktopListingAtom = Atom.family((environmentIds: string) =>
  Atom.make(
    Effect.promise(async () => {
      const results = await Promise.all(
        decodeEnvironmentIds(environmentIds).map(async (environmentId) => {
          try {
            const result = await runAtomCommand(
              appAtomRegistry,
              previewEnvironment.invokeAgentDesktopHuman,
              {
                environmentId,
                input: {
                  threadId: ThreadId.make("agent-desktop-settings"),
                  request: { operation: "list" },
                },
              },
              { reportFailure: false },
            );
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return { environmentId, value: decodeListing(result.value) } as const;
          } catch (cause) {
            return { environmentId, cause } as const;
          }
        }),
      );
      const desktops: AgentDesktop[] = [];
      const availability = new Map<EnvironmentId, Omit<AgentDesktopList, "desktops">>();
      let error: string | null = null;
      for (const result of results) {
        if ("value" in result) {
          availability.set(result.environmentId, result.value);
          desktops.push(...result.value.desktops);
        } else {
          availability.set(result.environmentId, { available: false, requirements: [] });
          error ??=
            result.cause instanceof Error
              ? result.cause.message
              : "The Agent desktop request failed.";
        }
      }
      desktops.sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
      return { desktops, availability, error };
    }),
  ).pipe(Atom.setIdleTTL(0)),
);

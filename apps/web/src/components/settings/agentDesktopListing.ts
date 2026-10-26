import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";

const decodeEnvironmentIds = Schema.decodeSync(Schema.fromJsonString(Schema.Array(EnvironmentId)));

import {
  decodeAgentDesktopListing,
  isAgentDesktopMaintenanceActive,
  type AgentDesktopView,
  type EnvironmentAvailability,
} from "./agentDesktopListingState";

export const agentDesktopListingAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) => {
    return Effect.promise(async () => {
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
            return { environmentId, value: decodeAgentDesktopListing(result.value) } as const;
          } catch (cause) {
            return { environmentId, cause } as const;
          }
        }),
      );
      const desktops: AgentDesktopView[] = [];
      const availability = new Map<EnvironmentId, EnvironmentAvailability>();
      let error: string | null = null;
      for (const result of results) {
        if ("value" in result) {
          availability.set(result.environmentId, result.value);
          desktops.push(...result.value.desktops);
        } else {
          availability.set(result.environmentId, {
            available: false,
            requirements: [],
            maintenanceSupported: false,
          });
          error ??=
            result.cause instanceof Error
              ? result.cause.message
              : "The Agent desktop request failed.";
        }
      }
      desktops.sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
      return { desktops, availability, error };
    }).pipe(
      Effect.tap(({ desktops, availability }) =>
        desktops.some((desktop) => isAgentDesktopMaintenanceActive(desktop.maintenance)) ||
        Array.from(availability.values()).some((status) =>
          isAgentDesktopMaintenanceActive(status.baseImage?.maintenance),
        )
          ? Effect.sleep("2 seconds").pipe(
              Effect.andThen(Effect.sync(() => get.refreshSelf())),
              Effect.forkScoped,
              Effect.asVoid,
            )
          : Effect.void,
      ),
    );
  }).pipe(Atom.setIdleTTL(0)),
);

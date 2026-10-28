import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type UserDesktopHumanInvokeInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import {
  decodeUserDesktopList,
  decodeUserDesktopAuditLog,
  decodeComputerStatus,
  type UserDesktopEntry,
} from "./userDesktopListingState";

const decodeEnvironmentIds = Schema.decodeSync(Schema.fromJsonString(Schema.Array(EnvironmentId)));

async function request(environmentId: EnvironmentId, input: UserDesktopHumanInvokeInput) {
  const result = await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.invokeUserDesktopHuman,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export const userDesktopListingAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    Effect.promise(async () => {
      const results = await Promise.all(
        decodeEnvironmentIds(environmentIds).map(async (environmentId) => {
          try {
            const list = decodeUserDesktopList(
              await request(environmentId, {
                request: { operation: "list", includeExecution: true },
              }),
            );
            const entries = await Promise.all(
              list.desktops.map(async (desktop): Promise<UserDesktopEntry> => {
                if (desktop.connectionState !== "online")
                  return { environmentId, desktop, status: null };
                try {
                  const status = decodeComputerStatus(
                    await request(environmentId, {
                      request: { operation: "status", desktopId: desktop.desktop.desktopId },
                    }),
                  );
                  return { environmentId, desktop, status };
                } catch {
                  return { environmentId, desktop, status: null };
                }
              }),
            );
            return { entries, incompatibleClientCount: list.incompatibleClientCount } as const;
          } catch (cause) {
            return { cause } as const;
          }
        }),
      );
      const entries = results.flatMap((result) => ("entries" in result ? result.entries : []));
      entries.sort(
        (left, right) =>
          Number(right.desktop.t3Focused) - Number(left.desktop.t3Focused) ||
          Number(right.desktop.connectionState === "online") -
            Number(left.desktop.connectionState === "online") ||
          right.desktop.lastSeenAt.localeCompare(left.desktop.lastSeenAt),
      );
      let error: string | null = null;
      let incompatibleClientCount = 0;
      for (const result of results) {
        if ("cause" in result)
          error ??=
            result.cause instanceof Error ? result.cause.message : "User desktop request failed.";
        else incompatibleClientCount += result.incompatibleClientCount;
      }
      return { entries, incompatibleClientCount, error };
    }).pipe(
      Effect.tap(() =>
        Effect.sleep("5 seconds").pipe(
          Effect.andThen(Effect.sync(() => get.refreshSelf())),
          Effect.forkScoped,
          Effect.asVoid,
        ),
      ),
    ),
  ).pipe(Atom.setIdleTTL(0)),
);

const decodeAuditTargets = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ environmentId: EnvironmentId, desktopId: Schema.String })),
  ),
);

export const userDesktopAuditAtom = Atom.family((targets: string) =>
  Atom.make(
    Effect.promise(async () =>
      (
        await Promise.all(
          decodeAuditTargets(targets).map(async ({ environmentId, desktopId }) => {
            try {
              const log = decodeUserDesktopAuditLog(
                await request(environmentId, { request: { operation: "audit", desktopId } }),
              );
              return log.events.map((event) => ({ environmentId, event }));
            } catch {
              return [];
            }
          }),
        )
      ).flat(),
    ),
  ).pipe(Atom.setIdleTTL(0)),
);

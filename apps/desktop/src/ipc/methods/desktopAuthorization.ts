import * as Stream from "effect/Stream";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  DesktopAuthorizationReferences,
  DesktopAuthorizationSyncInput,
  makeDesktopComputerAutomationResultSchema,
} from "@t3tools/contracts";
import { toComputerAutomationFailure } from "@t3tools/shared/computerAutomationFailure";
import * as Effect from "effect/Effect";

import * as Grants from "../../computer/DesktopGrants.ts";
import * as Channels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const sync = DesktopIpc.makeIpcMethod({
  channel: Channels.DESKTOP_AUTHORIZATION_CHANNEL,
  payload: DesktopAuthorizationSyncInput,
  result: makeDesktopComputerAutomationResultSchema(DesktopAuthorizationReferences),
  handler: Effect.fn("desktop.ipc.authorization.sync")(function* (input) {
    const grants = yield* Grants.DesktopGrants;
    const { environmentId, connectionGeneration } = input;
    return yield* Effect.gen(function* () {
      switch (input.operation) {
        case "connected":
          grants.connect(environmentId, connectionGeneration);
          break;
        case "disconnected":
          grants.disconnect(environmentId, connectionGeneration);
          break;
        case "unavailable":
          grants.invalidate(environmentId, connectionGeneration, input.threadIds);
          break;
        case "reconcile":
          if (grants.generation(environmentId) === connectionGeneration) {
            yield* grants.synchronizeBatch(
              (input.snapshots ?? []).filter((source) => source.environmentId === environmentId),
              connectionGeneration,
            );
          }
          break;
      }
      return { ok: true as const, value: { threadIds: grants.references(environmentId) } };
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({ ok: false as const, error: toComputerAutomationFailure(cause) }),
      ),
    );
  }),
});

export const installChangeNotifications = Effect.fn(
  "desktop.ipc.authorization.installChangeNotifications",
)(function* () {
  const grants = yield* Grants.DesktopGrants;
  const windows = yield* ElectronWindow.ElectronWindow;
  yield* grants.changes.pipe(
    Stream.runForEach(() => windows.sendAll(Channels.DESKTOP_AUTHORIZATION_CHANGED_CHANNEL)),
    Effect.forkScoped,
  );
});

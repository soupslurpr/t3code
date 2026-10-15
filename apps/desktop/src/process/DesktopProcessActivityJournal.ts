/** Retries finite command milestones across source reconnects and desktop restart. */
import { DesktopProcessActivity, type EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const Ledger = Schema.Struct({
  version: Schema.Literal(1),
  activities: Schema.Array(DesktopProcessActivity),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Ledger));
const encode = Schema.encodeEffect(Schema.fromJsonString(Ledger));
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const lock = yield* Semaphore.make(1);
  const file = environment.path.join(environment.stateDir, "desktop-process-activity.json");
  let activities: readonly DesktopProcessActivity[] = [];
  if (yield* fs.exists(file))
    activities = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decode),
      Effect.map((value) => value.activities),
      // Activity is a retry hint, never authorization or a command receipt. A
      // damaged hint must not prevent human recovery of already-consented work.
      Effect.catch((cause) =>
        Effect.logWarning("Desktop command activity could not be restored", cause).pipe(
          Effect.as([]),
        ),
      ),
    );
  const save = (next: readonly DesktopProcessActivity[]) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(environment.stateDir, { recursive: true });
      yield* fs.writeFileString(`${file}.new`, yield* encode({ version: 1, activities: next }), {
        mode: 0o600,
      });
      yield* fs.rename(`${file}.new`, file);
      activities = next;
    });
  return {
    record: (activity: DesktopProcessActivity) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (activities.some((entry) => entry.activityId === activity.activityId)) return;
          // Unacknowledged input milestones can coalesce; they are activity, not an input log.
          const previous = activities.filter(
            (entry) =>
              !(
                activity.phase === "input" &&
                entry.phase === "input" &&
                entry.processId === activity.processId &&
                entry.runtimeGeneration === activity.runtimeGeneration
              ),
          );
          yield* save([...previous, activity]);
        }),
      ),
    pending: (environmentId: EnvironmentId) =>
      activities.filter((activity) => activity.environmentId === environmentId).slice(0, 256),
    acknowledge: (environmentId: EnvironmentId, ids: readonly string[]) =>
      lock.withPermit(
        Effect.gen(function* () {
          const received = new Set(ids);
          yield* save(
            activities.filter(
              (activity) =>
                activity.environmentId !== environmentId || !received.has(activity.activityId),
            ),
          );
        }),
      ),
  };
});
export class DesktopProcessActivityJournal extends Context.Service<
  DesktopProcessActivityJournal,
  Effect.Success<typeof make>
>()("@t3tools/desktop/process/DesktopProcessActivityJournal") {}
export const layer = Layer.effect(DesktopProcessActivityJournal, make);

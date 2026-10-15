/** Retains only preauthorized completion metadata, independently of expiring grants. */
import {
  DesktopProcessCompletionReceipt,
  EnvironmentId,
  ThreadId,
  isDesktopProcessLive,
  type DesktopProcess,
  type UserDesktopCompletionInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const Registration = Schema.Struct({
  waitId: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  processId: Schema.String,
  runtimeGeneration: Schema.String,
  grantIds: Schema.Array(Schema.String),
  receipt: Schema.NullOr(DesktopProcessCompletionReceipt),
});
type Registration = typeof Registration.Type;
interface Owner {
  readonly environmentId: string;
  readonly threadId: string;
}
const Document = Schema.Struct({
  version: Schema.Literal(2),
  registrations: Schema.Array(Registration),
});
const encode = Schema.encodeEffect(Schema.fromJsonString(Document));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Document));
const identityKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class DesktopCompletionError extends Schema.TaggedError<DesktopCompletionError>()(
  "DesktopCompletionError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Completion wait: ${this.reason}.`;
  }
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* Semaphore.make(1);
  const file = environment.path.join(environment.stateDir, "desktop-completion-receipts.json");
  let registrations: ReadonlyArray<Registration> = [];
  let loadError: DesktopCompletionError | undefined;
  // A cancellation can arrive before an in-flight registration reaches this
  // service. Keep minimal tombstones for this native runtime; restart rejects
  // the old runtime generation independently.
  const retired = new Set<string>();
  if (yield* fs.exists(file).pipe(Effect.orDie)) {
    yield* fs.readFileString(file).pipe(
      Effect.flatMap(decode),
      Effect.match({
        onSuccess: (value) => {
          registrations = value.registrations;
        },
        onFailure: (cause) => {
          loadError = new DesktopCompletionError({ reason: "saved-waits-unavailable", cause });
        },
      }),
    );
  }
  const persist = (next: ReadonlyArray<Registration>) =>
    Effect.gen(function* () {
      const body = yield* encode({ version: 2, registrations: next });
      yield* fs.makeDirectory(environment.stateDir, { recursive: true });
      yield* fs.writeFileString(`${file}.new`, body, { mode: 0o600 });
      yield* fs.rename(`${file}.new`, file);
      registrations = next;
    }).pipe(
      Effect.mapError((cause) => new DesktopCompletionError({ reason: "write-failed", cause })),
    );
  const endedReceipt = (
    record: Registration,
    status: DesktopProcessCompletionReceipt["status"],
    completedAt: string,
  ): DesktopProcessCompletionReceipt => ({
    processId: record.processId,
    runtimeGeneration: record.runtimeGeneration,
    status,
    completedAt,
    exitCode: null,
    signal: null,
  });
  const resetRuntime = (generation: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (loadError !== undefined) return;
        const now = DateTime.formatIso(yield* DateTime.now);
        const next = registrations.map((record) =>
          record.receipt === null && record.runtimeGeneration !== generation
            ? { ...record, receipt: endedReceipt(record, "lost", now) }
            : record,
        );
        if (next.length > 0) yield* persist(next);
      }),
    );
  const capture = (process: DesktopProcess) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (loadError !== undefined || isDesktopProcessLive(process)) return;
        const now = DateTime.formatIso(yield* DateTime.now);
        let changed = false;
        const next = registrations.map((record): Registration => {
          if (
            record.receipt !== null ||
            record.processId !== process.processId ||
            record.runtimeGeneration !== process.runtimeGeneration
          )
            return record;
          changed = true;
          return {
            ...record,
            receipt: {
              processId: record.processId,
              runtimeGeneration: record.runtimeGeneration,
              status: process.status as "exited" | "failed" | "lost",
              exitCode: process.exitCode,
              signal: process.signal,
              completedAt: process.completedAt ?? now,
            },
          };
        });
        if (changed) yield* persist(next);
      }),
    );
  const cancelGrants = (ids: ReadonlySet<string>) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (loadError !== undefined) return;
        const now = DateTime.formatIso(yield* DateTime.now);
        let changed = false;
        const next = registrations.map((record) => {
          if (!record.grantIds.some((id) => ids.has(id))) return record;
          changed = true;
          return { ...record, receipt: endedReceipt(record, "permission-revoked", now) };
        });
        if (changed) yield* persist(next);
      }),
    );
  const removeThread = (owner: Owner) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (loadError !== undefined) return;
        const remaining = registrations.filter(
          (entry) =>
            entry.environmentId !== owner.environmentId || entry.threadId !== owner.threadId,
        );
        if (remaining.length === registrations.length) return;
        yield* persist(remaining);
      }),
    );
  const invoke = (
    owner: Owner,
    input: UserDesktopCompletionInput,
    grantIds?: ReadonlyArray<string>,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (loadError !== undefined) return yield* loadError;
        let record = registrations.find((entry) => entry.waitId === input.waitId);
        const key = identityKey([
          owner.environmentId,
          owner.threadId,
          input.waitId,
          input.processId,
          input.runtimeGeneration,
        ]);
        if (
          record !== undefined &&
          (record.environmentId !== owner.environmentId ||
            record.threadId !== owner.threadId ||
            record.processId !== input.processId ||
            record.runtimeGeneration !== input.runtimeGeneration)
        )
          return yield* new DesktopCompletionError({ reason: "wait-identity-conflict" });
        if (input.action === "cancel" || input.action === "acknowledge") {
          if (record !== undefined)
            yield* persist(registrations.filter((entry) => entry !== record));
          retired.add(key);
          return null;
        }
        if (input.action === "register" && record === undefined) {
          if (retired.has(key))
            return yield* new DesktopCompletionError({ reason: "wait-cancelled" });
          if (grantIds === undefined)
            return yield* new DesktopCompletionError({ reason: "permission-required" });
          record = {
            environmentId: EnvironmentId.make(owner.environmentId),
            threadId: ThreadId.make(owner.threadId),
            waitId: input.waitId,
            processId: input.processId,
            runtimeGeneration: input.runtimeGeneration,
            grantIds,
            receipt: null,
          };
          yield* persist([...registrations, record]);
        }
        if (record === undefined)
          return yield* new DesktopCompletionError({ reason: "wait-not-registered" });
        return record.receipt;
      }),
    );
  return {
    invoke,
    capture,
    cancelGrants,
    removeThread,
    resetRuntime,
    has: (owner: Owner, input: UserDesktopCompletionInput) =>
      registrations.some(
        (record) =>
          record.waitId === input.waitId &&
          record.environmentId === owner.environmentId &&
          record.threadId === owner.threadId &&
          record.processId === input.processId &&
          record.runtimeGeneration === input.runtimeGeneration,
      ),
    references: (environmentId: EnvironmentId) =>
      registrations
        .filter((record) => record.environmentId === environmentId)
        .map((record) => record.threadId),
  };
});
export class DesktopCompletionReceipts extends Context.Service<
  DesktopCompletionReceipts,
  Effect.Success<typeof make>
>()("@t3tools/desktop/process/DesktopCompletionReceipts") {}
export const layer = Layer.effect(DesktopCompletionReceipts, make);

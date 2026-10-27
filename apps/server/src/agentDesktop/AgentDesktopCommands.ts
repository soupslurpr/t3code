import { DesktopProcessActivityRecorder } from "../computer/DesktopProcessActivityRecorder.ts";
/** Durable host reservations for the guest-owned process supervisor. */
import {
  AgentDesktopId,
  AgentDesktopOwner,
  DesktopProcess,
  DesktopProcessOutput,
  isDesktopProcessLive,
  desktopProcessActivity,
  desktopProcessPage,
  type AgentDesktopCommandInput,
  type AgentDesktopCommandResult,
  type AgentDesktopProcessInput,
  type AgentDesktopProcessResponse,
  type AgentDesktopProcessResult,
  type DesktopProcessCompletionReceipt,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as AgentDesktopEnvironment from "./AgentDesktopEnvironment.ts";
import * as QemuAgentDesktop from "./QemuAgentDesktop.ts";

export class AgentDesktopCommandError extends Schema.TaggedError<AgentDesktopCommandError>()(
  "AgentDesktopCommandError",
  {
    reason: Schema.String,
    processId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Agent desktop command: ${this.reason}${this.processId === undefined ? "" : ` (process ${this.processId})`}.`;
  }
}

const isCommandError = Schema.is(AgentDesktopCommandError);

const Receipt = Schema.Struct({
  desktopId: AgentDesktopId,
  owner: AgentDesktopOwner,
  fingerprint: Schema.String,
  process: DesktopProcess,
  dispatched: Schema.Boolean,
  forgotten: Schema.Boolean,
});
type Receipt = typeof Receipt.Type;
const Ledger = Schema.Struct({ version: Schema.Literal(2), receipts: Schema.Array(Receipt) });
const Reply = Schema.Union([
  Schema.Struct({ version: Schema.Literal(2), error: Schema.String }),
  Schema.Struct({
    version: Schema.Literal(2),
    generation: Schema.String,
    systemdVersion: Schema.String,
    cgroup: Schema.Literal(2),
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    process: DesktopProcess,
    stdout: Schema.optional(DesktopProcessOutput),
    stderr: Schema.optional(DesktopProcessOutput),
  }),
]);
const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(Reply));
const decodeLedger = Schema.decodeUnknownEffect(Schema.fromJsonString(Ledger));
const encodeLedger = Schema.encodeEffect(Schema.fromJsonString(Ledger));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const owned = (record: Receipt, owner: AgentDesktopOwner) =>
  record.owner.environmentId === owner.environmentId && record.owner.threadId === owner.threadId;
const keyFor = (desktopId: string, owner: AgentDesktopOwner, commandId: string) =>
  encodeJson([desktopId, owner.environmentId, commandId]);
const emptyOutput = (): DesktopProcessOutput => ({
  data: "",
  encoding: "utf8",
  offset: 0,
  nextOffset: 0,
  totalBytes: 0,
  storedBytes: 0,
  truncated: false,
  invalidUtf8: false,
});

export class AgentDesktopCommands extends Context.Service<
  AgentDesktopCommands,
  {
    readonly command: (
      owner: AgentDesktopOwner,
      desktopId: AgentDesktopId,
      input: AgentDesktopCommandInput,
    ) => Effect.Effect<AgentDesktopCommandResult, AgentDesktopCommandError>;
    readonly process: (
      owner: AgentDesktopOwner,
      input: AgentDesktopProcessInput,
    ) => Effect.Effect<AgentDesktopProcessResponse, AgentDesktopCommandError>;
    readonly activeCount: (desktopId: AgentDesktopId) => number;
    readonly ended: (desktopId: AgentDesktopId) => Effect.Effect<void, AgentDesktopCommandError>;
    readonly authorizeCompletion: (
      owner: AgentDesktopOwner,
      desktopId: AgentDesktopId,
      processId: string,
      generation: string,
    ) => Effect.Effect<void, AgentDesktopCommandError>;
    readonly completion: (
      owner: AgentDesktopOwner,
      desktopId: AgentDesktopId,
      processId: string,
      generation: string,
    ) => Effect.Effect<DesktopProcessCompletionReceipt | null, AgentDesktopCommandError>;
    readonly changes: Stream.Stream<DesktopProcess>;
  }
>()("t3/agentDesktop/AgentDesktopCommands") {}

const make = Effect.gen(function* () {
  const environment = yield* AgentDesktopEnvironment.AgentDesktopEnvironment;
  const qemu = yield* QemuAgentDesktop.QemuAgentDesktop;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const recordActivity = yield* DesktopProcessActivityRecorder;
  const lock = yield* Semaphore.make(1);
  const installationLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<DesktopProcess>(256);
  let wake = yield* Deferred.make<void>();
  const file = environment.path.join(environment.agentDesktopsDir, "command-receipts-v2.json");
  const records = new Map<string, Receipt>();
  let loadError: AgentDesktopCommandError | undefined;
  if (yield* fs.exists(file).pipe(Effect.orDie)) {
    const initial = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeLedger),
      Effect.match({
        onSuccess: (ledger) => ledger.receipts,
        onFailure: (cause) => {
          loadError = new AgentDesktopCommandError({ reason: "host-ledger-unavailable", cause });
          return [];
        },
      }),
    );
    for (const record of initial) {
      const key = keyFor(record.desktopId, record.owner, record.process.commandId);
      if (records.has(key))
        loadError = new AgentDesktopCommandError({ reason: "host-ledger-conflict" });
      records.set(key, record);
    }
  }
  const source = yield* Effect.gen(function* () {
    for (const candidate of environment.resolveResourcePathCandidates(
      "agent-desktop/command-helper.py",
    )) {
      const contents = yield* fs.readFile(candidate).pipe(Effect.option);
      if (Option.isSome(contents)) return contents.value;
    }
    return undefined;
  });
  const helperId =
    source === undefined
      ? "missing"
      : Hex.encode(yield* crypto.digest("SHA-256", source).pipe(Effect.orDie)).slice(0, 16);
  const helperPath = `/run/t3-agent-desktop/command-helper-${helperId}.py`;
  const checkStore = Effect.suspend(() =>
    loadError === undefined ? Effect.void : Effect.fail(loadError),
  );
  const persist = Effect.fn("AgentDesktopCommands.persist")(
    function* (next: Receipt) {
      yield* checkStore;
      const updated = new Map(records);
      updated.set(keyFor(next.desktopId, next.owner, next.process.commandId), next);
      const json = yield* encodeLedger({ version: 2, receipts: [...updated.values()] });
      yield* fs.makeDirectory(environment.agentDesktopsDir, { recursive: true });
      yield* fs.writeFileString(`${file}.new`, json, { mode: 0o600 });
      yield* fs.rename(`${file}.new`, file);
    },
    Effect.mapError(
      (cause) => new AgentDesktopCommandError({ reason: "host-ledger-write-failed", cause }),
    ),
  );
  const activity = Effect.fn("AgentDesktopCommands.activity")(
    function* (record: Receipt, phase: "started" | "input" | "completed", inputId = "") {
      const value = desktopProcessActivity(
        { kind: "agent", desktopId: record.desktopId },
        record.process,
        phase,
        inputId,
      );
      if (value !== null && recordActivity !== null) yield* recordActivity(value);
    },
    Effect.catch((cause) => Effect.logWarning("Could not record guest command milestone", cause)),
  );
  const save = Effect.fn("AgentDesktopCommands.save")(function* (record: Receipt) {
    const previous = records.get(keyFor(record.desktopId, record.owner, record.process.commandId));
    yield* persist(record);
    records.set(keyFor(record.desktopId, record.owner, record.process.commandId), record);
    yield* Deferred.succeed(wake, undefined);
    wake = yield* Deferred.make<void>();
    yield* PubSub.publish(changes, record.process);
    if (previous === undefined || previous.process.status !== record.process.status)
      yield* activity(record, isDesktopProcessLive(record.process) ? "started" : "completed");
  });
  const request = Effect.fn("AgentDesktopCommands.request")(
    function* (desktopId: AgentDesktopId, input: Readonly<Record<string, unknown>>) {
      const result = yield* qemu.executeGuestProcess(desktopId, {
        executable: "/usr/bin/python",
        arguments: [helperPath],
        stdin: new TextEncoder().encode(encodeJson(input)),
        timeoutMs: 15_000,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      if (result.exitCode !== 0 || result.stdoutTruncated)
        return yield* new AgentDesktopCommandError({ reason: "guest-helper-unavailable" });
      const reply = yield* decodeReply(result.stdout);
      if ("error" in reply) return yield* new AgentDesktopCommandError({ reason: reply.error });
      return reply;
    },
    Effect.mapError((cause) =>
      isCommandError(cause)
        ? cause
        : new AgentDesktopCommandError({ reason: "guest-unavailable", cause }),
    ),
  );
  const initialize = (desktopId: AgentDesktopId) =>
    installationLock
      .withPermit(
        Effect.gen(function* () {
          const probe = () => request(desktopId, { action: "capabilities" });
          let capabilities = yield* probe().pipe(Effect.option);
          if (Option.isNone(capabilities)) {
            if (source === undefined)
              return yield* new AgentDesktopCommandError({ reason: "bundled-helper-missing" });
            yield* qemu.executeGuestProcess(desktopId, {
              executable: "/usr/bin/mkdir",
              arguments: ["-p", "/run/t3-agent-desktop"],
              timeoutMs: 10_000,
              maxOutputBytes: 4096,
            });
            yield* qemu.writeGuestFile(desktopId, helperPath, source, "overwrite");
            capabilities = Option.some(yield* probe());
          }
          if (Option.isNone(capabilities) || !("generation" in capabilities.value))
            return yield* new AgentDesktopCommandError({ reason: "unsupported-helper" });
          return capabilities.value.generation;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isCommandError(cause)
            ? cause
            : new AgentDesktopCommandError({ reason: "helper-install-failed", cause }),
        ),
      );
  const selectProcess = (current: Receipt, process: DesktopProcess) => {
    if (
      process.processId !== current.process.processId ||
      process.commandId !== current.process.commandId ||
      process.runtimeGeneration !== current.process.runtimeGeneration ||
      process.environmentId !== current.owner.environmentId ||
      process.threadId !== current.owner.threadId
    )
      return Effect.fail(
        new AgentDesktopCommandError({
          reason: "guest-receipt-identity-mismatch",
          processId: current.process.processId,
        }),
      );
    if (
      !isDesktopProcessLive(current.process) ||
      (process.statusRevision ?? 0) < (current.process.statusRevision ?? 0)
    )
      return Effect.succeed(current);
    return Effect.succeed(
      encodeJson(current.process) === encodeJson(process) ? current : { ...current, process },
    );
  };
  const updateProcess = (record: Receipt, process: DesktopProcess) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = records.get(
          keyFor(record.desktopId, record.owner, record.process.commandId),
        );
        if (current === undefined) return record;
        const next = yield* selectProcess(current, process);
        if (next !== current) yield* save(next);
        return next;
      }),
    );
  const ended = (desktopId: AgentDesktopId) =>
    lock.withPermit(
      Effect.gen(function* () {
        const completedAt = DateTime.formatIso(yield* DateTime.now);
        for (const record of records.values()) {
          if (record.desktopId !== desktopId || !isDesktopProcessLive(record.process)) continue;
          yield* save({
            ...record,
            process: {
              ...record.process,
              status: "lost",
              completedAt,
              stdinClosed: true,
              outputError: "The guest stopped or was deleted.",
            },
          });
        }
      }),
    );
  const refresh = Effect.fn("AgentDesktopCommands.refresh")(
    function* (record: Receipt) {
      if (!isDesktopProcessLive(record.process)) return record;
      if (!(yield* qemu.isRunning(record.desktopId))) {
        yield* ended(record.desktopId);
        return records.get(keyFor(record.desktopId, record.owner, record.process.commandId))!;
      }
      const generation = yield* initialize(record.desktopId);
      if (generation !== record.process.runtimeGeneration) {
        return yield* updateProcess(record, {
          ...record.process,
          status: "lost",
          completedAt: DateTime.formatIso(yield* DateTime.now),
          stdinClosed: true,
          outputError: "The guest generation changed; this command ID cannot be reused.",
        });
      }
      const reply = yield* request(record.desktopId, {
        action: "status",
        processId: record.process.processId,
        generation,
      });
      if (!("process" in reply))
        return yield* new AgentDesktopCommandError({ reason: "invalid-helper-reply" });
      return yield* updateProcess(record, reply.process);
    },
    (effect, record) =>
      effect.pipe(
        Effect.catch((cause) =>
          updateProcess(record, {
            ...record.process,
            status: "unknown",
            outputError: cause.message,
          }),
        ),
      ),
  );
  const lookup = Effect.fn("AgentDesktopCommands.lookup")(function* (
    owner: AgentDesktopOwner,
    desktopId: AgentDesktopId,
    processId: string | undefined,
  ) {
    yield* checkStore;
    const record = [...records.values()].find(
      (entry) => entry.desktopId === desktopId && entry.process.processId === processId,
    );
    if (record === undefined || !owned(record, owner))
      return yield* new AgentDesktopCommandError({ reason: "process-not-owned" });
    return record;
  });
  const read = Effect.fn("AgentDesktopCommands.read")(function* (
    record: Receipt,
    input: Omit<AgentDesktopProcessInput, "desktopId" | "action">,
  ) {
    if (record.forgotten)
      return yield* new AgentDesktopCommandError({
        reason: "output-forgotten",
        processId: record.process.processId,
      });
    const current = yield* refresh(record);
    const fallback: AgentDesktopProcessResult = {
      kind: "process",
      protocolVersion: 2,
      desktopId: current.desktopId,
      process: current.process,
      stdout: emptyOutput(),
      stderr: emptyOutput(),
    };
    if (current.process.status === "lost" || current.process.status === "unknown") return fallback;
    const reply = yield* Effect.gen(function* () {
      const generation = yield* initialize(record.desktopId);
      if (generation !== record.process.runtimeGeneration)
        return yield* new AgentDesktopCommandError({ reason: "generation-changed" });
      return yield* request(record.desktopId, {
        ...input,
        action: "read",
        processId: record.process.processId,
        generation: record.process.runtimeGeneration,
      });
    }).pipe(Effect.option);
    if (Option.isNone(reply))
      return {
        ...fallback,
        process: {
          ...fallback.process,
          outputError: "Captured output is unavailable in the current guest generation.",
        },
      };
    const outputReply = reply.value;
    if (
      !("process" in outputReply) ||
      outputReply.stdout === undefined ||
      outputReply.stderr === undefined
    )
      return yield* new AgentDesktopCommandError({ reason: "invalid-output-reply" });
    const latest = yield* updateProcess(current, outputReply.process);
    return {
      ...fallback,
      process: latest.process,
      stdout: outputReply.stdout,
      stderr: outputReply.stderr,
    };
  });
  const wait = Effect.fn("AgentDesktopCommands.wait")(function* (
    record: Receipt,
    milliseconds: number,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + milliseconds;
    let current = record;
    while (isDesktopProcessLive(current.process) && (yield* Clock.currentTimeMillis) < deadline) {
      current = yield* refresh(current);
      if (!isDesktopProcessLive(current.process)) break;
      yield* Effect.sleep(Math.min(100, Math.max(0, deadline - (yield* Clock.currentTimeMillis))));
    }
    return current;
  });
  const process = Effect.fn("AgentDesktopCommands.process")(function* (
    owner: AgentDesktopOwner,
    input: AgentDesktopProcessInput,
  ): Effect.fn.Return<AgentDesktopProcessResponse, AgentDesktopCommandError> {
    yield* checkStore;
    if (input.action === "list") {
      return {
        kind: "list",
        protocolVersion: 2,
        desktopId: input.desktopId,
        ...desktopProcessPage(
          [...records.values()]
            .filter(
              (record) =>
                record.desktopId === input.desktopId && owned(record, owner) && !record.forgotten,
            )
            .map((record) => record.process),
          input,
        ),
      };
    }
    let record = yield* lookup(owner, input.desktopId, input.processId);
    if (input.action !== "read") {
      if (
        input.action === "forget" &&
        !isDesktopProcessLive(record.process) &&
        !(yield* qemu.isRunning(input.desktopId).pipe(
          Effect.mapError(
            (cause) =>
              new AgentDesktopCommandError({
                reason: cause.message,
                processId: record.process.processId,
              }),
          ),
        ))
      ) {
        yield* lock.withPermit(save({ ...record, forgotten: true }));
        return {
          kind: "process",
          protocolVersion: 2,
          desktopId: record.desktopId,
          process: record.process,
          stdout: emptyOutput(),
          stderr: emptyOutput(),
        };
      }
      const currentGeneration = yield* initialize(input.desktopId);
      if (currentGeneration !== record.process.runtimeGeneration) {
        yield* refresh(record);
        return yield* new AgentDesktopCommandError({
          reason: "generation-changed",
          processId: record.process.processId,
        });
      }
      const reply = yield* request(input.desktopId, {
        ...input,
        generation: record.process.runtimeGeneration,
      });
      if (!("process" in reply))
        return yield* new AgentDesktopCommandError({ reason: "invalid-helper-reply" });
      record = yield* updateProcess(record, reply.process);
      if (input.action === "write")
        yield* activity(record, "input", yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      if (input.action === "forget") {
        yield* lock.withPermit(save({ ...record, forgotten: true }));
        return {
          kind: "process",
          protocolVersion: 2,
          desktopId: record.desktopId,
          process: record.process,
          stdout: emptyOutput(),
          stderr: emptyOutput(),
        };
      }
    }
    record = yield* wait(record, input.waitMs ?? 0);
    return yield* read(record, input);
  });
  const command = Effect.fn("AgentDesktopCommands.command")(function* (
    owner: AgentDesktopOwner,
    desktopId: AgentDesktopId,
    input: AgentDesktopCommandInput,
  ): Effect.fn.Return<AgentDesktopCommandResult, AgentDesktopCommandError> {
    yield* checkStore;
    const legacy = input.commandId === undefined;
    const commandId = input.commandId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const variables = Array.isArray(input.environment)
      ? Object.fromEntries(input.environment.map((entry) => [entry.name, entry.value]))
      : (input.environment ?? {});
    const configuration = {
      executable: input.executable,
      arguments: input.arguments ?? [],
      workingDirectory: input.workingDirectory,
      user: input.user ?? "root",
      environment: Object.fromEntries(
        Object.entries(variables).sort(([a], [b]) => a.localeCompare(b)),
      ),
      stdin: input.stdin ?? "",
      stdinEncoding: input.stdinEncoding ?? "utf8",
      keepStdinOpen: input.keepStdinOpen ?? !!input.terminal,
      terminal: input.terminal ?? false,
      inheritEnvironment: input.inheritEnvironment ?? true,
      timeoutMs: legacy
        ? Math.min(input.timeoutMs ?? 300_000, 3_600_000)
        : (input.timeoutMs ?? null),
      maxStoredOutputBytes: input.maxStoredOutputBytes ?? 64 * 1024 * 1024,
    };
    const fingerprint = Hex.encode(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(encodeJson(configuration)))
        .pipe(Effect.orDie),
    );
    const key = keyFor(desktopId, owner, commandId);
    let acceptedLegacy: Receipt | undefined;
    let record = yield* Effect.gen(function* () {
      let record = yield* lock.withPermit(
        Effect.gen(function* () {
          const previous = records.get(key);
          if (previous !== undefined) {
            if (!owned(previous, owner) || previous.fingerprint !== fingerprint)
              return yield* new AgentDesktopCommandError({ reason: "command-id-conflict" });
            if (previous.forgotten)
              return yield* new AgentDesktopCommandError({
                reason: "output-forgotten",
                processId: previous.process.processId,
              });
            return previous;
          }
          const generation = yield* initialize(desktopId);
          const processId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const created: Receipt = {
            owner,
            desktopId,
            fingerprint,
            dispatched: false,
            forgotten: false,
            process: {
              environmentId: owner.environmentId,
              threadId: owner.threadId,
              runtimeGeneration: generation,
              processId,
              commandId,
              executable: input.executable,
              arguments: input.arguments ?? [],
              workingDirectory: input.workingDirectory ?? "",
              user: configuration.user,
              terminal: !!configuration.terminal,
              pid: null,
              status: "starting",
              startedAt: DateTime.formatIso(yield* DateTime.now),
              completedAt: null,
              exitCode: null,
              signal: null,
              timeoutMs: configuration.timeoutMs,
              timedOut: false,
              stdinClosed: false,
              stdoutPath: `/var/lib/t3-command-v2/job-${processId}/stdout`,
              stderrPath: `/var/lib/t3-command-v2/job-${processId}/stderr`,
              outputError: null,
            },
          };
          yield* save(created);
          return created;
        }),
      );
      // The persisted reservation is the acceptance point. The bounded dispatch is
      // uninterruptible; later tool waits are cancellable without killing the job.
      yield* lock.withPermit(
        Effect.gen(function* () {
          record = records.get(key)!;
          if (record.dispatched) return;
          record = { ...record, dispatched: true };
          yield* save(record);
          const started = yield* request(desktopId, {
            action: "start",
            generation: record.process.runtimeGeneration,
            process: record.process,
            fingerprint,
            owner: { environmentId: owner.environmentId, threadId: owner.threadId },
            input: configuration,
          }).pipe(Effect.option);
          const verified =
            Option.isSome(started) && "process" in started.value
              ? yield* selectProcess(record, started.value.process).pipe(Effect.option)
              : Option.none();
          record = Option.isSome(verified)
            ? verified.value
            : {
                ...record,
                process: {
                  ...record.process,
                  status: "unknown",
                  outputError:
                    "The start acknowledgement was lost or invalid; reconcile this handle before taking further action.",
                },
              };
          yield* save(record);
        }),
      );
      acceptedLegacy = record;
      return record;
    }).pipe(
      Effect.uninterruptible,
      Effect.onInterrupt(() =>
        legacy && acceptedLegacy !== undefined
          ? process(owner, {
              desktopId,
              processId: acceptedLegacy.process.processId,
              action: "signal",
              signal: "SIGTERM",
            }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    const complete = Effect.gen(function* () {
      record = yield* wait(
        record,
        legacy ? (configuration.timeoutMs ?? 300_000) + 4_000 : (input.waitMs ?? 1_000),
      );
      const result = yield* read(record, {
        ...input,
        ...(legacy
          ? {
              maxBytes: Math.max(4, Math.min(input.maxOutputBytes ?? 1024 * 1024, 1024 * 1024)),
              encoding: "utf8" as const,
            }
          : {}),
      });
      if (!legacy) return result;
      if (
        isDesktopProcessLive(result.process) ||
        result.process.timedOut ||
        result.process.status === "lost"
      ) {
        yield* process(owner, {
          desktopId,
          processId: record.process.processId,
          action: "signal",
          signal: "SIGTERM",
        }).pipe(Effect.ignore);
        return yield* new AgentDesktopCommandError({
          reason: "one-shot-did-not-complete",
          processId: record.process.processId,
        });
      }
      return {
        desktopId,
        exitCode: result.process.exitCode ?? 128,
        stdout: new TextDecoder().decode(
          new TextEncoder()
            .encode(result.stdout.data)
            .subarray(0, input.maxOutputBytes ?? 1024 * 1024),
          { stream: true },
        ),
        stderr: new TextDecoder().decode(
          new TextEncoder()
            .encode(result.stderr.data)
            .subarray(0, input.maxOutputBytes ?? 1024 * 1024),
          { stream: true },
        ),
        stdoutTruncated:
          result.stdout.truncated ||
          Math.min(result.stdout.nextOffset, input.maxOutputBytes ?? 1024 * 1024) <
            result.stdout.totalBytes,
        stderrTruncated:
          result.stderr.truncated ||
          Math.min(result.stderr.nextOffset, input.maxOutputBytes ?? 1024 * 1024) <
            result.stderr.totalBytes,
        startedAt: result.process.startedAt,
        completedAt: result.process.completedAt!,
        durationMs: Math.max(
          0,
          Date.parse(result.process.completedAt!) - Date.parse(result.process.startedAt),
        ),
      };
    });
    return yield* legacy
      ? complete.pipe(
          Effect.onInterrupt(() =>
            process(owner, {
              desktopId,
              processId: record.process.processId,
              action: "signal",
              signal: "SIGTERM",
            }).pipe(Effect.ignore),
          ),
        )
      : complete;
  });
  // Reconciliation exists only while accepted scopes remain live or uncertain.
  // Terminal receipts survive restart; the stream is merely a wake-up hint.
  yield* Effect.gen(function* () {
    for (const record of records.values())
      yield* activity(record, isDesktopProcessLive(record.process) ? "started" : "completed");
    while (true) {
      const pending = [...records.values()].filter(
        (record) => record.dispatched && isDesktopProcessLive(record.process),
      );
      if (pending.length === 0) {
        yield* Deferred.await(wake);
        continue;
      }
      yield* Effect.forEach(pending, refresh, { concurrency: 4, discard: true });
      yield* Effect.sleep(2_000);
    }
  }).pipe(
    Effect.tapError((cause) => Effect.logError("Command reconciliation will retry", { cause })),
    Effect.retry(Schedule.spaced("2 seconds")),
    Effect.forkScoped,
  );
  return AgentDesktopCommands.of({
    authorizeCompletion: (owner, desktopId, processId, generation) =>
      lookup(owner, desktopId, processId).pipe(
        Effect.flatMap((record) =>
          record.process.runtimeGeneration === generation
            ? Effect.void
            : new AgentDesktopCommandError({ reason: "generation-mismatch", processId }),
        ),
      ),
    completion: Effect.fn("AgentDesktopCommands.completion")(
      function* (owner, desktopId, processId, generation) {
        const record = yield* lookup(owner, desktopId, processId);
        if (record.process.runtimeGeneration !== generation)
          return yield* new AgentDesktopCommandError({ reason: "generation-mismatch", processId });
        const { process } = yield* refresh(record);
        if (isDesktopProcessLive(process)) return null;
        return {
          processId,
          runtimeGeneration: generation,
          status: process.status as "exited" | "failed" | "lost",
          exitCode: process.exitCode,
          signal: process.signal,
          completedAt: process.completedAt ?? DateTime.formatIso(yield* DateTime.now),
        };
      },
    ),
    command,
    process,
    ended,
    changes: Stream.fromPubSub(changes),
    // An unreadable host ledger cannot prove that any guest is idle.
    activeCount: (desktopId) =>
      loadError === undefined
        ? [...records.values()].filter(
            (record) => record.desktopId === desktopId && isDesktopProcessLive(record.process),
          ).length
        : 1,
  });
});

export const layer = Layer.effect(AgentDesktopCommands, make);

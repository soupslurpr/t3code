import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentDesktopCommandInput,
  DesktopProcess,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as AgentDesktopCommands from "./AgentDesktopCommands.ts";
import * as AgentDesktopEnvironment from "./AgentDesktopEnvironment.ts";
import * as QemuAgentDesktop from "./QemuAgentDesktop.ts";

const owner = {
  environmentId: EnvironmentId.make("source"),
  threadId: ThreadId.make("thread"),
  controllerId: "controller",
};
const input = { commandId: "write-once", executable: "/usr/bin/write-once", waitMs: 0 };
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      action: Schema.String,
      generation: Schema.optional(Schema.String),
      process: Schema.optional(DesktopProcess),
      processId: Schema.optional(Schema.String),
      input: Schema.optional(AgentDesktopCommandInput),
    }),
  ),
);

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-commands-" });
  const guest = new Map<string, DesktopProcess>();
  const started = yield* Deferred.make<void>();
  const controls = {
    generation: "boot-one:ledger-one",
    starts: 0,
    loseAck: false,
    missing: false,
    corrupt: false,
    running: true,
    unavailable: false,
  };
  const qemu = Layer.mock(QemuAgentDesktop.QemuAgentDesktop)({
    paths: () => assert.fail("This test never inspects hypervisor paths."),
    isRunning: () =>
      Effect.suspend(() =>
        controls.unavailable
          ? Effect.fail(
              new QemuAgentDesktop.QemuAgentDesktopError({
                code: "guest-disconnected",
                operation: "probe-running",
                detail: "Test control outage",
              }),
            )
          : Effect.succeed(controls.running),
      ),
    executeGuestProcess: (_id, request) =>
      Effect.gen(function* () {
        const message = decodeRequest(new TextDecoder().decode(request.stdin));
        if (message.action === "capabilities")
          return {
            exitCode: 0,
            stdout: encode({
              version: 2,
              generation: controls.generation,
              systemdVersion: "262",
              cgroup: 2,
            }),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        if (message.action === "start" && message.process !== undefined) {
          controls.starts += 1;
          if (!controls.missing)
            guest.set(message.process.processId, {
              ...message.process,
              status: "running",
              pid: 41,
            });
          yield* Deferred.succeed(started, undefined);
          if (controls.loseAck)
            return yield* new QemuAgentDesktop.QemuAgentDesktopError({
              code: "guest-disconnected",
              operation: "guest-exec",
              detail: "Test lost reply",
            });
        }
        let process = guest.get(message.processId ?? message.process?.processId ?? "");
        if (message.action === "signal" && process !== undefined) {
          process = {
            ...process,
            status: "exited",
            signal: "SIGTERM",
            completedAt: DateTime.formatIso(yield* DateTime.now),
          };
          guest.set(process.processId, process);
        }
        const output = {
          data: "",
          encoding: "utf8",
          offset: 0,
          nextOffset: 0,
          storedBytes: 0,
          totalBytes: 0,
          truncated: false,
          invalidUtf8: false,
        };
        return {
          exitCode: 0,
          stdout: encode(
            controls.corrupt
              ? { version: 2, process: { status: "running" } }
              : process === undefined
                ? { version: 2, error: "receipt-missing" }
                : { version: 2, process, stdout: output, stderr: output },
          ),
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  const environment = Layer.succeed(AgentDesktopEnvironment.AgentDesktopEnvironment, {
    path,
    platform: "linux",
    processArch: "x64",
    agentDesktopsDir: directory,
    agentDesktopBaseImage: Option.none(),
    resolveResourcePathCandidates: () => [],
  });
  const open = <A, E, R>(run: Effect.Effect<A, E, R>) =>
    run.pipe(
      Effect.provide(
        AgentDesktopCommands.layer.pipe(Layer.provide(qemu), Layer.provide(environment)),
      ),
      Effect.scoped,
    );
  return {
    fs,
    file: path.join(directory, "command-receipts-v2.json"),
    guest,
    controls,
    started,
    open,
  };
});

describe("managed Agent desktop command reservations", () => {
  it.effect(
    "keeps unknown jobs counted during control loss and reconciles the same job after recovery",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.open(
          Effect.gen(function* () {
            const service = yield* AgentDesktopCommands.AgentDesktopCommands;
            const started = yield* service.command(owner, "desktop", input);
            if (!("kind" in started)) return assert.fail();
            h.controls.unavailable = true;
            const read = {
              action: "read" as const,
              desktopId: "desktop",
              processId: started.process.processId,
            };
            const uncertain = yield* service.process(owner, read);
            if (uncertain.kind !== "process") return assert.fail();
            assert.equal(uncertain.process.status, "unknown");
            assert.equal(service.activeCount("desktop"), 1);
            assert.isNull(
              yield* service.completion(
                owner,
                "desktop",
                started.process.processId,
                started.process.runtimeGeneration!,
              ),
            );
            h.controls.unavailable = false;
            const recovered = yield* service.process(owner, read);
            if (recovered.kind !== "process") return assert.fail();
            assert.equal(recovered.process.status, "running");
            assert.equal(recovered.process.processId, started.process.processId);
            assert.equal(h.controls.starts, 1);
            h.controls.running = false;
            const ended = yield* service.process(owner, read);
            if (ended.kind !== "process") return assert.fail();
            assert.equal(ended.process.status, "lost");
            assert.equal(service.activeCount("desktop"), 0);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("pages only owned commands and keeps legacy cancellation scoped to its job", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.open(
        Effect.gen(function* () {
          const service = yield* AgentDesktopCommands.AgentDesktopCommands;
          const legacy = yield* service
            .command(owner, "desktop", { executable: "/usr/bin/legacy" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.started);
          yield* Fiber.interrupt(legacy);
          assert.equal([...h.guest.values()][0]?.status, "exited");
          for (let index = 0; index < 4; index++)
            yield* service.command(owner, "desktop", { ...input, commandId: `own-${index}` });
          const foreign = { ...owner, threadId: ThreadId.make("other-thread") };
          const other = yield* service.command(foreign, "desktop", {
            ...input,
            commandId: "foreign",
          });
          if (!("kind" in other)) return assert.fail();
          const ids = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = yield* service.process(owner, {
              desktopId: "desktop",
              action: "list",
              limit: 2,
              ...(cursor ? { cursor } : {}),
            });
            if (page.kind !== "list") return assert.fail();
            assert.isAtMost(page.processes.length, 2);
            for (const process of page.processes) {
              assert.equal(process.threadId, owner.threadId);
              ids.add(process.processId);
            }
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          assert.equal(ids.size, 5);
          assert.equal(
            (yield* service
              .process(owner, {
                desktopId: "desktop",
                action: "read",
                processId: other.process.processId,
              })
              .pipe(Effect.flip)).reason,
            "process-not-owned",
          );
          assert.equal(h.guest.get(other.process.processId)?.status, "running");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "reconciles a lost acknowledgement and survives server restart without another execution",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.controls.loseAck = true;
        const first = yield* h.open(
          Effect.gen(function* () {
            const service = yield* AgentDesktopCommands.AgentDesktopCommands;
            const result = yield* service.command(owner, "desktop", input);
            assert.isTrue("kind" in result);
            if (!("kind" in result)) return assert.fail();
            assert.equal(result.process.status, "running");
            assert.equal(service.activeCount("desktop"), 1);
            return result.process.processId;
          }),
        );
        yield* h.open(
          Effect.gen(function* () {
            const service = yield* AgentDesktopCommands.AgentDesktopCommands;
            const result = yield* service.command(
              { ...owner, controllerId: "new-session" },
              "desktop",
              input,
            );
            if (!("kind" in result)) return assert.fail();
            assert.equal(result.process.processId, first);
            assert.equal(h.controls.starts, 1);
            assert.equal(
              (yield* service
                .command({ ...owner, threadId: ThreadId.make("other") }, "desktop", input)
                .pipe(Effect.flip)).reason,
              "command-id-conflict",
            );
            assert.equal(
              (yield* service
                .command(owner, "desktop", { ...input, arguments: ["different"] })
                .pipe(Effect.flip)).reason,
              "command-id-conflict",
            );
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "keeps an uncertain acceptance inspectable and never treats missing or corrupt receipts as a new start",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.controls.loseAck = true;
        h.controls.missing = true;
        yield* h.open(
          Effect.gen(function* () {
            const service = yield* AgentDesktopCommands.AgentDesktopCommands;
            const result = yield* service.command(owner, "desktop", input);
            if (!("kind" in result)) return assert.fail();
            assert.equal(result.process.status, "unknown");
            assert.equal(service.activeCount("desktop"), 1);
            yield* service.command(owner, "desktop", input);
            h.controls.corrupt = true;
            const retry = yield* service.command(owner, "desktop", input);
            if (!("kind" in retry)) return assert.fail();
            assert.equal(retry.process.status, "unknown");
            assert.equal(h.controls.starts, 1);
            yield* service.ended("desktop");
            assert.equal(service.activeCount("desktop"), 0);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "pins retries to the first guest generation and retains identity after forgetting output",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.open(
          Effect.gen(function* () {
            const service = yield* AgentDesktopCommands.AgentDesktopCommands;
            const result = yield* service.command(owner, "desktop", input);
            if (!("kind" in result)) return assert.fail();
            h.controls.generation = "boot-two:ledger-one";
            const retry = yield* service.command(owner, "desktop", input);
            if (!("kind" in retry)) return assert.fail();
            assert.equal(retry.process.status, "lost");
            assert.equal(retry.process.runtimeGeneration, "boot-one:ledger-one");
            assert.equal(h.controls.starts, 1);
            h.controls.running = false;
            yield* service.process(owner, {
              desktopId: "desktop",
              action: "forget",
              processId: result.process.processId,
            });
            assert.equal(
              (yield* service.command(owner, "desktop", input).pipe(Effect.flip)).reason,
              "output-forgotten",
            );
          }),
        );
        yield* h.open(
          Effect.gen(function* () {
            const service = yield* AgentDesktopCommands.AgentDesktopCommands;
            assert.equal(
              (yield* service.command(owner, "desktop", input).pipe(Effect.flip)).reason,
              "output-forgotten",
            );
            assert.equal(h.controls.starts, 1);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails closed on a corrupt host ledger", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.fs.writeFileString(h.file, "{partial");
      yield* h.open(
        Effect.gen(function* () {
          const service = yield* AgentDesktopCommands.AgentDesktopCommands;
          assert.equal(
            (yield* service.command(owner, "desktop", input).pipe(Effect.flip)).reason,
            "host-ledger-unavailable",
          );
          assert.equal(h.controls.starts, 0);
          assert.equal(service.activeCount("desktop"), 1);
          assert.equal(service.activeCount("other-desktop"), 1);
          assert.equal(yield* h.fs.readFileString(h.file), "{partial");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

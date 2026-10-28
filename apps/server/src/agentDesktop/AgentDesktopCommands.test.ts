import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DesktopProcess, EnvironmentId, ThreadId } from "@t3tools/contracts";
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
      input: Schema.optional(
        Schema.Struct({
          stdin: Schema.String,
          stdinEncoding: Schema.String,
        }),
      ),
      data: Schema.optional(Schema.String),
      encoding: Schema.optional(Schema.String),
    }),
  ),
);

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-commands-" });
  const guest = new Map<string, DesktopProcess>();
  const requests: Array<ReturnType<typeof decodeRequest>> = [];
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
        if (request.stdin!.byteLength > 4 * 1024 * 1024)
          return {
            exitCode: 0,
            stdout: encode({ version: 2, error: "helper-unavailable" }),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        const message = decodeRequest(new TextDecoder().decode(request.stdin));
        if (message.action === "write" && request.stdin!.byteLength > 2 * 1024 * 1024)
          return {
            exitCode: 0,
            stdout: encode({ version: 2, error: "invalid-control" }),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        requests.push(message);
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
    requests,
    controls,
    started,
    open,
  };
});

describe("managed Agent desktop command reservations", () => {
  it.effect("retains the original input representation in command retry identity", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.open(
        Effect.gen(function* () {
          const service = yield* AgentDesktopCommands.AgentDesktopCommands;
          const stdin = "a\0🦀";
          yield* service.command(owner, "desktop", { ...input, stdin, stdinEncoding: "utf8" });
          const changed = yield* service
            .command(owner, "desktop", {
              ...input,
              stdin: Buffer.from(stdin).toString("base64"),
              stdinEncoding: "base64",
            })
            .pipe(Effect.flip);
          assert.equal(changed.reason, "command-id-conflict");
          assert.equal(h.controls.starts, 1);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "rejects an oversized control envelope before writing and keeps the session usable",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.open(
          Effect.gen(function* () {
            const service = yield* AgentDesktopCommands.AgentDesktopCommands;
            const started = yield* service.command(owner, "desktop", input);
            if (!("kind" in started)) return assert.fail();
            const process = {
              desktopId: "desktop",
              action: "write" as const,
              processId: started.process.processId,
              encoding: "utf8" as const,
            };
            const refused = yield* service
              .process(owner, { ...process, data: "🦀".repeat(512 * 1024) })
              .pipe(Effect.flip);
            assert.equal(refused.reason, "guest-request-too-large");
            assert.isFalse(h.requests.some((request) => request.action === "write"));
            yield* service.process(owner, { ...process, data: "still usable" });
            assert.equal(h.requests.filter((request) => request.action === "write").length, 1);
            assert.equal(h.controls.starts, 1);
            assert.equal(service.activeCount("desktop"), 1);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("delivers a maximum escaped write without retrying the command", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.open(
        Effect.gen(function* () {
          const service = yield* AgentDesktopCommands.AgentDesktopCommands;
          const started = yield* service.command(owner, "desktop", input);
          if (!("kind" in started)) return assert.fail();
          const data = "\0".repeat(1024 * 1024);
          const result = yield* service.process(owner, {
            desktopId: "desktop",
            action: "write",
            processId: started.process.processId,
            data,
            encoding: "utf8",
          });
          assert.equal(result.kind, "process");
          const written = h.requests.find((request) => request.action === "write")!;
          assert.equal(
            Buffer.from(
              written.data!,
              written.encoding === "base64" ? "base64" : "utf8",
            ).toString(),
            data,
          );
          assert.equal(h.controls.starts, 1);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["control", "unicode", "base64"] as const)(
    "delivers maximum %s input through bounded guest requests and retains retries",
    (kind) =>
      Effect.gen(function* () {
        const h = yield* harness;
        const data =
          kind === "unicode"
            ? "🦀".repeat(256 * 1024)
            : "\0".repeat(kind === "base64" ? 768 * 1024 : 1024 * 1024);
        const encoding = kind === "base64" ? ("base64" as const) : ("utf8" as const);
        const payload = encoding === "base64" ? Buffer.from(data).toString("base64") : data;
        yield* h.open(
          Effect.gen(function* () {
            const service = yield* AgentDesktopCommands.AgentDesktopCommands;
            const started = yield* service.command(owner, "desktop", {
              ...input,
              stdin: payload,
              stdinEncoding: encoding,
            });
            if (!("kind" in started)) return assert.fail();
            assert.equal(started.process.status, "running");
            const request = h.requests.find((request) => request.action === "start")!;
            assert.equal(
              Buffer.from(
                request.input!.stdin,
                request.input!.stdinEncoding === "base64" ? "base64" : "utf8",
              ).toString(),
              data,
            );
            const repeated = yield* service.command(owner, "desktop", {
              ...input,
              stdin: payload,
              stdinEncoding: encoding,
            });
            if (!("kind" in repeated)) return assert.fail();
            assert.equal(repeated.process.processId, started.process.processId);
            assert.equal(h.controls.starts, 1);
            yield* service.process(owner, {
              desktopId: "desktop",
              action: "write",
              processId: started.process.processId,
              data: payload,
              encoding,
            });
            const written = h.requests.find((request) => request.action === "write")!;
            assert.equal(
              Buffer.from(
                written.data!,
                written.encoding === "base64" ? "base64" : "utf8",
              ).toString(),
              data,
            );
            assert.equal(service.activeCount("desktop"), 1);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "rejects an oversized request before durable acceptance and allows a corrected retry",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.open(
          Effect.gen(function* () {
            const service = yield* AgentDesktopCommands.AgentDesktopCommands;
            const oversized = {
              ...input,
              arguments: Array.from({ length: 100 }, () => "a".repeat(32768)),
            };
            const refused = yield* service
              .command(owner, "desktop", oversized)
              .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error }));
            if (refused === null) return assert.fail("Oversized request was accepted");
            assert.equal(refused.reason, "guest-request-too-large");
            assert.equal(h.controls.starts, 0);
            assert.equal(service.activeCount("desktop"), 0);
            assert.isFalse(yield* h.fs.exists(h.file));
            const accepted = yield* service.command(owner, "desktop", input);
            if (!("kind" in accepted)) return assert.fail();
            assert.equal(accepted.process.status, "running");
            assert.equal(h.controls.starts, 1);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

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

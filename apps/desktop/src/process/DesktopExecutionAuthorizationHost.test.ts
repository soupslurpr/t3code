import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DesktopExecutionAuthorizationCommand,
  DesktopExecutionAuthorizationEvent,
  EnvironmentId,
  ThreadId,
  AuthSessionId,
  type DesktopComputerAutomationContext,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as DesktopExecution from "./DesktopExecution.ts";
import * as Host from "./DesktopExecutionAuthorizationHost.ts";
import * as Identity from "../computer/UserDesktopIdentity.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(DesktopExecutionAuthorizationCommand));
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopExecutionAuthorizationEvent),
);
const desktop = { kind: "user", desktopId: "native-target" } as const;
it.effect("binds decisions to one native child generation, source and invocation payload", () =>
  Effect.gen(function* () {
    const contexts: DesktopComputerAutomationContext[] = [];
    let cleanupLease: string | null = null;
    const environmentId = EnvironmentId.make("native-environment");
    const test = Effect.gen(function* () {
      const host = yield* Host.DesktopExecutionAuthorizationHost;
      const channel = yield* host.open;
      const events = yield* Queue.unbounded<DesktopExecutionAuthorizationEvent>();
      yield* channel.events.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapEffect((line) => decode(line)),
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      yield* channel.handleCommandLine(encode({ type: "hello", environmentId }));
      const ready = yield* Queue.take(events);
      if (ready.type !== "ready") return assert.fail();
      yield* channel.handleCommandLine(encode({ type: "hello", environmentId }));
      assert.deepEqual(yield* Queue.take(events), ready);
      yield* channel.handleCommandLine(
        encode({ type: "hello", environmentId: EnvironmentId.make("imposter") }),
      );
      const cleanup = {
        type: "cleanup-acquire" as const,
        generation: ready.generation,
        invocationId: "cleanup",
      };
      yield* channel.handleCommandLine(encode(cleanup));
      assert.deepEqual(yield* Queue.take(events), {
        type: "cleanup-result",
        invocationId: "cleanup",
        acquired: true,
      });
      assert.equal(cleanupLease, `${ready.generation}:cleanup`);
      yield* channel.handleCommandLine(
        encode({ ...cleanup, type: "cleanup-release", generation: "stale" }),
      );
      assert.equal((yield* Queue.take(events)).type, "error");
      assert.isNotNull(cleanupLease);
      yield* channel.handleCommandLine(encode({ ...cleanup, type: "cleanup-release" }));
      assert.isNull(cleanupLease);
      const command = {
        type: "invoke" as const,
        invocationId: "decision",
        generation: ready.generation,
        sessionId: AuthSessionId.make("session"),
        threadId: ThreadId.make("source-thread"),
        input: {
          operation: "access" as const,
          desktop,
          input: { action: "status" as const, desktop },
        },
      };
      yield* channel.handleCommandLine(encode({ ...command, generation: "retired-child" }));
      assert.deepEqual(yield* Queue.take(events), {
        type: "error",
        invocationId: "decision",
        code: "connection-changed",
        message: "The native desktop authorization channel changed.",
      });
      yield* channel.handleCommandLine(encode(command));
      const result = yield* Queue.take(events);
      assert.equal(result.type, "result");
      yield* channel.handleCommandLine(encode(command));
      assert.deepEqual(yield* Queue.take(events), result);
      assert.lengthOf(contexts, 1);
      assert.equal(contexts[0]!.environmentId, environmentId);
      yield* channel.handleCommandLine(
        encode({ ...command, threadId: ThreadId.make("another-thread") }),
      );
      const conflict = yield* Queue.take(events);
      assert.isTrue(conflict.type === "error" && conflict.code === "invocation-conflict");
      const replacement = yield* host.open;
      const replacementEvents = yield* Queue.unbounded<DesktopExecutionAuthorizationEvent>();
      yield* replacement.events.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapEffect((line) => decode(line)),
        Stream.runForEach((event) => Queue.offer(replacementEvents, event)),
        Effect.forkScoped,
      );
      yield* replacement.handleCommandLine(encode({ type: "hello", environmentId }));
      const fresh = yield* Queue.take(replacementEvents);
      assert.isTrue(fresh.type === "ready" && fresh.generation !== ready.generation);
      yield* replacement.handleCommandLine(encode(command));
      const stale = yield* Queue.take(replacementEvents);
      assert.isTrue(stale.type === "error" && stale.code === "connection-changed");
      assert.lengthOf(contexts, 1);
    });
    yield* test.pipe(
      Effect.provide(
        Host.layer.pipe(
          Layer.provide(
            Layer.mock(Identity.UserDesktopIdentity)({
              registration: {
                protocolVersion: 1,
                desktopId: desktop.desktopId,
                defaultLabel: "Native target",
                platform: "linux",
                capabilities: ["execution"],
              },
            }),
          ),
          Layer.provide(
            Layer.mock(DesktopExecution.DesktopExecution)({
              reserveWorktreeCleanup: (leaseId) =>
                Effect.sync(() => {
                  if (cleanupLease !== null) return false;
                  cleanupLease = leaseId;
                  return true;
                }),
              releaseWorktreeCleanup: (leaseId) =>
                Effect.sync(() => {
                  if (cleanupLease === leaseId) cleanupLease = null;
                }),
              invokeFromNativeBackend: (context) =>
                Effect.sync(() => {
                  contexts.push(context);
                  return {
                    kind: "access" as const,
                    desktop,
                    user: "user",
                    homeDirectory: "/home/user",
                    platform: "linux",
                    granted: false,
                    grants: [],
                  };
                }),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

// @effect-diagnostics nodeBuiltinImport:off -- Subprocess boundary for inherited descriptors and real session records.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as DesktopExecutionAuthorizationChannel from "../DesktopExecutionAuthorizationChannel.ts";
import * as DesktopThreadLifecycle from "../DesktopThreadLifecycle.ts";

const environmentId = EnvironmentId.make("coolcrab-environment");
const threadId = ThreadId.make("thread");
const desktop = { kind: "user", desktopId: "coolcrab-desktop" } as const;

Effect.gen(function* () {
  const base = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-command-channel-" })),
  );
  const config = {
    ...base,
    desktopAuthorizationFd: 3,
    desktopAuthorizationControlFd: 4,
    environmentHost: {
      protocolVersion: 1,
      desktopId: String(desktop.desktopId),
      defaultLabel: "Test host",
      platform: "linux",
      capabilities: ["execution"],
    } as const,
  };
  const services = yield* Layer.build(
    SessionStore.layer.pipe(
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
    ),
  );
  const sessions = Context.get(services, SessionStore.SessionStore);
  const current = yield* sessions.issue({ scopes: ["orchestration:operate", "terminal:operate"] });
  let revokeBeforeAcceptance = false;
  const source = Layer.succeed(DesktopThreadLifecycle.DesktopThreadLifecycleService, {
    read: () =>
      Effect.gen(function* () {
        if (revokeBeforeAcceptance) yield* sessions.revoke(current.sessionId).pipe(Effect.orDie);
        return {
          version: 2 as const,
          environmentId,
          threadId,
          revision: 1,
          activityRevision: 1,
          state: "active" as const,
          serverNow: DateTime.formatIso(yield* DateTime.now),
          activityAt: DateTime.formatIso(yield* DateTime.now),
          settledAt: null,
        };
      }),
    changes: Stream.empty,
  });
  const native = Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  });
  const channelContext = yield* Layer.build(
    DesktopExecutionAuthorizationChannel.layer.pipe(
      Layer.provide(source),
      Layer.provide(native),
      Layer.provide(Layer.succeedContext(services)),
    ),
  );
  const channel = Context.get(
    channelContext,
    DesktopExecutionAuthorizationChannel.DesktopExecutionAuthorizationChannel,
  );
  const input = { operation: "access", desktop, input: { action: "status", desktop } } as const;
  for (const scopes of [
    [],
    ["orchestration:operate"],
    ["terminal:operate"],
    ["orchestration:read", "preview:operate"],
  ] satisfies AuthEnvironmentScope[][]) {
    const session = yield* sessions.issue({ scopes });
    const rejected = yield* channel.invoke(session.sessionId, threadId, input).pipe(Effect.flip);
    if (rejected.code !== "permission-denied")
      return yield* Effect.die("Insufficient session scopes were accepted");
  }
  const foreign = yield* channel.invoke(current.sessionId, threadId, {
    ...input,
    desktop: { kind: "user", desktopId: "roamingcrab-desktop" },
  });
  if (Option.isSome(foreign))
    return yield* Effect.die("Reverse desktop access was accepted by the source backend");
  const accepted = yield* channel.invoke(current.sessionId, threadId, input);
  if (Option.isNone(accepted) || accepted.value.kind !== "access")
    return yield* Effect.die("Bound target was not reached");
  revokeBeforeAcceptance = true;
  const revoked = yield* channel.invoke(current.sessionId, threadId, input).pipe(Effect.flip);
  if (revoked.code !== "permission-denied")
    return yield* Effect.die("Revoked session authorized a decision");
  for (const outcome of ["success", "failure", "interrupt"] as const) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        if (!(yield* channel.reserveWorktreeCleanup))
          return yield* Effect.die("Idle native host rejected cleanup");
        if (outcome === "failure") return yield* Effect.fail("cleanup failed");
        if (outcome === "interrupt") return yield* Effect.interrupt;
      }),
    ).pipe(Effect.exit);
  }
  if (yield* Effect.scoped(channel.reserveWorktreeCleanup))
    return yield* Effect.die("Busy native host admitted cleanup");
  config.environmentHost = { ...config.environmentHost, desktopId: "different-native-host" };
  if (yield* Effect.scoped(channel.reserveWorktreeCleanup))
    return yield* Effect.die("Mismatched native host admitted cleanup");
  config.environmentHost = { ...config.environmentHost, desktopId: desktop.desktopId };
  if (yield* Effect.scoped(channel.reserveWorktreeCleanup))
    return yield* Effect.die("Disconnected native host admitted cleanup");
  const standaloneContext = yield* Layer.build(
    DesktopExecutionAuthorizationChannel.layer.pipe(
      Layer.provide(source),
      Layer.provide(native),
      Layer.provide(Layer.succeed(ServerConfig.ServerConfig, base)),
      Layer.provide(Layer.succeedContext(services)),
    ),
  );
  const standalone = Context.get(
    standaloneContext,
    DesktopExecutionAuthorizationChannel.DesktopExecutionAuthorizationChannel,
  );
  const replacement = yield* sessions.issue({
    scopes: ["orchestration:operate", "terminal:operate"],
  });
  if (Option.isSome(yield* standalone.invoke(replacement.sessionId, threadId, input)))
    return yield* Effect.die("Standalone backend claimed native approval authority");
  if (yield* Effect.scoped(standalone.reserveWorktreeCleanup))
    return yield* Effect.die("Unidentified standalone host admitted cleanup");
  yield* Console.log("verified");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);

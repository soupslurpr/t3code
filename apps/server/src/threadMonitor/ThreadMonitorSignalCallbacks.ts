// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto does not expose HMAC.
import * as NodeCrypto from "node:crypto";
import {
  ThreadMonitorError,
  type ThreadMonitorId,
  type ThreadMonitorSignalInput,
  type ThreadMonitorStartResult,
  type ThreadMonitorStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServer from "effect/http/HttpServer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadWorkspaceQuery from "../orchestration-v2/ThreadWorkspaceQuery.ts";
import * as ThreadMonitors from "../persistence/ThreadMonitors.ts";
import * as ThreadMonitorService from "./ThreadMonitorService.ts";

export class SignalCallbackError extends Schema.TaggedError<SignalCallbackError>()(
  "SignalCallbackError",
  { code: Schema.Literals(["unauthorized", "unavailable", "internal_error"]) },
) {}

/** Issues completion-only credentials without exposing a provider's MCP session. */
export class ThreadMonitorSignalCallbacks extends Context.Service<
  ThreadMonitorSignalCallbacks,
  {
    readonly create: (
      input: Parameters<ThreadMonitorService.ThreadMonitorServiceShape["create"]>[0],
    ) => Effect.Effect<ThreadMonitorStartResult, ThreadMonitorError>;
    readonly signal: (input: {
      readonly monitorId: ThreadMonitorId;
      readonly authorizationHeader: string | undefined;
      readonly result: Omit<ThreadMonitorSignalInput, "monitorId">;
    }) => Effect.Effect<{ readonly status: ThreadMonitorStatus }, SignalCallbackError>;
  }
>()("t3/threadMonitor/ThreadMonitorSignalCallbacks") {}

const make = Effect.gen(function* () {
  const monitors = yield* ThreadMonitorService.ThreadMonitorService;
  const repository = yield* ThreadMonitors.ThreadMonitorRepository;
  const snapshots = yield* ThreadWorkspaceQuery.ThreadWorkspaceQuery;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const server = yield* HttpServer.HttpServer;
  const signingKey = yield* Effect.cached(
    secrets.getOrCreateRandom("monitor-signal-signing-key", 32),
  );
  const credential = Effect.fnUntraced(function* (monitorId: ThreadMonitorId) {
    const key = yield* signingKey;
    return NodeCrypto.createHmac("sha256", key)
      .update(`t3-monitor-signal-v1:${monitorId}`)
      .digest("hex");
  });

  const create: ThreadMonitorSignalCallbacks["Service"]["create"] = Effect.fnUntraced(
    function* (input) {
      if (input.monitor.schedule.type !== "signal") return yield* monitors.create(input);
      if (!NetAddress.isInetAddress(server.address)) {
        return yield* new ThreadMonitorError({
          code: "MONITOR_NOT_SIGNALABLE",
          operation: "start",
          detail: "Signal callbacks require a TCP listener.",
        });
      }
      // Prepare the durable key before creating a wait whose callback cannot be returned.
      yield* signingKey.pipe(
        Effect.mapError(
          () =>
            new ThreadMonitorError({
              code: "PERSISTENCE_FAILURE",
              operation: "start",
              detail: "Could not prepare the signal callback credential.",
            }),
        ),
      );
      const monitor = yield* monitors.create(input);
      const token = yield* credential(monitor.id).pipe(Effect.orDie);
      const host = NetAddress.isUnspecified(server.address.address)
        ? "127.0.0.1"
        : NetAddress.formatUrlHostString(NetAddress.formatIp(server.address.address));
      const url = `http://${host}:${server.address.port}/api/monitor-signals/${encodeURIComponent(monitor.id)}`;
      const authorizationHeader = `Bearer ${token}`;
      return {
        ...monitor,
        signalCallback: {
          url,
          authorizationHeader,
          command: `curl --fail-with-body --silent --show-error --connect-timeout 10 --max-time 30 --request POST --header 'Authorization: ${authorizationHeader}' --header 'Content-Type: application/json' --data-binary @- '${url}'`,
        },
      };
    },
  );

  const signal: ThreadMonitorSignalCallbacks["Service"]["signal"] = Effect.fnUntraced(function* ({
    monitorId,
    authorizationHeader,
    result,
  }) {
    const token = authorizationHeader?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (token === undefined) return yield* new SignalCallbackError({ code: "unauthorized" });
    const expected = yield* credential(monitorId).pipe(
      Effect.mapError(() => new SignalCallbackError({ code: "internal_error" })),
    );
    if (!NodeCrypto.timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"))) {
      return yield* new SignalCallbackError({ code: "unauthorized" });
    }
    const stored = yield* repository
      .getById(monitorId)
      .pipe(Effect.mapError(() => new SignalCallbackError({ code: "internal_error" })));
    if (Option.isNone(stored) || stored.value.condition.type !== "signal") {
      return yield* new SignalCallbackError({ code: "unavailable" });
    }
    const monitor = stored.value;
    const owner = yield* snapshots
      .getThreadShellById(monitor.threadId)
      .pipe(Effect.mapError(() => new SignalCallbackError({ code: "internal_error" })));
    if (Option.isNone(owner) || owner.value.archivedAt !== null) {
      return yield* new SignalCallbackError({ code: "unavailable" });
    }
    const signalled = yield* monitors
      .signal({
        threadId: monitor.threadId,
        signal: { ...result, monitorId },
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new SignalCallbackError({
              code: error.code === "PERSISTENCE_FAILURE" ? "internal_error" : "unavailable",
            }),
        ),
      );
    if (signalled.status === "cancelled" || signalled.status === "failed") {
      return yield* new SignalCallbackError({ code: "unavailable" });
    }
    return { status: signalled.status };
  });
  return ThreadMonitorSignalCallbacks.of({ create, signal });
});

export const layer = Layer.effect(ThreadMonitorSignalCallbacks, make).pipe(
  Layer.provide(ThreadMonitors.layer),
  Layer.provide(ServerSecretStore.layer),
);

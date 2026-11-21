import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentHttpApi, ThreadMonitorId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { ServerConfig } from "../config.ts";
import * as SignalRoute from "./signalRoute.ts";
import * as MonitorTestkit from "./ThreadMonitor.testkit.ts";
import * as ThreadMonitorSignalCallbacks from "./ThreadMonitorSignalCallbacks.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.monitorSignals) {}

const handlerFor = (
  signal: ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks["Service"]["signal"],
) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(TestApi).pipe(
      Layer.provide(SignalRoute.layer),
      Layer.provide(
        Layer.mock(ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks)({ signal }),
      ),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://environment.local/api/monitor-signals/test-monitor", {
    method: "POST",
    body,
    headers: { authorization: "Bearer private-credential", ...headers },
  });

describe("signal callbacks over HTTP", () => {
  it.each(["exit=0", { exit_code: 0, status_file: "worker-status.json", report: "results.json" }])(
    "accepts bounded observations and returns only completion status (%#)",
    async (evidence) => {
      let received:
        | Parameters<
            ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks["Service"]["signal"]
          >[0]
        | undefined;
      const { handler, dispose } = handlerFor((input) => {
        received = input;
        return Effect.succeed({ status: "triggered" });
      });
      try {
        const response = await handler(post(JSON.stringify({ summary: "Done", evidence })));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "triggered" });
        expect(received).toEqual({
          monitorId: "test-monitor",
          authorizationHeader: "Bearer private-credential",
          result: {
            summary: "Done",
            evidence: typeof evidence === "string" ? evidence : JSON.stringify(evidence, null, 2),
          },
        });
      } finally {
        await dispose();
      }
    },
  );

  it.each([
    ["not-json", undefined, "Expected a JSON object containing only summary and evidence."],
    [
      JSON.stringify({ unexpected: "private-observation" }),
      undefined,
      "Expected a JSON object containing only summary and evidence.",
    ],
    [
      JSON.stringify({ evidence: ["private-observation"] }),
      "evidence",
      "Expected string | object | undefined",
    ],
    [
      JSON.stringify({ evidence: { output: "x".repeat(20_000) } }),
      "evidence",
      "Evidence exceeds 20,000 characters.",
    ],
    [
      JSON.stringify({ summary: "x".repeat(2_001) }),
      "summary",
      "Expected a value with a length of at most 2000",
    ],
  ] as const)(
    "explains rejected fields without echoing observations (%#)",
    async (body, field, message) => {
      const { handler, dispose } = handlerFor(() => Effect.die("invalid request reached service"));
      try {
        const response = await handler(post(body));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "invalid_result",
          ...(field === undefined ? {} : { field }),
          message,
        });
      } finally {
        await dispose();
      }
    },
  );

  it.each([
    ["not-json", {}, 400],
    [JSON.stringify({ monitorId: "other-monitor" }), {}, 400],
    [JSON.stringify({ summary: "a".repeat(2_001) }), {}, 400],
    [JSON.stringify({ evidence: "a".repeat(20_001) }), {}, 400],
    ["a".repeat(65_537), {}, 413],
    ["{}", { "content-length": "65537" }, 413],
  ] as const)("rejects invalid or oversized observations (%#)", async (body, headers, status) => {
    const { handler, dispose } = handlerFor(() => Effect.die("invalid request reached service"));
    try {
      expect((await handler(post(body, headers))).status).toBe(status);
    } finally {
      await dispose();
    }
  });

  it.each([
    ["unauthorized", 401],
    ["unavailable", 410],
    ["internal_error", 500],
  ] as const)("maps SignalCallbackError %s to HTTP %d", async (code, status) => {
    const { handler, dispose } = handlerFor(() =>
      Effect.fail(new ThreadMonitorSignalCallbacks.SignalCallbackError({ code })),
    );
    try {
      expect((await handler(post("{}"))).status).toBe(status);
    } finally {
      await dispose();
    }
  });

  it.effect(
    "authenticates per-monitor HMAC tokens, rejects wrong tokens with 401, omits credentials from status, and returns 410 for cancelled/non-signal/archived monitors",
    () =>
      Effect.gen(function* () {
        yield* MonitorTestkit.seedThread();
        const callbacks = yield* ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks;
        const monitors = yield* MonitorTestkit.ThreadMonitorService;

        const created = yield* callbacks.create({
          threadId: MonitorTestkit.threadId,
          monitor: {
            label: "External webhook",
            schedule: { type: "signal" },
            continuation: "record-only",
          },
        });
        expect(created.signalCallback?.authorizationHeader).toMatch(/^Bearer [a-f0-9]{64}$/);
        expect(created.signalCallback?.url).toContain(`/api/monitor-signals/${created.id}`);

        // Status must never echo the signalCallback credential
        const listed = yield* monitors.status({
          threadId: MonitorTestkit.threadId,
          query: { monitorId: created.id },
        });
        expect("signalCallback" in (listed.monitors[0] ?? {})).toBe(false);

        // Wrong token fails with unauthorized (401)
        const wrongToken = yield* callbacks
          .signal({
            monitorId: created.id,
            authorizationHeader: `Bearer ${"0".repeat(64)}`,
            result: { summary: "spoof" },
          })
          .pipe(Effect.flip);
        expect(wrongToken.code).toBe("unauthorized");

        // Token bound to monitor A cannot signal monitor B
        const other = yield* callbacks.create({
          threadId: MonitorTestkit.threadId,
          monitor: {
            label: "Other signal",
            schedule: { type: "signal" },
            continuation: "record-only",
          },
        });
        const crossMonitor = yield* callbacks
          .signal({
            monitorId: other.id,
            authorizationHeader: created.signalCallback?.authorizationHeader,
            result: { summary: "wrong monitor" },
          })
          .pipe(Effect.flip);
        expect(crossMonitor.code).toBe("unauthorized");

        // Valid token succeeds
        const signalled = yield* callbacks.signal({
          monitorId: created.id,
          authorizationHeader: created.signalCallback?.authorizationHeader,
          result: { summary: "Webhook OK", evidence: "status=200" },
        });
        expect(signalled.status).toBe("triggered");

        // Cancelled signal monitor returns unavailable (410)
        yield* monitors.cancel({
          threadId: MonitorTestkit.threadId,
          cancel: { monitorId: other.id },
        });
        const cancelledSignal = yield* callbacks
          .signal({
            monitorId: other.id,
            authorizationHeader: other.signalCallback?.authorizationHeader,
            result: { summary: "late" },
          })
          .pipe(Effect.flip);
        expect(cancelledSignal.code).toBe("unavailable");

        // Non-existent monitor with valid hex format still fails unauthorized
        const missing = yield* callbacks
          .signal({
            monitorId: ThreadMonitorId.make("does-not-exist"),
            authorizationHeader: created.signalCallback?.authorizationHeader,
            result: {},
          })
          .pipe(Effect.flip);
        expect(missing.code).toBe("unauthorized");
      }).pipe(
        Effect.provide(
          ThreadMonitorSignalCallbacks.layer.pipe(
            Layer.provideMerge(MonitorTestkit.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-signal-route-" })),
            Layer.provide(NodeHttpServer.layerTest),
            Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
});

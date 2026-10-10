import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as SignalRoute from "./signalRoute.ts";
import {
  SignalCallbackError,
  ThreadMonitorSignalCallbacks,
} from "./ThreadMonitorSignalCallbacks.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.monitorSignals) {}

const handlerFor = (signal: ThreadMonitorSignalCallbacks["Service"]["signal"]) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(TestApi).pipe(
      Layer.provide(SignalRoute.layer),
      Layer.provide(Layer.mock(ThreadMonitorSignalCallbacks)({ signal })),
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
  it("accepts bounded observations and returns only completion status", async () => {
    let received: Parameters<ThreadMonitorSignalCallbacks["Service"]["signal"]>[0] | undefined;
    const { handler, dispose } = handlerFor((input) => {
      received = input;
      return Effect.succeed({ status: "triggered" });
    });
    try {
      const response = await handler(post(JSON.stringify({ summary: "Done", evidence: "exit=0" })));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "triggered" });
      expect(received).toEqual({
        monitorId: "test-monitor",
        authorizationHeader: "Bearer private-credential",
        result: { summary: "Done", evidence: "exit=0" },
      });
    } finally {
      await dispose();
    }
  });

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
  ] as const)("reports %s without revealing credentials or monitor state", async (code, status) => {
    const { handler, dispose } = handlerFor(() => Effect.fail(new SignalCallbackError({ code })));
    try {
      const response = await handler(post("{}"));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    } finally {
      await dispose();
    }
  });
});

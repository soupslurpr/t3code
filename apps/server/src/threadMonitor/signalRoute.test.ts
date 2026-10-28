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
  it.each(["exit=0", { exit_code: 0, status_file: "worker-status.json", report: "results.json" }])(
    "accepts bounded observations and returns only completion status (%#)",
    async (evidence) => {
      let received: Parameters<ThreadMonitorSignalCallbacks["Service"]["signal"]>[0] | undefined;
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

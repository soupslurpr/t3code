import { EnvironmentHttpApi, ThreadMonitorSignalInput } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ThreadMonitorSignalCallbacks from "./ThreadMonitorSignalCallbacks.ts";

const MAX_BODY_BYTES = 64 * 1024;
const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      summary: ThreadMonitorSignalInput.fields.summary,
      evidence: ThreadMonitorSignalInput.fields.evidence,
    }),
  ),
  { onExcessProperty: "error" },
);

/** A callback's bearer credential authorizes only completion of its own monitor. */
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "monitorSignals",
  Effect.fnUntraced(function* (handlers) {
    const callbacks = yield* ThreadMonitorSignalCallbacks.ThreadMonitorSignalCallbacks;
    return handlers.handleRaw("signal", ({ params, request }) =>
      Effect.gen(function* () {
        const length = Number(request.headers["content-length"] ?? "0");
        if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
          return HttpServerResponse.jsonUnsafe({ error: "body_too_large" }, { status: 413 });
        }
        const body = yield* request.arrayBuffer.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
          Effect.option,
        );
        if (Option.isNone(body) || body.value.byteLength > MAX_BODY_BYTES) {
          return HttpServerResponse.jsonUnsafe({ error: "body_too_large" }, { status: 413 });
        }
        const result = yield* decodeResult(new TextDecoder().decode(body.value)).pipe(
          Effect.option,
        );
        if (Option.isNone(result)) {
          return HttpServerResponse.jsonUnsafe({ error: "invalid_result" }, { status: 400 });
        }
        return yield* callbacks
          .signal({
            monitorId: params.monitorId,
            authorizationHeader: request.headers.authorization,
            result: result.value,
          })
          .pipe(
            Effect.map((response) => HttpServerResponse.jsonUnsafe(response)),
            Effect.catchTags({
              SignalCallbackError: (error) =>
                Effect.succeed(
                  HttpServerResponse.jsonUnsafe(
                    { error: error.code },
                    {
                      status:
                        error.code === "unauthorized"
                          ? 401
                          : error.code === "unavailable"
                            ? 410
                            : 500,
                    },
                  ),
                ),
            }),
          );
      }),
    );
  }),
);

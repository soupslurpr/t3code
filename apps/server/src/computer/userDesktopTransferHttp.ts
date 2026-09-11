/** A transfer-scoped capability authorizes exactly one archive stream, never filesystem paths. */
import {
  DESKTOP_TRANSFER_MANIFEST_HEADER,
  DESKTOP_TRANSFER_ROUTE_PREFIX,
  DesktopTransferManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { UserDesktopTransfers } from "./UserDesktopTransfers.ts";

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopTransferManifest));
const credentials = (request: HttpServerRequest.HttpServerRequest) => {
  const url = HttpServerRequest.toURL(request);
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? "")?.[1];
  return Option.isSome(url) && token !== undefined
    ? { id: url.value.pathname.slice(DESKTOP_TRANSFER_ROUTE_PREFIX.length + 1), token }
    : null;
};

export const userDesktopTransferRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const transfers = yield* UserDesktopTransfers;
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        `${DESKTOP_TRANSFER_ROUTE_PREFIX}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const auth = credentials(request);
          if (auth === null) return HttpServerResponse.empty({ status: 404 });
          const download = transfers.download(auth.id, auth.token);
          if (download === null) return HttpServerResponse.empty({ status: 404 });
          return HttpServerResponse.stream(
            Stream.fromAsyncIterable(
              download.body,
              (cause) => new Error("Archive download failed", { cause }),
            ),
            {
              headers: {
                "content-type": "application/octet-stream",
                "content-length": String(download.manifest.wireBytes),
                "cache-control": "no-store, no-transform",
              },
            },
          );
        }),
      ),
      HttpRouter.add(
        "POST",
        `${DESKTOP_TRANSFER_ROUTE_PREFIX}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const auth = credentials(request);
          if (auth === null) return HttpServerResponse.empty({ status: 404 });
          const header = request.headers[DESKTOP_TRANSFER_MANIFEST_HEADER];
          if (header === undefined || header.length > 4096)
            return HttpServerResponse.empty({ status: 400 });
          const manifest = yield* decodeManifest(header).pipe(Effect.option);
          if (
            Option.isNone(manifest) ||
            request.headers["content-length"] !== String(manifest.value.wireBytes)
          )
            return HttpServerResponse.empty({ status: 400 });
          // Keep consumption in the HTTP request scope for backpressure and disconnect cleanup.
          const pull = yield* Stream.toPull(request.stream);
          const body = Stream.toAsyncIterable(Stream.fromPull(Effect.succeed(pull)));
          return yield* transfers.upload(auth.id, auth.token, manifest.value, body).pipe(
            Effect.map((accepted) => HttpServerResponse.empty({ status: accepted ? 204 : 404 })),
            Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
          );
        }),
      ),
    );
  }),
);

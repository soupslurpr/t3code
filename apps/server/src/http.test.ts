import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import {
  assetFileResponse,
  assetResponseHeaders,
  isLoopbackHostname,
  resolveAssetByteRange,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });
});

describe("resolveAssetByteRange", () => {
  it("keeps requests without a range as full responses", () => {
    expect(resolveAssetByteRange(undefined, 10n)).toEqual({ _tag: "full" });
  });

  it("resolves bounded, open, and suffix ranges", () => {
    expect(resolveAssetByteRange("bytes=2-5", 10n)).toEqual({
      _tag: "partial",
      start: 2n,
      endInclusive: 5n,
    });
    expect(resolveAssetByteRange("bytes=7-", 10n)).toEqual({
      _tag: "partial",
      start: 7n,
      endInclusive: 9n,
    });
    expect(resolveAssetByteRange("bytes=-4", 10n)).toEqual({
      _tag: "partial",
      start: 6n,
      endInclusive: 9n,
    });
  });

  it("clamps ranges to the file", () => {
    expect(resolveAssetByteRange("bytes=2-100", 10n)).toEqual({
      _tag: "partial",
      start: 2n,
      endInclusive: 9n,
    });
    expect(resolveAssetByteRange("bytes=-100", 10n)).toEqual({
      _tag: "partial",
      start: 0n,
      endInclusive: 9n,
    });
  });

  it("rejects malformed, multiple, reversed, and out-of-file ranges", () => {
    for (const range of ["items=0-1", "bytes=", "bytes=0-1,3-4", "bytes=5-2", "bytes=10-"]) {
      expect(resolveAssetByteRange(range, 10n)).toEqual({ _tag: "unsatisfiable" });
    }
    expect(resolveAssetByteRange("bytes=-0", 10n)).toEqual({ _tag: "unsatisfiable" });
    expect(resolveAssetByteRange("bytes=0-", 0n)).toEqual({ _tag: "unsatisfiable" });
  });
});

describe("asset byte-range responses", () => {
  it.effect("streams the requested WAV bytes with media range headers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-range-",
      });
      const audioPath = path.join(directory, "sample.wav");
      yield* fileSystem.writeFileString(audioPath, "0123456789abcdef");

      const rangeRouteLayer = HttpRouter.add(
        "GET",
        "/sample.wav",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* assetFileResponse(audioPath, request.headers.range);
        }),
      );
      yield* HttpRouter.serve(rangeRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const response = yield* HttpClient.get("/sample.wav", {
        headers: { Range: "bytes=2-5" },
      });

      expect(response.status).toBe(206);
      expect(response.headers["accept-ranges"]).toBe("bytes");
      expect(response.headers["content-range"]).toBe("bytes 2-5/16");
      expect(response.headers["content-length"]).toBe("4");
      expect(response.headers["content-type"]).toBe("audio/wav");
      expect(yield* response.text).toBe("2345");

      const unsatisfiable = yield* HttpClient.get("/sample.wav", {
        headers: { Range: "bytes=99-" },
      });
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers["content-range"]).toBe("bytes */16");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );
});

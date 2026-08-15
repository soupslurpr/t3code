import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import {
  AGENT_DESKTOP_TRANSFER_ROUTE_PREFIX,
  AgentDesktopTransferService,
} from "./agentDesktop/AgentDesktopTransferService.ts";
import {
  agentDesktopTransferDownloadRouteLayer,
  agentDesktopTransferUploadRouteLayer,
  assetResponseHeaders,
  isLoopbackHostname,
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
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });
});

describe("Agent desktop transfer routes", () => {
  it.effect("streams exact ranges and bounded upload chunks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-transfer-http-",
        });
        const archivePath = path.join(directory, "archive.bundle");
        const archive = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]);
        yield* fileSystem.writeFile(archivePath, archive);
        const token = "A".repeat(43);
        const uploads: Uint8Array[] = [];
        const transferLayer = Layer.succeed(
          AgentDesktopTransferService,
          AgentDesktopTransferService.of({
            start: () => Effect.die("unused"),
            status: () => Effect.die("unused"),
            cancel: () => Effect.die("unused"),
            download: (receivedToken, range) => {
              expect(receivedToken).toBe(token);
              expect(range).toBe("bytes=2-5");
              return Effect.succeed({
                status: "ready" as const,
                download: {
                  path: archivePath,
                  offset: 2,
                  bytesToRead: 4,
                  totalBytes: archive.byteLength,
                },
              });
            },
            upload: (receivedToken, input) => {
              expect(receivedToken).toBe(token);
              expect(input).toMatchObject({ start: 0, end: 3, total: 4 });
              uploads.push(input.data);
              return Effect.succeed({
                status: "accepted" as const,
                nextOffset: 4,
                complete: true,
              });
            },
          }),
        );
        yield* HttpRouter.serve(
          Layer.mergeAll(
            agentDesktopTransferDownloadRouteLayer,
            agentDesktopTransferUploadRouteLayer,
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.provide(transferLayer), Layer.build);
        const client = yield* HttpClient.HttpClient;
        const transferPath = `${AGENT_DESKTOP_TRANSFER_ROUTE_PREFIX}/${token}`;

        const downloaded = yield* client.get(transferPath, {
          headers: { range: "bytes=2-5" },
        });
        expect(downloaded.status).toBe(206);
        expect(downloaded.headers["content-range"]).toBe("bytes 2-5/8");
        expect(Buffer.from(yield* downloaded.arrayBuffer)).toEqual(archive.subarray(2, 6));

        const uploaded = yield* client.put(transferPath, {
          headers: { "content-range": "bytes 0-3/4" },
          body: HttpBody.uint8Array(new Uint8Array([1, 2, 3, 4])),
        });
        expect(uploaded.status).toBe(201);
        expect(uploaded.headers["upload-offset"]).toBe("4");
        expect(uploads).toHaveLength(1);
        expect([...uploads[0]!]).toEqual([1, 2, 3, 4]);

        const queried = yield* client.get(`${transferPath}?redirect=1`, {
          headers: { range: "bytes=2-5" },
        });
        expect(queried.status).toBe(404);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports transfer storage exhaustion precisely", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const token = "B".repeat(43);
        const transferLayer = Layer.succeed(
          AgentDesktopTransferService,
          AgentDesktopTransferService.of({
            start: () => Effect.die("unused"),
            status: () => Effect.die("unused"),
            cancel: () => Effect.die("unused"),
            download: () => Effect.die("unused"),
            upload: () =>
              Effect.succeed({
                status: "failed" as const,
                code: "resource-exhausted" as const,
                detail: "the transfer volume is full",
              }),
          }),
        );
        yield* HttpRouter.serve(agentDesktopTransferUploadRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.provide(transferLayer), Layer.build);
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.put(`${AGENT_DESKTOP_TRANSFER_ROUTE_PREFIX}/${token}`, {
          headers: { "content-range": "bytes 0-0/1" },
          body: HttpBody.uint8Array(new Uint8Array([1])),
        });

        expect(response.status).toBe(507);
        expect(yield* response.text).toBe("the transfer volume is full");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

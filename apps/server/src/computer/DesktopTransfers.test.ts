import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  DesktopTransferRequest,
  type UserDesktopTransferResult,
  type DesktopCopyInput,
  DESKTOP_TRANSFER_MANIFEST_HEADER,
} from "@t3tools/contracts";
import {
  packAgentDesktopBundle,
  desktopTransferArchiveChunks,
} from "@t3tools/shared/desktopTransfer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { ComputerAutomationRouter } from "./ComputerAutomationRouter.ts";
import * as Transfers from "./DesktopTransfers.ts";
import { userDesktopTransferRouteLayer } from "./userDesktopTransferHttp.ts";
import {
  desktopWorkspaceThread,
  transferCaller as caller,
} from "./testing/desktopWorkspace.fixture.ts";

const decodeTransfer = Schema.decodeUnknownEffect(DesktopTransferRequest);
it.effect.each(["user", "agent"] as const)(
  "binds %s transfer tickets to one direction and rechecks workspace writes at publication",
  (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-copy-" });
      const source = path.join(root, "source");
      yield* fs.writeFileString(source, "archive fixture");
      const thread = desktopWorkspaceThread(null);
      let permitted = true;
      const requests = yield* Queue.unbounded<{
        input: Extract<DesktopTransferRequest, { operation: "run" }>;
        reply: Deferred.Deferred<UserDesktopTransferResult>;
      }>();
      const router = Layer.mock(ComputerAutomationRouter)({
        invoke: (schema, scope, op, params) =>
          Effect.gen(function* () {
            expect([scope.environmentId, scope.threadId, op]).toEqual([
              caller.environmentId,
              thread.id,
              "computerTransfer",
            ]);
            const request = yield* decodeTransfer(params).pipe(Effect.orDie);
            expect(request.desktop.kind).toBe(kind);
            if (request.operation !== "run")
              return yield* Schema.decodeEffect(schema)({
                transferId: request.transferId,
                cancelled: true,
              }).pipe(Effect.orDie);
            const reply = yield* Deferred.make<UserDesktopTransferResult>();
            yield* Queue.offer(requests, { input: request, reply });
            return yield* Schema.decodeEffect(schema)(yield* Deferred.await(reply)).pipe(
              Effect.orDie,
            );
          }),
      });
      const layer = Transfers.layer.pipe(
        Layer.provide([
          ServerConfig.layerTest(root, { prefix: "desktop-copy-state-" }),
          router,
          Layer.mock(Projects.ProjectService)({
            getById: () => Effect.succeedSome({ workspaceRoot: root } as never),
          }),
          Layer.mock(Projection.ProjectionStoreV2)({
            getThreadRecords: () => Effect.succeed({ thread } as never),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: () =>
              Effect.succeed({
                runtimeMode: permitted ? "full-access" : "approval-required",
                interactionMode: "default",
                cwd: root,
              }),
          }),
        ]),
      );
      yield* Effect.gen(function* () {
        const transfers = yield* Transfers.DesktopTransfers;
        const routes = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              userDesktopTransferRouteLayer.pipe(
                Layer.provide(Layer.succeed(Transfers.DesktopTransfers, transfers)),
              ),
              { disableLogger: true },
            ),
          ),
          ({ dispose }) => Effect.promise(dispose),
        );
        const input: DesktopCopyInput = {
          desktop: { kind, desktopId: "selected" },
          copyId: "export",
          direction: "to-desktop",
          workspacePath: "source",
          desktopPath: "guest-target",
          waitMs: 0,
        };
        const download = yield* transfers.start(caller, input);
        const out = yield* Queue.take(requests);
        expect((yield* transfers.start(caller, input)).id).toBe(download.id);
        const active = (yield* transfers.listForDesktop(
          caller.environmentId,
          "selected",
          caller.thread.threadId,
        )).map((t) => t.id);
        expect(active).toEqual(kind === "user" ? [download.id] : []);
        expect(yield* transfers.listForDesktop("other", "selected")).toEqual([]);
        expect(yield* transfers.listForDesktop(caller.environmentId, "selected", "other")).toEqual(
          [],
        );
        const url = "http://desktop.test" + out.input.url;
        const manifest = out.input.manifest!;
        const headers = {
          authorization: "Bearer " + out.input.token,
          [DESKTOP_TRANSFER_MANIFEST_HEADER]: JSON.stringify(manifest),
          "content-length": String(manifest.wireBytes),
        };
        expect(
          (yield* Effect.promise(() =>
            routes.handler(new Request(url, { method: "POST", headers, body: "wrong direction" })),
          )).status,
        ).toBe(404);
        expect((yield* Effect.promise(() => routes.handler(new Request(url)))).status).toBe(404);
        const get = () => Effect.promise(() => routes.handler(new Request(url, { headers })));
        const response = yield* get();
        expect(response.status).toBe(200);
        expect((yield* Effect.promise(() => response.arrayBuffer())).byteLength).toBe(
          manifest.wireBytes,
        );
        expect((yield* get()).status).toBe(404);
        yield* Deferred.succeed(out.reply, { transferId: download.id, cancelled: false, manifest });
        expect(
          (yield* transfers.status(caller, { transferId: download.id, waitMs: 60_000 })).state,
        ).toBe("completed");
        expect(yield* transfers.listForDesktop(caller.environmentId, "selected")).toEqual([]);
        const archivePath = path.join(root, "archive");
        const packed = yield* Effect.promise(() =>
          packAgentDesktopBundle({
            sourcePath: source,
            outputPath: archivePath,
            compression: "gzip",
          }),
        );
        const upload = yield* transfers.start(caller, {
          ...input,
          direction: "from-desktop",
          workspacePath: "imported",
          copyId: "import",
        });
        const incoming = yield* Queue.take(requests),
          signal = yield* Effect.abortSignal;
        const body = () => desktopTransferArchiveChunks({ archivePath, signal });
        expect(transfers.download(upload.id, incoming.input.token)).toBeNull();
        expect(yield* transfers.upload(upload.id, incoming.input.token, packed, body())).toBe(true);
        expect(yield* transfers.upload(upload.id, incoming.input.token, packed, body())).toBe(
          false,
        );
        permitted = false;
        yield* Deferred.succeed(incoming.reply, {
          transferId: upload.id,
          cancelled: false,
          manifest: packed,
        });
        const result = yield* transfers.status(caller, { transferId: upload.id, waitMs: 60_000 });
        expect(result).toMatchObject({ state: "failed", error: { code: "permission-denied" } });
        expect(yield* fs.exists(path.join(root, "imported"))).toBe(false);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, NodeCrypto.layer])),
);

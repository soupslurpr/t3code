import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter } from "effect/unstable/http";
import { userDesktopTransferRouteLayer } from "./userDesktopTransferHttp.ts";
// @effect-diagnostics nodeBuiltinImport:off - Exercises actual archives and isolated workspaces.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserDesktopTransferRequest,
  type UserDesktopTransferResult,
  type UserDesktopCopyInput,
} from "@t3tools/contracts";
import {
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
} from "@t3tools/shared/agentDesktopBundle";
import {
  desktopTransferArchiveChunks,
  receiveDesktopTransferArchive,
} from "@t3tools/shared/desktopTransfer";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Transfers from "./UserDesktopTransfers.ts";

const decodeRequest = Schema.decodeUnknownEffect(UserDesktopTransferRequest);
const environmentId = EnvironmentId.make("environment-transfer-test");
const projectId = ProjectId.make("project-transfer-test");
const threadId = ThreadId.make("thread-transfer-test");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = "2026-09-11T00:00:00.000Z";
const modelSelection = { instanceId: providerInstanceId, model: "test-model" } as const;
const owner: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId,
  controllerId: "controller",
  providerSessionId: "session",
  providerInstanceId,
  capabilities: new Set(["computer"]),
  issuedAt: 0,
};
const desktop = { kind: "user", desktopId: "desktop-transfer-test" } as const;
const input: UserDesktopCopyInput = {
  desktop,
  copyId: "test-copy",
  direction: "to-desktop",
  workspacePath: "source",
  desktopPath: "destination",
  waitMs: 0,
};
function projectionLayer(workspaceRoot: string) {
  return Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: () =>
      Effect.succeed(
        Option.some({
          id: threadId,
          projectId,
          title: "Transfer test",
          pullRequests: [],
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        }),
      ),
    getProjectShellById: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          title: "Transfer test",
          workspaceRoot,
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        }),
      ),
  });
}

type NativeRequest = {
  input: Extract<UserDesktopTransferRequest, { operation: "run" }>;
  completion: Deferred.Deferred<UserDesktopTransferResult>;
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-user-transfer-test-" });
  yield* fs.writeFileString(NodePath.join(workspace, "source"), "exact bytes → \n");
  const requests = yield* Queue.unbounded<NativeRequest>();
  const broker = Layer.mock(PreviewAutomationBroker)({
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.gen(function* () {
        assert.equal(request.operation, "computerTransfer");
        const input = yield* decodeRequest(request.input).pipe(Effect.orDie);
        assert.equal(input.operation, "run");
        if (input.operation !== "run") return yield* Effect.die("Expected run");
        const completion = yield* Deferred.make<UserDesktopTransferResult>();
        yield* Queue.offer(requests, { input, completion });
        return (yield* Deferred.await(completion)) as A;
      }),
  });
  const service = Transfers.layer.pipe(
    Layer.provide(ServerConfig.layerTest(workspace, { prefix: "t3-user-transfer-service-" })),
    Layer.provide(broker),
  );
  return { workspace, requests, service, projections: projectionLayer(workspace) };
});

const withFixture = <A, E>(
  run: (
    value: Effect.Success<typeof fixture>,
  ) => Effect.Effect<A, E, Transfers.UserDesktopTransfers | ProjectionSnapshotQuery | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const value = yield* fixture;
    return yield* run(value).pipe(Effect.provide(Layer.merge(value.service, value.projections)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("user desktop transfers", () => {
  it.effect("serves archives only through the exact one-use HTTP capability", () =>
    withFixture(({ requests }) =>
      Effect.gen(function* () {
        const transfers = yield* Transfers.UserDesktopTransfers;
        const routes = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              userDesktopTransferRouteLayer.pipe(
                Layer.provide(Layer.succeed(Transfers.UserDesktopTransfers, transfers)),
              ),
              { disableLogger: true },
            ),
          ),
          ({ dispose }) => Effect.promise(dispose),
        );
        const started = yield* transfers.start(owner, input);
        const request = yield* Queue.take(requests);
        const url = `http://t3.test${request.input.url}`;
        const fetch = (token?: string) =>
          Effect.promise(() =>
            routes.handler(
              new Request(
                url,
                token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
              ),
            ),
          );
        assert.equal((yield* fetch()).status, 404);
        assert.equal((yield* fetch("0".repeat(64))).status, 404);
        const response = yield* fetch(request.input.token);
        assert.equal(response.status, 200);
        assert.equal(
          (yield* Effect.promise(() => response.arrayBuffer())).byteLength,
          request.input.manifest?.wireBytes,
        );
        assert.equal((yield* fetch(request.input.token)).status, 404);
        yield* transfers.cancel(owner, { transferId: started.id });
      }),
    ),
  );

  it.effect("expires a stalled transfer and cancels only its own worker", () =>
    withFixture(({ requests }) =>
      Effect.gen(function* () {
        const transfers = yield* Transfers.UserDesktopTransfers;
        const started = yield* transfers.start(owner, { ...input, timeoutMs: 1_000 });
        yield* Queue.take(requests);
        const other = yield* transfers.start(owner, {
          ...input,
          copyId: "other",
          timeoutMs: 10_000,
        });
        yield* Queue.take(requests);
        yield* TestClock.adjust(1_000);
        const result = yield* transfers.status(owner, { transferId: started.id, waitMs: 60_000 });
        assert.equal(result.state, "failed");
        assert.equal(result.error?.code, "timed-out");
        assert.equal((yield* transfers.status(owner, { transferId: other.id })).completedAt, null);
        yield* transfers.cancel(owner, { transferId: other.id });
      }),
    ),
  );

  it.effect("streams a verified download, confines credentials and rejects replay", () =>
    withFixture(({ workspace, requests }) =>
      Effect.gen(function* () {
        const transfers = yield* Transfers.UserDesktopTransfers;
        const started = yield* transfers.start(owner, input);
        const request = yield* Queue.take(requests);
        assert.isFalse("token" in started);
        assert.equal(transfers.download(started.id, "0".repeat(64)), null);
        const download = transfers.download(started.id, request.input.token);
        assert.isNotNull(download);
        assert.equal(transfers.download(started.id, request.input.token), null);
        if (download === null) return yield* Effect.die("Missing download");
        yield* Effect.promise(async () => {
          const archivePath = NodePath.join(workspace, "received.bundle");
          await receiveDesktopTransferArchive({
            archivePath,
            manifest: download.manifest,
            body: download.body,
            signal: new AbortController().signal,
          });
          await extractAgentDesktopBundle({
            archivePath,
            destinationPath: NodePath.join(workspace, "destination"),
            compression: download.manifest.compression,
          });
          assert.equal(
            await NodeFSP.readFile(NodePath.join(workspace, "destination"), "utf8"),
            "exact bytes → \n",
          );
        });
        yield* Deferred.succeed(request.completion, {
          transferId: started.id,
          cancelled: false,
          manifest: download.manifest,
        });
        const result = yield* transfers.status(owner, { transferId: started.id, waitMs: 60_000 });
        assert.equal(result.error, null);
        assert.equal(result.state, "completed");
        assert.equal(result.transferredBytes, download.manifest.wireBytes);
        assert.equal(result.error, null);
        assert.equal(transfers.download(started.id, request.input.token), null);
      }),
    ),
  );

  it.effect("accepts a verified upload before installing into the workspace", () =>
    withFixture(({ workspace, requests }) =>
      Effect.gen(function* () {
        const transfers = yield* Transfers.UserDesktopTransfers;
        const started = yield* transfers.start(owner, {
          ...input,
          direction: "from-desktop",
          workspacePath: "received",
        });
        const request = yield* Queue.take(requests);
        const archivePath = NodePath.join(workspace, "upload.bundle");
        const manifest = yield* Effect.promise(() =>
          packAgentDesktopBundle({
            sourcePath: NodePath.join(workspace, "source"),
            outputPath: archivePath,
            compression: "gzip",
          }),
        );
        assert.equal(transfers.download(started.id, request.input.token), null);
        assert.isTrue(
          yield* transfers.upload(
            started.id,
            request.input.token,
            manifest,
            desktopTransferArchiveChunks({ archivePath, signal: new AbortController().signal }),
          ),
        );
        assert.isFalse(
          yield* transfers.upload(
            started.id,
            request.input.token,
            manifest,
            desktopTransferArchiveChunks({ archivePath, signal: new AbortController().signal }),
          ),
        );
        yield* Deferred.succeed(request.completion, {
          transferId: started.id,
          cancelled: false,
          manifest,
        });
        const result = yield* transfers.status(owner, { transferId: started.id, waitMs: 60_000 });
        assert.equal(result.error, null);
        assert.equal(result.state, "completed");
        assert.equal(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(workspace, "received"), "utf8"),
          ),
          "exact bytes → \n",
        );
      }),
    ),
  );

  it.effect("deduplicates retry IDs, refuses changed arguments and separates threads", () =>
    withFixture(({ requests }) =>
      Effect.gen(function* () {
        const transfers = yield* Transfers.UserDesktopTransfers;
        const copies = yield* Effect.all(
          [transfers.start(owner, input), transfers.start(owner, input)],
          { concurrency: "unbounded" },
        );
        assert.equal(copies[0].id, copies[1].id);
        yield* Queue.take(requests);
        const changed = yield* transfers
          .start(owner, { ...input, desktopPath: "different" })
          .pipe(Effect.flip);
        assert.include(changed.message, "different transfer");
        const foreign = { ...owner, threadId: ThreadId.make("other-thread") };
        assert.include(
          (yield* transfers.status(foreign, { transferId: copies[0].id }).pipe(Effect.flip))
            .message,
          "not found",
        );
        assert.include(
          (yield* transfers.cancel(foreign, { transferId: copies[0].id }).pipe(Effect.flip))
            .message,
          "not found",
        );
        const cancelled = yield* transfers.cancel(owner, { transferId: copies[0].id });
        assert.equal(cancelled.state, "cancelled");
        assert.equal(
          (yield* transfers.status(owner, { transferId: cancelled.id })).state,
          "cancelled",
        );
      }),
    ),
  );

  it.effect("rejects escaping paths and unauthenticated upload acknowledgements", () =>
    withFixture(({ requests }) =>
      Effect.gen(function* () {
        const transfers = yield* Transfers.UserDesktopTransfers;
        const escaping = yield* transfers.start(owner, {
          ...input,
          workspacePath: "../outside",
          waitMs: 60_000,
        });
        assert.equal(escaping.error?.code, "invalid-source");
        const incoming = yield* transfers.start(owner, {
          ...input,
          copyId: "incoming",
          direction: "from-desktop",
          workspacePath: "received",
        });
        const request = yield* Queue.take(requests);
        yield* Deferred.succeed(request.completion, { transferId: incoming.id, cancelled: false });
        const result = yield* transfers.status(owner, { transferId: incoming.id, waitMs: 60_000 });
        assert.equal(result.error?.code, "integrity-failed");
      }),
    ),
  );
});

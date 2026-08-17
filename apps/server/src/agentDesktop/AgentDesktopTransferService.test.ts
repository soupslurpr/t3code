// @effect-diagnostics nodeBuiltinImport:off - Protocol tests exercise real bounded file ranges.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentDesktopId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentDesktopHostTransferInput,
  type AgentDesktopHostTransferResult,
} from "@t3tools/contracts";
import {
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
} from "@t3tools/shared/agentDesktopBundle";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentDesktopTransfer from "./AgentDesktopTransferService.ts";

const environmentId = EnvironmentId.make("environment-transfer-test");
const projectId = ProjectId.make("project-transfer-test");
const threadId = ThreadId.make("thread-transfer-test");
const providerInstanceId = ProviderInstanceId.make("codex");
const desktopId = AgentDesktopId.make("agent-transfer-test");
const now = "2026-08-14T00:00:00.000Z";
const modelSelection = { instanceId: providerInstanceId, model: "test-model" } as const;
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "session-transfer-test",
  providerInstanceId,
  capabilities: new Set(["computer"]),
  issuedAt: 0,
};

/** Provides the two projection rows needed to confine workspace paths. */
function projectionLayer(workspaceRoot: string) {
  return Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: () =>
      Effect.succeed(
        Option.some({
          id: threadId,
          projectId,
          title: "Transfer test",
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

/** Creates one broker service around an exact host-side transfer handler. */
function brokerLayer(
  handleTransfer: (
    input: AgentDesktopHostTransferInput,
  ) => Effect.Effect<AgentDesktopHostTransferResult>,
) {
  return Layer.succeed(
    PreviewAutomationBroker.PreviewAutomationBroker,
    PreviewAutomationBroker.PreviewAutomationBroker.of({
      connect: () => Effect.die("unused"),
      focusHost: () => Effect.die("unused"),
      respond: () => Effect.die("unused"),
      invoke: <Result>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) => {
        if (request.operation === "agentDesktopTransfer") {
          return handleTransfer(request.input as AgentDesktopHostTransferInput).pipe(
            Effect.map((result) => result as Result),
          );
        }
        if (request.operation === "agentDesktopTransferCancel") {
          return Effect.succeed(undefined as Result);
        }
        return Effect.die(`unexpected operation ${request.operation}`);
      },
    }),
  );
}

/** Creates a host that reports one categorized guest transfer rejection. */
function rejectingBrokerLayer(backendCode: string, detail: string) {
  return Layer.succeed(
    PreviewAutomationBroker.PreviewAutomationBroker,
    PreviewAutomationBroker.PreviewAutomationBroker.of({
      connect: () => Effect.die("unused"),
      focusHost: () => Effect.die("unused"),
      respond: () => Effect.die("unused"),
      invoke: () =>
        Effect.fail({
          computerFailure: {
            code: "guest-operation-failed",
            category: "conflict",
            message: "The Agent desktop file transfer was rejected.",
            backendCode,
            detail,
          },
        } as never),
    }),
  );
}

/** Extracts a capability token from the service-owned relative route. */
function transferToken(url: string): string {
  const token = url.split("/").at(-1);
  assert.isDefined(token);
  return token;
}

/** Copies every bounded server range into one local archive. */
function downloadArchive(
  transfers: AgentDesktopTransfer.AgentDesktopTransferServiceShape,
  token: string,
  sizeBytes: number,
  destination: string,
): Effect.Effect<void> {
  return Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.open(destination, "wx")),
    (destinationHandle) =>
      Effect.gen(function* () {
        let offset = 0;
        while (offset < sizeBytes) {
          const end = Math.min(sizeBytes - 1, offset + 16_383);
          const result = yield* transfers.download(token, `bytes=${offset}-${end}`);
          assert.equal(result.status, "ready");
          if (result.status !== "ready") return yield* Effect.die("transfer range unavailable");
          const data = yield* Effect.promise(async () => {
            const sourceHandle = await NodeFSP.open(result.download.path, "r");
            try {
              const bytes = Buffer.alloc(result.download.bytesToRead);
              const read = await sourceHandle.read(
                bytes,
                0,
                bytes.byteLength,
                result.download.offset,
              );
              assert.equal(read.bytesRead, bytes.byteLength);
              return bytes;
            } finally {
              await sourceHandle.close();
            }
          });
          yield* Effect.promise(() =>
            destinationHandle.write(data, 0, data.byteLength, offset).then(() => undefined),
          );
          offset = end + 1;
        }
        yield* Effect.promise(() => destinationHandle.sync());
      }),
    (destinationHandle) => Effect.promise(() => destinationHandle.close()),
  );
}

/** Uploads one archive through sequential, idempotent service chunks. */
function uploadArchive(
  transfers: AgentDesktopTransfer.AgentDesktopTransferServiceShape,
  token: string,
  source: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const data = yield* Effect.promise(() => NodeFSP.readFile(source));
    let offset = 0;
    while (offset < data.byteLength) {
      const end = Math.min(data.byteLength, offset + 16_384);
      const chunk = data.subarray(offset, end);
      const result = yield* transfers.upload(token, {
        start: offset,
        end: end - 1,
        total: data.byteLength,
        data: chunk,
      });
      assert.equal(result.status, "accepted");
      if (result.status !== "accepted") return yield* Effect.die("transfer chunk was rejected");
      assert.equal(result.nextOffset, end);
      offset = end;
    }
  });
}

/** Provides a fresh service state directory for one scoped transfer test. */
function withTransferService<A, E>(
  workspaceRoot: string,
  effect: Effect.Effect<A, E, AgentDesktopTransfer.AgentDesktopTransferService>,
) {
  const layer = AgentDesktopTransfer.layer.pipe(
    Layer.provide(ServerConfig.layerTest(workspaceRoot, { prefix: "t3-agent-transfer-service-" })),
    Layer.provide(NodeServices.layer),
  );
  return effect.pipe(Effect.provide(layer));
}

describe("AgentDesktopTransferService", () => {
  it.effect("copies a directory from the workspace through ranged download", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-transfer-workspace-",
        });
        const source = NodePath.join(workspaceRoot, "source");
        const guestArchive = NodePath.join(workspaceRoot, "guest.bundle");
        const guestDestination = NodePath.join(workspaceRoot, "guest-result");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(source);
          await NodeFSP.writeFile(NodePath.join(source, "message.txt"), "exact Unicode: ’ →\n");
        });

        yield* withTransferService(
          workspaceRoot,
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const host = brokerLayer((input) => {
              assert.equal(input.operation, "import");
              if (input.operation !== "import") return Effect.die("unexpected export");
              return Effect.gen(function* () {
                yield* downloadArchive(
                  transfers,
                  transferToken(input.url),
                  input.sizeBytes,
                  guestArchive,
                );
                const tree = yield* Effect.promise(() =>
                  extractAgentDesktopBundle({
                    archivePath: guestArchive,
                    destinationPath: guestDestination,
                    compression: input.compression,
                    collision: input.collision,
                  }),
                );
                return {
                  desktopId,
                  transferId: input.transferId,
                  compression: input.compression,
                  wireBytes: input.sizeBytes,
                  sha256: input.sha256,
                  tree,
                };
              });
            });
            const result = yield* transfers
              .start(scope, {
                source: { kind: "workspace", path: "source" },
                destination: { kind: "agent", desktopId, path: "~/received" },
                collision: "create",
                compression: "gzip",
                waitMs: 60_000,
              })
              .pipe(Effect.provide(Layer.mergeAll(projectionLayer(workspaceRoot), host)));

            assert.equal(result.state, "completed", result.error?.detail);
            assert.equal(result.transferredBytes, result.totalBytes);
            assert.deepInclude(result.destination, { kind: "agent", desktopId });
            assert.deepInclude(result.tree, {
              rootType: "directory",
              fileCount: 1,
              directoryCount: 1,
              symlinkCount: 0,
            });
            assert.equal(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(guestDestination, "message.txt"), "utf8"),
              ),
              "exact Unicode: ’ →\n",
            );
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("copies a directory into the workspace through resumable upload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-transfer-workspace-",
        });
        const guestSource = NodePath.join(workspaceRoot, "guest-source");
        const guestArchive = NodePath.join(workspaceRoot, "guest.bundle");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(guestSource);
          await NodeFSP.writeFile(
            NodePath.join(guestSource, "result.bin"),
            Buffer.alloc(40_000, 37),
          );
        });
        const packed = yield* Effect.promise(() =>
          packAgentDesktopBundle({
            sourcePath: guestSource,
            outputPath: guestArchive,
            compression: "none",
          }),
        );

        yield* withTransferService(
          workspaceRoot,
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const host = brokerLayer((input) => {
              assert.equal(input.operation, "export");
              if (input.operation !== "export") return Effect.die("unexpected import");
              return Effect.gen(function* () {
                const token = transferToken(input.url);
                yield* uploadArchive(transfers, token, guestArchive);
                const data = yield* Effect.promise(() => NodeFSP.readFile(guestArchive));
                const firstChunk = data.subarray(0, Math.min(16_384, data.byteLength));
                const retried = yield* transfers.upload(token, {
                  start: 0,
                  end: firstChunk.byteLength - 1,
                  total: data.byteLength,
                  data: firstChunk,
                });
                assert.deepInclude(retried, {
                  status: "accepted",
                  nextOffset: data.byteLength,
                  complete: true,
                });
                return {
                  desktopId,
                  transferId: input.transferId,
                  compression: packed.compression,
                  wireBytes: packed.wireBytes,
                  sha256: packed.sha256,
                  tree: packed,
                };
              });
            });
            const result = yield* transfers
              .start(scope, {
                source: { kind: "agent", desktopId, path: "~/result" },
                destination: { kind: "workspace", path: "received" },
                collision: "create",
                compression: "none",
                waitMs: 60_000,
              })
              .pipe(Effect.provide(Layer.mergeAll(projectionLayer(workspaceRoot), host)));

            assert.equal(result.state, "completed", result.error?.detail);
            assert.equal(result.sha256, packed.sha256);
            assert.deepInclude(result.source, { kind: "agent", desktopId });
            assert.deepEqual(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(workspaceRoot, "received", "result.bin")),
              ),
              Buffer.alloc(40_000, 37),
            );
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels an active host transfer and retains its terminal status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-transfer-workspace-",
        });
        yield* fileSystem.writeFileString(NodePath.join(workspaceRoot, "source.txt"), "pending");

        yield* withTransferService(
          workspaceRoot,
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const host = brokerLayer(() => Effect.never);
            const dependencies = Layer.mergeAll(projectionLayer(workspaceRoot), host);
            const started = yield* transfers
              .start(scope, {
                source: { kind: "workspace", path: "source.txt" },
                destination: { kind: "agent", desktopId, path: "~/pending.txt" },
                waitMs: 0,
              })
              .pipe(Effect.provide(dependencies));
            const cancelled = yield* transfers
              .cancel(scope, { transferId: started.id })
              .pipe(Effect.provide(dependencies));
            const retained = yield* transfers.status(scope, { transferId: started.id });

            assert.equal(cancelled.state, "cancelled");
            assert.equal(cancelled.error?.code, "cancelled");
            assert.deepEqual(retained, cancelled);
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves categorized guest failures in terminal status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-transfer-workspace-",
        });
        yield* fileSystem.writeFileString(NodePath.join(workspaceRoot, "source.txt"), "source");

        yield* withTransferService(
          workspaceRoot,
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const result = yield* transfers
              .start(scope, {
                source: { kind: "workspace", path: "source.txt" },
                destination: { kind: "agent", desktopId, path: "~/existing.txt" },
                waitMs: 60_000,
              })
              .pipe(
                Effect.provide(
                  Layer.mergeAll(
                    projectionLayer(workspaceRoot),
                    rejectingBrokerLayer("destination-exists", "destination already exists"),
                  ),
                ),
              );

            assert.equal(result.state, "failed");
            assert.deepEqual(result.error, {
              code: "destination-exists",
              phase: "installing",
              detail: "destination already exists",
            });
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("admits at most eight concurrent transfers per controller", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-transfer-workspace-",
        });
        yield* fileSystem.writeFileString(NodePath.join(workspaceRoot, "source.txt"), "source");

        yield* withTransferService(
          workspaceRoot,
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const dependencies = Layer.mergeAll(
              projectionLayer(workspaceRoot),
              brokerLayer(() => Effect.never),
            );
            const started = yield* Effect.all(
              Array.from({ length: 9 }, (_, index) =>
                transfers
                  .start(scope, {
                    source: { kind: "workspace", path: "source.txt" },
                    destination: { kind: "agent", desktopId, path: `~/copy-${index}.txt` },
                    waitMs: 0,
                  })
                  .pipe(Effect.provide(dependencies)),
              ),
              { concurrency: "unbounded" },
            );
            assert.equal(started.filter((transfer) => transfer.state === "failed").length, 1);
            assert.equal(
              started.find((transfer) => transfer.state === "failed")?.error?.code,
              "resource-exhausted",
            );
            yield* Effect.all(
              started
                .filter((transfer) => transfer.state !== "failed")
                .map((transfer) =>
                  transfers
                    .cancel(scope, { transferId: transfer.id })
                    .pipe(Effect.provide(dependencies)),
                ),
              { concurrency: "unbounded" },
            );
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

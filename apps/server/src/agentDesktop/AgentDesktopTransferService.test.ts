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
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentDesktopManager from "./AgentDesktopManager.ts";
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

/** Creates one manager service around an exact server-local transfer handler. */
function managerLayer(
  handleTransfer: (
    input: AgentDesktopManager.AgentDesktopManagerTransferInput,
  ) => Effect.Effect<
    AgentDesktopManager.AgentDesktopManagerTransferResult,
    AgentDesktopManager.AgentDesktopManagerOperationError
  >,
) {
  return Layer.mock(AgentDesktopManager.AgentDesktopManager)({
    transfer: (_owner, input) => handleTransfer(input),
    cancelTransfer: () => Effect.void,
  });
}

/** Creates a manager that reports one categorized guest transfer rejection. */
function rejectingManagerLayer(code: "destination-exists", detail: string) {
  return managerLayer(() =>
    Effect.fail(
      new AgentDesktopManager.AgentDesktopManagerError({
        code,
        operation: "guest-transfer-helper",
        detail,
      }),
    ),
  );
}

/** Provides a fresh service state directory for one scoped transfer test. */
function withTransferService<A, E>(
  workspaceRoot: string,
  manager: Layer.Layer<AgentDesktopManager.AgentDesktopManager>,
  effect: Effect.Effect<A, E, AgentDesktopTransfer.AgentDesktopTransferService>,
) {
  const layer = AgentDesktopTransfer.layer.pipe(
    Layer.provide(ServerConfig.layerTest(workspaceRoot, { prefix: "t3-agent-transfer-service-" })),
    Layer.provide(NodeServices.layer),
    Layer.provide(manager),
  );
  return effect.pipe(Effect.provide(layer));
}

describe("AgentDesktopTransferService", () => {
  it.effect("copies a directory directly from the workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-transfer-workspace-",
        });
        const source = NodePath.join(workspaceRoot, "source");
        const guestDestination = NodePath.join(workspaceRoot, "guest-result");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(source);
          await NodeFSP.writeFile(NodePath.join(source, "message.txt"), "exact Unicode: ’ →\n");
        });

        yield* withTransferService(
          workspaceRoot,
          managerLayer((input) => {
            assert.equal(input.operation, "import");
            if (input.operation !== "import") return Effect.die("unexpected export");
            return Effect.gen(function* () {
              const tree = yield* Effect.promise(() =>
                extractAgentDesktopBundle({
                  archivePath: input.archivePath,
                  destinationPath: guestDestination,
                  compression: input.compression,
                  collision: input.collision,
                }),
              );
              yield* input.onProgress?.(input.sizeBytes, input.sizeBytes) ?? Effect.void;
              return {
                desktopId,
                transferId: input.transferId,
                compression: input.compression,
                wireBytes: input.sizeBytes,
                sha256: input.sha256,
                tree,
              };
            });
          }),
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const result = yield* transfers
              .start(scope, {
                source: { kind: "workspace", path: "source" },
                destination: { kind: "agent", desktopId, path: "~/received" },
                collision: "create",
                compression: "gzip",
                waitMs: 60_000,
              })
              .pipe(Effect.provide(projectionLayer(workspaceRoot)));

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

  it.effect("copies a directory directly into the workspace", () =>
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
          managerLayer((input) => {
            assert.equal(input.operation, "export");
            if (input.operation !== "export") return Effect.die("unexpected import");
            return Effect.gen(function* () {
              yield* Effect.promise(() => NodeFSP.copyFile(guestArchive, input.archivePath));
              yield* input.onProgress?.(packed.wireBytes, packed.wireBytes) ?? Effect.void;
              return {
                desktopId,
                transferId: input.transferId,
                compression: packed.compression,
                wireBytes: packed.wireBytes,
                sha256: packed.sha256,
                tree: packed,
              };
            });
          }),
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const result = yield* transfers
              .start(scope, {
                source: { kind: "agent", desktopId, path: "~/result" },
                destination: { kind: "workspace", path: "received" },
                collision: "create",
                compression: "none",
                waitMs: 60_000,
              })
              .pipe(Effect.provide(projectionLayer(workspaceRoot)));

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

  it.effect("cancels an active guest transfer and retains its terminal status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-transfer-workspace-",
        });
        yield* fileSystem.writeFileString(NodePath.join(workspaceRoot, "source.txt"), "pending");

        yield* withTransferService(
          workspaceRoot,
          managerLayer(() => Effect.never),
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const started = yield* transfers
              .start(scope, {
                source: { kind: "workspace", path: "source.txt" },
                destination: { kind: "agent", desktopId, path: "~/pending.txt" },
                waitMs: 0,
              })
              .pipe(Effect.provide(projectionLayer(workspaceRoot)));
            const cancelled = yield* transfers.cancel(scope, { transferId: started.id });
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
          rejectingManagerLayer("destination-exists", "destination already exists"),
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const result = yield* transfers
              .start(scope, {
                source: { kind: "workspace", path: "source.txt" },
                destination: { kind: "agent", desktopId, path: "~/existing.txt" },
                waitMs: 60_000,
              })
              .pipe(Effect.provide(projectionLayer(workspaceRoot)));

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
          managerLayer(() => Effect.never),
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const started = yield* Effect.all(
              Array.from({ length: 9 }, (_, index) =>
                transfers
                  .start(scope, {
                    source: { kind: "workspace", path: "source.txt" },
                    destination: { kind: "agent", desktopId, path: `~/copy-${index}.txt` },
                    waitMs: 0,
                  })
                  .pipe(Effect.provide(projectionLayer(workspaceRoot))),
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
                .map((transfer) => transfers.cancel(scope, { transferId: transfer.id })),
              { concurrency: "unbounded" },
            );
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

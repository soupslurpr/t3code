// @effect-diagnostics nodeBuiltinImport:off - Protocol tests exercise real bounded file ranges.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
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
import { vi } from "vite-plus/test";
import * as Bundle from "@t3tools/shared/agentDesktopBundle";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ThreadWorkspaceQuery } from "../orchestration-v2/ThreadWorkspaceQuery.ts";
import * as AgentDesktopManager from "./AgentDesktopManager.ts";
import * as AgentDesktopTransfer from "./AgentDesktopTransferService.ts";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const environmentId = EnvironmentId.make("environment-transfer-test");
const projectId = ProjectId.make("project-transfer-test");
const threadId = ThreadId.make("thread-transfer-test");
const providerInstanceId = ProviderInstanceId.make("codex");
const desktopId = AgentDesktopId.make("agent-transfer-test");
const now = "2026-08-14T00:00:00.000Z";
const modelSelection = { instanceId: providerInstanceId, model: "test-model" } as const;
const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId,
  thread: {
    threadId,
    controllerId: "controller-transfer-test",
    providerSessionId: "session-transfer-test",
    providerInstanceId,
  },
  requestNamespace: "transfer-test",
  client: undefined,
  capabilities: new Set(["computer"]),
  issuedAt: 0,
};

/** Provides the two projection rows needed to confine workspace paths. */
function projectionLayer(workspaceRoot: string, worktreePath: string | null = null) {
  return Layer.mock(ThreadWorkspaceQuery)({
    getThreadShellById: () =>
      Effect.succeedSome({
        id: threadId,
        projectId,
        title: "Transfer test",
        pullRequests: [],
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath,
        activeRunId: null,
        pendingRuntimeRequest: null,
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
    getProjectShellById: () =>
      Effect.succeedSome({
        id: projectId,
        title: "Transfer test",
        workspaceRoot,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      }),
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
    transfer: (owner, input) => {
      assert.equal(owner.controllerId, scope.thread.controllerId);
      return handleTransfer(input);
    },
    cancelTransfer: (owner) => {
      assert.equal(owner.controllerId, scope.thread.controllerId);
      return Effect.void;
    },
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
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
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
              .pipe(Effect.provide(projectionLayer("/unused/project-root", workspaceRoot)));

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

  it.live.each(["success", "collision", "post-commit-error", "lost-receipt"] as const)(
    "settles host publication before reporting racing cancellation: %s",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const workspaceRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-transfer-publish-cancel-",
          });
          const source = NodePath.join(workspaceRoot, "source");
          const archive = NodePath.join(workspaceRoot, "bundle");
          yield* fs.writeFileString(source, "published payload");
          const packed = yield* Effect.promise(() =>
            packAgentDesktopBundle({
              sourcePath: source,
              outputPath: archive,
              compression: "none",
            }),
          );
          if (scenario === "collision")
            yield* fs.writeFileString(NodePath.join(workspaceRoot, "received"), "existing payload");
          const committed = Promise.withResolvers<void>();
          const receipt = Promise.withResolvers<void>();
          const realExtract = Bundle.extractAgentDesktopBundle;
          using _extract = vi
            .spyOn(Bundle, "extractAgentDesktopBundle")
            .mockImplementation((input) => {
              input.signal?.addEventListener("abort", () => receipt.resolve(), { once: true });
              return realExtract({
                ...input,
                loadKoffi: async () => {
                  const koffi = await (
                    input.loadKoffi ?? (async () => (await import("koffi")).default)
                  )();
                  // oxlint-disable-next-line t3code/no-global-process-runtime -- This fixture wraps the executing native ABI, not an injected host platform.
                  const windows = process.platform === "win32";
                  const kernel = windows ? koffi.load("kernel32.dll") : null;
                  const getError =
                    kernel?.func("uint32_t __stdcall GetLastError(void)") ?? (() => koffi.errno());
                  const setError =
                    kernel?.func("void __stdcall SetLastError(uint32_t)") ??
                    ((code: number) => koffi.errno(code));
                  return {
                    ...koffi,
                    load: (...args) => {
                      const library = koffi.load(...args);
                      return {
                        ...library,
                        func: ((...definition: Parameters<typeof library.func>) => {
                          const fn = library.func(...definition);
                          if (
                            !/renameat2|renameatx_np|SetFileInformationByHandle/.test(
                              String(definition[0]),
                            )
                          )
                            return fn;
                          return Object.assign(fn.bind(null), fn, {
                            async: (...args: unknown[]) => {
                              const callback = args.pop() as (
                                error: unknown,
                                value?: unknown,
                              ) => void;
                              fn.async(...args, (error: unknown, value: unknown) => {
                                const code = getError();
                                committed.resolve();
                                void receipt.promise.then(() => {
                                  if (scenario === "lost-receipt") {
                                    callback(
                                      new Error("injected lost receipt", {
                                        cause: input.signal?.reason,
                                      }),
                                    );
                                    return;
                                  }
                                  setError(scenario === "post-commit-error" ? 5 : code);
                                  callback(
                                    error,
                                    scenario === "post-commit-error" ? (windows ? 0 : -1) : value,
                                  );
                                });
                              });
                            },
                          });
                        }) as typeof library.func,
                      };
                    },
                  };
                },
              });
            });
          try {
            yield* withTransferService(
              workspaceRoot,
              managerLayer((input) =>
                Effect.gen(function* () {
                  yield* Effect.promise(() => NodeFSP.copyFile(archive, input.archivePath));
                  return {
                    desktopId,
                    transferId: input.transferId,
                    compression: packed.compression,
                    wireBytes: packed.wireBytes,
                    sha256: packed.sha256,
                    tree: packed,
                  };
                }),
              ),
              Effect.gen(function* () {
                const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
                const started = yield* transfers
                  .start(scope, {
                    source: { kind: "agent", desktopId, path: "~/source" },
                    destination: { kind: "workspace", path: "received" },
                    compression: "none",
                    waitMs: 0,
                  })
                  .pipe(Effect.provide(projectionLayer(workspaceRoot)));
                yield* Effect.promise(() => committed.promise);
                const result = yield* transfers.cancel(scope, { transferId: started.id });
                if (scenario === "success") {
                  assert.equal(result.state, "completed", result.error?.detail);
                  assert.isNull(result.error);
                } else {
                  assert.equal(result.state, "failed");
                  if (scenario === "collision")
                    assert.equal(result.error?.code, "destination-exists");
                  else
                    assert.match(result.error?.detail ?? "", /publication outcome is unconfirmed/i);
                }
                assert.equal(
                  yield* fs.readFileString(NodePath.join(workspaceRoot, "received")),
                  scenario === "collision" ? "existing payload" : "published payload",
                );
                assert.deepEqual(
                  yield* transfers.status(scope, { transferId: started.id }),
                  result,
                );
              }),
            );
          } finally {
            receipt.resolve();
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    ["staging-cleanup", "cancel"],
    ["gzip", "cancel"],
    ["staging-cleanup", "timeout"],
    ["gzip", "timeout"],
  ] as const)("retains pre-publication cancellation through %s on %s", ([scenario, interruption]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transfer-abort-" });
        const source = NodePath.join(workspaceRoot, "source");
        const archive = NodePath.join(workspaceRoot, "bundle");
        const destination = NodePath.join(workspaceRoot, "received");
        yield* fs.writeFileString(source, "complete payload");
        const packed = yield* Effect.promise(() =>
          packAgentDesktopBundle({
            sourcePath: source,
            outputPath: archive,
            compression: scenario === "gzip" ? "gzip" : "none",
          }),
        );
        const reached = Promise.withResolvers<void>();
        const aborted = Promise.withResolvers<void>();
        const realWriteStream = NodeFS.createWriteStream;
        const _write = vi.spyOn(NodeFS, "createWriteStream").mockImplementation((path, options) => {
          const stream = realWriteStream(path, options);
          if (scenario === "gzip" && String(path).endsWith(".raw")) {
            const write = stream._write;
            stream._write = (chunk, encoding, callback) => {
              write.call(stream, chunk, encoding, (error) => {
                reached.resolve();
                void aborted.promise.then(() => callback(error));
              });
            };
          }
          return stream;
        });
        const unlink = NodeFSP.unlink;
        const _unlink = vi.spyOn(NodeFSP, "unlink").mockImplementation(async (path) => {
          if (
            scenario === "staging-cleanup" &&
            String(path).startsWith(`${destination}.t3-transfer-`)
          )
            throw Object.assign(new Error("injected staging cleanup failure"), { code: "EIO" });
          return unlink(path);
        });
        const realExtract = Bundle.extractAgentDesktopBundle;
        const loadBinding = vi.fn(async () => {
          throw new Error("no native submission allowed");
        });
        const _extract = vi
          .spyOn(Bundle, "extractAgentDesktopBundle")
          .mockImplementation((input) => {
            input.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
            return realExtract({
              ...input,
              loadKoffi: async () => {
                if (scenario === "staging-cleanup") {
                  reached.resolve();
                  await aborted.promise;
                  input.signal?.throwIfAborted();
                }
                return loadBinding();
              },
            }).catch((cause: unknown) => {
              reached.reject(cause);
              throw cause;
            });
          });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            aborted.resolve();
            _extract.mockRestore();
            _unlink.mockRestore();
            _write.mockRestore();
          }),
        );
        yield* withTransferService(
          workspaceRoot,
          managerLayer((input) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => NodeFSP.copyFile(archive, input.archivePath));
              return {
                desktopId,
                transferId: input.transferId,
                compression: packed.compression,
                wireBytes: packed.wireBytes,
                sha256: packed.sha256,
                tree: packed,
              };
            }),
          ),
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const started = yield* transfers
              .start(scope, {
                source: { kind: "agent", desktopId, path: "~/source" },
                destination: { kind: "workspace", path: "received" },
                compression: packed.compression,
                waitMs: 0,
                timeoutMs: 100,
              })
              .pipe(Effect.provide(projectionLayer(workspaceRoot)));
            yield* Effect.promise(() => reached.promise);
            if (interruption === "timeout") yield* TestClock.adjust(100);
            const result = yield* interruption === "cancel"
              ? transfers.cancel(scope, { transferId: started.id })
              : transfers.status(scope, { transferId: started.id, waitMs: 15_000 });
            assert.equal(result.state, interruption === "cancel" ? "cancelled" : "failed");
            assert.equal(result.error?.code, interruption === "cancel" ? "cancelled" : "timed-out");
            assert.isFalse(yield* fs.exists(destination));
            assert.equal(loadBinding.mock.calls.length, 0);
            const retained = (yield* fs.readDirectory(workspaceRoot)).filter((path) =>
              path.includes(".t3-transfer-"),
            );
            if (scenario === "staging-cleanup") {
              assert.lengthOf(retained, 1);
              assert.include(
                result.error?.detail ?? "",
                NodePath.join(workspaceRoot, retained[0]!),
              );
              assert.equal(
                yield* fs.readFileString(NodePath.join(workspaceRoot, retained[0]!)),
                "complete payload",
              );
            } else assert.deepEqual(retained, []);
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

        const entered = yield* Deferred.make<void>();
        yield* withTransferService(
          workspaceRoot,
          managerLayer(() =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
          Effect.gen(function* () {
            const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
            const started = yield* transfers
              .start(scope, {
                source: { kind: "workspace", path: "source.txt" },
                destination: { kind: "agent", desktopId, path: "~/pending.txt" },
                waitMs: 0,
              })
              .pipe(Effect.provide(projectionLayer(workspaceRoot)));
            yield* Deferred.await(entered);
            for (const stranger of [
              { ...scope, environmentId: EnvironmentId.make("foreign") },
              { ...scope, thread: { ...scope.thread, threadId: ThreadId.make("foreign") } },
              { ...scope, thread: { ...scope.thread, providerSessionId: "foreign" } },
            ]) {
              const denied = yield* transfers
                .status(stranger, { transferId: started.id })
                .pipe(Effect.flip);
              assert.equal(denied._tag, "AgentDesktopTransferLookupError");
            }
            const cancelled = yield* transfers.cancel(scope, { transferId: started.id });
            const retained = yield* transfers.status(scope, { transferId: started.id });

            assert.equal(cancelled.state, "cancelled");
            assert.equal(cancelled.error?.code, "cancelled");
            assert.match(cancelled.error?.detail ?? "", /publication.*unconfirmed/i);
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
            yield* Effect.forEach(
              started.filter((transfer) => transfer.state !== "failed"),
              (transfer) => transfers.cancel(scope, { transferId: transfer.id }),
              { concurrency: "unbounded" },
            );
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.effect.each([
  "foreign-environment",
  "source-traversal",
  "source-link",
  "destination-traversal",
  "destination-link",
] as const)("rejects %s before invoking a host", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transfer-boundary-" });
    const root = NodePath.join(directory, "workspace");
    const outside = NodePath.join(directory, "outside");
    yield* fs.makeDirectory(root);
    yield* fs.makeDirectory(outside);
    yield* fs.writeFileString(NodePath.join(outside, "secret"), "outside");
    yield* fs.writeFileString(NodePath.join(root, "source"), "source");
    yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(root, "link")));
    yield* withTransferService(
      root,
      managerLayer(() => Effect.die("manager must not receive an unconfined path")),
      Effect.gen(function* () {
        const transfers = yield* AgentDesktopTransfer.AgentDesktopTransferService;
        const fromAgent = scenario.startsWith("destination");
        const sourcePath =
          scenario === "source-traversal"
            ? "../outside/secret"
            : scenario === "source-link"
              ? "link/secret"
              : "source";
        const result = yield* transfers
          .start(
            scenario === "foreign-environment"
              ? { ...scope, environmentId: EnvironmentId.make("foreign") }
              : scope,
            {
              source: fromAgent
                ? { kind: "agent", desktopId, path: "~/source" }
                : { kind: "workspace", path: sourcePath },
              destination: fromAgent
                ? {
                    kind: "workspace",
                    path: scenario === "destination-link" ? "link/new" : "../outside/new",
                  }
                : { kind: "agent", desktopId, path: "~/result" },
              waitMs: 60_000,
            },
          )
          .pipe(Effect.provide(projectionLayer(root)));
        assert.equal(result.state, "failed");
        assert.equal(result.error?.code, fromAgent ? "invalid-destination" : "invalid-source");
        assert.isFalse(yield* fs.exists(NodePath.join(outside, "new")));
        assert.equal(yield* fs.readFileString(NodePath.join(outside, "secret")), "outside");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

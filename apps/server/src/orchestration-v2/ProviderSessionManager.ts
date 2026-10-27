import { AgentScope } from "@t3tools/shared/AgentScope";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isOrchestrationV2WorkActive,
  ModelSelection,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeRequestId,
  ThreadId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { normalizeModelMetricLabel } from "../observability/Attributes.ts";
import {
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  withMetrics,
} from "../observability/Metrics.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000;
const RELEASE_SCOPE_CLOSE_TIMEOUT_MS = 30 * 1000;

const busyTurnPrefix = (providerThreadId: ProviderThreadId) => `${providerThreadId}#`;
const busyTurnKey = (providerThreadId: ProviderThreadId, runOrdinal: number) =>
  `${busyTurnPrefix(providerThreadId)}${runOrdinal}`;
const UNLOAD_THREAD_TIMEOUT_MS = 10 * 1000;

export const ProviderSessionReleaseReason = Schema.Literals([
  "idle_timeout",
  "runtime_error",
  "manual_shutdown",
  "server_shutdown",
]);
export type ProviderSessionReleaseReason = typeof ProviderSessionReleaseReason.Type;

export class ProviderSessionOpenError extends Schema.TaggedError<ProviderSessionOpenError>()(
  "ProviderSessionOpenError",
  {
    instanceId: ProviderInstanceId,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open provider instance ${this.instanceId} session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionLookupError extends Schema.TaggedError<ProviderSessionLookupError>()(
  "ProviderSessionLookupError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to look up provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionCloseError extends Schema.TaggedError<ProviderSessionCloseError>()(
  "ProviderSessionCloseError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionReleaseError extends Schema.TaggedError<ProviderSessionReleaseError>()(
  "ProviderSessionReleaseError",
  {
    providerSessionId: ProviderSessionId,
    reason: ProviderSessionReleaseReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to release provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionActivityError extends Schema.TaggedError<ProviderSessionActivityError>()(
  "ProviderSessionActivityError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to update provider session activity for ${this.providerSessionId}.`;
  }
}

export const ProviderSessionManagerV2Error = Schema.Union([
  ProviderSessionOpenError,
  ProviderWorkspaceMissingError,
  ProviderSessionLookupError,
  ProviderSessionCloseError,
  ProviderSessionReleaseError,
  ProviderSessionActivityError,
]);
export type ProviderSessionManagerV2Error = typeof ProviderSessionManagerV2Error.Type;

export interface ProviderSessionManagerV2Shape {
  readonly shutdown: Effect.Effect<void>;
  readonly open: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly modelSelection: ModelSelection;
    readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly resumeFromSession?: OrchestrationV2ProviderSession;
    readonly initialNativeThreadId?: string;
    readonly initialProviderItemIdentityVersion?: 2;
  }) => Effect.Effect<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    ProviderSessionManagerV2Error
  >;
  readonly get: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<
    Option.Option<ProviderAdapter.ProviderAdapterV2SessionRuntime>,
    ProviderSessionManagerV2Error
  >;
  readonly isLive: (providerSessionId: ProviderSessionId) => Effect.Effect<boolean>;
  /** Ownership from adapter startup through confirmed close, including failed opens and releases. */
  readonly listWorkspaceSessions: () => Effect.Effect<
    ReadonlyArray<{
      readonly id: ProviderSessionId;
      readonly generation: number;
      readonly cwd: string | null;
      /** Includes detached native workspaces until the whole generation confirms shutdown. */
      readonly threadWorkspaces: ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly cwd: string;
      }>;
    }>
  >;
  /** MCP credential ids are distinct from runtime session ids. */
  readonly isMcpCaller: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
    readonly mcpCredentialId: string;
  }) => Effect.Effect<boolean>;
  readonly close: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly closeInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly release: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly reason: ProviderSessionReleaseReason;
    readonly detail?: string;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly detach: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
    readonly detail?: string;
    readonly revokeMcpCredential?: boolean;
    /** Cleanup joins only the generations selected from the target workspace's inventory. */
    readonly releaseWhenUnused?: { readonly workspaceGenerations: ReadonlyArray<number> };
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
}

export class ProviderSessionManagerV2 extends Context.Service<
  ProviderSessionManagerV2,
  ProviderSessionManagerV2Shape
>()("t3/orchestration-v2/ProviderSessionManager/ProviderSessionManagerV2") {}

interface WorkspaceOwnership {
  readonly id: ProviderSessionId;
  readonly generation: number;
  cwd: string | null;
  readonly threadWorkspaces: Map<ThreadId, Set<string>>;
  readonly scope: Scope.Closeable;
  readonly shutdown: Deferred.Deferred<boolean>;
  closing: boolean;
}

interface LiveSessionEntry {
  readonly workspaceOwnership: WorkspaceOwnership;
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly loadedProviderThreadKeyByThread: ReadonlyMap<ThreadId, string>;
  /** Scope revocation to recorded credential ids so superseded sessions cannot revoke replacements opened before detach. */
  readonly mcpCredentialIdByThread: ReadonlyMap<ThreadId, string>;
  readonly supportsMultipleProviderThreads: boolean;
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly exposedRuntime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly eventSubscribers: Ref.Ref<
    ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
  >;
  readonly requestEventPermit: Semaphore.Semaphore;
  readonly idleGeneration: number;
  readonly busyTurns: ReadonlySet<string>;
  readonly lastActivityAtMs: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
  readonly pinnedSinceMs: number | null;
  readonly idleThreadUnloads: ReadonlyMap<ThreadId, IdleThreadUnload>;
}

interface IdleThreadUnload {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly generation: number;
  readonly fiber: Fiber.Fiber<void, never> | null;
}

type ProviderSessionEventSignal =
  | { readonly type: "event"; readonly event: ProviderAdapter.ProviderAdapterV2Event }
  | {
      readonly type: "failure";
      readonly cause: Cause.Cause<ProviderAdapter.ProviderAdapterV2Error>;
    };

export interface ProviderSessionManagerV2LayerOptions {
  readonly idleTimeoutMs?: number;
  readonly maxIdlePinMs?: number;
  readonly configureMcp?: boolean;
}

function releaseStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2ProviderSession["status"] {
  return reason === "runtime_error" ? "error" : "stopped";
}

function releasedRuntimeRequestStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2RuntimeRequest["status"] {
  return reason === "manual_shutdown" || reason === "server_shutdown" ? "cancelled" : "expired";
}

function sessionKey(providerSessionId: ProviderSessionId): string {
  return String(providerSessionId);
}

function sessionScopedRuntimeRequestThreadId(
  event: ProviderAdapter.ProviderAdapterV2Event,
): ThreadId | undefined {
  switch (event.type) {
    case "runtime_request.updated":
      return event.runtimeRequest.providerTurnId === null ? event.threadId : undefined;
    case "node.updated":
      return event.node.runId === null && event.node.runtimeRequestId !== null
        ? event.node.threadId
        : undefined;
    case "turn_item.updated":
      return event.turnItem.runId === null &&
        (event.turnItem.type === "approval_request" || event.turnItem.type === "user_input_request")
        ? event.turnItem.threadId
        : undefined;
    default:
      return undefined;
  }
}

function providerThreadRuntimeKey(
  providerThread: Parameters<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
  >[0]["providerThread"],
): string {
  const nativeThreadRef = providerThread.nativeThreadRef;
  return nativeThreadRef === null
    ? String(providerThread.id)
    : `${nativeThreadRef.driver}:${nativeThreadRef.nativeId}`;
}

function providerThreadLoadKey(input: {
  readonly providerThread: Parameters<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
  >[0]["providerThread"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): string {
  return JSON.stringify({
    providerThread: providerThreadRuntimeKey(input.providerThread),
    modelSelection: input.modelSelection ?? null,
    runtimePolicy: input.runtimePolicy ?? null,
  });
}

export const layerWithOptions = (
  options: ProviderSessionManagerV2LayerOptions = {},
): Layer.Layer<
  ProviderSessionManagerV2,
  never,
  | CommandOutputHub.CommandOutputHub
  | EventSink.EventSinkV2
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | McpSessionRegistry.McpSessionRegistry
  | ProjectionStore.ProjectionStoreV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
> =>
  Layer.effect(
    ProviderSessionManagerV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const mcpSessionRegistry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      /** Unreadable settings must preserve explicit browser-access opt-outs. */
      const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      const projectService = yield* Effect.serviceOption(ProjectService.ProjectService);
      const eventSink = yield* EventSink.EventSinkV2;
      const commandOutput = yield* CommandOutputHub.CommandOutputHub;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const agentScope = yield* AgentScope;
      const agentAccessSettings = Effect.fn("ProviderSessionManagerV2.agentAccessSettings")(
        function* (threadId: ThreadId) {
          if (Option.isNone(serverSettings)) return { browser: true, device: false };
          return yield* Effect.gen(function* () {
            const settings = yield* serverSettings.value.getSettings;
            const thread = yield* projectionStore.getThread(threadId);
            const entries = Object.values(settings.projectSettingsOverrides);
            const browserOverridden = entries.some(
              (entry) => entry.enableAgentBrowserAccess !== undefined,
            );
            const deviceOverridden = entries.some(
              (entry) => entry.enableAgentDeviceAccess !== undefined,
            );
            if (browserOverridden || deviceOverridden) {
              const project = Option.isSome(projectService)
                ? yield* projectService.value.getById(thread.projectId)
                : Option.none();
              if (Option.isNone(project))
                return {
                  browser: browserOverridden ? false : settings.enableAgentBrowserAccess,
                  device: deviceOverridden ? false : settings.enableAgentDeviceAccess,
                };
            }
            const effective = resolveProjectSettings(settings, thread.projectId).settings;
            return {
              browser: effective.enableAgentBrowserAccess,
              device: effective.enableAgentDeviceAccess,
            };
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Could not resolve agent access; withholding browser and device tools.",
                { threadId, cause },
              ).pipe(Effect.as({ browser: false, device: false })),
            ),
          );
        },
      );
      const layerScope = yield* Effect.scope;
      // Group signals stop providers before restart capture; drop post-signal events so recovery owns that state.
      const shutdownSignal = { received: false };
      const onShutdownSignal = () => {
        shutdownSignal.received = true;
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.on("SIGINT", onShutdownSignal);
          process.on("SIGTERM", onShutdownSignal);
        }),
        () =>
          Effect.sync(() => {
            process.off("SIGINT", onShutdownSignal);
            process.off("SIGTERM", onShutdownSignal);
          }),
      );
      const sessions = yield* Ref.make(new Map<string, LiveSessionEntry>());
      // Retry per released entry; reusing ids must not lose cleanup for earlier threads.
      const releaseRecordRetries = yield* FiberSet.make();
      const nextSubscriberId = yield* Ref.make(0);
      const sessionOpen = yield* KeyedLock.make<ProviderSessionId>();
      interface ReleasedEntry {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detachedThreadId?: ThreadId;
        requestIds: ReadonlyMap<ThreadId, ReadonlySet<RuntimeRequestId>> | undefined;
        backgroundTasks: ReadonlyArray<ReleasedBackgroundTasks> | undefined;
      }
      // A replacement cannot publish requests or background tasks until both
      // of the previous entry's snapshots are known.
      const pendingReleaseSnapshots = new Map<ProviderSessionId, ReleasedEntry>();
      // Session ids can be reused while an earlier process is still closing.
      // Register each generation BEFORE adapter startup and retain every cwd it
      // used until its own scope confirms shutdown. Unloading a native thread
      // alone does not prove its tools stopped using that thread's workspace.
      let nextWorkspaceGeneration = 0;
      const workspaceOwners = new Map<number, WorkspaceOwnership>();
      const rememberThreadWorkspace = (
        owner: WorkspaceOwnership,
        threadId: ThreadId,
        cwd: string | null | undefined,
      ) =>
        Effect.sync(() => {
          const workspace = cwd ?? owner.cwd;
          if (workspace === null) return;
          let workspaces = owner.threadWorkspaces.get(threadId);
          if (workspaces === undefined) {
            workspaces = new Set();
            owner.threadWorkspaces.set(threadId, workspaces);
          }
          workspaces.add(workspace);
        });
      const forgetCapturedReleaseSnapshot = (released: ReleasedEntry) => {
        const providerSessionId = released.entry.runtime.providerSessionId;
        if (
          released.requestIds !== undefined &&
          released.backgroundTasks !== undefined &&
          pendingReleaseSnapshots.get(providerSessionId) === released
        ) {
          pendingReleaseSnapshots.delete(providerSessionId);
        }
      };
      const threadAttachment = yield* KeyedLock.make<string>();
      const threadAttachmentKey = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) => `${input.providerSessionId}\u0000${input.threadId}`;
      const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
      const maxIdlePinMs = Math.max(0, options.maxIdlePinMs ?? DEFAULT_MAX_IDLE_PIN_MS);
      interface PreparedMcpCredential {
        readonly mcpCredentialId: string | undefined;
        readonly issued: boolean;
      }
      /** ACP and OpenCode consume credentials during openSession; reserve them against revocation until publication. */
      const mcpCredentialReservations = new Map<string, number>();
      const mcpReservationKey = (threadId: ThreadId, mcpCredentialId: string) =>
        `${threadId}\0${mcpCredentialId}`;
      const reserveMcpCredential = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        mcpCredentialReservations.set(key, (mcpCredentialReservations.get(key) ?? 0) + 1);
      };
      const dropMcpCredentialReservation = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        const count = mcpCredentialReservations.get(key) ?? 0;
        if (count <= 1) {
          mcpCredentialReservations.delete(key);
        } else {
          mcpCredentialReservations.set(key, count - 1);
        }
      };
      const isMcpCredentialReserved = (threadId: ThreadId, mcpCredentialId: string) =>
        (mcpCredentialReservations.get(mcpReservationKey(threadId, mcpCredentialId)) ?? 0) > 0;
      const mcpPrepareLock = yield* KeyedLock.make<ThreadId>();
      /** Serialize prepares per thread so concurrent rotations cannot revoke each other's credentials. */
      const prepareMcpSession = (
        threadId: ThreadId,
        providerInstanceId: ProviderInstanceId,
      ): Effect.Effect<PreparedMcpCredential> =>
        options.configureMcp === false
          ? mcpSessions
              .clear(threadId)
              .pipe(Effect.as<PreparedMcpCredential>({ mcpCredentialId: undefined, issued: false }))
          : mcpPrepareLock.withLock(
              threadId,
              Effect.gen(function* () {
                // Live providers build MCP clients once; reuse credentials across workspace handoffs.
                const { browser: browserToolsAvailable, device: deviceToolsAvailable } =
                  yield* agentAccessSettings(threadId);
                const capabilities = new Set<
                  import("../mcp/McpInvocationContext.ts").McpCapability
                >(["orchestration", "worktree", "pull-requests", "computer"]);
                if (browserToolsAvailable) capabilities.add("preview");
                if (deviceToolsAvailable) capabilities.add("device");
                const subagent = yield* projectionStore.getThread(threadId).pipe(
                  Effect.map((thread) => thread.lineage.relationshipToParent === "subagent"),
                  Effect.orElseSucceed(() => false),
                );
                const existing = yield* mcpSessions.read(threadId);
                if (existing !== undefined) {
                  // Reserve before async validation so release cannot revoke between validation and reservation.
                  reserveMcpCredential(threadId, existing.providerSessionId);
                  const rawToken = existing.authorizationHeader.replace(/^Bearer\s+/, "");
                  // Interrupted resolution must release the reservation before the caller learns of it.
                  const resolved = yield* mcpSessionRegistry
                    .resolve(rawToken)
                    .pipe(
                      Effect.onInterrupt(() =>
                        Effect.sync(() =>
                          dropMcpCredentialReservation(threadId, existing.providerSessionId),
                        ),
                      ),
                    );
                  if (
                    resolved !== undefined &&
                    resolved.thread.threadId === threadId &&
                    resolved.thread.providerInstanceId === providerInstanceId &&
                    resolved.capabilities.has("computer") &&
                    resolved.capabilities.has("preview") === browserToolsAvailable &&
                    resolved.capabilities.has("device") === deviceToolsAvailable &&
                    // A credential issued while the lineage read failed is replaced once it works.
                    (resolved.thread.subagent === true) === subagent
                  ) {
                    return { mcpCredentialId: existing.providerSessionId, issued: false };
                  }
                  dropMcpCredentialReservation(threadId, existing.providerSessionId);
                }
                yield* mcpSessionRegistry.revokeThread(threadId);
                const credential = yield* mcpSessionRegistry.issue({
                  threadId,
                  providerInstanceId,
                  browserToolsAvailable,
                  capabilities,
                  subagent,
                });
                yield* mcpSessions.set(credential.config);
                reserveMcpCredential(threadId, credential.config.providerSessionId);
                return { mcpCredentialId: credential.config.providerSessionId, issued: true };
              }),
            );
      const clearMcpSession = (threadId: ThreadId, mcpCredentialId?: string) =>
        mcpCredentialId === undefined
          ? mcpSessionRegistry
              .revokeThread(threadId)
              .pipe(Effect.tap(() => mcpSessions.clear(threadId)))
          : mcpSessionRegistry.revokeProviderSession(mcpCredentialId).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if ((yield* mcpSessions.read(threadId))?.providerSessionId === mcpCredentialId) {
                    yield* mcpSessions.clear(threadId);
                  }
                }),
              ),
            );

      const publishToSubscribers = (
        subscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
        signal: ProviderSessionEventSignal,
      ) =>
        Ref.get(subscribers).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(current.values(), (queue) => Queue.offer(queue, signal), {
              discard: true,
            }),
          ),
        );

      const failSubscribers = Effect.fn("ProviderSessionManager.failSubscribers")(function* (
        entry: LiveSessionEntry,
        detail: string,
      ) {
        const error = new ProviderAdapter.ProviderAdapterEventStreamError({
          driver: entry.runtime.driver,
          providerSessionId: entry.runtime.providerSessionId,
          cause: detail,
        });
        const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
        yield* Effect.forEach(
          subscribers.values(),
          (queue) =>
            Queue.offer(queue, {
              type: "failure",
              cause: Cause.fail(error),
            }),
          { discard: true },
        );
      });

      // Server shutdown interrupts subscribers rather than ending them: a
      // cleanly ended stream without a terminal fails its run, while an
      // interrupted one leaves run settlement to restart recovery.
      const interruptSubscribers = Effect.fn("ProviderSessionManager.interruptSubscribers")(
        function* (entry: LiveSessionEntry) {
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(
            subscribers.values(),
            (queue) => Queue.clear(queue).pipe(Effect.andThen(Queue.interrupt(queue))),
            { discard: true },
          );
        },
      );

      // Server shutdown intentionally clears them; a provider-announced Stop
      // must let consumers drain them before the stream completes.
      const endSubscribers = Effect.fn("ProviderSessionManager.endSubscribers")(function* (
        entry: LiveSessionEntry,
      ) {
        const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
        yield* Effect.forEach(subscribers.values(), (queue) => Queue.end(queue), {
          discard: true,
        });
      });

      const cancelIdleFiber = (fiber: Fiber.Fiber<void, never> | null) =>
        fiber === null ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.ignore);

      const writeProviderSessionEvents = Effect.fn(
        "ProviderSessionManager.writeProviderSessionEvents",
      )(function* (input: {
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
        readonly threadIds: Iterable<ThreadId>;
        readonly type: "provider-session.attached" | "provider-session.updated";
        readonly payload: OrchestrationV2ProviderSession;
      }) {
        const now = yield* DateTime.now;
        const events = yield* Effect.forEach(input.threadIds, (threadId) =>
          Effect.gen(function* () {
            return {
              id: yield* idAllocator.allocate.event({
                threadId,
                providerSessionId: input.runtime.providerSessionId,
              }),
              type: input.type,
              threadId,
              driver: input.runtime.driver,
              providerInstanceId: input.runtime.instanceId,
              occurredAt: now,
              payload: input.payload,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        if (events.length > 0) {
          yield* eventSink.write({ events });
        }
      });

      const writeReleasedSessionEvents = Effect.fn(
        "ProviderSessionManager.writeReleasedSessionEvents",
      )(function* (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
      }) {
        const now = yield* DateTime.now;
        const payload: OrchestrationV2ProviderSession = {
          ...input.entry.runtime.providerSession,
          status: releaseStatusFor(input.reason),
          updatedAt: now,
          lastError:
            input.reason === "runtime_error" ? (input.detail ?? "Provider runtime failed.") : null,
        };
        yield* writeProviderSessionEvents({
          runtime: input.entry.runtime,
          threadIds: input.entry.attachedThreadIds,
          type: "provider-session.updated",
          payload,
        });
      });

      // Call under sessionOpen, after removal drained requestEventPermit. A
      // failed read is retried before admitting a replacement, never inferred
      // from wall-clock timestamps shared by different runtime generations.
      const captureReleasedRequests = Effect.fn("ProviderSessionManager.captureReleasedRequests")(
        function* (released: ReleasedEntry) {
          if (released.requestIds !== undefined) return released.requestIds;
          const providerSessionId = released.entry.runtime.providerSessionId;
          const requestIds = new Map<ThreadId, ReadonlySet<RuntimeRequestId>>();
          for (const threadId of released.entry.attachedThreadIds) {
            const { runtimeRequests } = yield* projectionStore.getThreadRecords(threadId, [
              "runtimeRequests",
            ]);
            requestIds.set(
              threadId,
              new Set(
                runtimeRequests
                  .filter(
                    (request) =>
                      request.status === "pending" &&
                      request.responseCapability.type === "live" &&
                      request.responseCapability.providerSessionId === providerSessionId,
                  )
                  .map((request) => request.id),
              ),
            );
          }
          released.requestIds = requestIds;
          forgetCapturedReleaseSnapshot(released);
          return requestIds;
        },
      );

      const writeReleasedRuntimeRequestEvents = Effect.fn(
        "ProviderSessionManager.writeReleasedRuntimeRequestEvents",
      )(function* (input: {
        readonly released: ReleasedEntry;
        readonly reason: ProviderSessionReleaseReason;
      }) {
        const { entry } = input.released;
        const requestIds = yield* captureReleasedRequests(input.released);
        const providerSessionId = entry.runtime.providerSessionId;
        const now = yield* DateTime.now;
        const status = releasedRuntimeRequestStatusFor(input.reason);
        const reason =
          input.reason === "runtime_error"
            ? "Provider session failed before this runtime request was resolved."
            : "Provider session was closed before this runtime request was resolved.";

        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const threadId of entry.attachedThreadIds) {
          const projection = yield* projectionStore.getThreadRecords(
            threadId,
            ["runtimeRequests", "nodes", "turnItems"],
            { turnItemTypes: ["approval_request", "user_input_request"] },
          );
          const releasedRequests = projection.runtimeRequests.filter(
            (request) =>
              request.status === "pending" &&
              request.responseCapability.type === "live" &&
              request.responseCapability.providerSessionId === providerSessionId &&
              requestIds.get(threadId)?.has(request.id) === true,
          );

          for (const request of releasedRequests) {
            events.push({
              id: yield* idAllocator.allocate.event({
                threadId,
                providerSessionId,
              }),
              type: "runtime-request.updated",
              threadId,
              nodeId: request.nodeId,
              driver: entry.runtime.driver,
              occurredAt: now,
              payload: {
                ...request,
                status,
                responseCapability: {
                  type: "not_resumable",
                  reason,
                },
                resolvedAt: now,
              },
            });

            const requestNode = projection.nodes.find((node) => node.id === request.nodeId);
            if (requestNode !== undefined) {
              events.push({
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId,
                }),
                type: "node.updated",
                threadId,
                ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
                nodeId: requestNode.id,
                driver: entry.runtime.driver,
                occurredAt: now,
                payload: {
                  ...requestNode,
                  status: input.reason === "runtime_error" ? "failed" : "cancelled",
                  completedAt: now,
                },
              });
            }

            const turnItem = projection.turnItems.find(
              (item) =>
                (item.type === "approval_request" || item.type === "user_input_request") &&
                item.requestId === request.id,
            );
            if (turnItem !== undefined) {
              events.push({
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId,
                }),
                type: "turn-item.updated",
                threadId,
                ...(turnItem.runId === null ? {} : { runId: turnItem.runId }),
                ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
                driver: entry.runtime.driver,
                occurredAt: now,
                payload: {
                  ...turnItem,
                  status: input.reason === "runtime_error" ? "failed" : "cancelled",
                  completedAt: now,
                  updatedAt: now,
                },
              });
            }
          }
        }

        if (events.length > 0) {
          yield* eventSink.write({ events });
        }
      });

      // Capture under sessionOpen before a replacement can report its own tasks.
      // Keep OpenCode's roster: its background subagents share a server and can outlive the session.
      const readReleasedBackgroundTasks = Effect.fn(
        "ProviderSessionManager.readReleasedBackgroundTasks",
      )(
        function* (input: {
          readonly entry: LiveSessionEntry;
          readonly reason: ProviderSessionReleaseReason;
          readonly detachedThreadId?: ThreadId;
        }) {
          if (
            input.reason === "server_shutdown" ||
            input.entry.runtime.backgroundTasksEndWithProcess !== true
          ) {
            return [];
          }
          const providerSessionId = input.entry.runtime.providerSessionId;
          const threadIds = new Set(input.entry.attachedThreadIds);
          if (input.detachedThreadId !== undefined) threadIds.add(input.detachedThreadId);
          const released = [];
          for (const threadId of threadIds) {
            const projection = yield* projectionStore.getThreadRecords(threadId, [
              "providerThreads",
            ]);
            for (const providerThread of projection.providerThreads) {
              const tasks = providerThread.pendingBackgroundTasks ?? [];
              if (providerThread.providerSessionId !== providerSessionId || tasks.length === 0) {
                continue;
              }
              released.push({
                threadId,
                providerSessionId,
                providerThreadId: providerThread.id,
                taskIds: new Set(tasks.map((task) => task.taskId)),
              });
            }
          }
          return released;
        },
        (effect, input) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-session-release-roster-read-failed", {
                providerSessionId: input.entry.runtime.providerSessionId,
                cause,
              }).pipe(Effect.as([])),
            ),
          ),
      );
      type ReleasedBackgroundTasks = Effect.Success<
        ReturnType<typeof readReleasedBackgroundTasks>
      >[number];

      const captureReleasedBackgroundTasks = Effect.fn(
        "ProviderSessionManager.captureReleasedBackgroundTasks",
      )(function* (released: ReleasedEntry) {
        if (released.backgroundTasks !== undefined) return released.backgroundTasks;
        released.backgroundTasks = yield* readReleasedBackgroundTasks(released);
        forgetCapturedReleaseSnapshot(released);
        return released.backgroundTasks;
      });

      // Dead processes cannot report task endings; stale rosters keep threads Waiting.
      const writeReleasedBackgroundWorkEvents = (
        released: ReadonlyArray<ReleasedBackgroundTasks>,
      ) =>
        Effect.forEach(
          released,
          ({ threadId, providerSessionId, providerThreadId, taskIds }) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 3; attempt++) {
                const projection = yield* projectionStore.getThreadRecords(threadId, [
                  "providerThreads",
                ]);
                const providerThread = projection.providerThreads.find(
                  (candidate) => candidate.id === providerThreadId,
                );
                const tasks = providerThread?.pendingBackgroundTasks ?? [];
                const remaining = tasks.filter((task) => !taskIds.has(task.taskId));
                if (providerThread === undefined || remaining.length === tasks.length) return;
                const now = yield* DateTime.now;
                const { committed } = yield* eventSink.writeIfProviderThreadUnchanged({
                  expected: providerThread,
                  events: [
                    {
                      id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
                      type: "provider-thread.updated",
                      threadId,
                      driver: providerThread.driver,
                      providerInstanceId: providerThread.providerInstanceId,
                      occurredAt: now,
                      payload: {
                        ...providerThread,
                        pendingBackgroundTasks: remaining,
                        updatedAt: now,
                      },
                    },
                  ],
                });
                if (committed) return;
              }
              yield* Effect.logWarning(
                "orchestration-v2.provider-session-release-roster-conflict",
                {
                  providerSessionId,
                  providerThreadId,
                },
              );
            }),
          { discard: true },
        );

      const writeReleaseRecords = (input: {
        readonly released: ReleasedEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        readonly releasedBackgroundTasks: ReadonlyArray<ReleasedBackgroundTasks>;
        readonly replaced: boolean;
      }) =>
        Effect.all(
          [
            input.replaced
              ? Effect.succeed(Exit.void)
              : Effect.exit(writeReleasedSessionEvents({ ...input, entry: input.released.entry })),
            Effect.exit(
              writeReleasedRuntimeRequestEvents(input).pipe(
                input.released.entry.requestEventPermit.withPermits(1),
              ),
            ),
            Effect.exit(writeReleasedBackgroundWorkEvents(input.releasedBackgroundTasks)),
          ],
          { concurrency: 1 },
        ).pipe(Effect.flatMap(Exit.asVoidAll));

      // Retry after removal from the live map; later releases cannot clear stale ready sessions and approvals.
      const retryReleaseRecords = (
        input: Omit<Parameters<typeof writeReleaseRecords>[0], "replaced">,
      ) => {
        const providerSessionId = input.released.entry.runtime.providerSessionId;
        const attempt = Effect.gen(function* () {
          const exit = yield* Effect.exit(
            sessionOpen.withLock(
              providerSessionId,
              Effect.gen(function* () {
                const replaced = (yield* Ref.get(sessions)).has(sessionKey(providerSessionId));
                yield* writeReleaseRecords({ ...input, replaced });
              }),
            ),
          );
          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return yield* exit;
          yield* Effect.logWarning("orchestration-v2.provider-session-release-records-failed", {
            providerSessionId,
            cause: exit.cause,
          });
          // SQL commit failures are defects; retry every cause except interruption.
          return yield* Effect.fail(exit.cause);
        });
        return attempt.pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(Duration.min(duration, Duration.seconds(30))),
              ),
            ),
          }),
          Effect.delay("1 second"),
          FiberSet.run(releaseRecordRetries),
        );
      };

      const logReleaseFailure =
        (providerSessionId: ProviderSessionId) =>
        <E, R>(release: Effect.Effect<void, E, R>) =>
          release.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-session-release-failed", {
                providerSessionId,
                cause,
              }),
            ),
          );

      // Removal drains pending request writes before capturing their IDs. A
      // replacement cannot publish requests until that snapshot succeeds.
      const removeLiveEntry = Effect.fn("ProviderSessionManager.removeLiveEntry")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly reason: ProviderSessionReleaseReason;
          readonly detachedThreadId?: ThreadId;
          readonly onlyIfIdleGeneration?: number;
          readonly onlyIfUnusedOwnership?: WorkspaceOwnership;
        }): Effect.fn.Return<Option.Option<ReleasedEntry>> {
          const key = sessionKey(input.providerSessionId);
          const candidate = (yield* Ref.get(sessions)).get(key);
          if (candidate === undefined) {
            return Option.none<ReleasedEntry>();
          }
          const released: ReleasedEntry = {
            entry: candidate,
            reason: input.reason,
            ...(input.detachedThreadId === undefined
              ? {}
              : { detachedThreadId: input.detachedThreadId }),
            requestIds: undefined,
            backgroundTasks: undefined,
          };
          const removed = yield* Ref.modify(sessions, (current) => {
            const existing = current.get(key);
            if (existing !== candidate) {
              return [existing === undefined ? "gone" : "changed", current] as const;
            }
            if (
              input.onlyIfUnusedOwnership !== undefined &&
              (existing.workspaceOwnership !== input.onlyIfUnusedOwnership ||
                existing.attachedThreadIds.size > 0)
            ) {
              return ["kept", current] as const;
            }
            if (
              input.onlyIfIdleGeneration !== undefined &&
              (existing.busyTurns.size > 0 ||
                existing.idleGeneration !== input.onlyIfIdleGeneration)
            ) {
              return ["kept", current] as const;
            }
            const updated = new Map(current);
            updated.delete(key);
            candidate.workspaceOwnership.closing = true;
            pendingReleaseSnapshots.set(input.providerSessionId, released);
            return ["removed", updated] as const;
          }).pipe(candidate.requestEventPermit.withPermits(1));
          // Retry against the current entry, rechecking every release condition.
          if (removed === "changed") return yield* removeLiveEntry(input);
          if (removed !== "removed") return Option.none<ReleasedEntry>();
          return Option.some(released);
        },
      );

      // Scope close can wedge on a misbehaving adapter finalizer (e.g. a
      // provider process that never yields its message stream).
      const closeScopeWithin = Effect.fn("ProviderSessionManager.closeScopeWithin")(function* (
        scope: Scope.Closeable,
        annotations: { readonly providerSessionId?: ProviderSessionId; readonly reason: string },
        onClosed: (exit: Exit.Exit<void>) => Effect.Effect<void> = () => Effect.void,
      ) {
        const closeFiber = yield* Scope.close(scope, Exit.void).pipe(
          Effect.exit,
          Effect.tap(onClosed),
          Effect.forkDetach({ startImmediately: true }),
        );
        const closeExit = yield* Fiber.join(closeFiber).pipe(
          Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
        );
        if (Option.isNone(closeExit)) {
          yield* Effect.logWarning("orchestration-v2.provider-session-scope-close-timeout", {
            ...annotations,
            timeoutMs: RELEASE_SCOPE_CLOSE_TIMEOUT_MS,
          });
          yield* Fiber.join(closeFiber).pipe(
            Effect.flatMap((exit) =>
              Exit.isFailure(exit)
                ? Effect.logWarning("orchestration-v2.provider-session-scope-close-failed", {
                    ...annotations,
                    cause: exit.cause,
                  })
                : Effect.logInfo(
                    "orchestration-v2.provider-session-scope-close-completed-late",
                    annotations,
                  ),
            ),
            Effect.forkDetach,
          );
        }
        return closeExit;
      });

      const closeWorkspaceScope = Effect.fn("ProviderSessionManager.closeWorkspaceScope")(
        function* (owner: WorkspaceOwnership, reason: string) {
          owner.closing = true;
          return yield* closeScopeWithin(
            owner.scope,
            { providerSessionId: owner.id, reason },
            (exit) =>
              Effect.gen(function* () {
                if (Exit.isSuccess(exit)) workspaceOwners.delete(owner.generation);
                yield* Deferred.succeed(owner.shutdown, Exit.isSuccess(exit));
              }),
          );
        },
        (effect, owner) =>
          effect.pipe(
            // Failed or timed-out close retains ownership; late success removes only its generation.
            Effect.ensuring(Deferred.succeed(owner.shutdown, false)),
          ),
      );

      const releaseEntry = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        readonly detachedThreadId?: ThreadId;
        readonly cancelIdleFiber?: boolean;
        readonly onlyIfIdleGeneration?: number;
        readonly onlyIfUnusedOwnership?: WorkspaceOwnership;
        readonly gracefulSubscribers?: boolean;
        /** Attachment failure releases from inside open's existing lock. */
        readonly openLockHeld?: boolean;
      }) => {
        const withOpenLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          input.openLockHeld === true
            ? effect
            : sessionOpen.withLock(input.providerSessionId, effect);
        const revokeCredentials = (released: Option.Option<ReleasedEntry>) =>
          Option.match(released, {
            onNone: () => Effect.void,
            onSome: ({ entry }) =>
              // Preserve credentials held by a live replacement or an in-flight open.
              Ref.get(sessions).pipe(
                Effect.flatMap((current) =>
                  Effect.forEach(
                    entry.mcpCredentialIdByThread,
                    ([threadId, mcpCredentialId]) => {
                      // A stale record for a different credential must not prevent revocation.
                      const heldElsewhere =
                        isMcpCredentialReserved(threadId, mcpCredentialId) ||
                        Array.from(current.values()).some(
                          (other) =>
                            other !== entry &&
                            (other.attachedThreadIds.has(threadId) ||
                              other.mcpCredentialIdByThread.get(threadId) === mcpCredentialId),
                        );
                      return heldElsewhere
                        ? Effect.void
                        : clearMcpSession(threadId, mcpCredentialId);
                    },
                    { discard: true },
                  ),
                ),
              ),
          });
        const finishRelease = (released: Option.Option<ReleasedEntry>) =>
          Option.match(released, {
            onNone: () => Effect.void,
            onSome: (released) =>
              Effect.gen(function* () {
                const { entry } = released;
                const releasedBackgroundTasks = yield* withOpenLock(
                  captureReleasedBackgroundTasks(released),
                );
                if (input.cancelIdleFiber !== false) {
                  yield* cancelIdleFiber(entry.idleFiber);
                }
                if (input.gracefulSubscribers === true) {
                  yield* endSubscribers(entry);
                } else if (input.reason === "server_shutdown") {
                  yield* interruptSubscribers(entry);
                } else {
                  yield* failSubscribers(
                    entry,
                    input.detail ?? `Provider session released: ${input.reason}.`,
                  );
                }
                const closeExit = yield* closeWorkspaceScope(
                  entry.workspaceOwnership,
                  input.reason,
                );
                const records = {
                  released,
                  releasedBackgroundTasks,
                  reason: input.reason,
                  ...(input.detail === undefined ? {} : { detail: input.detail }),
                };
                const recorded = yield* Effect.exit(
                  withOpenLock(
                    Effect.gen(function* () {
                      const replaced = (yield* Ref.get(sessions)).has(
                        sessionKey(input.providerSessionId),
                      );
                      yield* writeReleaseRecords({ ...records, replaced });
                    }),
                  ),
                );
                if (Exit.isFailure(recorded)) {
                  yield* retryReleaseRecords(records);
                  return yield* recorded;
                }
                if (Option.isSome(closeExit) && Exit.isFailure(closeExit.value)) {
                  return yield* Effect.failCause(closeExit.value.cause);
                }
              }).pipe(
                // Also unblock cleanup if an earlier release step fails before close.
                Effect.ensuring(
                  Deferred.succeed(released.entry.workspaceOwnership.shutdown, false),
                ),
                withMetrics({
                  counter: providerSessionsTotal,
                  attributes: {
                    provider: released.entry.runtime.driver,
                    operation: "release",
                    reason: input.reason,
                  },
                }),
              ),
          }).pipe(Effect.ensuring(revokeCredentials(released)));
        return Effect.gen(function* () {
          const cleanupExit = yield* Ref.make<
            Exit.Exit<void, Effect.Error<ReturnType<typeof finishRelease>>>
          >(Exit.void);
          // Lock admission stays cancellable so an open can cancel its idle
          // fiber. Once removal succeeds, the full cleanup is a finalizer: an
          // interruption received while draining requests cannot skip it.
          yield* withOpenLock(
            Effect.acquireRelease(removeLiveEntry(input), (released) =>
              finishRelease(released).pipe(
                Effect.exit,
                Effect.flatMap((exit) => Ref.set(cleanupExit, exit)),
              ),
            ),
          ).pipe(Effect.scoped);
          // Finalizers cannot fail their scope with a typed error. Preserve the
          // cleanup result for the ordinary caller after its scope has closed.
          const result = yield* Ref.get(cleanupExit);
          return yield* result;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: input.reason,
                cause,
              }),
            ),
          ),
        );
      };

      const releaseIfStillIdle = Effect.fn("ProviderSessionManager.releaseIfStillIdle")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly generation: number;
        }): Effect.fn.Return<void> {
          const current = yield* Ref.get(sessions);
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.busyTurns.size > 0 ||
            entry.idleGeneration !== input.generation
          ) {
            return;
          }
          // Capture runtime identity before yielding; replacements can reuse the session id.
          const probedRuntime = entry.runtime;
          const hasPendingWork =
            probedRuntime.hasPendingBackgroundWork === undefined
              ? false
              : yield* probedRuntime.hasPendingBackgroundWork.pipe(
                  Effect.catchCause(() => Effect.succeed(false)),
                );
          if (hasPendingWork) {
            const now = yield* Clock.currentTimeMillis;
            const pinnedSinceMs = entry.pinnedSinceMs ?? now;
            if (now - pinnedSinceMs < maxIdlePinMs) {
              const shouldContinuePin = yield* Ref.modify(sessions, (latest) => {
                const latestEntry = latest.get(key);
                if (
                  latestEntry === undefined ||
                  latestEntry.busyTurns.size > 0 ||
                  latestEntry.idleGeneration !== input.generation ||
                  latestEntry.runtime !== probedRuntime
                ) {
                  return [false, latest] as const;
                }
                const updated = new Map(latest);
                updated.set(key, { ...latestEntry, pinnedSinceMs });
                return [true, updated] as const;
              });
              if (!shouldContinuePin) {
                return;
              }
              yield* Effect.logInfo("orchestration-v2.driver-session.idle-release-deferred", {
                providerSessionId: input.providerSessionId,
                pinnedForMs: now - pinnedSinceMs,
              });
              // Recheck on this fiber; scheduleIdleReleaseInternal would interrupt it and self-deadlock.
              yield* Effect.sleep(Duration.millis(idleTimeoutMs));
              return yield* releaseIfStillIdle(input);
            }
            yield* Effect.logWarning("orchestration-v2.driver-session.idle-release-pin-expired", {
              providerSessionId: input.providerSessionId,
              pinnedForMs: now - pinnedSinceMs,
            });
          }
          // Adapter probes yield; guard busyTurns and idleGeneration atomically when removing the entry.
          yield* releaseEntry({
            providerSessionId: input.providerSessionId,
            reason: "idle_timeout",
            cancelIdleFiber: false,
            onlyIfIdleGeneration: input.generation,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.idle-release-failed", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          );
        },
      );

      const withActivityError = <A, E, R>(
        providerSessionId: ProviderSessionId,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, ProviderSessionActivityError, R> =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new ProviderSessionActivityError({
                providerSessionId,
                cause,
              }),
            ),
          ),
        );

      // Provider activity restarts the pin budget, so background work that keeps
      // reporting progress (a long Claude workflow) is never cut off; only work
      // that went silent for maxIdlePinMs is released. This runs for every
      // provider event, so keep it untraced.
      const scheduleIdleReleaseInternal = Effect.fnUntraced(function* (
        providerSessionId: ProviderSessionId,
        options?: { readonly providerActivity?: boolean },
      ) {
        const key = sessionKey(providerSessionId);
        const current = yield* Ref.get(sessions);
        const entry = current.get(key);
        if (entry === undefined || entry.busyTurns.size > 0) {
          return;
        }

        yield* cancelIdleFiber(entry.idleFiber);
        const generation = entry.idleGeneration + 1;
        const idleFiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
          Effect.andThen(releaseIfStillIdle({ providerSessionId, generation })),
          Effect.forkIn(layerScope),
        );
        const lastActivityAtMs = yield* Clock.currentTimeMillis;
        yield* Ref.update(sessions, (latest) => {
          const latestEntry = latest.get(key);
          if (latestEntry === undefined || latestEntry.busyTurns.size > 0) {
            return latest;
          }
          const updated = new Map(latest);
          updated.set(key, {
            ...latestEntry,
            idleGeneration: generation,
            idleFiber,
            lastActivityAtMs,
            ...(options?.providerActivity === true ? { pinnedSinceMs: null } : {}),
          });
          return updated;
        });
      });

      const scheduleIdleRelease = (providerSessionId: ProviderSessionId) =>
        withActivityError(providerSessionId, scheduleIdleReleaseInternal(providerSessionId));

      const touchActivity = (
        providerSessionId: ProviderSessionId,
        options?: { readonly providerActivity?: boolean },
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const lastActivityAtMs = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(sessionKey(providerSessionId));
              if (entry === undefined) {
                return current;
              }
              const updated = new Map(current);
              updated.set(sessionKey(providerSessionId), {
                ...entry,
                lastActivityAtMs,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId, options);
          }),
        );

      const attachThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) =>
        withActivityError(
          input.providerSessionId,
          Ref.modify(sessions, (current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            if (entry === undefined || entry.attachedThreadIds.has(input.threadId)) {
              return [undefined, current] as const;
            }
            const updated = new Map(current);
            updated.set(sessionKey(input.providerSessionId), {
              ...entry,
              attachedThreadIds: new Set([...entry.attachedThreadIds, input.threadId]),
            });
            return [entry.runtime, updated] as const;
          }),
        );

      const removeThreadAttachment = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.runtime !== input.runtime ||
            !entry.attachedThreadIds.has(input.threadId)
          ) {
            return current;
          }
          const attachedThreadIds = new Set(entry.attachedThreadIds);
          attachedThreadIds.delete(input.threadId);
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.delete(input.threadId);
          const updated = new Map(current);
          updated.set(key, {
            ...entry,
            attachedThreadIds,
            loadedProviderThreadKeyByThread,
          });
          return updated;
        });

      const isProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
      }) =>
        Ref.get(sessions).pipe(
          Effect.map(
            (current) =>
              current
                .get(sessionKey(input.providerSessionId))
                ?.loadedProviderThreadKeyByThread.get(input.threadId) === input.providerThreadKey,
          ),
        );

      const markProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (entry === undefined) {
            return current;
          }
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.set(input.threadId, input.providerThreadKey);
          const updated = new Map(current);
          updated.set(key, { ...entry, loadedProviderThreadKeyByThread });
          return updated;
        });

      const ensureThreadAttached = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
      }) =>
        Effect.suspend(() => {
          let attachedTo: ProviderAdapter.ProviderAdapterV2SessionRuntime | undefined;
          let preparedForCleanup: PreparedMcpCredential | undefined;
          let reservationDropped = false;
          const dropReservation = () => {
            if (!reservationDropped && preparedForCleanup?.mcpCredentialId !== undefined) {
              reservationDropped = true;
              dropMcpCredentialReservation(input.threadId, preparedForCleanup.mcpCredentialId);
            }
          };
          // Lock attach through rollback so concurrent attaches cannot observe an attachment about to be undone.
          const attach = Effect.gen(function* () {
            const attached = yield* attachThread(input).pipe(
              // Record without interruption so cleanup undoes only this call's attachment.
              Effect.tap((runtime) => Effect.sync(() => (attachedTo = runtime))),
              Effect.uninterruptible,
            );
            if (attached !== undefined) {
              const prepared = yield* prepareMcpSession(input.threadId, input.providerInstanceId);
              preparedForCleanup = prepared;
              if (prepared.mcpCredentialId !== undefined) {
                const mcpCredentialId = prepared.mcpCredentialId;
                yield* Ref.update(sessions, (current) => {
                  const key = sessionKey(input.providerSessionId);
                  const entry = current.get(key);
                  if (entry === undefined) return current;
                  const mcpCredentialIdByThread = new Map(entry.mcpCredentialIdByThread);
                  mcpCredentialIdByThread.set(input.threadId, mcpCredentialId);
                  const updated = new Map(current);
                  updated.set(key, { ...entry, mcpCredentialIdByThread });
                  return updated;
                });
              }
              const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
              if (entry !== undefined) {
                yield* withActivityError(
                  input.providerSessionId,
                  writeProviderSessionEvents({
                    runtime: entry.runtime,
                    threadIds: [input.threadId],
                    type: "provider-session.attached",
                    payload: entry.runtime.providerSession,
                  }),
                );
              }
            }
          }).pipe(
            Effect.onError(() =>
              attachedTo === undefined
                ? Effect.void
                : removeThreadAttachment({ ...input, runtime: attachedTo }).pipe(
                    Effect.andThen(
                      Effect.suspend(() => {
                        dropReservation();
                        // Other live processes hold reused MCP credentials; revocation would break their clients.
                        if (preparedForCleanup?.issued !== true) return Effect.void;
                        const mcpCredentialId = preparedForCleanup.mcpCredentialId;
                        const attachedRuntime = attachedTo;
                        return Ref.get(sessions).pipe(
                          Effect.flatMap((current) =>
                            (mcpCredentialId !== undefined &&
                              isMcpCredentialReserved(input.threadId, mcpCredentialId)) ||
                            Array.from(current.values()).some(
                              (other) =>
                                other.runtime !== attachedRuntime &&
                                (other.attachedThreadIds.has(input.threadId) ||
                                  (mcpCredentialId !== undefined &&
                                    other.mcpCredentialIdByThread.get(input.threadId) ===
                                      mcpCredentialId)),
                            )
                              ? Effect.void
                              : clearMcpSession(input.threadId, mcpCredentialId),
                          ),
                        );
                      }),
                    ),
                  ),
            ),
          );
          return threadAttachment
            .withLock(threadAttachmentKey(input), attach)
            .pipe(Effect.ensuring(Effect.sync(dropReservation)));
        });

      const markBusy = (providerSessionId: ProviderSessionId, turnKey: string) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            const idleFiber = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return [null, current] as const;
              }
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns: new Set(entry.busyTurns).add(turnKey),
                idleFiber: null,
                lastActivityAtMs: now,
                pinnedSinceMs: null,
              });
              return [entry.idleFiber, updated] as const;
            });
            yield* cancelIdleFiber(idleFiber);
          }),
        );

      const markIdle = (
        providerSessionId: ProviderSessionId,
        providerThreadId: ProviderThreadId,
        runOrdinal: number,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return current;
              }
              const busyTurns = new Set(entry.busyTurns);
              busyTurns.delete(busyTurnKey(providerThreadId, runOrdinal));
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns,
                lastActivityAtMs: now,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId);
            yield* scheduleThreadUnload(providerSessionId, providerThreadId);
          }),
        );

      const hasBusyTurn = (entry: LiveSessionEntry, providerThreadId: ProviderThreadId) => {
        const prefix = busyTurnPrefix(providerThreadId);
        for (const turnKey of entry.busyTurns) {
          if (turnKey.startsWith(prefix)) return true;
        }
        return false;
      };

      const updateIdleThreadUnload = (
        providerSessionId: ProviderSessionId,
        threadId: ThreadId,
        update: (current: IdleThreadUnload | undefined) => IdleThreadUnload | undefined,
      ) =>
        Ref.modify(sessions, (current) => {
          const key = sessionKey(providerSessionId);
          const entry = current.get(key);
          if (entry === undefined) return [undefined, current] as const;
          const previous = entry.idleThreadUnloads.get(threadId);
          const next = update(previous);
          const idleThreadUnloads = new Map(entry.idleThreadUnloads);
          if (next === undefined) idleThreadUnloads.delete(threadId);
          else idleThreadUnloads.set(threadId, next);
          const updated = new Map(current);
          updated.set(key, { ...entry, idleThreadUnloads });
          return [previous, updated] as const;
        });

      /**
       * Called before the thread is resumed or given a turn, so an unload
       * cannot land between a resume that found the thread loaded and the turn
       * that relies on it.
       */
      const holdThreadLoaded = Effect.fn("ProviderSessionManager.holdThreadLoaded")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly threadId: ThreadId;
          readonly providerThread: OrchestrationV2ProviderThread;
        }) {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
          if (
            entry === undefined ||
            !entry.supportsMultipleProviderThreads ||
            entry.exposedRuntime.unloadThread === undefined ||
            input.providerThread.nativeThreadRef === null
          ) {
            return;
          }
          const previous = yield* updateIdleThreadUnload(
            input.providerSessionId,
            input.threadId,
            (current) => ({
              providerThread: input.providerThread,
              generation: (current?.generation ?? 0) + 1,
              fiber: null,
            }),
          );
          yield* cancelIdleFiber(previous?.fiber ?? null);
        },
      );

      const scheduleThreadUnload = Effect.fn("ProviderSessionManager.scheduleThreadUnload")(
        function* (providerSessionId: ProviderSessionId, providerThreadId: ProviderThreadId) {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
          if (entry === undefined || hasBusyTurn(entry, providerThreadId)) return;
          const tracked = Array.from(entry.idleThreadUnloads).find(
            ([, pending]) => pending.providerThread.id === providerThreadId,
          );
          if (tracked === undefined) return;
          const [threadId, pending] = tracked;
          const generation = pending.generation + 1;
          const fiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
            Effect.andThen(unloadIdleThread({ providerSessionId, threadId, generation })),
            Effect.forkIn(layerScope),
          );
          const previous = yield* updateIdleThreadUnload(providerSessionId, threadId, (current) =>
            current?.generation === pending.generation
              ? { ...current, generation, fiber }
              : current,
          );
          yield* cancelIdleFiber(
            previous?.generation === pending.generation ? previous.fiber : fiber,
          );
        },
      );

      const unloadIdleThread = Effect.fn("ProviderSessionManager.unloadIdleThread")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly threadId: ThreadId;
          readonly generation: number;
        }): Effect.fn.Return<void> {
          const outcome = yield* threadAttachment.withLock(
            threadAttachmentKey(input),
            Effect.gen(function* () {
              const key = sessionKey(input.providerSessionId);
              const entry = (yield* Ref.get(sessions)).get(key);
              const pending = entry?.idleThreadUnloads.get(input.threadId);
              const unloadThread = entry?.exposedRuntime.unloadThread;
              if (
                entry === undefined ||
                pending === undefined ||
                pending.generation !== input.generation ||
                unloadThread === undefined ||
                !entry.attachedThreadIds.has(input.threadId) ||
                hasBusyTurn(entry, pending.providerThread.id)
              ) {
                return "skipped" as const;
              }
              // Unloading kills background terminals; keep threads with pending work loaded.
              const hasPendingWork =
                entry.runtime.hasPendingBackgroundWorkForThread === undefined
                  ? false
                  : yield* entry.runtime
                      .hasPendingBackgroundWorkForThread(pending.providerThread)
                      .pipe(Effect.catchCause(() => Effect.succeed(false)));
              if (hasPendingWork) return "deferred" as const;
              const unloading = yield* Ref.modify(sessions, (current) => {
                const latest = current.get(key);
                if (
                  latest?.runtime !== entry.runtime ||
                  latest.idleThreadUnloads.get(input.threadId)?.generation !== input.generation
                ) {
                  return [false, current] as const;
                }
                const loadedProviderThreadKeyByThread = new Map(
                  latest.loadedProviderThreadKeyByThread,
                );
                loadedProviderThreadKeyByThread.delete(input.threadId);
                const idleThreadUnloads = new Map(latest.idleThreadUnloads);
                idleThreadUnloads.delete(input.threadId);
                const updated = new Map(current);
                updated.set(key, {
                  ...latest,
                  loadedProviderThreadKeyByThread,
                  idleThreadUnloads,
                });
                return [true, updated] as const;
              });
              if (!unloading) return "skipped" as const;
              yield* unloadThread({ providerThread: pending.providerThread }).pipe(
                Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                Effect.catchCause((cause) =>
                  Effect.logWarning("orchestration-v2.driver-session.idle-unload-failed", {
                    providerSessionId: input.providerSessionId,
                    threadId: input.threadId,
                    providerThreadId: pending.providerThread.id,
                    cause,
                  }),
                ),
              );
              return "unloaded" as const;
            }),
          );
          // Wait outside the lock so the next attach is not blocked.
          if (outcome === "deferred") {
            yield* Effect.sleep(Duration.millis(idleTimeoutMs));
            return yield* unloadIdleThread(input);
          }
        },
      );

      const observeActivity = (
        providerSessionId: ProviderSessionId,
        activity: Effect.Effect<void, ProviderSessionActivityError>,
      ) =>
        activity.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.driver-session.activity-failed", {
              providerSessionId,
              cause,
            }),
          ),
        );

      const makeEventSubscription = Effect.fn("ProviderSessionManager.makeEventSubscription")(
        function* (
          runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
          subscribers: Ref.Ref<
            ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
          >,
          requestEventPermit: Semaphore.Semaphore,
        ): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2EventSubscription> {
          const queue = yield* Queue.unbounded<ProviderSessionEventSignal, Cause.Done>();
          const subscriberId = yield* Ref.getAndUpdate(nextSubscriberId, (value) => value + 1);
          yield* Ref.update(subscribers, (current) => {
            const updated = new Map(current);
            updated.set(subscriberId, queue);
            return updated;
          });
          const close = Ref.modify(subscribers, (current) => {
            if (!current.has(subscriberId)) {
              return [false, current] as const;
            }
            const updated = new Map(current);
            updated.delete(subscriberId);
            return [true, updated] as const;
          }).pipe(
            Effect.flatMap((removed) =>
              removed
                ? Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid)
                : Effect.void,
            ),
          );
          const events = Stream.fromQueue(queue).pipe(
            Stream.flatMap(
              (signal): ProviderAdapter.ProviderAdapterV2EventSubscription["events"] => {
                if (signal.type === "failure") return Stream.failCause(signal.cause);
                const event = signal.event;
                const requestArtifact =
                  event.type === "runtime_request.updated" ||
                  (event.type === "node.updated" && event.node.runtimeRequestId !== null) ||
                  (event.type === "turn_item.updated" &&
                    (event.turnItem.type === "approval_request" ||
                      event.turnItem.type === "user_input_request"));
                if (!requestArtifact) return Stream.make(event);
                const status =
                  event.type === "node.updated"
                    ? event.node.status
                    : event.type === "turn_item.updated"
                      ? event.turnItem.status
                      : undefined;
                const canOutliveSession =
                  status === "completed" ||
                  status === "failed" ||
                  status === "cancelled" ||
                  status === "interrupted" ||
                  status === "rolled_back" ||
                  (event.type === "runtime_request.updated" &&
                    (event.runtimeRequest.status !== "pending" ||
                      event.runtimeRequest.responseCapability.type !== "live")) ||
                  (event.type === "turn_item.updated" &&
                    event.turnItem.type === "user_input_request" &&
                    event.turnItem.responseMode === "message");
                // The inner stream's scope holds the permit through downstream
                // persistence. Removal waits for an in-flight request; queued
                // live requests are dropped afterwards. Terminal updates and
                // message-mode questions remain valid after the provider exits.
                return Stream.unwrap(
                  Effect.gen(function* () {
                    yield* Effect.acquireRelease(
                      requestEventPermit.take(1),
                      () => requestEventPermit.release(1),
                      { interruptible: true },
                    );
                    const current = (yield* Ref.get(sessions)).get(
                      sessionKey(runtime.providerSessionId),
                    );
                    return current?.runtime === runtime || canOutliveSession
                      ? Stream.make(event)
                      : Stream.empty;
                  }),
                );
              },
            ),
            Stream.ensuring(close),
          );
          return { events, close } satisfies ProviderAdapter.ProviderAdapterV2EventSubscription;
        },
      );

      const decorateRuntime = (
        runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
        workspaceOwnership: WorkspaceOwnership,
        eventSubscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
        requestEventPermit: Semaphore.Semaphore,
      ): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
        const providerSessionId = runtime.providerSessionId;
        const subscribeEvents = makeEventSubscription(
          runtime,
          eventSubscribers,
          requestEventPermit,
        );
        const turnMetrics = (operation: string, model?: string) =>
          withMetrics({
            counter: providerTurnsTotal,
            ...(operation === "send" ? { timer: providerTurnDuration } : {}),
            attributes: {
              provider: runtime.driver,
              operation,
              modelFamily: normalizeModelMetricLabel(model),
            },
          });
        return {
          ...runtime,
          subscribeEvents,
          events: Stream.unwrap(
            subscribeEvents.pipe(Effect.map((subscription) => subscription.events)),
          ),
          ensureThread: (input) =>
            observeActivity(
              providerSessionId,
              rememberThreadWorkspace(
                workspaceOwnership,
                input.threadId,
                input.runtimePolicy.cwd,
              ).pipe(
                Effect.andThen(
                  ensureThreadAttached({
                    providerSessionId,
                    threadId: input.threadId,
                    providerInstanceId: runtime.instanceId,
                  }),
                ),
              ),
            ).pipe(
              Effect.andThen(runtime.ensureThread(input)),
              Effect.tap((providerThread) =>
                markProviderThreadLoaded({
                  providerSessionId,
                  threadId: input.threadId,
                  providerThreadKey: providerThreadLoadKey({
                    providerThread,
                    modelSelection: input.modelSelection,
                    runtimePolicy: input.runtimePolicy,
                  }),
                }),
              ),
            ),
          resumeThread: (input) => {
            const threadId = input.threadId ?? input.providerThread.appThreadId;
            if (threadId === null || threadId === undefined) {
              return runtime.resumeThread(input);
            }
            const providerThreadKey = providerThreadLoadKey({
              providerThread: input.providerThread,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
            });
            return observeActivity(
              providerSessionId,
              rememberThreadWorkspace(workspaceOwnership, threadId, input.runtimePolicy?.cwd).pipe(
                Effect.andThen(
                  ensureThreadAttached({
                    providerSessionId,
                    threadId,
                    providerInstanceId: runtime.instanceId,
                  }),
                ),
              ),
            ).pipe(
              Effect.andThen(
                holdThreadLoaded({
                  providerSessionId,
                  threadId,
                  providerThread: input.providerThread,
                }),
              ),
              Effect.andThen(
                isProviderThreadLoaded({ providerSessionId, threadId, providerThreadKey }),
              ),
              Effect.flatMap((loaded) =>
                loaded ? Effect.succeed(input.providerThread) : runtime.resumeThread(input),
              ),
              Effect.tap((providerThread) =>
                markProviderThreadLoaded({
                  providerSessionId,
                  threadId,
                  providerThreadKey: providerThreadLoadKey({
                    providerThread,
                    ...(input.modelSelection === undefined
                      ? {}
                      : { modelSelection: input.modelSelection }),
                    ...(input.runtimePolicy === undefined
                      ? {}
                      : { runtimePolicy: input.runtimePolicy }),
                  }),
                }),
              ),
            );
          },
          forkThread: (input) =>
            observeActivity(
              providerSessionId,
              rememberThreadWorkspace(
                workspaceOwnership,
                input.targetThreadId,
                input.runtimePolicy?.cwd,
              ).pipe(
                Effect.andThen(
                  ensureThreadAttached({
                    providerSessionId,
                    threadId: input.targetThreadId,
                    providerInstanceId: runtime.instanceId,
                  }),
                ),
              ),
            ).pipe(
              Effect.andThen(runtime.forkThread(input)),
              Effect.tap((providerThread) =>
                markProviderThreadLoaded({
                  providerSessionId,
                  threadId: input.targetThreadId,
                  providerThreadKey: providerThreadLoadKey({
                    providerThread,
                    ...(input.modelSelection === undefined
                      ? {}
                      : { modelSelection: input.modelSelection }),
                    ...(input.runtimePolicy === undefined
                      ? {}
                      : { runtimePolicy: input.runtimePolicy }),
                  }),
                }),
              ),
            ),
          startTurn: (input) =>
            observeActivity(
              providerSessionId,
              rememberThreadWorkspace(
                workspaceOwnership,
                input.threadId,
                input.runtimePolicy.cwd,
              ).pipe(
                Effect.andThen(
                  ensureThreadAttached({
                    providerSessionId,
                    threadId: input.threadId,
                    providerInstanceId: runtime.instanceId,
                  }),
                ),
              ),
            ).pipe(
              // Failed or stopped starts may omit turn.terminal; clear their turns so sessions can idle.
              Effect.andThen(
                holdThreadLoaded({
                  providerSessionId,
                  threadId: input.threadId,
                  providerThread: input.providerThread,
                }),
              ),
              Effect.andThen(
                Effect.acquireUseRelease(
                  observeActivity(
                    providerSessionId,
                    markBusy(
                      providerSessionId,
                      busyTurnKey(input.providerThread.id, input.runOrdinal),
                    ),
                  ),
                  () =>
                    runtime.startTurn(input).pipe(turnMetrics("send", input.modelSelection.model)),
                  (_, exit) =>
                    Exit.isFailure(exit)
                      ? observeActivity(
                          providerSessionId,
                          markIdle(providerSessionId, input.providerThread.id, input.runOrdinal),
                        )
                      : Effect.void,
                ),
              ),
            ),
          steerTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.steerTurn(input).pipe(turnMetrics("steer"))),
            ),
          interruptTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.interruptTurn(input).pipe(turnMetrics("interrupt"))),
            ),
          respondToRuntimeRequest: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(
                runtime
                  .respondToRuntimeRequest(input)
                  .pipe(turnMetrics("runtime-request-response")),
              ),
            ),
        };
      };

      const persistProviderSessionUpdate = Effect.fn(
        "ProviderSessionManager.persistProviderSessionUpdate",
      )(
        function* (
          entry: LiveSessionEntry,
          event: Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { readonly type: "provider_session.updated" }
          >,
        ) {
          const current = (yield* Ref.get(sessions)).get(
            sessionKey(entry.runtime.providerSessionId),
          );
          if (current?.runtime !== entry.runtime) {
            return;
          }
          yield* writeProviderSessionEvents({
            runtime: entry.runtime,
            threadIds: current.attachedThreadIds,
            type: "provider-session.updated",
            payload: event.providerSession,
          });
        },
        (effect, entry, _event) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.status-persist-failed", {
                providerSessionId: entry.runtime.providerSessionId,
                cause,
              }),
            ),
          ),
      );

      const startEventPump = (entry: LiveSessionEntry) => {
        let stoppedByProvider = false;
        return entry.runtime.events.pipe(
          Stream.runForEach((event) => {
            if (shutdownSignal.received) return Effect.void;
            // Live output bypasses persistence and subscribers so floods cannot delay domain events.
            if (event.type === "command_output.delta") {
              return commandOutput.append(event);
            }
            const releaseLiveOutput =
              event.type === "turn_item.updated" &&
              event.turnItem.type === "command_execution" &&
              !isOrchestrationV2WorkActive(event.turnItem.status)
                ? commandOutput.finish({
                    threadId: event.turnItem.threadId,
                    itemId: event.turnItem.id,
                  })
                : Effect.void;
            if (
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped"
            ) {
              stoppedByProvider = true;
            }
            return observeActivity(
              entry.runtime.providerSessionId,
              event.type === "turn.terminal"
                ? markIdle(
                    entry.runtime.providerSessionId,
                    event.providerThreadId,
                    event.runOrdinal,
                  )
                : touchActivity(entry.runtime.providerSessionId, { providerActivity: true }),
            ).pipe(
              Effect.andThen(
                event.type === "provider_session.updated"
                  ? persistProviderSessionUpdate(entry, event)
                  : Effect.void,
              ),
              Effect.andThen(
                Effect.gen(function* () {
                  if (
                    event.type === "provider_thread.updated" &&
                    event.providerThread.status === "error"
                  ) {
                    const threadId = event.providerThread.appThreadId;
                    yield* Ref.update(sessions, (sessions) => {
                      const key = sessionKey(entry.runtime.providerSessionId);
                      const latest = sessions.get(key);
                      if (latest?.runtime !== entry.runtime || threadId === null) return sessions;
                      const loadedProviderThreadKeyByThread = new Map(
                        latest.loadedProviderThreadKeyByThread,
                      );
                      loadedProviderThreadKeyByThread.delete(threadId);
                      return new Map(sessions).set(key, {
                        ...latest,
                        loadedProviderThreadKeyByThread,
                      });
                    });
                  }
                  // Some providers can block before a run subscriber exists
                  // (project trust, login, or session-switch hooks). Persist
                  // their runless request artifacts directly so the normal T3
                  // request UI can answer them and unblock session setup.
                  const threadId = sessionScopedRuntimeRequestThreadId(event);
                  if (threadId !== undefined) {
                    yield* Effect.gen(function* () {
                      const current = (yield* Ref.get(sessions)).get(
                        sessionKey(entry.runtime.providerSessionId),
                      );
                      if (current?.runtime !== entry.runtime) return;
                      yield* providerEventIngestor
                        .ingestNormalized({
                          providerSessionId: entry.runtime.providerSessionId,
                          providerInstanceId: entry.runtime.instanceId,
                          threadId,
                          event,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderAdapter.ProviderAdapterEventStreamError({
                                driver: entry.runtime.driver,
                                providerSessionId: entry.runtime.providerSessionId,
                                cause,
                              }),
                          ),
                        );
                    }).pipe(entry.requestEventPermit.withPermits(1));
                    return;
                  }
                  yield* publishToSubscribers(entry.eventSubscribers, { type: "event", event });
                  yield* releaseLiveOutput;
                }),
              ),
            );
          }),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              if (shutdownSignal.received) return;
              const current = (yield* Ref.get(sessions)).get(
                sessionKey(entry.runtime.providerSessionId),
              );
              if (current?.runtime !== entry.runtime) {
                return;
              }
              if (stoppedByProvider && Exit.isSuccess(exit)) {
                yield* releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  reason: "manual_shutdown",
                  gracefulSubscribers: true,
                }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
                return;
              }
              // Subscribers read an interrupt as server shutdown, so keep it for that.
              const cause =
                Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                  ? exit.cause
                  : Cause.fail(
                      new ProviderAdapter.ProviderAdapterEventStreamError({
                        driver: entry.runtime.driver,
                        providerSessionId: entry.runtime.providerSessionId,
                        cause: "Provider event stream ended unexpectedly.",
                      }),
                    );
              yield* publishToSubscribers(entry.eventSubscribers, {
                type: "failure",
                cause,
              });
              yield* Ref.set(entry.eventSubscribers, new Map());
              yield* releaseEntry({
                providerSessionId: entry.runtime.providerSessionId,
                reason: "runtime_error",
                detail: Cause.pretty(cause),
              }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
            }),
          ),
          Effect.forkIn(layerScope),
        );
      };

      // Shutdown must fit the launcher's 5 s deadline with up to 15 sessions.
      const sessionScopes = yield* Scope.make("parallel");
      const shutdown = Effect.gen(function* () {
        const activeSessions = [...(yield* Ref.get(sessions)).values()];
        yield* Effect.forEach(
          activeSessions,
          (entry) =>
            releaseEntry({
              providerSessionId: entry.runtime.providerSessionId,
              reason: "server_shutdown",
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.driver-session.shutdown-release-failed", {
                  providerSessionId: entry.runtime.providerSessionId,
                  cause,
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );
      });
      yield* Effect.addFinalizer(() =>
        shutdown.pipe(
          Effect.ensuring(closeScopeWithin(sessionScopes, { reason: "server_shutdown" })),
        ),
      );

      return ProviderSessionManagerV2.of({
        shutdown,
        open: (input) =>
          sessionOpen.withLock(
            input.providerSessionId,
            Effect.gen(function* () {
              const pendingSnapshot = pendingReleaseSnapshots.get(input.providerSessionId);
              if (pendingSnapshot !== undefined) {
                yield* Effect.all(
                  [
                    captureReleasedRequests(pendingSnapshot),
                    captureReleasedBackgroundTasks(pendingSnapshot),
                  ],
                  { concurrency: 1, discard: true },
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderSessionOpenError({
                        instanceId: input.modelSelection.instanceId,
                        providerSessionId: input.providerSessionId,
                        cause,
                      }),
                  ),
                );
              }
              const cwd = input.runtimePolicy.cwd;
              if (cwd !== null) {
                const workspaceIsDirectory = yield* fileSystem.stat(cwd).pipe(
                  Effect.map((stat) => stat.type === "Directory"),
                  Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
                );
                if (!workspaceIsDirectory) {
                  return yield* new ProviderWorkspaceMissingError({
                    threadId: input.threadId,
                    cwd,
                  });
                }
              }
              const key = sessionKey(input.providerSessionId);
              const existing = (yield* Ref.get(sessions)).get(key);
              if (existing !== undefined) {
                const attached = existing.attachedThreadIds.has(input.threadId);
                if (!attached && !existing.supportsMultipleProviderThreads) {
                  return yield* new ProviderSessionOpenError({
                    instanceId: input.modelSelection.instanceId,
                    providerSessionId: input.providerSessionId,
                    cause: `Provider ${existing.runtime.driver} does not support attaching multiple app threads to one session.`,
                  });
                }
                if (!attached) yield* agentScope.clear(input.threadId);
                yield* rememberThreadWorkspace(
                  existing.workspaceOwnership,
                  input.threadId,
                  input.runtimePolicy.cwd,
                );
                yield* ensureThreadAttached({
                  providerSessionId: input.providerSessionId,
                  threadId: input.threadId,
                  providerInstanceId: existing.runtime.instanceId,
                });
                yield* touchActivity(input.providerSessionId);
                return existing.exposedRuntime;
              }

              const adapter = yield* registry.get(input.modelSelection.instanceId).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderSessionOpenError({
                      instanceId: input.modelSelection.instanceId,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
              // Startup stays interruptible. Registration and the transfer to
              // residency cannot leave an unowned process between those steps.
              return yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const prepared = yield* restore(
                    prepareMcpSession(input.threadId, input.modelSelection.instanceId),
                  );
                  const mcpCredentialId = prepared.mcpCredentialId;
                  // The reservation from prepare protects the credential (which
                  // eager adapters bake into the provider process during
                  // openSession) from racing releases until this session's entry
                  // is recorded below. Dropped exactly once on every path.
                  let reservationDropped = mcpCredentialId === undefined;
                  const dropReservation = Effect.sync(() => {
                    if (!reservationDropped && mcpCredentialId !== undefined) {
                      reservationDropped = true;
                      dropMcpCredentialReservation(input.threadId, mcpCredentialId);
                    }
                  });
                  const sessionScope = yield* Scope.fork(sessionScopes);
                  const workspaceOwnership: WorkspaceOwnership = {
                    id: input.providerSessionId,
                    generation: ++nextWorkspaceGeneration,
                    cwd: input.runtimePolicy.cwd,
                    threadWorkspaces: new Map(),
                    scope: sessionScope,
                    shutdown: yield* Deferred.make<boolean>(),
                    closing: false,
                  };
                  workspaceOwners.set(workspaceOwnership.generation, workspaceOwnership);
                  yield* rememberThreadWorkspace(
                    workspaceOwnership,
                    input.threadId,
                    input.runtimePolicy.cwd,
                  );
                  let resident = false;
                  return yield* Effect.gen(function* () {
                    // The previous session's agent scope must not explain this
                    // session's failures, even when this provider runs without one.
                    yield* restore(agentScope.clear(input.threadId));
                    const runtime = yield* restore(
                      adapter
                        .openSession({
                          threadId: input.threadId,
                          providerSessionId: input.providerSessionId,
                          modelSelection: input.modelSelection,
                          runtimePolicy: input.runtimePolicy,
                          ...(input.resumeFromSession === undefined
                            ? {}
                            : { resumeFromSession: input.resumeFromSession }),
                          ...(input.initialNativeThreadId === undefined
                            ? {}
                            : { initialNativeThreadId: input.initialNativeThreadId }),
                          ...(input.initialProviderItemIdentityVersion === undefined
                            ? {}
                            : {
                                initialProviderItemIdentityVersion:
                                  input.initialProviderItemIdentityVersion,
                              }),
                        })
                        .pipe(
                          Effect.provideService(Scope.Scope, sessionScope),
                          Effect.mapError(
                            (cause) =>
                              new ProviderSessionOpenError({
                                instanceId: input.modelSelection.instanceId,
                                providerSessionId: input.providerSessionId,
                                cause,
                              }),
                          ),
                          withMetrics({
                            counter: providerSessionsTotal,
                            attributes: { provider: adapter.driver, operation: "open" },
                          }),
                        ),
                    );
                    workspaceOwnership.cwd = runtime.providerSession.cwd;
                    yield* rememberThreadWorkspace(
                      workspaceOwnership,
                      input.threadId,
                      runtime.providerSession.cwd,
                    );
                    const eventSubscribers = yield* Ref.make<
                      ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
                    >(new Map());
                    const requestEventPermit = yield* Semaphore.make(1);
                    const exposedRuntime = decorateRuntime(
                      runtime,
                      workspaceOwnership,
                      eventSubscribers,
                      requestEventPermit,
                    );
                    const now = yield* Clock.currentTimeMillis;
                    const entry: LiveSessionEntry = {
                      workspaceOwnership,
                      attachedThreadIds: new Set([input.threadId]),
                      loadedProviderThreadKeyByThread: new Map(),
                      mcpCredentialIdByThread:
                        mcpCredentialId === undefined
                          ? new Map()
                          : new Map([[input.threadId, mcpCredentialId]]),
                      supportsMultipleProviderThreads:
                        runtime.providerSession.capabilities.sessions
                          .supportsMultipleProviderThreadsPerSession,
                      runtime,
                      exposedRuntime,
                      eventSubscribers,
                      requestEventPermit,
                      idleGeneration: 0,
                      busyTurns: new Set(),
                      lastActivityAtMs: now,
                      idleFiber: null,
                      pinnedSinceMs: null,
                      idleThreadUnloads: new Map(),
                    };
                    yield* Ref.update(sessions, (current) => {
                      const updated = new Map(current);
                      updated.set(key, entry);
                      return updated;
                    });
                    resident = true;
                    // The entry now guards the credential via its recorded id, so
                    // the pre-open reservation can be dropped.
                    yield* dropReservation;
                    yield* restore(
                      withActivityError(
                        input.providerSessionId,
                        writeProviderSessionEvents({
                          runtime,
                          threadIds: [input.threadId],
                          type: "provider-session.attached",
                          payload: runtime.providerSession,
                        }),
                      ),
                    );
                    yield* restore(startEventPump(entry));
                    yield* restore(scheduleIdleRelease(input.providerSessionId));
                    return exposedRuntime;
                  }).pipe(
                    Effect.onError((cause) =>
                      resident
                        ? releaseEntry({
                            providerSessionId: input.providerSessionId,
                            openLockHeld: true,
                            reason: Cause.hasInterruptsOnly(cause)
                              ? "manual_shutdown"
                              : "runtime_error",
                            detail: Cause.hasInterruptsOnly(cause)
                              ? "The provider session start was interrupted."
                              : "Failed to persist the provider-session attachment.",
                          }).pipe(logReleaseFailure(input.providerSessionId))
                        : dropReservation.pipe(
                            Effect.andThen(
                              prepared.issued
                                ? clearMcpSession(input.threadId, mcpCredentialId)
                                : Effect.void,
                            ),
                            Effect.ensuring(closeWorkspaceScope(workspaceOwnership, "open_failed")),
                          ),
                    ),
                    Effect.ensuring(dropReservation),
                  );
                }),
              );
            }),
          ),
        isLive: (providerSessionId) =>
          Ref.get(sessions).pipe(
            Effect.map((current) => current.has(sessionKey(providerSessionId))),
          ),
        listWorkspaceSessions: () =>
          Effect.sync(() =>
            Array.from(workspaceOwners.values(), (owner) => ({
              id: owner.id,
              generation: owner.generation,
              cwd: owner.cwd,
              threadWorkspaces: Array.from(owner.threadWorkspaces, ([threadId, workspaces]) =>
                Array.from(workspaces, (cwd) => ({ threadId, cwd })),
              ).flat(),
            })),
          ),
        isMcpCaller: (input) =>
          Ref.get(sessions).pipe(
            Effect.map((current) => {
              const entry = current.get(sessionKey(input.providerSessionId));
              return (
                entry?.attachedThreadIds.has(input.threadId) === true &&
                entry.mcpCredentialIdByThread.get(input.threadId) === input.mcpCredentialId
              );
            }),
          ),
        get: Effect.fn("ProviderSessionManager.get")(
          function* (providerSessionId) {
            const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
            if (entry === undefined) {
              return Option.none<ProviderAdapter.ProviderAdapterV2SessionRuntime>();
            }
            yield* touchActivity(providerSessionId);
            return Option.some(entry.exposedRuntime);
          },
          (effect, providerSessionId) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSessionLookupError({
                    providerSessionId,
                    cause,
                  }),
              ),
            ),
        ),
        close: (providerSessionId) =>
          releaseEntry({ providerSessionId, reason: "manual_shutdown" }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionCloseError({
                  providerSessionId,
                  cause,
                }),
            ),
          ),
        closeInstance: Effect.fn("ProviderSessionManager.closeInstance")(
          function* (instanceId) {
            const active = [...(yield* Ref.get(sessions)).values()].filter(
              (entry) => entry.runtime.instanceId === instanceId,
            );
            const outcomes = yield* Effect.forEach(
              active,
              (entry) =>
                releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  reason: "manual_shutdown",
                  detail: `Provider instance ${instanceId} logged out.`,
                }).pipe(Effect.exit),
              { concurrency: "unbounded" },
            );
            const failure = outcomes.find(Exit.isFailure);
            if (failure !== undefined && Exit.isFailure(failure)) {
              return yield* Effect.failCause(failure.cause);
            }
          },
          (effect, instanceId) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSessionCloseError({
                    providerSessionId: ProviderSessionId.make(
                      `provider-session:provider-instance:${instanceId}`,
                    ),
                    cause,
                  }),
              ),
            ),
        ),
        release: releaseEntry,
        detach: Effect.fn("ProviderSessionManager.detach")(
          function* (input) {
            const key = sessionKey(input.providerSessionId);
            const currentEntry = (yield* Ref.get(sessions)).get(key);
            let detachedProviderThreads: ReadonlyArray<OrchestrationV2ProviderThread> = [];
            if (currentEntry?.supportsMultipleProviderThreads === true) {
              const projection = yield* Effect.option(
                projectionStore.getThreadRecords(input.threadId, [
                  "providerThreads",
                  "providerTurns",
                ]),
              );
              if (Option.isSome(projection)) {
                const providerThreads = new Map(
                  projection.value.providerThreads
                    .filter((thread) => thread.providerSessionId === input.providerSessionId)
                    .map((thread) => [thread.id, thread] as const),
                );
                detachedProviderThreads = [...providerThreads.values()];
                const activeTurns = projection.value.providerTurns.filter(
                  (turn) =>
                    providerThreads.has(turn.providerThreadId) &&
                    (turn.status === "running" ||
                      // The binding transaction can record an interruption before
                      // its detach effect stops the still-executing native turn.
                      (hasBusyTurn(currentEntry, turn.providerThreadId) &&
                        projection.value.providerTurns.findLast(
                          (candidate) => candidate.providerThreadId === turn.providerThreadId,
                        )?.id === turn.id)),
                );
                yield* Effect.forEach(
                  activeTurns,
                  (turn) =>
                    currentEntry.exposedRuntime
                      .interruptTurn({
                        providerThread: providerThreads.get(turn.providerThreadId)!,
                        providerTurnId: turn.id,
                      })
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.driver-session.detach-interrupt-failed",
                            {
                              providerSessionId: input.providerSessionId,
                              threadId: input.threadId,
                              providerTurnId: turn.id,
                              cause,
                            },
                          ),
                        ),
                      ),
                  { concurrency: 1, discard: true },
                );
              }
            }
            const detachResult = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined || !entry.attachedThreadIds.has(input.threadId)) {
                return [
                  Option.none<{
                    readonly entry: LiveSessionEntry;
                    readonly idleUnloadFiber: Fiber.Fiber<void, never> | null;
                  }>(),
                  current,
                ] as const;
              }
              const attachedThreadIds = new Set(entry.attachedThreadIds);
              attachedThreadIds.delete(input.threadId);
              const loadedProviderThreadKeyByThread = new Map(
                entry.loadedProviderThreadKeyByThread,
              );
              loadedProviderThreadKeyByThread.delete(input.threadId);
              const mcpCredentialIdByThread =
                input.revokeMcpCredential === true
                  ? (() => {
                      const pruned = new Map(entry.mcpCredentialIdByThread);
                      pruned.delete(input.threadId);
                      return pruned;
                    })()
                  : entry.mcpCredentialIdByThread;
              const idleThreadUnloads = new Map(entry.idleThreadUnloads);
              idleThreadUnloads.delete(input.threadId);
              const updatedEntry = {
                ...entry,
                attachedThreadIds,
                loadedProviderThreadKeyByThread,
                mcpCredentialIdByThread,
                idleThreadUnloads,
              };
              const updated = new Map(current);
              updated.set(key, updatedEntry);
              return [
                Option.some({
                  entry: updatedEntry,
                  idleUnloadFiber: entry.idleThreadUnloads.get(input.threadId)?.fiber ?? null,
                }),
                updated,
              ] as const;
            });
            if (Option.isSome(detachResult)) {
              yield* cancelIdleFiber(detachResult.value.idleUnloadFiber);
            }
            const detached = Option.map(detachResult, (result) => result.entry);
            // Plain detaches preserve credentials held by live shared providers across workspace handoffs.
            if (input.revokeMcpCredential === true) {
              yield* clearMcpSession(input.threadId);
            }
            if (Option.isNone(detached)) {
              const entry = (yield* Ref.get(sessions)).get(key);
              if (input.releaseWhenUnused && entry?.attachedThreadIds.size === 0) {
                yield* releaseEntry({
                  providerSessionId: input.providerSessionId,
                  reason: "manual_shutdown",
                  onlyIfUnusedOwnership: entry.workspaceOwnership,
                });
              }
              return;
            }
            if (
              detached.value.attachedThreadIds.size === 0 &&
              (!detached.value.supportsMultipleProviderThreads || input.releaseWhenUnused)
            ) {
              yield* releaseEntry({
                providerSessionId: input.providerSessionId,
                reason: "manual_shutdown",
                ...(input.detail === undefined ? {} : { detail: input.detail }),
                detachedThreadId: input.threadId,
                onlyIfUnusedOwnership: detached.value.workspaceOwnership,
              });
              const entry = (yield* Ref.get(sessions)).get(key);
              if (entry?.workspaceOwnership !== detached.value.workspaceOwnership) {
                return;
              }
              // A concurrent attachment kept this generation alive, so the
              // detached thread still needs the shared-runtime cleanup below.
            }
            const unloadThread = detached.value.exposedRuntime.unloadThread;
            if (detached.value.supportsMultipleProviderThreads && unloadThread !== undefined) {
              // Serialize unload with attachment so attached threads stay loaded and later attaches resume after unload.
              yield* threadAttachment.withLock(
                threadAttachmentKey(input),
                Effect.gen(function* () {
                  const entry = (yield* Ref.get(sessions)).get(key);
                  if (
                    entry?.runtime !== detached.value.runtime ||
                    entry.attachedThreadIds.has(input.threadId)
                  ) {
                    return;
                  }
                  yield* Effect.forEach(
                    detachedProviderThreads.filter((thread) => thread.nativeThreadRef !== null),
                    (providerThread) =>
                      unloadThread({ providerThread }).pipe(
                        Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.driver-session.detach-unload-failed",
                            {
                              providerSessionId: input.providerSessionId,
                              threadId: input.threadId,
                              providerThreadId: providerThread.id,
                              cause,
                            },
                          ),
                        ),
                      ),
                    { concurrency: 1, discard: true },
                  );
                }),
              );
            }
            yield* scheduleIdleRelease(input.providerSessionId);
          },
          (effect, input) =>
            effect.pipe(
              Effect.tap(() =>
                input.releaseWhenUnused
                  ? Effect.gen(function* () {
                      for (const generation of input.releaseWhenUnused!.workspaceGenerations) {
                        const owner = workspaceOwners.get(generation);
                        // An open/live runtime is checked by the caller's final inventory
                        // guard. Only join closes already in progress; never wait on a
                        // shared runtime that still has other attached threads.
                        if (owner?.id !== input.providerSessionId || !owner.closing) continue;
                        if (!(yield* Deferred.await(owner.shutdown)))
                          return yield* new ProviderSessionReleaseError({
                            providerSessionId: input.providerSessionId,
                            reason: "manual_shutdown",
                          });
                      }
                    })
                  : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Effect.fail(
                  new ProviderSessionReleaseError({
                    providerSessionId: input.providerSessionId,
                    reason: "manual_shutdown",
                    cause,
                  }),
                ),
              ),
            ),
        ),
      } satisfies ProviderSessionManagerV2Shape);
    }),
  );

export const layer = layerWithOptions();

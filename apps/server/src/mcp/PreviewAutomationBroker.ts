import {
  ComputerAutomationFailure,
  EnvironmentDesktopAutomationError,
  COMPUTER_AUTOMATION_OPERATIONS,
  isComputerAutomationFailureKind,
  MAX_USER_DESKTOPS,
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationDesktopTargetRequiredError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnsupportedClientError,
  PreviewTabId,
  type IsoDateTime,
  type EnvironmentId,
  type ThreadId,
  type ProviderInstanceId,
  type PreviewAutomationError,
  type PreviewAutomationOperation,
  type PreviewAutomationHost,
  type PreviewAutomationHostFocus,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  type UserDesktopCapability,
  type UserDesktopAuditAction,
  type UserDesktopAuditLog,
  type UserDesktopHostRegistration,
  UserDesktopId,
  type UserDesktopList,
  UserDesktopManagementError,
  type UserDesktopRenameInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as UserDesktops from "../persistence/UserDesktops.ts";

const isComputerAutomationFailure = Schema.is(ComputerAutomationFailure);
const THREAD_COMPUTER_INTERRUPTION_TIMEOUT_MS = 10_000;

export interface PreviewAutomationInvokeInput {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export interface ThreadComputerInterruptionInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

/** Identifies one environment-local thread without coupling control to provider credentials. */
function threadKey(
  input: Pick<ThreadComputerInterruptionInput, "environmentId" | "threadId">,
): string {
  return JSON.stringify([input.environmentId, input.threadId]);
}

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  {
    readonly connect: (
      host: PreviewAutomationHost,
    ) => Effect.Effect<Stream.Stream<PreviewAutomationStreamEvent>>;
    readonly focusHost: (host: PreviewAutomationHostFocus) => Effect.Effect<void>;
    readonly respond: (
      response: PreviewAutomationResponse,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly invoke: <A = unknown>(
      request: PreviewAutomationInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
    /** Blocks late input before provider cancellation and returns the desktop cleanup receipt. */
    readonly beginThreadInterruption: (
      input: ThreadComputerInterruptionInput,
    ) => Effect.Effect<Effect.Effect<void, PreviewAutomationError>>;
    readonly resumeThread: (
      input: Pick<ThreadComputerInterruptionInput, "environmentId" | "threadId">,
    ) => Effect.Effect<void>;
    readonly listUserDesktops: (
      environmentId: PreviewAutomationHost["environmentId"],
    ) => Effect.Effect<UserDesktopList, UserDesktops.UserDesktopRepositoryError>;
    readonly renameUserDesktop: (
      input: UserDesktopRenameInput,
    ) => Effect.Effect<void, UserDesktops.UserDesktopRepositoryError | UserDesktopManagementError>;
    readonly removeUserDesktop: (
      environmentId: PreviewAutomationHost["environmentId"],
      desktopId: UserDesktopId,
    ) => Effect.Effect<void, UserDesktops.UserDesktopRepositoryError | UserDesktopManagementError>;
    readonly listUserDesktopAudit: (
      desktopId: UserDesktopId,
    ) => Effect.Effect<UserDesktopAuditLog, UserDesktops.UserDesktopRepositoryError>;
  }
>()("t3/mcp/PreviewAutomationBroker") {}

interface ClientConnection {
  readonly clientId: string;
  readonly connectionId: string;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly supportedOperations: ReadonlySet<PreviewAutomationOperation>;
  readonly userDesktop: PreviewAutomationHost["userDesktop"];
  readonly focused: boolean;
  readonly focusOrder: number;
  readonly lastActiveAt: IsoDateTime | null;
  readonly connectedAt: IsoDateTime;
  readonly queue: Queue.Queue<PreviewAutomationStreamEvent>;
}

interface PendingRequest {
  readonly queue: ClientConnection["queue"];
  readonly deferred: Deferred.Deferred<unknown, PreviewAutomationError>;
  readonly context: PreviewAutomationRequestErrorContext;
  readonly controllerId?: string;
  readonly controllerKind?: McpInvocationContext.McpInvocationScope["controllerKind"];
}

/**
 * A lease pinning one provider session to one desktop runtime. It lives exactly
 * as long as the connection it names: `connectionId`/`queue` identity is what
 * makes a lease valid, so a disconnected or replaced host is dropped on the next
 * lookup. The lease deliberately has no clock of its own — it used to inherit
 * the MCP credential's expiry, which coupled host stickiness to an unrelated
 * auth deadline and could migrate a live session to another runtime mid-flow.
 */
interface HostAssignment {
  readonly clientId: ClientConnection["clientId"];
  readonly connectionId: ClientConnection["connectionId"];
  readonly queue: ClientConnection["queue"];
  readonly tabId?: PreviewTabId;
  readonly tabSequence?: number;
}

interface PreviewAutomationRequestErrorContext {
  readonly operation: PreviewAutomationOperation;
  readonly environmentId: McpInvocationContext.McpInvocationScope["environmentId"];
  readonly threadId: McpInvocationContext.McpInvocationScope["threadId"];
  readonly providerSessionId: string;
  readonly providerInstanceId: McpInvocationContext.McpInvocationScope["providerInstanceId"];
  readonly clientId: string;
  readonly connectionId: ClientConnection["connectionId"];
  readonly requestId: string;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs: number;
  readonly selectorKind?: "locator" | "selector";
  readonly selectorLength?: number;
}

interface BrokerState {
  readonly clients: ReadonlyMap<string, ClientConnection>;
  readonly assignments: ReadonlyMap<string, HostAssignment>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly interruptedThreads: ReadonlyMap<string, string>;
  readonly requestSequence: number;
  readonly focusSequence: number;
}

interface UnavailableHostDiagnostics {
  readonly connectedHostCount: number;
  readonly operationHostCount: number;
  readonly assignedHostIncompatible: boolean;
  readonly incompatibleClientCount: number;
  readonly targetConnectionCount: number;
  readonly targetOperationHostCount: number;
  readonly targetCapabilities: ReadonlySet<UserDesktopCapability>;
  readonly requestedDesktopId?: UserDesktopId | undefined;
  readonly connectedDesktopTargets: ReadonlyArray<string>;
}

type HostRoute =
  | { readonly _tag: "interrupted" }
  | {
      readonly _tag: "unavailable";
      readonly diagnostics: UnavailableHostDiagnostics;
    }
  | {
      readonly _tag: "route";
      readonly connection: ClientConnection;
      readonly requestId: string;
      readonly requestContext: PreviewAutomationRequestErrorContext;
      readonly requestSequence: number;
      readonly assignmentKey?: string | undefined;
    };

const removeConnectionFromState = (
  current: BrokerState,
  clientId: string,
  queue: ClientConnection["queue"],
): { readonly state: BrokerState; readonly disconnected: ReadonlyArray<PendingRequest> } => {
  const clients = new Map(current.clients);
  const assignments = new Map(current.assignments);
  const pending = new Map(current.pending);
  const disconnected: PendingRequest[] = [];
  if (current.clients.get(clientId)?.queue === queue) clients.delete(clientId);
  for (const [assignmentKey, assignment] of assignments) {
    if (assignment.queue === queue) assignments.delete(assignmentKey);
  }
  for (const [requestId, entry] of pending) {
    if (entry.queue !== queue) continue;
    pending.delete(requestId);
    disconnected.push(entry);
  }
  return {
    state: { ...current, clients, assignments, pending },
    disconnected,
  };
};

const selectorDiagnosticsFromInput = (
  input: unknown,
): Pick<PreviewAutomationRequestErrorContext, "selectorKind" | "selectorLength"> => {
  if (typeof input !== "object" || input === null) return {};
  if ("locator" in input && typeof input.locator === "string") {
    return { selectorKind: "locator", selectorLength: input.locator.length };
  }
  if ("selector" in input && typeof input.selector === "string") {
    return { selectorKind: "selector", selectorLength: input.selector.length };
  }
  return {};
};

const computerOperations = new Set<string>(COMPUTER_AUTOMATION_OPERATIONS);

const isComputerOperation = (
  operation: PreviewAutomationOperation,
): operation is (typeof COMPUTER_AUTOMATION_OPERATIONS)[number] =>
  computerOperations.has(operation);

/** Reports a stopped computer request without claiming native cleanup has completed. */
function threadInterruptedError(
  scope: Pick<
    McpInvocationContext.McpInvocationScope,
    "environmentId" | "threadId" | "providerSessionId" | "providerInstanceId"
  >,
  operation: (typeof COMPUTER_AUTOMATION_OPERATIONS)[number],
) {
  return new EnvironmentDesktopAutomationError({
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    providerSessionId: scope.providerSessionId,
    providerInstanceId: scope.providerInstanceId,
    operation,
    computerFailure: {
      code: "request-cancelled",
      category: "cancelled",
      message: "The turn was stopped. Computer operations can resume on the next turn.",
    },
  });
}

/** Builds one provider-session affinity key without inferring a computer target. */
function hostAssignmentKey(
  scope: McpInvocationContext.McpInvocationScope,
  operation: PreviewAutomationOperation,
): string {
  if (!isComputerOperation(operation)) {
    return `${scope.environmentId}\u0000${scope.providerSessionId}\u0000preview`;
  }
  return `${scope.environmentId}\u0000${scope.controllerId}\u0000computer`;
}

interface RequestedComputerDesktop {
  readonly kind: "user" | "agent" | undefined;
  readonly desktopId: UserDesktopId | undefined;
}

const isUserDesktopId = Schema.is(UserDesktopId);

/** Reads an explicit computer target without trusting arbitrary tool input. */
function requestedComputerDesktop(input: unknown): RequestedComputerDesktop {
  if (typeof input !== "object" || input === null || !("desktop" in input)) {
    return { kind: undefined, desktopId: undefined };
  }
  const desktop = input.desktop;
  if (typeof desktop !== "object" || desktop === null || !("kind" in desktop)) {
    return { kind: undefined, desktopId: undefined };
  }
  const kind = desktop.kind === "user" || desktop.kind === "agent" ? desktop.kind : undefined;
  const desktopId =
    kind === "user" && "desktopId" in desktop && isUserDesktopId(desktop.desktopId)
      ? desktop.desktopId
      : undefined;
  return { kind, desktopId };
}

interface UserDesktopAuditTransition {
  readonly action: UserDesktopAuditAction;
  readonly takeover: boolean;
}

/** Selects successful access transitions that are safe and useful to persist as metadata. */
function userDesktopAuditTransition(
  operation: PreviewAutomationOperation,
  input: unknown,
): UserDesktopAuditTransition | null {
  const options = typeof input === "object" && input !== null ? input : {};
  switch (operation) {
    case "computerRequestView":
      return {
        action:
          "releaseControlToView" in options && options.releaseControlToView === true
            ? "control-released"
            : "view-granted",
        takeover: false,
      };
    case "computerRequestControl":
      return {
        action:
          "returnControlToAgent" in options && options.returnControlToAgent === true
            ? "control-returned-to-agent"
            : "control-granted",
        takeover: "takeoverLeaseId" in options && typeof options.takeoverLeaseId === "string",
      };
    case "computerRelease":
      return { action: "access-released", takeover: false };
    case "computerForceRelease":
      return { action: "all-access-ended", takeover: false };
    case "computerRememberView":
      return { action: "view-remembered", takeover: false };
    case "computerRememberControl":
      return { action: "control-remembered", takeover: false };
    case "computerForgetControl":
    case "computerForceForgetControl":
      return { action: "approval-forgotten", takeover: false };
    default:
      return null;
  }
}

const USER_DESKTOP_TARGETS = ['{"kind":"user","desktopId":"<id from user_desktop_list>"}'] as const;

/** Describes connected host capabilities without exposing client identities. */
function unavailableHostDiagnostics(
  connections: ReadonlyArray<ClientConnection>,
  operation: PreviewAutomationOperation,
  assignedHostIncompatible: boolean,
  requestedDesktopId?: UserDesktopId,
): UnavailableHostDiagnostics {
  const targetConnections =
    requestedDesktopId === undefined
      ? []
      : connections.filter(
          (connection) => connection.userDesktop?.desktopId === requestedDesktopId,
        );
  return {
    connectedHostCount: connections.length,
    operationHostCount: connections.filter((connection) => supportsOperation(connection, operation))
      .length,
    assignedHostIncompatible,
    incompatibleClientCount: connections.filter(
      (connection) =>
        connection.userDesktop === undefined &&
        Array.from(computerOperations).some((candidate) =>
          connection.supportedOperations.has(candidate as PreviewAutomationOperation),
        ),
    ).length,
    targetConnectionCount: targetConnections.length,
    targetOperationHostCount: targetConnections.filter((connection) =>
      supportsOperation(connection, operation),
    ).length,
    targetCapabilities: new Set(
      targetConnections.flatMap((connection) => connection.userDesktop?.capabilities ?? []),
    ),
    ...(requestedDesktopId === undefined ? {} : { requestedDesktopId }),
    connectedDesktopTargets: connections.flatMap((connection) =>
      connection.userDesktop === undefined
        ? []
        : [
            JSON.stringify({
              kind: "user",
              desktopId: connection.userDesktop.desktopId,
            }),
          ],
    ),
  };
}

/** Maps one computer operation to the coarse user-desktop capability it needs. */
function requiredUserDesktopCapability(
  operation: PreviewAutomationOperation,
): UserDesktopCapability {
  if (operation === "computerRequestAvailability" || operation === "computerReleaseAvailability") {
    return "availability";
  }
  if (
    operation === "computerRequestControl" ||
    operation === "computerRememberControl" ||
    operation === "computerAct"
  ) {
    return "control";
  }
  return "view";
}

/** Builds one actionable computer-use failure from broker routing state. */
function unavailableComputerHostFailure(input: {
  readonly operation: PreviewAutomationOperation;
  readonly environmentId: PreviewAutomationInvokeInput["scope"]["environmentId"];
  readonly diagnostics: UnavailableHostDiagnostics;
}): ComputerAutomationFailure {
  const { diagnostics } = input;
  const detail = `Connected hosts: ${diagnostics.connectedHostCount}; current user desktops: ${diagnostics.connectedDesktopTargets.length}; hosts supporting ${input.operation}: ${diagnostics.operationHostCount}; incompatible desktop clients: ${diagnostics.incompatibleClientCount}.`;

  if (diagnostics.targetConnectionCount > 1) {
    return {
      code: "desktop-identity-conflict",
      category: "conflict",
      message: `More than one connected client claims user desktop ${diagnostics.requestedDesktopId}.`,
      backendCode: "duplicate-user-desktop-identity",
      detail,
      field: "desktop.desktopId",
      received: diagnostics.requestedDesktopId,
      phase: "execution",
      cleanup: { keys: "not-needed", buttons: "not-needed" },
    };
  }

  if (diagnostics.targetConnectionCount === 1 && diagnostics.targetOperationHostCount === 0) {
    const requiredCapability = requiredUserDesktopCapability(input.operation);
    if (!diagnostics.targetCapabilities.has(requiredCapability)) {
      return {
        code: "unsupported-operation",
        category: "unsupported-operation",
        message: `User desktop ${diagnostics.requestedDesktopId} does not support ${requiredCapability} access on its current platform.`,
        backendCode: "user-desktop-capability-unavailable",
        detail,
        field: "operation",
        received: input.operation,
        expected: Array.from(diagnostics.targetCapabilities),
        phase: "execution",
        cleanup: { keys: "not-needed", buttons: "not-needed" },
      };
    }
    return {
      code: "desktop-client-update-required",
      category: "unsupported-operation",
      message: `User desktop ${diagnostics.requestedDesktopId} does not support ${input.operation}. Update its T3 desktop client.`,
      backendCode: "user-desktop-operation-unsupported",
      detail,
      field: "operation",
      received: input.operation,
      phase: "execution",
      cleanup: { keys: "not-needed", buttons: "not-needed" },
    };
  }

  if (diagnostics.requestedDesktopId !== undefined && diagnostics.targetConnectionCount === 0) {
    return {
      code: "desktop-offline",
      category: "resource",
      message: `User desktop ${diagnostics.requestedDesktopId} is offline or unknown.`,
      backendCode:
        diagnostics.incompatibleClientCount > 0
          ? "connected-client-update-required"
          : "user-desktop-offline",
      detail,
      field: "desktop.desktopId",
      received: diagnostics.requestedDesktopId,
      ...(diagnostics.connectedDesktopTargets.length === 0
        ? {}
        : { expected: diagnostics.connectedDesktopTargets }),
      phase: "execution",
      cleanup: { keys: "not-needed", buttons: "not-needed" },
    };
  }

  if (diagnostics.connectedHostCount === 0) {
    return {
      code: "unsupported-operation",
      category: "resource",
      message: `No user-desktop automation host is connected for environment ${input.environmentId}.`,
      backendCode: "no-connected-automation-host",
      detail,
      phase: "execution",
      cleanup: { keys: "not-needed", buttons: "not-needed" },
    };
  }

  if (diagnostics.assignedHostIncompatible) {
    return {
      code: "unsupported-operation",
      category: "unsupported-operation",
      message: `The assigned user-desktop host does not support ${input.operation}. T3 retained host affinity instead of moving stateful work to another machine.`,
      backendCode: "assigned-automation-host-incompatible",
      detail,
      field: "operation",
      received: input.operation,
      phase: "execution",
      cleanup: { keys: "not-needed", buttons: "not-needed" },
    };
  }

  if (diagnostics.operationHostCount === 0) {
    return {
      code: "unsupported-operation",
      category: "unsupported-operation",
      message: `Connected automation hosts do not support ${input.operation} for environment ${input.environmentId}. Update or connect a capable desktop client.`,
      backendCode: "automation-operation-unsupported",
      detail,
      field: "operation",
      received: input.operation,
      phase: "execution",
      cleanup: { keys: "not-needed", buttons: "not-needed" },
    };
  }

  return {
    code: "unsupported-operation",
    category: "unsupported-operation",
    message: `No connected automation host supports ${input.operation} for the requested user desktop in environment ${input.environmentId}.`,
    backendCode: "no-compatible-automation-host",
    detail,
    phase: "execution",
    cleanup: { keys: "not-needed", buttons: "not-needed" },
  };
}

const isPreviewTabId = Schema.is(PreviewTabId);

const readResultTabId = (result: unknown): PreviewTabId | null | undefined => {
  if (typeof result !== "object" || result === null || !("tabId" in result)) return undefined;
  const tabId = result.tabId;
  return tabId === null || isPreviewTabId(tabId) ? tabId : undefined;
};

const supportsOperation = (
  connection: ClientConnection,
  operation: PreviewAutomationOperation,
): boolean => connection.supportedOperations.has(operation);

type RemoteDetailKind = "null" | "array" | "object" | "string" | "number" | "boolean";

function remoteDetailKind(detail: unknown): RemoteDetailKind {
  if (detail === null) return "null";
  if (Array.isArray(detail)) return "array";
  switch (typeof detail) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

const classifyResponseError = (
  context: PreviewAutomationRequestErrorContext,
  error: NonNullable<PreviewAutomationResponse["error"]>,
): PreviewAutomationError => {
  const remoteDiagnostics = {
    remoteTag: error._tag,
    remoteMessageLength: error.message.length,
    ...(error.detail === undefined ? {} : { remoteDetailKind: remoteDetailKind(error.detail) }),
    cause: error,
  };
  switch (error._tag) {
    case "PreviewAutomationNoAvailableHostError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const computerFailure =
        detail && "computerFailure" in detail && isComputerAutomationFailure(detail.computerFailure)
          ? detail.computerFailure
          : undefined;
      return new PreviewAutomationNoAvailableHostError({
        ...context,
        ...remoteDiagnostics,
        ...(computerFailure === undefined ? {} : { computerFailure }),
      });
    }
    case "PreviewAutomationUnsupportedClientError":
      return new PreviewAutomationUnsupportedClientError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTabNotFoundError":
      return new PreviewAutomationTabNotFoundError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTimeoutError":
      return new PreviewAutomationTimeoutError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationControlInterruptedError":
      return new PreviewAutomationControlInterruptedError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationInvalidSelectorError": {
      return new PreviewAutomationInvalidSelectorError({
        ...context,
        ...remoteDiagnostics,
      });
    }
    case "PreviewAutomationTargetNotEditableError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const remoteSelectorKind =
        detail &&
        "selectorKind" in detail &&
        (detail.selectorKind === "focused-element" ||
          detail.selectorKind === "locator" ||
          detail.selectorKind === "selector")
          ? detail.selectorKind
          : undefined;
      const remoteSelectorLength =
        detail &&
        "selectorLength" in detail &&
        typeof detail.selectorLength === "number" &&
        Number.isInteger(detail.selectorLength) &&
        detail.selectorLength >= 0
          ? detail.selectorLength
          : undefined;
      return new PreviewAutomationTargetNotEditableError({
        ...context,
        ...remoteDiagnostics,
        ...(remoteSelectorKind === undefined && context.selectorKind === undefined
          ? {}
          : { selectorKind: remoteSelectorKind ?? context.selectorKind }),
        ...(remoteSelectorLength === undefined && context.selectorLength === undefined
          ? {}
          : { selectorLength: remoteSelectorLength ?? context.selectorLength }),
      });
    }
    case "PreviewAutomationResultTooLargeError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const maximumBytes =
        detail &&
        "maximumBytes" in detail &&
        typeof detail.maximumBytes === "number" &&
        Number.isInteger(detail.maximumBytes) &&
        detail.maximumBytes > 0
          ? detail.maximumBytes
          : undefined;
      return new PreviewAutomationResultTooLargeError({
        ...context,
        ...remoteDiagnostics,
        ...(maximumBytes === undefined ? {} : { maximumBytes }),
      });
    }
    case "PreviewAutomationUnavailableError":
      return new PreviewAutomationRemoteUnavailableError({
        ...context,
        ...remoteDiagnostics,
      });
    default: {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const remoteFailureKind =
        detail && "failureKind" in detail && isComputerAutomationFailureKind(detail.failureKind)
          ? detail.failureKind
          : undefined;
      const computerFailure =
        detail && "computerFailure" in detail && isComputerAutomationFailure(detail.computerFailure)
          ? detail.computerFailure
          : undefined;
      return new PreviewAutomationExecutionError({
        ...context,
        ...remoteDiagnostics,
        ...(remoteFailureKind === undefined ? {} : { remoteFailureKind }),
        ...(computerFailure === undefined ? {} : { computerFailure }),
      });
    }
  }
};

/** Supplies the authoritative User desktop owner for a desktop-managed environment. */
export class EnvironmentUserDesktopHost extends Context.Reference<
  UserDesktopHostRegistration | undefined
>("t3/mcp/PreviewAutomationBroker/EnvironmentUserDesktopHost", {
  defaultValue: () => undefined,
}) {}

export const make = Effect.gen(function* PreviewAutomationBrokerMake() {
  const crypto = yield* Crypto.Crypto;
  const userDesktops = yield* UserDesktops.UserDesktopRepository;
  const environmentHost = yield* EnvironmentUserDesktopHost;
  const environmentHostLastSeenAt =
    environmentHost === undefined ? undefined : DateTime.formatIso(yield* DateTime.now);
  if (environmentHost !== undefined && environmentHostLastSeenAt !== undefined) {
    yield* userDesktops
      .upsertHost(environmentHost, environmentHostLastSeenAt)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("environment host desktop persistence failed", { error }),
        ),
      );
  }
  const state = yield* SynchronizedRef.make<BrokerState>({
    clients: new Map(),
    assignments: new Map(),
    pending: new Map(),
    interruptedThreads: new Map(),
    requestSequence: 0,
    focusSequence: 0,
  });

  const closeConnection = Effect.fn("PreviewAutomationBroker.closeConnection")(function* (
    queue: ClientConnection["queue"],
    disconnected: ReadonlyArray<PendingRequest>,
  ) {
    yield* Effect.forEach(
      disconnected,
      ({ deferred, context }) =>
        Deferred.fail(deferred, new PreviewAutomationClientDisconnectedError(context)),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const disconnect = Effect.fn("PreviewAutomationBroker.disconnect")(function* (
    clientId: string,
    queue: ClientConnection["queue"],
  ) {
    const disconnected = yield* SynchronizedRef.modify(state, (current) => {
      const removed = removeConnectionFromState(current, clientId, queue);
      const userDesktop = current.clients.get(clientId)?.userDesktop;
      return [{ pending: removed.disconnected, userDesktop }, removed.state] as const;
    });
    if (disconnected.userDesktop !== undefined) {
      const lastSeenAt = DateTime.formatIso(yield* DateTime.now);
      yield* userDesktops
        .upsertHost(disconnected.userDesktop, lastSeenAt)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("user desktop disconnect persistence failed", { error }),
          ),
        );
    }
    yield* closeConnection(queue, disconnected.pending);
  });

  const acquireConnection = Effect.fn("PreviewAutomationBroker.acquireConnection")(function* (
    host: PreviewAutomationHost,
  ) {
    const clientId = host.clientId;
    const queue = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const connectedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const connection: ClientConnection = {
      clientId,
      connectionId,
      environmentId: host.environmentId,
      supportedOperations: new Set(host.supportedOperations ?? PREVIEW_AUTOMATION_V1_OPERATIONS),
      userDesktop: host.userDesktop,
      focused: false,
      focusOrder: 0,
      lastActiveAt: null,
      connectedAt,
      queue,
    };
    if (host.userDesktop !== undefined) {
      yield* userDesktops
        .upsertHost(host.userDesktop, connectedAt)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("user desktop registration persistence failed", { error }),
          ),
        );
    }
    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previousConnection = current.clients.get(clientId);
      const removed = previousConnection
        ? removeConnectionFromState(current, clientId, previousConnection.queue)
        : { state: current, disconnected: [] };
      const clients = new Map(removed.state.clients);
      const focusSequence = removed.state.focusSequence + 1;
      const registeredConnection = { ...connection, focusOrder: focusSequence };
      clients.set(clientId, registeredConnection);
      return [
        {
          previousConnection,
          disconnected: removed.disconnected,
          registeredConnection,
        },
        { ...removed.state, clients, focusSequence },
      ] as const;
    });
    if (registration.previousConnection) {
      yield* closeConnection(registration.previousConnection.queue, registration.disconnected);
    }
    return registration.registeredConnection;
  });

  const connect: PreviewAutomationBroker["Service"]["connect"] = Effect.fn(
    "PreviewAutomationBroker.connect",
  )((host) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireConnection(host), (connection) =>
          disconnect(connection.clientId, connection.queue),
        ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
      ),
    ),
  );

  const focusHost: PreviewAutomationBroker["Service"]["focusHost"] = Effect.fn(
    "PreviewAutomationBroker.focusHost",
  )(function* (host) {
    const lastActiveAt = host.focused ? DateTime.formatIso(yield* DateTime.now) : null;
    const focusedDesktop = yield* SynchronizedRef.modify(state, (current) => {
      const currentHost = current.clients.get(host.clientId);
      if (
        !currentHost ||
        currentHost.environmentId !== host.environmentId ||
        currentHost.connectionId !== host.connectionId
      ) {
        return [undefined, current] as const;
      }
      const clients = new Map(current.clients);
      const focusSequence = host.focused ? current.focusSequence + 1 : current.focusSequence;
      clients.set(host.clientId, {
        ...currentHost,
        focused: host.focused,
        focusOrder: host.focused ? focusSequence : currentHost.focusOrder,
        lastActiveAt: lastActiveAt ?? currentHost.lastActiveAt,
      });
      return [
        host.focused ? currentHost.userDesktop : undefined,
        { ...current, clients, focusSequence },
      ] as const;
    });
    if (focusedDesktop !== undefined && lastActiveAt !== null) {
      yield* userDesktops
        .markActive(focusedDesktop.desktopId, lastActiveAt)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("user desktop activity persistence failed", { error }),
          ),
        );
    }
  });

  const listUserDesktops: PreviewAutomationBroker["Service"]["listUserDesktops"] = Effect.fn(
    "PreviewAutomationBroker.listUserDesktops",
  )(function* (environmentId) {
    const [records, current] = yield* Effect.all([userDesktops.list(), SynchronizedRef.get(state)]);
    const connections = Array.from(current.clients.values()).filter(
      (connection) => connection.environmentId === environmentId,
    );
    const recordsById = new Map(records.map((record) => [record.desktopId, record]));
    if (
      environmentHost !== undefined &&
      environmentHostLastSeenAt !== undefined &&
      !recordsById.has(environmentHost.desktopId)
    ) {
      recordsById.set(environmentHost.desktopId, {
        desktopId: environmentHost.desktopId,
        defaultLabel: environmentHost.defaultLabel,
        customLabel: null,
        platform: environmentHost.platform,
        capabilities: environmentHost.capabilities,
        lastSeenAt: environmentHostLastSeenAt,
        lastActiveAt: null,
      });
    }
    for (const connection of connections) {
      const host = connection.userDesktop;
      if (host === undefined || recordsById.has(host.desktopId)) continue;
      recordsById.set(host.desktopId, {
        desktopId: host.desktopId,
        defaultLabel: host.defaultLabel,
        customLabel: null,
        platform: host.platform,
        capabilities: host.capabilities,
        lastSeenAt: connection.connectedAt,
        lastActiveAt: connection.lastActiveAt,
      });
    }
    const desktops = Array.from(recordsById.values()).map((record) => {
      const matches = connections.filter(
        (connection) => connection.userDesktop?.desktopId === record.desktopId,
      );
      const liveConnection = matches.length === 1 ? matches[0] : undefined;
      const liveHost = liveConnection?.userDesktop;
      const liveLastActiveAt = matches
        .map((connection) => connection.lastActiveAt)
        .filter((value): value is IsoDateTime => value !== null)
        .sort()
        .at(-1);
      return {
        desktop: { kind: "user" as const, desktopId: record.desktopId },
        label: record.customLabel ?? liveHost?.defaultLabel ?? record.defaultLabel,
        defaultLabel: liveHost?.defaultLabel ?? record.defaultLabel,
        platform: liveHost?.platform ?? record.platform,
        capabilities: liveHost?.capabilities ?? record.capabilities,
        connectionState:
          matches.length > 1
            ? ("identity-conflict" as const)
            : matches.length === 1
              ? ("online" as const)
              : ("offline" as const),
        lastSeenAt: liveConnection?.connectedAt ?? record.lastSeenAt,
        t3Focused: matches.some((connection) => connection.focused),
        lastActiveAt: liveLastActiveAt ?? record.lastActiveAt,
      };
    });
    desktops.sort(
      (left, right) =>
        Number(right.t3Focused) - Number(left.t3Focused) ||
        Number(right.connectionState === "online") - Number(left.connectionState === "online") ||
        right.lastSeenAt.localeCompare(left.lastSeenAt) ||
        left.label.localeCompare(right.label),
    );
    const boundedDesktops = desktops.slice(0, MAX_USER_DESKTOPS);
    const environmentHostView =
      environmentHost === undefined
        ? undefined
        : desktops.find((desktop) => desktop.desktop.desktopId === environmentHost.desktopId);
    const listedDesktops =
      environmentHostView !== undefined &&
      !boundedDesktops.some(
        (desktop) => desktop.desktop.desktopId === environmentHostView.desktop.desktopId,
      )
        ? [...boundedDesktops.slice(0, -1), environmentHostView]
        : boundedDesktops;
    return {
      desktops: listedDesktops,
      incompatibleClientCount: connections.filter(
        (connection) =>
          connection.userDesktop === undefined &&
          Array.from(computerOperations).some((operation) =>
            connection.supportedOperations.has(operation as PreviewAutomationOperation),
          ),
      ).length,
      environmentHost:
        environmentHost === undefined
          ? ({ status: "unidentified" } as const)
          : ({
              status: "identified",
              desktop: { kind: "user", desktopId: environmentHost.desktopId },
            } as const),
    };
  });

  const renameUserDesktop: PreviewAutomationBroker["Service"]["renameUserDesktop"] = Effect.fn(
    "PreviewAutomationBroker.renameUserDesktop",
  )(function* (input) {
    const records = yield* userDesktops.list();
    if (!records.some((record) => record.desktopId === input.desktopId)) {
      return yield* new UserDesktopManagementError({
        code: "user-desktop-not-found",
        desktopId: input.desktopId,
        detail: "The selected user desktop is not known to this environment.",
      });
    }
    yield* userDesktops.rename(input);
  });

  const removeUserDesktop: PreviewAutomationBroker["Service"]["removeUserDesktop"] = Effect.fn(
    "PreviewAutomationBroker.removeUserDesktop",
  )(function* (environmentId, desktopId) {
    const [records, current] = yield* Effect.all([userDesktops.list(), SynchronizedRef.get(state)]);
    if (!records.some((record) => record.desktopId === desktopId)) {
      return yield* new UserDesktopManagementError({
        code: "user-desktop-not-found",
        desktopId,
        detail: "The selected user desktop is not known to this environment.",
      });
    }
    const connected = Array.from(current.clients.values()).some(
      (connection) =>
        connection.environmentId === environmentId &&
        connection.userDesktop?.desktopId === desktopId,
    );
    if (connected) {
      return yield* new UserDesktopManagementError({
        code: "user-desktop-online",
        desktopId,
        detail: "Disconnect this user desktop before removing it from the inventory.",
      });
    }
    yield* userDesktops.remove(desktopId);
  });

  const listUserDesktopAudit: PreviewAutomationBroker["Service"]["listUserDesktopAudit"] =
    Effect.fn("PreviewAutomationBroker.listUserDesktopAudit")((desktopId) =>
      userDesktops.listAudit(desktopId),
    );

  const respond: PreviewAutomationBroker["Service"]["respond"] = Effect.fn(
    "PreviewAutomationBroker.respond",
  )(function* (response) {
    const pending = yield* SynchronizedRef.modify(state, (current) => {
      const entry = current.pending.get(response.requestId);
      if (
        !entry ||
        entry.context.clientId !== response.clientId ||
        entry.context.connectionId !== response.connectionId
      ) {
        return [undefined, current] as const;
      }
      const next = new Map(current.pending);
      next.delete(response.requestId);
      return [entry, { ...current, pending: next }] as const;
    });
    if (!pending) return;
    if (response.ok) {
      yield* Deferred.succeed(pending.deferred, response.result);
    } else {
      yield* Deferred.fail(
        pending.deferred,
        response.error
          ? classifyResponseError(pending.context, response.error)
          : new PreviewAutomationMalformedResponseError(pending.context),
      );
    }
  });

  const invoke = Effect.fn("PreviewAutomationBroker.invoke")(function* <A = unknown>(
    input: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0],
  ): Effect.fn.Return<A, PreviewAutomationError> {
    const timeoutMs = input.timeoutMs ?? 15_000;
    const computerOperation = isComputerOperation(input.operation);
    const requestedDesktop = computerOperation
      ? requestedComputerDesktop(input.input)
      : { kind: undefined, desktopId: undefined };
    if (
      computerOperation &&
      (requestedDesktop.kind !== "user" || requestedDesktop.desktopId === undefined)
    ) {
      const missingDesktop = requestedDesktop.kind === undefined;
      const missingDesktopId = requestedDesktop.kind === "user";
      return yield* new PreviewAutomationDesktopTargetRequiredError({
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
        computerFailure: {
          code: "desktop-target-required",
          category: "invalid-input",
          message: missingDesktopId
            ? "A concrete user desktopId is required. Call user_desktop_list and select one result."
            : missingDesktop
              ? "An explicit desktop target is required."
              : "The client automation broker accepts only a user desktop.",
          field: missingDesktop
            ? "desktop"
            : missingDesktopId
              ? "desktop.desktopId"
              : "desktop.kind",
          received: missingDesktop
            ? "missing"
            : missingDesktopId
              ? "missing"
              : requestedDesktop.kind,
          expected: USER_DESKTOP_TARGETS,
          phase: "validation",
          cleanup: { keys: "not-needed", buttons: "not-needed" },
        },
      });
    }
    const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();
    const route = yield* SynchronizedRef.modify<BrokerState, HostRoute>(state, (current) => {
      if (
        computerOperation &&
        input.operation !== "computerInterrupt" &&
        (input.scope.controllerKind ?? "agent") === "agent" &&
        current.interruptedThreads.get(threadKey(input.scope)) === input.scope.controllerId
      ) {
        return [{ _tag: "interrupted" }, current] as const;
      }
      const assignments = new Map(
        Array.from(current.assignments).filter(([, assignment]) => {
          const connection = current.clients.get(assignment.clientId);
          return (
            connection?.connectionId === assignment.connectionId &&
            connection.queue === assignment.queue
          );
        }),
      );
      const environmentConnections = Array.from(current.clients.values()).filter(
        (host) => host.environmentId === input.scope.environmentId,
      );
      const assignmentKey = computerOperation
        ? undefined
        : hostAssignmentKey(input.scope, input.operation);
      const assigned = assignmentKey === undefined ? undefined : assignments.get(assignmentKey);
      const assignedConnection = assigned ? current.clients.get(assigned.clientId) : undefined;
      const hasLiveAssignment = assignedConnection?.environmentId === input.scope.environmentId;
      const targetConnections = computerOperation
        ? environmentConnections.filter(
            (connection) => connection.userDesktop?.desktopId === requestedDesktop.desktopId,
          )
        : [];
      // Browser operations retain their prior focused-host affinity. Computer
      // operations ignore focus and provider affinity and route only by desktopId.
      const connection = computerOperation
        ? targetConnections.length === 1 &&
          supportsOperation(targetConnections[0]!, input.operation)
          ? targetConnections[0]
          : undefined
        : hasLiveAssignment && supportsOperation(assignedConnection, input.operation)
          ? assignedConnection
          : hasLiveAssignment
            ? undefined
            : environmentConnections
                .filter((host) => supportsOperation(host, input.operation))
                .sort(
                  (left, right) =>
                    Number(right.focused) - Number(left.focused) ||
                    right.focusOrder - left.focusOrder ||
                    right.supportedOperations.size - left.supportedOperations.size,
                )[0];
      if (!connection) {
        if (assignmentKey !== undefined && !hasLiveAssignment) assignments.delete(assignmentKey);
        const unavailableRoute: HostRoute = {
          _tag: "unavailable",
          diagnostics: unavailableHostDiagnostics(
            environmentConnections,
            input.operation,
            computerOperation ? false : hasLiveAssignment,
            requestedDesktop.desktopId,
          ),
        };
        return [unavailableRoute, { ...current, assignments }] as const;
      }
      const canReuseAssignedTab =
        assigned !== undefined &&
        assigned.connectionId === connection.connectionId &&
        assigned.queue === connection.queue;
      if (assignmentKey !== undefined) {
        assignments.set(assignmentKey, {
          clientId: connection.clientId,
          connectionId: connection.connectionId,
          queue: connection.queue,
          ...(canReuseAssignedTab && assigned?.tabId !== undefined
            ? { tabId: assigned.tabId }
            : {}),
          ...(canReuseAssignedTab && assigned?.tabSequence !== undefined
            ? { tabSequence: assigned.tabSequence }
            : {}),
        });
      }

      const requestSequence = current.requestSequence;
      const requestId = `preview-${requestSequence}`;
      const tabId = input.tabId ?? (canReuseAssignedTab ? assigned?.tabId : undefined);
      const selectorDiagnostics = selectorDiagnosticsFromInput(input.input);
      const context: PreviewAutomationRequestErrorContext = {
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
        clientId: connection.clientId,
        connectionId: connection.connectionId,
        requestId,
        ...(tabId === undefined ? {} : { tabId }),
        timeoutMs,
        ...selectorDiagnostics,
      };
      const pending = new Map(current.pending);
      pending.set(requestId, {
        queue: connection.queue,
        deferred,
        context,
        ...(computerOperation
          ? {
              controllerId: input.scope.controllerId,
              controllerKind: input.scope.controllerKind ?? "agent",
            }
          : {}),
      });
      const routed: HostRoute = {
        _tag: "route",
        ...(assignmentKey === undefined ? {} : { assignmentKey }),
        connection,
        requestId,
        requestContext: context,
        requestSequence,
      };
      return [
        routed,
        { ...current, assignments, pending, requestSequence: current.requestSequence + 1 },
      ] as const;
    });
    if (route._tag === "interrupted") {
      if (!isComputerOperation(input.operation))
        return yield* Effect.die("interrupted non-computer request");
      return yield* threadInterruptedError(input.scope, input.operation);
    }
    if (route._tag === "unavailable") {
      const computerFailure = computerOperation
        ? unavailableComputerHostFailure({
            operation: input.operation,
            environmentId: input.scope.environmentId,
            diagnostics: route.diagnostics,
          })
        : undefined;
      return yield* new PreviewAutomationNoAvailableHostError({
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
        ...(computerFailure === undefined ? {} : { computerFailure }),
      });
    }
    const { assignmentKey, connection, requestId, requestContext, requestSequence } = route;
    const cancelPending = Effect.gen(function* () {
      const cancelled = yield* SynchronizedRef.modify(state, (next) => {
        const entry = next.pending.get(requestId);
        if (entry === undefined) return [false, next] as const;
        const pending = new Map(next.pending);
        pending.delete(requestId);
        return [true, { ...next, pending }] as const;
      });
      if (!cancelled) return;
      yield* Queue.offer(connection.queue, {
        type: "cancel",
        connectionId: connection.connectionId,
        requestId,
      }).pipe(Effect.ignore);
    });
    const awaitResponse = Effect.fn("PreviewAutomationBroker.awaitResponse")(function* () {
      const offered = yield* SynchronizedRef.modifyEffect(state, (current) => {
        // Publish before Stop can remove the request and enqueue its cancellation.
        if (!current.pending.has(requestId)) return Effect.succeed([null, current] as const);
        return Queue.offer(connection.queue, {
          type: "request",
          connectionId: connection.connectionId,
          request: {
            requestId,
            threadId: input.scope.threadId,
            ...(isComputerOperation(input.operation)
              ? {
                  controllerId: input.scope.controllerId,
                  controllerKind: input.scope.controllerKind ?? ("agent" as const),
                }
              : {}),
            tabId: requestContext.tabId,
            tabIdExplicit: input.tabId !== undefined,
            operation: input.operation,
            input: input.input,
            timeoutMs,
          },
        }).pipe(Effect.map((offered) => [offered, current] as const));
      });
      if (offered === false) {
        const completion = yield* Deferred.poll(deferred);
        if (Option.isSome(completion)) {
          return (yield* completion.value) as A;
        }
        return yield* new PreviewAutomationRequestQueueClosedError(requestContext);
      }
      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs));
      return yield* Option.match(result, {
        onNone: () => Effect.fail(new PreviewAutomationTimeoutError(requestContext)),
        onSome: (value) => Effect.succeed(value as A),
      });
    });
    const result = yield* awaitResponse().pipe(Effect.ensuring(cancelPending));
    const auditTransition = userDesktopAuditTransition(input.operation, input.input);
    if (requestedDesktop.desktopId !== undefined && auditTransition !== null) {
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      const actorKind =
        input.scope.controllerKind === "human" ? ("human" as const) : ("agent" as const);
      yield* userDesktops
        .recordAudit({
          desktopId: requestedDesktop.desktopId,
          occurredAt,
          actorKind,
          action: auditTransition.action,
          ...(actorKind === "agent"
            ? {
                threadId: input.scope.threadId,
                actorLabel: input.scope.providerInstanceId,
              }
            : {}),
          takeover: auditTransition.takeover,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("user desktop access audit persistence failed", { error }),
          ),
        );
    }
    if (assignmentKey === undefined) return result;
    const responseTabId = readResultTabId(result);
    const resultTabId = responseTabId === undefined ? input.tabId : responseTabId;
    if (resultTabId === undefined) return result;
    yield* SynchronizedRef.update(state, (current) => {
      const assignment = current.assignments.get(assignmentKey);
      if (
        !assignment ||
        assignment.connectionId !== connection.connectionId ||
        assignment.queue !== connection.queue ||
        (assignment.tabSequence ?? -1) > requestSequence
      ) {
        return current;
      }
      const assignments = new Map(current.assignments);
      if (resultTabId === null) {
        const { tabId: _tabId, ...withoutTabId } = assignment;
        assignments.set(assignmentKey, { ...withoutTabId, tabSequence: requestSequence });
      } else {
        assignments.set(assignmentKey, {
          ...assignment,
          ...(resultTabId === undefined ? {} : { tabId: resultTabId }),
          tabSequence: requestSequence,
        });
      }
      return { ...current, assignments };
    });
    return result;
  });

  const beginThreadInterruption: PreviewAutomationBroker["Service"]["beginThreadInterruption"] =
    Effect.fn("PreviewAutomationBroker.beginThreadInterruption")(function* (input) {
      const controllerId = yield* McpInvocationContext.threadComputerControllerId(
        input.environmentId,
        input.threadId,
      ).pipe(Effect.provideService(Crypto.Crypto, crypto));
      const interrupted = yield* SynchronizedRef.modify(state, (current) => {
        const pending = new Map(current.pending);
        const cancelled: PendingRequest[] = [];
        for (const [requestId, request] of pending) {
          if (
            request.context.environmentId !== input.environmentId ||
            request.context.threadId !== input.threadId ||
            request.controllerId !== controllerId ||
            request.controllerKind !== "agent" ||
            request.context.operation === "computerInterrupt"
          )
            continue;
          pending.delete(requestId);
          cancelled.push(request);
        }
        return [
          {
            cancelled,
            clients: Array.from(current.clients.values()).filter(
              (client) =>
                client.environmentId === input.environmentId && client.userDesktop !== undefined,
            ),
          },
          {
            ...current,
            pending,
            interruptedThreads: new Map(current.interruptedThreads).set(
              threadKey(input),
              controllerId,
            ),
          },
        ] as const;
      });
      for (const request of interrupted.cancelled) {
        if (!isComputerOperation(request.context.operation))
          return yield* Effect.die("cancelled non-computer request");
        yield* Deferred.fail(
          request.deferred,
          threadInterruptedError(request.context, request.context.operation),
        );
        const host = interrupted.clients.find((client) => client.queue === request.queue);
        if (host?.supportedOperations.has("computerInterrupt")) {
          yield* Queue.offer(request.queue, {
            type: "cancel",
            connectionId: request.context.connectionId,
            requestId: request.context.requestId,
            preserveDesktopAccess: true,
          }).pipe(Effect.ignore);
        }
      }
      const scope: McpInvocationContext.McpInvocationScope = {
        ...input,
        controllerId,
        providerSessionId: `thread-stop:${input.threadId}`,
        capabilities: new Set(["computer"]),
        issuedAt: DateTime.toEpochMillis(yield* DateTime.now),
      };
      const desktops = new Set(interrupted.clients.map((client) => client.userDesktop!.desktopId));
      return Effect.gen(function* () {
        const results = yield* Effect.forEach(
          desktops,
          (desktopId) =>
            invoke({
              scope,
              operation: "computerInterrupt",
              input: { desktop: { kind: "user", desktopId } },
              timeoutMs: THREAD_COMPUTER_INTERRUPTION_TIMEOUT_MS,
            }).pipe(Effect.asVoid, Effect.exit),
          { concurrency: "unbounded" },
        );
        // Attempt every host before reporting an unsupported, disconnected, or failed host.
        for (const result of results) if (Exit.isFailure(result)) return yield* result;
      });
    }, Effect.uninterruptible);

  const resumeThread: PreviewAutomationBroker["Service"]["resumeThread"] = Effect.fn(
    "PreviewAutomationBroker.resumeThread",
  )((input) =>
    SynchronizedRef.update(state, (current) => {
      if (!current.interruptedThreads.has(threadKey(input))) return current;
      const interruptedThreads = new Map(current.interruptedThreads);
      interruptedThreads.delete(threadKey(input));
      return { ...current, interruptedThreads };
    }),
  );

  return PreviewAutomationBroker.of({
    connect,
    focusHost,
    respond,
    invoke,
    beginThreadInterruption,
    resumeThread,
    listUserDesktops,
    renameUserDesktop,
    removeUserDesktop,
    listUserDesktopAudit,
  });
}).pipe(Effect.withSpan("PreviewAutomationBroker.make"));

export const layer = Layer.effect(PreviewAutomationBroker, make);

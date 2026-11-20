import {
  UserDesktopExecutionInput,
  UserDesktopTransferRequest,
  DESKTOP_TRANSFER_ROUTE_PREFIX,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { readPreparedConnection } from "~/state/session";
import { createDesktopAuthorizationSync } from "./desktopAuthorizationSync";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  COMPUTER_AUTOMATION_OPERATIONS,
  ComputerAutomationTargetInput,
  ComputerAutomationAvailabilityInput,
  type ComputerAutomationAccessInput,
  type ComputerAutomationActInput,
  type ComputerAutomationSnapshotInput,
  type EnvironmentId,
  type ComputerHostRequest,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { isElectron } from "~/env";
import { randomUUID } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { environmentSession } from "../../state/session";
import { computerEnvironment } from "~/state/computer";
import { useEnvironmentsWithScope } from "~/state/session";

import {
  PreviewAutomationComputerControllerRequiredError,
  resolveDesktopComputerAutomation,
} from "./computerAutomationErrors";
import { createComputerHostRequestConsumerAtom } from "./computerHostConsumer";

const decodeExecution = Schema.decodeUnknownSync(UserDesktopExecutionInput);
const decodeTransfer = Schema.decodeUnknownSync(UserDesktopTransferRequest);

async function handleComputerRequest(
  environmentId: EnvironmentId,
  request: ComputerHostRequest,
): Promise<unknown> {
  const computer = window.desktopBridge?.computer;
  if (computer === undefined)
    throw new Error("Computer automation is unavailable on this desktop.");
  if (request.controllerId === undefined) {
    throw new PreviewAutomationComputerControllerRequiredError({
      requestId: request.requestId,
      environmentId,
      threadId: request.threadId,
    });
  }
  const computerContext = {
    controllerId: request.controllerId,
    controllerKind: request.controllerKind ?? ("agent" as const),
    environmentId,
    threadId: request.threadId,
    ...(request.lifecycle === undefined ? {} : { lifecycle: request.lifecycle }),
    ...(request.connectionGeneration === undefined
      ? {}
      : { connectionGeneration: request.connectionGeneration }),
  };
  switch (request.operation) {
    case "computerExecution":
      return await resolveDesktopComputerAutomation(
        computer.execution?.(decodeExecution(request.input), computerContext),
      );
    case "computerTransfer": {
      const input = decodeTransfer(request.input);
      if (input.operation === "cancel")
        return await resolveDesktopComputerAutomation(computer.transfer?.(input, computerContext));
      const connection = readPreparedConnection(environmentId);
      if (!connection || input.url !== DESKTOP_TRANSFER_ROUTE_PREFIX + "/" + input.transferId)
        throw new Error("Invalid environment transfer route.");
      return await resolveDesktopComputerAutomation(
        computer.transfer?.(
          { ...input, url: new URL(input.url, connection.httpBaseUrl).toString() },
          computerContext,
        ),
      );
    }
    case "computerStatus":
      return await resolveDesktopComputerAutomation(
        computer?.status(request.input as ComputerAutomationTargetInput, computerContext),
      );
    case "computerRequestAvailability":
      return await resolveDesktopComputerAutomation(
        computer?.requestAvailability(
          request.input as ComputerAutomationAvailabilityInput,
          computerContext,
        ),
      );
    case "computerReleaseAvailability":
      return await resolveDesktopComputerAutomation(
        computer?.releaseAvailability(
          request.input as ComputerAutomationAvailabilityInput,
          computerContext,
        ),
      );
    case "computerRequestView":
      return await resolveDesktopComputerAutomation(
        computer?.requestView(request.input as ComputerAutomationAccessInput, computerContext),
      );
    case "computerRequestControl":
      return await resolveDesktopComputerAutomation(
        computer?.requestControl(request.input as ComputerAutomationAccessInput, computerContext),
      );
    case "computerRememberView":
      return await resolveDesktopComputerAutomation(
        computer?.rememberView(request.input as ComputerAutomationAccessInput, computerContext),
      );
    case "computerRememberControl":
      return await resolveDesktopComputerAutomation(
        computer?.rememberControl(request.input as ComputerAutomationAccessInput, computerContext),
      );
    case "computerInterrupt":
      return await resolveDesktopComputerAutomation(
        computer?.interrupt?.(request.input as ComputerAutomationTargetInput, computerContext),
      );
    case "computerForceRelease":
      return await resolveDesktopComputerAutomation(
        computer?.forceRelease(request.input as ComputerAutomationTargetInput, computerContext),
      );
    case "computerForceForgetControl":
      return await resolveDesktopComputerAutomation(
        computer?.forceForgetControl(
          request.input as ComputerAutomationTargetInput,
          computerContext,
        ),
      );
    case "computerSnapshot":
      return await resolveDesktopComputerAutomation(
        computer?.snapshot(request.input as ComputerAutomationSnapshotInput, computerContext),
      );
    case "computerAct":
      return await resolveDesktopComputerAutomation(
        computer?.act(request.input as ComputerAutomationActInput, computerContext),
      );
    case "computerRelease":
      return await resolveDesktopComputerAutomation(
        computer?.release(request.input as ComputerAutomationTargetInput, computerContext),
      );
    case "computerForgetControl":
      return await resolveDesktopComputerAutomation(
        computer?.forgetControl(request.input as ComputerAutomationTargetInput, computerContext),
      );
  }
  throw new Error("This desktop host only supports user desktop automation.");
}

async function cancelComputerRequest(environmentId: EnvironmentId, request: ComputerHostRequest) {
  const computer = window.desktopBridge?.computer;
  if (request.controllerId === undefined) return;
  const context = {
    controllerId: request.controllerId,
    controllerKind: request.controllerKind ?? ("agent" as const),
    environmentId,
    threadId: request.threadId,
    ...(request.connectionGeneration === undefined
      ? {}
      : { connectionGeneration: request.connectionGeneration }),
  };
  if (computer === undefined) return;
  if (
    (request.operation === "computerRequestView" ||
      request.operation === "computerRequestControl") &&
    (request.input as ComputerAutomationAccessInput).acquireLease === false
  ) {
    await computer.cancelPreparation?.(context);
    return;
  }
  switch (request.operation) {
    case "computerTransfer": {
      const input = decodeTransfer(request.input);
      if (input.operation === "run")
        await computer.transfer?.(
          { operation: "cancel", desktop: input.desktop, transferId: input.transferId },
          context,
        );
      return;
    }
    case "computerExecution": {
      const input = decodeExecution(request.input);
      if (
        input.operation === "access" &&
        (input.input.action === "request" || input.input.action === "edit")
      )
        await computer.execution?.({ operation: "cancel", desktop: input.desktop }, context);
      return;
    }
    case "computerRequestAvailability":
      await computer.releaseAvailability(
        request.input as ComputerAutomationAvailabilityInput,
        context,
      );
      return;
    case "computerRequestView":
    case "computerRequestControl":
    case "computerRememberView":
    case "computerRememberControl":
    case "computerSnapshot":
    case "computerAct":
      await computer.release(request.input as ComputerAutomationTargetInput, context);
      return;
  }
}

const computerHostAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const userDesktop = window.desktopBridge?.getUserDesktopHost?.();
    const hostId = get(environmentSession.sessionStateValueAtom(environmentId))?.userDesktopHostId;
    if (userDesktop === undefined || userDesktop.desktopId !== hostId) return;
    const clientId = randomUUID();
    const requestsAtom = computerEnvironment.automationRequests({
      environmentId,
      input: {
        clientId,
        environmentId,
        ...(window.desktopBridge?.authorization === undefined
          ? {}
          : { authorizationVersion: 2 as const }),
        userDesktop,
        ...(window.desktopBridge?.computer?.cancelPreparation
          ? { supportsPermissionPreparation: true as const }
          : {}),
        supportedOperations: [...COMPUTER_AUTOMATION_OPERATIONS],
      },
    });
    const connectionAtom = Atom.make<string | null>(null);
    const authorization = createDesktopAuthorizationSync({
      environmentId,
      clientId,
      focused: () => document.hasFocus() && document.visibilityState === "visible",
      authorize: async (input) =>
        window.desktopBridge?.authorization === undefined
          ? undefined
          : resolveDesktopComputerAutomation(window.desktopBridge.authorization(input)),
      report: async (input) => {
        const result = await runAtomCommand(
          get.registry,
          computerEnvironment.focusAutomationHost,
          { environmentId, input },
          { reportFailure: false },
        );
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
    });
    const unsubscribeAuthorization = window.desktopBridge?.onDesktopAuthorizationChanged?.(
      (source) => {
        if (source === environmentId) void authorization.flush();
      },
    );
    get.subscribe(connectionAtom, (generation) => authorization.connect(generation));
    get.addFinalizer(() => {
      unsubscribeAuthorization?.();
      authorization.dispose();
    });
    let lastFocusReport: string | null = null;
    const reportFocus = () => {
      const connectionId = get.once(connectionAtom);
      if (connectionId === null) {
        lastFocusReport = null;
        return;
      }
      const input = {
        clientId,
        environmentId,
        connectionId,
        focused: document.hasFocus() && document.visibilityState === "visible",
        liveTabs: [],
      };
      const key = JSON.stringify(input);
      if (key === lastFocusReport) return;
      lastFocusReport = key;
      void runAtomCommand(
        get.registry,
        computerEnvironment.focusAutomationHost,
        { environmentId, input },
        { reportFailure: false },
      ).then((result) => {
        if (result._tag === "Failure" && lastFocusReport === key) lastFocusReport = null;
      });
    };
    window.addEventListener("focus", reportFocus);
    window.addEventListener("blur", reportFocus);
    document.addEventListener("visibilitychange", reportFocus);
    get.addFinalizer(() => {
      window.removeEventListener("focus", reportFocus);
      window.removeEventListener("blur", reportFocus);
      document.removeEventListener("visibilitychange", reportFocus);
    });
    get.subscribe(connectionAtom, reportFocus);
    get.mount(
      createComputerHostRequestConsumerAtom({
        requestsAtom,
        clientId,
        connectionAtom,
        environmentId,
        requestHandlerAtom: Atom.make({
          handle: async (request: ComputerHostRequest, signal: AbortSignal) => {
            signal.throwIfAborted();
            const generation = request.connectionGeneration;
            if (generation !== undefined && window.desktopBridge?.authorization !== undefined) {
              await resolveDesktopComputerAutomation(
                window.desktopBridge.authorization({
                  operation: "connected",
                  environmentId,
                  connectionGeneration: generation,
                }),
              );
            }
            signal.throwIfAborted();
            const running = handleComputerRequest(environmentId, request);
            try {
              return await running;
            } finally {
              if (generation !== undefined)
                void authorization.refresh(generation).catch(() => authorization.flush());
            }
          },
          cancel: (request: ComputerHostRequest) => cancelComputerRequest(environmentId, request),
        }),
        respond: (input) =>
          runAtomCommand(
            get.registry,
            computerEnvironment.respondToAutomation,
            { environmentId, input },
            { reportFailure: false },
          ),
        lifecycle: authorization.lifecycle,
        label: `computer-requests:${environmentId}`,
      }),
    );
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`computer-host:${environmentId}`)),
);

export function ComputerAutomationHosts() {
  const { environments } = useEnvironments();
  const operable = useEnvironmentsWithScope(environments, AuthPreviewOperateScope);
  if (!isElectron || !window.desktopBridge?.computer) return null;
  return (
    <>
      {Array.from(operable).map((environmentId) => (
        <ComputerAutomationHost key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

function ComputerAutomationHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  useAtomValue(computerHostAtom(environmentId));
  return null;
}

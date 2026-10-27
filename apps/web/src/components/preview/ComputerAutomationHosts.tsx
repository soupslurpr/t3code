import { createDesktopAuthorizationSync } from "./desktopAuthorizationSync";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  ComputerAutomationTargetInput,
  ComputerAutomationAvailabilityInput,
  type ComputerAutomationAccessInput,
  type ComputerAutomationActInput,
  type ComputerAutomationSnapshotInput,
  type EnvironmentId,
  type UserDesktopExecutionInput,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { isElectron } from "~/env";
import { randomUUID } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { readPreparedConnection } from "../../state/session";
import type { UserDesktopTransferRequest } from "@t3tools/contracts";
import { serverEnvironment } from "~/state/server";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentsWithScope } from "~/state/session";

import {
  PreviewAutomationComputerControllerRequiredError,
  resolveDesktopComputerAutomation,
} from "./previewAutomationErrors";
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";
import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

async function handleComputerRequest(
  environmentId: EnvironmentId,
  request: PreviewAutomationRequest,
): Promise<unknown> {
  const computer = window.desktopBridge?.computer;
  if (
    computer === undefined &&
    request.operation !== "computerExecution" &&
    request.operation !== "computerTransfer"
  )
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
    case "computerTransfer": {
      const input = request.input as UserDesktopTransferRequest;
      const connection = readPreparedConnection(environmentId);
      if (connection === null) throw new Error("The transfer environment is disconnected.");
      return await resolveDesktopComputerAutomation(
        window.desktopBridge?.transfer?.(
          input.operation === "run"
            ? { ...input, url: new URL(input.url, connection.httpBaseUrl).toString() }
            : input,
          computerContext,
        ),
      );
    }
    case "computerExecution":
      return await resolveDesktopComputerAutomation(
        window.desktopBridge?.execution?.(
          request.input as UserDesktopExecutionInput,
          computerContext,
        ),
      );
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

async function cancelComputerRequest(
  environmentId: EnvironmentId,
  request: PreviewAutomationRequest,
) {
  const computer = window.desktopBridge?.computer;
  if (request.controllerId === undefined) return;
  const context = {
    controllerId: request.controllerId,
    controllerKind: request.controllerKind ?? ("agent" as const),
    environmentId,
    threadId: request.threadId,
  };
  if (request.operation === "computerTransfer") {
    const input = request.input as UserDesktopTransferRequest;
    await window.desktopBridge?.transfer?.(
      { operation: "cancel", desktop: input.desktop, transferId: input.transferId },
      context,
    );
    return;
  }
  if (request.operation === "computerExecution") {
    const input = request.input as UserDesktopExecutionInput;
    if (
      input.operation === "access" &&
      (input.input.action === "request" || input.input.action === "edit")
    ) {
      await window.desktopBridge?.execution?.(
        { operation: "cancel", desktop: input.desktop },
        context,
      );
    }
    return;
  }
  if (computer === undefined) return;
  switch (request.operation) {
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
    const clientId = randomUUID();
    const userDesktop = window.desktopBridge?.getUserDesktopHost?.();
    const serverConfig = get(serverEnvironment.configValueAtom(environmentId));
    const executionAvailable =
      window.desktopBridge?.execution !== undefined &&
      serverConfig?.environment.capabilities.userDesktopExecution === true;
    const transferAvailable =
      executionAvailable &&
      window.desktopBridge?.transfer !== undefined &&
      serverConfig?.environment.capabilities.userDesktopTransfers === true;
    const requestsAtom = previewEnvironment.automationRequests({
      environmentId,
      input: {
        clientId,
        environmentId,
        ...(window.desktopBridge?.authorization === undefined
          ? {}
          : { authorizationVersion: 2 as const }),
        ...previewAutomationHostCapabilities({
          executionAvailable,
          transferAvailable,
          ...(userDesktop === undefined ? {} : { userDesktop }),
          computerAvailable: window.desktopBridge?.computer !== undefined,
          computerInterruptAvailable:
            typeof window.desktopBridge?.computer?.interrupt === "function",
          computerCapabilities: userDesktop?.capabilities ?? [],
        }),
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
          previewEnvironment.focusAutomationHost,
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
        previewEnvironment.focusAutomationHost,
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
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom,
        clientId,
        connectionAtom,
        environmentId,
        requestHandlerAtom: Atom.make({
          handle: async (request: PreviewAutomationRequest, signal: AbortSignal) => {
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
            if (generation !== undefined && request.operation === "computerExecution")
              void authorization.refresh(generation).catch(() => authorization.flush());
            try {
              return await running;
            } finally {
              if (generation !== undefined)
                void authorization.refresh(generation).catch(() => authorization.flush());
            }
          },
          cancel: (request: PreviewAutomationRequest) =>
            cancelComputerRequest(environmentId, request),
        }),
        respond: (input) =>
          runAtomCommand(
            get.registry,
            previewEnvironment.respondToAutomation,
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
  if (!isElectron || (!window.desktopBridge?.computer && !window.desktopBridge?.execution))
    return null;
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

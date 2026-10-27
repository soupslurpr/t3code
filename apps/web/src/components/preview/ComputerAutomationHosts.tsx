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
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { isElectron } from "~/env";
import { randomUUID } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
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
  };
  switch (request.operation) {
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
        computer.rememberView(request.input as ComputerAutomationAccessInput, computerContext),
      );
    case "computerRememberControl":
      return await resolveDesktopComputerAutomation(
        computer.rememberControl(request.input as ComputerAutomationAccessInput, computerContext),
      );
    case "computerInterrupt":
      return await resolveDesktopComputerAutomation(
        computer.interrupt?.(request.input as ComputerAutomationTargetInput, computerContext),
      );
    case "computerForceRelease":
      return await resolveDesktopComputerAutomation(
        computer.forceRelease(request.input as ComputerAutomationTargetInput, computerContext),
      );
    case "computerForceForgetControl":
      return await resolveDesktopComputerAutomation(
        computer.forceForgetControl(
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
  if (computer === undefined || request.controllerId === undefined) return;
  const context = {
    controllerId: request.controllerId,
    controllerKind: request.controllerKind ?? ("agent" as const),
    environmentId,
    threadId: request.threadId,
  };
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
    const requestsAtom = previewEnvironment.automationRequests({
      environmentId,
      input: {
        clientId,
        environmentId,
        ...(userDesktop === undefined ? {} : { userDesktop }),
        ...previewAutomationHostCapabilities({
          computerAvailable: window.desktopBridge?.computer !== undefined,
          computerInterruptAvailable:
            typeof window.desktopBridge?.computer?.interrupt === "function",
          computerCapabilities: userDesktop?.capabilities ?? [],
        }),
      },
    });
    const connectionAtom = Atom.make<string | null>(null);
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
          handle: (request: PreviewAutomationRequest) =>
            handleComputerRequest(environmentId, request),
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
        label: `computer-requests:${environmentId}`,
      }),
    );
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`computer-host:${environmentId}`)),
);

export function ComputerAutomationHosts() {
  const { environments } = useEnvironments();
  const operable = useEnvironmentsWithScope(environments, AuthPreviewOperateScope);
  if (!isElectron || window.desktopBridge?.computer === undefined) return null;
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

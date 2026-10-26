import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  type ComputerAutomationAccessInput,
  type ComputerAutomationActInput,
  type ComputerAutomationSnapshotInput,
  type EnvironmentId,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { isElectron } from "~/env";
import { randomUUID } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentsWithScope } from "~/state/session";

import {
  resolveDesktopComputerAutomation,
  serializeComputerAutomationError,
} from "./previewAutomationErrors";
import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";

async function handleComputerRequest(request: PreviewAutomationRequest): Promise<unknown> {
  const computer = window.desktopBridge?.computer;
  if (computer === undefined)
    throw new Error("Computer automation is unavailable on this desktop.");
  switch (request.operation) {
    case "computerStatus":
      return computer.status();
    case "computerRequestAvailability":
      return resolveDesktopComputerAutomation(computer.requestAvailability());
    case "computerReleaseAvailability":
      return resolveDesktopComputerAutomation(computer.releaseAvailability());
    case "computerRequestView":
      return resolveDesktopComputerAutomation(
        computer.requestView(request.input as ComputerAutomationAccessInput),
      );
    case "computerRequestControl":
      return resolveDesktopComputerAutomation(
        computer.requestControl(request.input as ComputerAutomationAccessInput),
      );
    case "computerSnapshot":
      return resolveDesktopComputerAutomation(
        computer.snapshot(request.input as ComputerAutomationSnapshotInput),
      );
    case "computerAct":
      return resolveDesktopComputerAutomation(
        computer.act(request.input as ComputerAutomationActInput),
      );
    case "computerRelease":
      return resolveDesktopComputerAutomation(computer.release());
    case "computerForgetControl":
      return resolveDesktopComputerAutomation(computer.forgetControl());
    default:
      throw new Error("This desktop host only supports computer automation.");
  }
}

const computerHostAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const clientId = randomUUID();
    const requestsAtom = previewEnvironment.automationRequests({
      environmentId,
      input: {
        clientId,
        environmentId,
        ...previewAutomationHostCapabilities({ computerAvailable: true }),
      },
    });
    let disposed = false;
    let connectionId: string | null = null;
    let lastFocusReport: string | null = null;
    const reportFocus = () => {
      if (connectionId === null) return;
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
      disposed = true;
      window.removeEventListener("focus", reportFocus);
      window.removeEventListener("blur", reportFocus);
      document.removeEventListener("visibilitychange", reportFocus);
    });
    get.subscribe(requestsAtom, (result) => {
      if (AsyncResult.isFailure(result)) {
        connectionId = null;
        lastFocusReport = null;
        return;
      }
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "connected") {
        connectionId = event.connectionId;
        reportFocus();
        return;
      }
      if (event.connectionId !== connectionId) return;
      const answer = (
        outcome:
          | { ok: true; result: unknown }
          | { ok: false; error: NonNullable<PreviewAutomationResponse["error"]> },
      ) => {
        if (disposed || connectionId !== event.connectionId) return;
        return runAtomCommand(
          get.registry,
          previewEnvironment.respondToAutomation,
          {
            environmentId,
            input: {
              clientId,
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ...outcome,
            },
          },
          { reportFailure: false },
        );
      };
      void handleComputerRequest(event.request).then(
        (value) => answer({ ok: true, result: value }),
        (error: unknown) => answer({ ok: false, error: serializeComputerAutomationError(error) }),
      );
    });
    get.mount(requestsAtom);
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

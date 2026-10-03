"use client";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  ComputerAutomationAccessInput,
  ComputerAutomationActInput,
  ComputerAutomationAvailabilityInput,
  ComputerAutomationSnapshotInput,
  ComputerAutomationTargetInput,
  EnvironmentId,
  PreviewAutomationHost as PreviewAutomationHostState,
  PreviewAutomationRequest,
  UserDesktopExecutionInput,
  UserDesktopTransferRequest,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "~/env";
import { randomUUID } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  PreviewAutomationComputerControllerRequiredError,
  resolveDesktopComputerAutomation,
} from "./previewAutomationErrors";
import { previewAutomationHostCapabilities } from "./previewAutomationHostCapabilities";
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";

/** Registers this desktop's computer capabilities independently of the server's browser. */
export function ComputerAutomationHosts() {
  const { environments } = useEnvironments();
  if (!isElectron || (!window.desktopBridge?.computer && !window.desktopBridge?.execution))
    return null;
  return (
    <>
      {environments.map((environment) => (
        <ComputerAutomationHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}

function ComputerAutomationHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const lastFocusReportRef = useRef<string | null>(null);
  const [automationClientId] = useState(randomUUID);
  const [userDesktop] = useState(() => window.desktopBridge?.getUserDesktopHost?.());
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const executionAvailable =
    window.desktopBridge?.execution !== undefined &&
    serverConfig?.environment.capabilities.userDesktopExecution === true;
  const transferAvailable =
    executionAvailable &&
    window.desktopBridge?.transfer !== undefined &&
    serverConfig?.environment.capabilities.userDesktopTransfers === true;
  const initialAutomationHost = useMemo<PreviewAutomationHostState>(
    () => ({
      clientId: automationClientId,
      environmentId,
      ...previewAutomationHostCapabilities({
        computerAvailable: window.desktopBridge?.computer !== undefined,
        executionAvailable,
        transferAvailable,
        computerCapabilities: userDesktop?.capabilities ?? [],
        ...(userDesktop === undefined ? {} : { userDesktop }),
        computerInterruptAvailable: typeof window.desktopBridge?.computer?.interrupt === "function",
      }),
    }),
    [automationClientId, environmentId, userDesktop, executionAvailable, transferAvailable],
  );
  const automationRequestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: initialAutomationHost,
  });
  const respondToAutomation = useAtomCommand(
    previewEnvironment.respondToAutomation,
    "computer automation response",
  );
  const focusAutomationHost = useAtomCommand(
    previewEnvironment.focusAutomationHost,
    "computer automation host focus",
  );
  const [automationConnectionAtom] = useState(() => Atom.make<string | null>(null));
  const automationConnectionId = useAtomValue(automationConnectionAtom);
  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest, _signal: AbortSignal): Promise<unknown> => {
      const computer = window.desktopBridge?.computer;
      const computerContext =
        request.controllerId === undefined
          ? null
          : {
              controllerId: request.controllerId,
              controllerKind: request.controllerKind ?? ("agent" as const),
              environmentId,
              threadId: request.threadId,
            };
      const requireComputerContext = () => {
        if (computerContext !== null) return computerContext;
        throw new PreviewAutomationComputerControllerRequiredError({
          requestId: request.requestId,
          environmentId,
          threadId: request.threadId,
        });
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
              requireComputerContext(),
            ),
          );
        }
        case "computerExecution":
          return await resolveDesktopComputerAutomation(
            window.desktopBridge?.execution?.(
              request.input as UserDesktopExecutionInput,
              requireComputerContext(),
            ),
          );
        case "computerStatus":
          return await resolveDesktopComputerAutomation(
            computer?.status(
              request.input as ComputerAutomationTargetInput,
              requireComputerContext(),
            ),
          );
        case "computerRequestAvailability":
          return await resolveDesktopComputerAutomation(
            computer?.requestAvailability(
              request.input as ComputerAutomationAvailabilityInput,
              requireComputerContext(),
            ),
          );
        case "computerReleaseAvailability":
          return await resolveDesktopComputerAutomation(
            computer?.releaseAvailability(
              request.input as ComputerAutomationAvailabilityInput,
              requireComputerContext(),
            ),
          );
        case "computerRequestView":
          return await resolveDesktopComputerAutomation(
            computer?.requestView(
              request.input as ComputerAutomationAccessInput,
              requireComputerContext(),
            ),
          );
        case "computerRequestControl":
          return await resolveDesktopComputerAutomation(
            computer?.requestControl(
              request.input as ComputerAutomationAccessInput,
              requireComputerContext(),
            ),
          );
        case "computerRememberView":
          return await resolveDesktopComputerAutomation(
            computer?.rememberView(
              request.input as ComputerAutomationAccessInput,
              requireComputerContext(),
            ),
          );
        case "computerRememberControl":
          return await resolveDesktopComputerAutomation(
            computer?.rememberControl(
              request.input as ComputerAutomationAccessInput,
              requireComputerContext(),
            ),
          );
        case "computerInterrupt":
          return await resolveDesktopComputerAutomation(
            computer?.interrupt?.(
              request.input as ComputerAutomationTargetInput,
              requireComputerContext(),
            ),
          );
        case "computerForceRelease":
          return await resolveDesktopComputerAutomation(
            computer?.forceRelease(
              request.input as ComputerAutomationTargetInput,
              requireComputerContext(),
            ),
          );
        case "computerForceForgetControl":
          return await resolveDesktopComputerAutomation(
            computer?.forceForgetControl(
              request.input as ComputerAutomationTargetInput,
              requireComputerContext(),
            ),
          );
        case "computerSnapshot":
          return await resolveDesktopComputerAutomation(
            computer?.snapshot(
              request.input as ComputerAutomationSnapshotInput,
              requireComputerContext(),
            ),
          );
        case "computerAct":
          return await resolveDesktopComputerAutomation(
            computer?.act(request.input as ComputerAutomationActInput, requireComputerContext()),
          );
        case "computerRelease":
          return await resolveDesktopComputerAutomation(
            computer?.release(
              request.input as ComputerAutomationTargetInput,
              requireComputerContext(),
            ),
          );
        case "computerForgetControl":
          return await resolveDesktopComputerAutomation(
            computer?.forgetControl(
              request.input as ComputerAutomationTargetInput,
              requireComputerContext(),
            ),
          );
      }
      throw new Error("This desktop host only supports computer automation.");
    },
    [environmentId],
  );
  const cancelRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<void> => {
      if (request.operation === "computerTransfer" && request.controllerId !== undefined) {
        const input = request.input as UserDesktopTransferRequest;
        await window.desktopBridge?.transfer?.(
          { operation: "cancel", desktop: input.desktop, transferId: input.transferId },
          {
            controllerId: request.controllerId,
            controllerKind: request.controllerKind ?? "agent",
            environmentId,
            threadId: request.threadId,
          },
        );
        return;
      }
      if (request.operation === "computerExecution" && request.controllerId !== undefined) {
        const input = request.input as UserDesktopExecutionInput;
        if (input.operation === "access" && input.input.action === "request") {
          await window.desktopBridge?.execution?.(
            { operation: "cancel", desktop: input.desktop },
            {
              controllerId: request.controllerId,
              controllerKind: request.controllerKind ?? "agent",
              environmentId,
              threadId: request.threadId,
            },
          );
        }
        return;
      }
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
    },
    [environmentId],
  );
  const [requestHandlerAtom] = useState(() =>
    Atom.make({ handle: handleRequest, cancel: cancelRequest }),
  );
  const setRequestHandler = useAtomSet(requestHandlerAtom);
  useEffect(() => {
    setRequestHandler({ handle: handleRequest, cancel: cancelRequest });
  }, [cancelRequest, handleRequest, setRequestHandler]);

  const automationRequestConsumerAtom = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom: automationRequestsAtom,
        clientId: automationClientId,
        connectionAtom: automationConnectionAtom,
        environmentId,
        requestHandlerAtom,
        respond: (response) =>
          respondToAutomation({
            environmentId,
            input: response,
          }),
        label: `preview:automation-host:${environmentId}:${automationClientId}`,
      }),
    [
      automationClientId,
      automationConnectionAtom,
      automationRequestsAtom,
      requestHandlerAtom,
      respondToAutomation,
      environmentId,
    ],
  );
  useAtomValue(automationRequestConsumerAtom);

  useEffect(() => {
    const report = () => {
      if (!automationConnectionId) return;
      const input = {
        clientId: automationClientId,
        environmentId,
        connectionId: automationConnectionId,
        focused: document.hasFocus() && document.visibilityState === "visible",
        liveTabs: [],
      };
      const reportKey = JSON.stringify(input);
      if (lastFocusReportRef.current === reportKey) return;
      lastFocusReportRef.current = reportKey;
      void focusAutomationHost({ environmentId, input }).then((result) => {
        if (result._tag === "Failure" && lastFocusReportRef.current === reportKey) {
          lastFocusReportRef.current = null;
        }
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      document.removeEventListener("visibilitychange", report);
    };
  }, [automationClientId, automationConnectionId, environmentId, focusAutomationHost]);

  return null;
}

import {
  mountUserDesktopSupervision,
  readUserDesktopSupervision,
  requestUserDesktopLive,
  retainUnchangedImage,
} from "./userDesktopSupervision";
import { useThreadShells } from "~/state/entities";
import { Dialog } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ComputerDesktopViewer } from "./AgentDesktopSettings";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ComputerAutomationAction,
  ComputerAutomationLeaseId,
  ComputerAutomationSnapshot,
  ComputerObservation,
  ComputerObservationId,
  ComputerObservationList,
  ComputerObservationSummary,
  ComputerObservationUpdate,
  ComputerAutomationStatus,
  EnvironmentId,
  UserDesktopHumanInvokeInput,
  UserDesktopAuditAction,
  UserDesktopView,
} from "@t3tools/contracts";
import {
  EyeIcon,
  HandIcon,
  HistoryIcon,
  Undo2Icon,
  KeyboardIcon,
  MonitorIcon,
  PencilIcon,
  RefreshCwIcon,
  ShieldOffIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentsWithScope } from "~/state/session";
import { useStableCallback } from "~/hooks/useStableCallback";
import { userDesktopListingAtom, userDesktopAuditAtom } from "./userDesktopListing";
import {
  groupEntries,
  type UserDesktopGroup,
  type UserDesktopEntry,
} from "./userDesktopListingState";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const ACCESS_REQUEST_TIMEOUT_MS = 120_000;
const VIEWER_MAX_WIDTH = 1_280;
const VIEWER_MAX_HEIGHT = 720;

interface PendingRequest {
  readonly environmentId: EnvironmentId;
  readonly desktopId: string;
  readonly label: string;
  readonly operation: "remember-view" | "remember-control" | "end-all-access" | "forget";
}

interface UserDesktopViewer {
  readonly generation: number;
  readonly group: UserDesktopGroup;
  readonly entry: UserDesktopEntry;
  readonly status: ComputerAutomationStatus;
  readonly liveStarted: boolean;
  readonly observation: ComputerAutomationSnapshot | null;
  readonly observationList: ComputerObservationList["observations"];
  readonly selectedObservationId: ComputerObservationId | null;
  readonly agentObservation: ComputerObservation | null;
  readonly selectedDisplayId: string | null;
}

interface TakeoverConfirmation {
  readonly leaseId: ComputerAutomationLeaseId;
  readonly desktopLabel: string;
  readonly controllerKind: "agent" | "human" | "local";
  readonly sameEnvironment: boolean;
  readonly resolve: (confirmed: boolean) => void;
}

/** Converts an RPC failure into bounded user-facing prose. */
function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "User desktop request failed.";
}

/** Formats one durable inventory connection state. */
function connectionLabel(state: UserDesktopView["connectionState"]): string {
  if (state === "identity-conflict") return "Identity conflict";
  return state === "online" ? "Online" : "Offline";
}

/** Formats one bounded host platform for Settings. */
function platformLabel(platform: UserDesktopView["platform"]): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  return "Unknown platform";
}

/** Formats one durable access transition for the User desktop card. */
function auditActionLabel(action: UserDesktopAuditAction): string {
  switch (action) {
    case "view-granted":
      return "Started viewing";
    case "control-granted":
      return "Took control";
    case "control-released":
      return "Released control";
    case "control-returned-to-agent":
      return "Returned control to agent";
    case "access-released":
      return "Ended own access";
    case "all-access-ended":
      return "Ended all access";
    case "view-remembered":
      return "Remembered view approval";
    case "control-remembered":
      return "Remembered control approval";
    case "approval-forgotten":
      return "Forgot approval";
  }
}

/** Labels one retained model-facing observation for the Agent lens selector. */
function observationSummaryLabel(
  observation: ComputerObservationSummary,
  environmentLabel: string,
  threadTitle: string,
): string {
  const recipient =
    observation.recipient.kind === "controller"
      ? observation.recipient.instanceId
      : observation.recipient.modelSelection.model;
  return `${recipient} · ${threadTitle} · ${environmentLabel} · ${observation.source.replaceAll("-", " ")} · ${formatRelativeTimeLabel(observation.observedAt)}`;
}

/** Lists and manages the concrete user desktops exposed to one environment. */
export function UserDesktopSettings() {
  const { environments, isReady: environmentsReady } = useEnvironments();
  const threads = useThreadShells();
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const listingAtom = userDesktopListingAtom(JSON.stringify(Array.from(operable).sort()));
  const listing = useAtomValue(listingAtom);
  const entries = AsyncResult.isSuccess(listing) ? listing.value.entries : [];
  const auditAtom = userDesktopAuditAtom(
    JSON.stringify(
      entries
        .map((entry) => ({
          environmentId: entry.environmentId,
          desktopId: entry.desktop.desktop.desktopId,
        }))
        .sort(
          (a, b) =>
            a.environmentId.localeCompare(b.environmentId) ||
            a.desktopId.localeCompare(b.desktopId),
        ),
    ),
  );
  const audit = useAtomValue(auditAtom);
  const incompatibleClientCount = AsyncResult.isSuccess(listing)
    ? listing.value.incompatibleClientCount
    : 0;
  const loading = !environmentsReady || AsyncResult.isInitial(listing) || listing.waiting;
  const listingError = AsyncResult.isSuccess(listing) ? listing.value.error : null;
  const invoke = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, {
    reportFailure: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [removeGroup, setRemoveGroup] = useState<UserDesktopGroup | null>(null);

  const [viewer, setViewerState] = useState<UserDesktopViewer | null>(null);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [takeoverConfirmation, setTakeoverConfirmation] = useState<TakeoverConfirmation | null>(
    null,
  );
  const [localDesktopId] = useState(
    () => window.desktopBridge?.getUserDesktopHost?.().desktopId ?? null,
  );
  const viewerRef = useRef(viewer);
  const viewerActionQueue = useRef<Promise<void>>(Promise.resolve());
  const confirmedTakeoverLeaseId = useRef<ComputerAutomationLeaseId | null>(null);
  const takeoverConfirmationRef = useRef<TakeoverConfirmation | null>(null);

  const viewerGeneration = useRef(0);
  const viewerCleanup = useRef<(() => void) | null>(null);
  const setViewer = (
    next:
      | UserDesktopViewer
      | null
      | ((current: UserDesktopViewer | null) => UserDesktopViewer | null),
  ) => {
    const value = typeof next === "function" ? next(viewerRef.current) : next;
    viewerRef.current = value;
    setViewerState(value);
  };

  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const desktopGroups = groupEntries(entries, AsyncResult.isSuccess(audit) ? audit.value : []);

  const run = async <Value,>(environmentId: EnvironmentId, input: UserDesktopHumanInvokeInput) => {
    const result = await invoke({ environmentId, input });
    if (result._tag === "Success") return result.value as Value;
    throw squashAtomCommandFailure(result);
  };

  const refresh = useStableCallback(() => {
    appAtomRegistry.refresh(listingAtom);
    appAtomRegistry.refresh(auditAtom);
  });

  const performAccessAction = async (
    group: UserDesktopGroup,
    operation: PendingRequest["operation"],
  ) => {
    const requiredCapability = operation === "remember-control" ? "control" : "view";
    const entry =
      group.routes.find(
        (route) =>
          route.desktop.connectionState === "online" &&
          route.desktop.capabilities.includes(requiredCapability),
      ) ?? group.primary;
    const request = {
      environmentId: entry.environmentId,
      desktopId: group.desktopId,
      label: entry.desktop.label,
      operation,
    } satisfies PendingRequest;
    setPending(request);
    setError(null);
    try {
      await run<ComputerAutomationStatus | void>(entry.environmentId, {
        request: { operation, desktopId: request.desktopId },
        timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
      });
      refresh();
    } catch (cause) {
      if (operation === "remember-view" || operation === "remember-control") {
        await run(entry.environmentId, {
          request: { operation: "release", desktopId: request.desktopId },
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
        }).catch(() => undefined);
      }
      setError(failureMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const readObservation = async (entry: UserDesktopEntry, observationId: ComputerObservationId) => {
    const update = await run<ComputerObservationUpdate>(entry.environmentId, {
      request: {
        operation: "observation",
        desktopId: entry.desktop.desktop.desktopId,
        observationId,
      },
    });
    return update.observation ?? null;
  };

  const defaultObservation = (
    observations: ComputerObservationList["observations"],
    status: ComputerAutomationStatus,
  ) => {
    const controllingThreadId =
      status.lease?.controller?.kind === "agent" && status.lease.controller.sameEnvironment === true
        ? status.lease.controller.threadId
        : undefined;
    return (
      observations.find(
        (observation) =>
          controllingThreadId !== undefined && observation.threadId === controllingThreadId,
      ) ?? observations[0]
    );
  };

  const openViewer = async (group: UserDesktopGroup) => {
    const entry =
      group.routes.find(
        (route) =>
          route.desktop.connectionState === "online" &&
          route.desktop.capabilities.includes("view") &&
          route.status !== null,
      ) ??
      group.routes.find(
        (route) =>
          route.desktop.connectionState === "online" && route.desktop.capabilities.includes("view"),
      );
    if (entry === undefined) return;
    const generation = ++viewerGeneration.current;
    setViewerBusy(true);
    setViewerError(null);
    try {
      const { status, list, selectedObservation, agentObservation } =
        await readUserDesktopSupervision(
          (input) => run(entry.environmentId, input),
          group.desktopId,
        );
      if (generation !== viewerGeneration.current) return;
      const primaryDisplay =
        status.displays.find((display) => display.primary) ?? status.displays[0];
      setViewer({
        generation,
        group,
        entry,
        status,
        liveStarted: false,
        observation: null,
        observationList: list.observations,
        selectedObservationId: selectedObservation?.id ?? null,
        agentObservation,
        selectedDisplayId: primaryDisplay?.id ?? null,
      });
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setViewerBusy(false);
    }
  };

  const captureViewer = async (
    selected: UserDesktopViewer,
    displayId = selected.selectedDisplayId,
  ) => {
    const contentHash =
      selected.observation?.screenshot?.state === "image"
        ? selected.observation.screenshot.contentHash
        : undefined;
    const observation = await run<ComputerAutomationSnapshot>(selected.entry.environmentId, {
      request: {
        operation: "snapshot",
        desktopId: selected.group.desktopId,
        input: {
          ...(displayId === null ? {} : { displayId }),
          includeAccessibility: false,
          screenshot: {
            maxWidth: VIEWER_MAX_WIDTH,
            maxHeight: VIEWER_MAX_HEIGHT,
            ...(contentHash === undefined ? {} : { unchangedIfContentHash: contentHash }),
          },
        },
      },
    });
    setViewer((current) =>
      current?.generation === selected.generation && current.selectedDisplayId === displayId
        ? {
            ...current,
            observation: retainUnchangedImage(current.observation, observation),
            selectedDisplayId: observation.display.id,
          }
        : current,
    );
    return observation;
  };

  const startLive = async (displayId?: string) => {
    const selected = viewerRef.current;
    if (selected === null) return;
    setViewerBusy(true);
    setViewerError(null);
    try {
      const result = await requestUserDesktopLive(
        (input) => run(selected.entry.environmentId, input),
        selected.group.desktopId,
        displayId ?? selected.selectedDisplayId,
        () => viewerRef.current?.generation === selected.generation,
      );
      if (result === null) return;
      setViewer((current) =>
        current?.generation === selected.generation
          ? {
              ...current,
              status: result.status,
              liveStarted: true,
              observation: result.observation,
              selectedDisplayId: result.observation.display.id,
            }
          : current,
      );
    } catch (cause) {
      setViewerError(failureMessage(cause));
      throw cause;
    } finally {
      setViewerBusy(false);
    }
  };

  const selectDisplay = async (displayId: string) => {
    const selected = viewerRef.current;
    if (selected === null || selected.selectedDisplayId === displayId) return;
    setViewerBusy(true);
    setViewerError(null);
    try {
      const next = { ...selected, observation: null, selectedDisplayId: displayId };
      setViewer(next);
      await captureViewer(next, displayId);
    } catch (cause) {
      setViewerError(failureMessage(cause));
    } finally {
      setViewerBusy(false);
    }
  };

  const selectObservation = async (observationId: string | null) => {
    const selected = viewerRef.current;
    const summary = selected?.observationList.find(
      (observation) => observation.id === observationId,
    );
    if (selected === null || summary === undefined) return;
    setViewerBusy(true);
    setViewerError(null);
    try {
      const observation = await readObservation(selected.entry, summary.id);
      setViewer((current) =>
        current?.generation === selected.generation
          ? {
              ...current,
              selectedObservationId: summary.id,
              agentObservation: observation,
            }
          : current,
      );
    } catch (cause) {
      setViewerError(`Agent lens unavailable: ${failureMessage(cause)}`);
    } finally {
      setViewerBusy(false);
    }
  };

  const confirmTakeover = (): Promise<boolean> => {
    const selected = viewerRef.current;
    const leaseId = selected?.status.lease?.takeoverLeaseId;
    const controller = selected?.status.lease?.controller;
    if (
      selected === null ||
      leaseId === undefined ||
      controller === null ||
      controller === undefined
    ) {
      confirmedTakeoverLeaseId.current = null;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const confirmation = {
        leaseId,
        desktopLabel: selected.entry.desktop.label,
        controllerKind: controller.kind,
        sameEnvironment: controller.sameEnvironment,
        resolve,
      } satisfies TakeoverConfirmation;
      takeoverConfirmationRef.current = confirmation;
      setTakeoverConfirmation(confirmation);
    });
  };

  const settleTakeoverConfirmation = (confirmed: boolean) => {
    const current = takeoverConfirmationRef.current;
    if (current === null) return;
    takeoverConfirmationRef.current = null;
    confirmedTakeoverLeaseId.current = confirmed ? current.leaseId : null;
    setTakeoverConfirmation(null);
    current.resolve(confirmed);
  };

  const takeViewerControl = async () => {
    const selected = viewerRef.current;
    if (selected === null) return false;
    const takeoverLeaseId = confirmedTakeoverLeaseId.current;
    confirmedTakeoverLeaseId.current = null;
    setViewerBusy(true);
    setViewerError(null);
    let granted = false;
    try {
      const status = await run<ComputerAutomationStatus>(selected.entry.environmentId, {
        request: {
          operation: "request-control",
          desktopId: selected.group.desktopId,
          ...(takeoverLeaseId === null ? {} : { takeoverLeaseId }),
        },
        timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
      });
      granted = status.lease?.access === "control";
      if (viewerRef.current?.generation !== selected.generation) {
        await run(selected.entry.environmentId, {
          request: { operation: "release", desktopId: selected.group.desktopId },
        });
        return false;
      }
      setViewer((current) =>
        current?.generation === selected.generation
          ? { ...current, status, liveStarted: true }
          : current,
      );
      await captureViewer({ ...selected, status, liveStarted: true });
      return status.lease?.access === "control";
    } catch (cause) {
      if (granted) {
        await run(selected.entry.environmentId, {
          request: { operation: "release-control", desktopId: selected.group.desktopId },
        }).catch(() => undefined);
      }
      setViewerError(failureMessage(cause));
      return false;
    } finally {
      setViewerBusy(false);
    }
  };

  const releaseViewerControl = async () => {
    const selected = viewerRef.current;
    if (selected === null) return false;
    setViewerBusy(true);
    setViewerError(null);
    try {
      const status = await run<ComputerAutomationStatus>(selected.entry.environmentId, {
        request: { operation: "release-control", desktopId: selected.group.desktopId },
      });
      setViewer((current) =>
        current?.generation === selected.generation ? { ...current, status } : current,
      );
      return true;
    } catch (cause) {
      setViewerError(failureMessage(cause));
      return false;
    } finally {
      setViewerBusy(false);
    }
  };

  const returnViewerControl = async () => {
    const selected = viewerRef.current;
    if (selected === null) return;
    setViewerBusy(true);
    setViewerError(null);
    try {
      const status = await run<ComputerAutomationStatus>(selected.entry.environmentId, {
        request: { operation: "return-control", desktopId: selected.group.desktopId },
      });
      setViewer((current) =>
        current?.generation === selected.generation ? { ...current, status } : current,
      );
    } catch (cause) {
      setViewerError(failureMessage(cause));
    } finally {
      setViewerBusy(false);
    }
  };

  const stopAgentControl = async () => {
    const selected = viewerRef.current;
    if (selected?.status.lease?.controller?.kind !== "agent") return;
    if (!(await confirmTakeover())) return;
    const takeoverLeaseId = confirmedTakeoverLeaseId.current;
    confirmedTakeoverLeaseId.current = null;
    setViewerBusy(true);
    setViewerError(null);
    try {
      await run(selected.entry.environmentId, {
        request: {
          operation: "request-control",
          desktopId: selected.group.desktopId,
          ...(takeoverLeaseId === null ? {} : { takeoverLeaseId }),
        },
      });
      await run(selected.entry.environmentId, {
        request: { operation: "release", desktopId: selected.group.desktopId },
      });
      const status = await run<ComputerAutomationStatus>(selected.entry.environmentId, {
        request: { operation: "status", desktopId: selected.group.desktopId },
      });
      setViewer((current) =>
        current?.generation === selected.generation ? { ...current, status } : current,
      );
    } catch (cause) {
      setViewerError(failureMessage(cause));
    } finally {
      setViewerBusy(false);
    }
  };

  const actInViewer = (actions: ReadonlyArray<ComputerAutomationAction>): Promise<void> => {
    const selected = viewerRef.current;
    if (selected?.status.lease?.access !== "control") return Promise.resolve();
    const execute = async () => {
      const current = viewerRef.current;
      if (
        current?.generation !== selected.generation ||
        current.status.lease?.access !== "control"
      ) {
        return;
      }
      try {
        await run(current.entry.environmentId, {
          request: {
            operation: "act",
            desktopId: current.group.desktopId,
            input: { actions: [...actions], observation: false },
          },
        });
        await captureViewer(current);
        setViewerError(null);
      } catch (cause) {
        setViewerError(failureMessage(cause));
      }
    };
    const queued = viewerActionQueue.current.then(execute, execute);
    viewerActionQueue.current = queued;
    return queued;
  };

  const closeViewer = useStableCallback(async () => {
    viewerGeneration.current += 1;
    const selected = viewerRef.current;
    settleTakeoverConfirmation(false);
    setViewer(null);
    setViewerError(null);
    const cleanup = viewerCleanup.current;
    viewerCleanup.current = null;
    if (cleanup !== null) cleanup();
    else if (selected !== null)
      await run(selected.entry.environmentId, {
        request: { operation: "release", desktopId: selected.group.desktopId },
      }).catch(() => undefined);
  });

  const bindViewer = useStableCallback((node: HTMLDivElement | null) => {
    const initial = viewerRef.current;
    if (node === null || initial === null) return;
    const { generation, entry, group } = initial;
    const currentSession = () => viewerRef.current?.generation === generation;
    const cleanup = mountUserDesktopSupervision({
      document,
      isLive: () => currentSession() && viewerRef.current?.liveStarted === true,
      capture: async () => {
        const selected = viewerRef.current;
        if (selected?.generation === generation) await captureViewer(selected);
      },
      metadata: async () => {
        const [status, list] = await Promise.all([
          run<ComputerAutomationStatus>(entry.environmentId, {
            request: { operation: "status", desktopId: group.desktopId },
          }),
          run<ComputerObservationList>(entry.environmentId, {
            request: { operation: "observation-list", desktopId: group.desktopId },
          }),
        ]);
        const current = viewerRef.current;
        if (current?.generation !== generation) return;
        const summary =
          list.observations.find(
            (observation) => observation.id === current.selectedObservationId,
          ) ?? defaultObservation(list.observations, status);
        const agentObservation =
          summary === undefined
            ? null
            : summary.id === current.selectedObservationId
              ? current.agentObservation
              : await readObservation(entry, summary.id);
        setViewer((selected) =>
          selected?.generation === generation
            ? {
                ...selected,
                status,
                observationList: list.observations,
                selectedObservationId: summary?.id ?? null,
                agentObservation,
              }
            : selected,
        );
      },
      onError: (cause) => {
        if (currentSession()) setViewerError(failureMessage(cause));
      },
      onHidden: () => {
        void closeViewer();
      },
      release: () =>
        run(entry.environmentId, {
          request: { operation: "release", desktopId: group.desktopId },
        }).then(() => undefined),
    });
    viewerCleanup.current = cleanup;
    return () => {
      cleanup();
      if (viewerCleanup.current === cleanup) viewerCleanup.current = null;
      if (currentSession()) {
        viewerGeneration.current += 1;
        viewerRef.current = null;
      }
    };
  });

  const saveRename = async (group: UserDesktopGroup) => {
    const label = editingLabel.trim();
    if (label.length === 0) return;
    setError(null);
    try {
      await Promise.all(
        group.routes.map((route) =>
          run(route.environmentId, {
            request: {
              operation: "rename",
              input: { desktopId: group.desktopId, label },
            },
          }),
        ),
      );
      setEditingKey(null);
      refresh();
    } catch (cause) {
      setError(failureMessage(cause));
    }
  };

  const confirmRemove = async () => {
    const group = removeGroup;
    if (group === null) return;
    setError(null);
    try {
      await Promise.all(
        group.routes.map((route) =>
          run(route.environmentId, {
            request: {
              operation: "remove",
              input: { desktopId: group.desktopId },
            },
          }),
        ),
      );
      setRemoveGroup(null);
      refresh();
    } catch (cause) {
      setError(failureMessage(cause));
    }
  };

  const selectedViewerSummary = viewer?.observationList.find(
    (observation) => observation.id === viewer.selectedObservationId,
  );
  const viewerEnvironmentLabel =
    viewer === null
      ? "Unknown environment"
      : (environmentById.get(viewer.entry.environmentId)?.label ?? "Unknown environment");
  const viewerThreadTitle =
    selectedViewerSummary === undefined
      ? "Unknown thread"
      : (threadById.get(selectedViewerSummary.threadId)?.title ?? selectedViewerSummary.threadId);
  const viewerIsLocalDesktop =
    viewer !== null && localDesktopId !== null && viewer.group.desktopId === localDesktopId;
  const viewerLiveDisabledReason =
    viewer === null
      ? null
      : viewerIsLocalDesktop
        ? "Live view is hidden here to avoid recursively mirroring T3 into itself. Agent lens and control status remain available."
        : !viewer.status.available
          ? (viewer.status.detail ?? "Live viewing is unavailable on this desktop.")
          : null;
  const viewerSupportsControl =
    viewer?.entry.desktop.connectionState === "online" &&
    viewer.entry.desktop.capabilities.includes("control");

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="user-desktops"
        title="User desktops"
        headerAction={
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCwIcon />
            Refresh
          </Button>
        }
      >
        <p className="px-3 pb-1 text-sm text-muted-foreground sm:px-4">
          Graphical desktops exposed by T3 desktop clients. Each has a stable identity, and agents
          must target one explicitly; T3 never redirects an operation to another machine.
        </p>
        {pending !== null ? (
          <Alert>
            <AlertDescription>
              {pending.operation === "remember-view" || pending.operation === "remember-control"
                ? `Waiting for approval on ${pending.label}. Complete the GNOME sharing prompt on that desktop. This explicit Settings action asks GNOME to remember the selected access.`
                : pending.operation === "end-all-access"
                  ? `Ending active computer access on ${pending.label}…`
                  : `Forgetting remembered computer-use approval on ${pending.label}…`}
            </AlertDescription>
          </Alert>
        ) : null}
        {(error ?? listingError) ? (
          <Alert variant="error">
            <AlertDescription>{error ?? listingError}</AlertDescription>
          </Alert>
        ) : null}
        {incompatibleClientCount > 0 ? (
          <Alert variant="error">
            <AlertDescription>
              {incompatibleClientCount} connected desktop{" "}
              {incompatibleClientCount === 1 ? "client" : "clients"}
              {" cannot identify a user desktop. Update "}
              {incompatibleClientCount === 1 ? "that client" : "those clients"} before using
              computer control there.
            </AlertDescription>
          </Alert>
        ) : null}
        {loading && desktopGroups.length === 0 ? (
          <div role="status" className="rounded-xl border border-dashed px-5 py-10 text-center">
            <RefreshCwIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
            <p className="font-medium">Loading user desktops…</p>
          </div>
        ) : desktopGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed px-5 py-10 text-center">
            <MonitorIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
            <p className="font-medium">No user desktops known</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start a current T3 desktop client connected to this environment.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {desktopGroups.map((group) => {
              const desktop = group.primary.desktop;
              const busy = pending !== null;
              const supportsView = group.routes.some(
                (route) =>
                  route.desktop.connectionState === "online" &&
                  route.desktop.capabilities.includes("view"),
              );
              const supportsControl = group.routes.some(
                (route) =>
                  route.desktop.connectionState === "online" &&
                  route.desktop.capabilities.includes("control"),
              );
              const activeLease = group.routes
                .map((route) => route.status?.lease)
                .find(
                  (lease) =>
                    lease !== undefined && (lease.controller !== null || lease.access !== "none"),
                );
              const environmentLabels = [
                ...new Set(
                  group.routes.map(
                    (route) =>
                      environmentById.get(route.environmentId)?.label ?? "Unknown environment",
                  ),
                ),
              ];
              return (
                <div key={group.desktopId} className="rounded-lg border p-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="flex flex-wrap items-center gap-2 font-medium">
                        {desktop.label}
                        <Badge
                          variant={
                            group.connectionState === "online"
                              ? "default"
                              : group.connectionState === "identity-conflict"
                                ? "error"
                                : "secondary"
                          }
                        >
                          {connectionLabel(group.connectionState)}
                        </Badge>
                        {group.t3Focused ? <Badge variant="secondary">T3 focused</Badge> : null}
                        {activeLease?.controller ? (
                          <Badge variant="secondary">
                            {activeLease.controller.kind === "human"
                              ? "Human control"
                              : activeLease.controller.kind === "agent"
                                ? "Agent control"
                                : "Local control"}
                          </Badge>
                        ) : activeLease?.access === "view" ? (
                          <Badge variant="secondary">Live view</Badge>
                        ) : null}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {environmentLabels.length === 1
                          ? environmentLabels[0]
                          : `Available through ${environmentLabels.join(", ")}`}{" "}
                        · {platformLabel(desktop.platform)}
                        {group.connectionState !== "identity-conflict" ? (
                          <>
                            {" · "}
                            {group.connectionState === "online" ? "Connected" : "Last seen"}{" "}
                            {formatRelativeTimeLabel(desktop.lastSeenAt)}
                          </>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          pending !== null ||
                          viewerBusy ||
                          group.connectionState !== "online" ||
                          !supportsView
                        }
                        onClick={() => void openViewer(group)}
                      >
                        <EyeIcon />
                        Supervise
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Rename ${desktop.label}`}
                        onClick={() => {
                          setEditingKey(group.desktopId);
                          setEditingLabel(desktop.label);
                        }}
                      >
                        <PencilIcon />
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-3">
                    {editingKey === group.desktopId ? (
                      <div className="flex gap-2">
                        <Input
                          value={editingLabel}
                          maxLength={256}
                          aria-label="User desktop name"
                          onChange={(event) => setEditingLabel(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void saveRename(group);
                            if (event.key === "Escape") setEditingKey(null);
                          }}
                        />
                        <Button onClick={() => void saveRename(group)}>Save</Button>
                        <Button variant="ghost" onClick={() => setEditingKey(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>
                        View:{" "}
                        {group.rememberedAccess.includes("view") ? "remembered" : "ask each time"}
                      </span>
                      <span>
                        Control:{" "}
                        {group.rememberedAccess.includes("control")
                          ? "remembered"
                          : "ask each time"}
                      </span>
                      <span className="font-mono">{group.desktopId}</span>
                    </div>
                    {group.audit.slice(0, 3).length > 0 ? (
                      <div
                        aria-label={`Recent access for ${desktop.label}`}
                        className="grid gap-2 rounded-lg border bg-muted/20 p-3"
                      >
                        <div className="flex items-center gap-2 text-xs font-medium">
                          <HistoryIcon className="size-4 text-muted-foreground" />
                          Recent access
                        </div>
                        {group.audit.slice(0, 3).map(({ environmentId, event }) => {
                          const actorLabel =
                            event.actorLabel ?? (event.actorKind === "human" ? "Human" : "Agent");
                          const threadLabel =
                            event.threadId === undefined
                              ? null
                              : (threadById.get(event.threadId)?.title ?? event.threadId);
                          const environmentLabel =
                            environmentById.get(environmentId)?.label ?? "Unknown environment";
                          return (
                            <div
                              key={`${environmentId}:${event.sequence}`}
                              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                            >
                              <span className="font-medium">{auditActionLabel(event.action)}</span>
                              {event.takeover ? <Badge variant="secondary">Takeover</Badge> : null}
                              <span className="text-muted-foreground">
                                {[actorLabel, threadLabel, environmentLabel]
                                  .filter((label) => label !== null)
                                  .join(" · ")}{" "}
                                · {formatRelativeTimeLabel(event.occurredAt)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {group.hasIdentityConflict ? (
                      <Alert variant="error">
                        <AlertDescription>
                          At least one environment reports multiple clients claiming this identity.
                          Actions use a healthy route when one is available.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    {group.connectionState === "online" && !supportsView ? (
                      <Alert>
                        <AlertDescription>
                          Computer use is unavailable for this desktop on its current platform.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || group.connectionState !== "online" || !supportsView}
                        onClick={() => void performAccessAction(group, "remember-view")}
                      >
                        <EyeIcon />
                        Remember view
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || group.connectionState !== "online" || !supportsControl}
                        onClick={() => void performAccessAction(group, "remember-control")}
                      >
                        <KeyboardIcon />
                        Remember control
                      </Button>
                      {group.connectionState === "online" && supportsView ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void performAccessAction(group, "end-all-access")}
                        >
                          {pending?.desktopId === group.desktopId &&
                          pending.operation === "end-all-access"
                            ? "Ending access…"
                            : "End all access"}
                        </Button>
                      ) : null}
                      {group.rememberedAccess.length > 0 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void performAccessAction(group, "forget")}
                        >
                          <ShieldOffIcon />
                          {pending?.desktopId === group.desktopId && pending.operation === "forget"
                            ? "Forgetting…"
                            : "Forget approval"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={group.connectionState !== "offline"}
                        onClick={() => setRemoveGroup(group)}
                      >
                        <Trash2Icon />
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <Dialog open={viewer !== null} onOpenChange={(open) => !open && void closeViewer()}>
        {viewer ? (
          <div key={viewer.generation} ref={bindViewer}>
            <ComputerDesktopViewer
              label={viewer.entry.desktop.label}
              description={
                <>
                  Open Agent lens observations without starting a new capture, or start Live to
                  watch the selected display. Taking control safely releases queued and held agent
                  input, then captures host shortcuts in full screen. GNOME shows the native sharing
                  indicator while access is active.
                </>
              }
              observation={viewer.observation}
              agentObservation={viewer.agentObservation}
              controlling={viewer.status.lease?.access === "control"}
              busy={viewerBusy}
              error={viewerError}
              liveStarted={viewer.liveStarted}
              liveDisabledReason={viewerLiveDisabledReason}
              controlDisabledReason={
                viewerSupportsControl ? null : "Control is unavailable on this desktop."
              }
              liveDisplays={viewer.status.displays}
              selectedDisplayId={viewer.selectedDisplayId}
              lensControls={
                <div className="mt-2 flex items-center gap-2 rounded-lg border bg-muted/20 p-2.5">
                  <HistoryIcon className="size-4 shrink-0 text-muted-foreground" />
                  {viewer.observationList.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No model-facing observations are retained for this desktop.
                    </p>
                  ) : (
                    <Select
                      value={viewer.selectedObservationId}
                      onValueChange={(value) => void selectObservation(value)}
                      disabled={viewerBusy}
                    >
                      <SelectTrigger
                        size="sm"
                        className="min-w-0 flex-1"
                        aria-label="Agent lens observation"
                      >
                        <SelectValue>
                          {selectedViewerSummary === undefined
                            ? "Choose an observation"
                            : observationSummaryLabel(
                                selectedViewerSummary,
                                viewerEnvironmentLabel,
                                viewerThreadTitle,
                              )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup
                        align="start"
                        alignItemWithTrigger={false}
                        className="max-w-[min(90vw,48rem)]"
                      >
                        {viewer.observationList.map((observation) => (
                          <SelectItem key={observation.id} value={observation.id}>
                            {observationSummaryLabel(
                              observation,
                              viewerEnvironmentLabel,
                              threadById.get(observation.threadId)?.title ?? observation.threadId,
                            )}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )}
                </div>
              }
              secondaryActions={
                <>
                  {viewer.status.lease?.canReturnControl === true ? (
                    <Button variant="outline" disabled={viewerBusy} onClick={returnViewerControl}>
                      <Undo2Icon />
                      Return control to agent
                    </Button>
                  ) : null}
                  {viewerIsLocalDesktop &&
                  viewer.status.lease?.controller?.kind === "agent" &&
                  viewer.status.lease.access !== "control" ? (
                    <Button variant="outline" disabled={viewerBusy} onClick={stopAgentControl}>
                      <HandIcon />
                      Stop agent control
                    </Button>
                  ) : null}
                </>
              }
              onStartLive={() => startLive()}
              onSelectDisplay={selectDisplay}
              onShowInLive={(displayId) =>
                viewer.liveStarted ? selectDisplay(displayId) : startLive(displayId)
              }
              onConfirmTakeControl={confirmTakeover}
              onTakeControl={takeViewerControl}
              onRelease={releaseViewerControl}
              onAction={actInViewer}
            />
          </div>
        ) : null}
      </Dialog>

      <AlertDialog
        open={takeoverConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) settleTakeoverConfirmation(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Take control of this desktop?</AlertDialogTitle>
            <AlertDialogDescription>
              {takeoverConfirmation === null
                ? "The current desktop controller changed."
                : `${takeoverConfirmation.desktopLabel} is controlled by ${
                    takeoverConfirmation.controllerKind === "human"
                      ? "another person"
                      : takeoverConfirmation.controllerKind === "agent"
                        ? "an agent"
                        : "a local controller"
                  }${takeoverConfirmation.sameEnvironment ? "" : " through another environment"}. Taking over immediately cancels its queued input and releases held keys and buttons.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => settleTakeoverConfirmation(false)}>
              Cancel
            </AlertDialogClose>
            <Button onClick={() => settleTakeoverConfirmation(true)}>Take control</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={removeGroup !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveGroup(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this user desktop?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the offline inventory entry only. If that desktop reconnects with the
              same identity, it will appear again automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmRemove()}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}

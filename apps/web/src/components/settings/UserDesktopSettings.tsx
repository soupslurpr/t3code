import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ComputerAutomationAction,
  ComputerAutomationLeaseId,
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  ComputerObservation,
  ComputerObservationId,
  ComputerObservationList,
  ComputerObservationSummary,
  ComputerObservationUpdate,
  EnvironmentId,
  UserDesktopAuditAction,
  UserDesktopAuditEvent,
  UserDesktopAuditLog,
  UserDesktopHumanInvokeInput,
  UserDesktopList,
  UserDesktopView,
} from "@t3tools/contracts";
import {
  EyeIcon,
  HandIcon,
  HistoryIcon,
  KeyboardIcon,
  MonitorIcon,
  PencilIcon,
  RefreshCwIcon,
  ShieldOffIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useThreadShells } from "~/state/entities";
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
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Dialog } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ComputerDesktopViewer } from "./AgentDesktopSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const INVENTORY_REFRESH_INTERVAL_MS = 5_000;
const ACCESS_REQUEST_TIMEOUT_MS = 120_000;
const VIEWER_REFRESH_INTERVAL_MS = 750;
const VIEWER_METADATA_REFRESH_INTERVAL_MS = 2_000;
const VIEWER_MAX_WIDTH = 1_280;
const VIEWER_MAX_HEIGHT = 720;

interface UserDesktopEntry {
  readonly environmentId: EnvironmentId;
  readonly desktop: UserDesktopView;
  readonly status: ComputerAutomationStatus | null;
  readonly audit: UserDesktopAuditLog["events"];
}

interface UserDesktopAuditEntry {
  readonly environmentId: EnvironmentId;
  readonly event: UserDesktopAuditEvent;
}

interface UserDesktopGroup {
  readonly desktopId: string;
  readonly routes: ReadonlyArray<UserDesktopEntry>;
  readonly primary: UserDesktopEntry;
  readonly connectionState: UserDesktopView["connectionState"];
  readonly hasIdentityConflict: boolean;
  readonly t3Focused: boolean;
  readonly rememberedAccess: ComputerAutomationStatus["rememberedAccess"];
  readonly audit: ReadonlyArray<UserDesktopAuditEntry>;
}

interface PendingRequest {
  readonly environmentId: EnvironmentId;
  readonly desktopId: string;
  readonly label: string;
  readonly operation: "remember-view" | "remember-control" | "end-all-access" | "forget";
}

interface UserDesktopViewer {
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

/** Groups environment-scoped routes that lead to one physical desktop identity. */
function groupEntries(entries: ReadonlyArray<UserDesktopEntry>): ReadonlyArray<UserDesktopGroup> {
  const routesByDesktop = new Map<string, Array<UserDesktopEntry>>();
  for (const entry of entries) {
    const desktopId = entry.desktop.desktop.desktopId;
    const routes = routesByDesktop.get(desktopId);
    if (routes === undefined) routesByDesktop.set(desktopId, [entry]);
    else routes.push(entry);
  }

  const groups: Array<UserDesktopGroup> = [];
  for (const [desktopId, routes] of routesByDesktop) {
    const primary =
      routes.find((entry) => entry.desktop.connectionState === "online" && entry.status !== null) ??
      routes.find((entry) => entry.desktop.connectionState === "online") ??
      routes[0];
    if (primary === undefined) continue;
    const hasIdentityConflict = routes.some(
      (entry) => entry.desktop.connectionState === "identity-conflict",
    );
    groups.push({
      desktopId,
      routes,
      primary,
      connectionState: routes.some((entry) => entry.desktop.connectionState === "online")
        ? "online"
        : hasIdentityConflict
          ? "identity-conflict"
          : "offline",
      hasIdentityConflict,
      t3Focused: routes.some((entry) => entry.desktop.t3Focused),
      rememberedAccess: (["view", "control"] as const).filter((access) =>
        routes.some((entry) => entry.status?.rememberedAccess.includes(access) === true),
      ),
      audit: routes
        .flatMap((entry) =>
          entry.audit.map((event) => ({ environmentId: entry.environmentId, event })),
        )
        .toSorted(
          (left, right) =>
            right.event.occurredAt.localeCompare(left.event.occurredAt) ||
            right.event.sequence - left.event.sequence,
        ),
    });
  }
  return groups;
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

/** Preserves prior image bytes when a fingerprint confirms the next frame is unchanged. */
function retainUnchangedImage(
  current: ComputerAutomationSnapshot | null,
  next: ComputerAutomationSnapshot,
): ComputerAutomationSnapshot {
  if (
    next.screenshot?.state !== "unchanged" ||
    current?.screenshot?.state !== "image" ||
    next.screenshot.contentHash !== current.screenshot.contentHash
  ) {
    return next;
  }
  return { ...next, screenshot: current.screenshot };
}

/** Lists and manages the concrete user desktops exposed to one environment. */
export function UserDesktopSettings() {
  const { environments, isReady: environmentsReady } = useEnvironments();
  const threads = useThreadShells();
  const invoke = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, {
    reportFailure: false,
  });
  const [entries, setEntries] = useState<ReadonlyArray<UserDesktopEntry>>([]);
  const [incompatibleClientCount, setIncompatibleClientCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [removeGroup, setRemoveGroup] = useState<UserDesktopGroup | null>(null);
  const [viewer, setViewer] = useState<UserDesktopViewer | null>(null);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [takeoverConfirmation, setTakeoverConfirmation] = useState<TakeoverConfirmation | null>(
    null,
  );
  const [localDesktopId] = useState(
    () => window.desktopBridge?.getUserDesktopHost?.().desktopId ?? null,
  );
  const refreshing = useRef<Promise<void> | null>(null);
  const entriesRef = useRef(entries);
  const viewerRef = useRef(viewer);
  const viewerActionQueue = useRef<Promise<void>>(Promise.resolve());
  const confirmedTakeoverLeaseId = useRef<ComputerAutomationLeaseId | null>(null);
  const takeoverConfirmationRef = useRef<TakeoverConfirmation | null>(null);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);

  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const desktopGroups = useMemo(() => groupEntries(entries), [entries]);

  const run = useCallback(
    async <Value,>(environmentId: EnvironmentId, input: UserDesktopHumanInvokeInput) => {
      const result = await invoke({ environmentId, input });
      if (result._tag === "Success") return result.value as Value;
      throw squashAtomCommandFailure(result);
    },
    [invoke],
  );

  const refresh = useCallback(
    (silent = false, afterCurrent = false): Promise<void> => {
      const active = refreshing.current;
      if (active !== null && !afterCurrent) return active;
      const previous = active?.catch(() => undefined) ?? Promise.resolve();
      const next = previous.then(async () => {
        if (!silent) setLoading(true);
        const includeAudit = !silent || afterCurrent;
        const priorByEnvironment = new Map<EnvironmentId, Map<string, UserDesktopEntry>>();
        for (const entry of entriesRef.current) {
          const routes = priorByEnvironment.get(entry.environmentId);
          if (routes === undefined) {
            priorByEnvironment.set(
              entry.environmentId,
              new Map([[entry.desktop.desktop.desktopId, entry]]),
            );
          } else {
            routes.set(entry.desktop.desktop.desktopId, entry);
          }
        }
        try {
          const results = await Promise.all(
            environments.map(async (environment) => {
              try {
                const list = await run<UserDesktopList>(environment.environmentId, {
                  request: { operation: "list" },
                });
                const desktops = await Promise.all(
                  list.desktops.map(async (desktop): Promise<UserDesktopEntry> => {
                    const prior = priorByEnvironment
                      .get(environment.environmentId)
                      ?.get(desktop.desktop.desktopId);
                    const statusPromise: Promise<ComputerAutomationStatus | null> =
                      desktop.connectionState === "online"
                        ? run<ComputerAutomationStatus>(environment.environmentId, {
                            request: {
                              operation: "status",
                              desktopId: desktop.desktop.desktopId,
                            },
                          }).catch(() => null)
                        : Promise.resolve(null);
                    const auditPromise: Promise<UserDesktopAuditLog["events"]> = includeAudit
                      ? run<UserDesktopAuditLog>(environment.environmentId, {
                          request: {
                            operation: "audit",
                            desktopId: desktop.desktop.desktopId,
                          },
                        })
                          .then((audit) => audit.events)
                          .catch(() => prior?.audit ?? [])
                      : Promise.resolve(prior?.audit ?? []);
                    const [status, audit] = await Promise.all([statusPromise, auditPromise]);
                    return { environmentId: environment.environmentId, desktop, status, audit };
                  }),
                );
                return { environmentId: environment.environmentId, desktops, list } as const;
              } catch (cause) {
                return { environmentId: environment.environmentId, cause } as const;
              }
            }),
          );
          const nextEntries = results.flatMap((result) =>
            "desktops" in result ? result.desktops : [],
          );
          nextEntries.sort(
            (left, right) =>
              Number(right.desktop.t3Focused) - Number(left.desktop.t3Focused) ||
              Number(right.desktop.connectionState === "online") -
                Number(left.desktop.connectionState === "online") ||
              right.desktop.lastSeenAt.localeCompare(left.desktop.lastSeenAt),
          );
          const failed = results.find(
            (
              result,
            ): result is { readonly environmentId: EnvironmentId; readonly cause: unknown } =>
              "cause" in result,
          );
          entriesRef.current = nextEntries;
          setEntries(nextEntries);
          setIncompatibleClientCount(
            results.reduce(
              (total, result) =>
                total + ("list" in result ? result.list.incompatibleClientCount : 0),
              0,
            ),
          );
          setError(failed === undefined ? null : failureMessage(failed.cause));
        } finally {
          if (!silent) setLoading(false);
        }
      });
      refreshing.current = next;
      return next.finally(() => {
        if (refreshing.current === next) refreshing.current = null;
      });
    },
    [environments, run],
  );

  useEffect(() => {
    if (!environmentsReady) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(true), INVENTORY_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [environmentsReady, refresh]);

  const performAccessAction = useCallback(
    async (group: UserDesktopGroup, operation: PendingRequest["operation"]) => {
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
        await refresh(true, true);
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
    },
    [refresh, run],
  );

  const readObservation = useCallback(
    async (entry: UserDesktopEntry, observationId: ComputerObservationId) => {
      const update = await run<ComputerObservationUpdate>(entry.environmentId, {
        request: {
          operation: "observation",
          desktopId: entry.desktop.desktop.desktopId,
          observationId,
        },
      });
      return update.observation ?? null;
    },
    [run],
  );

  const defaultObservation = useCallback(
    (observations: ComputerObservationList["observations"], status: ComputerAutomationStatus) => {
      const controllingThreadId =
        status.lease?.controller?.kind === "agent" &&
        status.lease.controller.sameEnvironment === true
          ? status.lease.controller.threadId
          : undefined;
      return (
        observations.find(
          (observation) =>
            controllingThreadId !== undefined && observation.threadId === controllingThreadId,
        ) ?? observations[0]
      );
    },
    [],
  );

  const openViewer = useCallback(
    async (group: UserDesktopGroup) => {
      const entry =
        group.routes.find(
          (route) =>
            route.desktop.connectionState === "online" &&
            route.desktop.capabilities.includes("view") &&
            route.status !== null,
        ) ??
        group.routes.find(
          (route) =>
            route.desktop.connectionState === "online" &&
            route.desktop.capabilities.includes("view"),
        );
      if (entry === undefined) return;
      setViewerBusy(true);
      setViewerError(null);
      try {
        const [status, list] = await Promise.all([
          run<ComputerAutomationStatus>(entry.environmentId, {
            request: { operation: "status", desktopId: group.desktopId },
          }),
          run<ComputerObservationList>(entry.environmentId, {
            request: { operation: "observation-list", desktopId: group.desktopId },
          }),
        ]);
        const selectedObservation = defaultObservation(list.observations, status);
        let agentObservation: ComputerObservation | null = null;
        if (selectedObservation !== undefined) {
          try {
            agentObservation = await readObservation(entry, selectedObservation.id);
          } catch (cause) {
            setViewerError(`Agent lens unavailable: ${failureMessage(cause)}`);
          }
        }
        const primaryDisplay =
          status.displays.find((display) => display.primary) ?? status.displays[0];
        setViewer({
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
    },
    [defaultObservation, readObservation, run],
  );

  const captureViewer = useCallback(
    async (selected: UserDesktopViewer, displayId = selected.selectedDisplayId) => {
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
        current?.group.desktopId === selected.group.desktopId
          ? {
              ...current,
              observation: retainUnchangedImage(current.observation, observation),
              selectedDisplayId: observation.display.id,
            }
          : current,
      );
      return observation;
    },
    [run],
  );

  const startLive = useCallback(
    async (displayId?: string) => {
      const selected = viewerRef.current;
      if (selected === null) return;
      setViewerBusy(true);
      setViewerError(null);
      try {
        const status = await run<ComputerAutomationStatus>(selected.entry.environmentId, {
          request: { operation: "request-view", desktopId: selected.group.desktopId },
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
        });
        const requestedDisplayId =
          displayId ??
          selected.selectedDisplayId ??
          status.displays.find((display) => display.primary)?.id ??
          status.displays[0]?.id;
        const next = {
          ...selected,
          status,
          liveStarted: true,
          selectedDisplayId: requestedDisplayId ?? null,
        } satisfies UserDesktopViewer;
        setViewer(next);
        await captureViewer(next);
      } catch (cause) {
        setViewerError(failureMessage(cause));
        throw cause;
      } finally {
        setViewerBusy(false);
      }
    },
    [captureViewer, run],
  );

  const selectDisplay = useCallback(
    async (displayId: string) => {
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
    },
    [captureViewer],
  );

  const selectObservation = useCallback(
    async (observationId: string | null) => {
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
          current?.group.desktopId === selected.group.desktopId
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
    },
    [readObservation],
  );

  const confirmTakeover = useCallback((): Promise<boolean> => {
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
  }, []);

  const settleTakeoverConfirmation = useCallback((confirmed: boolean) => {
    const current = takeoverConfirmationRef.current;
    if (current === null) return;
    takeoverConfirmationRef.current = null;
    confirmedTakeoverLeaseId.current = confirmed ? current.leaseId : null;
    setTakeoverConfirmation(null);
    current.resolve(confirmed);
  }, []);

  const takeViewerControl = useCallback(async () => {
    const selected = viewerRef.current;
    if (selected === null) return false;
    const takeoverLeaseId = confirmedTakeoverLeaseId.current;
    confirmedTakeoverLeaseId.current = null;
    setViewerBusy(true);
    setViewerError(null);
    try {
      const status = await run<ComputerAutomationStatus>(selected.entry.environmentId, {
        request: {
          operation: "request-control",
          desktopId: selected.group.desktopId,
          ...(takeoverLeaseId === null ? {} : { takeoverLeaseId }),
        },
        timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
      });
      setViewer((current) =>
        current?.group.desktopId === selected.group.desktopId
          ? { ...current, status, liveStarted: true }
          : current,
      );
      await captureViewer({ ...selected, status, liveStarted: true });
      return status.lease?.access === "control";
    } catch (cause) {
      setViewerError(failureMessage(cause));
      return false;
    } finally {
      setViewerBusy(false);
    }
  }, [captureViewer, run]);

  const releaseViewerControl = useCallback(async () => {
    const selected = viewerRef.current;
    if (selected === null) return false;
    setViewerBusy(true);
    setViewerError(null);
    try {
      const status = await run<ComputerAutomationStatus>(selected.entry.environmentId, {
        request: { operation: "release-control", desktopId: selected.group.desktopId },
      });
      setViewer((current) =>
        current?.group.desktopId === selected.group.desktopId ? { ...current, status } : current,
      );
      return true;
    } catch (cause) {
      setViewerError(failureMessage(cause));
      return false;
    } finally {
      setViewerBusy(false);
    }
  }, [run]);

  const returnViewerControl = useCallback(async () => {
    const selected = viewerRef.current;
    if (selected === null) return;
    setViewerBusy(true);
    setViewerError(null);
    try {
      const status = await run<ComputerAutomationStatus>(selected.entry.environmentId, {
        request: { operation: "return-control", desktopId: selected.group.desktopId },
      });
      setViewer((current) =>
        current?.group.desktopId === selected.group.desktopId ? { ...current, status } : current,
      );
    } catch (cause) {
      setViewerError(failureMessage(cause));
    } finally {
      setViewerBusy(false);
    }
  }, [run]);

  const stopAgentControl = useCallback(async () => {
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
        current?.group.desktopId === selected.group.desktopId ? { ...current, status } : current,
      );
    } catch (cause) {
      setViewerError(failureMessage(cause));
    } finally {
      setViewerBusy(false);
    }
  }, [confirmTakeover, run]);

  const actInViewer = useCallback(
    (actions: ReadonlyArray<ComputerAutomationAction>): Promise<void> => {
      const selected = viewerRef.current;
      if (selected?.status.lease?.access !== "control") return Promise.resolve();
      const execute = async () => {
        const current = viewerRef.current;
        if (
          current?.group.desktopId !== selected.group.desktopId ||
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
    },
    [captureViewer, run],
  );

  const closeViewer = useCallback(async () => {
    const selected = viewerRef.current;
    settleTakeoverConfirmation(false);
    setViewer(null);
    setViewerError(null);
    if (selected === null) return;
    try {
      await run(selected.entry.environmentId, {
        request: { operation: "release", desktopId: selected.group.desktopId },
      });
    } catch {
      // Closing is best effort; expiry and disconnect also release the transient human lease.
    }
  }, [run, settleTakeoverConfirmation]);

  useEffect(() => {
    if (viewer === null || !viewer.liveStarted) return;
    const desktopId = viewer.group.desktopId;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!cancelled) timeout = setTimeout(poll, VIEWER_REFRESH_INTERVAL_MS);
    };
    const poll = async () => {
      const selected = viewerRef.current;
      if (
        cancelled ||
        document.visibilityState !== "visible" ||
        selected?.group.desktopId !== desktopId ||
        !selected.liveStarted
      ) {
        schedule();
        return;
      }
      try {
        await captureViewer(selected);
        if (!cancelled) setViewerError(null);
      } catch (cause) {
        if (!cancelled) setViewerError(failureMessage(cause));
      }
      schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeout !== null) clearTimeout(timeout);
    };
  }, [captureViewer, viewer?.group.desktopId, viewer?.liveStarted]);

  useEffect(() => {
    if (viewer === null) return;
    const desktopId = viewer.group.desktopId;
    const entry = viewer.entry;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!cancelled) timeout = setTimeout(poll, VIEWER_METADATA_REFRESH_INTERVAL_MS);
    };
    const poll = async () => {
      if (cancelled || document.visibilityState !== "visible") {
        schedule();
        return;
      }
      try {
        const [status, list] = await Promise.all([
          run<ComputerAutomationStatus>(entry.environmentId, {
            request: { operation: "status", desktopId },
          }),
          run<ComputerObservationList>(entry.environmentId, {
            request: { operation: "observation-list", desktopId },
          }),
        ]);
        if (cancelled) return;
        const current = viewerRef.current;
        if (current?.group.desktopId !== desktopId) return;
        const selectedSummary =
          list.observations.find(
            (observation) => observation.id === current.selectedObservationId,
          ) ?? defaultObservation(list.observations, status);
        let agentObservation = current.agentObservation;
        if (selectedSummary !== undefined && selectedSummary.id !== current.selectedObservationId) {
          agentObservation = await readObservation(entry, selectedSummary.id);
        } else if (selectedSummary === undefined) {
          agentObservation = null;
        }
        if (cancelled) return;
        setViewer((selected) =>
          selected?.group.desktopId === desktopId
            ? {
                ...selected,
                status,
                observationList: list.observations,
                selectedObservationId: selectedSummary?.id ?? null,
                agentObservation: selectedSummary === undefined ? null : agentObservation,
              }
            : selected,
        );
      } catch (cause) {
        if (!cancelled) setViewerError(failureMessage(cause));
      }
      schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeout !== null) clearTimeout(timeout);
    };
  }, [defaultObservation, readObservation, run, viewer?.entry, viewer?.group.desktopId]);

  useEffect(() => {
    const releaseWhenHidden = () => {
      if (document.visibilityState === "hidden" && viewerRef.current !== null) {
        void closeViewer();
      }
    };
    document.addEventListener("visibilitychange", releaseWhenHidden);
    return () => document.removeEventListener("visibilitychange", releaseWhenHidden);
  }, [closeViewer]);

  useEffect(
    () => () => {
      const selected = viewerRef.current;
      if (selected === null) return;
      void run(selected.entry.environmentId, {
        request: { operation: "release", desktopId: selected.group.desktopId },
      }).catch(() => undefined);
    },
    [run],
  );

  const saveRename = useCallback(
    async (group: UserDesktopGroup) => {
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
        await refresh(true, true);
      } catch (cause) {
        setError(failureMessage(cause));
      }
    },
    [editingLabel, refresh, run],
  );

  const confirmRemove = useCallback(async () => {
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
      await refresh(true, true);
    } catch (cause) {
      setError(failureMessage(cause));
    }
  }, [refresh, removeGroup, run]);

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
    viewer?.group.routes.some(
      (route) =>
        route.desktop.connectionState === "online" &&
        route.desktop.capabilities.includes("control"),
    ) ?? false;

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="user-desktops"
        title="User desktops"
        headerAction={
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
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
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
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
            <RefreshCwIcon className="mx-auto mb-3 size-6 animate-spin text-muted-foreground" />
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
                .find((lease) => lease?.controller !== null || lease?.access !== "none");
              const environmentLabels = [
                ...new Set(
                  group.routes.map(
                    (route) =>
                      environmentById.get(route.environmentId)?.label ?? "Unknown environment",
                  ),
                ),
              ];
              const recentAudit = group.audit.slice(0, 3);
              return (
                <Card key={group.desktopId}>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
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
                      {activeLease?.controller !== null && activeLease?.controller !== undefined ? (
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
                    </CardTitle>
                    <CardDescription>
                      {environmentLabels.length === 1
                        ? environmentLabels[0]
                        : `Available through ${environmentLabels.join(", ")}`}{" "}
                      · {platformLabel(desktop.platform)}
                      {" · "}seen {formatRelativeTimeLabel(desktop.lastSeenAt)}
                    </CardDescription>
                    <CardAction>
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
                    </CardAction>
                  </CardHeader>
                  <CardPanel className="grid gap-3">
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
                    {recentAudit.length > 0 ? (
                      <div
                        aria-label={`Recent access for ${desktop.label}`}
                        className="grid gap-2 rounded-lg border bg-muted/20 p-3"
                      >
                        <div className="flex items-center gap-2 text-xs font-medium">
                          <HistoryIcon className="size-4 text-muted-foreground" />
                          Recent access
                        </div>
                        {recentAudit.map(({ environmentId, event }) => {
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
                  </CardPanel>
                </Card>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <Dialog open={viewer !== null} onOpenChange={(open) => !open && void closeViewer()}>
        {viewer ? (
          <ComputerDesktopViewer
            label={viewer.entry.desktop.label}
            description={
              <>
                Open Agent lens observations without starting a new capture, or start Live to watch
                the selected display. Taking control safely releases queued and held agent input,
                then captures host shortcuts in full screen. GNOME shows the native sharing
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

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ComputerAutomationStatus,
  EnvironmentId,
  UserDesktopHumanInvokeInput,
  UserDesktopList,
  UserDesktopView,
} from "@t3tools/contracts";
import {
  EyeIcon,
  KeyboardIcon,
  MonitorIcon,
  PencilIcon,
  RefreshCwIcon,
  ShieldOffIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const INVENTORY_REFRESH_INTERVAL_MS = 5_000;
const ACCESS_REQUEST_TIMEOUT_MS = 120_000;

interface UserDesktopEntry {
  readonly environmentId: EnvironmentId;
  readonly desktop: UserDesktopView;
  readonly status: ComputerAutomationStatus | null;
}

interface PendingRequest {
  readonly environmentId: EnvironmentId;
  readonly desktopId: string;
  readonly label: string;
  readonly operation: "remember-view" | "remember-control" | "release" | "forget";
}

/** Keeps duplicate desktop ids from different environments distinct in React state. */
function entryKey(entry: UserDesktopEntry): string {
  return `${entry.environmentId}:${entry.desktop.desktop.desktopId}`;
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

/** Lists and manages the concrete user desktops exposed to one environment. */
export function UserDesktopSettings() {
  const { environments, isReady: environmentsReady } = useEnvironments();
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
  const [removeEntry, setRemoveEntry] = useState<UserDesktopEntry | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);

  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );

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
        try {
          const results = await Promise.all(
            environments.map(async (environment) => {
              try {
                const list = await run<UserDesktopList>(environment.environmentId, {
                  request: { operation: "list" },
                });
                const desktops = await Promise.all(
                  list.desktops.map(async (desktop): Promise<UserDesktopEntry> => {
                    if (desktop.connectionState !== "online") {
                      return { environmentId: environment.environmentId, desktop, status: null };
                    }
                    try {
                      const status = await run<ComputerAutomationStatus>(
                        environment.environmentId,
                        {
                          request: {
                            operation: "status",
                            desktopId: desktop.desktop.desktopId,
                          },
                        },
                      );
                      return { environmentId: environment.environmentId, desktop, status };
                    } catch {
                      return { environmentId: environment.environmentId, desktop, status: null };
                    }
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
    async (entry: UserDesktopEntry, operation: PendingRequest["operation"]) => {
      const request = {
        environmentId: entry.environmentId,
        desktopId: entry.desktop.desktop.desktopId,
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

  const saveRename = useCallback(
    async (entry: UserDesktopEntry) => {
      const label = editingLabel.trim();
      if (label.length === 0) return;
      setError(null);
      try {
        await run(entry.environmentId, {
          request: {
            operation: "rename",
            input: { desktopId: entry.desktop.desktop.desktopId, label },
          },
        });
        setEditingKey(null);
        await refresh(true, true);
      } catch (cause) {
        setError(failureMessage(cause));
      }
    },
    [editingLabel, refresh, run],
  );

  const confirmRemove = useCallback(async () => {
    const entry = removeEntry;
    if (entry === null) return;
    setError(null);
    try {
      await run(entry.environmentId, {
        request: {
          operation: "remove",
          input: { desktopId: entry.desktop.desktop.desktopId },
        },
      });
      setRemoveEntry(null);
      await refresh(true, true);
    } catch (cause) {
      setError(failureMessage(cause));
    }
  }, [refresh, removeEntry, run]);

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
                : pending.operation === "release"
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
        {loading && entries.length === 0 ? (
          <div role="status" className="rounded-xl border border-dashed px-5 py-10 text-center">
            <RefreshCwIcon className="mx-auto mb-3 size-6 animate-spin text-muted-foreground" />
            <p className="font-medium">Loading user desktops…</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-xl border border-dashed px-5 py-10 text-center">
            <MonitorIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
            <p className="font-medium">No user desktops known</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start a current T3 desktop client connected to this environment.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {entries.map((entry) => {
              const desktop = entry.desktop;
              const desktopId = desktop.desktop.desktopId;
              const key = entryKey(entry);
              const busy = pending !== null;
              const remembered = entry.status?.rememberedAccess ?? [];
              const supportsView = desktop.capabilities.includes("view");
              const supportsControl = desktop.capabilities.includes("control");
              const environment = environmentById.get(entry.environmentId);
              return (
                <Card key={key}>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      {desktop.label}
                      <Badge
                        variant={
                          desktop.connectionState === "online"
                            ? "default"
                            : desktop.connectionState === "identity-conflict"
                              ? "error"
                              : "secondary"
                        }
                      >
                        {connectionLabel(desktop.connectionState)}
                      </Badge>
                      {desktop.t3Focused ? <Badge variant="secondary">T3 focused</Badge> : null}
                    </CardTitle>
                    <CardDescription>
                      {environment?.label ?? "Unknown environment"} ·{" "}
                      {platformLabel(desktop.platform)}
                      {" · "}seen {formatRelativeTimeLabel(desktop.lastSeenAt)}
                    </CardDescription>
                    <CardAction>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Rename ${desktop.label}`}
                        onClick={() => {
                          setEditingKey(key);
                          setEditingLabel(desktop.label);
                        }}
                      >
                        <PencilIcon />
                      </Button>
                    </CardAction>
                  </CardHeader>
                  <CardPanel className="grid gap-3">
                    {editingKey === key ? (
                      <div className="flex gap-2">
                        <Input
                          value={editingLabel}
                          maxLength={256}
                          aria-label="User desktop name"
                          onChange={(event) => setEditingLabel(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void saveRename(entry);
                            if (event.key === "Escape") setEditingKey(null);
                          }}
                        />
                        <Button onClick={() => void saveRename(entry)}>Save</Button>
                        <Button variant="ghost" onClick={() => setEditingKey(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>
                        View: {remembered.includes("view") ? "remembered" : "ask each time"}
                      </span>
                      <span>
                        Control: {remembered.includes("control") ? "remembered" : "ask each time"}
                      </span>
                      <span className="font-mono">{desktopId}</span>
                    </div>
                    {desktop.connectionState === "identity-conflict" ? (
                      <Alert variant="error">
                        <AlertDescription>
                          Multiple connected clients claim this identity. Computer use is blocked
                          until only the original desktop remains connected.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    {desktop.connectionState === "online" && !supportsView ? (
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
                        disabled={busy || desktop.connectionState !== "online" || !supportsView}
                        onClick={() => void performAccessAction(entry, "remember-view")}
                      >
                        <EyeIcon />
                        Remember view
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || desktop.connectionState !== "online" || !supportsControl}
                        onClick={() => void performAccessAction(entry, "remember-control")}
                      >
                        <KeyboardIcon />
                        Remember control
                      </Button>
                      {desktop.connectionState === "online" && supportsView ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void performAccessAction(entry, "release")}
                        >
                          {pending?.desktopId === desktopId && pending.operation === "release"
                            ? "Ending access…"
                            : "End all access"}
                        </Button>
                      ) : null}
                      {remembered.length > 0 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void performAccessAction(entry, "forget")}
                        >
                          <ShieldOffIcon />
                          {pending?.desktopId === desktopId && pending.operation === "forget"
                            ? "Forgetting…"
                            : "Forget approval"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={desktop.connectionState !== "offline"}
                        onClick={() => setRemoveEntry(entry)}
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

      <AlertDialog
        open={removeEntry !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveEntry(null);
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

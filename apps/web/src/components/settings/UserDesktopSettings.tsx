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

interface UserDesktopGroup {
  readonly desktopId: string;
  readonly routes: ReadonlyArray<UserDesktopEntry>;
  readonly primary: UserDesktopEntry;
  readonly connectionState: UserDesktopView["connectionState"];
  readonly hasIdentityConflict: boolean;
  readonly t3Focused: boolean;
  readonly rememberedAccess: ComputerAutomationStatus["rememberedAccess"];
}

interface PendingRequest {
  readonly environmentId: EnvironmentId;
  readonly desktopId: string;
  readonly label: string;
  readonly operation: "remember-view" | "remember-control" | "end-all-access" | "forget";
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
  const [removeGroup, setRemoveGroup] = useState<UserDesktopGroup | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);

  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
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
              const environmentLabels = [
                ...new Set(
                  group.routes.map(
                    (route) =>
                      environmentById.get(route.environmentId)?.label ?? "Unknown environment",
                  ),
                ),
              ];
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
                    </CardTitle>
                    <CardDescription>
                      {environmentLabels.length === 1
                        ? environmentLabels[0]
                        : `Available through ${environmentLabels.join(", ")}`}{" "}
                      · {platformLabel(desktop.platform)}
                      {" · "}seen {formatRelativeTimeLabel(desktop.lastSeenAt)}
                    </CardDescription>
                    <CardAction>
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

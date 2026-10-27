import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ComputerAutomationStatus,
  EnvironmentId,
  UserDesktopHumanInvokeInput,
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
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentsWithScope } from "~/state/session";
import { useStableCallback } from "~/hooks/useStableCallback";
import { userDesktopListingAtom } from "./userDesktopListing";
import { groupEntries, type UserDesktopGroup } from "./userDesktopListingState";

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

interface PendingRequest {
  readonly environmentId: EnvironmentId;
  readonly desktopId: string;
  readonly label: string;
  readonly operation: "remember-view" | "remember-control" | "end-all-access" | "forget";
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
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const listingAtom = userDesktopListingAtom(JSON.stringify(Array.from(operable).sort()));
  const listing = useAtomValue(listingAtom);
  const entries = AsyncResult.isSuccess(listing) ? listing.value.entries : [];
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

  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const desktopGroups = groupEntries(entries);

  const run = async <Value,>(environmentId: EnvironmentId, input: UserDesktopHumanInvokeInput) => {
    const result = await invoke({ environmentId, input });
    if (result._tag === "Success") return result.value as Value;
    throw squashAtomCommandFailure(result);
  };

  const refresh = useStableCallback(() => appAtomRegistry.refresh(listingAtom));

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
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {environmentLabels.length === 1
                          ? environmentLabels[0]
                          : `Available through ${environmentLabels.join(", ")}`}{" "}
                        · {platformLabel(desktop.platform)}
                        {" · "}seen {formatRelativeTimeLabel(desktop.lastSeenAt)}
                      </p>
                    </div>
                    <div>
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

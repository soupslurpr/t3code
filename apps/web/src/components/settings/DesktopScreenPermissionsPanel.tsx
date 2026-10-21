import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ComputerAutomationStatus,
  type DesktopScreenAuthorization,
  type DesktopScreenPendingApproval,
  type DesktopCapabilityGrant,
  type DesktopGrantScope,
  type DesktopGrantLifetime,
  type EnvironmentId,
  type ThreadId,
  type UserDesktopHumanRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";

const decode = Schema.decodeUnknownSync(ComputerAutomationStatus);
export function DesktopScreenPermissionsPanel({
  environmentId,
  desktopId,
  desktopLabel,
  threadId,
}: {
  environmentId: EnvironmentId;
  desktopId: string;
  desktopLabel: string;
  threadId?: ThreadId | undefined;
}) {
  const invoke = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, {
    reportFailure: false,
  });
  const allowed = useAtomValue(
    previewEnvironment.invokeUserDesktopHuman.permissionAtom(environmentId, {
      request: { operation: "screen-permission", action: "status", desktopId },
    }),
  );
  const [status, setStatus] = useState<DesktopScreenAuthorization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deadline, setDeadline] = useState(() => new Date(Date.now() + 86_400_000).toISOString());
  const [selected, setSelected] = useState<{
    capability: "view" | "control";
    grant?: DesktopCapabilityGrant;
  } | null>(null);
  const [scope, setScope] = useState<DesktopGrantScope>(threadId ? "thread" : "environment");
  const [lifetime, setLifetime] = useState<DesktopGrantLifetime>(
    threadId ? "automatic" : "until-time",
  );
  const [remembered, setRemembered] = useState(false);
  const choose = (capability: "view" | "control", grant?: DesktopCapabilityGrant) => {
    setSelected({ capability, ...(grant ? { grant } : {}) });
    setScope(grant?.scope ?? (threadId ? "thread" : "environment"));
    setLifetime(grant?.lifetime ?? (threadId ? "automatic" : "until-time"));
    setRemembered(grant?.remembered ?? false);
    if (grant?.deadline) setDeadline(grant.deadline);
  };
  const run = async (request: UserDesktopHumanRequest, source = threadId) => {
    const result = await invoke({
      environmentId,
      input: { request, ...(source ? { threadId: source } : {}), timeoutMs: 120_000 },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const act = async (request?: UserDesktopHumanRequest, source = threadId) => {
    setBusy(true);
    setError(null);
    try {
      if (request) {
        await run(request, source);
        setSelected(null);
      }
      setStatus(decode(await run({ operation: "status", desktopId })).authorization ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screen permission request failed.");
    } finally {
      setBusy(false);
    }
  };
  const approve = (request: DesktopScreenPendingApproval) =>
    void act(
      {
        operation: "screen-permission",
        desktopId,
        action: "approve",
        requestId: request.requestId,
        policy: {
          scope: "thread",
          lifetime: request.proposedPolicy.lifetime === "automatic" ? "automatic" : "until-time",
          remembered: false,
          deadline: request.proposedPolicy.lifetime === "automatic" ? null : deadline,
        },
      },
      request.threadId,
    );
  const policy = (capability: "view" | "control", grant?: DesktopCapabilityGrant) =>
    void act(
      {
        operation: "screen-permission",
        desktopId,
        action: grant ? "edit" : "request",
        capability,
        ...(grant?.scope === "desktop" ? { localPrompt: true } : {}),
        ...(grant ? { permission: { grantId: grant.grantId, revision: grant.revision } } : {}),
        policy: {
          scope,
          lifetime,
          remembered,
          deadline: lifetime === "until-time" ? deadline : null,
        },
      },
      grant?.threadId ?? threadId,
    );
  return (
    <details
      className="rounded-lg border p-3"
      onToggle={(event) => {
        if (event.currentTarget.open) void act();
      }}
    >
      <summary className="cursor-pointer text-sm font-medium">Screen permissions</summary>
      <div className="mt-3 grid gap-2 text-xs">
        <p>
          View and control are separate from command execution and operating-system consent.{" "}
          {status?.remoteApprovalAvailable
            ? "You can approve this environment’s screen permissions here."
            : "Approval appears on the selected desktop."}
        </p>
        {error ? <p role="alert">{error}</p> : null}
        {status === null ? (
          <p>Scoped screen permissions require a compatible desktop.</p>
        ) : (
          <>
            <p>
              {threadId
                ? "New permissions cover this thread, expire automatically, and end when T3 quits."
                : "New permissions cover this environment until the time below and end when T3 quits."}
            </p>
            <p>
              Automatic access expires 15 minutes after settlement, after 24 hours without task
              activity, or after seven days.
            </p>
            {status.pendingRequests
              ?.filter((item) => !threadId || item.threadId === threadId)
              .map((item) => (
                <div key={item.requestId} className="grid gap-1 rounded-md border p-2">
                  <p>
                    {item.capability === "control"
                      ? "Screen viewing and control"
                      : "Screen viewing"}{" "}
                    requested by {item.source?.threadTitle || item.threadId}
                  </p>
                  <p>
                    {item.source?.projectName ? `${item.source.projectName} · ` : ""}
                    {item.source?.environmentLabel || item.environmentId} → {desktopLabel}
                  </p>
                  <p>
                    This thread only ·{" "}
                    {item.proposedPolicy.lifetime === "automatic"
                      ? "Automatic temporary access"
                      : `Until ${deadline}`}{" "}
                    · Ends when T3 quits
                  </p>
                  <details>
                    <summary>Request details</summary>
                    <p>
                      Thread: {item.threadId}
                      <br />
                      Environment: {item.environmentId}
                    </p>
                  </details>
                  {status.remoteApprovalAvailable && !item.requiresLocalApproval ? (
                    <div className="flex gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || !allowed || !Number.isFinite(Date.parse(deadline))}
                        onClick={() => approve(item)}
                      >
                        Approve request
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy || !allowed}
                        onClick={() =>
                          void act(
                            {
                              operation: "screen-permission",
                              desktopId,
                              action: "deny",
                              requestId: item.requestId,
                            },
                            item.threadId,
                          )
                        }
                      >
                        Deny
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            <label>
              Until-time proposal{" "}
              <input
                aria-label="Screen permission deadline"
                value={deadline}
                onChange={(event) => setDeadline(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !allowed || !Number.isFinite(Date.parse(deadline))}
                onClick={() => choose("view")}
              >
                Allow viewing
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !allowed || !Number.isFinite(Date.parse(deadline))}
                onClick={() => choose("control")}
              >
                Allow viewing and control
              </Button>
            </div>
            {selected ? (
              <div className="grid gap-2 rounded-md border p-3">
                <p>
                  {selected.capability === "control"
                    ? "Screen viewing and control"
                    : "Screen viewing"}{" "}
                  ·{" "}
                  {selected.grant?.source?.threadTitle ||
                    (selected.grant?.threadId
                      ? `Thread ${selected.grant.threadId}`
                      : threadId
                        ? "This thread"
                        : "This environment")}
                </p>
                <select
                  aria-label="Screen permission scope"
                  value={scope}
                  disabled={busy || selected.grant !== undefined}
                  onChange={(event) => {
                    const next = event.target.value as DesktopGrantScope;
                    setScope(next);
                    if (next !== "thread" && lifetime === "automatic") setLifetime("until-time");
                  }}
                >
                  {threadId || selected.grant?.threadId ? (
                    <option value="thread">This thread</option>
                  ) : null}
                  <option value="environment">This environment</option>
                  {selected.grant?.scope === "desktop" ? (
                    <option value="desktop">All environments</option>
                  ) : null}
                </select>
                <select
                  aria-label="Screen permission lifetime"
                  value={lifetime}
                  disabled={busy}
                  onChange={(event) => setLifetime(event.target.value as DesktopGrantLifetime)}
                >
                  {scope === "thread" ? (
                    <option value="automatic">Automatic temporary access</option>
                  ) : null}
                  <option value="until-time">Until the time above</option>
                  <option value="until-revoked">Until revoked</option>
                </select>
                <label>
                  <input
                    type="checkbox"
                    checked={remembered}
                    disabled={busy}
                    onChange={(event) => setRemembered(event.target.checked)}
                  />{" "}
                  Remember across restart
                </label>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      busy ||
                      !allowed ||
                      (lifetime === "until-time" && !Number.isFinite(Date.parse(deadline)))
                    }
                    onClick={() => policy(selected.capability, selected.grant)}
                  >
                    {status.remoteApprovalAvailable && scope !== "desktop"
                      ? "Confirm permission"
                      : "Request approval on desktop"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setSelected(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {status.grants
              .filter((grant) => !threadId || !grant.threadId || grant.threadId === threadId)
              .map((grant) => (
                <div key={grant.grantId} className="grid gap-1">
                  <p>
                    {grant.capability} ·{" "}
                    {grant.scope === "desktop"
                      ? "All environments"
                      : grant.threadId
                        ? `Thread ${grant.source?.threadTitle || grant.threadId}`
                        : `Environment ${grant.source?.environmentLabel || grant.environmentId}`}{" "}
                    ·{" "}
                    {grant.expiresAt
                      ? `Expires ${new Date(grant.expiresAt).toLocaleString()}`
                      : "Until revoked"}{" "}
                    · {grant.remembered ? "Remembered" : "Ends when T3 quits"}
                    {grant.suspended ? " · Needs fresh approval" : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy || !allowed || !Number.isFinite(Date.parse(deadline))}
                      onClick={() =>
                        choose(grant.capability === "control" ? "control" : "view", grant)
                      }
                    >
                      Change permission
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy || !allowed}
                      onClick={() =>
                        void act(
                          {
                            operation: "screen-permission",
                            desktopId,
                            action: "remove",
                            localPrompt: grant.scope === "desktop",
                            capability: grant.capability === "control" ? "control" : "view",
                            permission: { grantId: grant.grantId, revision: grant.revision },
                          },
                          grant.threadId ?? threadId,
                        )
                      }
                    >
                      Remove permission
                    </Button>
                  </div>
                </div>
              ))}
            <p>Removing one permission leaves any independent covering permissions in effect.</p>
          </>
        )}
        <Button size="xs" variant="ghost" disabled={busy || !allowed} onClick={() => void act()}>
          Refresh permissions
        </Button>
      </div>
    </details>
  );
}

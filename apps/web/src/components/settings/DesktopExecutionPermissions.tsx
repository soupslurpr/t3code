import type {
  DesktopExecutionAccess,
  DesktopExecutionGrant,
  DesktopGrantLifetime,
  DesktopGrantScope,
  DesktopProcess,
  EnvironmentId,
  ThreadId,
  UserDesktopExecutionAccessInput,
  UserDesktopTarget,
} from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

/** A policy decision names its source, lifetime and affected work before submission. */
export function DesktopExecutionPermissions({
  access,
  desktop,
  threadId,
  local = false,
  affectedWork,
  busy,
  submit,
}: {
  access: DesktopExecutionAccess;
  desktop: UserDesktopTarget;
  threadId?: ThreadId | undefined;
  local?: boolean;
  affectedWork: (grant: DesktopExecutionGrant) => Promise<readonly DesktopProcess[]>;
  busy: boolean;
  submit: (
    input: UserDesktopExecutionAccessInput,
    threadId?: ThreadId,
    environmentId?: EnvironmentId,
  ) => void;
}) {
  const [scope, setScope] = useState<DesktopGrantScope>(threadId ? "thread" : "environment");
  const [lifetime, setLifetime] = useState<DesktopGrantLifetime>(
    threadId ? "automatic" : "until-time",
  );
  const [deadline, setDeadline] = useState(tomorrow);
  const [remembered, setRemembered] = useState(false);
  const [editing, setEditing] = useState<DesktopExecutionGrant | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<DesktopExecutionGrant | null>(null);
  const [stopWork, setStopWork] = useState(true);
  const request = access.pendingRequests?.find((item) => item.requestId === requestId);
  const sourceThreadId = request?.threadId ?? editing?.threadId ?? threadId;
  const sourceEnvironmentId = request?.environmentId ?? editing?.environmentId ?? undefined;
  const canManage = local || access.remoteApprovalAvailable === true;
  const grants = access.grants.filter(
    (grant) => threadId === undefined || grant.threadId === threadId || grant.scope !== "thread",
  );
  const existingPolicy =
    !local && !editing && !request
      ? grants.find(
          (grant) =>
            grant.scope === scope && (scope !== "thread" || grant.threadId === sourceThreadId),
        )
      : undefined;
  const [affected, setAffected] = useState<readonly DesktopProcess[]>([]);
  const [loadedGrantId, setLoadedGrantId] = useState<string | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const inspectRevoke = (grant: DesktopExecutionGrant) => {
    setRevoke(grant);
    setStopWork(true);
    setLoadedGrantId(null);
    setWorkError(null);
    void affectedWork(grant)
      .then((jobs) => {
        setAffected(jobs);
        setLoadedGrantId(grant.grantId);
      })
      .catch((cause: unknown) =>
        setWorkError(cause instanceof Error ? cause.message : "Could not read affected work."),
      );
  };
  const chooseGrant = (grant: DesktopExecutionGrant) => {
    setEditing(grant);
    setRequestId(null);
    setScope(grant.scope);
    setLifetime(grant.lifetime);
    setDeadline(grant.absoluteExpiresAt ?? tomorrow());
    setRemembered(grant.remembered);
  };
  return (
    <div className="grid gap-3 text-xs">
      <p>
        Runs as {access.user}.{" "}
        {local
          ? "You can manage command permissions for every source on this desktop."
          : canManage
            ? "You can approve this environment’s commands here."
            : "Approval will appear on the selected desktop."}{" "}
        Commands and transfers can access this account’s files. Expiry leaves running commands
        intact.
      </p>
      {access.pendingRequests
        ?.filter((item) => threadId === undefined || item.threadId === threadId)
        .map((item) => (
          <div key={item.requestId} className="flex flex-wrap items-center gap-2">
            <span>
              Permission requested by thread {item.threadId}
              {local ? ` · Environment ${item.environmentId}` : ""}
            </span>
            {canManage ? (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setRequestId(item.requestId);
                    setEditing(null);
                    setScope(
                      item.proposedPolicy.scope === "desktop" && !local
                        ? "thread"
                        : item.proposedPolicy.scope,
                    );
                    setLifetime(item.proposedPolicy.lifetime);
                    setDeadline(item.proposedPolicy.deadline ?? tomorrow());
                    setRemembered(false);
                  }}
                >
                  Review request
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    submit(
                      { action: "deny", desktop, requestId: item.requestId },
                      item.threadId,
                      item.environmentId,
                    )
                  }
                >
                  Deny
                </Button>
              </>
            ) : null}
          </div>
        ))}
      {!local || editing || request ? (
        <div className="flex flex-wrap items-center gap-2">
          {local && sourceEnvironmentId ? <p>Environment {sourceEnvironmentId}</p> : null}
          <select
            aria-label="Command permission scope"
            value={scope}
            disabled={busy || editing !== null}
            onChange={(event) => {
              const next = event.target.value as DesktopGrantScope;
              setScope(next);
              if (next !== "thread" && lifetime === "automatic") setLifetime("until-time");
            }}
          >
            {sourceThreadId ? <option value="thread">This thread</option> : null}
            <option value="environment">This environment</option>
            {local || editing?.scope === "desktop" ? (
              <option value="desktop">All environments</option>
            ) : null}
          </select>
          <select
            aria-label="Command permission lifetime"
            value={lifetime}
            disabled={busy}
            onChange={(event) => setLifetime(event.target.value as DesktopGrantLifetime)}
          >
            {scope === "thread" ? (
              <option value="automatic">Automatic temporary access</option>
            ) : null}
            <option value="until-time">Until a time</option>
            <option value="until-revoked">Until revoked</option>
          </select>
          {lifetime === "until-time" ? (
            <label>
              Expires{" "}
              <input
                aria-label="Command permission expiry"
                type="datetime-local"
                value={new Date(
                  Date.parse(deadline) - new Date(deadline).getTimezoneOffset() * 60_000,
                )
                  .toISOString()
                  .slice(0, 16)}
                onChange={(event) => {
                  if (event.target.value) setDeadline(new Date(event.target.value).toISOString());
                }}
              />
            </label>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={remembered}
              disabled={busy}
              onChange={(event) => setRemembered(event.target.checked)}
            />{" "}
            Remember across restart
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (requestId !== null && request === undefined)}
            onClick={() => {
              if (existingPolicy) return chooseGrant(existingPolicy);
              submit(
                {
                  action: request ? "approve" : "edit",
                  desktop,
                  scope,
                  lifetime,
                  remembered,
                  ...(lifetime === "until-time" ? { deadline } : {}),
                  ...(request ? { requestId: request.requestId } : {}),
                  ...(editing
                    ? {
                        grantId: editing.grantId,
                        revision: editing.revision,
                        localPrompt: !local && editing.scope === "desktop",
                      }
                    : {}),
                },
                sourceThreadId ?? undefined,
                sourceEnvironmentId,
              );
            }}
          >
            {request
              ? "Approve request"
              : editing
                ? "Save policy"
                : existingPolicy
                  ? "Edit existing permission"
                  : canManage
                    ? "Allow commands"
                    : "Request local approval"}
          </Button>
          {editing || requestId ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setEditing(null);
                setRequestId(null);
                setScope(threadId ? "thread" : "environment");
                setLifetime(threadId ? "automatic" : "until-time");
                setRemembered(false);
              }}
            >
              {local ? "Cancel edit" : "New permission"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {lifetime === "automatic" && (!local || editing || request) ? (
        <p>
          Expires 15 minutes after settlement, after 24 hours without task activity, or seven days
          after approval.
        </p>
      ) : null}
      {grants.map((grant) => (
        <div key={grant.grantId} className="flex flex-wrap items-center gap-2">
          <span>
            {grant.grantId === access.selectedGrantId ? "Selected · " : ""}
            {grant.scope === "desktop"
              ? "All environments"
              : grant.scope === "environment"
                ? local
                  ? `Environment ${grant.environmentId}`
                  : "This environment"
                : `Thread ${grant.threadId}`}{" "}
            {local && grant.scope === "thread" ? `· Environment ${grant.environmentId} ` : ""}·{" "}
            {grant.expiresAt !== null
              ? `Expires ${new Date(grant.expiresAt).toLocaleString()}`
              : "Until revoked"}{" "}
            · {grant.remembered ? "Remembered" : "Ends when T3 Code quits"}
            {grant.suspended ? " · Needs fresh approval" : ""}
            {grant.migrated ? " · Migrated permission" : ""}
          </span>
          {
            <>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => chooseGrant(grant)}>
                Change policy
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  inspectRevoke(grant);
                }}
              >
                Remove
              </Button>
            </>
          }
        </div>
      ))}
      {revoke ? (
        <div className="grid gap-2 rounded-md border p-3">
          {workError ? <p role="alert">{workError}</p> : null}
          {loadedGrantId !== revoke.grantId ? <p>Reading affected work…</p> : null}
          {revoke.scope === "desktop" && !local ? (
            <p>The native confirmation includes work from all environments.</p>
          ) : null}
          <p>
            Remove {revoke.scope} permission? {affected.length} running command
            {affected.length === 1 ? "" : "s"} and any transfers accepted under this permission are
            affected.
          </p>
          {access.activeTransfers
            ?.filter((transfer) => transfer.grantId === revoke.grantId)
            .map((transfer) => (
              <p key={transfer.transferId}>
                Transfer {transfer.transferId} · Thread {transfer.threadId}
              </p>
            ))}
          {affected.map((process) => (
            <code key={process.processId}>
              {process.executable} · {process.commandId}
            </code>
          ))}
          {grants.some(
            (grant) =>
              grant.grantId !== revoke.grantId &&
              (grant.scope === "desktop" ||
                (grant.scope === "environment" &&
                  revoke.scope === "thread" &&
                  grant.environmentId === revoke.environmentId)),
          ) ? (
            <p>A broader permission remains and can still allow access.</p>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={stopWork}
              onChange={(event) => setStopWork(event.target.checked)}
            />{" "}
            Stop commands and transfers accepted under this permission
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || loadedGrantId !== revoke.grantId}
              onClick={() => {
                submit(
                  {
                    action: "revoke",
                    desktop,
                    grantId: revoke.grantId,
                    revision: revoke.revision,
                    stopProcesses: stopWork,
                    localPrompt: !local && revoke.scope === "desktop",
                  },
                  revoke.threadId ?? undefined,
                  revoke.environmentId ?? undefined,
                );
                setRevoke(null);
              }}
            >
              Confirm removal
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevoke(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

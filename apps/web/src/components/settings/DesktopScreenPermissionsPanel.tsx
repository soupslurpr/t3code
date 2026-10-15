import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ComputerAutomationStatus,
  type DesktopCapabilityGrant,
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
/** Graphical policy decisions always go to the selected desktop's local prompt. */
export function DesktopScreenPermissionsPanel({
  environmentId,
  desktopId,
  threadId,
}: {
  environmentId: EnvironmentId;
  desktopId: string;
  threadId?: ThreadId | undefined;
}) {
  const invoke = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, {
    reportFailure: false,
  });
  const allowed = useAtomValue(
    previewEnvironment.invokeUserDesktopHuman.permissionAtom(environmentId, {
      request: { operation: "status", desktopId },
    }),
  );
  const [status, setStatus] = useState<ComputerAutomationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deadline, setDeadline] = useState(() => new Date(Date.now() + 86_400_000).toISOString());
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
      if (request) await run(request, source);
      setStatus(decode(await run({ operation: "status", desktopId })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screen permission request failed.");
    } finally {
      setBusy(false);
    }
  };
  const policy = (capability: "view" | "control", grant?: DesktopCapabilityGrant) =>
    void act(
      {
        operation: "screen-permission",
        desktopId,
        action: grant ? "edit" : "request",
        capability,
        ...(grant ? { permission: { grantId: grant.grantId, revision: grant.revision } } : {}),
        policy: {
          scope: grant?.scope ?? (threadId ? "thread" : "environment"),
          lifetime: grant?.lifetime ?? (threadId ? "automatic" : "until-time"),
          remembered: grant?.remembered ?? false,
          deadline:
            (grant?.lifetime ?? (threadId ? "automatic" : "until-time")) === "until-time"
              ? deadline
              : null,
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
          View and control are separate from command execution and operating-system consent. Policy
          changes require confirmation on this desktop.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        {status?.authorization === undefined ? (
          <p>Scoped screen permissions require a compatible desktop.</p>
        ) : (
          <>
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
                onClick={() => policy("view")}
              >
                Choose view policy
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !allowed || !Number.isFinite(Date.parse(deadline))}
                onClick={() => policy("control")}
              >
                Choose control policy
              </Button>
            </div>
            {status.authorization.grants
              .filter((grant) => !threadId || !grant.threadId || grant.threadId === threadId)
              .map((grant) => (
                <div key={grant.grantId} className="grid gap-1">
                  <p>
                    {grant.capability} ·{" "}
                    {grant.scope === "desktop"
                      ? "All environments"
                      : grant.threadId
                        ? `Thread ${grant.threadId}`
                        : `Environment ${grant.environmentId}`}{" "}
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
                        policy(grant.capability === "control" ? "control" : "view", grant)
                      }
                    >
                      Change on desktop
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
                            capability: grant.capability === "control" ? "control" : "view",
                            permission: { grantId: grant.grantId, revision: grant.revision },
                          },
                          grant.threadId ?? threadId,
                        )
                      }
                    >
                      Remove on desktop
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

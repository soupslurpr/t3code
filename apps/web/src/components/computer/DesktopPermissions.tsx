import { Checkbox } from "../ui/checkbox";
import { useDesktopLabels } from "./desktopLabels";
import {
  DesktopExecutionAccess,
  DesktopScreenAuthorization,
  type DesktopCapabilityGrant,
  type DesktopGrantLifetime,
  type DesktopGrantPolicy,
  type DesktopGrantScope,
  type DesktopScreenPermissionRequest,
  type UserDesktopExecutionAccessInput,
  type UserDesktopHumanRequest,
  type UserDesktopTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useState } from "react";
import { Input } from "../ui/input";
import { GuardedAction, DesktopError, DesktopSection, DesktopSelect } from "./DesktopControls";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useDesktopRead, type DesktopClient } from "./desktopClient";

type Capability = DesktopCapabilityGrant["capability"];
type Client = DesktopClient<UserDesktopHumanRequest>;
const screenSchema = Schema.NullOr(DesktopScreenAuthorization);

export function executionAccess(
  desktop: UserDesktopTarget,
  input: Omit<UserDesktopExecutionAccessInput, "desktop">,
): UserDesktopHumanRequest {
  return {
    operation: "execution",
    input: { operation: "access", desktop, input: { ...input, desktop } },
  };
}

function policyRequest(
  desktop: UserDesktopTarget,
  capability: Capability,
  policy: DesktopGrantPolicy,
  grant?: DesktopCapabilityGrant,
): UserDesktopHumanRequest {
  const action = grant ? "edit" : "request";
  const localPrompt = policy.scope === "desktop" || grant?.scope === "desktop";
  return capability === "execution"
    ? executionAccess(desktop, {
        action,
        ...policy,
        deadline: policy.deadline ?? undefined,
        localPrompt,
        ...(grant ? { grantId: grant.grantId, revision: grant.revision } : {}),
      })
    : {
        operation: "screen-permission",
        desktopId: desktop.desktopId,
        action,
        capability,
        policy,
        localPrompt,
        ...(grant ? { permission: { grantId: grant.grantId, revision: grant.revision } } : {}),
      };
}

function GrantForm({
  client,
  desktop,
  initial,
  onSave,
  capabilities,
}: {
  client: Client;
  desktop: UserDesktopTarget;
  initial?: DesktopCapabilityGrant;
  onSave: () => void;
  capabilities: readonly Capability[];
}) {
  const gt = useGT();
  const [capability, setCapability] = useState<Capability>(
    initial?.capability ?? capabilities[0] ?? "view",
  );
  const [scope, setScope] = useState<DesktopGrantScope>(
    initial?.scope ?? (client.threadId ? "thread" : "environment"),
  );
  const [lifetime, setLifetime] = useState<DesktopGrantLifetime>(initial?.lifetime ?? "until-time");
  const [remembered, setRemembered] = useState(initial?.remembered ?? false);
  const nowMinute = useNowMinute();
  const [deadline, setDeadline] = useState(() => {
    if (initial && !initial.deadline && initial.lifetime !== "until-time") return "";
    const date = new Date(initial?.deadline ?? Date.now() + 3_600_000);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const time = new Date(deadline).getTime();
  const policy = {
    scope,
    lifetime,
    remembered,
    deadline: Number.isFinite(time) ? new Date(time).toISOString() : null,
  };
  return (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="grid gap-1">
        {gt("Permission")}
        <DesktopSelect
          label={gt("Permission")}
          value={capability}
          disabled={!!initial}
          onChange={setCapability}
          options={(initial ? [initial.capability] : capabilities).map((cap) => [
            cap,
            cap === "view" ? gt("View") : cap === "control" ? gt("Control") : gt("Commands"),
          ])}
        />
      </label>
      <label className="grid gap-1">
        {gt("Scope")}
        <DesktopSelect
          label={gt("Scope")}
          value={scope}
          onChange={setScope}
          options={[
            ...(client.threadId || initial?.scope === "thread"
              ? [["thread", gt("Thread")] as const]
              : []),
            ["environment", gt("Environment")],
            ["desktop", gt("All environments")],
          ]}
        />
      </label>
      <label className="grid gap-1">
        {gt("Duration")}
        <DesktopSelect
          label={gt("Duration")}
          value={lifetime}
          onChange={(next) => {
            setLifetime(next);
            if (next !== "until-time") setDeadline("");
          }}
          options={[
            ["automatic", gt("Automatic")],
            ["until-time", gt("Until a time")],
            ["until-revoked", gt("Until revoked")],
          ]}
        />
      </label>
      <label className="grid gap-1">
        {gt("Expires at")}
        <Input
          type="datetime-local"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <Checkbox checked={remembered} onCheckedChange={setRemembered} />{" "}
        {gt("Remember permission")}
      </label>
      <GuardedAction
        client={client}
        request={policyRequest(desktop, capability, policy, initial)}
        onSuccess={onSave}
        disabled={
          (lifetime === "until-time" || deadline !== "") && !(time > Date.parse(nowMinute + "Z"))
        }
      >
        {initial ? gt("Save changes") : gt("Grant permission")}
      </GuardedAction>
    </div>
  );
}

export function DesktopPermissions({
  client,
  desktop,
  capabilities,
}: {
  client: Client;
  desktop: UserDesktopTarget;
  capabilities: readonly Capability[];
}) {
  const gt = useGT();
  const label = useDesktopLabels();
  const [edit, setEdit] = useState<string | null>(null);
  const screen = (input: DesktopScreenPermissionRequest): UserDesktopHumanRequest => ({
    operation: "screen-permission",
    desktopId: desktop.desktopId,
    ...input,
  });
  const screens = useDesktopRead(
    client,
    capabilities.some((cap) => cap !== "execution") ? screen({ action: "status" }) : null,
    screenSchema,
    6000,
  );
  const commands = useDesktopRead(
    client,
    capabilities.includes("execution") ? executionAccess(desktop, { action: "status" }) : null,
    DesktopExecutionAccess,
    6000,
  );
  const grants = [
    ...(screens.data?.grants.filter((g) => g.capability !== "execution") ?? []),
    ...(commands.data?.grants ?? []),
  ];
  const refresh = () => {
    screens.refresh();
    commands.refresh();
    setEdit(null);
  };
  return (
    <DesktopSection title={gt("Permissions")}>
      <DesktopError message={screens.error ?? commands.error} />
      {capabilities.length > 0 && (
        <GrantForm
          key={capabilities.join(",")}
          client={client}
          desktop={desktop}
          capabilities={capabilities}
          onSave={refresh}
        />
      )}
      {grants.map((g) => (
        <div className="grid gap-2 border-t pt-2" key={g.grantId}>
          <p>
            {g.capability === "execution"
              ? gt("Commands")
              : g.capability === "view"
                ? gt("View")
                : gt("Control")}{" "}
            ·{" "}
            {g.scope === "desktop"
              ? gt("All environments")
              : g.scope === "thread"
                ? g.source?.threadTitle || g.threadId
                : g.source?.environmentLabel || g.environmentId}{" "}
            ·{" "}
            {g.expiresAt
              ? new Date(g.expiresAt).toLocaleString()
              : g.lifetime === "until-revoked"
                ? gt("Until revoked")
                : gt("Automatic")}
            {g.suspended && " · " + gt("Suspended")}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setEdit(edit === g.grantId ? null : g.grantId)}
            >
              {gt("Edit")}
            </button>
            <GuardedAction
              client={client}
              destructive
              onSuccess={refresh}
              request={
                g.capability === "execution"
                  ? executionAccess(desktop, {
                      action: "revoke",
                      grantId: g.grantId,
                      revision: g.revision,
                      localPrompt: g.scope === "desktop",
                    })
                  : screen({
                      action: "remove",
                      permission: { grantId: g.grantId, revision: g.revision },
                      localPrompt: g.scope === "desktop",
                    })
              }
            >
              {gt("Revoke")}
            </GuardedAction>
          </div>
          {edit === g.grantId && (
            <GrantForm
              key={g.revision}
              client={client}
              desktop={desktop}
              initial={g}
              onSave={refresh}
              capabilities={capabilities}
            />
          )}
        </div>
      ))}
      {[
        ...(screens.data?.pendingRequests ?? []).map((p) => ({
          ...p,
          remote: screens.data?.remoteApprovalAvailable && !p.requiresLocalApproval,
        })),
        ...(commands.data?.pendingRequests ?? []).map((p) => ({
          ...p,
          capability: "execution" as const,
          remote: commands.data?.remoteApprovalAvailable,
        })),
      ].map((p) => (
        <div key={p.requestId} className="grid gap-2 border-t pt-2">
          <p>
            {p.source?.threadTitle || p.threadId} ·{" "}
            {p.capability === "execution"
              ? gt("Commands")
              : p.capability === "control"
                ? gt("Control")
                : gt("View")}{" "}
            · {label(p.proposedPolicy.scope)} ·{" "}
            {p.proposedPolicy.deadline
              ? new Date(p.proposedPolicy.deadline).toLocaleString()
              : label(p.proposedPolicy.lifetime)}
          </p>
          {p.remote ? (
            <div className="flex gap-2">
              {(["approve", "deny"] as const).map((action) => (
                <GuardedAction
                  key={action}
                  client={client}
                  onSuccess={refresh}
                  request={
                    p.capability === "execution"
                      ? executionAccess(desktop, { action, requestId: p.requestId })
                      : screen({ action, requestId: p.requestId, policy: p.proposedPolicy })
                  }
                >
                  {action === "approve" ? gt("Approve") : gt("Deny")}
                </GuardedAction>
              ))}
            </div>
          ) : (
            <p>{gt("Approve this request on the selected desktop.")}</p>
          )}
        </div>
      ))}
    </DesktopSection>
  );
}

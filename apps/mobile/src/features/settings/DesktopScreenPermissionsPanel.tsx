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
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

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
  const [expanded, setExpanded] = useState(false);
  const [showRequestIds, setShowRequestIds] = useState(false);
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
    return (async () => {
      if (request) {
        await run(request, source);
        setSelected(null);
      }
      setStatus(decode(await run({ operation: "status", desktopId })).authorization ?? null);
    })()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Screen permission request failed.");
      })
      .finally(() => setBusy(false));
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
  const button = (label: string, onPress: () => void, disabled = busy || !allowed) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="p-2 disabled:opacity-40"
    >
      <Text>{label}</Text>
    </Pressable>
  );
  return (
    <View className="gap-2 rounded-xl bg-card p-3">
      {button(
        `${expanded ? "Hide" : "Show"} screen permissions`,
        () => {
          setExpanded(!expanded);
          if (!expanded) void act();
        },
        false,
      )}
      {expanded ? (
        <>
          <Text>
            View and control are separate from command execution and operating-system consent.{" "}
            {status?.remoteApprovalAvailable
              ? "You can approve this environment’s screen permissions here."
              : "Approval appears on the selected desktop."}
          </Text>
          {error ? <Text accessibilityRole="alert">{error}</Text> : null}
          {status === null ? (
            <Text>Scoped screen permissions require a compatible desktop.</Text>
          ) : (
            <>
              <Text>
                {threadId
                  ? "New permissions cover this thread, expire automatically, and end when T3 quits."
                  : "New permissions cover this environment until the time below and end when T3 quits."}
              </Text>
              <Text>
                Automatic access expires 15 minutes after settlement, after 24 hours without task
                activity, or after seven days.
              </Text>
              {status.pendingRequests
                ?.filter((item) => !threadId || item.threadId === threadId)
                .map((item) => (
                  <View key={item.requestId} className="gap-1 rounded-lg bg-subtle p-2">
                    <Text>
                      {item.capability === "control"
                        ? "Screen viewing and control"
                        : "Screen viewing"}{" "}
                      requested by {item.source?.threadTitle || item.threadId}
                    </Text>
                    <Text>
                      {item.source?.projectName ? `${item.source.projectName} · ` : ""}
                      {item.source?.environmentLabel || item.environmentId} → {desktopLabel}
                    </Text>
                    <Text>
                      This thread only ·{" "}
                      {item.proposedPolicy.lifetime === "automatic"
                        ? "Automatic temporary access"
                        : `Until ${deadline}`}{" "}
                      · Ends when T3 quits
                    </Text>
                    {button(showRequestIds ? "Hide request IDs" : "Show request IDs", () =>
                      setShowRequestIds(!showRequestIds),
                    )}
                    {showRequestIds ? (
                      <Text>
                        Thread: {item.threadId}
                        {"\n"}Environment: {item.environmentId}
                      </Text>
                    ) : null}
                    {status.remoteApprovalAvailable && !item.requiresLocalApproval ? (
                      <>
                        {button(
                          "Approve request",
                          () => approve(item),
                          busy || !allowed || !Number.isFinite(Date.parse(deadline)),
                        )}
                        {button(
                          "Deny",
                          () =>
                            void act(
                              {
                                operation: "screen-permission",
                                desktopId,
                                action: "deny",
                                requestId: item.requestId,
                              },
                              item.threadId,
                            ),
                        )}
                      </>
                    ) : null}
                  </View>
                ))}
              <TextInput
                accessibilityLabel="Screen permission deadline"
                value={deadline}
                onChangeText={setDeadline}
                className="rounded-lg bg-subtle p-2 text-foreground"
              />
              {button(
                "Allow viewing",
                () => choose("view"),
                busy || !allowed || !Number.isFinite(Date.parse(deadline)),
              )}
              {button(
                "Allow viewing and control",
                () => choose("control"),
                busy || !allowed || !Number.isFinite(Date.parse(deadline)),
              )}
              {selected ? (
                <View className="gap-2 rounded-lg bg-subtle p-3">
                  <Text>
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
                  </Text>
                  <Text>Scope: {scope}</Text>
                  {!selected.grant ? (
                    <View className="flex-row gap-2">
                      {threadId ? button("This thread", () => setScope("thread")) : null}
                      {button("This environment", () => {
                        setScope("environment");
                        if (lifetime === "automatic") setLifetime("until-time");
                      })}
                    </View>
                  ) : null}
                  <Text>
                    Lifetime:{" "}
                    {lifetime === "automatic"
                      ? "Automatic temporary access"
                      : lifetime === "until-time"
                        ? `Until ${deadline}`
                        : "Until revoked"}
                  </Text>
                  {scope === "thread"
                    ? button("Automatic temporary access", () => setLifetime("automatic"))
                    : null}
                  {button("Until the time above", () => setLifetime("until-time"))}
                  {button("Until revoked", () => setLifetime("until-revoked"))}
                  {button(`${remembered ? "✓ " : ""}Remember across restart`, () =>
                    setRemembered(!remembered),
                  )}
                  {button(
                    status.remoteApprovalAvailable && scope !== "desktop"
                      ? "Confirm permission"
                      : "Request approval on desktop",
                    () => policy(selected.capability, selected.grant),
                    busy ||
                      !allowed ||
                      (lifetime === "until-time" && !Number.isFinite(Date.parse(deadline))),
                  )}
                  {button("Cancel", () => setSelected(null))}
                </View>
              ) : null}
              {status.grants
                .filter((grant) => !threadId || !grant.threadId || grant.threadId === threadId)
                .map((grant) => (
                  <View key={grant.grantId} className="gap-1">
                    <Text>
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
                    </Text>
                    {button(
                      "Change permission",
                      () => choose(grant.capability === "control" ? "control" : "view", grant),
                      busy || !allowed || !Number.isFinite(Date.parse(deadline)),
                    )}
                    {button(
                      "Remove permission",
                      () =>
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
                        ),
                    )}
                  </View>
                ))}
              <Text>
                Removing one permission leaves independent covering permissions in effect.
              </Text>
            </>
          )}
          {button("Refresh permissions", () => void act())}
        </>
      ) : null}
    </View>
  );
}

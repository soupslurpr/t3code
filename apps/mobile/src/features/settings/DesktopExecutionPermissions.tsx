import type {
  DesktopExecutionAccess,
  DesktopExecutionGrant,
  DesktopGrantLifetime,
  DesktopGrantScope,
  DesktopProcess,
  ThreadId,
  UserDesktopExecutionAccessInput,
  UserDesktopTarget,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, Switch, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

export function DesktopExecutionPermissions({
  access,
  desktop,
  threadId,
  affectedWork,
  busy,
  submit,
}: {
  access: DesktopExecutionAccess;
  desktop: UserDesktopTarget;
  threadId?: ThreadId | undefined;
  affectedWork: (grant: DesktopExecutionGrant) => Promise<readonly DesktopProcess[]>;
  busy: boolean;
  submit: (input: UserDesktopExecutionAccessInput, threadId?: ThreadId) => void;
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
  const canManage = access.remoteApprovalAvailable === true;
  const grants = access.grants.filter(
    (grant) => threadId === undefined || grant.threadId === threadId || grant.scope !== "thread",
  );
  const existingPolicy =
    !editing && !request
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
  const action = (label: string, onPress: () => void, disabled = busy) => (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}>
      <Text className="py-2 text-sm text-foreground">{label}</Text>
    </Pressable>
  );
  const chooseGrant = (grant: DesktopExecutionGrant) => {
    setEditing(grant);
    setRequestId(null);
    setScope(grant.scope);
    setLifetime(grant.lifetime);
    setDeadline(grant.absoluteExpiresAt ?? tomorrow());
    setRemembered(grant.remembered);
  };
  return (
    <View className="gap-3">
      <Text className="text-xs text-foreground-muted">
        Runs as {access.user}.{" "}
        {canManage
          ? "You can approve this environment’s commands here."
          : "Approval appears on the selected desktop."}{" "}
        Commands and transfers can access this account’s files. Expiry leaves running commands
        intact.
      </Text>
      {access.pendingRequests
        ?.filter((item) => threadId === undefined || item.threadId === threadId)
        .map((item) => (
          <View key={item.requestId} className="gap-1">
            <Text>Permission requested by thread {item.threadId}</Text>
            {canManage ? (
              <View className="flex-row gap-3">
                {action("Review request", () => {
                  setRequestId(item.requestId);
                  setEditing(null);
                  setScope(
                    item.proposedPolicy.scope === "desktop" ? "thread" : item.proposedPolicy.scope,
                  );
                  setLifetime(item.proposedPolicy.lifetime);
                  setDeadline(item.proposedPolicy.deadline ?? tomorrow());
                  setRemembered(false);
                })}
                {action("Deny", () =>
                  submit({ action: "deny", desktop, requestId: item.requestId }),
                )}
              </View>
            ) : null}
          </View>
        ))}
      <Text className="font-t3-bold">
        {request
          ? `Approve thread ${request.threadId}`
          : editing
            ? "Change permission"
            : "New permission"}
      </Text>
      <View className="flex-row flex-wrap gap-3">
        {sourceThreadId
          ? action(
              `${scope === "thread" ? "✓ " : ""}This thread`,
              () => setScope("thread"),
              busy || editing !== null,
            )
          : null}
        {action(
          `${scope === "environment" ? "✓ " : ""}This environment`,
          () => {
            setScope("environment");
            if (lifetime === "automatic") setLifetime("until-time");
          },
          busy || editing !== null,
        )}
      </View>
      <View className="flex-row flex-wrap gap-3">
        {scope === "thread"
          ? action(`${lifetime === "automatic" ? "✓ " : ""}Automatic temporary access`, () =>
              setLifetime("automatic"),
            )
          : null}
        {action(`${lifetime === "until-time" ? "✓ " : ""}Until a time`, () =>
          setLifetime("until-time"),
        )}
        {action(`${lifetime === "until-revoked" ? "✓ " : ""}Until revoked`, () =>
          setLifetime("until-revoked"),
        )}
      </View>
      {lifetime === "automatic" ? (
        <Text className="text-xs text-foreground-muted">
          Expires 15 minutes after settlement, after 24 hours without task activity, or seven days
          after approval.
        </Text>
      ) : null}
      {lifetime === "until-time" ? (
        <View className="gap-1">
          <Text>Expiry, including time zone</Text>
          <TextInput
            accessibilityLabel="Command permission expiry"
            value={deadline}
            onChangeText={setDeadline}
            autoCapitalize="none"
            className="rounded-lg bg-card p-2 text-foreground"
          />
          <Text className="text-xs text-foreground-muted">
            For example 2026-10-16T18:00:00-07:00
          </Text>
        </View>
      ) : null}
      <View className="flex-row items-center gap-2">
        <Switch
          accessibilityLabel="Remember command permission across restart"
          value={remembered}
          onValueChange={setRemembered}
          disabled={busy}
        />
        <Text>Remember across restart</Text>
      </View>
      {action(
        request
          ? "Approve request"
          : editing
            ? "Save policy"
            : existingPolicy
              ? "Edit existing permission"
              : canManage
                ? "Allow commands"
                : "Request local approval",
        () => {
          if (existingPolicy) return chooseGrant(existingPolicy);
          submit(
            {
              action: request ? "approve" : "edit",
              desktop,
              scope,
              lifetime,
              remembered,
              ...(lifetime === "until-time" ? { deadline: new Date(deadline).toISOString() } : {}),
              ...(request ? { requestId: request.requestId } : {}),
              ...(editing
                ? {
                    grantId: editing.grantId,
                    revision: editing.revision,
                    localPrompt: editing.scope === "desktop",
                  }
                : {}),
            },
            sourceThreadId ?? undefined,
          );
        },
        busy ||
          (lifetime === "until-time" && !Number.isFinite(Date.parse(deadline))) ||
          (requestId !== null && request === undefined),
      )}
      {editing || requestId
        ? action("New permission", () => {
            setEditing(null);
            setRequestId(null);
            setScope(threadId ? "thread" : "environment");
            setLifetime(threadId ? "automatic" : "until-time");
            setRemembered(false);
          })
        : null}
      {grants.map((grant) => (
        <View key={grant.grantId} className="gap-1">
          <Text className="text-xs text-foreground-muted">
            {grant.grantId === access.selectedGrantId ? "Selected · " : ""}
            {grant.scope === "desktop"
              ? "All environments"
              : grant.scope === "environment"
                ? "This environment"
                : `Thread ${grant.threadId}`}{" "}
            ·{" "}
            {grant.expiresAt !== null
              ? `Expires ${new Date(grant.expiresAt).toLocaleString()}`
              : "Until revoked"}{" "}
            · {grant.remembered ? "Remembered" : "Ends when T3 Code quits"}
            {grant.suspended ? " · Needs fresh approval" : ""}
            {grant.migrated ? " · Migrated permission" : ""}
          </Text>
          {
            <View className="flex-row gap-3">
              {action("Change policy", () => chooseGrant(grant))}
              {action("Remove", () => {
                inspectRevoke(grant);
              })}
            </View>
          }
        </View>
      ))}
      {revoke ? (
        <View className="gap-2 rounded-xl bg-card p-3">
          {workError ? <Text accessibilityRole="alert">{workError}</Text> : null}
          {loadedGrantId !== revoke.grantId ? <Text>Reading affected work…</Text> : null}
          {revoke.scope === "desktop" ? (
            <Text>The native confirmation includes work from all environments.</Text>
          ) : null}
          <Text>
            Remove {revoke.scope} permission? {affected.length} running commands and any transfers
            accepted under this permission are affected.
          </Text>
          {access.activeTransfers
            ?.filter((transfer) => transfer.grantId === revoke.grantId)
            .map((transfer) => (
              <Text key={transfer.transferId}>
                Transfer {transfer.transferId} · Thread {transfer.threadId}
              </Text>
            ))}
          {affected.map((process) => (
            <Text key={process.processId}>
              {process.executable} · {process.commandId}
            </Text>
          ))}
          {grants.some(
            (grant) =>
              grant.grantId !== revoke.grantId &&
              (grant.scope === "desktop" ||
                (grant.scope === "environment" && revoke.scope === "thread")),
          ) ? (
            <Text>A broader permission remains and can still allow access.</Text>
          ) : null}
          <View className="flex-row items-center gap-2">
            <Switch
              accessibilityLabel="Stop work when removing permission"
              value={stopWork}
              onValueChange={setStopWork}
            />
            <Text className="flex-1">
              Stop commands and transfers accepted under this permission
            </Text>
          </View>
          {action(
            "Confirm removal",
            () => {
              submit(
                {
                  action: "revoke",
                  desktop,
                  grantId: revoke.grantId,
                  revision: revoke.revision,
                  stopProcesses: stopWork,
                  localPrompt: revoke.scope === "desktop",
                },
                revoke.threadId ?? undefined,
              );
              setRevoke(null);
            },
            busy || loadedGrantId !== revoke.grantId,
          )}
          {action("Cancel", () => setRevoke(null))}
        </View>
      ) : null}
    </View>
  );
}

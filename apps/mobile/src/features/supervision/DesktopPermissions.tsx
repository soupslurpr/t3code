import {
  DesktopScreenAuthorization,
  type DesktopCapabilityGrant,
  type DesktopExecutionAccess,
  type DesktopGrantCapability,
  type DesktopGrantLifetime,
  type DesktopGrantPolicy,
  type DesktopGrantScope,
  type DesktopProcess,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Switch, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Errors, Panel } from "./SupervisionLayout";
import {
  type DesktopRouteTarget,
  useDesktopAction,
  useDesktopRead,
  useUserPermission,
  useUserRequest,
} from "./desktopRequests";

import { grantRequest, type GrantChange } from "./desktopGrantRequest";
import { useDeadlinePassed } from "../../lib/clock";
type Authority = DesktopScreenAuthorization | DesktopExecutionAccess;

const decodeScreen = Schema.decodeUnknownSync(Schema.NullOr(DesktopScreenAuthorization));
export function ScreenPermissions(target: DesktopRouteTarget) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const request = {
    operation: "screen-permission",
    action: "status",
    desktopId: target.desktopId,
  } as const;
  const allowed = useUserPermission(target, request);
  const invoke = useUserRequest(target);
  const query = useDesktopRead(
    open && allowed,
    async () => decodeScreen(await invoke(request)),
    5_000,
  );
  if (!allowed) return null;
  return (
    <Panel title={gt("Screen permissions")}>
      <Button
        size="compact"
        label={open ? gt("Hide permissions") : gt("Show permissions")}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <>
          <Errors error={query.error} />
          {query.data ? (
            <DesktopPermissions target={target} authority={query.data} refresh={query.refresh} />
          ) : (
            !query.error && <Text>{gt("Waiting for desktop permissions…")}</Text>
          )}
        </>
      )}
    </Panel>
  );
}

type GrantEditorState = { grant?: DesktopCapabilityGrant; capability: DesktopGrantCapability };
export function DesktopPermissions({
  target,
  authority,
  refresh,
  affectedWork,
}: {
  target: DesktopRouteTarget;
  authority: Authority;
  refresh: () => void;
  affectedWork?: (grant: DesktopCapabilityGrant) => Promise<readonly DesktopProcess[]>;
}) {
  const gt = useGT();
  const invoke = useUserRequest(target);
  const execution = "kind" in authority;
  const [edit, setEdit] = useState<GrantEditorState | null>(null);
  const [remove, setRemove] = useState<DesktopCapabilityGrant | null>(null);
  const action = useDesktopAction();
  const apply = (change: GrantChange) =>
    void action.run(async () => {
      const { request, threadId } = grantRequest(target, execution, change);
      await invoke(request, threadId);
      setEdit(null);
      setRemove(null);
      refresh();
    });
  const capabilityLabel = (v: DesktopGrantCapability) =>
    v === "view"
      ? gt("Screen viewing")
      : v === "control"
        ? gt("Screen viewing and control")
        : gt("Commands");
  const scopeLabel = (v: DesktopGrantScope) =>
    v === "thread"
      ? gt("This thread")
      : v === "environment"
        ? gt("This environment")
        : gt("All environments");
  const showLifetime = (p: DesktopGrantPolicy) =>
    p.lifetime === "automatic"
      ? gt("Automatic temporary access")
      : p.lifetime === "until-time" && p.deadline
        ? gt("Expires {time}", { time: new Date(p.deadline).toLocaleString() })
        : gt("Until revoked");
  return (
    <View className="gap-3">
      <Errors error={action.error} />
      <Text>
        {authority.remoteApprovalAvailable
          ? gt("You can approve requests for this environment here.")
          : gt("Approval appears on the selected desktop.")}
      </Text>
      {execution && (
        <Text selectable>
          {authority.user} · {authority.homeDirectory}
        </Text>
      )}
      {authority.pendingRequests
        ?.filter(
          (p) =>
            p.environmentId === target.environmentId &&
            (!target.threadId || p.threadId === target.threadId),
        )
        .map((p) => (
          <View key={p.requestId} className="gap-2">
            <Text>
              {capabilityLabel("capability" in p ? p.capability : "execution")} ·{" "}
              {p.source?.threadTitle || p.threadId} · {scopeLabel(p.proposedPolicy.scope)} ·{" "}
              {showLifetime(p.proposedPolicy)}
            </Text>
            {authority.remoteApprovalAvailable &&
              !("requiresLocalApproval" in p && p.requiresLocalApproval) && (
                <View className="flex-row flex-wrap gap-2">
                  <Button
                    size="compact"
                    label={gt("Approve request")}
                    disabled={action.busy}
                    onPress={() => apply({ action: "approve", pending: p })}
                  />
                  <Button
                    size="compact"
                    label={gt("Deny")}
                    disabled={action.busy}
                    onPress={() => apply({ action: "deny", pending: p })}
                  />
                </View>
              )}
          </View>
        ))}
      {authority.grants
        .filter(
          (g) =>
            (g.environmentId === null || g.environmentId === target.environmentId) &&
            (!target.threadId || !g.threadId || g.threadId === target.threadId),
        )
        .map((g) => (
          <View key={g.grantId} className="gap-2">
            <Text>
              {capabilityLabel(g.capability)} · {scopeLabel(g.scope)} ·{" "}
              {g.source?.threadTitle || g.threadId || g.source?.environmentLabel} ·{" "}
              {g.expiresAt
                ? gt("Expires {time}", { time: new Date(g.expiresAt).toLocaleString() })
                : showLifetime(g)}
            </Text>
            <Text>
              {g.remembered ? gt("Remembered") : gt("Ends when T3 quits")}
              {g.suspended ? gt(" · Needs fresh approval") : ""}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Button
                size="compact"
                label={gt("Change permission")}
                disabled={action.busy}
                onPress={() => {
                  setRemove(null);
                  setEdit({ grant: g, capability: g.capability });
                }}
              />
              <Button
                size="compact"
                label={gt("Remove permission")}
                disabled={action.busy}
                onPress={() => {
                  setEdit(null);
                  setRemove(g);
                }}
              />
            </View>
          </View>
        ))}
      <View className="flex-row flex-wrap gap-2">
        {(execution ? (["execution"] as const) : (["view", "control"] as const)).map((cap) => (
          <Button
            key={cap}
            size="compact"
            label={
              cap === "view"
                ? gt("Allow viewing")
                : cap === "control"
                  ? gt("Allow viewing and control")
                  : gt("Allow commands")
            }
            disabled={action.busy}
            onPress={() => {
              setRemove(null);
              setEdit({ capability: cap });
            }}
          />
        ))}
      </View>
      {edit && (
        <PolicyEditor
          key={JSON.stringify([edit.grant?.grantId, edit.grant?.revision, edit.capability])}
          edit={edit}
          threadId={target.threadId}
          remote={authority.remoteApprovalAvailable === true}
          disabled={action.busy}
          onCancel={() => setEdit(null)}
          onSave={(policy) => apply({ action: "save", ...edit, policy })}
        />
      )}
      {remove && (
        <GrantRemoval
          key={JSON.stringify([remove.grantId, remove.revision])}
          grant={remove}
          disabled={action.busy}
          affectedWork={affectedWork}
          transfers={
            execution
              ? authority.activeTransfers?.filter((t) => t.grantId === remove.grantId)
              : undefined
          }
          cancel={() => setRemove(null)}
          confirm={(stopWork) => apply({ action: "remove", grant: remove, stopWork })}
        />
      )}
    </View>
  );
}

function PolicyEditor({
  edit,
  threadId,
  remote,
  disabled,
  onCancel,
  onSave,
}: {
  edit: GrantEditorState;
  threadId?: ThreadId | undefined;
  remote: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSave: (p: DesktopGrantPolicy) => void;
}) {
  const gt = useGT();
  const g = edit.grant;
  const [scope, setScope] = useState<DesktopGrantScope>(
    g?.scope ?? (threadId ? "thread" : "environment"),
  );
  const [lifetime, setLifetime] = useState<DesktopGrantLifetime>(
    g?.lifetime ?? (threadId ? "automatic" : "until-time"),
  );
  const [remembered, setRemembered] = useState(g?.remembered ?? false);
  const [deadline, setDeadline] = useState(
    () => g?.deadline ?? new Date(Date.now() + 86_400_000).toISOString(),
  );
  const scopes: DesktopGrantScope[] = g
    ? [g.scope]
    : threadId
      ? ["thread", "environment", "desktop"]
      : ["environment", "desktop"];
  const lifetimes: DesktopGrantLifetime[] =
    scope === "thread"
      ? ["automatic", "until-time", "until-revoked"]
      : ["until-time", "until-revoked"];
  const timestamp = Date.parse(deadline);
  const expired = useDeadlinePassed(Number.isFinite(timestamp) ? timestamp : null);
  const valid = lifetime !== "until-time" || (Number.isFinite(timestamp) && !expired);
  return (
    <View className="gap-2 rounded-xl bg-subtle p-3">
      <View className="flex-row flex-wrap gap-2">
        {scopes.map((s) => (
          <Button
            key={s}
            size="compact"
            tone={scope === s ? "primary" : "secondary"}
            label={
              s === "thread"
                ? gt("This thread")
                : s === "environment"
                  ? gt("This environment")
                  : gt("All environments")
            }
            onPress={() => {
              setScope(s);
              if (s !== "thread" && lifetime === "automatic") setLifetime("until-time");
            }}
          />
        ))}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {lifetimes.map((l) => (
          <Button
            size="compact"
            key={l}
            tone={lifetime === l ? "primary" : "secondary"}
            label={
              l === "automatic"
                ? gt("Automatic temporary access")
                : l === "until-time"
                  ? gt("Until a time")
                  : gt("Until revoked")
            }
            onPress={() => setLifetime(l)}
          />
        ))}
      </View>
      {lifetime === "until-time" && (
        <>
          <Text>{gt("Expiry, including time zone")}</Text>
          <AppTextInput
            accessibilityLabel={gt("Expiry, including time zone")}
            value={deadline}
            onChangeText={setDeadline}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      )}
      <View className="flex-row items-center gap-2">
        <Switch
          accessibilityLabel={gt("Remember across restart")}
          value={remembered}
          onValueChange={setRemembered}
        />
        <Text>{gt("Remember across restart")}</Text>
      </View>
      <Button
        size="compact"
        label={
          remote && scope !== "desktop"
            ? gt("Confirm permission")
            : gt("Request approval on desktop")
        }
        disabled={!valid || disabled}
        onPress={() =>
          onSave({
            scope,
            lifetime,
            remembered,
            deadline: lifetime === "until-time" ? new Date(deadline).toISOString() : null,
          })
        }
      />
      <Button size="compact" label={gt("Cancel")} disabled={disabled} onPress={onCancel} />
    </View>
  );
}

function GrantRemoval({
  grant,
  disabled,
  affectedWork,
  transfers,
  cancel,
  confirm,
}: {
  grant: DesktopCapabilityGrant;
  disabled: boolean;
  affectedWork?: ((g: DesktopCapabilityGrant) => Promise<readonly DesktopProcess[]>) | undefined;
  transfers?: DesktopExecutionAccess["activeTransfers"];
  cancel: () => void;
  confirm: (stop: boolean) => void;
}) {
  const gt = useGT();
  const [stop, setStop] = useState(true);
  const jobs = useDesktopRead(Boolean(affectedWork), async () =>
    affectedWork ? affectedWork(grant) : [],
  );
  return (
    <View className="gap-2 rounded-xl bg-subtle p-3">
      <Errors error={jobs.error} />
      {affectedWork && (
        <>
          {jobs.data?.map((p) => (
            <Text key={p.processId} selectable>
              {p.executable} · {p.processId}
            </Text>
          ))}
          {transfers?.map((t) => (
            <Text key={t.transferId} selectable>
              {t.transferId} · {t.threadId}
            </Text>
          ))}
          <View className="flex-row items-center gap-2">
            <Switch
              value={stop}
              onValueChange={setStop}
              accessibilityLabel={gt("Stop commands and transfers accepted under this permission")}
            />
            <Text className="flex-1">
              {gt("Stop commands and transfers accepted under this permission")}
            </Text>
          </View>
        </>
      )}
      <Button
        size="compact"
        tone="danger"
        label={gt("Confirm removal")}
        disabled={disabled || (Boolean(affectedWork) && !jobs.data)}
        onPress={() => confirm(stop)}
      />
      <Button size="compact" label={gt("Cancel")} disabled={disabled} onPress={cancel} />
    </View>
  );
}

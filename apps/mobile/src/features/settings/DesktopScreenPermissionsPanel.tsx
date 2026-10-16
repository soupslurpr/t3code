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
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

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
  const [expanded, setExpanded] = useState(false);
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
            View and control are separate from command execution and operating-system consent.
            Changes require confirmation on this desktop.
          </Text>
          {error ? <Text accessibilityRole="alert">{error}</Text> : null}
          {status?.authorization === undefined ? (
            <Text>Scoped screen permissions require a compatible desktop.</Text>
          ) : (
            <>
              <TextInput
                accessibilityLabel="Screen permission deadline"
                value={deadline}
                onChangeText={setDeadline}
                className="rounded-lg bg-subtle p-2 text-foreground"
              />
              {button(
                "Choose view policy",
                () => policy("view"),
                busy || !allowed || !Number.isFinite(Date.parse(deadline)),
              )}
              {button(
                "Choose control policy",
                () => policy("control"),
                busy || !allowed || !Number.isFinite(Date.parse(deadline)),
              )}
              {status.authorization.grants
                .filter((grant) => !threadId || !grant.threadId || grant.threadId === threadId)
                .map((grant) => (
                  <View key={grant.grantId} className="gap-1">
                    <Text>
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
                    </Text>
                    {button(
                      "Change on desktop",
                      () => policy(grant.capability === "control" ? "control" : "view", grant),
                      busy || !allowed || !Number.isFinite(Date.parse(deadline)),
                    )}
                    {button(
                      "Remove on desktop",
                      () =>
                        void act(
                          {
                            operation: "screen-permission",
                            desktopId,
                            action: "remove",
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

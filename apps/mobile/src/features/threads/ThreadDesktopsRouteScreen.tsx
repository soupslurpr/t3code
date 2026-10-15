import type { DesktopProcessActivity } from "@t3tools/contracts";
import { DesktopScreenPermissionsPanel } from "../settings/DesktopScreenPermissionsPanel";
import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AgentDesktop, EnvironmentId, ThreadId, UserDesktopList } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ErrorBanner } from "../../components/ErrorBanner";
import {
  UserDesktopExecutionPanel,
  AgentDesktopExecutionPanel,
} from "../settings/UserDesktopExecutionPanel";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const decodeAgents = Schema.decodeUnknownSync(
  Schema.Struct({ desktops: Schema.Array(AgentDesktop) }),
);
const decodeUsers = Schema.decodeUnknownSync(UserDesktopList);

/** Opens supervision and inspects desktop work from the owning conversation on either platform. */
export function ThreadDesktopsRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; threadId: string }>) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const { environments } = useEnvironments();
  const environmentLabel =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  const allowed = useAtomValue(
    previewEnvironment.invokeUserDesktopHuman.permissionAtom(environmentId),
  );
  const agentAllowed = useAtomValue(
    previewEnvironment.invokeAgentDesktopHuman.permissionAtom(environmentId),
  );
  const userInvoke = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, {
    reportFailure: false,
  });
  const agentInvoke = useAtomCommand(previewEnvironment.invokeAgentDesktopHuman, {
    reportFailure: false,
  });
  const [selected, setSelected] = useState<DesktopProcessActivity | null>(null);
  const [agents, setAgents] = useState<ReadonlyArray<AgentDesktop>>([]);
  const [users, setUsers] = useState<UserDesktopList["desktops"]>([]);
  const [error, setError] = useState<string | null>(null);
  const activity = useEnvironmentQuery(
    serverEnvironment.threadDesktopActivity({ environmentId, input: { threadId } }),
  );
  const { refresh: refreshActivity } = activity;
  const refresh = useCallback(async () => {
    try {
      const results = await Promise.all([
        allowed
          ? userInvoke({
              environmentId,
              input: { request: { operation: "list", includeExecution: true } },
            })
          : null,
        agentAllowed
          ? agentInvoke({ environmentId, input: { threadId, request: { operation: "list" } } })
          : null,
      ]);
      const [userResult, agentResult] = results;
      for (const result of results)
        if (result?._tag === "Failure") throw squashAtomCommandFailure(result);
      setUsers(userResult?._tag === "Success" ? decodeUsers(userResult.value).desktops : []);
      setAgents(
        agentResult?._tag === "Success"
          ? decodeAgents(agentResult.value).desktops.filter(
              (desktop) => desktop.owner.threadId === threadId,
            )
          : [],
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read desktops.");
    }
  }, [
    allowed,
    agentAllowed,
    userInvoke,
    agentInvoke,
    environmentId,
    threadId,
    setUsers,
    setAgents,
    setError,
  ]);
  useEffect(() => {
    if (!focused) return;
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") {
        void refresh();
        refreshActivity();
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [focused, refresh, refreshActivity]);
  return (
    <View className="flex-1 bg-screen">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Desktop" onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title: "Desktop" }} />
      )}
      <ScrollView contentContainerClassName="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          {environmentLabel} · This conversation
        </Text>
        {(error ?? activity.error) ? <ErrorBanner message={error ?? activity.error ?? ""} /> : null}
        {!allowed || !agentAllowed ? (
          <Text>Desktop supervision requires operate access to this environment.</Text>
        ) : null}
        <Text className="font-t3-bold">Agent desktops</Text>
        {agents.length === 0 ? (
          <Text className="text-foreground-muted">No Agent desktops owned by this thread.</Text>
        ) : null}
        {agents.map((desktop) => (
          <Pressable
            key={desktop.id}
            accessibilityRole="button"
            disabled={
              !agentAllowed ||
              desktop.state === "recoverable" ||
              desktop.state === "deleting" ||
              desktop.state === "failed"
            }
            className="rounded-2xl bg-subtle p-4 disabled:opacity-40"
            onPress={() =>
              navigation.navigate("UserDesktopSupervision", {
                environmentId,
                environmentLabel,
                desktopId: desktop.id,
                label: desktop.label,
                supportsControl: true,
                threadId,
                agentOwner: desktop.owner,
              })
            }
          >
            <Text className="font-t3-bold">{desktop.label}</Text>
            <Text>{desktop.state} · Supervise</Text>
          </Pressable>
        ))}
        <Text className="font-t3-bold">User desktops</Text>
        {users.length === 0 ? (
          <Text className="text-foreground-muted">No User desktops connected.</Text>
        ) : null}
        {users.map((desktop) => (
          <Pressable
            key={desktop.desktop.desktopId}
            accessibilityRole="button"
            disabled={
              !allowed ||
              desktop.connectionState !== "online" ||
              !desktop.capabilities.includes("view")
            }
            className="rounded-2xl bg-subtle p-4 disabled:opacity-40"
            onPress={() =>
              navigation.navigate("UserDesktopSupervision", {
                environmentId,
                environmentLabel,
                desktopId: desktop.desktop.desktopId,
                label: desktop.label,
                supportsControl: desktop.capabilities.includes("control"),
                threadId,
              })
            }
          >
            <Text className="font-t3-bold">{desktop.label}</Text>
            <Text>{desktop.connectionState} · Supervise</Text>
          </Pressable>
        ))}
        {users
          .filter(
            (desktop) =>
              desktop.connectionState === "online" && desktop.capabilities.includes("view"),
          )
          .map((desktop) => (
            <DesktopScreenPermissionsPanel
              key={`screen:${desktop.desktop.desktopId}`}
              environmentId={environmentId}
              desktopId={desktop.desktop.desktopId}
              threadId={threadId}
            />
          ))}
        <Text className="font-t3-bold">Commands and transfers</Text>
        {agents.map((desktop) => (
          <AgentDesktopExecutionPanel
            key={desktop.id}
            desktopId={desktop.id}
            owner={desktop.owner}
            label={desktop.label}
          />
        ))}
        {users
          .filter(
            (desktop) =>
              desktop.connectionState === "online" && desktop.capabilities.includes("execution"),
          )
          .map((desktop) => (
            <UserDesktopExecutionPanel
              key={desktop.desktop.desktopId}
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              desktop={desktop.desktop}
              threadId={threadId}
            />
          ))}
        {activity.data?.transfers.map((transfer) => (
          <View key={transfer.id} className="gap-1 rounded-2xl bg-subtle p-4">
            <Text>
              {transfer.label} · {transfer.state}
            </Text>
            <Text>
              {transfer.transferredBytes.toLocaleString()} /{" "}
              {transfer.totalBytes?.toLocaleString() ?? "unknown"} bytes
            </Text>
            {transfer.error ? <Text>{transfer.error}</Text> : null}
          </View>
        ))}
        {activity.data?.commands.map((command) => (
          <View key={command.id} className="gap-2 rounded-2xl bg-subtle p-4">
            <Text className="font-t3-bold">
              {command.process
                ? `Process ${command.process.phase}`
                : `${command.tool.split("__").at(-1)} · Tool ${command.status}`}
            </Text>
            {command.process ? (
              <Pressable accessibilityRole="button" onPress={() => setSelected(command.process!)}>
                <Text>Inspect process on {command.process.desktop.desktopId}</Text>
              </Pressable>
            ) : null}
            <Text selectable className="text-sm">
              {command.input}
            </Text>
            <Text selectable className="text-sm">
              {command.output || "Waiting for output…"}
            </Text>
          </View>
        ))}
        {selected ? (
          selected.desktop.kind === "agent" ? (
            <AgentDesktopExecutionPanel
              key={selected.processId}
              desktopId={selected.desktop.desktopId}
              owner={{ environmentId, threadId, controllerId: "human-supervision" }}
              label={selected.desktop.desktopId}
              initialProcessId={selected.processId}
            />
          ) : (
            <UserDesktopExecutionPanel
              key={selected.processId}
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              desktop={{ kind: "user", desktopId: selected.desktop.desktopId }}
              threadId={threadId}
              initialProcessId={selected.processId}
            />
          )
        ) : null}
        {activity.data?.commands.length === 0 && activity.data.transfers.length === 0 ? (
          <Text className="text-foreground-muted">No recent desktop activity.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

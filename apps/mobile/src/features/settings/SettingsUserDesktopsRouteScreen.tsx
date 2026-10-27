import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, UserDesktopList, UserDesktopView } from "@t3tools/contracts";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { SymbolView } from "../../components/ui/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";

import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";

const INVENTORY_REFRESH_INTERVAL_MS = 5_000;

interface UserDesktopRoute {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly desktop: UserDesktopView;
}

interface UserDesktopGroup {
  readonly desktopId: string;
  readonly routes: ReadonlyArray<UserDesktopRoute>;
  readonly primary: UserDesktopRoute;
  readonly connectionState: UserDesktopView["connectionState"];
  readonly supportsView: boolean;
  readonly supportsControl: boolean;
}

/** Groups environment routes by the stable identity of one physical desktop. */
export function groupMobileUserDesktops(
  routes: ReadonlyArray<UserDesktopRoute>,
): ReadonlyArray<UserDesktopGroup> {
  const routesByDesktop = new Map<string, Array<UserDesktopRoute>>();
  for (const route of routes) {
    const desktopId = route.desktop.desktop.desktopId;
    const existing = routesByDesktop.get(desktopId);
    if (existing === undefined) routesByDesktop.set(desktopId, [route]);
    else existing.push(route);
  }
  return Array.from(routesByDesktop, ([desktopId, desktopRoutes]) => {
    const primary =
      desktopRoutes.find(
        (route) =>
          route.desktop.connectionState === "online" && route.desktop.capabilities.includes("view"),
      ) ??
      desktopRoutes.find((route) => route.desktop.connectionState === "online") ??
      desktopRoutes[0]!;
    const connectionState: UserDesktopView["connectionState"] = desktopRoutes.some(
      (route) => route.desktop.connectionState === "online",
    )
      ? "online"
      : desktopRoutes.some((route) => route.desktop.connectionState === "identity-conflict")
        ? "identity-conflict"
        : "offline";
    return {
      desktopId,
      routes: desktopRoutes,
      primary,
      connectionState,
      supportsView: desktopRoutes.some(
        (route) =>
          route.desktop.connectionState === "online" && route.desktop.capabilities.includes("view"),
      ),
      supportsControl: desktopRoutes.some(
        (route) =>
          route.desktop.connectionState === "online" &&
          route.desktop.capabilities.includes("control"),
      ),
    };
  }).sort((left, right) => {
    const connectionOrder =
      Number(right.connectionState === "online") - Number(left.connectionState === "online");
    return connectionOrder || left.primary.desktop.label.localeCompare(right.primary.desktop.label);
  });
}

async function readMobileUserDesktopInventory(
  environments: ReadonlyArray<{
    environmentId: EnvironmentId;
    environmentLabel: string;
    connectionState: string;
  }>,
  permitted: ReadonlySet<EnvironmentId>,
  list: (environmentId: EnvironmentId) => Promise<UserDesktopList>,
) {
  const routes: UserDesktopRoute[] = [];
  const failures: string[] = [];
  await Promise.all(
    environments
      .filter(
        (environment) =>
          environment.connectionState === "connected" && permitted.has(environment.environmentId),
      )
      .map(async (environment) => {
        try {
          const result = await list(environment.environmentId);
          for (const desktop of result.desktops)
            routes.push({
              environmentId: environment.environmentId,
              environmentLabel: environment.environmentLabel,
              desktop,
            });
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : "Could not load User desktops.");
        }
      }),
  );
  return { routes, error: failures[0] ?? null };
}

/** Lists physical User desktops available through connected environments. */
export function SettingsUserDesktopsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const invoke = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, {
    reportFailure: false,
  });
  const [routes, setRoutes] = useState<ReadonlyArray<UserDesktopRoute>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const groups = groupMobileUserDesktops(routes);
  const permitted = useEnvironmentsWithScope(connectedEnvironments, AuthOrchestrationOperateScope);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((key) => key + 1);

  useFocusEffect(() => {
    void refreshKey;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const result = await readMobileUserDesktopInventory(
        connectedEnvironments,
        permitted,
        async (environmentId) => {
          const result = await invoke({ environmentId, input: { request: { operation: "list" } } });
          if (result._tag !== "Success") throw squashAtomCommandFailure(result);
          return result.value as UserDesktopList;
        },
      );
      if (disposed) return;
      setRoutes(result.routes);
      setError(result.error);
      setLoading(false);
      timer = setTimeout(load, INVENTORY_REFRESH_INTERVAL_MS);
    };
    setLoading(true);
    void load();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  });

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="User desktops" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl refreshing={loading && groups.length > 0} onRefresh={refresh} />
        }
      >
        <Text className="px-1 text-sm leading-normal text-foreground-muted">
          Supervision opens Agent Lens history without starting screen capture. Live viewing remains
          explicit and transient.
        </Text>
        {error === null ? null : <ErrorBanner message={error} />}
        {loading && groups.length === 0 ? (
          <View className="items-center gap-3 rounded-[24px] bg-card px-6 py-10">
            <ActivityIndicator />
            <Text className="text-sm text-foreground-muted">Loading User desktops…</Text>
          </View>
        ) : groups.length === 0 ? (
          <View className="items-center gap-3 rounded-[24px] bg-card px-6 py-10">
            <SymbolView
              name="desktopcomputer"
              size={24}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              No compatible User desktops are connected.
            </Text>
          </View>
        ) : (
          groups.map((group) => {
            const desktop = group.primary.desktop;
            const environmentLabels = [
              ...new Set(group.routes.map((route) => route.environmentLabel)),
            ];
            return (
              <View key={group.desktopId} className="gap-3 rounded-[24px] bg-card p-4">
                <View className="flex-row items-start gap-3">
                  <View className="h-11 w-11 items-center justify-center rounded-[15px] bg-subtle">
                    <SymbolView
                      name="desktopcomputer"
                      size={21}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1 gap-1">
                    <Text className="text-lg font-t3-bold text-foreground" numberOfLines={1}>
                      {desktop.label}
                    </Text>
                    <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                      {environmentLabels.join(", ")} · {desktop.platform}
                    </Text>
                    <Text
                      className={
                        group.connectionState === "online"
                          ? "text-xs font-t3-medium text-adaptive-emerald-600-400"
                          : "text-xs font-t3-medium text-foreground-muted"
                      }
                    >
                      {group.connectionState === "online"
                        ? "Online"
                        : group.connectionState === "identity-conflict"
                          ? "Identity conflict"
                          : "Offline"}
                    </Text>
                  </View>
                </View>
                {group.connectionState === "online" && !group.supportsView ? (
                  <Text className="text-sm leading-normal text-foreground-muted">
                    This desktop does not expose screen viewing on its current platform.
                  </Text>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={!group.supportsView || group.connectionState !== "online"}
                  className="items-center rounded-[14px] bg-primary px-4 py-3 disabled:opacity-40"
                  onPress={() =>
                    navigation.navigate("UserDesktopSupervision", {
                      environmentId: group.primary.environmentId,
                      environmentLabel: group.primary.environmentLabel,
                      desktopId: group.desktopId,
                      label: desktop.label,
                      supportsControl: group.primary.desktop.capabilities.includes("control"),
                    })
                  }
                >
                  <Text className="font-t3-bold text-primary-foreground">Supervise</Text>
                </Pressable>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

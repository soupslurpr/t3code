import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { AppText } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { useEnvironments } from "../../state/environments";
import { environmentConnectedAtom } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "../settings/components/SettingsSection";
import { DesktopEnrollment } from "./DesktopEnrollment";
import { AgentInventory, AgentDesktopDetail } from "./AgentDesktops";
import { UserInventory, UserDesktopDetail } from "./UserDesktops";
import { SupervisionPage } from "./SupervisionLayout";
import {
  desktopRouteTarget,
  type DesktopRouteParams,
  type DesktopRouteTarget,
} from "./desktopRequests";

export function SettingsUserDesktopsRouteScreen() {
  return <DesktopSettings kind="user" />;
}

export function SettingsAgentDesktopsRouteScreen() {
  return <DesktopSettings kind="agent" />;
}

function DesktopSettings({ kind }: { kind: "user" | "agent" }) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const selected =
    chosen === null && environments.length === 1
      ? environments[0]
      : environments.find((env) => env.environmentId === chosen);
  return (
    <SupervisionPage title={kind === "user" ? gt("User desktops") : gt("Agent desktops")}>
      <SettingsSection title={gt("Environment")}>
        {environments.map((env, index) => (
          <ListChoiceRow
            key={env.environmentId}
            label={env.label}
            description={
              env.connection.phase === "connected" ? gt("Connected") : gt("Disconnected")
            }
            separated={index > 0}
            selected={selected?.environmentId === env.environmentId}
            onPress={() => setChosen(env.environmentId)}
          />
        ))}
      </SettingsSection>
      {selected?.connection.phase === "connected" ? (
        kind === "user" ? (
          <UserSettingsInventory
            key={selected.environmentId}
            environmentId={selected.environmentId}
          />
        ) : (
          <AgentInventory key={selected.environmentId} environmentId={selected.environmentId} />
        )
      ) : (
        <AppText>
          {selected
            ? gt("The selected environment is disconnected.")
            : gt("Select an environment.")}
        </AppText>
      )}
    </SupervisionPage>
  );
}

function UserSettingsInventory({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <>
      <UserInventory environmentId={environmentId} />
      <DesktopEnrollment environmentId={environmentId} />
    </>
  );
}

export function ThreadDesktopsRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; threadId: string }>) {
  const gt = useGT();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const connected = useAtomValue(environmentConnectedAtom(environmentId));
  return (
    <SupervisionPage title={gt("Desktop")}>
      {connected ? (
        <ThreadInventories
          key={JSON.stringify([environmentId, threadId])}
          environmentId={environmentId}
          threadId={threadId}
        />
      ) : (
        <AppText>{gt("The selected environment is disconnected.")}</AppText>
      )}
    </SupervisionPage>
  );
}

function ThreadInventories(scope: { environmentId: EnvironmentId; threadId: ThreadId }) {
  return (
    <>
      <UserInventory {...scope} />
      <AgentInventory {...scope} />
    </>
  );
}

export function DesktopDetailRouteScreen({ route }: StaticScreenProps<DesktopRouteParams>) {
  const gt = useGT();
  const target = desktopRouteTarget(route.params);
  return target ? (
    <DesktopDetail {...target} />
  ) : (
    <SupervisionPage title={gt("Desktop")}>
      <AppText>{gt("This desktop is no longer available.")}</AppText>
    </SupervisionPage>
  );
}

function DesktopDetail(target: DesktopRouteTarget) {
  const gt = useGT();
  const connected = useAtomValue(environmentConnectedAtom(target.environmentId));
  const key = JSON.stringify([
    target.environmentId,
    target.kind,
    target.desktopId,
    target.threadId,
  ]);
  return (
    <SupervisionPage title={target.label}>
      {connected ? (
        target.kind === "user" ? (
          <UserDesktopDetail key={key} {...target} />
        ) : (
          <AgentDesktopDetail key={key} {...target} />
        )
      ) : (
        <AppText>{gt("The selected environment is disconnected.")}</AppText>
      )}
    </SupervisionPage>
  );
}

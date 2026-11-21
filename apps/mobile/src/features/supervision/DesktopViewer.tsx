import { useDesktopLabel } from "./desktopLabels";
import { useAtomValue } from "@effect/atom-react";
import {
  useFocusEffect,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { createDesktopViewer } from "@t3tools/client-runtime/computer/viewer";
import {
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  UserDesktopList,
  type ComputerAutomationAccess,
  type UserDesktopHumanRequest,
  type AgentDesktopHumanRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react-native";
import { useCallback, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useAppActive } from "../../lib/appState";
import { environmentConnectedAtom } from "../../state/use-remote-environment-registry";
import { DesktopInput } from "./DesktopInput";
import { DesktopLens } from "./DesktopLens";
import { retainMobileDesktopImage } from "./desktopFrame";
import { createMobileViewerSlot } from "./mobileViewerSlot";
import {
  desktopError,
  desktopRouteTarget,
  type DesktopRouteParams,
  type DesktopRouteTarget,
  useAgentPermission,
  useAgentRequest,
  useDesktopRead,
  useUserPermission,
  useUserRequest,
} from "./desktopRequests";
import { Errors, Panel, SupervisionPage } from "./SupervisionLayout";

const decodeStatus = Schema.decodeUnknownSync(ComputerAutomationStatus);
const decodeFrame = Schema.decodeUnknownSync(ComputerAutomationSnapshot);
const decodeInventory = Schema.decodeUnknownSync(UserDesktopList);
const viewers = createMobileViewerSlot();
type Viewer = ReturnType<typeof createDesktopViewer>;
interface Session {
  viewer: Viewer;
  handback: boolean;
  takeover?: string | undefined;
}

export function DesktopViewerRouteScreen({ route }: StaticScreenProps<DesktopRouteParams>) {
  const gt = useGT();
  const target = desktopRouteTarget(route.params);
  return target ? (
    <DesktopViewer {...target} />
  ) : (
    <SupervisionPage title={gt("Desktop")}>
      <Text>{gt("This desktop is no longer available.")}</Text>
    </SupervisionPage>
  );
}

function DesktopViewer(target: DesktopRouteTarget) {
  const gt = useGT();
  const connected = useAtomValue(environmentConnectedAtom(target.environmentId));
  const viewRequest = { operation: "request-view", desktopId: target.desktopId } as const;
  const userAllowed = useUserPermission(target, viewRequest);
  const agentAllowed = useAgentPermission(target, viewRequest);
  const allowed = target.kind === "user" ? userAllowed : agentAllowed;
  const focused = useIsFocused();
  const active = useAppActive();
  return (
    <SupervisionPage title={target.label}>
      {!connected ? (
        <Text>{gt("The selected environment is disconnected.")}</Text>
      ) : !allowed ? (
        <Text>{gt("Desktop supervision is not permitted in this environment.")}</Text>
      ) : (
        focused &&
        active && (
          <ViewerContent
            key={JSON.stringify([
              target.environmentId,
              target.kind,
              target.desktopId,
              target.threadId,
            ])}
            {...target}
          />
        )
      )}
    </SupervisionPage>
  );
}

function ViewerContent(target: DesktopRouteTarget) {
  const gt = useGT();
  const label = useDesktopLabel();
  const navigation = useNavigation();
  const { desktopId } = target;
  const user = useUserRequest(target);
  const agent = useAgentRequest(target);
  const run = (request: UserDesktopHumanRequest & AgentDesktopHumanRequest) =>
    target.kind === "user" ? user(request) : agent(request);
  const userControl = useUserPermission(target, { operation: "request-control", desktopId });
  const agentControl = useAgentPermission(target, { operation: "request-control", desktopId });
  const list = { operation: "list" } as const;
  const canList = useUserPermission(target, list);
  const inventory = useDesktopRead(
    target.kind === "user" && canList,
    async () => {
      const data = decodeInventory(await user(list));
      return data.desktops.find((row) => row.desktop.desktopId === desktopId);
    },
    10_000,
  );
  const userOnline = inventory.data?.connectionState === "online";
  const canControl =
    target.kind === "user"
      ? userControl && userOnline && inventory.data?.capabilities.includes("control")
      : agentControl;
  const status = useDesktopRead(
    true,
    async () => decodeStatus(await run({ operation: "status", desktopId })),
    4_000,
  );
  const [display, setDisplay] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ComputerAutomationSnapshot | null>(null);
  const [live, setLive] = useState<Viewer | null>(null);
  const [control, setControl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  const visible = () => navigation.isFocused() && AppState.currentState === "active";
  const onError = (cause: unknown) => setError(desktopError(cause));

  const close = useCallback(async (handback = false) => {
    const closing = session.current;
    session.current = null;
    setLive(null);
    setControl(false);
    setSnapshot(null);
    if (!closing) return;
    closing.handback = handback;
    await viewers.close(closing.viewer);
  }, []);
  useFocusEffect(
    useCallback(() => {
      const stop = () => {
        void close().catch((cause) => setError(desktopError(cause)));
      };
      const state = AppState.addEventListener("change", (next) => {
        if (next !== "active") stop();
      });
      const blur = AppState.addEventListener("blur", stop);
      return () => {
        state.remove();
        blur.remove();
        stop();
      };
    }, [close]),
  );

  const start = async (access: ComputerAutomationAccess, takeover?: string) => {
    if (!visible()) return;
    setBusy(true);
    setError(null);
    let active = session.current;
    if (!active) {
      const viewer = createDesktopViewer({
        request: async (mode) => {
          const credential = active?.takeover;
          const request =
            mode === "view"
              ? ({ operation: "request-view", desktopId } as const)
              : ({ operation: "request-control", desktopId } as const);
          const result = decodeStatus(
            await (target.kind === "user"
              ? user({
                  ...request,
                  ...(mode === "control" && credential ? { takeoverLeaseId: credential } : {}),
                })
              : agent(request)),
          );
          if (session.current?.viewer === viewer)
            setControl(
              mode === "control" &&
                (result.lease
                  ? result.lease.access === "control"
                  : result.permission === "granted"),
            );
        },
        snapshot: async (knownHash) =>
          decodeFrame(
            await run({
              operation: "snapshot",
              desktopId,
              input: {
                ...(display ? { displayId: display } : {}),
                includeAccessibility: false,
                screenshot: {
                  maxWidth: 1280,
                  ...(knownHash ? { unchangedIfContentHash: knownHash } : {}),
                },
              },
            }),
          ),
        act: (actions) =>
          run({ operation: "act", desktopId, input: { actions, observation: false } }),
        release: () =>
          (active?.handback
            ? run({ operation: "return-control", desktopId })
            : Promise.resolve()
          ).finally(() => run({ operation: "release", desktopId })),
        onFrame: (frame) => {
          if (session.current?.viewer === viewer)
            setSnapshot((previous) => retainMobileDesktopImage(previous, frame));
        },
        onError: (cause) => {
          if (session.current?.viewer === viewer) {
            onError(cause);
            void close().catch(onError);
          }
        },
      });
      active = { viewer, handback: false };
      session.current = active;
    }
    active.takeover = takeover;
    const opening = active;
    await viewers
      .open(opening.viewer, access)
      .then(() => {
        if (session.current === opening) setLive(opening.viewer);
      })
      .catch(async (cause) => {
        if (session.current !== opening) return;
        onError(cause);
        await close().catch(onError);
      });
    if (visible()) {
      setBusy(false);
      status.refresh();
    }
  };
  const stop = async (handback = false) => {
    setBusy(true);
    setError(null);
    await close(handback).catch(onError);
    setBusy(false);
    status.refresh();
  };
  const takeControl = () => {
    const token = status.data?.lease?.takeoverLeaseId;
    if (token)
      Dialog.confirm({
        title: gt("Take control"),
        message: gt("Another controller has this desktop. Take over its current lease?"),
        confirmText: gt("Take control"),
        onConfirm: () => void start("control", token),
      });
    else void start("control");
  };
  const lease = status.data?.lease;
  const controlling =
    control &&
    Boolean(
      canControl &&
      status.data &&
      (lease ? lease.access === "control" : status.data.permission === "granted"),
    );
  return (
    <>
      <Panel title={gt("Live")}>
        <Errors error={error ?? status.error ?? inventory.error} />
        {status.data?.detail && <Text>{status.data.detail}</Text>}
        {lease && (
          <Text>
            {gt("Control")} · {label(lease.controller?.kind ?? lease.access)}
          </Text>
        )}
        {(status.data?.displays.length ?? 0) > 1 && (
          <View className="flex-row flex-wrap gap-2">
            {status.data?.displays.map((d) => (
              <Button
                key={d.id}
                label={d.label || d.id}
                disabled={busy}
                size="compact"
                tone={display === d.id || (!display && d.primary) ? "primary" : "secondary"}
                onPress={() => {
                  setBusy(true);
                  void close()
                    .then(() => setDisplay(d.id))
                    .catch(onError)
                    .finally(() => setBusy(false));
                }}
              />
            ))}
          </View>
        )}
        {live ? (
          <>
            <DesktopInput
              viewer={live}
              snapshot={snapshot}
              control={controlling}
              onError={onError}
            />
            <View className="flex-row flex-wrap gap-2">
              {!controlling && (
                <Button
                  label={gt("Take control")}
                  size="compact"
                  disabled={busy || !canControl || !status.data?.available}
                  onPress={takeControl}
                />
              )}
              {controlling && lease?.canReturnControl && (
                <Button
                  label={gt("Return control to agent")}
                  size="compact"
                  disabled={busy}
                  onPress={() => void stop(true)}
                />
              )}
              <Button
                label={gt("Close viewer")}
                size="compact"
                disabled={busy}
                onPress={() => void stop()}
              />
            </View>
          </>
        ) : (
          <Button
            label={gt("Start Live")}
            loading={busy}
            disabled={
              !status.data?.available ||
              (target.kind === "user" &&
                !(userOnline && inventory.data?.capabilities.includes("view")))
            }
            onPress={() => void start("view")}
          />
        )}
      </Panel>
      {!live && <DesktopLens {...target} />}
    </>
  );
}

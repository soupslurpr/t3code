import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ComputerAutomationAction,
  ComputerAutomationFrame,
  ComputerObservation,
  ComputerObservationId,
  EnvironmentId,
  UserDesktopId,
} from "@t3tools/contracts";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type GestureResponderEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadShells } from "../../state/entities";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  mobileDesktopFramePoint,
  type MobileDesktopPoint,
  type MobileDesktopSurface,
} from "./UserDesktopSupervisionRouteScreen.logic";

import { useAtomValue } from "@effect/atom-react";
import { environmentConnectedAtom } from "../../state/use-remote-environment-registry";
import {
  createMobileDesktopSupervision,
  emptyMobileDesktopSupervision,
} from "./mobileDesktopSupervision";

const DRAG_THRESHOLD_POINTS = 6;

export interface UserDesktopSupervisionRouteParams extends Record<string, unknown> {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly desktopId: UserDesktopId;
  readonly label: string;
  readonly supportsControl: boolean;
}

interface TouchStart {
  readonly frame: ComputerAutomationFrame;
  readonly point: MobileDesktopPoint;
  readonly surfacePoint: MobileDesktopPoint;
}

/** Labels the model-facing recipient of one exact Agent Lens observation. */
function observationRecipient(observation: ComputerObservation): string {
  return observation.recipient.kind === "controller"
    ? observation.recipient.instanceId
    : observation.recipient.modelSelection.model;
}

/** Renders one compact, native-feeling supervision action. */
function SupervisionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, selected: props.selected }}
      disabled={props.disabled}
      className={
        props.destructive
          ? "rounded-[13px] bg-danger px-3.5 py-2.5 disabled:opacity-40"
          : props.selected
            ? "rounded-[13px] bg-primary px-3.5 py-2.5 disabled:opacity-40"
            : "rounded-[13px] bg-subtle px-3.5 py-2.5 disabled:opacity-40"
      }
      onPress={props.onPress}
    >
      <Text
        className={
          props.destructive
            ? "text-sm font-t3-bold text-danger-foreground"
            : props.selected
              ? "text-sm font-t3-bold text-primary-foreground"
              : "text-sm font-t3-bold text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function UserDesktopSupervisionRouteScreen(
  props: StaticScreenProps<UserDesktopSupervisionRouteParams>,
) {
  return (
    <UserDesktopSupervisionContent
      key={`${props.route.params.environmentId}:${props.route.params.desktopId}`}
      {...props}
    />
  );
}

function UserDesktopSupervisionContent({
  route,
}: StaticScreenProps<UserDesktopSupervisionRouteParams>) {
  const params = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const threads = useThreadShells();
  const connected = useAtomValue(environmentConnectedAtom(params.environmentId));
  const permitted = useAtomValue(
    previewEnvironment.invokeUserDesktopHuman.permissionAtom(params.environmentId),
  );
  const invoke = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, {
    reportFailure: false,
  });
  const [view, setView] = useState(emptyMobileDesktopSupervision);
  const [selectedLensImageId, setSelectedLensImageId] = useState<string | null>(null);
  const [surface, setSurface] = useState<MobileDesktopSurface>({ width: 0, height: 0 });
  const [text, setText] = useState("");
  const touchStart = useRef<TouchStart | null>(null);
  const gestureActive = useRef(false);
  const sessionRef = useRef<ReturnType<typeof createMobileDesktopSupervision> | null>(null);
  const accessQueue = useRef(Promise.resolve());
  const { environmentId, desktopId } = params;
  useFocusEffect(() => {
    if (!connected || !permitted) {
      setView({
        ...emptyMobileDesktopSupervision,
        busy: false,
        error: connected
          ? "Desktop supervision is not permitted in this environment."
          : "The selected environment is disconnected.",
      });
      return;
    }
    const session = createMobileDesktopSupervision({
      desktopId,
      accessQueue,
      run: async <Value,>(input: Parameters<typeof invoke>[0]["input"]) => {
        const result = await invoke({ environmentId, input });
        if (result._tag === "Success") return result.value as Value;
        throw squashAtomCommandFailure(result);
      },
      onChange: setView,
      isGestureActive: () => gestureActive.current,
      foreground: AppState.currentState === "active",
    });
    sessionRef.current = session;
    const subscription = AppState.addEventListener("change", (next) =>
      session.setForeground(next === "active"),
    );
    return () => {
      subscription.remove();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
      touchStart.current = null;
      gestureActive.current = false;
    };
  });
  const {
    status,
    liveStarted,
    mode,
    snapshot,
    observations,
    selectedObservationId,
    agentObservation,
    selectedDisplayId,
    busy,
    error,
  } = view;
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const setMode = (mode: "live" | "lens") => sessionRef.current?.setMode(mode);
  const startLive = () => sessionRef.current?.startLive();
  const selectDisplay = (displayId: string) => sessionRef.current?.selectDisplay(displayId);
  const selectObservation = (id: ComputerObservationId) =>
    sessionRef.current?.selectObservation(id);
  const act = (actions: ReadonlyArray<ComputerAutomationAction>) =>
    sessionRef.current?.act(actions);
  const releaseControl = () => sessionRef.current?.changeControl("release-control");
  const returnControl = () => sessionRef.current?.changeControl("return-control");
  const releaseTransientAccess = () => sessionRef.current?.stop();
  const takeControl = () => {
    const session = sessionRef.current;
    const lease = session?.read().status?.lease;
    if (session === null || !session.read().liveStarted || lease === undefined) return;
    const takeoverLeaseId = lease.takeoverLeaseId;
    if (takeoverLeaseId === undefined || lease.controller === null) {
      void session.takeControl();
      return;
    }
    Alert.alert(
      "Take control of this desktop?",
      `${params.label} is controlled by ${lease.controller.kind}${lease.controller.sameEnvironment ? "" : " through another environment"}. Taking over cancels queued input and releases held keys and buttons.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Take control",
          style: "destructive",
          onPress: () => void session.takeControl(takeoverLeaseId),
        },
      ],
    );
  };
  const endAllAccess = () => {
    const session = sessionRef.current;
    Alert.alert(
      "End all desktop access?",
      "This stops every viewer and controller on the physical desktop. Remembered approval is unchanged.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "End all access",
          style: "destructive",
          onPress: () => void session?.endAllAccess(),
        },
      ],
    );
  };
  const panHandlers = {
    onStartShouldSetResponder: () => sessionRef.current?.read().status?.lease?.access === "control",
    onMoveShouldSetResponder: () => sessionRef.current?.read().status?.lease?.access === "control",
    onResponderGrant: (event: GestureResponderEvent) => {
      const frame = sessionRef.current?.read().snapshot?.frame;
      if (frame === undefined) return;
      const point = mobileDesktopFramePoint({
        surface,
        frame,
        touch: { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
      });
      if (point === null) return;
      gestureActive.current = true;
      touchStart.current = {
        frame,
        point,
        surfacePoint: { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
      };
    },
    onResponderRelease: (event: GestureResponderEvent) => {
      const start = touchStart.current;
      touchStart.current = null;
      gestureActive.current = false;
      if (start === null) return;
      const end = mobileDesktopFramePoint({
        surface,
        frame: start.frame,
        touch: { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
      });
      if (end === null) return;
      const dragged =
        Math.hypot(
          event.nativeEvent.locationX - start.surfacePoint.x,
          event.nativeEvent.locationY - start.surfacePoint.y,
        ) >= DRAG_THRESHOLD_POINTS;
      void act(
        dragged
          ? [
              {
                type: "drag",
                frameId: start.frame.id,
                startX: start.point.x,
                startY: start.point.y,
                endX: end.x,
                endY: end.y,
              },
            ]
          : [{ type: "click", frameId: start.frame.id, ...end }],
      );
    },
    onResponderTerminate: () => {
      touchStart.current = null;
      gestureActive.current = false;
    },
  };

  const updateSurface = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSurface({ width, height });
  };

  const sendText = (submit: boolean) => {
    if (text.length === 0) return;
    void act([{ type: "type", text, submit, verification: "best-effort" }]);
    setText("");
  };

  const controlling = status?.lease?.access === "control";
  const selectedSummary = observations.find(
    (observation) => observation.id === selectedObservationId,
  );
  const selectedThread =
    selectedSummary === undefined ? undefined : threadById.get(selectedSummary.threadId);
  const lensImage =
    agentObservation?.images.find((image) => image.id === selectedLensImageId) ??
    agentObservation?.images.at(-1);
  const lensDisplayId = lensImage?.frame?.displayId ?? lensImage?.region?.displayId;
  const liveImage = snapshot?.screenshot?.state === "image" ? snapshot.screenshot : null;

  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={params.label} onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title: params.label }} />
      )}

      <View className="flex-row items-center justify-between gap-3 border-b border-border px-4 py-3">
        <View className="flex-row rounded-[14px] bg-subtle p-1">
          <SupervisionButton
            label="Live"
            disabled={busy || !connected || !permitted}
            selected={mode === "live"}
            onPress={() => (liveStarted ? setMode("live") : void startLive())}
          />
          <SupervisionButton
            label="Agent Lens"
            selected={mode === "lens"}
            disabled={agentObservation === null}
            onPress={() => setMode("lens")}
          />
        </View>
        <Text className="text-xs font-t3-medium text-foreground-muted">
          {controlling
            ? "You control"
            : status?.lease?.controller === null || status?.lease?.controller === undefined
              ? liveStarted
                ? "Watching"
                : "Passive"
              : `${status.lease.controller.kind} controls`}
        </Text>
      </View>

      {error === null ? null : (
        <View className="px-4 pt-3">
          <ErrorBanner message={error} />
        </View>
      )}

      {status !== null && status.displays.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-4 py-3"
        >
          {status.displays.map((display) => (
            <SupervisionButton
              key={display.id}
              label={display.label || (display.primary ? "Primary" : display.id)}
              selected={liveStarted && selectedDisplayId === display.id}
              disabled={busy}
              onPress={() => void selectDisplay(display.id)}
            />
          ))}
        </ScrollView>
      ) : null}

      {mode === "lens" && observations.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-4 pb-3"
        >
          {observations.map((observation) => (
            <SupervisionButton
              key={observation.id}
              label={
                observation.recipient.kind === "controller"
                  ? observation.recipient.instanceId
                  : observation.recipient.modelSelection.model
              }
              selected={selectedObservationId === observation.id}
              disabled={busy}
              onPress={() => void selectObservation(observation.id)}
            />
          ))}
        </ScrollView>
      ) : null}

      {mode === "lens" && agentObservation !== null && agentObservation.images.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-4 pb-3"
        >
          {agentObservation.images.map((image) => (
            <SupervisionButton
              key={image.id}
              label={image.purpose ?? image.role.replaceAll("-", " ")}
              selected={selectedLensImageId === image.id}
              onPress={() => setSelectedLensImageId(image.id)}
            />
          ))}
        </ScrollView>
      ) : null}

      <View
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
        onLayout={updateSurface}
        {...(mode === "live" ? panHandlers : {})}
      >
        {mode === "live" && liveImage !== null ? (
          <Image
            source={{ uri: `data:${liveImage.mimeType};base64,${liveImage.data}` }}
            resizeMode="contain"
            style={StyleSheet.absoluteFill}
            accessibilityLabel={`${params.label} live screen`}
          />
        ) : mode === "lens" && lensImage?.screenshot.state === "image" ? (
          <Image
            source={{
              uri: `data:${lensImage.screenshot.mimeType};base64,${lensImage.screenshot.data}`,
            }}
            resizeMode="contain"
            style={StyleSheet.absoluteFill}
            accessibilityLabel={`${params.label} Agent Lens observation`}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-3 px-8">
            {busy ? <ActivityIndicator color="white" /> : null}
            <Text className="text-center text-sm leading-normal text-white/65">
              {mode === "live"
                ? liveStarted
                  ? "No current frame is available."
                  : "Start Live to request a current screen frame."
                : "No model-facing image is retained for this desktop."}
            </Text>
            {mode === "live" && !liveStarted ? (
              <SupervisionButton
                label="Start Live"
                disabled={busy}
                onPress={() => void startLive()}
              />
            ) : null}
          </View>
        )}
      </View>

      {mode === "lens" && agentObservation !== null ? (
        <View className="gap-1 border-t border-border bg-sheet px-4 py-3">
          <Text className="text-sm font-t3-bold text-foreground">
            {observationRecipient(agentObservation)} ·{" "}
            {selectedThread?.title ?? agentObservation.threadId}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {params.environmentLabel} · {agentObservation.source.replaceAll("-", " ")} ·{" "}
            {new Date(agentObservation.observedAt).toLocaleString()}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {lensImage === undefined
              ? "Semantic data only"
              : `${lensImage.purpose ?? lensImage.role.replaceAll("-", " ")} · ${lensImage.screenshot.width}×${lensImage.screenshot.height}`}
            {agentObservation.accessibility === undefined
              ? ""
              : ` · ${agentObservation.accessibility.targets.length} semantic targets`}
          </Text>
          {lensDisplayId === undefined ? null : (
            <View className="mt-1 items-start">
              <SupervisionButton
                label="Show in Live"
                disabled={busy}
                onPress={() => void selectDisplay(lensDisplayId)}
              />
            </View>
          )}
        </View>
      ) : null}

      {controlling && mode === "live" ? (
        <View className="gap-2 border-t border-border bg-sheet px-4 py-3">
          <View className="flex-row gap-2">
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Type into the focused app"
              className="min-w-0 flex-1 rounded-[13px] bg-subtle px-3.5 py-2.5 text-foreground"
              returnKeyType="send"
              onSubmitEditing={() => sendText(true)}
            />
            <SupervisionButton
              label="Type"
              disabled={text.length === 0}
              onPress={() => sendText(false)}
            />
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            <SupervisionButton
              label="Scroll up"
              onPress={() => void act([{ type: "wheel", verticalTicks: -3 }])}
            />
            <SupervisionButton
              label="Scroll down"
              onPress={() => void act([{ type: "wheel", verticalTicks: 3 }])}
            />
            <SupervisionButton
              label="Enter"
              onPress={() => void act([{ type: "press", key: "Enter" }])}
            />
            <SupervisionButton
              label="Escape"
              onPress={() => void act([{ type: "press", key: "Escape" }])}
            />
          </ScrollView>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="max-h-16 border-t border-border bg-sheet"
        contentContainerClassName="items-center gap-2 px-4 py-3"
      >
        {controlling ? (
          <SupervisionButton
            label="Release control"
            disabled={busy}
            onPress={() => void releaseControl()}
          />
        ) : (
          <SupervisionButton
            label="Take control"
            disabled={busy || !liveStarted || !params.supportsControl}
            onPress={takeControl}
          />
        )}
        {status?.lease?.canReturnControl ? (
          <SupervisionButton
            label="Return to agent"
            disabled={busy}
            onPress={() => void returnControl()}
          />
        ) : null}
        {liveStarted ? (
          <SupervisionButton
            label="Stop watching"
            disabled={busy}
            onPress={() => void releaseTransientAccess()}
          />
        ) : null}
        <SupervisionButton
          label="End all access"
          disabled={busy}
          destructive
          onPress={endAllAccess}
        />
      </ScrollView>
    </View>
  );
}

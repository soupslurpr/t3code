import { UserDesktopExecutionPanel, AgentDesktopExecutionPanel } from "./UserDesktopExecutionPanel";
import { DesktopScreenPermissionsPanel } from "./DesktopScreenPermissionsPanel";
import { useAtomValue } from "@effect/atom-react";
import { AgentDesktopId, type AgentDesktopOwner, type ThreadId } from "@t3tools/contracts";
import { createAgentDesktopSupervisionTransport } from "./AgentDesktopSupervisionTransport";
import { useDesktopSupervisionAccess } from "./useDesktopSupervisionAccess";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ComputerAutomationAction,
  ComputerAutomationFrame,
  ComputerAutomationLeaseId,
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  ComputerObservation,
  ComputerObservationId,
  ComputerObservationList,
  ComputerObservationUpdate,
  EnvironmentId,
  UserDesktopHumanInvokeInput,
  UserDesktopId,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
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
  retainMobileDesktopImage,
  type MobileDesktopPoint,
  type MobileDesktopSurface,
} from "./UserDesktopSupervisionRouteScreen.logic";

const LIVE_REFRESH_INTERVAL_MS = 750;
const METADATA_REFRESH_INTERVAL_MS = 2_000;
const ACCESS_REQUEST_TIMEOUT_MS = 120_000;
const VIEWER_MAX_WIDTH = 1_280;
const VIEWER_MAX_HEIGHT = 720;
const DRAG_THRESHOLD_POINTS = 6;

export interface UserDesktopSupervisionRouteParams extends Record<string, unknown> {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly desktopId: UserDesktopId;
  readonly label: string;
  readonly supportsControl: boolean;
  readonly threadId?: ThreadId;
  readonly agentOwner?: AgentDesktopOwner;
}

interface TouchStart {
  readonly frame: ComputerAutomationFrame;
  readonly point: MobileDesktopPoint;
}

/** Converts a bounded command failure into concise mobile UI prose. */
function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The User desktop request failed.";
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

/** Provides passive Agent Lens and explicit full-screen Live supervision on mobile. */
export function UserDesktopSupervisionRouteScreen({
  route,
}: StaticScreenProps<UserDesktopSupervisionRouteParams>) {
  const params = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const threads = useThreadShells();
  const invoke = useAtomCommand(previewEnvironment.invokeUserDesktopHuman, {
    reportFailure: false,
  });
  const invokeAgent = useAtomCommand(previewEnvironment.invokeAgentDesktopHuman, {
    reportFailure: false,
  });
  const allowed = useAtomValue(
    (params.agentOwner === undefined
      ? previewEnvironment.invokeUserDesktopHuman
      : previewEnvironment.invokeAgentDesktopHuman
    ).permissionAtom(params.environmentId),
  );
  const agentTransport = useMemo(
    () =>
      params.agentOwner === undefined
        ? null
        : createAgentDesktopSupervisionTransport(
            params.agentOwner,
            AgentDesktopId.make(params.desktopId),
            async (input) => {
              const result = await invokeAgent({ environmentId: params.environmentId, input });
              if (result._tag === "Success") return result.value;
              throw squashAtomCommandFailure(result);
            },
          ),
    [invokeAgent, params.agentOwner, params.desktopId, params.environmentId],
  );
  const [status, setStatus] = useState<ComputerAutomationStatus | null>(null);
  const [liveStarted, setLiveStarted] = useState(false);
  const [mode, setMode] = useState<"live" | "lens">("lens");
  const [snapshot, setSnapshot] = useState<ComputerAutomationSnapshot | null>(null);
  const [observations, setObservations] = useState<ComputerObservationList["observations"]>([]);
  const [selectedObservationId, setSelectedObservationId] = useState<ComputerObservationId | null>(
    null,
  );
  const [agentObservation, setAgentObservation] = useState<ComputerObservation | null>(null);
  const [selectedLensImageId, setSelectedLensImageId] = useState<string | null>(null);
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null);
  const [surface, setSurface] = useState<MobileDesktopSurface>({ width: 0, height: 0 });
  const [text, setText] = useState("");
  const [pending, setBusy] = useState(true);
  const busy = pending || !allowed;
  const [error, setError] = useState<string | null>(null);
  const snapshotRef = useRef(snapshot);
  const statusRef = useRef(status);
  const actionQueue = useRef<Promise<void>>(Promise.resolve());
  const touchStart = useRef<TouchStart | null>(null);
  const gestureActive = useRef(false);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    setSelectedLensImageId(agentObservation?.images.at(-1)?.id ?? null);
  }, [agentObservation?.id, agentObservation?.images]);

  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );

  const run = useCallback(
    async <Value,>(input: UserDesktopHumanInvokeInput) => {
      if (agentTransport !== null) return (await agentTransport(input)) as Value;
      const result = await invoke({ environmentId: params.environmentId, input });
      if (result._tag === "Success") {
        if (params.threadId !== undefined && input.request.operation === "observation-list") {
          const list = result.value as ComputerObservationList;
          return {
            observations: list.observations.filter((item) => item.threadId === params.threadId),
          } as Value;
        }
        return result.value as Value;
      }
      throw squashAtomCommandFailure(result);
    },
    [agentTransport, invoke, params.environmentId, params.threadId],
  );

  const clearAccess = useCallback(() => {
    setLiveStarted(false);
    setSnapshot(null);
    snapshotRef.current = null;
    statusRef.current = null;
    setStatus(null);
    gestureActive.current = false;
    touchStart.current = null;
    setBusy(false);
  }, []);
  const {
    currentGeneration,
    isCurrent,
    request: requestAccess,
    close: releaseTransientAccess,
  } = useDesktopSupervisionAccess(params.desktopId, run, clearAccess);

  const readObservation = useCallback(
    async (observationId: ComputerObservationId) => {
      const update = await run<ComputerObservationUpdate>({
        request: {
          operation: "observation",
          desktopId: params.desktopId,
          observationId,
        },
      });
      return update.observation ?? null;
    },
    [params.desktopId, run],
  );

  const selectDefaultObservation = useCallback(
    (list: ComputerObservationList["observations"], nextStatus: ComputerAutomationStatus) => {
      const controllingThreadId =
        nextStatus.lease?.controller?.kind === "agent" &&
        nextStatus.lease.controller.sameEnvironment
          ? nextStatus.lease.controller.threadId
          : undefined;
      return (
        list.find(
          (observation) =>
            controllingThreadId !== undefined && observation.threadId === controllingThreadId,
        ) ?? list[0]
      );
    },
    [],
  );

  const capture = useCallback(
    async (displayId = selectedDisplayId) => {
      const generation = currentGeneration();
      const current = snapshotRef.current;
      const contentHash =
        current?.screenshot?.state === "image" ? current.screenshot.contentHash : undefined;
      const next = await run<ComputerAutomationSnapshot>({
        request: {
          operation: "snapshot",
          desktopId: params.desktopId,
          input: {
            ...(displayId === null ? {} : { displayId }),
            includeAccessibility: false,
            screenshot: {
              maxWidth: VIEWER_MAX_WIDTH,
              maxHeight: VIEWER_MAX_HEIGHT,
              ...(contentHash === undefined ? {} : { unchangedIfContentHash: contentHash }),
            },
          },
        },
      });
      if (isCurrent(generation)) {
        setSnapshot((previous) => retainMobileDesktopImage(previous, next));
        setSelectedDisplayId(next.display.id);
      }
      return next;
    },
    [currentGeneration, isCurrent, params.desktopId, run, selectedDisplayId],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setBusy(true);
      setError(null);
      try {
        const [nextStatus, list] = await Promise.all([
          run<ComputerAutomationStatus>({
            request: { operation: "status", desktopId: params.desktopId },
          }),
          run<ComputerObservationList>({
            request: { operation: "observation-list", desktopId: params.desktopId },
          }),
        ]);
        const selected = selectDefaultObservation(list.observations, nextStatus);
        const exact = selected === undefined ? null : await readObservation(selected.id);
        if (cancelled) return;
        setStatus(nextStatus);
        setObservations(list.observations);
        setSelectedObservationId(selected?.id ?? null);
        setAgentObservation(exact);
        const primary =
          nextStatus.displays.find((display) => display.primary) ?? nextStatus.displays[0];
        setSelectedDisplayId(primary?.id ?? null);
        setMode(exact === null ? "live" : "lens");
      } catch (cause) {
        if (!cancelled) setError(failureMessage(cause));
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [params.desktopId, readObservation, run, selectDefaultObservation]);

  const startLive = useCallback(
    async (displayId?: string) => {
      const generation = currentGeneration();
      if (!isCurrent(generation)) return;
      setBusy(true);
      setError(null);
      try {
        const nextStatus = await requestAccess(
          {
            request: { operation: "request-view", desktopId: params.desktopId },
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          },
          generation,
        );
        if (nextStatus === null) return;
        const nextDisplayId =
          displayId ??
          selectedDisplayId ??
          nextStatus.displays.find((display) => display.primary)?.id ??
          nextStatus.displays[0]?.id;
        setStatus(nextStatus);
        setLiveStarted(true);
        setMode("live");
        setSelectedDisplayId(nextDisplayId ?? null);
        snapshotRef.current = null;
        setSnapshot(null);
        await capture(nextDisplayId);
      } catch (cause) {
        if (isCurrent(generation)) setError(failureMessage(cause));
      } finally {
        if (isCurrent(generation)) setBusy(false);
      }
    },
    [capture, currentGeneration, isCurrent, params.desktopId, requestAccess, selectedDisplayId],
  );

  const selectDisplay = useCallback(
    async (displayId: string) => {
      if (!liveStarted) {
        await startLive(displayId);
        return;
      }
      if (displayId === selectedDisplayId) {
        setMode("live");
        return;
      }
      setBusy(true);
      setError(null);
      snapshotRef.current = null;
      setSnapshot(null);
      setSelectedDisplayId(displayId);
      setMode("live");
      try {
        await capture(displayId);
      } catch (cause) {
        setError(failureMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [capture, liveStarted, selectedDisplayId, startLive],
  );

  const selectObservation = useCallback(
    async (observationId: ComputerObservationId) => {
      setBusy(true);
      setError(null);
      try {
        const exact = await readObservation(observationId);
        setSelectedObservationId(observationId);
        setAgentObservation(exact);
        setMode("lens");
      } catch (cause) {
        setError(failureMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [readObservation],
  );

  useEffect(() => {
    if (!liveStarted) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (cancelled) return;
      if (AppState.currentState === "active" && !gestureActive.current) {
        try {
          await capture();
          if (!cancelled) setError(null);
        } catch (cause) {
          if (!cancelled) setError(failureMessage(cause));
        }
      }
      if (!cancelled) timeout = setTimeout(poll, LIVE_REFRESH_INTERVAL_MS);
    };
    timeout = setTimeout(poll, LIVE_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeout !== null) clearTimeout(timeout);
    };
  }, [capture, liveStarted]);

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (cancelled) return;
      if (AppState.currentState === "active") {
        try {
          const [nextStatus, list] = await Promise.all([
            run<ComputerAutomationStatus>({
              request: { operation: "status", desktopId: params.desktopId },
            }),
            run<ComputerObservationList>({
              request: { operation: "observation-list", desktopId: params.desktopId },
            }),
          ]);
          if (!cancelled) {
            setStatus(nextStatus);
            setObservations(list.observations);
          }
        } catch (cause) {
          if (!cancelled) setError(failureMessage(cause));
        }
      }
      if (!cancelled) timeout = setTimeout(poll, METADATA_REFRESH_INTERVAL_MS);
    };
    timeout = setTimeout(poll, METADATA_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeout !== null) clearTimeout(timeout);
    };
  }, [params.desktopId, run]);

  const takeControlWithLease = useCallback(
    async (takeoverLeaseId?: ComputerAutomationLeaseId, generation = currentGeneration()) => {
      if (!isCurrent(generation)) return;
      setBusy(true);
      setError(null);
      try {
        const nextStatus = await requestAccess(
          {
            request: {
              operation: "request-control",
              desktopId: params.desktopId,
              ...(takeoverLeaseId === undefined ? {} : { takeoverLeaseId }),
            },
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          },
          generation,
        );
        if (nextStatus !== null) setStatus(nextStatus);
      } catch (cause) {
        if (isCurrent(generation)) setError(failureMessage(cause));
      } finally {
        if (isCurrent(generation)) setBusy(false);
      }
    },
    [currentGeneration, isCurrent, params.desktopId, requestAccess],
  );

  const takeControl = useCallback(() => {
    const lease = statusRef.current?.lease;
    if (!liveStarted || lease === undefined) return;
    const takeoverLeaseId = lease.takeoverLeaseId;
    if (takeoverLeaseId === undefined || lease.controller === null) {
      void takeControlWithLease();
      return;
    }
    const controller = lease.controller;
    const generation = currentGeneration();
    Alert.alert(
      "Take control of this desktop?",
      `${params.label} is controlled by ${
        controller.kind === "human"
          ? "another person"
          : controller.kind === "agent"
            ? "an agent"
            : "a local controller"
      }${controller.sameEnvironment ? "" : " through another environment"}. Taking over cancels queued input and releases held keys and buttons.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Take control",
          style: "destructive",
          onPress: () => void takeControlWithLease(takeoverLeaseId, generation),
        },
      ],
    );
  }, [currentGeneration, liveStarted, params.label, takeControlWithLease]);

  const releaseControl = useCallback(async () => {
    const generation = currentGeneration();
    if (!isCurrent(generation)) return;
    setBusy(true);
    setError(null);
    try {
      const nextStatus = await requestAccess(
        {
          request: { operation: "release-control", desktopId: params.desktopId },
        },
        generation,
      );
      if (nextStatus !== null) setStatus(nextStatus);
    } catch (cause) {
      if (isCurrent(generation)) setError(failureMessage(cause));
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  }, [currentGeneration, isCurrent, params.desktopId, requestAccess]);

  const returnControl = useCallback(async () => {
    const generation = currentGeneration();
    if (!isCurrent(generation)) return;
    setBusy(true);
    setError(null);
    try {
      const nextStatus = await requestAccess(
        {
          request: { operation: "return-control", desktopId: params.desktopId },
        },
        generation,
      );
      if (nextStatus !== null) setStatus(nextStatus);
    } catch (cause) {
      if (isCurrent(generation)) setError(failureMessage(cause));
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  }, [currentGeneration, isCurrent, params.desktopId, requestAccess]);

  const endAllAccess = useCallback(() => {
    Alert.alert(
      "End all desktop access?",
      "This stops every current viewer and controller on the physical desktop. Remembered approval is unchanged.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "End all access",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusy(true);
              try {
                await run({
                  request: { operation: "end-all-access", desktopId: params.desktopId },
                });
                setLiveStarted(false);
                setSnapshot(null);
                snapshotRef.current = null;
                setStatus(
                  await run<ComputerAutomationStatus>({
                    request: { operation: "status", desktopId: params.desktopId },
                  }),
                );
              } catch (cause) {
                setError(failureMessage(cause));
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  }, [params.desktopId, run]);

  const act = useCallback(
    (actions: ReadonlyArray<ComputerAutomationAction>) => {
      const execute = async () => {
        if (statusRef.current?.lease?.access !== "control") return;
        try {
          await run({
            request: {
              operation: "act",
              desktopId: params.desktopId,
              input: { actions: [...actions], observation: false },
            },
          });
          await capture();
          setError(null);
        } catch (cause) {
          setError(failureMessage(cause));
        }
      };
      const queued = actionQueue.current.then(execute, execute);
      actionQueue.current = queued;
      return queued;
    },
    [capture, params.desktopId, run],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => statusRef.current?.lease?.access === "control",
        onMoveShouldSetPanResponder: () => statusRef.current?.lease?.access === "control",
        onPanResponderGrant: (event) => {
          const frame = snapshotRef.current?.frame;
          if (frame === undefined) return;
          const point = mobileDesktopFramePoint({
            surface,
            frame,
            touch: { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
          });
          if (point === null) return;
          gestureActive.current = true;
          touchStart.current = { frame, point };
        },
        onPanResponderRelease: (event, gesture) => {
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
          const dragged = Math.hypot(gesture.dx, gesture.dy) >= DRAG_THRESHOLD_POINTS;
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
        onPanResponderTerminate: () => {
          touchStart.current = null;
          gestureActive.current = false;
        },
      }),
    [act, surface],
  );

  const updateSurface = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSurface({ width, height });
  }, []);

  const sendText = useCallback(
    (submit: boolean) => {
      if (text.length === 0) return;
      void act([{ type: "type", text, submit, verification: "best-effort" }]);
      setText("");
    },
    [act, text],
  );

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
            disabled={busy}
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
        {...(mode === "live" ? panResponder.panHandlers : {})}
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
              disabled={busy || text.length === 0}
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
        {params.agentOwner ? (
          <AgentDesktopExecutionPanel
            desktopId={params.desktopId}
            owner={params.agentOwner}
            label={params.label}
          />
        ) : (
          <>
            <DesktopScreenPermissionsPanel
              environmentId={params.environmentId}
              desktopId={params.desktopId}
              threadId={params.threadId}
            />
            <UserDesktopExecutionPanel
              environmentId={params.environmentId}
              environmentLabel={params.environmentLabel}
              desktop={{ kind: "user", desktopId: params.desktopId }}
              threadId={params.threadId}
            />
          </>
        )}
        {params.threadId === undefined && params.agentOwner === undefined ? (
          <SupervisionButton
            label="End all access"
            disabled={busy}
            destructive
            onPress={endAllAccess}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

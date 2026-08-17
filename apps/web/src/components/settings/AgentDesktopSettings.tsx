import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AgentDesktop,
  AgentDesktopHumanInvokeInput,
  AgentDesktopId,
  AgentDesktopRequirement,
  AgentDesktopSetupResult,
  ComputerAutomationAction,
  ComputerAutomationSnapshot,
  ComputerObservation,
  ComputerObservationImage,
  ComputerObservationUpdate,
  EnvironmentId,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import {
  CircleStopIcon,
  EyeIcon,
  HandIcon,
  ImagesIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  acquireAgentDesktopKeyboardCapture,
  type AgentDesktopKeyboardCapture,
} from "./agentDesktopKeyboardCapture";
import {
  agentDesktopObservationLayout,
  agentDesktopObservationViews,
  agentDesktopPixelScrollPosition,
} from "./agentDesktopObservation";

const VIEWER_REFRESH_INTERVAL_MS = 750;
const VIEWER_HOVER_DELAY_MS = 100;
const VIEWER_DRAG_THRESHOLD_PX = 4;
const VIEWER_MAX_WIDTH = 1_280;
const VIEWER_MAX_HEIGHT = 720;

interface ViewerPoint {
  readonly x: number;
  readonly y: number;
}

interface ViewerDragStart {
  readonly pointerId: number;
  readonly button: "left" | "right" | "middle";
  readonly point: ViewerPoint;
  readonly clientX: number;
  readonly clientY: number;
}

interface EnvironmentAvailability {
  readonly available: boolean;
  readonly requirements: ReadonlyArray<AgentDesktopRequirement>;
  readonly detail?: string;
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "The Agent desktop request failed.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1_024 ** 3).toFixed(1)} GB`;
}

/** Formats the end of a desktop's recovery window in local time. */
function formatRecoveryDeadline(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return "an unknown time";
  return new Date(milliseconds).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function stateBadgeVariant(state: AgentDesktop["state"]) {
  if (state === "failed") return "error" as const;
  if (state === "active" || state === "ready") return "success" as const;
  if (state === "recoverable") return "warning" as const;
  return "secondary" as const;
}

function stateLabel(state: AgentDesktop["state"]): string {
  if (state === "ready") return "Running";
  if (state === "active") return "In use";
  return `${state[0]!.toUpperCase()}${state.slice(1)}`;
}

function pointerButton(button: number): ViewerDragStart["button"] | null {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return null;
}

function keyboardKey(event: ReactKeyboardEvent): string | null {
  if (/^Key[A-Z]$/u.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/u.test(event.code)) return event.code.slice(5);
  const codeKeys: Readonly<Record<string, string>> = {
    AltLeft: "AltLeft",
    AltRight: "AltRight",
    Backquote: "`",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Comma: ",",
    ControlLeft: "ControlLeft",
    ControlRight: "ControlRight",
    Equal: "=",
    MetaLeft: "MetaLeft",
    MetaRight: "MetaRight",
    Minus: "-",
    Period: ".",
    Quote: "'",
    Semicolon: ";",
    ShiftLeft: "ShiftLeft",
    ShiftRight: "ShiftRight",
    Slash: "/",
    Space: "Space",
  };
  const codeKey = codeKeys[event.code];
  if (codeKey !== undefined) return codeKey;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(event.key)) return event.key;
  const namedKeys = new Set([
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "Backspace",
    "CapsLock",
    "Delete",
    "End",
    "Enter",
    "Escape",
    "Home",
    "Insert",
    "PageDown",
    "PageUp",
    "Tab",
  ]);
  return namedKeys.has(event.key) ? event.key : null;
}

function wheelTicks(delta: number, deltaMode: number): number {
  if (delta === 0) return 0;
  const units = deltaMode === 1 ? delta : deltaMode === 2 ? delta * 3 : delta / 100;
  const rounded = Math.round(units);
  return Math.max(-100, Math.min(100, rounded === 0 ? Math.sign(delta) : rounded));
}

/** Formats one exact image encoding for the Agent lens status. */
function observationEncoding(image: ComputerObservationImage): string {
  if (image.screenshot.state === "unchanged") return "unchanged";
  const encoding = image.screenshot.encoding;
  if (encoding.format === "png") return "PNG";
  if (encoding.mode === "lossless") return "lossless WebP";
  return `${encoding.mode} WebP${encoding.quality === undefined ? "" : ` q${encoding.quality}`}`;
}

/** Identifies the model-facing recipient without implying model attention. */
function observationRecipient(observation: ComputerObservation): string {
  const recipient = observation.recipient;
  if (recipient.kind === "controller") return `Controller · ${recipient.instanceId}`;
  return `Watch evaluator · ${recipient.modelSelection.model}`;
}

/** Formats the operation that produced a model-facing observation. */
function observationSource(observation: ComputerObservation): string {
  return observation.source.replaceAll("-", " ");
}

/** Overlays exact delivered pixels at their desktop-logical location. */
function AgentObservationOverlay({
  liveFrame,
  images,
}: {
  liveFrame: NonNullable<ComputerAutomationSnapshot["frame"]>;
  images: ReadonlyArray<ComputerObservationImage>;
}) {
  const positioned = images.flatMap((image) => {
    const layout = agentDesktopObservationLayout(image, liveFrame);
    return layout === null ? [] : [{ image, layout }];
  });
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0 bg-black/55" />
      {positioned.map(({ image, layout }) => (
        <div
          key={image.id}
          className="absolute overflow-hidden bg-cyan-950/30"
          style={{
            left: `${layout.leftPercent}%`,
            top: `${layout.topPercent}%`,
            width: `${layout.widthPercent}%`,
            height: `${layout.heightPercent}%`,
          }}
        >
          {image.screenshot.state === "image" ? (
            <img
              src={`data:${image.screenshot.mimeType};base64,${image.screenshot.data}`}
              alt=""
              draggable={false}
              className="size-full object-fill"
            />
          ) : (
            <div className="size-full bg-cyan-950/30" />
          )}
          <div className="absolute inset-0 z-10 border-2 border-cyan-300 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.8)]" />
          <span className="absolute left-1.5 top-1.5 z-20 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/80 px-1.5 py-0.5 text-[10px] leading-none text-white shadow-sm ring-1 ring-white/15">
            {image.purpose ?? image.id}
          </span>
        </div>
      ))}
      {positioned.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/75">
          This observation contains no displayable image bytes for the current display.
        </div>
      ) : null}
    </div>
  );
}

function DesktopViewer({
  desktop,
  observation,
  agentObservation,
  controlling,
  busy,
  error,
  onTakeControl,
  onRelease,
  onAction,
}: {
  desktop: AgentDesktop;
  observation: ComputerAutomationSnapshot | null;
  agentObservation: ComputerObservation | null;
  controlling: boolean;
  busy: boolean;
  error: string | null;
  onTakeControl: () => Promise<boolean>;
  onRelease: () => Promise<boolean>;
  onAction: (actions: ReadonlyArray<ComputerAutomationAction>) => Promise<void>;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef<ViewerDragStart | null>(null);
  const heldKeysRef = useRef(new Set<string>());
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardCaptureRef = useRef<AgentDesktopKeyboardCapture | null>(null);
  const controlAttemptRef = useRef(false);
  const mountedRef = useRef(true);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"live" | "lens">("live");
  const [selectedObservationViewId, setSelectedObservationViewId] = useState<string | null>(null);
  const [inspectPixels, setInspectPixels] = useState(false);
  const [inspectSemantics, setInspectSemantics] = useState(false);
  const observationViews = useMemo(
    () => (agentObservation === null ? [] : agentDesktopObservationViews(agentObservation)),
    [agentObservation],
  );
  const selectedObservationView =
    observationViews.find((view) => view.id === selectedObservationViewId) ??
    observationViews.at(-1) ??
    null;

  useEffect(() => {
    setSelectedObservationViewId(observationViews.at(-1)?.id ?? null);
    setInspectPixels(false);
    setInspectSemantics(false);
  }, [agentObservation?.id, observationViews]);

  useEffect(() => {
    if (agentObservation === null) setViewMode("live");
  }, [agentObservation]);

  const framePoint = useCallback(
    (clientX: number, clientY: number): ViewerPoint | null => {
      const image = imageRef.current;
      const frame = observation?.frame;
      if (image === null || frame === undefined) return null;
      const bounds = image.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      if (
        clientX < bounds.left ||
        clientX >= bounds.right ||
        clientY < bounds.top ||
        clientY >= bounds.bottom
      ) {
        return null;
      }
      return {
        x: Math.max(
          0,
          Math.min(frame.width - 1, ((clientX - bounds.left) / bounds.width) * frame.width),
        ),
        y: Math.max(
          0,
          Math.min(frame.height - 1, ((clientY - bounds.top) / bounds.height) * frame.height),
        ),
      };
    },
    [observation?.frame],
  );

  const cancelHover = useCallback(() => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  useEffect(() => cancelHover, [cancelHover]);

  useEffect(() => {
    if (controlling) surfaceRef.current?.focus({ preventScroll: true });
  }, [controlling]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!controlling) return;
      const button = pointerButton(event.button);
      const point = framePoint(event.clientX, event.clientY);
      if (button === null || point === null) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      cancelHover();
      dragStartRef.current = {
        pointerId: event.pointerId,
        button,
        point,
        clientX: event.clientX,
        clientY: event.clientY,
      };
    },
    [cancelHover, controlling, framePoint],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!controlling || dragStartRef.current !== null) return;
      const point = framePoint(event.clientX, event.clientY);
      const frame = observation?.frame;
      if (point === null || frame === undefined) return;
      cancelHover();
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        void onAction([
          {
            type: "move",
            frameId: frame.id,
            ...point,
            settleMs: 0,
          },
        ]);
      }, VIEWER_HOVER_DELAY_MS);
    },
    [cancelHover, controlling, framePoint, observation?.frame, onAction],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      if (start === null || start.pointerId !== event.pointerId) return;
      dragStartRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const end = framePoint(event.clientX, event.clientY);
      const frame = observation?.frame;
      if (!controlling || end === null || frame === undefined) return;
      event.preventDefault();
      const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
      void onAction(
        distance >= VIEWER_DRAG_THRESHOLD_PX
          ? [
              {
                type: "drag",
                frameId: frame.id,
                startX: start.point.x,
                startY: start.point.y,
                endX: end.x,
                endY: end.y,
                button: start.button,
              },
            ]
          : [{ type: "click", frameId: frame.id, ...end, button: start.button }],
      );
    },
    [controlling, framePoint, observation?.frame, onAction],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!controlling) return;
      const point = framePoint(event.clientX, event.clientY);
      const frame = observation?.frame;
      if (point === null || frame === undefined) return;
      event.preventDefault();
      const horizontalTicks = wheelTicks(event.deltaX, event.deltaMode);
      const verticalTicks = wheelTicks(event.deltaY, event.deltaMode);
      if (horizontalTicks === 0 && verticalTicks === 0) return;
      void onAction([
        {
          type: "wheel",
          frameId: frame.id,
          ...point,
          horizontalTicks,
          verticalTicks,
        },
      ]);
    },
    [controlling, framePoint, observation?.frame, onAction],
  );

  const handlePixelWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const next = agentDesktopPixelScrollPosition({
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
      scrollWidth: scroller.scrollWidth,
      scrollHeight: scroller.scrollHeight,
      clientWidth: scroller.clientWidth,
      clientHeight: scroller.clientHeight,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      shiftKey: event.shiftKey,
    });
    if (!next.consumed) return;
    event.preventDefault();
    event.stopPropagation();
    scroller.scrollLeft = next.left;
    scroller.scrollTop = next.top;
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!controlling) return;
      const key = keyboardKey(event);
      if (key === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || heldKeysRef.current.has(key)) return;
      heldKeysRef.current.add(key);
      void onAction([{ type: "key_down", key }]);
    },
    [controlling, onAction],
  );

  const handleKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!controlling) return;
      const key = keyboardKey(event);
      if (key === null) return;
      event.preventDefault();
      event.stopPropagation();
      heldKeysRef.current.delete(key);
      void onAction([{ type: "key_up", key }]);
    },
    [controlling, onAction],
  );

  const releaseHeldKeys = useCallback(() => {
    if (heldKeysRef.current.size === 0) return;
    const actions = Array.from(heldKeysRef.current, (key) => ({
      type: "key_up" as const,
      key,
    }));
    heldKeysRef.current.clear();
    void onAction(actions);
  }, [onAction]);

  const releaseKeyboardCapture = useCallback(async () => {
    const capture = keyboardCaptureRef.current;
    keyboardCaptureRef.current = null;
    if (capture === null) return;
    try {
      await capture.release();
    } catch (cause) {
      setCaptureError(failureMessage(cause));
    }
  }, []);

  const takeControl = useCallback(async () => {
    if (controlAttemptRef.current) return;
    controlAttemptRef.current = true;
    setViewMode("live");
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const capture = await acquireAgentDesktopKeyboardCapture();
      if (!mountedRef.current) {
        await capture.release();
        return;
      }
      keyboardCaptureRef.current = capture;
      const granted = await onTakeControl();
      if (!mountedRef.current) {
        if (granted) await onRelease();
        await capture.release();
        return;
      }
      const ownsCapture = keyboardCaptureRef.current === capture;
      if (!granted || !ownsCapture || document.fullscreenElement === null) {
        if (granted && ownsCapture) await onRelease();
        if (ownsCapture) await releaseKeyboardCapture();
        if (granted) {
          setCaptureError("Full screen ended before Agent desktop control became active.");
        }
      }
    } catch (cause) {
      await releaseKeyboardCapture();
      if (mountedRef.current) setCaptureError(failureMessage(cause));
    } finally {
      controlAttemptRef.current = false;
      if (mountedRef.current) setCaptureBusy(false);
    }
  }, [onRelease, onTakeControl, releaseKeyboardCapture]);

  const releaseControl = useCallback(async () => {
    releaseHeldKeys();
    await onRelease();
    await releaseKeyboardCapture();
  }, [onRelease, releaseHeldKeys, releaseKeyboardCapture]);

  useEffect(() => {
    if (!controlling) void releaseKeyboardCapture();
  }, [controlling, releaseKeyboardCapture]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (document.fullscreenElement !== null || keyboardCaptureRef.current === null) return;
      void releaseKeyboardCapture();
      releaseHeldKeys();
      void onRelease();
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [onRelease, releaseHeldKeys, releaseKeyboardCapture]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const capture = keyboardCaptureRef.current;
      keyboardCaptureRef.current = null;
      if (capture !== null) void capture.release();
    };
  }, []);

  const liveFrame = observation?.frame;
  const lensActive = viewMode === "lens" && agentObservation !== null;
  const selectedImages = selectedObservationView?.images ?? [];
  const hasSelectedPixels = selectedImages.some((image) => image.screenshot.state === "image");
  const liveSurfaceStyle =
    liveFrame === undefined
      ? undefined
      : {
          aspectRatio: `${liveFrame.width} / ${liveFrame.height}`,
          width: `min(100%, ${liveFrame.width}px, calc(65vh * ${liveFrame.width / liveFrame.height}))`,
        };

  return (
    <DialogPopup
      className="row-start-1 row-end-4 h-full w-[min(96vw,1100px)] max-w-none self-start"
      bottomStickOnMobile={false}
    >
      <DialogHeader>
        <DialogTitle>{desktop.label}</DialogTitle>
        <DialogDescription>
          Live supervision for this isolated Agent desktop. Taking control safely releases input
          held by its agent and enters full screen so host shortcuts go only to the remote desktop.
          GNOME may ask once to inhibit shortcuts; Super+Escape always restores them.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div
          ref={surfaceRef}
          className={cn(
            "overflow-hidden rounded-xl border bg-black outline-none",
            controlling && "cursor-crosshair focus-visible:ring-2 focus-visible:ring-ring",
          )}
          tabIndex={controlling ? 0 : -1}
          role="application"
          aria-label={`${desktop.label} remote screen`}
          onBlur={releaseHeldKeys}
          onContextMenu={(event) => controlling && event.preventDefault()}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onPointerCancel={() => {
            dragStartRef.current = null;
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
        >
          {observation?.screenshot?.state === "image" && liveFrame !== undefined ? (
            <div className="relative mx-auto" style={liveSurfaceStyle}>
              <img
                ref={imageRef}
                src={`data:${observation.screenshot.mimeType};base64,${observation.screenshot.data}`}
                alt={`${desktop.label} screen`}
                draggable={false}
                className="size-full touch-none select-none object-fill"
              />
              {lensActive && selectedObservationView !== null ? (
                <AgentObservationOverlay liveFrame={liveFrame} images={selectedImages} />
              ) : null}
            </div>
          ) : (
            <div className="flex aspect-video items-center justify-center text-sm text-white/60">
              No screen frame is available.
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex rounded-lg border bg-muted/30 p-0.5" role="group" aria-label="View">
            <Button
              size="xs"
              variant={viewMode === "live" ? "secondary" : "ghost"}
              aria-pressed={viewMode === "live"}
              onClick={() => setViewMode("live")}
            >
              Live
            </Button>
            <Button
              size="xs"
              variant={lensActive ? "secondary" : "ghost"}
              aria-pressed={lensActive}
              disabled={agentObservation === null}
              onClick={() => setViewMode("lens")}
            >
              <ImagesIcon />
              Agent lens
            </Button>
          </div>
          {lensActive && agentObservation !== null ? (
            <div className="text-right text-[11px] leading-tight text-muted-foreground">
              <p>{observationRecipient(agentObservation)}</p>
              <p>
                {observationSource(agentObservation)} · Observed{" "}
                {formatRelativeTimeLabel(agentObservation.observedAt)}
              </p>
            </div>
          ) : null}
        </div>
        {lensActive && agentObservation !== null ? (
          <div className="mt-2 rounded-lg border bg-muted/20 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {observationViews.length > 1
                ? observationViews.map((view) => (
                    <Button
                      key={view.id}
                      size="xs"
                      variant={selectedObservationView?.id === view.id ? "secondary" : "outline"}
                      aria-pressed={selectedObservationView?.id === view.id}
                      onClick={() => setSelectedObservationViewId(view.id)}
                    >
                      {view.label}
                    </Button>
                  ))
                : null}
              {hasSelectedPixels ? (
                <Button
                  size="xs"
                  variant={inspectPixels ? "secondary" : "outline"}
                  aria-pressed={inspectPixels}
                  onClick={() => setInspectPixels((current) => !current)}
                >
                  1:1 pixels
                </Button>
              ) : null}
              {agentObservation.accessibility !== undefined ? (
                <Button
                  size="xs"
                  variant={inspectSemantics ? "secondary" : "outline"}
                  aria-pressed={inspectSemantics}
                  onClick={() => setInspectSemantics((current) => !current)}
                >
                  {agentObservation.accessibility.targets.length} semantic targets
                </Button>
              ) : null}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {selectedImages.length === 0
                ? "This delivery contained semantic data without image pixels."
                : `${selectedImages.length} delivered image${selectedImages.length === 1 ? "" : "s"}`}
              {agentObservation.label === undefined ? "" : ` · ${agentObservation.label}`}
            </p>
            {selectedImages.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                {selectedImages.map((image) => (
                  <span key={image.id}>
                    {image.purpose ?? image.role.replaceAll("-", " ")} · {image.screenshot.width}×
                    {image.screenshot.height} · {observationEncoding(image)}
                  </span>
                ))}
              </div>
            ) : null}
            {inspectPixels ? (
              <div
                className="mt-2 flex max-h-[40vh] gap-3 overflow-auto overscroll-contain rounded-md bg-black p-2"
                onWheelCapture={handlePixelWheel}
              >
                {selectedImages.flatMap((image) =>
                  image.screenshot.state === "image"
                    ? [
                        <figure key={image.id} className="shrink-0">
                          <img
                            src={`data:${image.screenshot.mimeType};base64,${image.screenshot.data}`}
                            alt={image.purpose ?? image.id}
                            draggable={false}
                            width={image.screenshot.width}
                            height={image.screenshot.height}
                            className="max-w-none"
                          />
                          <figcaption className="mt-1 text-[10px] text-white/70">
                            {image.purpose ?? image.id} · {image.screenshot.width}×
                            {image.screenshot.height} · {observationEncoding(image)}
                          </figcaption>
                        </figure>,
                      ]
                    : [],
                )}
              </div>
            ) : null}
            {inspectSemantics && agentObservation.accessibility !== undefined ? (
              <div className="mt-2 max-h-44 overflow-auto rounded-md border bg-background p-2 text-[11px]">
                {agentObservation.accessibility.targets.length === 0 ? (
                  <p className="text-muted-foreground">
                    {agentObservation.accessibility.detail ?? "No semantic targets were exposed."}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {agentObservation.accessibility.targets.map((target) => (
                      <li key={target.id}>
                        <span className="font-medium">{target.name || target.role}</span>
                        <span className="text-muted-foreground">
                          {` · ${target.role} · ${target.activation}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="mt-3 min-h-5 text-xs text-muted-foreground">
          {error ??
            captureError ??
            (controlling
              ? "Full-screen input control is active. Click the screen to focus its keyboard."
              : "Watching live. Taking control captures host shortcuts in full screen.")}
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {controlling ? (
            <Button
              variant="outline"
              disabled={busy || captureBusy}
              onClick={() => void releaseControl()}
            >
              Release control
            </Button>
          ) : (
            <Button disabled={busy || captureBusy} onClick={() => void takeControl()}>
              <HandIcon />
              {captureBusy ? "Taking control…" : "Take control"}
            </Button>
          )}
        </div>
      </DialogPanel>
    </DialogPopup>
  );
}

/** Lists, watches, takes over, and manages isolated Agent desktops. */
export function AgentDesktopSettings() {
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const invoke = useAtomCommand(previewEnvironment.invokeAgentDesktopHuman, {
    reportFailure: false,
  });
  const [desktops, setDesktops] = useState<ReadonlyArray<AgentDesktop>>([]);
  const [availability, setAvailability] = useState<
    ReadonlyMap<EnvironmentId, EnvironmentAvailability>
  >(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyDesktopId, setBusyDesktopId] = useState<AgentDesktopId | null>(null);
  const [openingViewerId, setOpeningViewerId] = useState<AgentDesktopId | null>(null);
  const [busyEnvironmentId, setBusyEnvironmentId] = useState<EnvironmentId | null>(null);
  const [setupEnvironmentId, setSetupEnvironmentId] = useState<EnvironmentId | null>(null);
  const [permanentDeleteDesktop, setPermanentDeleteDesktop] = useState<AgentDesktop | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{
    readonly desktop: AgentDesktop;
    readonly observation: ComputerAutomationSnapshot;
    readonly agentObservation: ComputerObservation | null;
    readonly controlling: boolean;
  } | null>(null);
  const viewerRef = useRef(viewer);
  const viewerActionQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);

  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );

  const run = useCallback(
    async <Value,>(environmentId: EnvironmentId, input: AgentDesktopHumanInvokeInput) => {
      const result = await invoke({ environmentId, input });
      if (result._tag === "Success") return result.value as Value;
      throw squashAtomCommandFailure(result);
    },
    [invoke],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(
      environments.map(async (environment) => {
        try {
          const value = await run<{
            readonly available: boolean;
            readonly desktops: ReadonlyArray<AgentDesktop>;
            readonly requirements: ReadonlyArray<AgentDesktopRequirement>;
            readonly detail?: string;
          }>(environment.environmentId, {
            threadId: ThreadId.make("agent-desktop-settings"),
            request: { operation: "list" },
          });
          return { environmentId: environment.environmentId, value } as const;
        } catch (cause) {
          return { environmentId: environment.environmentId, cause } as const;
        }
      }),
    );
    const nextDesktops: AgentDesktop[] = [];
    const nextAvailability = new Map<EnvironmentId, EnvironmentAvailability>();
    let firstError: string | null = null;
    for (const result of results) {
      if ("value" in result) {
        nextAvailability.set(result.environmentId, {
          available: result.value.available,
          requirements: result.value.requirements,
          ...(result.value.detail === undefined ? {} : { detail: result.value.detail }),
        });
        nextDesktops.push(...result.value.desktops);
      } else {
        nextAvailability.set(result.environmentId, { available: false, requirements: [] });
        firstError ??= failureMessage(result.cause);
      }
    }
    nextDesktops.sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
    setAvailability(nextAvailability);
    setDesktops(nextDesktops);
    setError(firstError);
    setLoading(false);
  }, [environments, run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setupEnvironment = useCallback(async () => {
    const environmentId = setupEnvironmentId;
    if (environmentId === null) return;
    setSetupEnvironmentId(null);
    setBusyEnvironmentId(environmentId);
    setError(null);
    try {
      const result = await run<AgentDesktopSetupResult>(environmentId, {
        threadId: ThreadId.make("agent-desktop-settings"),
        request: { operation: "setup" },
        timeoutMs: 4_560_000,
      });
      await refresh();
      if (!result.completed && result.detail !== undefined) setError(result.detail);
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusyEnvironmentId(null);
    }
  }, [refresh, run, setupEnvironmentId]);

  const manage = useCallback(
    async (
      desktop: AgentDesktop,
      operation: "resume" | "park" | "stop" | "delete" | "restore" | "delete-permanently",
    ) => {
      setBusyDesktopId(desktop.id);
      setError(null);
      try {
        await run(desktop.owner.environmentId, {
          threadId: desktop.owner.threadId,
          request: {
            operation: "manage",
            owner: desktop.owner,
            input: { operation, desktopId: desktop.id },
          },
        });
        await refresh();
      } catch (cause) {
        setError(failureMessage(cause));
      } finally {
        setBusyDesktopId(null);
      }
    },
    [refresh, run],
  );

  const openViewer = useCallback(
    async (desktop: AgentDesktop) => {
      setBusyDesktopId(desktop.id);
      setOpeningViewerId(desktop.id);
      setError(null);
      setViewerError(null);
      try {
        await run(desktop.owner.environmentId, {
          threadId: desktop.owner.threadId,
          request: { operation: "request-view", owner: desktop.owner, desktopId: desktop.id },
        });
        const observation = await run<ComputerAutomationSnapshot>(desktop.owner.environmentId, {
          threadId: desktop.owner.threadId,
          request: {
            operation: "snapshot",
            owner: desktop.owner,
            desktopId: desktop.id,
            input: {
              includeAccessibility: false,
              screenshot: { maxWidth: VIEWER_MAX_WIDTH, maxHeight: VIEWER_MAX_HEIGHT },
            },
          },
        });
        let agentObservation: ComputerObservation | null = null;
        try {
          const update = await run<ComputerObservationUpdate>(desktop.owner.environmentId, {
            threadId: desktop.owner.threadId,
            request: {
              operation: "observation",
              owner: desktop.owner,
              desktopId: desktop.id,
            },
          });
          agentObservation = update.observation ?? null;
        } catch (cause) {
          setViewerError(`Agent lens unavailable: ${failureMessage(cause)}`);
        }
        setViewer({
          desktop,
          observation,
          agentObservation,
          controlling: false,
        });
      } catch (cause) {
        setError(failureMessage(cause));
      } finally {
        setOpeningViewerId(null);
        setBusyDesktopId(null);
      }
    },
    [run],
  );

  useEffect(() => {
    if (viewer === null) return;
    const desktop = viewer.desktop;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const schedule = () => {
      if (!cancelled) timeout = setTimeout(poll, VIEWER_REFRESH_INTERVAL_MS);
    };
    const poll = async () => {
      if (cancelled || inFlight) return;
      if (document.visibilityState !== "visible") {
        schedule();
        return;
      }
      inFlight = true;
      let failure: unknown = null;
      try {
        const observation = await run<ComputerAutomationSnapshot>(desktop.owner.environmentId, {
          threadId: desktop.owner.threadId,
          request: {
            operation: "snapshot",
            owner: desktop.owner,
            desktopId: desktop.id,
            input: {
              includeAccessibility: false,
              screenshot: { maxWidth: VIEWER_MAX_WIDTH, maxHeight: VIEWER_MAX_HEIGHT },
            },
          },
        });
        if (cancelled) return;
        setViewer((current) =>
          current?.desktop.id === desktop.id ? { ...current, observation } : current,
        );
      } catch (cause) {
        failure = cause;
      }
      try {
        const currentObservation = viewerRef.current?.agentObservation;
        const update = await run<ComputerObservationUpdate>(desktop.owner.environmentId, {
          threadId: desktop.owner.threadId,
          request: {
            operation: "observation",
            owner: desktop.owner,
            desktopId: desktop.id,
            ...(currentObservation === null || currentObservation === undefined
              ? {}
              : { afterId: currentObservation.id }),
          },
        });
        if (!cancelled) {
          setViewer((current) => {
            if (current?.desktop.id !== desktop.id) return current;
            if (update.latestId === null) return { ...current, agentObservation: null };
            return update.observation === undefined
              ? current
              : { ...current, agentObservation: update.observation };
          });
        }
      } catch (cause) {
        failure ??= cause;
      }
      if (!cancelled) setViewerError(failure === null ? null : failureMessage(failure));
      inFlight = false;
      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      if (timeout !== null) clearTimeout(timeout);
    };
  }, [run, viewer?.desktop]);

  const actInViewer = useCallback(
    (actions: ReadonlyArray<ComputerAutomationAction>): Promise<void> => {
      const selected = viewerRef.current;
      if (selected === null || !selected.controlling) return Promise.resolve();
      const desktop = selected.desktop;
      const execute = async () => {
        const current = viewerRef.current;
        if (current?.desktop.id !== desktop.id || !current.controlling) return;
        try {
          await run(desktop.owner.environmentId, {
            threadId: desktop.owner.threadId,
            request: {
              operation: "act",
              owner: desktop.owner,
              desktopId: desktop.id,
              input: { actions: [...actions], observation: false },
            },
          });
          setViewerError(null);
        } catch (cause) {
          setViewerError(failureMessage(cause));
        }
      };
      const queued = viewerActionQueueRef.current.then(execute, execute);
      viewerActionQueueRef.current = queued;
      return queued;
    },
    [run],
  );

  const setViewerControl = useCallback(
    async (controlling: boolean) => {
      if (viewer === null) return false;
      setBusyDesktopId(viewer.desktop.id);
      setViewerError(null);
      try {
        if (controlling) {
          await run(viewer.desktop.owner.environmentId, {
            threadId: viewer.desktop.owner.threadId,
            request: {
              operation: "request-control",
              owner: viewer.desktop.owner,
              desktopId: viewer.desktop.id,
            },
          });
        } else {
          await run(viewer.desktop.owner.environmentId, {
            threadId: viewer.desktop.owner.threadId,
            request: {
              operation: "release",
              owner: viewer.desktop.owner,
              desktopId: viewer.desktop.id,
            },
          });
          await run(viewer.desktop.owner.environmentId, {
            threadId: viewer.desktop.owner.threadId,
            request: {
              operation: "request-view",
              owner: viewer.desktop.owner,
              desktopId: viewer.desktop.id,
            },
          });
        }
        setViewer((current) => (current === null ? null : { ...current, controlling }));
        return true;
      } catch (cause) {
        setViewerError(failureMessage(cause));
        return false;
      } finally {
        setBusyDesktopId(null);
      }
    },
    [run, viewer],
  );

  const closeViewer = useCallback(async () => {
    const current = viewer;
    setViewer(null);
    setViewerError(null);
    if (current === null) return;
    try {
      await run(current.desktop.owner.environmentId, {
        threadId: current.desktop.owner.threadId,
        request: {
          operation: "release",
          owner: current.desktop.owner,
          desktopId: current.desktop.id,
        },
      });
    } catch {
      // Closing the viewer is best effort; the host also clears leases on disconnect.
    }
  }, [run, viewer]);

  const availableCount = Array.from(availability.values()).filter(
    (status) => status.available,
  ).length;
  const environmentNotices = Array.from(availability).filter(
    ([, status]) => !status.available || status.detail !== undefined,
  );
  const setupStatus =
    setupEnvironmentId === null ? undefined : availability.get(setupEnvironmentId);
  const setupPackages = Array.from(
    new Set(
      setupStatus?.requirements.flatMap((requirement) =>
        requirement.status !== "ready" && requirement.remedy?.automatic
          ? (requirement.remedy.packages ?? [])
          : [],
      ) ?? [],
    ),
  ).sort();
  const setupIncludesImage =
    setupStatus?.requirements.some(
      (requirement) =>
        requirement.id === "base-image" &&
        requirement.status !== "ready" &&
        requirement.remedy?.automatic,
    ) === true;

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="agent-desktops"
        title="Agent desktops"
        headerAction={
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
        }
      >
        <p className="px-3 pb-1 text-sm text-muted-foreground sm:px-4">
          Independent desktops that agents can use without interrupting your desktop. Resources,
          parking, retention, and network boundaries are managed automatically. Inactive desktops
          enter a seven-day recovery window after 30 days or when host storage is low.
        </p>
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {environmentNotices.map(([environmentId, status]) => {
          const hasAutomaticRemedy = status.requirements.some(
            (requirement) =>
              requirement.status !== "ready" && requirement.remedy?.automatic === true,
          );
          return (
            <Alert
              key={environmentId}
              variant={status.available || hasAutomaticRemedy ? "warning" : "error"}
            >
              <AlertDescription>
                {environmentById.get(environmentId)?.label ?? "Unknown device"}:{" "}
                {status.detail ?? "Agent desktop support is unavailable."}
              </AlertDescription>
              {hasAutomaticRemedy ? (
                <AlertAction>
                  <Button
                    size="xs"
                    disabled={busyEnvironmentId !== null}
                    onClick={() => setSetupEnvironmentId(environmentId)}
                  >
                    {busyEnvironmentId === environmentId ? "Setting up…" : "Set up"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          );
        })}
        {desktops.length === 0 ? (
          <div className="rounded-xl border border-dashed px-5 py-10 text-center">
            <MonitorIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
            <p className="font-medium">No Agent desktops yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {availableCount > 0
                ? "An agent will create one automatically when a task benefits from a separate desktop."
                : "No connected environment currently advertises Agent desktop support."}
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {desktops.map((desktop) => {
              const thread = threadById.get(desktop.owner.threadId);
              const environment = environmentById.get(desktop.owner.environmentId);
              const busy = busyDesktopId === desktop.id;
              const openingViewer = openingViewerId === desktop.id;
              const resumable = desktop.state === "parked" || desktop.state === "stopped";
              const recoverable = desktop.state === "recoverable";
              return (
                <Card key={desktop.id}>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      {desktop.label}
                      <Badge variant={stateBadgeVariant(desktop.state)}>
                        {stateLabel(desktop.state)}
                      </Badge>
                      {!desktop.automaticParking ? (
                        <Badge variant="secondary">Kept running</Badge>
                      ) : null}
                      {desktop.retention === "preserve" ? (
                        <Badge variant="secondary">preserved</Badge>
                      ) : null}
                    </CardTitle>
                    <CardDescription>
                      {thread?.title ?? "Unknown thread"} · {environment?.label ?? "Unknown device"}
                    </CardDescription>
                    <CardAction>
                      {recoverable ? null : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void openViewer(desktop)}
                        >
                          <EyeIcon />
                          {openingViewer ? (resumable ? "Resuming…" : "Opening…") : "Watch"}
                        </Button>
                      )}
                    </CardAction>
                  </CardHeader>
                  <CardPanel className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-muted-foreground">
                      <p>
                        {recoverable && desktop.recoverableUntil !== null
                          ? `Recoverable until ${formatRecoveryDeadline(desktop.recoverableUntil)}`
                          : desktop.resources
                            ? `${desktop.resources.cpuUsagePercent.toFixed(1)}% CPU · ${formatBytes(desktop.resources.memoryUsedBytes)} memory · ${desktop.resources.network.activeFlowCount} network flows`
                            : `Last active ${formatRelativeTimeLabel(desktop.lastActiveAt)}`}
                      </p>
                      {desktop.detail === undefined ? null : (
                        <p className="mt-1">{desktop.detail}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {recoverable ? (
                        <>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void manage(desktop, "restore")}
                          >
                            <RotateCcwIcon />
                            Restore
                          </Button>
                          <Button
                            size="xs"
                            variant="destructive-outline"
                            disabled={busy}
                            onClick={() => setPermanentDeleteDesktop(desktop)}
                          >
                            <Trash2Icon />
                            Delete permanently
                          </Button>
                        </>
                      ) : (
                        <>
                          {resumable ? (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void manage(desktop, "resume")}
                            >
                              <PlayIcon />
                              Resume
                            </Button>
                          ) : (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void manage(desktop, "park")}
                            >
                              <PauseIcon />
                              Park
                            </Button>
                          )}
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void manage(desktop, "stop")}
                          >
                            <CircleStopIcon />
                            Stop
                          </Button>
                          <Button
                            size="xs"
                            variant="destructive-outline"
                            disabled={busy}
                            onClick={() => void manage(desktop, "delete")}
                          >
                            <Trash2Icon />
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </CardPanel>
                </Card>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <Dialog open={viewer !== null} onOpenChange={(open) => !open && void closeViewer()}>
        {viewer ? (
          <DesktopViewer
            desktop={viewer.desktop}
            observation={viewer.observation}
            agentObservation={viewer.agentObservation}
            controlling={viewer.controlling}
            busy={busyDesktopId === viewer.desktop.id}
            error={viewerError}
            onTakeControl={() => setViewerControl(true)}
            onRelease={() => setViewerControl(false)}
            onAction={actInViewer}
          />
        ) : null}
      </Dialog>

      <AlertDialog
        open={setupEnvironmentId !== null}
        onOpenChange={(open) => !open && setSetupEnvironmentId(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Set up Agent desktops?</AlertDialogTitle>
            <AlertDialogDescription>
              T3 Code will repair Agent desktop prerequisites on{" "}
              {setupEnvironmentId === null
                ? "this device"
                : (environmentById.get(setupEnvironmentId)?.label ?? "this device")}
              .
              {setupPackages.length > 0
                ? ` PolicyKit will ask before installing these official Arch packages: ${setupPackages.join(", ")}.`
                : ""}
              {setupIncludesImage
                ? " It will also download a pinned 531 MB official Arch image, verify its SHA-256, and build a private graphical guest. Allow up to 75 minutes, 8 GiB of temporary free space, and roughly 3 GiB of retained storage."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => void setupEnvironment()}>Continue</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={permanentDeleteDesktop !== null}
        onOpenChange={(open) => !open && setPermanentDeleteDesktop(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this Agent desktop permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {permanentDeleteDesktop?.label ?? "this desktop"}'s virtual
              disk and saved state. This cannot be undone. Restore it instead if you may need its
              files or application state.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const desktop = permanentDeleteDesktop;
                setPermanentDeleteDesktop(null);
                if (desktop !== null) void manage(desktop, "delete-permanently");
              }}
            >
              Delete permanently
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}

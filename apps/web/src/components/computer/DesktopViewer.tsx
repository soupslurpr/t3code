import { useAtomValue } from "@effect/atom-react";
import { createDesktopViewer } from "@t3tools/client-runtime/computer/viewer";
import {
  ComputerAutomationSnapshot,
  ComputerAutomationStatus,
  type ComputerAutomationAccess,
  type ComputerAutomationAction,
  type ComputerAutomationActionBatchInput,
  type ComputerAutomationObservationOptions,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { readLocalApi } from "~/localApi";
import { Button } from "../ui/button";
import { desktopError, type DesktopClient } from "./desktopClient";
import { DesktopError, DesktopSelect } from "./DesktopControls";
import {
  applyViewerSnapshot,
  viewerKey,
  viewerPoint,
  type ViewerFrame,
} from "./desktopViewerFrame";

type ViewerRequest =
  | { operation: "request-view" | "release" | "return-control"; desktopId: string }
  | { operation: "request-control"; desktopId: string; takeoverLeaseId?: string }
  | { operation: "snapshot"; desktopId: string; input: ComputerAutomationObservationOptions }
  | { operation: "act"; desktopId: string; input: ComputerAutomationActionBatchInput };

const decodeStatus = Schema.decodeUnknownSync(ComputerAutomationStatus);
const decodeSnapshot = Schema.decodeUnknownSync(ComputerAutomationSnapshot);

interface Session {
  viewer: ReturnType<typeof createDesktopViewer>;
  stop(handback?: boolean): Promise<void>;
}
// A route change can unmount one viewer and open another while its final key-up is still in flight.
let activeSession: Session | null = null;
let releasing: Promise<void> = Promise.resolve();
let latestOpen: symbol | undefined;

interface ViewerProps {
  client: DesktopClient<ViewerRequest>;
  desktopId: string;
  status: ComputerAutomationStatus;
  canControl: boolean;
  onChange: () => void;
}

export function DesktopViewer({ client, desktopId, ...props }: ViewerProps) {
  return (
    <DesktopViewerSession
      key={JSON.stringify([client.environmentId, client.threadId, desktopId])}
      client={client}
      desktopId={desktopId}
      {...props}
    />
  );
}

function DesktopViewerSession({ client, desktopId, status, canControl, onChange }: ViewerProps) {
  const gt = useGT();
  const current = useRef<Session | null>(null);
  const intent = useRef<symbol | undefined>(undefined);
  const [access, setAccess] = useState<ComputerAutomationAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<ViewerFrame | null>(null);
  const [displayId, setDisplayId] = useState<string>("");
  const [acquired, setAcquired] = useState<{
    before: ComputerAutomationStatus;
    after: ComputerAutomationStatus;
  }>();
  const lease = acquired?.before === status ? acquired.after.lease : status.lease;
  const controlRequest = {
    operation: "request-control" as const,
    desktopId,
    ...(status.lease?.takeoverLeaseId ? { takeoverLeaseId: status.lease.takeoverLeaseId } : {}),
  };
  const allowView = useAtomValue(client.permission({ operation: "request-view", desktopId }));
  const allowControl = useAtomValue(client.permission(controlRequest));
  const allowHandback = useAtomValue(client.permission({ operation: "return-control", desktopId }));
  const permitted = useStableCallback(
    (mode: ComputerAutomationAccess) =>
      status.available && allowView && (mode === "view" || (canControl && allowControl)),
  );
  const lostAccess =
    access !== null &&
    (!allowView ||
      !status.available ||
      lease?.access === "none" ||
      (access === "control" && (!canControl || !allowControl || lease?.access === "view")));
  const drag = useRef<{
    frame: ViewerFrame;
    x: number;
    y: number;
    button: "left" | "middle" | "right";
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- browser focus, visibility and unmount terminate native input ownership
  useEffect(() => {
    const end = () => {
      intent.current = undefined;
      setBusy(false);
      void current.current?.stop().catch((cause) => setError(desktopError(cause)));
    };
    const blur = () => {
      drag.current = null;
      void current.current?.viewer.blur().catch(() => end());
    };
    const visibility = () => {
      if (document.hidden) end();
    };
    window.addEventListener("blur", blur);
    window.addEventListener("pagehide", end);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", end);
      document.removeEventListener("visibilitychange", visibility);
      end();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a refreshed host lease can revoke access while a capture is visible
  useEffect(() => {
    if (lostAccess) void current.current?.stop().catch((cause) => setError(desktopError(cause)));
  }, [lostAccess]);

  const open = async (next: ComputerAutomationAccess, button: HTMLButtonElement) => {
    const token = Symbol();
    intent.current = latestOpen = token;
    const pending = () =>
      intent.current === token &&
      latestOpen === token &&
      button.isConnected &&
      !document.hidden &&
      permitted(next);
    setError(null);
    setBusy(true);
    const acquire = async () => {
      if (
        next === "control" &&
        controlRequest.takeoverLeaseId &&
        !(await readLocalApi()?.dialogs.confirm(gt("Take control from the current controller?")))
      )
        return;
      if (!pending()) return;
      if (activeSession) await activeSession.stop();
      await releasing;
      if (!pending()) return;
      let handback = false;
      let closing: Promise<void> | undefined;
      const viewer = createDesktopViewer({
        request: async (level) => {
          const value = decodeStatus(
            await client.invoke(
              level === "control" ? controlRequest : { operation: "request-view", desktopId },
            ),
          );
          if (current.current === session) setAcquired({ before: status, after: value });
        },
        snapshot: async (knownHash) =>
          decodeSnapshot(
            await client.invoke({
              operation: "snapshot",
              desktopId,
              input: {
                ...(displayId ? { displayId } : {}),
                includeAccessibility: false,
                screenshot: {
                  maxWidth: 1280,
                  maxHeight: 720,
                  ...(knownHash ? { unchangedIfContentHash: knownHash } : {}),
                },
              },
            }),
          ),
        act: (actions) =>
          client.invoke({ operation: "act", desktopId, input: { actions, observation: false } }),
        release: () => {
          const release = () => client.invoke({ operation: "release", desktopId });
          return handback
            ? client.invoke({ operation: "return-control", desktopId }).finally(release)
            : release();
        },
        onFrame: (snapshot) => {
          if (current.current === session) setFrame((last) => applyViewerSnapshot(last, snapshot));
        },
        onError: (cause) => {
          if (current.current === session) {
            setError(desktopError(cause));
            void session.stop().catch((e) => setError(desktopError(e)));
          }
        },
      });
      const session: Session = {
        viewer,
        stop(returnControl = false) {
          if (closing) return closing;
          handback = returnControl;
          if (current.current === session) {
            current.current = null;
            drag.current = null;
            setAccess(null);
            setFrame(null);
            setAcquired(undefined);
          }
          if (activeSession === session) activeSession = null;
          closing = viewer.close();
          releasing = closing.catch(() => {});
          return closing;
        },
      };
      current.current = activeSession = session;
      await viewer.open(next).catch(async (cause) => {
        if (intent.current === token) setError(desktopError(cause));
        await session.stop();
      });
      if (current.current === session) {
        if (!pending()) {
          await session.stop();
          return;
        }
        setAccess(next);
        onChange();
      }
    };
    await acquire().catch((cause) => {
      if (intent.current === token) setError(desktopError(cause));
    });
    if (intent.current === token) setBusy(false);
  };
  const stop = async (returnControl = false) => {
    const token = Symbol();
    intent.current = token;
    setBusy(true);
    try {
      await (current.current?.stop(returnControl) ?? releasing);
      if (intent.current === token) onChange();
    } catch (cause) {
      if (intent.current === token) setError(desktopError(cause));
    }
    if (intent.current === token) setBusy(false);
  };
  const controlling = access === "control" && allowControl && !lostAccess;
  const actSafely = (perform: (session: Session) => Promise<unknown>) => {
    const session = current.current;
    if (!session || !controlling) return;
    void perform(session).catch((cause) => {
      if (current.current !== session) return;
      setError(desktopError(cause));
      void session.stop().catch((failure) => setError(desktopError(failure)));
    });
  };
  const send = (action: ComputerAutomationAction) => {
    actSafely((session) => session.viewer.act([action]));
  };
  const keyboard = (event: KeyboardEvent<HTMLImageElement>, down: boolean) => {
    const key = viewerKey(event.code);
    if (!controlling || !key || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    actSafely(({ viewer }) =>
      down ? viewer.keys.down(event.code, key) : viewer.keys.up(event.code),
    );
  };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {status.displays.length > 1 && (
          <DesktopSelect
            label={gt("Display")}
            value={displayId}
            disabled={busy || !!access}
            onChange={setDisplayId}
            options={[
              ["", gt("Primary display")],
              ...status.displays.map((d) => [d.id, d.label] as const),
            ]}
          />
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={busy || access === "view" || !allowView || !status.available}
          onClick={(e) => void open("view", e.currentTarget)}
        >
          {gt("View live")}
        </Button>
        {canControl && (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || controlling || !allowControl || !status.available}
            onClick={(e) => void open("control", e.currentTarget)}
          >
            {gt("Take control")}
          </Button>
        )}
        {controlling && lease?.canReturnControl && (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !allowHandback}
            onClick={() => void stop(true)}
          >
            {gt("Return control to agent")}
          </Button>
        )}
        {(access || busy) && (
          <Button size="xs" variant="outline" onClick={() => void stop()}>
            {gt("Close viewer")}
          </Button>
        )}
      </div>
      <DesktopError message={error} />
      {frame && allowView && !lostAccess && (
        <img
          className="h-auto max-w-full touch-none select-none rounded-md border focus-visible:ring-2 focus-visible:ring-inset"
          src={frame.src}
          alt={gt("Live desktop view")}
          tabIndex={controlling ? 0 : -1}
          draggable={false}
          onKeyDown={(e) => keyboard(e, true)}
          onKeyUp={(e) => keyboard(e, false)}
          onBlur={() => {
            drag.current = null;
            void current.current?.viewer.blur().catch((cause) => setError(desktopError(cause)));
          }}
          onContextMenu={(e) => {
            if (controlling) e.preventDefault();
          }}
          onPointerDown={(e) => {
            if (
              !controlling ||
              !e.currentTarget.complete ||
              e.currentTarget.currentSrc !== frame.src ||
              e.button > 2
            )
              return;
            const point = viewerPoint(
              e.currentTarget.getBoundingClientRect(),
              frame.frame,
              e.clientX,
              e.clientY,
            );
            if (!point) return;
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = {
              frame,
              ...point,
              button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
            };
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onPointerUp={(e) => {
            const start = drag.current;
            drag.current = null;
            if (
              !start ||
              start.frame.contentHash !== frame.contentHash ||
              start.frame.frame.displayId !== frame.frame.displayId
            )
              return;
            const end = viewerPoint(
              e.currentTarget.getBoundingClientRect(),
              frame.frame,
              e.clientX,
              e.clientY,
            );
            if (!end) return;
            const common = { frameId: frame.frame.id, button: start.button };
            send(
              Math.hypot(end.x - start.x, end.y - start.y) < 4
                ? { type: "click", ...common, ...end }
                : {
                    type: "drag",
                    ...common,
                    startX: start.x,
                    startY: start.y,
                    endX: end.x,
                    endY: end.y,
                  },
            );
          }}
          onWheel={(e) => {
            if (
              !controlling ||
              document.activeElement !== e.currentTarget ||
              (!e.deltaX && !e.deltaY)
            )
              return;
            const point = viewerPoint(
              e.currentTarget.getBoundingClientRect(),
              frame.frame,
              e.clientX,
              e.clientY,
            );
            if (point)
              send({
                type: "wheel",
                frameId: frame.frame.id,
                ...point,
                horizontalTicks: Math.sign(e.deltaX),
                verticalTicks: Math.sign(e.deltaY),
              });
          }}
        />
      )}
    </div>
  );
}

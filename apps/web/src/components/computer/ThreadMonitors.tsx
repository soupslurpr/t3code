import { useDesktopLabels } from "./desktopLabels";
import {
  type ScopedThreadRef,
  ThreadMonitorComputerInspection,
  type ThreadMonitorComputerUpdateInput,
  type ThreadMonitorSummary,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";
import { computerEnvironment } from "~/state/computer";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DesktopError, DesktopSection, GuardedAction } from "./DesktopControls";
import { useDesktopRead, useScopedCommand } from "./desktopClient";

export function ThreadMonitors({ target }: { target: ScopedThreadRef }) {
  const gt = useGT();
  const labelText = useDesktopLabels();
  const { environmentId, threadId } = target;
  const list = useEnvironmentQuery(
    computerEnvironment.threadMonitors({ environmentId, input: { threadId } }),
    useMessages(),
  );
  const cancel = useScopedCommand(environmentId, computerEnvironment.cancelMonitor);
  return (
    <DesktopSection title={gt("Thread monitors")}>
      <DesktopError message={list.error} />
      {list.data?.monitors.length === 0 && <p>{gt("No monitors for this thread.")}</p>}
      {list.data?.monitors.map((monitor) => (
        <div key={monitor.id} className="grid gap-2 border-t pt-2">
          <strong>{monitor.label}</strong>
          <p>
            {labelText(monitor.condition)} · {labelText(monitor.status)}
            {monitor.deadlineAt &&
              " · " +
                gt("Deadline {date}", { date: new Date(monitor.deadlineAt).toLocaleString() })}
          </p>
          {monitor.nextCheckAt && (
            <p>
              {gt("Next check {date}", { date: new Date(monitor.nextCheckAt).toLocaleString() })}
            </p>
          )}
          {monitor.criterion && <p className="whitespace-pre-wrap">{monitor.criterion}</p>}
          {monitor.blockedReason && <p>{monitor.blockedReason}</p>}
          {monitor.reviewRequired && (
            <p>
              {gt("Review required")} · {monitor.review?.reason}
            </p>
          )}
          {monitor.result && <p>{monitor.result}</p>}
          <DesktopError message={monitor.lastError} />
          {(monitor.status === "active" || monitor.status === "triggered") && (
            <div>
              <GuardedAction client={cancel} request={{ threadId, monitorId: monitor.id }}>
                {gt("Cancel monitor")}
              </GuardedAction>
            </div>
          )}
          {(monitor.condition === "model" || monitor.condition === "image-change") && (
            <WatchInspector target={target} monitor={monitor} />
          )}
        </div>
      ))}
    </DesktopSection>
  );
}

function WatchInspector({
  target,
  monitor,
}: {
  target: ScopedThreadRef;
  monitor: ThreadMonitorSummary;
}) {
  const gt = useGT();
  const labelText = useDesktopLabels();
  const inspect = useScopedCommand(target.environmentId, computerEnvironment.inspectWatch);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<ThreadMonitorComputerInspection | null>(null);
  const [revision, setRevision] = useState(0);
  const request = { threadId: target.threadId, inspect: { monitorId: monitor.id } };
  const allowed = useAtomValue(inspect.permission(request));
  const retained = useDesktopRead(
    { ...target, ...inspect },
    open ? request : null,
    ThreadMonitorComputerInspection,
  );
  const latest = fresh && fresh.revision >= (retained.data?.revision ?? 0) ? fresh : retained.data;
  const inspection =
    open &&
    allowed &&
    latest &&
    latest.revision >= revision &&
    latest.monitor.threadId === target.threadId &&
    latest.monitor.id === monitor.id
      ? latest
      : null;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!allowed}
          aria-expanded={open}
          onClick={() => {
            setFresh(null);
            if (open) retained.refresh();
            else setOpen(true);
          }}
        >
          {gt("Inspect retained evidence")}
        </Button>
        {open && (
          <>
            <GuardedAction
              key={revision}
              client={inspect}
              request={{ threadId: target.threadId, inspect: { monitorId: monitor.id, fresh: {} } }}
              onSuccess={(value) => {
                if (value.monitor.threadId === target.threadId && value.monitor.id === monitor.id)
                  setFresh(value);
              }}
            >
              {gt("Capture fresh evidence")}
            </GuardedAction>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setOpen(false);
                setFresh(null);
              }}
            >
              {gt("Close")}
            </Button>
          </>
        )}
      </div>
      <DesktopError message={retained.error} />
      {inspection && inspection.monitor.condition.type === "computer" && (
        <>
          <p>
            {gt("Revision {revision}", { revision: inspection.revision })} ·{" "}
            {inspection.monitor.condition.desktop.desktopId}
          </p>
          {inspection.monitor.condition.observation.regions.map((region) => (
            <p key={region.id}>
              {region.id} · {labelText(region.role)} · {region.region.width} ×{" "}
              {region.region.height}
              {region.purpose && " · " + region.purpose}
            </p>
          ))}
          {inspection.images.map((image) => (
            <figure key={image.id}>
              <img
                loading="lazy"
                className="max-h-72 max-w-full"
                src={"data:" + image.mimeType + ";base64," + image.dataBase64}
                alt={image.regionId + " · " + image.kind}
              />
              <figcaption>
                {image.regionId} · {labelText(image.kind)} ·{" "}
                {new Date(image.capturedAt).toLocaleString()}
              </figcaption>
            </figure>
          ))}
          {monitor.status === "active" && (
            <WatchRevision
              key={inspection.revision}
              target={target}
              inspection={inspection}
              onChanged={(nextRevision) => {
                setFresh(null);
                setRevision(nextRevision);
                retained.refresh();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function WatchRevision({
  target,
  inspection,
  onChanged,
}: {
  target: ScopedThreadRef;
  inspection: ThreadMonitorComputerInspection;
  onChanged: (revision: number) => void;
}) {
  const gt = useGT();
  const update = useScopedCommand(target.environmentId, computerEnvironment.updateWatch);
  const { condition, label } = inspection.monitor;
  const [nextLabel, setLabel] = useState(label);
  const [criterion, setCriterion] = useState(
    condition.type === "computer" && condition.match.type === "model"
      ? condition.match.criterion
      : "",
  );
  if (condition.type !== "computer") return null;
  const base = { monitorId: inspection.monitor.id, expectedRevision: inspection.revision };
  const revise = (fields: ThreadMonitorComputerUpdateInput, title: string, disabled = false) => (
    <GuardedAction
      client={update}
      request={{ threadId: target.threadId, update: fields }}
      disabled={disabled}
      onSuccess={(value) => {
        if (value.monitor.id !== base.monitorId || value.monitor.threadId !== target.threadId)
          return;
        onChanged(value.revision);
      }}
    >
      {title}
    </GuardedAction>
  );
  return (
    <div className="grid gap-2">
      <label>
        {gt("Name")}
        <Input value={nextLabel} maxLength={500} onChange={(e) => setLabel(e.target.value)} />
      </label>
      {condition.match.type === "model" && (
        <label>
          {gt("Watch criterion")}
          <Input
            value={criterion}
            maxLength={8000}
            onChange={(e) => setCriterion(e.target.value)}
          />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {revise(
          {
            ...base,
            label: nextLabel.trim(),
            ...(condition.match.type === "model"
              ? { match: { ...condition.match, criterion: criterion.trim() } }
              : {}),
          },
          gt("Save changes"),
          !nextLabel.trim() ||
            (condition.match.type === "model" && !criterion.trim()) ||
            (nextLabel.trim() === label &&
              (condition.match.type !== "model" || condition.match.criterion === criterion.trim())),
        )}
        {revise({ ...base, baselineObservation: {} }, gt("Capture new baseline"))}
        {condition.review.state !== "idle" &&
          revise({ ...base, acknowledgeReview: true }, gt("Acknowledge review"))}
      </div>
    </div>
  );
}

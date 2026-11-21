import { useDesktopLabels } from "./desktopLabels";
import { selectDesktopObservation } from "@t3tools/client-runtime/computer/viewer";
import { ComputerObservationList, ComputerObservationUpdate } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { DesktopError, DesktopSection, DesktopSelect } from "./DesktopControls";
import { type DesktopClient, useDesktopRead } from "./desktopClient";

type ObservationRequest =
  | { operation: "observation-list"; desktopId: string }
  | { operation: "observation"; desktopId: string; observationId: string };

export function DesktopObservations({
  client,
  desktopId,
}: {
  client: DesktopClient<ObservationRequest>;
  desktopId: string;
}) {
  const gt = useGT();
  const label = useDesktopLabels();
  const [expanded, setExpanded] = useState(false);
  const [selectedId, select] = useState<string | null>(null);
  const list = useDesktopRead(
    client,
    expanded ? { operation: "observation-list", desktopId } : null,
    ComputerObservationList,
    10_000,
  );
  const rows =
    list.data?.observations.filter(
      (row) =>
        row.desktopId === desktopId && (!client.threadId || row.threadId === client.threadId),
    ) ?? [];
  const selected = selectDesktopObservation(rows, selectedId);
  const result = useDesktopRead(
    client,
    expanded && selected
      ? { operation: "observation", desktopId, observationId: selected.id }
      : null,
    ComputerObservationUpdate,
  );
  const entry = result.data?.observation;
  const observation =
    entry &&
    entry.id === selected?.id &&
    entry.desktopId === desktopId &&
    (!client.threadId || entry.threadId === client.threadId)
      ? entry
      : null;
  return (
    <DesktopSection
      title={gt("Agent observations")}
      action={
        <Button
          size="xs"
          variant="outline"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? gt("Close") : gt("Inspect")}
        </Button>
      }
    >
      {expanded && (
        <>
          <DesktopError message={list.error ?? result.error} />
          {rows.length > 0 ? (
            <DesktopSelect
              label={gt("Agent observations")}
              value={selectedId ?? ""}
              onChange={(id) => select(id || null)}
              options={[
                ["", gt("Latest observation")],
                ...(selectedId && !selected ? [[selectedId, label("unavailable")] as const] : []),
                ...rows.map(
                  (r) =>
                    [
                      r.id,
                      new Date(r.observedAt).toLocaleString() +
                        " · " +
                        (r.label ?? label(r.source)),
                    ] as const,
                ),
              ]}
            />
          ) : (
            list.data && <p>{gt("No retained observations.")}</p>
          )}
          {observation && (
            <>
              <p>
                {observation.recipient.kind === "controller"
                  ? observation.recipient.instanceId
                  : observation.recipient.modelSelection.model}{" "}
                · {new Date(observation.observedAt).toLocaleString()}
              </p>
              {observation.images.map((image) => (
                <figure key={image.id}>
                  {image.screenshot.state === "image" && (
                    <img
                      className="max-h-96 max-w-full"
                      src={"data:" + image.screenshot.mimeType + ";base64," + image.screenshot.data}
                      alt={image.purpose ?? image.id}
                    />
                  )}
                  <figcaption>
                    {image.id} · {image.screenshot.width} × {image.screenshot.height}
                    {image.purpose && " · " + image.purpose}
                  </figcaption>
                </figure>
              ))}
              {observation.accessibility && (
                <details>
                  <summary>{gt("Accessibility")}</summary>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(observation.accessibility, null, 2)}
                  </pre>
                </details>
              )}
            </>
          )}
        </>
      )}
    </DesktopSection>
  );
}

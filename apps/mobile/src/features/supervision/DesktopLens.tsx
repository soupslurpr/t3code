import { useDesktopLabel } from "./desktopLabels";
import { selectDesktopObservation } from "@t3tools/client-runtime/computer/viewer";
import {
  ComputerObservationList,
  ComputerObservationUpdate,
  type ComputerObservationSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Image, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Errors, Panel } from "./SupervisionLayout";
import {
  type DesktopRouteTarget,
  useAgentRequest,
  useDesktopRead,
  useUserRequest,
} from "./desktopRequests";

const decodeList = Schema.decodeUnknownSync(ComputerObservationList);
const decodeObservation = Schema.decodeUnknownSync(ComputerObservationUpdate);

export function DesktopLens(target: DesktopRouteTarget) {
  const gt = useGT();
  const user = useUserRequest(target);
  const agent = useAgentRequest(target);
  const request = target.kind === "user" ? user : agent;
  const query = useDesktopRead(
    true,
    async () =>
      decodeList(await request({ operation: "observation-list", desktopId: target.desktopId })),
    5_000,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const rows =
    query.data?.observations.filter(
      (r) =>
        r.desktopId === target.desktopId && (!target.threadId || r.threadId === target.threadId),
    ) ?? [];
  const observation = selectDesktopObservation(rows, selected);
  return (
    <Panel title={gt("Agent lens")}>
      <Errors error={query.error} />
      {query.data && rows.length === 0 && <Text>{gt("No retained observations.")}</Text>}
      {rows.length > 0 && (
        <View className="gap-1">
          <Button
            size="compact"
            tone={selected === null ? "primary" : "secondary"}
            label={gt("Latest observation")}
            onPress={() => setSelected(null)}
          />
          {rows.map((row) => (
            <Button
              size="compact"
              key={row.id}
              tone={selected === row.id ? "primary" : "text"}
              label={[row.label ?? row.source, new Date(row.observedAt).toLocaleString()].join(
                " · ",
              )}
              onPress={() => setSelected(row.id)}
            />
          ))}
        </View>
      )}
      {selected && !observation && (
        <Text>{gt("This Agent lens observation has expired. Select the latest observation.")}</Text>
      )}
      {observation && <LensObservation key={observation.id} row={observation} target={target} />}
    </Panel>
  );
}

function LensObservation({
  target,
  row,
}: {
  target: DesktopRouteTarget;
  row: ComputerObservationSummary;
}) {
  const gt = useGT();
  const label = useDesktopLabel();
  const user = useUserRequest(target);
  const agent = useAgentRequest(target);
  const query = useDesktopRead(true, async () =>
    decodeObservation(
      await (target.kind === "user" ? user : agent)({
        operation: "observation",
        desktopId: target.desktopId,
        observationId: row.id,
      }),
    ),
  );
  const observation = query.data?.observation;
  if (
    !observation ||
    observation.id !== row.id ||
    observation.desktopId !== target.desktopId ||
    observation.threadId !== row.threadId
  )
    return (
      <>
        <Errors error={query.error} />
        {query.data && (
          <Text>
            {gt("This Agent lens observation has expired. Select the latest observation.")}
          </Text>
        )}
      </>
    );
  const recipient = observation.recipient;
  return (
    <View className="gap-2">
      <Text>
        {recipient.kind === "controller"
          ? gt("Controller · {instanceId}", { instanceId: recipient.instanceId })
          : gt("Watch evaluator · {model}", { model: recipient.modelSelection.model })}{" "}
        · {row.threadId}
      </Text>
      {observation.images.map((img) => (
        <View key={img.id} className="gap-1">
          <Text>
            {img.purpose ?? label(img.role)} · {new Date(img.capturedAt).toLocaleTimeString()}
          </Text>
          {img.screenshot.state === "image" ? (
            <Image
              source={{ uri: `data:${img.screenshot.mimeType};base64,${img.screenshot.data}` }}
              style={{ width: "100%", aspectRatio: img.screenshot.width / img.screenshot.height }}
              resizeMode="contain"
              accessibilityLabel={img.purpose ?? gt("Agent lens")}
            />
          ) : (
            <Text>{gt("Unchanged")}</Text>
          )}
        </View>
      ))}
      {observation.accessibility?.targets.map((node) => (
        <Text selectable key={node.id}>
          {node.application} · {node.role} · {node.name}
        </Text>
      ))}
    </View>
  );
}

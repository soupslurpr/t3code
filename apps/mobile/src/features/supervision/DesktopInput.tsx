import type { createDesktopViewer } from "@t3tools/client-runtime/computer/viewer";
import type {
  ComputerAutomationAction,
  ComputerAutomationFrame,
  ComputerAutomationSnapshot,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { mobileDesktopFramePoint, type MobileDesktopPoint } from "./desktopFrame";

export function DesktopInput({
  snapshot,
  control,
  viewer,
  onError,
}: {
  snapshot: ComputerAutomationSnapshot | null;
  control: boolean;
  viewer: ReturnType<typeof createDesktopViewer>;
  onError: (cause: unknown) => void;
}) {
  const gt = useGT();
  const [text, setText] = useState("");
  const [surface, setSurface] = useState({ width: 0, height: 0 });
  const touchStart = useRef<{
    frame: ComputerAutomationFrame;
    point: MobileDesktopPoint;
    touch: MobileDesktopPoint;
  } | null>(null);
  const report = useEffectEvent(onError);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release held desktop keys when the host revokes this viewer's control.
  useEffect(() => {
    if (!control) return;
    return () => {
      touchStart.current = null;
      void viewer.blur().catch(report);
    };
  }, [control, viewer]);
  const image = snapshot?.screenshot;
  const touch = (event: GestureResponderEvent) => ({
    x: event.nativeEvent.locationX,
    y: event.nativeEvent.locationY,
  });
  const act = (action: ComputerAutomationAction) => viewer.act([action]).catch(onError);
  return (
    <View className="gap-2">
      <View
        className="w-full overflow-hidden rounded-xl bg-black"
        style={{ aspectRatio: image ? image.width / image.height : 16 / 9 }}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setSurface({ width, height });
        }}
        onStartShouldSetResponder={() => control && image?.state === "image"}
        onResponderGrant={(event) => {
          const frame = snapshot?.frame;
          const location = touch(event);
          const point = frame && mobileDesktopFramePoint({ frame, surface, touch: location });
          touchStart.current = frame && point ? { frame, point, touch: location } : null;
        }}
        onResponderRelease={(event) => {
          const start = touchStart.current;
          touchStart.current = null;
          if (!start || !control) return;
          const endTouch = touch(event);
          const end = mobileDesktopFramePoint({ frame: start.frame, surface, touch: endTouch });
          if (!end) return;
          void act(
            Math.hypot(endTouch.x - start.touch.x, endTouch.y - start.touch.y) < 8
              ? { type: "click", frameId: start.frame.id, ...end }
              : {
                  type: "drag",
                  frameId: start.frame.id,
                  startX: start.point.x,
                  startY: start.point.y,
                  endX: end.x,
                  endY: end.y,
                },
          );
        }}
        onResponderTerminate={() => {
          touchStart.current = null;
          void viewer.blur().catch(onError);
        }}
      >
        {image?.state === "image" && (
          <Image
            pointerEvents="none"
            source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
            accessibilityLabel={gt("Live screen")}
          />
        )}
      </View>
      {control && (
        <>
          <View className="flex-row flex-wrap gap-2">
            {["Shift", "Control", "Alt", "Meta"].map((key) => (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityLabel={key}
                className="rounded-lg bg-subtle px-3 py-2"
                onPressIn={() => void viewer.keys.down(key, key).catch(onError)}
                onPressOut={() => void viewer.keys.up(key).catch(onError)}
              >
                <Text>{key}</Text>
              </Pressable>
            ))}
            {["Escape", "Tab", "Enter", "Backspace"].map((key) => (
              <Button
                key={key}
                size="compact"
                label={key}
                onPress={() => void act({ type: "press", key })}
              />
            ))}
          </View>
          <View className="flex-row flex-wrap gap-2">
            <Button
              size="compact"
              label={gt("Scroll up")}
              onPress={() => void act({ type: "wheel", verticalTicks: -3 })}
            />
            <Button
              size="compact"
              label={gt("Scroll down")}
              onPress={() => void act({ type: "wheel", verticalTicks: 3 })}
            />
          </View>
          <AppTextInput
            multiline
            accessibilityLabel={gt("Remote text input")}
            placeholder={gt("Remote text input")}
            value={text}
            onChangeText={setText}
            onBlur={() => void viewer.blur().catch(onError)}
          />
          <Button
            size="compact"
            label={gt("Send text")}
            disabled={!text}
            onPress={() => {
              const sent = text;
              void viewer
                .act([{ type: "type", text: sent }])
                .then(() => setText((current) => (current === sent ? "" : current)), onError);
            }}
          />
        </>
      )}
    </View>
  );
}

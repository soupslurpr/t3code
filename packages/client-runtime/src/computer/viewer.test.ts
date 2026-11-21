import { expect, it } from "vite-plus/test";
import { createDesktopViewer } from "./viewer.ts";
import type { ComputerAutomationSnapshot } from "@t3tools/contracts";

it("drains in-flight input and releases an acquired lease when the viewer closes", async () => {
  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  const sent: string[] = [];
  const snapshot: ComputerAutomationSnapshot = {
    display: {
      id: "display",
      label: "Primary",
      primary: true,
      bounds: { x: 0, y: 0, width: 32, height: 32 },
      scaleFactor: 1,
    },
    cursor: null,
    captureSource: "virtual-display",
  };
  const viewer = createDesktopViewer({
    async request() {
      sent.push("request");
    },
    async snapshot() {
      return snapshot;
    },
    async act(actions) {
      for (const action of actions) {
        sent.push(action.type);
        if (action.type === "key_down") {
          started.resolve();
          await complete.promise;
        }
      }
    },
    async release() {
      sent.push("release");
    },
    onFrame() {
      sent.push("frame");
    },
    onError(error) {
      throw error;
    },
  });
  await viewer.keys.down("KeyA", "a");
  await viewer.open("control");
  const press = viewer.keys.down("ControlLeft", "Control");
  await started.promise;
  const closed = viewer.close();
  await viewer.keys.down("KeyB", "b");
  complete.resolve();
  await Promise.all([press, closed, viewer.close()]);
  expect(sent).toEqual(["request", "frame", "key_down", "key_up", "release"]);
});

import { expect, it } from "vite-plus/test";
import { createViewerKeys } from "./viewerKeys.ts";

it("drains held keys after blur even while a key-down is in flight", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const sent: string[] = [];
  const keys = createViewerKeys(async (action) => {
    sent.push(action.type + " " + action.key);
    if (action.type === "key_down" && action.key === "Control") {
      started.resolve();
      await finish.promise;
    }
  });
  const press = keys.down("ControlLeft", "Control");
  await started.promise;
  const chord = keys.down("KeyT", "t");
  const release = keys.up("ControlLeft");
  const blur = keys.blur();
  const handoff = keys.close();
  finish.resolve();
  await Promise.all([press, chord, release, blur, handoff]);
  await keys.down("KeyX", "x");
  expect(sent).toEqual(["key_down Control", "key_up Control"]);
});

it("releases a shared logical modifier only after both physical keys are lifted", async () => {
  const sent: string[] = [];
  const keys = createViewerKeys(async (action) => {
    sent.push(action.type + " " + action.key);
  });
  await keys.down("ShiftLeft", "Shift");
  await keys.down("ShiftRight", "Shift");
  await keys.up("ShiftLeft");
  await keys.up("ShiftRight");
  await keys.close();
  expect(sent).toEqual(["key_down Shift", "key_up Shift"]);
});

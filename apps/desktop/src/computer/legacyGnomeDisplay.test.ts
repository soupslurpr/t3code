import { expect, it } from "vite-plus/test";
import { legacyDisplayId, migrateGnomeDisplay } from "./legacyGnomeDisplay.ts";

it("maps an Electron crop only to its uniquely shared logical display", () => {
  const bounds = { x: -1280, y: 0, width: 1280, height: 900 };
  const other = { ...bounds, x: 0 };
  const host = [
    { id: -62, bounds },
    { id: 8, bounds: other },
  ];
  const shared = [
    { id: "portal-1", bounds: other },
    { id: "connector", bounds },
  ];
  const region = { coordinateSpace: "desktop-logical" as const, displayId: "-62", ...bounds };
  const options = { screenshot: false as const, detailScreenshots: [{ id: "corner", region }] };
  expect(legacyDisplayId(options)).toBe("-62");
  expect(migrateGnomeDisplay(options, "-62", host, shared)?.detailScreenshots?.[0]?.region).toEqual(
    {
      ...region,
      displayId: "connector",
    },
  );
  expect(migrateGnomeDisplay(options, "-62", host, shared.slice(0, 1))).toBeNull();
  expect(migrateGnomeDisplay(options, "-62", host, [...shared, shared[1]!])).toBeNull();
  expect(migrateGnomeDisplay(options, "-62", [...host, { id: 9, bounds }], shared)).toBeNull();
  expect(
    migrateGnomeDisplay({ displayId: "-62" }, "-62", [host[0]!], [shared[0]!])?.displayId,
  ).toBe("portal-1");
  expect(migrateGnomeDisplay(options, "-62", [host[0]!], [shared[0]!])).toBeNull();
});

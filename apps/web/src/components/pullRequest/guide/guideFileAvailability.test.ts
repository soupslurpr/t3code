import { expect, it } from "vite-plus/test";
import { guideFileAvailability } from "./guideFileAvailability";

it("hides cached current-head code when a guide is stale, then restores it when enabled", () => {
  const files = new Map([["src/main.ts", "new-head code"]]);
  const request = { files, wantedPaths: ["src/main.ts", "src/more.ts"], done: false };
  const disabled = guideFileAvailability({ ...request, enabled: false });
  expect(disabled.files.size).toBe(0);
  expect(disabled.loading).toBe(false);
  expect(files.get("src/main.ts")).toBe("new-head code");
  const enabled = guideFileAvailability({ ...request, enabled: true });
  expect(enabled.files).toBe(files);
  expect(enabled.loading).toBe(true);
});

it("does not fetch disabled or exhausted guides and stops once all wanted files are cached", () => {
  const files = new Map([["src/main.ts", "code"]]);
  expect(
    guideFileAvailability({ files, wantedPaths: ["missing"], done: false, enabled: false }).loading,
  ).toBe(false);
  expect(
    guideFileAvailability({ files, wantedPaths: ["missing"], done: true, enabled: true }).loading,
  ).toBe(false);
  expect(
    guideFileAvailability({ files, wantedPaths: ["src/main.ts"], done: false, enabled: true })
      .loading,
  ).toBe(false);
});

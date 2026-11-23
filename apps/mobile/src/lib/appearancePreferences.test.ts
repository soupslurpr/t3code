import { describe, expect, it } from "vite-plus/test";

import {
  resolveAppearancePreferences,
  resolveComposerTextRole,
  resolveMathRenderingEnabled,
} from "./appearancePreferences";

describe("appearancePreferences", () => {
  it("enables math rendering by default unless explicitly turned off", () => {
    expect(resolveMathRenderingEnabled(undefined)).toBe(true);
    expect(resolveMathRenderingEnabled(null)).toBe(true);
    expect(resolveMathRenderingEnabled(true)).toBe(true);
    expect(resolveMathRenderingEnabled(false)).toBe(false);
  });

  it("migrates the legacy markdownFontSize key to baseFontSize", () => {
    expect(resolveAppearancePreferences({ markdownFontSize: 18 }).baseFontSize).toBe(18);
    expect(
      resolveAppearancePreferences({ baseFontSize: 16, markdownFontSize: 18 }).baseFontSize,
    ).toBe(16);
  });

  it("scales the iOS composer text with the system text size", () => {
    const body = { fontSize: 16, lineHeight: 23 };
    expect(resolveComposerTextRole(body, 1, "ios")).toEqual(body);
    expect(resolveComposerTextRole(body, 2.643, "ios")).toEqual({
      fontSize: 16 * 2.643,
      lineHeight: 23 * 2.643,
    });
    expect(resolveComposerTextRole(body, 2.643, "android")).toEqual(body);
  });
});

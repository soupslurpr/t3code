import { describe, expect, it } from "vite-plus/test";
import { resolveClientAssetUrl } from "./assetUrls";

describe("resolveClientAssetUrl", () => {
  it("keeps signed assets direct in a web client", () => {
    expect(
      resolveClientAssetUrl("http://192.0.2.56:3773/", "/api/assets/signed-token/preview.wav"),
    ).toBe("http://192.0.2.56:3773/api/assets/signed-token/preview.wav");
  });

  it("keeps document dependencies within the signed directory in Electron", () => {
    const page = resolveClientAssetUrl(
      "https://example.invalid",
      "/api/assets/fixture-token/docs/index.html",
      "t3code://app/thread/fixture",
    );
    expect(new URL("../css/theme.css", page!).toString()).toBe(
      "t3code://app/.t3/assets/proxy/https%3A%2F%2Fexample.invalid/api/assets/fixture-token/css/theme.css",
    );
  });

  it("routes signed assets through the secure Electron origin", () => {
    expect(
      resolveClientAssetUrl(
        "http://192.0.2.56:3773/",
        "/api/assets/signed-token/preview.wav",
        "t3code://app/thread/123",
      ),
    ).toBe(
      "t3code://app/.t3/assets/proxy/http%3A%2F%2F192.0.2.56%3A3773/api/assets/signed-token/preview.wav",
    );
  });
});

import { describe, expect, it } from "vite-plus/test";

import { resolveClientAssetUrl } from "./assetUrls";

describe("resolveClientAssetUrl", () => {
  it("keeps signed assets direct in a web client", () => {
    expect(
      resolveClientAssetUrl("http://192.168.1.56:3773/", "/api/assets/signed-token/preview.wav"),
    ).toBe("http://192.168.1.56:3773/api/assets/signed-token/preview.wav");
  });

  it("routes signed assets through the secure Electron origin", () => {
    expect(
      resolveClientAssetUrl(
        "http://192.168.1.56:3773/",
        "/api/assets/signed-token/preview.wav",
        "t3code://app/thread/123",
      ),
    ).toBe(
      "t3code://app/.t3/assets/proxy?url=http%3A%2F%2F192.168.1.56%3A3773%2Fapi%2Fassets%2Fsigned-token%2Fpreview.wav",
    );
  });
});

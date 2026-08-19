import { describe, expect, it } from "vite-plus/test";

import { resolveAssetUrl, resolveClientAssetUrl } from "./assetUrls";

describe("resolveAssetUrl", () => {
  it("resolves an environment-relative asset URL", () => {
    expect(
      resolveAssetUrl("https://environment.example/base/", "/api/assets/signed-token/favicon.png"),
    ).toBe("https://environment.example/api/assets/signed-token/favicon.png");
  });

  it("rejects an invalid environment base URL", () => {
    expect(resolveAssetUrl("not a URL", "/api/assets/signed-token/favicon.png")).toBeNull();
  });
});

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

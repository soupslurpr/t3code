import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  parsePairingUrlFields,
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    "http://127.0.0.1:3775/pair#token=complete-token",
    "http://127.0.0.1:3775/pair?token=complete-token",
    "https://app.t3.codes/pair?host=http%3A%2F%2F127.0.0.1%3A3775#token=complete-token",
  ])("extracts the full token from %s", (url) => {
    expect(parsePairingUrlFields(url, "http://localhost:3773")).toEqual({
      host: "http://127.0.0.1:3775",
      pairingCode: "complete-token",
    });
  });

  it("accepts a scheme-less host with a complete pairing token", () => {
    expect(
      parsePairingUrlFields(
        "  backend.example.com/pair#token=complete-token  ",
        "https://app.t3.codes",
      ),
    ).toEqual({ host: "https://backend.example.com", pairingCode: "complete-token" });
  });

  it.each(["", "backend.example.com", "https://backend.example.com/pair#token=", "https://["])(
    "leaves a host without pairing credentials unchanged: %s",
    (value) => {
      expect(parsePairingUrlFields(value, "https://app.t3.codes")).toBeNull();
    },
  );

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});

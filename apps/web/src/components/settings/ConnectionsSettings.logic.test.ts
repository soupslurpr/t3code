import type { DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  parsePairingUrlFields,
  parseRemotePairingFields,
  selectQrEndpointOption,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";

describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "relay:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["relay:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });
});

describe("pairing input", () => {
  const baseUrl = "https://app.t3.codes";
  it.each([
    "http://127.0.0.1:3775/pair#token=complete-token",
    "http://127.0.0.1:3775/pair?token=complete-token",
    "https://app.t3.codes/pair?host=http%3A%2F%2F127.0.0.1%3A3775#token=complete-token",
  ])("extracts the complete token on blur or direct submission: %s", (host) => {
    const expected = { host: "http://127.0.0.1:3775", pairingCode: "complete-token" };
    expect(parsePairingUrlFields(host, baseUrl)).toEqual(expected);
    expect(parseRemotePairingFields({ host, pairingCode: "" }, baseUrl)).toEqual(expected);
  });

  it("accepts a scheme-less URL without requiring blur before submission", () => {
    expect(
      parseRemotePairingFields(
        { host: " backend.example.com/pair#token=complete-token ", pairingCode: "" },
        baseUrl,
      ),
    ).toEqual({ host: "https://backend.example.com", pairingCode: "complete-token" });
  });

  it.each(["", "backend.example.com", "https://backend.example.com/pair#token=", "https://["])(
    "does not extract incomplete URL fields on blur: %s",
    (host) => {
      expect(parsePairingUrlFields(host, baseUrl)).toBeNull();
    },
  );

  it("preserves a separately entered code when the host contains no token", () => {
    expect(
      parseRemotePairingFields(
        { host: " backend.example.com ", pairingCode: " full-code " },
        baseUrl,
      ),
    ).toEqual({ host: "backend.example.com", pairingCode: "full-code" });
  });

  it("prefers the full token in the submitted URL over a previously extracted code", () => {
    expect(
      parseRemotePairingFields(
        { host: "backend.example.com/pair#token=first-rest", pairingCode: "first" },
        baseUrl,
      ),
    ).toEqual({ host: "https://backend.example.com", pairingCode: "first-rest" });
  });

  it("requires both fields when the host is not a pairing URL", () => {
    expect(() => parseRemotePairingFields({ host: "", pairingCode: "token" }, baseUrl)).toThrow(
      "Enter a backend host.",
    );
    expect(() =>
      parseRemotePairingFields({ host: "backend.example.com", pairingCode: "" }, baseUrl),
    ).toThrow("Enter a pairing code.");
  });
});

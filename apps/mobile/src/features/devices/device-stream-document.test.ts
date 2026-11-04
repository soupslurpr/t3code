import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  deviceStreamBaseUrl,
  deviceStreamDocument,
  deviceStreamMessage,
} from "./device-stream-document";

describe("native device stream origin", () => {
  const httpBase = "http://dev.example.test:3773/t3/";
  const httpsBase = "https://dev.example.test:8443/t3/";

  it.each([
    ["android", "ios", true, httpBase, "https://localhost/"],
    ["android", "ios", true, httpsBase, "https://localhost/"],
    ["android", "ios", false, httpBase, "http://dev.example.test:3773/"],
    ["android", "ios", false, httpsBase, "https://dev.example.test:8443/"],
    ["android", "android", true, httpBase, "https://localhost/"],
    ["android", "android", true, httpsBase, "https://localhost/"],
    ["android", "android", false, httpBase, "https://localhost/"],
    ["android", "android", false, httpsBase, "https://localhost/"],
    ["ios", "ios", true, httpBase, "file:///"],
    ["ios", "ios", true, httpsBase, "file:///"],
    ["ios", "ios", false, httpBase, "file:///"],
    ["ios", "ios", false, httpsBase, "file:///"],
    ["ios", "android", true, httpBase, "file:///"],
    ["ios", "android", true, httpsBase, "file:///"],
    ["ios", "android", false, httpBase, "file:///"],
    ["ios", "android", false, httpsBase, "file:///"],
    ["macos", "ios", true, httpBase, "file:///"],
    ["windows", "ios", true, httpBase, "file:///"],
    ["web", "ios", true, httpBase, "file:///"],
  ] as const)(
    "%s viewer, %s device, serveSimOnly=%s through %s",
    (viewerPlatform, devicePlatform, serveSimOnly, environment, expected) => {
      expect(deviceStreamBaseUrl(viewerPlatform, devicePlatform, environment, serveSimOnly)).toBe(
        expected,
      );
    },
  );

  it.each([
    [httpBase, "http://dev.example.test:3773/"],
    [httpsBase, "https://dev.example.test:8443/"],
  ])("keeps the local iOS origin when host mode is omitted: %s", (environment, expected) => {
    expect(deviceStreamBaseUrl("android", "ios", environment)).toBe(expected);
  });
});

describe("native device stream document", () => {
  it("keeps ticket and device values from terminating the embedded script", () => {
    const deviceId = '</script><script>alert("device")</script>';
    const configuration = JSON.stringify({ deviceId, ticket: "<ticket>" });
    const html = deviceStreamDocument(
      configuration,
      "var T3DeviceStream={start(input){return input}};",
    );
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(html.match(/<script>/g)).toHaveLength(1);
    const input: unknown = NodeVM.runInNewContext(script!, { window: { addEventListener() {} } });
    expect(input).toEqual({ deviceId, ticket: "<ticket>" });
  });

  it("reports a bootstrap exception to the native recovery UI", () => {
    const postMessage = vi.fn();
    const html = deviceStreamDocument(
      "{}",
      'var T3DeviceStream={start(){throw new Error("startup")}};',
    );
    NodeVM.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1]!, {
      window: { addEventListener() {}, ReactNativeWebView: { postMessage } },
    });
    expect(JSON.parse(postMessage.mock.calls[0]![0] as string)).toEqual({
      type: "status",
      status: "error",
      detail: "Device viewer stopped unexpectedly.",
    });
  });
});

describe("native device stream messages", () => {
  it.each([
    "invalid JSON",
    "null",
    '"input"',
    "{}",
    '{"type":"input","connected":"yes"}',
    '{"type":"unknown"}',
    '{"type":"status","status":"unknown"}',
    '{"type":"status","status":"error","detail":42}',
    '{"type":"status"}',
  ])("ignores invalid bridge messages: %s", (data) => expect(deviceStreamMessage(data)).toBeNull());
});

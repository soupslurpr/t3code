import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DesktopTelemetryControlMessage } from "./resourceTelemetry.ts";

const decodeControlMessage = Schema.decodeUnknownSync(DesktopTelemetryControlMessage);

describe("desktop telemetry control messages", () => {
  it("decodes aggregate agent activity updates", () => {
    expect(decodeControlMessage({ version: 1, type: "setAgentWorking", enabled: true })).toEqual({
      version: 1,
      type: "setAgentWorking",
      enabled: true,
    });
  });
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ComputerAutomationStatus } from "./computerAutomation.ts";
import {
  DesktopEnvironmentBootstrapSchema,
  makeDesktopComputerAutomationResultSchema,
} from "./ipc.ts";

describe("desktop computer automation IPC", () => {
  const decode = Schema.decodeUnknownSync(
    makeDesktopComputerAutomationResultSchema(ComputerAutomationStatus),
  );

  it("carries only a bounded public failure reason", () => {
    expect(
      decode({
        ok: false,
        error: {
          code: "display-locked",
          category: "authorization",
          message: "The desktop is locked.",
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "display-locked",
        category: "authorization",
        message: "The desktop is locked.",
      },
    });
    expect(() =>
      decode({
        ok: false,
        error: {
          code: "private-portal-error",
          category: "internal",
          message: "Private failure.",
        },
      }),
    ).toThrow();
    expect(() => decode({ ok: false, cause: "private diagnostic" })).toThrow();
  });
});

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

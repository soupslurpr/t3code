import { describe, expect, it } from "vite-plus/test";

import { resolveAgentDesktopTransferUrl } from "./agentDesktopTransferUrl";

const token = "a".repeat(43);

describe("resolveAgentDesktopTransferUrl", () => {
  it("resolves an opaque capability against its environment", () => {
    expect(
      resolveAgentDesktopTransferUrl(
        `/api/agent-desktop-transfers/${token}`,
        "https://environment.example/base/",
      ),
    ).toBe(`https://environment.example/api/agent-desktop-transfers/${token}`);
  });

  it.each([
    `https://attacker.example/api/agent-desktop-transfers/${token}`,
    `/api/agent-desktop-transfers/${token}?redirect=1`,
    "/api/agent-desktop-transfers/short",
    `/other/${token}`,
  ])("rejects a non-capability URL: %s", (path) => {
    expect(() => resolveAgentDesktopTransferUrl(path, "https://environment.example/")).toThrow();
  });
});

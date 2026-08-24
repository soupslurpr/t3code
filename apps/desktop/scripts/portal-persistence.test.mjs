import { describe, expect, it } from "vite-plus/test";

import { portalPersistMode } from "../resources/computer-use/portal-persistence.js";

describe("portal persistence", () => {
  it("keeps ordinary approval transient", () => {
    expect(portalPersistMode(null, false)).toBe(0);
  });

  it("requests persistence only for restore or explicit remember actions", () => {
    expect(portalPersistMode(null, true)).toBe(2);
    expect(portalPersistMode("restore-token", false)).toBe(2);
    expect(portalPersistMode("restore-token", true)).toBe(2);
  });
});

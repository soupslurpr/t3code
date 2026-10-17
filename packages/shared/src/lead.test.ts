import { describe, expect, it } from "vite-plus/test";
import { LEAD_INSTRUCTION, stripLeadInstruction } from "./lead.ts";

describe("stripLeadInstruction", () => {
  it("leaves the task for both first-send and retry title seeds", () => {
    expect(stripLeadInstruction(`Fix the login test\n\n${LEAD_INSTRUCTION}`)).toBe(
      "Fix the login test",
    );
    expect(
      stripLeadInstruction(`${LEAD_INSTRUCTION}\n\nFix the login test\n\n${LEAD_INSTRUCTION}`),
    ).toBe("Fix the login test");
  });

  it("preserves ordinary task text and strips only the exact sentence", () => {
    expect(stripLeadInstruction("Act as lead here and fix login.")).toBe(
      "Act as lead here and fix login.",
    );
    expect(stripLeadInstruction(LEAD_INSTRUCTION)).toBe("");
    expect(stripLeadInstruction("Fix login")).toBe("Fix login");
  });
});

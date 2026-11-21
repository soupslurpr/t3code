import { describe, expect, it } from "vite-plus/test";

import { canManageProjectWorktrees, isScratchProject } from "./projects.ts";

describe("isScratchProject", () => {
  it.each([null, undefined])(
    "recognises a loaded scratch project when its environment offers no available root (%s)",
    (scratchWorkspaceRoot) => {
      const project = { workspaceRoot: "/remote/scratch", isScratch: true as const };

      expect(isScratchProject(project, scratchWorkspaceRoot)).toBe(true);
    },
  );
});

it("offers worktree actions only when the selected environment identifies a regular project", () => {
  const project = { workspaceRoot: "/one/scratch" };
  expect(canManageProjectWorktrees(project, { scratchWorkspaceRoot: "/one/scratch/" })).toBe(false);
  expect(canManageProjectWorktrees({ ...project, isScratch: true }, {})).toBe(false);
  expect(canManageProjectWorktrees(project, null)).toBe(false);
  expect(canManageProjectWorktrees(null, {})).toBe(false);
  expect(canManageProjectWorktrees(project, { scratchWorkspaceRoot: "/two/scratch" })).toBe(true);
  expect(canManageProjectWorktrees(project, {})).toBe(true);
});

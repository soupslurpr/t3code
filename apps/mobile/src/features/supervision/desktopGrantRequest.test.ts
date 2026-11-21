import { EnvironmentId, ThreadId, type DesktopCapabilityGrant } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { grantRequest } from "./desktopGrantRequest";

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("owner-thread");
const target = { environmentId, kind: "user", desktopId: "desktop-a", label: "Desktop" } as const;
const desktop = { kind: "user", desktopId: target.desktopId } as const;
const policy = {
  scope: "thread",
  lifetime: "automatic",
  deadline: null,
  remembered: false,
} as const;
const grant: DesktopCapabilityGrant = {
  ...policy,
  environmentId,
  threadId,
  grantId: "permission",
  revision: 3,
  capability: "execution",
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  absoluteExpiresAt: null,
  idleExpiresAt: null,
  settledExpiresAt: null,
  sourceRevision: null,
  activityRevision: null,
  sourceState: "active",
  suspended: false,
  migrated: false,
};

it("edits and removes the revision and thread that own the selected grant from Settings", () => {
  expect(
    grantRequest(target, true, { action: "save", capability: "execution", policy, grant }),
  ).toEqual({
    threadId,
    request: {
      operation: "execution",
      input: {
        operation: "access",
        desktop,
        input: {
          desktop,
          action: "edit",
          grantId: "permission",
          revision: 3,
          scope: "thread",
          lifetime: "automatic",
          remembered: false,
          localPrompt: false,
        },
      },
    },
  });
  expect(grantRequest(target, true, { action: "remove", grant, stopWork: true })).toMatchObject({
    threadId,
    request: {
      input: {
        desktop,
        input: { action: "revoke", grantId: "permission", revision: 3, stopProcesses: true },
      },
    },
  });
  expect(
    grantRequest(target, false, {
      action: "save",
      capability: "view",
      policy: { ...policy, scope: "desktop" },
    }),
  ).toMatchObject({
    request: {
      operation: "screen-permission",
      desktopId: target.desktopId,
      action: "request",
      capability: "view",
      localPrompt: true,
    },
  });
});

it("approves the pending screen request with its proposed policy and exact source thread", () => {
  const pending = {
    requestId: "pending",
    environmentId,
    threadId,
    capability: "control" as const,
    expiresAt: "2026-01-03T00:00:00.000Z",
    proposedPolicy: policy,
  };
  expect(grantRequest(target, false, { action: "approve", pending })).toEqual({
    threadId,
    request: {
      operation: "screen-permission",
      desktopId: target.desktopId,
      requestId: "pending",
      action: "approve",
      policy,
    },
  });
  expect(grantRequest(target, false, { action: "deny", pending })).toEqual({
    threadId,
    request: {
      operation: "screen-permission",
      desktopId: target.desktopId,
      requestId: "pending",
      action: "deny",
    },
  });
});

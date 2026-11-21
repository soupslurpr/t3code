import type {
  DesktopCapabilityGrant,
  DesktopExecutionPendingApproval,
  DesktopGrantCapability,
  DesktopGrantPolicy,
  DesktopScreenPendingApproval,
  ThreadId,
  UserDesktopHumanRequest,
} from "@t3tools/contracts";
import type { DesktopRouteTarget } from "./desktopRequests";
type Pending = DesktopScreenPendingApproval | DesktopExecutionPendingApproval;
export type GrantChange =
  | {
      action: "save";
      capability: DesktopGrantCapability;
      policy: DesktopGrantPolicy;
      grant?: DesktopCapabilityGrant;
    }
  | { action: "approve" | "deny"; pending: Pending }
  | { action: "remove"; grant: DesktopCapabilityGrant; stopWork: boolean };

export function grantRequest(
  target: DesktopRouteTarget,
  execution: boolean,
  change: GrantChange,
): { request: UserDesktopHumanRequest; threadId?: ThreadId | undefined } {
  const { desktopId } = target;
  const desktop = { kind: "user", desktopId } as const;
  if ("pending" in change) {
    const { pending } = change;
    const decision = { action: change.action, requestId: pending.requestId };
    return {
      threadId: pending.threadId,
      request: execution
        ? {
            operation: "execution",
            input: { operation: "access", desktop, input: { desktop, ...decision } },
          }
        : {
            operation: "screen-permission",
            desktopId,
            ...decision,
            ...(change.action === "approve" ? { policy: pending.proposedPolicy } : {}),
          },
    };
  }
  if (change.action === "remove") {
    const g = change.grant;
    const permission = { grantId: g.grantId, revision: g.revision };
    const localPrompt = g.scope === "desktop";
    return {
      threadId: g.threadId ?? target.threadId,
      request: execution
        ? {
            operation: "execution",
            input: {
              operation: "access",
              desktop,
              input: {
                desktop,
                action: "revoke",
                ...permission,
                stopProcesses: change.stopWork,
                localPrompt,
              },
            },
          }
        : { operation: "screen-permission", desktopId, action: "remove", permission, localPrompt },
    };
  }
  const { grant, policy, capability } = change;
  const action = grant ? "edit" : "request";
  const permission = grant ? { grantId: grant.grantId, revision: grant.revision } : undefined;
  const localPrompt = policy.scope === "desktop";
  return {
    threadId: grant?.threadId ?? target.threadId,
    request:
      capability === "execution"
        ? {
            operation: "execution",
            input: {
              operation: "access",
              desktop,
              input: {
                desktop,
                action,
                ...permission,
                scope: policy.scope,
                lifetime: policy.lifetime,
                remembered: policy.remembered,
                ...(policy.deadline ? { deadline: policy.deadline } : {}),
                localPrompt,
              },
            },
          }
        : {
            operation: "screen-permission",
            desktopId,
            action,
            capability,
            policy,
            ...(permission ? { permission } : {}),
            localPrompt,
          },
  };
}

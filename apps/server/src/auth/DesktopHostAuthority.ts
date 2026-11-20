import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  isUserDesktopId,
  type UserDesktopId,
} from "@t3tools/contracts";
import type { AuthenticatedSession } from "./EnvironmentAuth.ts";

const nativePrefix = "desktop-bootstrap:";
const attachedPrefix = "desktop-host:";

export const nativeDesktopSubject = (id: UserDesktopId) => nativePrefix + id;
export const attachedDesktopSubject = (id: UserDesktopId) => attachedPrefix + id;

export function attachedDesktopId(subject: string): UserDesktopId | null {
  const id = subject.startsWith(attachedPrefix) ? subject.slice(attachedPrefix.length) : null;
  return isUserDesktopId(id) ? id : null;
}

export function authorizedDesktopId(
  session: Pick<AuthenticatedSession, "subject" | "method" | "scopes">,
  nativeId: UserDesktopId | undefined,
): UserDesktopId | null {
  if (
    (session.method !== "bearer-access-token" && session.method !== "dpop-access-token") ||
    !session.scopes.includes(AuthPreviewOperateScope) ||
    !session.scopes.includes(AuthOrchestrationOperateScope)
  )
    return null;
  if (nativeId !== undefined && session.subject === nativeDesktopSubject(nativeId)) return nativeId;
  const id = attachedDesktopId(session.subject);
  return id === nativeId ? null : id;
}

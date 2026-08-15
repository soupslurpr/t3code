const AGENT_DESKTOP_TRANSFER_PATH = /^\/api\/agent-desktop-transfers\/[A-Za-z0-9_-]{43}$/;

/** Resolves only server-issued relative Agent desktop transfer capabilities. */
export function resolveAgentDesktopTransferUrl(
  path: string,
  environmentHttpBaseUrl: string,
): string {
  if (!AGENT_DESKTOP_TRANSFER_PATH.test(path)) {
    throw new Error("the Agent desktop transfer capability is invalid");
  }
  return new URL(path, environmentHttpBaseUrl).toString();
}

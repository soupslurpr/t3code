import type { DesktopComputerAutomationContext } from "@t3tools/contracts";
import { msg } from "gt-i18n";
import { m } from "../i18n/messages.ts";

export function permissionSourceDescription(context: DesktopComputerAutomationContext): string {
  const source = context.lifecycle?.source;
  const name = (label: string | undefined | null) => label?.replace(/[\r\n\t]/g, " ").trim();
  const thread =
    [name(source?.threadTitle), context.threadId].filter(Boolean).join(" · ") ||
    m(msg("Desktop settings"));
  const environment =
    [name(source?.environmentLabel), context.environmentId].filter(Boolean).join(" · ") ||
    m(msg("This desktop"));
  return [
    m(msg("Thread: {thread}"), { thread }),
    ...(source?.projectName
      ? [m(msg("Project: {project}"), { project: name(source.projectName) ?? "" })]
      : []),
    m(msg("Environment: {environment}"), { environment }),
  ].join("\n");
}

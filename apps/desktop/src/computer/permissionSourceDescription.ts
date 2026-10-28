import type { DesktopComputerAutomationContext } from "@t3tools/contracts";

export function permissionSourceDescription(context: DesktopComputerAutomationContext): string {
  const source = context.lifecycle?.source;
  const name = (value: string | undefined | null, fallback: string) =>
    value?.replace(/[\r\n\t]/g, " ").trim() || fallback;
  return [
    `Thread: ${name(source?.threadTitle, context.threadId ?? "Desktop settings")}`,
    ...(source?.projectName ? [`Project: ${name(source.projectName, "No project")}`] : []),
    `Environment: ${name(source?.environmentLabel, context.environmentId ?? "This desktop")}`,
    `Thread ID: ${context.threadId ?? "Desktop settings"}`,
    `Environment ID: ${context.environmentId ?? "This desktop"}`,
  ].join("\n");
}

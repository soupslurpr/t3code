import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  EyeIcon,
  PencilIcon,
  PlayIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import type {
  EnvironmentId,
  ScheduledTask,
  ThreadId,
  ThreadMonitorSummary,
} from "@t3tools/contracts";
import { scheduledTaskDispatchStatus } from "@t3tools/client-runtime/automations";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { cn } from "../../lib/utils";
import { relativeLabel, scheduleLabel } from "../settings/ScheduledTasksSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
};

/**
 * Live schedules and outstanding waits owned by this thread.
 */
export function ThreadAutomationsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const monitorsQuery = useEnvironmentQuery(
    serverEnvironment.threadMonitorsLive({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const cancelMonitor = useAtomCommand(serverEnvironment.cancelThreadMonitor, {
    label: "thread monitor cancel",
  });
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
  });
  const navigate = useNavigate();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [busyMonitorId, setBusyMonitorId] = useState<string | null>(null);

  const boundTasks = (tasksQuery.data?.tasks ?? []).filter(
    (task) => task.threadId === props.threadId,
  );
  const monitors = monitorsQuery.data?.monitors ?? [];
  // A load error must not look like "no automations" — this thread may have
  // tasks whose controls would silently vanish. Only hide the section when we
  // positively know there is nothing bound to it.
  if (
    tasksQuery.isSuccess &&
    monitorsQuery.isSuccess &&
    boundTasks.length === 0 &&
    monitors.length === 0
  )
    return null;

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const toggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (busyTaskId !== null) return;
    setBusyTaskId(task.id);
    // Partial update: only the enabled flag changes, so a toggle can never
    // revert concurrent edits made to the task elsewhere.
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update automation", squashAtomCommandFailure(result));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (busyTaskId !== null) return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({
      environmentId: props.environmentId,
      input: { id: task.id },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not run automation", squashAtomCommandFailure(result));
    }
  };

  const cancelWait = async (monitor: ThreadMonitorSummary) => {
    if (busyMonitorId !== null) return;
    setBusyMonitorId(monitor.id);
    const result = await cancelMonitor({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, monitorId: monitor.id },
    });
    setBusyMonitorId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not cancel monitor", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-automations-heading"
      title="Automations"
      data-thread-automations-panel
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="Manage scheduled tasks"
                onClick={() =>
                  void navigate({
                    to: "/settings/scheduled-tasks",
                    search: { environmentId: props.environmentId },
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>Manage scheduled tasks</TooltipPopup>
        </Tooltip>
      }
    >
      {tasksQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          Could not load automations: {tasksQuery.error}
        </p>
      ) : null}
      {monitorsQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          Could not load monitors: {monitorsQuery.error}
        </p>
      ) : null}
      {(!tasksQuery.data && !tasksQuery.error) || (!monitorsQuery.data && !monitorsQuery.error) ? (
        <p className="px-2.5 py-1.5 text-2xs text-muted-foreground">Loading automations…</p>
      ) : null}

      <ul className="m-0 list-none p-0">
        {boundTasks.map((task) => (
          <li
            key={task.id}
            className={cn(
              "group flex items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
              <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span
                className={cn(
                  "absolute -right-1 -top-1 size-1.5 rounded-full",
                  STATUS_DOT_CLASS[task.lastRunStatus],
                )}
                aria-hidden
              />
            </span>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground/80">
                {task.title}
              </span>
              <p className="truncate text-2xs text-muted-foreground">
                {scheduleLabel(task.schedule)}
                {task.enabled && task.nextRunAt !== null
                  ? ` · next ${relativeLabel(task.nextRunAt)}`
                  : task.enabled
                    ? ""
                    : " · paused"}
              </p>
              {task.lastRunStatus !== "never" ? (
                <Tooltip>
                  <TooltipTrigger render={<p className="text-2xs text-muted-foreground" />}>
                    {scheduledTaskDispatchStatus[task.lastRunStatus].label}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {scheduledTaskDispatchStatus[task.lastRunStatus].description}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`Edit ${task.title}`}
                    onClick={() =>
                      void navigate({
                        to: "/settings/scheduled-tasks",
                        search: { environmentId: props.environmentId, taskId: task.id },
                      })
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>Edit automation</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`Run ${task.title} now`}
                    disabled={busyTaskId !== null || task.lastRunStatus === "running"}
                    onClick={() => void runNow(task)}
                  >
                    <PlayIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>Run now</TooltipPopup>
            </Tooltip>
            <Switch
              checked={task.enabled}
              disabled={busyTaskId !== null}
              aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
              onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
            />
          </li>
        ))}
        {monitors.map((monitor) => (
          <li key={monitor.id} className="flex items-start gap-2 py-1.5">
            <span className="flex size-4 shrink-0 items-center justify-center">
              <EyeIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            </span>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground/80">
                {monitor.label}
              </span>
              {monitor.criterion ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<p className="line-clamp-2 text-2xs text-muted-foreground" />}
                  >
                    {monitor.criterion}
                  </TooltipTrigger>
                  <TooltipPopup>{monitor.criterion}</TooltipPopup>
                </Tooltip>
              ) : (
                <p className="text-2xs text-muted-foreground">
                  {monitor.condition === "time"
                    ? "One-time timer"
                    : monitor.condition === "signal"
                      ? "External signal"
                      : "Screen image changes"}
                </p>
              )}
              <p className="text-2xs text-muted-foreground">
                {monitor.status === "triggered"
                  ? monitor.continuation.mode === "resume-thread"
                    ? "Waiting to resume"
                    : "Recording result"
                  : monitor.reviewRequired
                    ? "Agent review needed"
                    : monitor.lastError
                      ? "Retrying"
                      : "Waiting"}
                {monitor.continuation.mode === "record-only" ? " · record only" : ""}
              </p>
              {monitor.nextCheckAt !== null ? (
                <p className="text-2xs text-muted-foreground">
                  {monitor.condition === "time" ? "Due" : "Next check"}{" "}
                  <time dateTime={monitor.nextCheckAt}>
                    {new Date(monitor.nextCheckAt).toLocaleString()}
                  </time>
                </p>
              ) : null}
              {monitor.deadlineAt !== null ? (
                <p className="text-2xs text-muted-foreground">
                  Deadline{" "}
                  <time dateTime={monitor.deadlineAt}>
                    {new Date(monitor.deadlineAt).toLocaleString()}
                  </time>
                </p>
              ) : null}
              {monitor.lastError ? (
                <Tooltip>
                  <TooltipTrigger render={<p className="line-clamp-2 text-2xs text-destructive" />}>
                    {monitor.lastError}
                  </TooltipTrigger>
                  <TooltipPopup>{monitor.lastError}</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`Cancel ${monitor.label}`}
                    disabled={busyMonitorId !== null || monitorsQuery.error !== null}
                    onClick={() => void cancelWait(monitor)}
                  >
                    <XIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>Cancel monitor</TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}

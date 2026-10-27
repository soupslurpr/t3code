import type {
  DesktopAuthorizationReferences,
  DesktopAuthorizationSyncInput,
  EnvironmentId,
  PreviewAutomationHostFocus,
  PreviewAutomationStreamEvent,
} from "@t3tools/contracts";

/** Bridges the native grant journal to the current environment connection. */
export function createDesktopAuthorizationSync(options: {
  environmentId: EnvironmentId;
  clientId: string;
  authorize: (
    input: DesktopAuthorizationSyncInput,
  ) => Promise<DesktopAuthorizationReferences | undefined>;
  report: (input: PreviewAutomationHostFocus) => Promise<void>;
  focused: () => boolean;
}) {
  let generation: string | null = null;
  let signature: string | null = null;
  let reports: Promise<boolean | undefined> = Promise.resolve(undefined);
  let retry: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  let changed = false;
  const refresh = (source: string, operation: "connected" | "references" = "references") => {
    const report = reports
      .catch(() => undefined)
      .then(async () => {
        if (generation !== source) return;
        const references = await options.authorize({
          operation,
          environmentId: options.environmentId,
          connectionGeneration: source,
        });
        if (generation !== source || references === undefined) return;
        const next = JSON.stringify([
          source,
          [...references.threadIds].sort(),
          references.activities?.map((entry) => entry.activityId),
        ]);
        if (signature === next) return;
        await options.report({
          clientId: options.clientId,
          environmentId: options.environmentId,
          connectionId: source,
          focused: options.focused(),
          authorizationThreads: references.threadIds,
          processActivities: references.activities ?? [],
        });
        if (generation !== source) return;
        if (references.activities?.length) {
          await options.authorize({
            operation: "acknowledge",
            environmentId: options.environmentId,
            connectionGeneration: source,
            activityIds: references.activities.map((entry) => entry.activityId),
          });
          signature = null;
        } else signature = next;
        return (references.activities?.length ?? 0) === 256;
      });
    reports = report;
    return report;
  };
  const flush = async () => {
    changed = true;
    if (generation === null || flushing) return;
    flushing = true;
    try {
      while (changed) {
        if (generation === null) break;
        changed = false;
        const more = await refresh(generation);
        changed ||= more === true;
      }
    } catch {
      signature = null;
      if (generation !== null) retry = setTimeout(() => void flush(), 1_000);
    } finally {
      flushing = false;
    }
  };
  const connect = (next: string | null) => {
    if (generation === next) return;
    const previous = generation;
    generation = next;
    signature = null;
    clearTimeout(retry);
    if (previous !== null)
      void options
        .authorize({
          operation: "disconnected",
          environmentId: options.environmentId,
          connectionGeneration: previous,
        })
        .catch(() => undefined);
    if (next !== null)
      void refresh(next, "connected").then(
        () => flush(),
        () => flush(),
      );
  };
  const lifecycle = async (event: Extract<PreviewAutomationStreamEvent, { type: "lifecycle" }>) => {
    if (generation !== event.connectionId) return;
    if (event.unavailable === true || (event.unavailableThreadIds?.length ?? 0) > 0)
      await options.authorize({
        operation: "unavailable",
        environmentId: options.environmentId,
        connectionGeneration: event.connectionId,
        ...(event.unavailable === true ? {} : { threadIds: event.unavailableThreadIds }),
      });
    if (generation !== event.connectionId) return;
    await options.authorize({
      operation: "reconcile",
      environmentId: options.environmentId,
      connectionGeneration: event.connectionId,
      snapshots: event.snapshots,
    });
    await refresh(event.connectionId);
  };
  return { connect, flush, refresh, lifecycle, dispose: () => connect(null) };
}

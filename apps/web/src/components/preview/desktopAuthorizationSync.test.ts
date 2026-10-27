import {
  EnvironmentId,
  ThreadId,
  type DesktopAuthorizationReferences,
  type DesktopAuthorizationSyncInput,
  type DesktopProcessActivity,
  type PreviewAutomationHostFocus,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { createDesktopAuthorizationSync } from "./desktopAuthorizationSync";

const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const activity: DesktopProcessActivity = {
  activityId: "completion",
  desktop: { kind: "user", desktopId: "physical" },
  environmentId,
  threadId,
  processId: "process",
  commandId: "command",
  runtimeGeneration: "runtime",
  phase: "completed",
  status: "exited",
  exitCode: 0,
  signal: null,
};

it("acknowledges completion only after the source has persisted its report", async () => {
  const entered = deferred<void>();
  const persisted = deferred<void>();
  const acknowledged = deferred<void>();
  const operations: string[] = [];
  let pending = true;
  const sync = createDesktopAuthorizationSync({
    environmentId,
    clientId: "native",
    focused: () => true,
    authorize: async (input) => {
      operations.push(input.operation);
      if (input.operation === "acknowledge") {
        expect(input.activityIds).toEqual([activity.activityId]);
        pending = false;
        acknowledged.resolve();
      }
      return { threadIds: [threadId], activities: pending ? [activity] : [] };
    },
    report: async (report) => {
      expect(report.processActivities).toEqual([activity]);
      entered.resolve();
      await persisted.promise;
    },
  });
  try {
    sync.connect("first");
    await entered.promise;
    expect(operations).not.toContain("acknowledge");
    persisted.resolve();
    await acknowledged.promise;
  } finally {
    sync.dispose();
  }
});

it("does not acknowledge an old connection after replacement", async () => {
  const entered = deferred<void>();
  const persisted = deferred<void>();
  const acknowledged = deferred<void>();
  const generations: string[] = [];
  const sync = createDesktopAuthorizationSync({
    environmentId,
    clientId: "native",
    focused: () => true,
    authorize: async (input) => {
      if (input.operation === "acknowledge") {
        generations.push(input.connectionGeneration);
        acknowledged.resolve();
      }
      return { threadIds: [threadId], activities: [activity] };
    },
    report: async (report) => {
      if (report.connectionId === "old") {
        entered.resolve();
        await persisted.promise;
      }
    },
  });
  try {
    sync.connect("old");
    await entered.promise;
    sync.connect("new");
    persisted.resolve();
    await acknowledged.promise;
    expect(generations).toEqual(["new"]);
  } finally {
    sync.dispose();
  }
});

it("flushes a grant change that arrives while the preceding report is in flight", async () => {
  const entered = deferred<void>();
  const persisted = deferred<void>();
  const revoked = deferred<void>();
  let references: DesktopAuthorizationReferences = { threadIds: [] };
  const reports: PreviewAutomationHostFocus[] = [];
  const sync = createDesktopAuthorizationSync({
    environmentId,
    clientId: "native",
    focused: () => false,
    authorize: async () => references,
    report: async (report) => {
      reports.push(report);
      if (reports.length === 3) revoked.resolve();
      if (report.authorizationThreads?.includes(threadId)) {
        entered.resolve();
        await persisted.promise;
      }
    },
  });
  try {
    sync.connect("first");
    await sync.refresh("first");
    await sync.flush();
    references = { threadIds: [threadId] };
    const flushing = sync.flush();
    await entered.promise;
    references = { threadIds: [] };
    await sync.flush();
    persisted.resolve();
    await flushing;
    await revoked.promise;
    expect(reports.map((report) => report.authorizationThreads)).toEqual([[], [threadId], []]);
    await sync.refresh("first");
    expect(reports).toHaveLength(3);
  } finally {
    sync.dispose();
  }
});

it("ignores stale lifecycle messages and applies unavailability before reconciliation", async () => {
  const operations: DesktopAuthorizationSyncInput[] = [];
  const sync = createDesktopAuthorizationSync({
    environmentId,
    clientId: "native",
    focused: () => false,
    authorize: async (input) => {
      operations.push(input);
      return { threadIds: [] };
    },
    report: async () => {},
  });
  try {
    sync.connect("current");
    await sync.refresh("current");
    await sync.lifecycle({
      type: "lifecycle",
      connectionId: "old",
      snapshots: [],
      unavailable: true,
    });
    expect(operations.some((input) => input.connectionGeneration === "old")).toBe(false);
    await sync.lifecycle({
      type: "lifecycle",
      connectionId: "current",
      snapshots: [],
      unavailableThreadIds: [threadId],
    });
    expect(
      operations.filter(
        (input) => input.operation === "unavailable" || input.operation === "reconcile",
      ),
    ).toEqual([
      {
        operation: "unavailable",
        environmentId,
        connectionGeneration: "current",
        threadIds: [threadId],
      },
      { operation: "reconcile", environmentId, connectionGeneration: "current", snapshots: [] },
    ]);
  } finally {
    sync.dispose();
  }
});

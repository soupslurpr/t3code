import {
  EnvironmentId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  configValueAtom: vi.fn(),
  randomUUID: vi.fn(),
  automationRequests: vi.fn(),
  runAtomCommand: vi.fn(),
  focus: {},
  respond: {},
}));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/lib/utils", () => ({ randomUUID: mocks.randomUUID }));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: mocks.configValueAtom },
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    automationRequests: mocks.automationRequests,
    focusAutomationHost: mocks.focus,
    respondToAutomation: mocks.respond,
  },
}));
vi.mock("~/state/environments", () => ({ useEnvironments: vi.fn() }));
vi.mock("~/state/session", () => ({ useEnvironmentsWithScope: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.runAtomCommand }));

import { computerHostAtom } from "./ComputerAutomationHosts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

function setup() {
  vi.clearAllMocks();
  let nextId = 0;
  const freshId = () => `${expect.getState().currentTestName}:${++nextId}`;
  mocks.randomUUID.mockImplementation(freshId);
  const config = (enabled = true, providerStatus = "initial") => ({
    environment: { capabilities: { userDesktopExecution: enabled } },
    providerStatus,
  });
  const configs = new Map<EnvironmentId, Atom.Writable<ReturnType<typeof config>>>();
  const scheduled = new Set<() => void>();
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.add(task);
      return () => scheduled.delete(task);
    },
  });
  const flush = () => {
    for (const task of scheduled) {
      scheduled.delete(task);
      task();
    }
  };
  const registrations: Array<{
    input: PreviewAutomationHost;
    requests: Atom.Writable<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>;
  }> = [];
  const pending = new Map<
    string,
    {
      began: ReturnType<typeof deferred<void>>;
      result: ReturnType<typeof deferred<{ ok: true; value: unknown }>>;
      cancelled: ReturnType<typeof deferred<void>>;
      replied: ReturnType<typeof deferred<PreviewAutomationResponse>>;
    }
  >();
  const cancelled: string[] = [];
  const handled: string[] = [];
  const responses: Array<{ environmentId: EnvironmentId; input: PreviewAutomationResponse }> = [];
  mocks.configValueAtom.mockImplementation((environmentId: EnvironmentId) => {
    let value = configs.get(environmentId);
    if (value === undefined) {
      value = Atom.make(config());
      configs.set(environmentId, value);
    }
    return value;
  });
  mocks.automationRequests.mockImplementation(({ input }: { input: PreviewAutomationHost }) => {
    const requests = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.success({ type: "connected" as const, connectionId: "one" }),
    );
    registrations.push({ input, requests });
    return requests;
  });
  mocks.runAtomCommand.mockImplementation(async (_registry, command, args) => {
    if (command === mocks.respond) {
      const response = args as { environmentId: EnvironmentId; input: PreviewAutomationResponse };
      responses.push(response);
      pending.get(response.input.requestId)?.replied.resolve(response.input);
    }
    return { _tag: "Success" };
  });
  const handle = (_input: unknown, context: { controllerId: string }) => {
    const call = pending.get(context.controllerId)!;
    handled.push(context.controllerId);
    call.began.resolve();
    return call.result.promise;
  };
  vi.stubGlobal("window", {
    desktopBridge: {
      getUserDesktopHost: () => ({
        desktopId: "selected",
        defaultLabel: "Isolated desktop",
        platform: "linux",
        capabilities: ["view", "control", "execution"],
      }),
      execution: handle,
      computer: {
        requestControl: handle,
        act: handle,
        release: async (_input: unknown, context: { controllerId: string }) => {
          cancelled.push(context.controllerId);
          pending.get(context.controllerId)?.cancelled.resolve();
          return { ok: true, value: undefined };
        },
      },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    hasFocus: () => true,
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const mount = () => {
    const environmentId = EnvironmentId.make(freshId());
    const atom = computerHostAtom(environmentId);
    const unmount = registry.mount(atom);
    registry.get(atom);
    flush();
    return { environmentId, atom, unmount };
  };
  const registration = (environmentId: EnvironmentId) =>
    registrations.filter(({ input }) => input.environmentId === environmentId).at(-1)!;
  const send = (environmentId: EnvironmentId, event: PreviewAutomationStreamEvent) => {
    registry.set(registration(environmentId).requests, AsyncResult.success(event));
    flush();
  };
  const request = (
    environmentId: EnvironmentId,
    operation: "computerRequestControl" | "computerAct",
    connectionId = "one",
  ) => {
    const id = freshId();
    const call = {
      began: deferred<void>(),
      result: deferred<{ ok: true; value: unknown }>(),
      cancelled: deferred<void>(),
      replied: deferred<PreviewAutomationResponse>(),
    };
    pending.set(id, call);
    const input: PreviewAutomationRequest = {
      requestId: id,
      controllerId: id,
      threadId: ThreadId.make("isolated-thread"),
      operation,
      input: { desktop: { kind: "user", desktopId: "selected" } },
      timeoutMs: 1000,
    };
    send(environmentId, { type: "request", connectionId, request: input });
    return { id, ...call };
  };
  const refresh = (environmentId: EnvironmentId, enabled = true) => {
    registry.set(configs.get(environmentId)!, config(enabled, "provider-refreshed"));
    registry.get(computerHostAtom(environmentId));
    flush();
  };
  return {
    registry,
    flush,
    mount,
    request,
    send,
    refresh,
    registration,
    registrations,
    handled,
    cancelled,
    responses,
    [Symbol.dispose]: () => {
      registry.dispose();
      for (const value of pending.values()) value.result.resolve({ ok: true, value: "disposed" });
      vi.unstubAllGlobals();
    },
  };
}

it.each(["computerRequestControl", "computerAct"] as const)(
  "preserves %s across an unrelated provider refresh",
  async (operation) => {
    using h = setup();
    const host = h.mount();
    const call = h.request(host.environmentId, operation);
    await call.began.promise;
    const originalClient = h.registration(host.environmentId).input.clientId;
    h.refresh(host.environmentId);
    expect(h.registrations).toHaveLength(1);
    expect(h.cancelled).toEqual([]);
    call.result.resolve({ ok: true, value: "same native operation" });
    expect(await call.replied.promise).toMatchObject({
      clientId: originalClient,
      requestId: call.id,
      ok: true,
      result: "same native operation",
    });
  },
);

it("revokes pending work and updates registration when a capability is removed", async () => {
  using h = setup();
  const host = h.mount();
  const old = h.request(host.environmentId, "computerRequestControl");
  await old.began.promise;
  h.refresh(host.environmentId, false);
  await old.cancelled.promise;
  expect(h.registrations).toHaveLength(2);
  expect(h.registration(host.environmentId).input.supportedOperations).not.toContain(
    "computerExecution",
  );
  old.result.resolve({ ok: true, value: "stale permission result" });
  const current = h.request(host.environmentId, "computerAct");
  await current.began.promise;
  current.result.resolve({ ok: true, value: "current" });
  await current.replied.promise;
  expect(h.responses.map(({ input }) => input.requestId)).toEqual([current.id]);
});

it("rejects stale native replies and requests when the connection generation changes", async () => {
  using h = setup();
  const host = h.mount();
  const old = h.request(host.environmentId, "computerRequestControl");
  await old.began.promise;
  h.send(host.environmentId, { type: "connected", connectionId: "two" });
  await old.cancelled.promise;
  const stale = h.request(host.environmentId, "computerAct", "one");
  const current = h.request(host.environmentId, "computerAct", "two");
  await current.began.promise;
  old.result.resolve({ ok: true, value: "late" });
  current.result.resolve({ ok: true, value: "current" });
  expect(await current.replied.promise).toMatchObject({ connectionId: "two", result: "current" });
  expect(h.handled).not.toContain(stale.id);
  expect(h.responses.map(({ input }) => input.requestId)).toEqual([current.id]);
});

it("unmounting a removed environment scope cancels only its pending native work", async () => {
  using h = setup();
  const first = h.mount();
  const second = h.mount();
  const removed = h.request(first.environmentId, "computerRequestControl");
  const retained = h.request(second.environmentId, "computerAct");
  await Promise.all([removed.began.promise, retained.began.promise]);
  first.unmount();
  h.flush();
  await removed.cancelled.promise;
  expect(h.cancelled).toEqual([removed.id]);
  removed.result.resolve({ ok: true, value: "late" });
  retained.result.resolve({ ok: true, value: "still authorized" });
  await retained.replied.promise;
  expect(h.responses).toEqual([
    expect.objectContaining({
      environmentId: second.environmentId,
      input: expect.objectContaining({ requestId: retained.id }),
    }),
  ]);
});

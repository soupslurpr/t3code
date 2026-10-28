import {
  EnvironmentId,
  ThreadId,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { resolve, reject, promise };
};

const request = (id: string): PreviewAutomationRequest => ({
  requestId: id,
  threadId: ThreadId.make("owner"),
  controllerId: "stable-owner",
  operation: "computerStatus",
  input: { desktop: { kind: "user", desktopId: "selected" } },
  timeoutMs: 1000,
});
const event = (id: string, connectionId = "one"): PreviewAutomationStreamEvent => ({
  type: "request",
  connectionId,
  request: request(id),
});
function setup(initial: PreviewAutomationStreamEvent = { type: "connected", connectionId: "one" }) {
  const registry = AtomRegistry.make();
  const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
    AsyncResult.success(initial),
  );
  const connectionAtom = Atom.make<string | null>(null);
  const started = new Map<string, ReturnType<typeof deferred<void>>>();
  const results = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const signals = new Map<string, AbortSignal>();
  const handled: string[] = [];
  const cancelled: string[] = [];
  const cancellation = deferred<void>();
  const responses: PreviewAutomationResponse[] = [];
  const replied = deferred<PreviewAutomationResponse>();
  const began = (id: string) => {
    let value = started.get(id);
    if (value === undefined) {
      value = deferred<void>();
      started.set(id, value);
    }
    return value;
  };
  const result = (id: string) => {
    let value = results.get(id);
    if (value === undefined) {
      value = deferred<unknown>();
      results.set(id, value);
    }
    return value;
  };
  const requestHandlerAtom = Atom.make({
    handle: async (request: PreviewAutomationRequest, signal: AbortSignal): Promise<unknown> => {
      handled.push(request.requestId);
      signals.set(request.requestId, signal);
      began(request.requestId).resolve();
      signal.addEventListener("abort", () => result(request.requestId).resolve("late"), {
        once: true,
      });
      return result(request.requestId).promise;
    },
    cancel: async (request: PreviewAutomationRequest) => {
      cancelled.push(request.requestId);
      cancellation.resolve();
    },
  });
  const consumer = createPreviewAutomationRequestConsumerAtom({
    requestsAtom,
    connectionAtom,
    clientId: "native",
    environmentId: EnvironmentId.make("environment"),
    requestHandlerAtom,
    respond: async (response) => {
      responses.push(response);
      replied.resolve(response);
    },
    label: "native-lifetime-test",
  });
  const unmount = registry.mount(consumer);
  return {
    registry,
    requestsAtom,
    connectionAtom,
    requestHandlerAtom,
    began,
    result,
    signals,
    handled,
    cancelled,
    cancellation,
    responses,
    replied,
    unmount,
    send: (value: PreviewAutomationStreamEvent) =>
      registry.set(requestsAtom, AsyncResult.success(value)),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it("consumes a retained native request once when the host mounts", async () => {
  using h = setup(event("initial"));
  await h.began("initial").promise;
  h.result("initial").resolve("available");
  const response = await h.replied.promise;
  expect(h.handled).toEqual(["initial"]);
  expect(response).toMatchObject({
    connectionId: "one",
    requestId: "initial",
    ok: true,
    result: "available",
  });
});

it("cancels only the selected request and suppresses its late native result", async () => {
  using h = setup();
  h.send(event("cancelled"));
  await h.began("cancelled").promise;
  h.send(event("continuing"));
  await h.began("continuing").promise;
  h.send({ type: "cancel", connectionId: "one", requestId: "cancelled" });
  expect(h.signals.get("cancelled")?.aborted).toBe(true);
  expect(h.signals.get("continuing")?.aborted).toBe(false);
  expect(h.cancelled).toEqual(["cancelled"]);
  h.result("continuing").resolve("complete");
  await h.replied.promise;
  expect(h.responses.map((response) => response.requestId)).toEqual(["continuing"]);
});

it("tears down in-flight native requests when the host unmounts", async () => {
  using h = setup();
  h.send(event("orphan"));
  await h.began("orphan").promise;
  h.unmount();
  await h.cancellation.promise;
  expect(h.signals.get("orphan")?.aborted).toBe(true);
  expect(h.cancelled).toEqual(["orphan"]);
  expect(h.responses).toEqual([]);
});

it("disconnect failure cancels native work and a new connection can recover", async () => {
  using h = setup();
  h.send(event("lost"));
  await h.began("lost").promise;
  h.registry.set(h.requestsAtom, AsyncResult.fail(new Error("disconnected")));
  expect(h.cancelled).toEqual(["lost"]);
  expect(h.registry.get(h.connectionAtom)).toBe(null);
  h.send({ type: "connected", connectionId: "two" });
  h.send(event("recovered", "two"));
  await h.began("recovered").promise;
  h.result("recovered").resolve("recovered");
  expect((await h.replied.promise).connectionId).toBe("two");
});

it("connection replacement rejects stale requests and late responses", async () => {
  using h = setup();
  h.send(event("old"));
  await h.began("old").promise;
  h.send({ type: "connected", connectionId: "two" });
  h.send(event("stale", "one"));
  h.send(event("current", "two"));
  await h.began("current").promise;
  h.result("current").resolve("current");
  await h.replied.promise;
  expect(h.handled).toEqual(["old", "current"]);
  expect(h.cancelled).toEqual(["old"]);
  expect(h.responses.map((response) => response.requestId)).toEqual(["current"]);
});

it("uses the latest handler without dropping pending native work", async () => {
  using h = setup();
  h.send(event("pending"));
  await h.began("pending").promise;
  h.registry.set(h.requestHandlerAtom, {
    handle: async () => "new handler",
    cancel: async () => {},
  });
  h.send(event("new"));
  expect((await h.replied.promise).result).toBe("new handler");
  expect(h.signals.get("pending")?.aborted).toBe(false);
  h.send({ type: "cancel", connectionId: "one", requestId: "pending" });
  expect(h.cancelled).toEqual(["pending"]);
});

it("serializes native failures without leaking arbitrary exception details", async () => {
  using h = setup();
  h.send(event("failed"));
  await h.began("failed").promise;
  h.result("failed").reject(new Error("private native exception"));
  expect((await h.replied.promise).error).toEqual({
    _tag: "PreviewAutomationExecutionError",
    message: "The desktop computer operation failed.",
  });
});

it("suppresses a stopped request while preserving access for acknowledged cleanup", async () => {
  using h = setup();
  h.send(event("stopped"));
  await h.began("stopped").promise;
  h.send({
    type: "cancel",
    connectionId: "one",
    requestId: "stopped",
    preserveDesktopAccess: true,
  });
  expect(h.signals.get("stopped")?.aborted).toBe(true);
  expect(h.cancelled).toEqual([]);
  h.send(event("cleanup"));
  await h.began("cleanup").promise;
  h.result("cleanup").resolve("retained viewing");
  await h.replied.promise;
  expect(h.responses.map((response) => response.requestId)).toEqual(["cleanup"]);
  h.unmount();
  expect(h.cancelled).toEqual([]);
});

it("routes lifecycle snapshots separately and discards a replaced connection's late snapshot", () => {
  const connectionId = "one";
  const clientId = "native";
  const environmentId = EnvironmentId.make("environment");
  const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
    AsyncResult.success<PreviewAutomationStreamEvent, Error>({ type: "connected", connectionId }),
  );
  const lifecycle = vi.fn(async () => undefined);
  const handle = vi.fn(async () => undefined);
  const respond = vi.fn(async () => undefined);
  const registry = AtomRegistry.make();
  registry.mount(
    createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      environmentId,
      connectionAtom: Atom.make<string | null>(null),
      requestHandlerAtom: Atom.make({ handle }),
      respond,
      lifecycle,
      label: "test:lifecycle",
    }),
  );
  registry.set(
    requestsAtom,
    AsyncResult.success({ type: "lifecycle", connectionId, snapshots: [] }),
  );
  expect(lifecycle).toHaveBeenCalledTimes(1);
  registry.set(
    requestsAtom,
    AsyncResult.success({ type: "connected", connectionId: "replacement" }),
  );
  registry.set(
    requestsAtom,
    AsyncResult.success({ type: "lifecycle", connectionId, snapshots: [] }),
  );
  expect(lifecycle).toHaveBeenCalledTimes(1);
  expect(handle).not.toHaveBeenCalled();
  expect(respond).not.toHaveBeenCalled();
  registry.dispose();
});

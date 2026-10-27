import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import { RegistryContext } from "@effect/atom-react";
import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { createEnvironmentSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type ConnectionCatalogEntry,
  type NetworkStatus,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ThreadId,
  ThreadMonitorId,
  type ThreadMonitorSummaryList,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry, type AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

type Target = { environmentId: EnvironmentId; input: { threadId: ThreadId } };
const state = vi.hoisted(() => ({
  allowed: true,
  cancel: vi.fn(),
  press: (() => {}) as () => void,
  live: (_input: Target): Atom.Atom<AsyncResult.AsyncResult<ThreadMonitorSummaryList, unknown>> => {
    throw new Error("setup required");
  },
  permission: null as unknown as Atom.Atom<boolean>,
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(
    realpathSync(require.resolve("@react-navigation/native/package.json")),
  );
  const {
    NavigationContext,
    useIsFocused,
    useNavigation,
  }: typeof import("@react-navigation/native") = nativeRequire("@react-navigation/core");
  return { NavigationContext, useIsFocused, useNavigation };
});
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: "div",
  ScrollView: "div",
  Pressable: ({
    onPress,
    disabled,
    accessibilityLabel,
    children,
  }: {
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    children: ReactNode;
  }) => {
    state.press = onPress;
    return (
      <button onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>
        {children}
      </button>
    );
  },
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/ErrorBanner", () => ({
  ErrorBanner: ({ message }: { message: string }) => <p>{message}</p>,
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    threadMonitorsLive: (input: Target) => state.live(input),
    cancelThreadMonitor: { permissionAtom: () => state.permission },
  },
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => state.allowed }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.cancel }));
import { ThreadMonitorsRouteScreen } from "./ThreadMonitorsRouteScreen";

const remote = EnvironmentId.make("remote");
const owner = ThreadId.make("owner");
const snapshot = (label: string): ThreadMonitorSummaryList => ({
  monitors: [
    {
      id: ThreadMonitorId.make("wait"),
      label,
      status: "active",
      condition: "thread-run",
      criterion: null,
      nextCheckAt: null,
      deadlineAt: null,
      continuation: { mode: "record-only" },
      reviewRequired: false,
      lastError: null,
    },
  ],
});

const setup = Effect.fn("ThreadMonitorScreenTest.setup")(function* () {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.allowed = true;
  state.permission = Atom.make(true);
  state.cancel.mockReset().mockResolvedValue({ _tag: "Success" });
  const registry = AtomRegistry.make();
  const starts = yield* Queue.unbounded<string>();
  const stops = yield* Queue.unbounded<string>();
  const generation = yield* Queue.unbounded<number>();
  const channels = new Map<string, Queue.Queue<ThreadMonitorSummaryList>>();
  const source = (threadId: ThreadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const channel = yield* Queue.unbounded<ThreadMonitorSummaryList>();
        channels.set(threadId, channel);
        yield* Queue.offer(starts, threadId);
        return Stream.fromQueue(channel).pipe(Stream.ensuring(Queue.offer(stops, threadId)));
      }),
    );
  const supervisorLayer = Layer.mock(EnvironmentSupervisor.EnvironmentSupervisor)({
    target: new PrimaryConnectionTarget({
      environmentId: remote,
      label: "Remote",
      httpBaseUrl: "https://remote.test",
      wsBaseUrl: "wss://remote.test",
    }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
  });
  const runtime = Atom.runtime(
    Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
      entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
        new Map(),
      ),
      networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
      followStream: (_environmentId, stream) =>
        Stream.concat(Stream.succeed(0), Stream.fromQueue(generation)).pipe(
          Stream.switchMap(() => stream),
          Stream.provide(supervisorLayer),
        ),
    }),
  );
  const live = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "test.thread-monitors",
    idleTtlMs: 0,
    subscribe: ({ threadId }: Target["input"]) => source(threadId),
  });
  const subscribed: Target[] = [];
  state.live = (target) => {
    subscribed.push(target);
    return live(target);
  };
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  const navigation = {
    isFocused: () => focused,
    goBack: vi.fn(),
    addListener: (event: keyof typeof listeners, listener: () => void) => {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  } as unknown as NavigationProp<ParamListBase>;
  const container = document.createElement("div");
  const root = createRoot(container);
  let mounted = true;
  return {
    subscribed,
    get text() {
      return container.textContent;
    },
    get button() {
      return container.querySelector<HTMLButtonElement>("button")!;
    },
    async render(threadId = owner) {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NavigationContext.Provider value={navigation}>
              <ThreadMonitorsRouteScreen route={{ params: { environmentId: remote, threadId } }} />
            </NavigationContext.Provider>
          </RegistryContext.Provider>,
        ),
      );
    },
    started: () => Queue.take(starts),
    stopped: () => Queue.take(stops),
    async emit(thread: ThreadId, label: string) {
      await act(async () => {
        Queue.offerUnsafe(channels.get(thread)!, snapshot(label));
      });
    },
    async reconnect() {
      await act(async () => {
        Queue.offerUnsafe(generation, 1);
      });
    },
    async focus(next: boolean) {
      focused = next;
      await act(async () => {
        for (const listener of listeners[next ? "focus" : "blur"]) listener();
      });
    },
    async permission(allowed: boolean) {
      state.allowed = allowed;
      await act(async () => registry.set(state.permission as Atom.Writable<boolean>, allowed));
    },
    async unmount() {
      if (mounted) {
        mounted = false;
        await act(async () => root.unmount());
      }
    },
    async [Symbol.asyncDispose]() {
      if (mounted) await act(async () => root.unmount());
      registry.dispose();
    },
  };
});

it.effect(
  "follows the selected thread across focus, reconnect and target changes, then unsubscribes",
  () =>
    Effect.gen(function* () {
      const screen = yield* setup();
      yield* Effect.addFinalizer(() => Effect.promise(() => screen[Symbol.asyncDispose]()));
      yield* Effect.promise(() => screen.render());
      expect(yield* screen.started()).toBe(owner);
      yield* Effect.promise(() => screen.emit(owner, "First run"));
      expect(screen.text).toContain("First run");
      yield* Effect.promise(() => screen.render());
      yield* Effect.promise(() => screen.reconnect());
      expect(yield* screen.stopped()).toBe(owner);
      expect(yield* screen.started()).toBe(owner);
      yield* Effect.promise(() => screen.emit(owner, "After reconnect"));
      expect(screen.text).toContain("After reconnect");
      yield* Effect.promise(() => screen.focus(false));
      expect(yield* screen.stopped()).toBe(owner);
      yield* Effect.promise(() => screen.focus(true));
      expect(yield* screen.started()).toBe(owner);
      const other = ThreadId.make("other");
      yield* Effect.promise(() => screen.render(other));
      expect(yield* screen.stopped()).toBe(owner);
      expect(yield* screen.started()).toBe(other);
      yield* Effect.promise(() => screen.emit(other, "Other thread run"));
      expect(screen.text).toContain("Other thread run");
      expect(screen.text).not.toContain("After reconnect");
      expect(screen.subscribed.every((target) => target.environmentId === remote)).toBe(true);
      yield* Effect.promise(() => screen.unmount());
      expect(yield* screen.stopped()).toBe(other);
    }).pipe(Effect.scoped),
);

it.effect("cancels on the owning environment and rejects a retained action after revocation", () =>
  Effect.gen(function* () {
    const screen = yield* setup();
    yield* Effect.addFinalizer(() => Effect.promise(() => screen[Symbol.asyncDispose]()));
    yield* Effect.promise(() => screen.render());
    yield* screen.started();
    yield* Effect.promise(() => screen.emit(owner, "Native run"));
    expect(screen.button.disabled).toBe(false);
    const retained = state.press;
    state.allowed = false;
    yield* Effect.promise(() => act(async () => retained()));
    expect(state.cancel).not.toHaveBeenCalled();
    yield* Effect.promise(() => screen.permission(false));
    expect(screen.button.disabled).toBe(true);
    yield* Effect.promise(() => screen.permission(true));
    yield* Effect.promise(() => act(async () => screen.button.click()));
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith({
      environmentId: remote,
      input: { threadId: owner, monitorId: ThreadMonitorId.make("wait") },
    });
  }).pipe(Effect.scoped),
);

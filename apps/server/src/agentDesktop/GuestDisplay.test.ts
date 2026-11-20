import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, ProviderInstanceId, type AgentDesktop } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Digest from "effect/crypto/Digest";
import { desktopCaller } from "../computer/DesktopCaller.ts";
import { ownerOf } from "./AgentEffects.ts";
import { makeGuestDisplay } from "./GuestDisplay.ts";
import { machinePaths } from "./MachinePaths.ts";
import type { DesktopLifecycle, GuestIo } from "./MachinePorts.ts";

const caller = {
  environmentId: EnvironmentId.make("e"),
  threadId: ThreadId.make("t"),
  controllerId: "controller",
  controllerKind: "agent" as const,
};

it.effect("retains agent ownership across provider-session rotation within the same thread", () =>
  Effect.gen(function* () {
    const scope = {
      environmentId: caller.environmentId,
      issuedAt: 1,
      requestNamespace: "test",
      client: undefined,
      capabilities: new Set<never>(),
      thread: {
        threadId: caller.threadId,
        providerSessionId: "before",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    };
    const before = ownerOf(yield* desktopCaller(scope));
    expect(
      ownerOf(
        yield* desktopCaller({ ...scope, thread: { ...scope.thread, providerSessionId: "after" } }),
      ),
    ).toEqual(before);
  }).pipe(Effect.provide(Digest.layerWebCrypto)),
);

it.live("finishes admitted input before releasing control and rejects subsequent input", () =>
  Effect.gen(function* () {
    const paths = machinePaths("/tmp", "agent-" + "1".repeat(32));
    let controlled = true;
    const row: AgentDesktop = {
      id: paths.id,
      label: "vm",
      owner: caller,
      state: "ready",
      automaticParking: true,
      capabilities: [],
      controllerId: caller.controllerId,
      viewerCount: 1,
      createdAt: "",
      lastActiveAt: "",
      recoverableUntil: null,
      baseGeneration: null,
      maintenance: {
        status: "current",
        targetProfileVersion: "test",
        appliedProfileVersion: "test",
        lastUpdatedAt: null,
        startedAt: null,
        completedAt: null,
      },
      graphics: {
        backend: "virtio-gpu-2d",
        hardwareAccelerated: false,
        renderer: "software",
        checkpointMode: "full-state",
      },
    };
    const order: string[] = [];
    const lifecycle: DesktopLifecycle = {
      acquire: async () => row,
      lease: async (_owner, _id, access) => {
        if (access === "release") {
          controlled = false;
          order.push("release");
        }
        return row;
      },
      begin: async () => {
        if (!controlled) throw new Error("released");
        return { paths, desktop: row, release: async () => {} };
      },
      list: vi.fn(),
      manage: vi.fn(),
      inspect: vi.fn(),
      route: vi.fn(),
      update: vi.fn(),
      baseMaintenance: vi.fn(),
      ensureBase: vi.fn(),
      maintain: vi.fn(),
    };
    const first = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    const guest: GuestIo = {
      qga: vi.fn(),
      exec: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
      qmp: async (_vm, cmd) => {
        if (cmd === "send-key") {
          order.push("key");
          if (order.length === 1) {
            first.resolve();
            await resume.promise;
          }
        }
      },
    };
    const display = makeGuestDisplay(lifecycle, guest, {
      install: vi.fn(),
      identity: vi.fn(),
      session: vi.fn(),
    });
    const desktop = { kind: "agent" as const, desktopId: paths.id };
    const request = { desktop, observation: false };
    yield* display.invoke(caller, "computerRequestControl", request, 30_000);
    const input = {
      ...request,
      actions: [
        { type: "press", key: "a" },
        { type: "press", key: "b" },
      ],
    };
    const act = yield* display
      .invoke(caller, "computerAct", input, 30_000)
      .pipe(Effect.forkScoped());
    yield* Effect.promise(() => first.promise);
    const release = yield* display
      .invoke(caller, "computerRelease", { desktop }, 30_000)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    resume.resolve();
    yield* Fiber.join(act);
    yield* Fiber.join(release);
    expect(order).toEqual(["key", "key", "release"]);
    expect((yield* Effect.result(display.invoke(caller, "computerAct", input, 30_000)))._tag).toBe(
      "Failure",
    );
  }),
);

import {
  AgentDesktopId,
  EnvironmentId,
  ThreadId,
  type AgentDesktop,
  type AgentDesktopOwner,
  type ComputerAutomationStatus,
  type DesktopComputerAutomationContext,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as AgentDesktopManager from "../agentDesktop/AgentDesktopManager.ts";
import * as ComputerUseCoordinator from "./ComputerUseCoordinator.ts";
import * as ComputerUseRouter from "./ComputerUseRouter.ts";

const environmentId = Schema.decodeUnknownSync(EnvironmentId)("environment-1");
const threadId = Schema.decodeUnknownSync(ThreadId)("thread-1");
const desktopId = Schema.decodeUnknownSync(AgentDesktopId)("agent-desktop-1");
const secondDesktopId = Schema.decodeUnknownSync(AgentDesktopId)("agent-desktop-2");
const context: DesktopComputerAutomationContext = {
  controllerId: "controller-1",
  environmentId,
  threadId,
};
const userStatus: ComputerAutomationStatus = {
  desktop: { id: "user", kind: "user", label: "Your desktop" },
  available: true,
  backend: "gnome-wayland-portal",
  permission: "remembered",
  rememberedAccess: ["view", "control"],
  displayState: "active",
  keepAwake: false,
  displays: [],
  cursor: null,
};
const agentStatus: ComputerAutomationStatus = {
  desktop: { id: desktopId, kind: "agent", label: "Agent desktop" },
  available: true,
  backend: "qemu-agent-desktop",
  permission: "granted",
  rememberedAccess: ["view", "control"],
  displayState: "active",
  keepAwake: true,
  displays: [],
  cursor: null,
};

/** Returns a status identifying one concrete Agent desktop. */
const statusForAgentDesktop = (id: AgentDesktopId): ComputerAutomationStatus => ({
  ...agentStatus,
  desktop: { id, kind: "agent", label: "Agent desktop" },
});

/** Creates deterministic desktop targets while retaining their routed operations. */
const routerHarness = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);
  const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
  const unexpected = Effect.die("unexpected desktop operation");
  const user = ComputerUseCoordinator.ComputerUseCoordinator.of({
    status: () => record("user:status").pipe(Effect.as(userStatus)),
    requestView: () => record("user:view").pipe(Effect.as(userStatus)),
    requestControl: () => record("user:control").pipe(Effect.as(userStatus)),
    requestAvailability: () => record("user:requestAvailability").pipe(Effect.as(userStatus)),
    releaseAvailability: () => record("user:releaseAvailability").pipe(Effect.as(userStatus)),
    snapshot: () => unexpected,
    act: () => unexpected,
    release: () => record("user:release").pipe(Effect.as(userStatus)),
    forget: () => record("user:forget"),
  });
  const desktop: AgentDesktop = {
    id: desktopId,
    label: "Agent desktop",
    owner: { environmentId, threadId, controllerId: context.controllerId },
    state: "ready",
    automaticParking: true,
    capabilities: ["computer"],
    graphics: {
      backend: "virtio-gpu-2d",
      hardwareAccelerated: false,
      renderer: "virtio-gpu 2D",
      checkpointMode: "full-state",
    },
    controllerId: null,
    viewerCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    recoverableUntil: null,
  };
  const assertOwner = (owner: AgentDesktopOwner) => {
    assert.deepEqual(owner, {
      environmentId,
      threadId,
      controllerId: context.controllerId,
    });
  };
  const agent = AgentDesktopManager.AgentDesktopManager.of({
    list: Effect.succeed({ available: true, desktops: [desktop], requirements: [] }),
    setup: unexpected,
    acquire: () => Effect.succeed(desktop),
    manage: () => Effect.succeed(desktop),
    command: () => unexpected,
    readFile: () => unexpected,
    writeFile: () => unexpected,
    transfer: () => unexpected,
    cancelTransfer: () => unexpected,
    inspect: () => unexpected,
    createPortRoute: () => unexpected,
    removePortRoute: () => unexpected,
    capturePackets: () => unexpected,
    requestView: (owner, selector) =>
      Effect.sync(() => {
        assertOwner(owner);
        assert.deepEqual(selector, { kind: "agent", fresh: true });
      }).pipe(Effect.andThen(record("agent:view")), Effect.as(agentStatus)),
    requestControl: (owner, selector) =>
      Effect.sync(() => assertOwner(owner)).pipe(
        Effect.andThen(record(`agent:control:${selector.desktopId ?? "automatic"}`)),
        Effect.as(statusForAgentDesktop(selector.desktopId ?? desktopId)),
      ),
    requestHumanView: () => unexpected,
    requestHumanControl: () => unexpected,
    status: (_controllerId, selectedId) =>
      record(`agent:status:${selectedId}`).pipe(
        Effect.as(statusForAgentDesktop(selectedId ?? desktopId)),
      ),
    snapshot: (_controllerId, _input, selectedId) =>
      record(`agent:snapshot:${selectedId}`).pipe(
        Effect.as({
          display: {
            id: "display-0",
            label: "Agent desktop",
            primary: true,
            bounds: { x: 0, y: 0, width: 1600, height: 900 },
            scaleFactor: 1,
          },
          cursor: null,
          captureSource: "virtual-display" as const,
        }),
      ),
    act: (_controllerId, _input, selectedId) =>
      record(`agent:act:${selectedId}`).pipe(Effect.as([])),
    release: (_controllerId, selectedId) =>
      record(`agent:release:${selectedId}`).pipe(Effect.as(agentStatus)),
    forget: (_controllerId, selectedId) => record(`agent:forget:${selectedId}`),
  });
  const layer = ComputerUseRouter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ComputerUseCoordinator.ComputerUseCoordinator, user),
        Layer.succeed(AgentDesktopManager.AgentDesktopManager, agent),
      ),
    ),
  );
  return { calls, layer };
});

describe("ComputerUseRouter", () => {
  it.effect("routes availability independently to the user desktop", () =>
    Effect.gen(function* () {
      const harness = yield* routerHarness;
      yield* Effect.gen(function* () {
        const router = yield* ComputerUseRouter.ComputerUseRouter;
        yield* router.requestAvailability(context, {});
        yield* router.releaseAvailability(context, {});
        assert.deepEqual(yield* Ref.get(harness.calls), [
          "user:requestAvailability",
          "user:releaseAvailability",
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("defaults to Your desktop", () =>
    Effect.gen(function* () {
      const harness = yield* routerHarness;
      yield* Effect.gen(function* () {
        const router = yield* ComputerUseRouter.ComputerUseRouter;
        assert.equal((yield* router.status(context, {})).desktop?.kind, "user");
        assert.deepEqual(yield* Ref.get(harness.calls), ["user:status"]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("routes subsequent operations by concrete Agent desktop id", () =>
    Effect.gen(function* () {
      const harness = yield* routerHarness;
      yield* Effect.gen(function* () {
        const router = yield* ComputerUseRouter.ComputerUseRouter;
        const status = yield* router.requestView(context, {
          desktop: { kind: "agent", fresh: true },
        });
        assert.equal(status.desktop?.id, desktopId);
        const target = { kind: "agent" as const, desktopId };
        yield* router.requestControl(context, { desktop: target });
        yield* router.snapshot(context, { desktop: target });
        yield* router.act(context, {
          desktop: target,
          actions: [{ type: "press", key: "Escape" }],
        });
        yield* router.release(context, { desktop: target });

        assert.deepEqual(yield* Ref.get(harness.calls), [
          "agent:view",
          `agent:control:${desktopId}`,
          `agent:snapshot:${desktopId}`,
          `agent:act:${desktopId}`,
          `agent:release:${desktopId}`,
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps parallel Agent desktop operations isolated", () =>
    Effect.gen(function* () {
      const harness = yield* routerHarness;
      yield* Effect.gen(function* () {
        const router = yield* ComputerUseRouter.ComputerUseRouter;
        const first = { kind: "agent" as const, desktopId };
        const second = { kind: "agent" as const, desktopId: secondDesktopId };

        yield* router.requestControl(context, { desktop: first });
        yield* router.requestControl(context, { desktop: second });
        yield* router.act(context, {
          desktop: first,
          actions: [{ type: "press", key: "A" }],
        });
        yield* router.act(context, {
          desktop: second,
          actions: [{ type: "press", key: "B" }],
        });
        yield* router.release(context, { desktop: first });
        yield* router.snapshot(context, { desktop: second });
        yield* router.release(context, { desktop: second });

        assert.deepEqual(yield* Ref.get(harness.calls), [
          `agent:control:${desktopId}`,
          `agent:control:${secondDesktopId}`,
          `agent:act:${desktopId}`,
          `agent:act:${secondDesktopId}`,
          `agent:release:${desktopId}`,
          `agent:snapshot:${secondDesktopId}`,
          `agent:release:${secondDesktopId}`,
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

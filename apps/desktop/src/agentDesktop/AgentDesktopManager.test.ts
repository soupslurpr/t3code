import { AgentDesktopId, AgentDesktopOwner, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

const { nativeImage } = vi.hoisted(() => {
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 100, height: 100 }),
    crop: () => image,
    resize: () => image,
    toPNG: () => Buffer.from([1]),
  };
  return { nativeImage: { createFromBitmap: vi.fn(() => image) } };
});

vi.mock("electron", () => ({ nativeImage }));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ComputerUse from "../computer/ComputerUse.ts";
import * as AgentDesktopManager from "./AgentDesktopManager.ts";
import * as QemuAgentDesktop from "./QemuAgentDesktop.ts";

const owner = Schema.decodeUnknownSync(AgentDesktopOwner)({
  environmentId: Schema.decodeUnknownSync(EnvironmentId)("environment-1"),
  threadId: Schema.decodeUnknownSync(ThreadId)("thread-1"),
  controllerId: "controller-1",
});
const decodeAgentDesktopId = Schema.decodeUnknownSync(AgentDesktopId);
const decodeAgentDesktopOwner = Schema.decodeUnknownEffect(AgentDesktopOwner);
const decodeRecordedAccessibilityLocator = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      application: Schema.String,
      processId: Schema.Int,
      objectPath: Schema.String,
      window: Schema.optional(Schema.String),
    }),
  ),
);

/** Creates a deterministic in-memory hypervisor and its recorded calls. */
const makeQemu = (
  accessibility: boolean,
  acceleratedGraphicsAvailable: boolean,
  failInputReleaseOnce: boolean,
  failSendKeyOnce: boolean,
  textInsertionResponse: string,
  activationResponse: string,
  captureAvailable: boolean,
  windowActivationRequiresSwitch: boolean,
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const inputEvents = yield* Ref.make<
      ReadonlyArray<ReadonlyArray<QemuAgentDesktop.QemuInputEvent>>
    >([]);
    const running = yield* Ref.make<ReadonlySet<AgentDesktopId>>(new Set());
    const commandStarted = yield* Deferred.make<void>();
    const releaseCommand = yield* Deferred.make<void>();
    const desktopParked = yield* Deferred.make<void>();
    const inputReleaseFailed = yield* Ref.make(false);
    const sendKeyFailed = yield* Ref.make(false);
    let windowActivationAttemptCount = 0;
    const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
    const service = QemuAgentDesktop.QemuAgentDesktop.of({
      probe: Effect.succeed({
        available: true,
        baseImagePath: "/base.qcow2",
        displayDevice: "virtio-vga",
        acceleratedGraphicsAvailable,
        requirements: [],
      }),
      setup: Effect.succeed({
        attempted: false,
        completed: true,
        packages: [],
        imageProvisioned: false,
        probe: {
          available: true,
          baseImagePath: "/base.qcow2",
          displayDevice: "virtio-vga",
          acceleratedGraphicsAvailable,
          requirements: [],
        },
      }),
      paths: () => {
        throw new Error("paths are not used by the manager test");
      },
      create: (id) => record(`create:${id}`),
      clone: (source, destination) => record(`clone:${source}:${destination}`),
      start: (id, _resources, _routes, _restoreParkedState, graphicsBackend) =>
        record(`start:${id}:${graphicsBackend}`).pipe(
          Effect.andThen(Ref.update(running, (current) => new Set(current).add(id))),
        ),
      isRunning: (id) => Ref.get(running).pipe(Effect.map((current) => current.has(id))),
      stop: (id) =>
        record(`stop:${id}`).pipe(
          Effect.andThen(
            Ref.update(running, (current) => {
              const next = new Set(current);
              next.delete(id);
              return next;
            }),
          ),
        ),
      park: (id, saveMemoryState) =>
        record(`park:${id}:${saveMemoryState ? "memory" : "cold"}`).pipe(
          Effect.andThen(Deferred.succeed(desktopParked, undefined)),
          Effect.asVoid,
        ),
      checkpoint: (id, saveMemoryState) =>
        record(`checkpoint:${id}:${saveMemoryState ? "memory" : "disk"}`),
      remove: (id) => record(`remove:${id}`),
      capture: () =>
        captureAvailable
          ? Effect.succeed({
              kind: "bitmap" as const,
              path: "/capture.raw",
              data: new Uint8Array(100 * 100 * 4).fill(255),
              width: 100,
              height: 100,
            })
          : Effect.die("capture is not expected"),
      sendInput: (id, events) =>
        Effect.gen(function* () {
          yield* record(`input:${id}:${events.length}`);
          yield* Ref.update(inputEvents, (current) => [...current, events]);
          const isRelease =
            events.length > 0 &&
            events.every((event) => event.type !== "abs" && event.data.down === false);
          if (
            failInputReleaseOnce &&
            isRelease &&
            !(yield* Ref.getAndSet(inputReleaseFailed, true))
          ) {
            return yield* new QemuAgentDesktop.QemuAgentDesktopError({
              code: "internal-error",
              operation: "send-input",
              detail: "the test release failed",
            });
          }
        }),
      sendKey: (id, qcodes) =>
        record(`key:${id}:${qcodes.join("+")}`).pipe(
          Effect.andThen(
            failSendKeyOnce
              ? Ref.getAndSet(sendKeyFailed, true).pipe(
                  Effect.flatMap((failed) =>
                    failed
                      ? Effect.void
                      : new QemuAgentDesktop.QemuAgentDesktopError({
                          code: "internal-error",
                          operation: "send-key",
                          detail: "the test key chord failed",
                        }),
                  ),
                )
              : Effect.void,
          ),
        ),
      guestCommand: (_id, command) =>
        command === "guest-network-get-interfaces"
          ? Effect.succeed([
              {
                name: "eth0",
                "ip-addresses": [{ "ip-address": "10.0.2.15" }],
                statistics: {
                  "rx-bytes": 1_000,
                  "tx-bytes": 2_000,
                  "rx-packets": 10,
                  "tx-packets": 20,
                  "rx-dropped": 1,
                  "tx-dropped": 2,
                },
              },
            ])
          : Effect.die("unexpected guest command"),
      executeGuestProcess: (id, input) => {
        const argumentsValue = input.arguments ?? [];
        const encodedTextInput = argumentsValue.at(-1);
        const successfulTextInsertion = () => {
          if (typeof encodedTextInput !== "string") {
            throw new Error("the guest text insertion argument is missing");
          }
          const insertion = JSON.parse(
            Buffer.from(encodedTextInput, "base64").toString("utf8"),
          ) as {
            readonly text: string;
          };
          const codePointCount = Array.from(insertion.text).length;
          return JSON.stringify({
            ok: true,
            result: {
              status: "inserted",
              injectedCodePoints: codePointCount,
              confirmedCodePoints: codePointCount,
            },
          });
        };
        const accessibilityOutput = argumentsValue.includes("probe")
          ? '{"ok":true,"result":{"available":true}}'
          : argumentsValue.includes("insert-text")
            ? textInsertionResponse || successfulTextInsertion()
            : argumentsValue.includes("snapshot")
              ? '{"ok":true,"result":{"available":true,"coordinateSpace":"focused-window","window":{"application":"Calculator","name":"Calculator","size":{"width":400,"height":500}},"windows":[{"window":{"application":"Calculator","name":"Calculator","focused":true},"locator":{"application":"Calculator","processId":42,"objectPath":"/org/example/Calculator/window/1"}}],"targets":[{"target":{"application":"Calculator","role":"button","name":"7","bounds":{"x":10,"y":20,"width":30,"height":40},"activation":"action","enabled":true,"focused":false,"selected":false,"checked":false,"expanded":false},"locator":{"application":"Calculator","processId":42,"objectPath":"/org/example/Calculator/window/1","path":[1,2],"role":"button","name":"7","activation":"action","actionName":"click"}}],"truncated":false}}'
              : argumentsValue.includes("activate-window")
                ? windowActivationRequiresSwitch && windowActivationAttemptCount++ === 0
                  ? '{"ok":true,"result":{"activated":false}}'
                  : '{"ok":true,"result":{"activated":true}}'
                : argumentsValue.includes("activate")
                  ? activationResponse
                  : undefined;
        const result = {
          exitCode: 0,
          stdout:
            input.executable === "/usr/bin/getent"
              ? "t3test:x:1000:1000::/home/t3test:/bin/bash\n"
              : accessibilityOutput !== undefined
                ? accessibilityOutput
                : input.executable === "/usr/bin/ss"
                  ? 'ESTAB 0 0 10.0.2.15:40000 203.0.113.1:443 users:(("chromium",pid=42,fd=7))\n'
                  : "ok\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
        const execute =
          input.executable === "/usr/bin/t3-block"
            ? Deferred.succeed(commandStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCommand)),
              )
            : Effect.void;
        return record(`exec:${id}:${input.executable}:${(input.arguments ?? []).join(" ")}`).pipe(
          Effect.andThen(execute),
          Effect.as(result),
        );
      },
      readGuestFile: (_id, path) =>
        Effect.succeed({
          data: new TextEncoder().encode(
            accessibility && path === "/etc/t3-agent-desktop-user" ? "t3test\n" : "hello",
          ),
          eof: true,
        }),
      writeGuestFile: (id, path, data) =>
        record(`write:${id}:${path}:${data.byteLength}`).pipe(Effect.as(data.byteLength)),
      addRoute: () => Effect.die("route is not expected"),
      removeRoute: () => Effect.die("route is not expected"),
      diskUsage: () => Effect.succeed({ allocatedBytes: 1, virtualBytes: 2 }),
      storageCapacity: Effect.succeed({
        totalBytes: 200 * 1024 ** 3,
        availableBytes: 100 * 1024 ** 3,
      }),
      resourceUsage: () => Effect.succeed({ cpuUsageNanoseconds: 1, memoryUsedBytes: 1 }),
      capturePackets: () =>
        Effect.succeed({ path: "/captures/network.pcap", sizeBytes: 64, truncated: false }),
      qmp: (id, operation) => record(`qmp:${id}:${operation}`).pipe(Effect.as({})),
    });
    return { calls, commandStarted, desktopParked, inputEvents, releaseCommand, service };
  });

/** Creates an isolated manager layer backed by one fake hypervisor. */
const managerHarness = (
  name: string,
  options?: {
    readonly accessibility?: boolean;
    readonly acceleratedGraphics?: boolean;
    readonly failInputReleaseOnce?: boolean;
    readonly failSendKeyOnce?: boolean;
    readonly textInsertionResponse?: string;
    readonly activationResponse?: string;
    readonly captureAvailable?: boolean;
    readonly windowActivationRequiresSwitch?: boolean;
  },
) =>
  Effect.gen(function* () {
    const accessibility = options?.accessibility === true;
    const qemu = yield* makeQemu(
      accessibility,
      options?.acceleratedGraphics === true,
      options?.failInputReleaseOnce === true,
      options?.failSendKeyOnce === true,
      options?.textInsertionResponse ?? "",
      options?.activationResponse ?? '{"ok":true,"result":{"keyboard":false}}',
      options?.captureAvailable === true,
      options?.windowActivationRequiresSwitch === true,
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const agentDesktopsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: `t3-agent-manager-${name}-`,
    });
    const accessibilityResource = `${agentDesktopsDir}/agent-desktop-accessibility.js`;
    if (accessibility) yield* fileSystem.writeFileString(accessibilityResource, "test helper");
    const environmentLayer = Layer.effect(
      DesktopEnvironment.DesktopEnvironment,
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return DesktopEnvironment.DesktopEnvironment.of({
          path,
          platform: "linux",
          processArch: "x64",
          agentDesktopsDir,
          agentDesktopBaseImage: { _tag: "None" },
          resolveResourcePathCandidates: () => (accessibility ? [accessibilityResource] : []),
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      environmentLayer,
      Layer.succeed(QemuAgentDesktop.QemuAgentDesktop, qemu.service),
    );
    return {
      calls: qemu.calls,
      commandStarted: qemu.commandStarted,
      desktopParked: qemu.desktopParked,
      inputEvents: qemu.inputEvents,
      releaseCommand: qemu.releaseCommand,
      layer: AgentDesktopManager.layer.pipe(Layer.provide(dependencies)),
    };
  }).pipe(Effect.provide(NodeServices.layer));

describe("AgentDesktopManager", () => {
  it("reconciles persisted lifecycle states with QEMU after restart", () => {
    assert.equal(AgentDesktopManager.reconcileAgentDesktopLifecycleState("active", true), "ready");
    assert.equal(
      AgentDesktopManager.reconcileAgentDesktopLifecycleState("ready", false),
      "stopped",
    );
    assert.equal(
      AgentDesktopManager.reconcileAgentDesktopLifecycleState("parking", false),
      "parked",
    );
    assert.equal(
      AgentDesktopManager.reconcileAgentDesktopLifecycleState("creating", false),
      "failed",
    );
    assert.equal(
      AgentDesktopManager.reconcileAgentDesktopLifecycleState("recoverable", false),
      "recoverable",
    );
  });

  it("chooses bounded resources automatically", () => {
    assert.deepEqual(
      AgentDesktopManager.chooseAgentDesktopResources(
        {
          totalMemoryBytes: 32 * 1024 ** 3,
          freeMemoryBytes: 20 * 1024 ** 3,
          cpuCount: 16,
          runningDesktopCount: 1,
        },
        { graphics: "preferred", expectedTemporaryDiskBytes: 40 * 1024 ** 3 },
      ),
      {
        cpuCount: 6,
        memoryBytes: 6 * 1024 ** 3,
        diskVirtualBytes: 112 * 1024 ** 3,
        audio: false,
      },
    );
    assert.equal(
      AgentDesktopManager.chooseAgentDesktopResources({
        totalMemoryBytes: 8 * 1024 ** 3,
        freeMemoryBytes: 3 * 1024 ** 3,
        cpuCount: 4,
        runningDesktopCount: 0,
      }),
      null,
    );
  });

  it("parks only unleased idle desktops", () => {
    const now = Duration.toMillis(Duration.minutes(10));
    const lastActiveAt = "1970-01-01T00:00:00.000Z";
    assert.isTrue(
      AgentDesktopManager.shouldAutomaticallyParkAgentDesktop({
        now,
        lastActiveAt,
        preventParking: false,
        hasLease: false,
        activeOperationCount: 0,
      }),
    );
    assert.isFalse(
      AgentDesktopManager.shouldAutomaticallyParkAgentDesktop({
        now,
        lastActiveAt,
        preventParking: true,
        hasLease: false,
        activeOperationCount: 0,
      }),
    );
    assert.isFalse(
      AgentDesktopManager.shouldAutomaticallyParkAgentDesktop({
        now,
        lastActiveAt,
        preventParking: false,
        hasLease: false,
        activeOperationCount: 1,
      }),
    );
  });

  it("selects only safe automatic recovery candidates", () => {
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const stale = decodeAgentDesktopId("desktop-stale");
    const preserved = decodeAgentDesktopId("desktop-preserved");
    const running = decodeAgentDesktopId("desktop-running");
    const recent = decodeAgentDesktopId("desktop-recent");
    assert.deepEqual(
      AgentDesktopManager.selectAutomaticRecoveryCandidates({
        now,
        desktops: [
          {
            id: stale,
            state: "stopped",
            lastActiveAt: "2026-07-01T12:00:00.000Z",
            retention: "automatic",
            allocatedBytes: 1,
          },
          {
            id: preserved,
            state: "parked",
            lastActiveAt: "2026-06-01T12:00:00.000Z",
            retention: "preserve",
            allocatedBytes: 1,
          },
          {
            id: running,
            state: "ready",
            lastActiveAt: "2026-06-01T12:00:00.000Z",
            retention: "automatic",
            allocatedBytes: 1,
          },
          {
            id: recent,
            state: "stopped",
            lastActiveAt: "2026-08-01T12:00:00.000Z",
            retention: "automatic",
            allocatedBytes: 1,
          },
        ],
      }),
      [{ id: stale, reason: "inactive" }],
    );
  });

  it("schedules only sufficiently idle storage needed for the reserve", () => {
    const gib = 1024 ** 3;
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const pending = decodeAgentDesktopId("desktop-pending");
    const unknown = decodeAgentDesktopId("desktop-unknown");
    const oldest = decodeAgentDesktopId("desktop-oldest");
    const older = decodeAgentDesktopId("desktop-older");
    const recent = decodeAgentDesktopId("desktop-recent");
    assert.deepEqual(
      AgentDesktopManager.selectAutomaticRecoveryCandidates({
        now,
        storage: { totalBytes: 200 * gib, availableBytes: 3 * gib },
        desktops: [
          {
            id: pending,
            state: "recoverable",
            lastActiveAt: "2026-08-01T12:00:00.000Z",
            retention: "automatic",
            allocatedBytes: 1 * gib,
          },
          {
            id: unknown,
            state: "stopped",
            lastActiveAt: "2026-08-02T12:00:00.000Z",
            retention: "automatic",
            allocatedBytes: 0,
          },
          {
            id: oldest,
            state: "stopped",
            lastActiveAt: "2026-08-03T12:00:00.000Z",
            retention: "automatic",
            allocatedBytes: 0.5 * gib,
          },
          {
            id: older,
            state: "parked",
            lastActiveAt: "2026-08-11T12:00:00.000Z",
            retention: "automatic",
            allocatedBytes: 1 * gib,
          },
          {
            id: recent,
            state: "stopped",
            lastActiveAt: "2026-08-13T00:30:00.000Z",
            retention: "automatic",
            allocatedBytes: 20 * gib,
          },
        ],
      }),
      [
        { id: oldest, reason: "storage-pressure" },
        { id: older, reason: "storage-pressure" },
      ],
    );
  });

  it.effect("returns setup results with the manager's current desktops", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("setup");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Prepared" });
        const result = yield* manager.setup;

        assert.isFalse(result.attempted);
        assert.isTrue(result.completed);
        assert.deepEqual(result.packages, []);
        assert.deepEqual(result.status.requirements, []);
        assert.deepEqual(
          result.status.desktops.map((value) => value.id),
          [desktop.id],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("creates, reuses, controls, and releases one desktop", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("lifecycle");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const first = yield* manager.acquire(owner, { label: "Research" });
        const reused = yield* manager.acquire(owner, {});
        assert.equal(reused.id, first.id);

        const status = yield* manager.requestControl(owner, { kind: "agent" });
        assert.equal(status.permission, "granted");
        assert.deepEqual(status.desktop, {
          id: first.id,
          kind: "agent",
          label: "Research",
        });
        const semanticOnly = yield* manager.snapshot(
          owner.controllerId,
          { screenshot: false },
          first.id,
        );
        assert.equal(semanticOnly.accessibility?.available, false);
        yield* manager.act(
          owner.controllerId,
          { actions: [{ type: "hotkey", keys: ["Control", "L"] }] },
          first.id,
        );
        assert.equal(
          (yield* manager.release(owner.controllerId, first.id)).permission,
          "remembered",
        );

        const calls = yield* Ref.get(harness.calls);
        assert.equal(calls.filter((call) => call.startsWith("create:")).length, 1);
        assert.equal(calls.filter((call) => call.startsWith("start:")).length, 1);
        assert(calls.some((call) => call.endsWith(":ctrl+l") && call.startsWith("key:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("captures a durable Agent desktop region without a source frame", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("durable-region", { captureAvailable: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Durable crop" });
        yield* manager.requestView(owner, { kind: "agent", desktopId: desktop.id });

        const snapshot = yield* manager.snapshot(
          owner.controllerId,
          {
            includeAccessibility: false,
            screenshot: {
              region: {
                coordinateSpace: "desktop-logical",
                displayId: "display-0",
                x: 10,
                y: 20,
                width: 30,
                height: 40,
              },
              maxWidth: 100,
              maxHeight: 100,
            },
          },
          desktop.id,
        );

        assert.deepInclude(snapshot.frame, {
          displayId: "display-0",
          toDesktopLogical: {
            scaleX: 0.3,
            scaleY: 0.4,
            offsetX: 10,
            offsetY: 20,
          },
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("shares view-only access with another controller in the same thread", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("shared-thread-view");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Shared view" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const viewer = yield* decodeAgentDesktopOwner({
          ...owner,
          controllerId: "monitor-controller",
        });

        const viewed = yield* manager.requestView(viewer, {
          kind: "agent",
          desktopId: desktop.id,
        });
        assert.strictEqual(viewed.permission, "view-only");
        assert.strictEqual(
          (yield* manager.status(owner.controllerId, desktop.id)).permission,
          "granted",
        );

        const foreignThread = yield* decodeAgentDesktopOwner({
          ...viewer,
          threadId: "another-thread",
        });
        const error = yield* manager
          .requestView(foreignThread, { kind: "agent", desktopId: desktop.id })
          .pipe(Effect.flip);
        assert.strictEqual(
          ComputerUse.toComputerAutomationFailure(error).code,
          "desktop-target-mismatch",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("restores recoverable desktops and permanently removes them on request", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("deletion-lifecycle");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Disposable" });
        const deleted = yield* manager.manage(owner, {
          desktopId: desktop.id,
          operation: "delete",
        });
        assert.equal(deleted.state, "recoverable");
        assert.isNotNull(deleted.recoverableUntil);

        const restored = yield* manager.manage(owner, {
          desktopId: desktop.id,
          operation: "restore",
        });
        assert.equal(restored.state, "stopped");
        assert.isNull(restored.recoverableUntil);

        yield* manager.manage(owner, { desktopId: desktop.id, operation: "delete" });
        yield* manager.manage(owner, {
          desktopId: desktop.id,
          operation: "delete-permanently",
        });
        assert.isFalse(
          (yield* manager.list).desktops.some((candidate) => candidate.id === desktop.id),
        );
        assert.isTrue(
          (yield* Ref.get(harness.calls)).some((call) => call === `remove:${desktop.id}`),
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("selects accelerated graphics and disk-consistent lifecycle operations", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("accelerated", { acceleratedGraphics: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, {
          label: "Accelerated",
          requirements: { graphics: "required" },
        });
        assert.deepEqual(desktop.graphics, {
          backend: "virgl",
          hardwareAccelerated: true,
          renderer: "virgl",
          checkpointMode: "disk-consistent",
        });
        assert.include(desktop.capabilities, "graphics-acceleration");

        yield* manager.manage(owner, { desktopId: desktop.id, operation: "snapshot" });
        yield* manager.manage(owner, { desktopId: desktop.id, operation: "park" });
        const softwareDesktop = yield* manager.acquire(owner, {
          requirements: { graphics: "none" },
        });
        assert.notEqual(softwareDesktop.id, desktop.id);
        assert.deepEqual(softwareDesktop.graphics, {
          backend: "virtio-gpu-2d",
          hardwareAccelerated: false,
          renderer: "virtio-gpu 2D",
          checkpointMode: "full-state",
        });

        const calls = yield* Ref.get(harness.calls);
        assert.isTrue(calls.some((call) => call.endsWith(":virgl") && call.startsWith("start:")));
        assert.isTrue(
          calls.some((call) => call.endsWith(":virtio-gpu-2d") && call.startsWith("start:")),
        );
        assert.isTrue(calls.some((call) => call.endsWith(":disk")));
        assert.isTrue(calls.some((call) => call.endsWith(":cold")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("captures and activates guest accessibility targets", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("accessibility", {
        accessibility: true,
        activationResponse: '{"ok":true,"result":{"keyboard":true}}',
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Accessible" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        const snapshot = yield* manager.snapshot(
          owner.controllerId,
          { screenshot: false },
          desktop.id,
        );
        assert.isTrue(snapshot.accessibility?.available);
        assert.equal(snapshot.accessibility?.window?.application, "Calculator");
        assert.equal(snapshot.accessibility?.windows[0]?.name, "Calculator");
        assert.equal(snapshot.accessibility?.targets[0]?.name, "7");

        const targetId = snapshot.accessibility?.targets[0]?.id;
        assert.isDefined(targetId);
        yield* manager.act(
          owner.controllerId,
          { actions: [{ type: "activate", targetId }] },
          desktop.id,
        );
        const windowSnapshot = yield* manager.snapshot(
          owner.controllerId,
          { screenshot: false },
          desktop.id,
        );
        const windowId = windowSnapshot.accessibility?.windows[0]?.id;
        assert.isDefined(windowId);
        assert.deepEqual(
          yield* manager.act(
            owner.controllerId,
            { actions: [{ type: "activate_window", windowId }] },
            desktop.id,
          ),
          [{ index: 0, type: "activate_window" }],
        );

        const calls = yield* Ref.get(harness.calls);
        assert.isTrue(
          calls.some((call) => call.includes("/usr/bin/gjs") && call.includes("probe")),
        );
        assert.isTrue(
          calls.some((call) => call.includes("/usr/bin/gjs") && call.includes("snapshot")),
        );
        assert.isTrue(
          calls.some((call) => call.includes("/usr/bin/gjs") && call.includes("activate")),
        );
        assert.isTrue(calls.some((call) => call.startsWith("key:") && call.endsWith(":ret")));
        assert.isTrue(calls.some((call) => call.includes("activate-window")));
        const activationCall = calls.find((call) => call.includes(" activate "));
        const windowActivationCall = calls.find((call) => call.includes(" activate-window "));
        assert.isDefined(activationCall);
        assert.isDefined(windowActivationCall);
        for (const call of [activationCall, windowActivationCall]) {
          const encodedLocator = call.split(" ").at(-1);
          assert.isDefined(encodedLocator);
          const locator = decodeRecordedAccessibilityLocator(
            Buffer.from(encodedLocator, "base64").toString("utf8"),
          );
          assert.deepInclude(locator, {
            application: "Calculator",
            processId: 42,
            objectPath: "/org/example/Calculator/window/1",
          });
          assert.notProperty(locator, "window");
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("preserves semantic targets across visual-only viewer snapshots", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("accessibility-viewer", {
        accessibility: true,
        captureAvailable: true,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Accessible viewer" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        const semanticSnapshot = yield* manager.snapshot(
          owner.controllerId,
          { screenshot: false },
          desktop.id,
        );
        const targetId = semanticSnapshot.accessibility?.targets[0]?.id;
        assert.isDefined(targetId);

        const viewerControllerId = "human:viewer";
        yield* manager.requestHumanView(owner, viewerControllerId, desktop.id);
        yield* manager.snapshot(
          viewerControllerId,
          { includeAccessibility: false, screenshot: {} },
          desktop.id,
        );

        assert.deepEqual(
          yield* manager.act(
            owner.controllerId,
            { actions: [{ type: "activate", targetId }] },
            desktop.id,
          ),
          [{ index: 0, type: "activate" }],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("switches to Agent desktop windows that reject top-level accessibility focus", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("window-switch-fallback", {
        accessibility: true,
        windowActivationRequiresSwitch: true,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Window switch" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const snapshot = yield* manager.snapshot(
          owner.controllerId,
          { screenshot: false },
          desktop.id,
        );
        const windowId = snapshot.accessibility?.windows[0]?.id;
        assert.isDefined(windowId);

        const activation = yield* manager
          .act(owner.controllerId, { actions: [{ type: "activate_window", windowId }] }, desktop.id)
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(100));
        assert.deepEqual(yield* Fiber.join(activation), [{ index: 0, type: "activate_window" }]);

        const calls = yield* Ref.get(harness.calls);
        assert.isTrue(calls.some((call) => call.startsWith("key:") && call.endsWith(":alt+esc")));
        assert.equal(calls.filter((call) => call.includes(" activate-window ")).length, 2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reports semantic activation rejection with target context", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("activation-rejected", {
        accessibility: true,
        activationResponse:
          '{"ok":false,"code":"accessibility-activation-failed","detail":"the application rejected semantic activation"}',
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Rejected activation" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const snapshot = yield* manager.snapshot(
          owner.controllerId,
          { screenshot: false },
          desktop.id,
        );
        const targetId = snapshot.accessibility?.targets[0]?.id;
        assert.isDefined(targetId);

        const error = yield* manager
          .act(owner.controllerId, { actions: [{ type: "activate", targetId }] }, desktop.id)
          .pipe(Effect.flip);
        assert.deepInclude(ComputerUse.toComputerAutomationFailure(error), {
          code: "semantic-activation-failed",
          category: "input-injection",
          actionIndex: 0,
          completedActionCount: 0,
          field: "actions[0].targetId",
          received: targetId,
          phase: "execution",
          cleanup: { keys: "not-needed", buttons: "not-needed" },
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("inserts exact editable text and preserves a keyboard fallback", () =>
    Effect.gen(function* () {
      const accessibleHarness = yield* managerHarness("exact-text", { accessibility: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Exact text" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const resultsFiber = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                { type: "type", text: "ASCII is exact\nacross lines" },
                { type: "type", text: "That’s exact → 😀" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(500));
        const results = yield* Fiber.join(resultsFiber);
        assert.deepInclude(results[0], {
          type: "type",
          delivery: "accessibility",
          focusedEditable: true,
        });
        const unicodeResult = results[1];
        assert.equal(unicodeResult?.type, "type");
        if (unicodeResult?.type === "type") {
          assert.equal(unicodeResult.confirmedCodePoints, Array.from("That’s exact → 😀").length);
        }

        const calls = yield* Ref.get(accessibleHarness.calls);
        assert.equal(
          calls.filter((call) => call.includes("/usr/bin/gjs") && call.includes("insert-text"))
            .length,
          2,
        );
        assert.isFalse(calls.some((call) => call.startsWith("input:")));
        assert.isFalse(calls.some((call) => call.startsWith("key:")));
      }).pipe(Effect.provide(accessibleHarness.layer));

      const fallbackHarness = yield* managerHarness("exact-text-fallback");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Keyboard text" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const typing = yield* manager
          .act(
            owner.controllerId,
            { actions: [{ type: "type", text: "ASCII fallback ->" }] },
            desktop.id,
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(250));
        yield* Fiber.join(typing);

        const calls = yield* Ref.get(fallbackHarness.calls);
        assert.isTrue(calls.some((call) => call.startsWith("key:")));
      }).pipe(Effect.provide(fallbackHarness.layer));

      const unsafeFallbackHarness = yield* managerHarness("unsafe-unicode-fallback");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "No exact text target" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const error = yield* manager
          .act(
            owner.controllerId,
            { actions: [{ type: "type", text: "That’s exact → 😀" }] },
            desktop.id,
          )
          .pipe(Effect.flip);
        assert.deepInclude(ComputerUse.toComputerAutomationFailure(error), {
          code: "exact-text-unavailable",
          category: "unsupported-operation",
          actionIndex: 0,
          completedActionCount: 0,
          field: "actions[0].text",
        });
        assert.isFalse(
          (yield* Ref.get(unsafeFallbackHarness.calls)).some((call) => call.startsWith("key:")),
        );
      }).pipe(Effect.provide(unsafeFallbackHarness.layer));
    }),
  );

  it.effect("dwells between Agent desktop pointer button transitions", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("pointer-dwell", { captureAvailable: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Pointer dwell" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const snapshot = yield* manager.snapshot(
          owner.controllerId,
          {
            screenshot: { maxWidth: 100, maxHeight: 100 },
            includeAccessibility: false,
          },
          desktop.id,
        );
        assert.isDefined(snapshot.frame);

        const clicking = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                {
                  type: "click",
                  frameId: snapshot.frame.id,
                  x: 50,
                  y: 50,
                  count: 2,
                },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(40));
        yield* Fiber.join(clicking);

        const buttonEvents = (yield* Ref.get(harness.inputEvents))
          .flat()
          .filter((event) => event.type === "btn");
        assert.deepEqual(
          buttonEvents.map((event) => event.data.down),
          [true, false, true, false],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("releases a transient chord when keyboard typing fails", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("failed-key-chord", { failSendKeyOnce: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Failed key chord" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        const error = yield* manager
          .act(owner.controllerId, { actions: [{ type: "type", text: "a" }] }, desktop.id)
          .pipe(Effect.flip);

        assert.deepInclude(ComputerUse.toComputerAutomationFailure(error), {
          code: "input-injection-failed",
          category: "input-injection",
          actionIndex: 0,
          completedActionCount: 0,
          cleanup: { keys: "released", buttons: "not-needed" },
        });
        const releasedKeys = (yield* Ref.get(harness.inputEvents))
          .flat()
          .flatMap((event) =>
            event.type === "key" && !event.data.down ? [event.data.key.data] : [],
          );
        assert.deepEqual(releasedKeys, ["a"]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not replay text after an uncertain accessibility insertion", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("uncertain-text-insertion", {
        accessibility: true,
        textInsertionResponse:
          '{"ok":false,"code":"accessibility-insertion-failed","detail":"insertion stopped after a prefix"}',
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Uncertain insertion" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        const error = yield* manager
          .act(
            owner.controllerId,
            { actions: [{ type: "type", text: "do not duplicate this text" }] },
            desktop.id,
          )
          .pipe(Effect.flip);

        assert.deepInclude(ComputerUse.toComputerAutomationFailure(error), {
          code: "input-injection-failed",
          category: "input-injection",
          actionIndex: 0,
          completedActionCount: 0,
          field: "actions[0].text",
          phase: "execution",
          cleanup: { keys: "not-needed", buttons: "not-needed" },
        });
        const calls = yield* Ref.get(harness.calls);
        assert.isFalse(calls.some((call) => call.startsWith("key:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reports exact invalid key details and releases held input", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("invalid-key");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Invalid key" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        const error = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                { type: "key_down", key: "Alt" },
                { type: "press", key: "Hyper" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.flip);

        assert.deepEqual(ComputerUse.toComputerAutomationFailure(error), {
          code: "invalid-key-name",
          category: "invalid-input",
          message: "The action contains an unsupported or duplicate key name.",
          actionIndex: 1,
          completedActionCount: 1,
          field: "actions[1].key",
          received: "Hyper",
          expected: ["named key", "single printable ASCII character"],
          phase: "validation",
          cleanup: { keys: "released", buttons: "not-needed" },
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("bounds accessibility helpers for tab-heavy text", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("tab-heavy-text", { accessibility: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Tab-heavy text" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const typing = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [{ type: "type", text: Array.from({ length: 40 }, () => "x").join("\t") }],
            },
            desktop.id,
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(250));
        yield* Fiber.join(typing);

        const calls = yield* Ref.get(harness.calls);
        assert.isFalse(calls.some((call) => call.includes("insert-text")));
        assert.isTrue(calls.some((call) => call.startsWith("key:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reports invalid modifier and duplicate hotkey fields", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("chord-validation");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Chord validation" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        const modifierError = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                {
                  type: "press",
                  key: "N",
                  modifiers: ["Control", "Hyper"],
                },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.flip);
        assert.deepInclude(ComputerUse.toComputerAutomationFailure(modifierError), {
          code: "invalid-key-name",
          field: "actions[0].modifiers[1]",
          received: "Hyper",
          phase: "validation",
          cleanup: { keys: "not-needed", buttons: "not-needed" },
        });

        const duplicateError = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [{ type: "hotkey", keys: ["Control", "Ctrl", "N"] }],
            },
            desktop.id,
          )
          .pipe(Effect.flip);
        assert.deepInclude(ComputerUse.toComputerAutomationFailure(duplicateError), {
          code: "invalid-key-name",
          field: "actions[0].keys[1]",
          received: "Ctrl",
          phase: "validation",
          cleanup: { keys: "not-needed", buttons: "not-needed" },
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("preserves cleanup details after a later validation failure", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("stale-frame-cleanup");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Stale frame" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        const error = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                { type: "key_down", key: "Alt" },
                { type: "click", frameId: "missing-frame", x: 10, y: 20 },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.flip);

        assert.deepEqual(ComputerUse.toComputerAutomationFailure(error), {
          code: "stale-frame",
          category: "stale-target",
          message: "The referenced screenshot frame is stale; capture a new observation.",
          actionIndex: 1,
          completedActionCount: 1,
          field: "actions[1].frameId",
          received: "missing-frame",
          phase: "validation",
          cleanup: { keys: "released", buttons: "not-needed" },
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("retries held input cleanup after an injection failure", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("retry-input-release", {
        failInputReleaseOnce: true,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Retry input release" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        const error = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                { type: "key_down", key: "Alt" },
                { type: "press", key: "Hyper" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.flip);
        assert.deepInclude(ComputerUse.toComputerAutomationFailure(error), {
          cleanup: { keys: "release-failed", buttons: "not-needed" },
        });

        yield* manager.release(owner.controllerId, desktop.id);
        const inputCalls = (yield* Ref.get(harness.calls)).filter((call) =>
          call.startsWith("input:"),
        );
        assert.lengthOf(inputCalls, 3);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("retains shared modifier qcodes until every logical key is released", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("shared-modifier");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Shared modifier" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        yield* manager.act(
          owner.controllerId,
          {
            actions: [
              { type: "key_down", key: "Shift" },
              { type: "key_down", key: "A" },
              { type: "key_up", key: "A" },
              { type: "key_up", key: "Shift" },
              { type: "key_down", key: "A" },
              { type: "key_down", key: "Shift" },
              { type: "key_up", key: "A" },
              { type: "key_up", key: "Shift" },
            ],
          },
          desktop.id,
        );

        const transitions = (yield* Ref.get(harness.inputEvents)).map((events) =>
          events.map((event) => {
            if (event.type !== "key") throw new Error("expected a key transition");
            return `${event.data.key.data}:${event.data.down ? "down" : "up"}`;
          }),
        );
        assert.deepEqual(transitions, [
          ["shift:down"],
          ["a:down"],
          ["a:up"],
          ["shift:up"],
          ["shift:down", "a:down"],
          ["a:up"],
          ["shift:up"],
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not release explicitly held keys from transient chords", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("transient-held-key");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Transient held key" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        yield* manager.act(
          owner.controllerId,
          {
            actions: [
              { type: "key_down", key: "Alt" },
              { type: "hotkey", keys: ["Alt", "Tab"] },
              { type: "press", key: "Tab", modifiers: ["Alt"] },
              { type: "key_up", key: "Alt" },
            ],
          },
          desktop.id,
        );

        const keyCalls = (yield* Ref.get(harness.calls)).filter((call) => call.startsWith("key:"));
        assert.lengthOf(keyCalls, 2);
        assert.isTrue(keyCalls.every((call) => call.endsWith(":tab")));
        const transitions = (yield* Ref.get(harness.inputEvents)).map((events) =>
          events.map((event) => {
            if (event.type !== "key") throw new Error("expected a key transition");
            return `${event.data.key.data}:${event.data.down ? "down" : "up"}`;
          }),
        );
        assert.deepEqual(transitions, [["alt:down"], ["alt:up"]]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("lets a human watch and explicitly take over one desktop", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("human-access");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Supervised" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });

        const humanControllerId = "human:session-1";
        const watched = yield* manager.requestHumanView(owner, humanControllerId, desktop.id);
        assert.equal(watched.permission, "view-only");
        assert.equal(
          (yield* manager.status(humanControllerId, desktop.id)).permission,
          "view-only",
        );

        const viewOnlyError = yield* manager
          .act(humanControllerId, { actions: [{ type: "press", key: "Enter" }] }, desktop.id)
          .pipe(Effect.flip);
        assert.equal(ComputerUse.toComputerAutomationFailure(viewOnlyError).code, "desktop-busy");

        yield* manager.requestHumanControl(owner, humanControllerId, desktop.id);
        yield* manager.act(
          humanControllerId,
          { actions: [{ type: "press", key: "Enter" }] },
          desktop.id,
        );
        const displacedAgentError = yield* manager
          .act(owner.controllerId, { actions: [{ type: "press", key: "Enter" }] }, desktop.id)
          .pipe(Effect.flip);
        assert.equal(
          ComputerUse.toComputerAutomationFailure(displacedAgentError).code,
          "desktop-busy",
        );

        yield* manager.release(humanControllerId, desktop.id);
        const releasedError = yield* manager
          .status(humanControllerId, desktop.id)
          .pipe(Effect.flip);
        assert.equal(
          ComputerUse.toComputerAutomationFailure(releasedError).code,
          "desktop-target-mismatch",
        );

        yield* manager.requestHumanControl(owner, humanControllerId, desktop.id);
        yield* TestClock.adjust(Duration.seconds(31));
        assert.equal(
          (yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id }))
            .permission,
          "granted",
        );
        const expiredError = yield* manager.status(humanControllerId, desktop.id).pipe(Effect.flip);
        assert.equal(
          ComputerUse.toComputerAutomationFailure(expiredError).code,
          "desktop-target-mismatch",
        );

        const calls = yield* Ref.get(harness.calls);
        assert.isTrue(calls.some((call) => call.startsWith("key:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("runs guest work and returns per-desktop accounting", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("operations");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Operations" });
        const command = yield* manager.command(owner, {
          desktopId: desktop.id,
          executable: "/usr/bin/printf",
          arguments: ["ok"],
        });
        assert.equal(command.stdout, "ok\n");
        assert.equal(command.exitCode, 0);

        const file = yield* manager.readFile(owner, {
          desktopId: desktop.id,
          path: "/tmp/result",
        });
        assert.equal(file.data, "hello");
        assert.equal(
          (yield* manager.writeFile(owner, {
            desktopId: desktop.id,
            path: "/tmp/result",
            data: "updated",
          })).bytesWritten,
          7,
        );

        const inspected = yield* manager.inspect(owner, {
          desktopId: desktop.id,
          includeConnections: true,
        });
        assert.equal(inspected.resources?.network.privateAddresses[0], "10.0.2.15");
        assert.equal(inspected.resources?.network.connections[0]?.processName, "chromium");
        assert.equal(inspected.resources?.diskVirtualBytes, 2);

        const capture = yield* manager.capturePackets(owner, {
          desktopId: desktop.id,
          durationMs: 1_000,
          maxBytes: 1_024,
        });
        assert.equal(capture.path, "/captures/network.pcap");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("writes multi-megabyte base64 without overflowing the regex stack", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("large-base64");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Large base64" });
        const bytes = 4_609_024;
        const result = yield* manager.writeFile(owner, {
          desktopId: desktop.id,
          path: "/tmp/archive.tar",
          data: Buffer.alloc(bytes, 0xa5).toString("base64"),
          encoding: "base64",
        });

        assert.equal(result.bytesWritten, bytes);
        assert.include(
          yield* Ref.get(harness.calls),
          `write:${desktop.id}:/tmp/archive.tar:${bytes}`,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not park a desktop while a guest operation is active", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("active-operation");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Long operation" });
        const operation = yield* manager
          .command(owner, {
            desktopId: desktop.id,
            executable: "/usr/bin/t3-block",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(harness.commandStarted);

        yield* TestClock.adjust(Duration.minutes(11));
        yield* Effect.yieldNow;
        assert.isFalse((yield* Ref.get(harness.calls)).some((call) => call.startsWith("park:")));

        yield* Deferred.succeed(harness.releaseCommand, undefined);
        yield* Fiber.join(operation);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.minutes(11));
        yield* Deferred.await(harness.desktopParked);

        const calls = yield* Ref.get(harness.calls);
        assert.isTrue(calls.some((call) => call.startsWith("park:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it("parses IPv4 and IPv6 socket ownership", () => {
    assert.deepEqual(
      AgentDesktopManager.parseAgentDesktopConnections(
        "tcp",
        'ESTAB 0 0 [fd00::2]:443 [fd00::3]:50000 users:(("server",pid=123,fd=4))',
      ),
      [
        {
          protocol: "tcp",
          localAddress: "fd00::2",
          localPort: 443,
          remoteAddress: "fd00::3",
          remotePort: 50_000,
          state: "estab",
          processId: 123,
          processName: "server",
        },
      ],
    );
  });
});

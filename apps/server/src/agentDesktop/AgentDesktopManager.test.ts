import * as Scheduler from "effect/Scheduler";
import * as Tracer from "effect/Tracer";
import * as Queue from "effect/Queue";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import {
  AgentDesktopOwner,
  ComputerAutomationActionResult,
  ComputerAutomationStatus,
  EnvironmentId,
  ThreadId,
  AgentDesktopId,
} from "@t3tools/contracts";
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

import * as AgentDesktopEnvironment from "./AgentDesktopEnvironment.ts";
import * as ComputerUse from "../computer/ComputerAutomationFailure.ts";
import * as AgentDesktopManager from "./AgentDesktopManager.ts";
import * as QemuAgentDesktop from "./QemuAgentDesktop.ts";

const decodeEvidenceActionResult = Schema.decodeUnknownEffect(ComputerAutomationActionResult);
const decodeEvidenceStatus = Schema.decodeUnknownEffect(ComputerAutomationStatus);

const owner = Schema.decodeSync(AgentDesktopOwner)({
  environmentId: Schema.decodeSync(EnvironmentId)("environment-1"),
  threadId: Schema.decodeSync(ThreadId)("thread-1"),
  controllerId: "controller-1",
});

const decodeAgentDesktopId = Schema.decodeSync(AgentDesktopId);
const decodeAgentDesktopOwner = Schema.decodeEffect(AgentDesktopOwner);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeRecordedAccessibilityLocator = Schema.decodeSync(
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
    const commandEnvironment = yield* Ref.make<ReadonlyArray<string>>([]);
    const commandStarted = yield* Deferred.make<void>();
    const releaseCommand = yield* Deferred.make<void>();
    const desktopParked = yield* Deferred.make<void>();
    const inputReleaseFailed = yield* Ref.make(false);
    const sendKeyFailed = yield* Ref.make(false);
    const wheelAcknowledgementLost = yield* Ref.make(false);
    const captureEnabled = yield* Ref.make(captureAvailable);
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
        Ref.get(captureEnabled).pipe(
          Effect.flatMap((enabled) =>
            enabled
              ? Effect.succeed({
                  kind: "bitmap" as const,
                  path: "/capture.raw",
                  data: new Uint8Array(100 * 100 * 4).fill(255),
                  width: 100,
                  height: 100,
                })
              : new QemuAgentDesktop.QemuAgentDesktopError({
                  code: "guest-disconnected",
                  operation: "capture",
                  detail: "the test virtual display disconnected",
                }),
          ),
        ),
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
          Effect.andThen(Ref.set(commandEnvironment, input.environment ?? [])),
          Effect.andThen(execute),
          Effect.andThen(
            argumentsValue.includes("wheel") &&
              argumentsValue.slice(-2).some((value) => value !== "0")
              ? Ref.get(wheelAcknowledgementLost).pipe(
                  Effect.flatMap((lost) =>
                    lost
                      ? new QemuAgentDesktop.QemuAgentDesktopError({
                          code: "internal-error",
                          operation: "guest-exec",
                          detail: "input may have been injected before acknowledgement was lost",
                        })
                      : Effect.void,
                  ),
                )
              : Effect.void,
          ),
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
    return {
      calls,
      wheelAcknowledgementLost,
      captureEnabled,
      commandEnvironment,
      commandStarted,
      desktopParked,
      inputEvents,
      releaseCommand,
      service,
    };
  });

/** Creates an isolated manager layer backed by one fake hypervisor. */
const managerHarness = (
  name: string,
  options?: {
    readonly accessibility?: boolean;
    readonly afterGuestProcess?: (
      input: Parameters<QemuAgentDesktop.QemuAgentDesktop["Service"]["executeGuestProcess"]>[1],
    ) => Effect.Effect<void>;
    readonly beforePersistContent?: (content: string) => Effect.Effect<void>;
    readonly acceleratedGraphics?: boolean;
    readonly failInputReleaseOnce?: boolean;
    readonly failSendKeyOnce?: boolean;
    readonly inputHelper?: boolean;
    readonly textInsertionResponse?: string;
    readonly activationResponse?: string;
    readonly initialDocument?: string;
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
    if (options?.initialDocument !== undefined) {
      yield* fileSystem.writeFileString(
        `${agentDesktopsDir}/desktops.json`,
        options.initialDocument,
      );
    }
    const accessibilityResource = `${agentDesktopsDir}/agent-desktop-accessibility.js`;
    if (accessibility) yield* fileSystem.writeFileString(accessibilityResource, "test helper");
    const inputHelperResource = `${agentDesktopsDir}/input-helper.py`;
    if (options?.inputHelper === true) {
      yield* fileSystem.writeFileString(inputHelperResource, "test input helper");
    }
    const environmentLayer = Layer.effect(
      AgentDesktopEnvironment.AgentDesktopEnvironment,
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return AgentDesktopEnvironment.AgentDesktopEnvironment.of({
          path,
          platform: "linux",
          processArch: "x64",
          agentDesktopsDir,
          agentDesktopBaseImage: { _tag: "None" },
          resolveResourcePathCandidates: (resource: string) =>
            resource === "agent-desktop/accessibility.js" && accessibility
              ? [accessibilityResource]
              : resource === "agent-desktop/input-helper.py" && options?.inputHelper === true
                ? [inputHelperResource]
                : [],
        } as unknown as AgentDesktopEnvironment.AgentDesktopEnvironment["Service"]);
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      environmentLayer,
      Layer.succeed(QemuAgentDesktop.QemuAgentDesktop, {
        ...qemu.service,
        executeGuestProcess: (id, input) =>
          qemu.service
            .executeGuestProcess(id, input)
            .pipe(Effect.tap(() => options?.afterGuestProcess?.(input) ?? Effect.void)),
      }),
    );
    return {
      files: fileSystem,
      directory: agentDesktopsDir,
      calls: qemu.calls,
      wheelAcknowledgementLost: qemu.wheelAcknowledgementLost,
      captureEnabled: qemu.captureEnabled,
      commandEnvironment: qemu.commandEnvironment,
      commandStarted: qemu.commandStarted,
      desktopParked: qemu.desktopParked,
      inputEvents: qemu.inputEvents,
      releaseCommand: qemu.releaseCommand,
      layer: AgentDesktopManager.layer.pipe(
        Layer.provide(
          Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fileSystem,
              writeFileString: (path, content, optionsValue) =>
                (path === `${agentDesktopsDir}/desktops.json.tmp`
                  ? (options?.beforePersistContent?.(content) ?? Effect.void)
                  : Effect.void
                ).pipe(Effect.andThen(fileSystem.writeFileString(path, content, optionsValue))),
            }),
          ),
        ),
        Layer.provide(dependencies),
      ),
    };
  }).pipe(Effect.provide(NodeServices.layer));

describe("AgentDesktopManager", () => {
  it.effect("reclaims an idle desktop after its controller changes", () =>
    Effect.gen(function* () {
      const desktopId = decodeAgentDesktopId("agent-preserved-before-restart");
      const harness = yield* managerHarness("controller-restart", {
        initialDocument: encodeUnknownJson({
          version: 1,
          desktops: [
            {
              id: desktopId,
              label: "Persistent workspace",
              owner,
              state: "parked",
              resources: {
                cpuCount: 4,
                memoryBytes: 4 * 1024 ** 3,
                diskVirtualBytes: 64 * 1024 ** 3,
                audio: false,
              },
              graphicsBackend: "virtio-gpu-2d",
              requirements: { retention: "automatic" },
              routes: [],
              createdAt: "2026-08-01T00:00:00.000Z",
              lastActiveAt: "2026-08-01T01:00:00.000Z",
              recoverableUntil: null,
            },
          ],
        }),
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        assert.deepEqual(
          (yield* manager.list).desktops.map((desktop) => desktop.id),
          [desktopId],
        );
        const replacementOwner = yield* decodeAgentDesktopOwner({
          ...owner,
          controllerId: "controller-after-restart",
        });

        const reclaimed = yield* manager.acquire(replacementOwner, {
          desktopId,
          label: "Recovered workspace",
          requirements: { retention: "preserve" },
        });

        assert.equal(reclaimed.id, desktopId);
        assert.equal(reclaimed.label, "Recovered workspace");
        assert.equal(reclaimed.owner.controllerId, replacementOwner.controllerId);
        assert.equal(reclaimed.retention, "preserve");
        assert.lengthOf((yield* manager.list).desktops, 1);

        const foreignOwner = yield* decodeAgentDesktopOwner({
          ...replacementOwner,
          threadId: "another-thread",
        });
        const error = yield* manager.acquire(foreignOwner, { desktopId }).pipe(Effect.flip);
        assert.equal(
          ComputerUse.toComputerAutomationFailure(error).code,
          "desktop-target-mismatch",
        );
        assert.isFalse((yield* Ref.get(harness.calls)).some((call) => call.startsWith("create:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reuses same-thread desktops without stealing active control", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("same-thread-reuse");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Shared thread workspace" });
        const secondOwner = yield* decodeAgentDesktopOwner({
          ...owner,
          controllerId: "controller-2",
        });
        const automaticallyReused = yield* manager.acquire(secondOwner, {});
        assert.equal(automaticallyReused.id, desktop.id);

        yield* manager.requestControl(secondOwner, {
          kind: "agent",
          desktopId: desktop.id,
        });
        const thirdOwner = yield* decodeAgentDesktopOwner({
          ...owner,
          controllerId: "controller-3",
        });
        const parallelDesktop = yield* manager.acquire(thirdOwner, {});
        assert.notEqual(parallelDesktop.id, desktop.id);

        const busyError = yield* manager
          .acquire(thirdOwner, { desktopId: desktop.id })
          .pipe(Effect.flip);
        assert.equal(ComputerUse.toComputerAutomationFailure(busyError).code, "desktop-busy");

        yield* manager.release(secondOwner.controllerId, desktop.id);
        const operation = yield* manager
          .command(secondOwner, {
            desktopId: desktop.id,
            executable: "/usr/bin/t3-block",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(harness.commandStarted);
        const activeOperationError = yield* manager
          .acquire(thirdOwner, { desktopId: desktop.id })
          .pipe(Effect.flip);
        assert.equal(
          ComputerUse.toComputerAutomationFailure(activeOperationError).code,
          "desktop-busy",
        );
        yield* Deferred.succeed(harness.releaseCommand, undefined);
        yield* Fiber.join(operation);

        const reclaimed = yield* manager.acquire(thirdOwner, { desktopId: desktop.id });
        assert.equal(reclaimed.id, desktop.id);
        assert.equal(reclaimed.owner.controllerId, thirdOwner.controllerId);

        const calls = yield* Ref.get(harness.calls);
        assert.equal(calls.filter((call) => call.startsWith("create:")).length, 2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

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

  it.effect("injects discrete wheel ticks through QEMU", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("wheel-ticks", { captureAvailable: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Wheel input" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const snapshot = yield* manager.snapshot(
          owner.controllerId,
          { includeAccessibility: false },
          desktop.id,
        );
        if (snapshot.frame === undefined) throw new Error("snapshot did not return a frame");
        const result = yield* manager.act(
          owner.controllerId,
          {
            actions: [
              {
                type: "wheel",
                frameId: snapshot.frame.id,
                x: 50,
                y: 50,
                verticalTicks: -7,
              },
            ],
          },
          desktop.id,
        );

        assert.deepEqual(result, [
          { index: 0, type: "wheel", horizontalTicks: 0, verticalTicks: -7 },
        ]);
        const injected = (yield* Ref.get(harness.inputEvents)).flat();
        assert.equal(
          injected.filter(
            (event) => event.type === "btn" && event.data.button === "wheel-up" && event.data.down,
          ).length,
          7,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reports and recovers Agent desktop capture health", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("capture-health", { captureAvailable: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Capture health" });
        yield* manager.requestView(owner, { kind: "agent", desktopId: desktop.id });

        assert.equal(
          (yield* manager.status(owner.controllerId, desktop.id)).captureHealth?.[0]?.state,
          "untested",
        );
        yield* manager.snapshot(owner.controllerId, { includeAccessibility: false }, desktop.id);
        assert.equal(
          (yield* manager.status(owner.controllerId, desktop.id)).captureHealth?.[0]?.state,
          "healthy",
        );

        yield* Ref.set(harness.captureEnabled, false);
        yield* manager
          .snapshot(owner.controllerId, { includeAccessibility: false }, desktop.id)
          .pipe(Effect.flip);
        const degraded = yield* manager.status(owner.controllerId, desktop.id);
        assert.deepInclude(degraded.captureHealth?.[0], {
          state: "degraded",
          consecutiveFailures: 1,
          lastFailure: {
            code: "guest-disconnected",
            category: "resource",
            message: "The Agent desktop guest is not currently responding.",
            backendCode: "guest-disconnected",
            detail: "the test virtual display disconnected",
          },
        });

        yield* Ref.set(harness.captureEnabled, true);
        yield* manager.snapshot(owner.controllerId, { includeAccessibility: false }, desktop.id);
        const recovered = yield* manager.status(owner.controllerId, desktop.id);
        assert.equal(recovered.captureHealth?.[0]?.state, "healthy");
        assert.equal(recovered.captureHealth?.[0]?.consecutiveFailures, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("injects horizontal wheel ticks through the guest input bridge", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("horizontal-wheel", {
        captureAvailable: true,
        inputHelper: true,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Horizontal wheel input" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const snapshot = yield* manager.snapshot(
          owner.controllerId,
          { includeAccessibility: false },
          desktop.id,
        );
        if (snapshot.frame === undefined) throw new Error("snapshot did not return a frame");
        const result = yield* manager.act(
          owner.controllerId,
          {
            actions: [
              {
                type: "wheel",
                frameId: snapshot.frame.id,
                x: 50,
                y: 50,
                horizontalTicks: 4,
                verticalTicks: -2,
              },
            ],
          },
          desktop.id,
        );

        assert.deepEqual(result, [
          { index: 0, type: "wheel", horizontalTicks: 4, verticalTicks: -2 },
        ]);
        const injected = (yield* Ref.get(harness.inputEvents)).flat();
        assert.isFalse(
          injected.some(
            (event) =>
              event.type === "btn" &&
              (event.data.button === "wheel-left" || event.data.button === "wheel-right"),
          ),
        );
        assert.include(
          yield* Ref.get(harness.calls),
          `exec:${desktop.id}:/usr/bin/python:/run/t3-agent-input/input-helper.py wheel 4 -2`,
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
          verification: "exact",
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
        const results = yield* Fiber.join(typing);

        assert.deepInclude(results[0], {
          type: "type",
          requestedCodePoints: Array.from("ASCII fallback ->").length,
          acceptedCodePoints: Array.from("ASCII fallback ->").length,
          confirmedCodePoints: 0,
          verification: "unavailable",
          delivery: "key-events",
          focusedEditable: false,
        });

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

  it.effect("rejects a later invalid key before holding input", () =>
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
          completedActionCount: 0,
          field: "actions[1].key",
          received: "Hyper",
          expected: ["named key", "single printable ASCII character"],
          phase: "validation",
          cleanup: { keys: "not-needed", buttons: "not-needed" },
        });
        const calls = yield* Ref.get(harness.calls);
        assert.isFalse(calls.some((call) => call.startsWith("input:") || call.startsWith("key:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("inserts literal tabs through one editable target", () =>
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
        assert.equal(calls.filter((call) => call.includes("insert-text")).length, 1);
        assert.isFalse(calls.some((call) => call.startsWith("key:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("rejects literal Newline and Tab without sending fallback input", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("literal-control-text");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, {});
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        for (const text of ["prefix\nnext line", "prefix\tfield"]) {
          const error = yield* manager
            .act(
              owner.controllerId,
              {
                actions: [{ type: "type", text }],
              },
              desktop.id,
            )
            .pipe(Effect.flip);
          assert.equal(
            ComputerUse.toComputerAutomationFailure(error).code,
            "exact-text-unavailable",
          );
        }
        assert.isFalse((yield* Ref.get(harness.calls)).some((call) => call.startsWith("key:")));
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

  it.effect("preflights later frame references before holding input", () =>
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
          completedActionCount: 0,
          field: "actions[1].frameId",
          received: "missing-frame",
          phase: "validation",
          cleanup: { keys: "not-needed", buttons: "not-needed" },
        });
        const calls = yield* Ref.get(harness.calls);
        assert.isFalse(calls.some((call) => call.startsWith("input:") || call.startsWith("key:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("retries held input cleanup after an injection failure", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("retry-input-release", {
        failInputReleaseOnce: true,
        failSendKeyOnce: true,
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
                { type: "press", key: "A" },
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

it.effect("never replays ambiguous wheel input and repairs the bridge for the next action", () =>
  Effect.gen(function* () {
    const harness = yield* managerHarness("wheel-acknowledgement", { inputHelper: true });
    yield* Effect.gen(function* () {
      const manager = yield* AgentDesktopManager.AgentDesktopManager;
      const desktop = yield* manager.acquire(owner, { label: "Wheel acknowledgement" });
      yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
      yield* manager.act(
        owner.controllerId,
        { actions: [{ type: "wheel", horizontalTicks: 1 }] },
        desktop.id,
      );
      yield* Ref.set(harness.wheelAcknowledgementLost, true);
      const failure = yield* manager
        .act(
          owner.controllerId,
          {
            actions: [{ type: "wheel", horizontalTicks: 4, verticalTicks: -2 }],
          },
          desktop.id,
        )
        .pipe(Effect.flip);
      assert.include(
        ComputerUse.toComputerAutomationFailure(failure).detail!,
        "acknowledgement was lost",
      );
      const failedCalls = yield* Ref.get(harness.calls);
      assert.equal(
        failedCalls.filter((call) => call.endsWith("input-helper.py wheel 4 -2")).length,
        1,
      );
      assert.equal(
        failedCalls.filter((call) => call.endsWith("restart t3-agent-input.service")).length,
        1,
      );
      yield* Ref.set(harness.wheelAcknowledgementLost, false);
      const result = yield* manager.act(
        owner.controllerId,
        { actions: [{ type: "wheel", horizontalTicks: -3, verticalTicks: 2 }] },
        desktop.id,
      );
      assert.deepEqual(result, [
        { index: 0, type: "wheel", horizontalTicks: -3, verticalTicks: 2 },
      ]);
      assert.equal(
        (yield* Ref.get(harness.calls)).filter((call) =>
          call.endsWith("restart t3-agent-input.service"),
        ).length,
        2,
      );
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
        width: 30,
        height: 40,
        toDesktopLogical: {
          scaleX: 1,
          scaleY: 1,
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

describe("shared Agent observation lifecycle", () => {
  it.effect.each(["viewer", "controller"] as const)(
    "releases %s first without revoking the remaining lease",
    (first) =>
      Effect.gen(function* () {
        const harness = yield* managerHarness(`shared-release-${first}`, {
          captureAvailable: true,
        });
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const desktop = yield* manager.acquire(owner, {});
          const viewer = { ...owner, controllerId: "durable-watcher" };
          yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
          yield* manager.requestView(viewer, { kind: "agent", desktopId: desktop.id });
          const denied = yield* manager
            .act(viewer.controllerId, { actions: [{ type: "press", key: "Enter" }] }, desktop.id)
            .pipe(Effect.flip);
          assert.equal(ComputerUse.toComputerAutomationFailure(denied).code, "desktop-busy");
          const released = first === "viewer" ? viewer : owner;
          const remaining = first === "viewer" ? owner : viewer;
          yield* manager.release(released.controllerId, desktop.id);
          assert.equal(
            (yield* manager.status(remaining.controllerId, desktop.id)).permission,
            first === "viewer" ? "granted" : "view-only",
          );
          assert.isDefined(
            (yield* manager.snapshot(
              remaining.controllerId,
              { includeAccessibility: false },
              desktop.id,
            )).frame,
          );
          yield* manager.release(remaining.controllerId, desktop.id);
          assert.equal(
            (yield* manager.status(owner.controllerId, desktop.id)).permission,
            "remembered",
          );
          yield* manager.requestView(viewer, { kind: "agent", desktopId: desktop.id });
          assert.equal(
            (yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id }))
              .permission,
            "granted",
          );
          assert.equal(
            (yield* manager.status(viewer.controllerId, desktop.id)).permission,
            "view-only",
          );
          const foreignEnvironment = {
            ...viewer,
            environmentId: EnvironmentId.make("foreign-environment"),
          };
          assert.equal(
            ComputerUse.toComputerAutomationFailure(
              yield* manager
                .requestView(foreignEnvironment, { kind: "agent", desktopId: desktop.id })
                .pipe(Effect.flip),
            ).code,
            "desktop-target-mismatch",
          );
          for (const region of [
            { displayId: "missing", x: 0, y: 0, width: 1, height: 1 },
            { displayId: "display-0", x: -1, y: 0, width: 1, height: 1 },
            { displayId: "display-0", x: 99, y: 0, width: 2, height: 1 },
          ]) {
            const error = yield* manager
              .snapshot(
                viewer.controllerId,
                {
                  includeAccessibility: false,
                  screenshot: { region: { coordinateSpace: "desktop-logical", ...region } },
                },
                desktop.id,
              )
              .pipe(Effect.flip);
            assert.equal(
              ComputerUse.toComputerAutomationFailure(error).code,
              region.displayId === "missing" ? "display-not-found" : "invalid-coordinate",
            );
          }
        }).pipe(Effect.provide(harness.layer));
      }),
  );
});

it.effect(
  "normalizes object and entry-list environments into the same exact guest invocation",
  () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("command-environment");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Command environment" });
        const environments = [
          { LANG: "C.UTF-8", VALUE: "literal $HOME=thing" },
          [
            { name: "LANG", value: "C.UTF-8" },
            { name: "VALUE", value: "literal $HOME=thing" },
          ],
        ];
        for (const environment of environments) {
          yield* manager.command(owner, {
            desktopId: desktop.id,
            executable: "/usr/bin/env",
            environment,
          });
          assert.deepEqual(yield* Ref.get(harness.commandEnvironment), [
            "LANG=C.UTF-8",
            "VALUE=literal $HOME=thing",
          ]);
        }
      }).pipe(Effect.provide(harness.layer));
    }),
);

describe("F049 evidence Agent queued input ownership", () => {
  it.effect.each(
    (["type"] as const).map(
      (type) =>
        [
          `${type} queued before takeover cannot inject after the human owns control`,
          { type },
        ] as const,
    ),
  )("%s", ([_title, { type }]) =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("queued-before-takeover", { accessibility: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Queued input ownership" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const admissions = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options),
              end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (options.name === "AgentDesktopManager.requireLease")
                Queue.offerUnsafe(admissions, exit);
            };
            return span;
          },
        });
        const first = yield* manager
          .act(owner.controllerId, { actions: [{ type: "wait", durationMs: 1000 }] }, desktop.id)
          .pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
        assert.strictEqual((yield* Queue.take(admissions))._tag, "Success");
        const takeover = yield* manager
          .requestHumanControl(owner, "human:f049", desktop.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const queued = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                { type: "wait", durationMs: 1000 },
                { type, text: "old" },
              ],
            },
            desktop.id,
          )
          .pipe(
            Effect.withTracer(tracer),
            Effect.result,
            Effect.forkChild({ startImmediately: true }),
          );
        assert.strictEqual((yield* Queue.take(admissions))._tag, "Success");
        yield* TestClock.adjust(Duration.millis(1000));
        yield* Fiber.join(first);
        const human = yield* Fiber.join(takeover);
        assert.strictEqual(human.permission, "granted");
        const before = yield* Ref.get(harness.calls);
        assert.isFalse(before.some((c) => c.includes("insert-text")));
        yield* TestClock.adjust(Duration.millis(1500));
        const outcome = yield* Fiber.join(queued);
        const after = yield* Ref.get(harness.calls);
        const injectedAfterTakeover = after
          .slice(before.length)
          .filter((c) => c.includes("insert-text"));
        assert.deepEqual(
          { outcome: outcome._tag, injectedAfterTakeover },
          { outcome: "Failure", injectedAfterTakeover: [] },
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );
  it.effect("fresh displaced-agent input refuses after takeover", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("fresh-after-takeover", { accessibility: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Fresh input ownership" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        yield* manager.requestHumanControl(owner, "human:f049", desktop.id);
        const outcome = yield* manager
          .act(owner.controllerId, { actions: [{ type: "type", text: "old" }] }, desktop.id)
          .pipe(Effect.result);
        assert.strictEqual(outcome._tag, "Failure");
        assert.isFalse((yield* Ref.get(harness.calls)).some((c) => c.includes("insert-text")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("review5 adversarial Manager", () => {
  it.effect.each(
    (["takeover", "release"] as const).map(
      (transition) =>
        [
          `${transition} cannot admit an old queued physical press afterward`,
          { transition },
        ] as const,
    ),
  )("%s", ([_title, { transition }]) =>
    Effect.gen(function* () {
      const harness = yield* managerHarness(`review5-${transition}`, { accessibility: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Review5 queued press" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const admissions = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options),
              end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (options.name === "AgentDesktopManager.requireLease")
                Queue.offerUnsafe(admissions, exit);
            };
            return span;
          },
        });
        const blocker = yield* manager
          .act(owner.controllerId, { actions: [{ type: "wait", durationMs: 1000 }] }, desktop.id)
          .pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
        assert.strictEqual((yield* Queue.take(admissions))._tag, "Success");
        const revoke = yield* (
          transition === "takeover"
            ? manager.requestHumanControl(owner, "human:review5", desktop.id)
            : manager.release(owner.controllerId, desktop.id)
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const queued = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                { type: "wait", durationMs: 1000 },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(
            Effect.withTracer(tracer),
            Effect.result,
            Effect.forkChild({ startImmediately: true }),
          );
        assert.strictEqual((yield* Queue.take(admissions))._tag, "Success");
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(blocker);
        yield* Fiber.join(revoke);
        const before = yield* Ref.get(harness.calls);
        assert.isFalse(before.some((x) => x.startsWith("key:")));
        yield* TestClock.adjust("1 second");
        const outcome = yield* Fiber.join(queued);
        const after = yield* Ref.get(harness.calls);
        assert.deepEqual(
          {
            outcome: outcome._tag,
            inputAfterRevocation: after.slice(before.length).filter((x) => x.startsWith("key:")),
          },
          { outcome: "Failure", inputAfterRevocation: [] },
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("F049 authority identity comparison", () => {
  it.effect.each(
    (["extra-viewer", "human-renewal", "same-agent-control"] as const).map(
      (mutation) =>
        [
          `${mutation} does not revoke the active controller's admitted work`,
          { mutation },
        ] as const,
    ),
  )("%s", ([_title, { mutation }]) =>
    Effect.gen(function* () {
      const harness = yield* managerHarness(`authority-${mutation}`);
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Identity control" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const human = "human:identity";
        if (mutation === "human-renewal")
          yield* manager.requestHumanControl(owner, human, desktop.id);
        const controller = mutation === "human-renewal" ? human : owner.controllerId;
        const admissions = yield* Queue.unbounded<void>();
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options),
              end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (options.name === "AgentDesktopManager.requireLease" && Exit.isSuccess(exit))
                Queue.offerUnsafe(admissions, undefined);
            };
            return span;
          },
        });
        const pending = yield* manager
          .act(
            controller,
            {
              actions: [
                { type: "wait", durationMs: 1000 },
                { type: "press", key: "ArrowRight" },
              ],
            },
            desktop.id,
          )
          .pipe(
            Effect.withTracer(tracer),
            Effect.result,
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Queue.take(admissions);
        if (mutation === "extra-viewer") yield* manager.requestHumanView(owner, human, desktop.id);
        else if (mutation === "human-renewal") yield* manager.status(human, desktop.id);
        else yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        yield* TestClock.adjust("1 second");
        const outcome = yield* Fiber.join(pending);
        assert.strictEqual(outcome._tag, "Success");
        assert.lengthOf(
          (yield* Ref.get(harness.calls)).filter(
            (call) => call.startsWith("key:") && call.endsWith(":right"),
          ),
          1,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );
  it.effect.each(
    (["takeover", "release"] as const).map(
      (transition) =>
        [
          `${transition} stops an admitted batch at its next action boundary`,
          { transition },
        ] as const,
    ),
  )("%s", ([_title, { transition }]) =>
    Effect.gen(function* () {
      const harness = yield* managerHarness(`action-boundary-${transition}`);
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Action boundary" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const admission = yield* Queue.unbounded<void>();
        const takeoverReady = yield* Queue.unbounded<void>();
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options),
              end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (options.name === "AgentDesktopManager.requireLease" && Exit.isSuccess(exit))
                Queue.offerUnsafe(admission, undefined);
              if (options.name === "AgentDesktopManager.ensureStarted" && Exit.isSuccess(exit))
                Queue.offerUnsafe(takeoverReady, undefined);
            };
            return span;
          },
        });
        const pending = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                { type: "wait", durationMs: 1000 },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(
            Effect.withTracer(tracer),
            Effect.result,
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Queue.take(admission);
        const revoke = yield* (
          transition === "takeover"
            ? manager.requestHumanControl(owner, "human:boundary", desktop.id)
            : manager.release(owner.controllerId, desktop.id)
        ).pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
        if (transition === "takeover") yield* Queue.take(takeoverReady);
        yield* TestClock.adjust("1 second");
        const outcome = yield* Fiber.join(pending);
        yield* Fiber.join(revoke);
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure")
          assert.deepInclude(ComputerUse.toComputerAutomationFailure(outcome.failure), {
            completedActionCount: 1,
            actionIndex: 1,
          });
        assert.isFalse((yield* Ref.get(harness.calls)).some((call) => call.startsWith("key:")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

it.effect(
  "F049 authority ABA: full Release and same-id reacquire cannot revive old admitted input",
  () =>
    Effect.gen(function* () {
      const releaseCommit = yield* Deferred.make<void>();
      const publishRelease = yield* Deferred.make<void>();
      let gateRelease = false;
      const harness = yield* managerHarness("same-id-reacquire", {
        beforePersistContent: (content) => {
          const document = JSON.parse(content) as { desktops: ReadonlyArray<{ state: string }> };
          return gateRelease && document.desktops.some((desktop) => desktop.state === "ready")
            ? Deferred.succeed(releaseCommit, undefined).pipe(
                Effect.andThen(Deferred.await(publishRelease)),
              )
            : Effect.void;
        },
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Same id reacquire" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const admissions = yield* Queue.unbounded<void>();
        const queuedDispatchOrRefusal = yield* Deferred.make<void>();
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options),
              end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (options.name === "AgentDesktopManager.requireLease" && Exit.isSuccess(exit))
                Queue.offerUnsafe(admissions, undefined);
            };
            return span;
          },
        });
        const queuedTracer = Tracer.make({
          span(options) {
            if (options.name === "AgentDesktopManager.executeAction")
              Deferred.doneUnsafe(queuedDispatchOrRefusal, Exit.void);
            return tracer.span(options);
          },
        });
        const blocker = yield* manager
          .act(owner.controllerId, { actions: [{ type: "wait", durationMs: 1000 }] }, desktop.id)
          .pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
        yield* Queue.take(admissions);
        gateRelease = true;
        const release = yield* manager
          .release(owner.controllerId, desktop.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const queued = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                { type: "wait", durationMs: 1000 },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(
            Effect.withTracer(queuedTracer),
            Effect.tapError(() => Deferred.succeed(queuedDispatchOrRefusal, undefined)),
            Effect.result,
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Queue.take(admissions);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(releaseCommit);
        yield* Deferred.await(queuedDispatchOrRefusal);
        gateRelease = false;
        yield* Deferred.succeed(publishRelease, undefined);
        yield* Fiber.join(blocker);
        yield* Fiber.join(release);
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        yield* TestClock.adjust("1 second");
        const old = yield* Fiber.join(queued);
        assert.strictEqual(old._tag, "Failure");
        assert.isFalse(
          (yield* Ref.get(harness.calls)).some(
            (call) => call.startsWith("key:") && call.endsWith(":left"),
          ),
        );
        yield* manager.act(
          owner.controllerId,
          { actions: [{ type: "press", key: "ArrowRight" }] },
          desktop.id,
        );
        assert.lengthOf(
          (yield* Ref.get(harness.calls)).filter(
            (call) => call.startsWith("key:") && call.endsWith(":right"),
          ),
          1,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each(["type"] as const)(
  "F049 authority accepted %s prefix keeps its completed count when the remaining batch is fenced",
  (type) =>
    Effect.gen(function* () {
      const accepted = yield* Deferred.make<void>();
      const deliver = yield* Deferred.make<void>();
      const ready = yield* Queue.unbounded<void>();
      const harness = yield* managerHarness(`accepted-prefix-${type}`, {
        accessibility: true,
        afterGuestProcess: (input) =>
          input.arguments?.includes("insert-text")
            ? Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Deferred.await(deliver)))
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Accepted prefix" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options),
              end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (options.name === "AgentDesktopManager.ensureStarted" && Exit.isSuccess(exit))
                Queue.offerUnsafe(ready, undefined);
            };
            return span;
          },
        });
        const pending = yield* manager
          .act(
            owner.controllerId,
            {
              actions: [
                { type, text: "abc" },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(accepted);
        const takeover = yield* manager
          .requestHumanControl(owner, "human:prefix", desktop.id)
          .pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
        yield* Queue.take(ready);
        yield* Deferred.succeed(deliver, undefined);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(pending);
        yield* Fiber.join(takeover);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          const failure = ComputerUse.toComputerAutomationFailure(result.failure);
          assert.deepInclude(failure, {
            actionIndex: 1,
            completedActionCount: 1,
            code: "request-cancelled",
          });
          const output = process.env.F049_PROBE_OUTPUT;
          if (output)
            yield* harness.files.writeFileString(
              `${output}/accepted-prefix-${type}.json`,
              JSON.stringify(
                {
                  inputType: type,
                  nativeAccepted: true,
                  completedActionCount: failure.completedActionCount,
                  outcome: result._tag,
                  failure,
                  detailedPrefixReceiptReturned: "actionResults" in result.failure,
                  limit:
                    "The existing failed-batch contract carries completed counts, not the earlier per-action text verification details.",
                },
                null,
                2,
              ),
            );
        }
        assert.isFalse((yield* Ref.get(harness.calls)).some((call) => call.startsWith("key:")));
        assert.lengthOf(
          (yield* Ref.get(harness.calls)).filter(
            (call) => call.startsWith("exec:") && call.includes("insert-text"),
          ),
          1,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each([
  ["late status", { renewal: "status", seconds: 31, expired: true }],
  ["timely status", { renewal: "status", seconds: 29, expired: false }],
] as const)(
  "F049 expiry continuity: %s cannot revive expired batch authority",
  ([_title, { renewal, seconds, expired }]) =>
    Effect.gen(function* () {
      const accepted = yield* Deferred.make<void>();
      const deliver = yield* Deferred.make<void>();
      const human = "human:expiry-continuity";
      const harness = yield* managerHarness(`expiry-continuity-${renewal}-${seconds}`, {
        accessibility: true,
        afterGuestProcess: (input) =>
          input.arguments?.includes("insert-text")
            ? Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Deferred.await(deliver)))
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Expiry continuity" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        yield* manager.requestHumanControl(owner, human, desktop.id);
        const pending = yield* manager
          .act(
            human,
            {
              actions: [
                { type: "type", text: "abc" },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(accepted);
        yield* TestClock.adjust(Duration.seconds(seconds));
        const heartbeat = yield* manager.status(human, desktop.id).pipe(Effect.result);
        yield* Deferred.succeed(deliver, undefined);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(pending);
        const calls = yield* Ref.get(harness.calls);
        const keys = calls.filter((call) => call.startsWith("key:"));
        const output = process.env.F049_PROBE_OUTPUT;
        if (output !== undefined)
          yield* harness.files.writeFileString(
            `${output}/expiry-${renewal}-${seconds}.json`,
            JSON.stringify({ renewal, seconds, expired, result, heartbeat, keys }, null, 2),
          );
        assert.strictEqual(result._tag, expired ? "Failure" : "Success");
        assert.strictEqual(heartbeat._tag, expired ? "Failure" : "Success");
        assert.strictEqual(keys.filter((call) => call.endsWith(":left")).length, expired ? 0 : 1);
      }).pipe(Effect.ensuring(Deferred.succeed(deliver, undefined)), Effect.provide(harness.layer));
    }),
);

it.effect.each((["view", "control"] as const).map((access) => [access] as const))(
  "F049 expiry continuity: explicit %s reacquisition does not revive the expired batch",
  ([access]) =>
    Effect.gen(function* () {
      const accepted = yield* Deferred.make<void>();
      const deliver = yield* Deferred.make<void>();
      const admission = yield* Queue.unbounded<void>();
      const human = "human:expiry-reacquisition";
      const harness = yield* managerHarness(`expiry-reacquisition-${access}`, {
        accessibility: true,
        afterGuestProcess: (input) =>
          input.arguments?.includes("insert-text")
            ? Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Deferred.await(deliver)))
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Expiry reacquisition" });
        yield* manager.requestHumanControl(owner, human, desktop.id);
        const pending = yield* manager
          .act(
            human,
            {
              actions: [
                { type: "type", text: "abc" },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(accepted);
        yield* TestClock.adjust("31 seconds");
        const tracer = Tracer.make({
          span(options) {
            if (
              options.name === "AgentDesktopManager.withInputTransition" ||
              options.name === "AgentDesktopManager.expireHumanLeases"
            )
              Queue.offerUnsafe(admission, undefined);
            return new Tracer.NativeSpan(options);
          },
        });
        const next = yield* (
          access === "view"
            ? manager.requestHumanView(owner, human, desktop.id)
            : manager.requestHumanControl(owner, human, desktop.id)
        ).pipe(
          Effect.withTracer(tracer),
          Effect.result,
          Effect.tap(() => Queue.offer(admission, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Queue.take(admission);
        yield* Deferred.succeed(deliver, undefined);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(pending);
        const reacquired = yield* Fiber.join(next);
        const fresh = yield* manager
          .act(human, { actions: [{ type: "press", key: "ArrowRight" }] }, desktop.id)
          .pipe(Effect.result);
        const keys = (yield* Ref.get(harness.calls)).filter((call) => call.startsWith("key:"));
        const output = process.env.F049_PROBE_OUTPUT;
        if (output !== undefined)
          yield* harness.files.writeFileString(
            `${output}/expiry-reacquire-${access}.json`,
            JSON.stringify({ access, result, reacquired, fresh, keys }, null, 2),
          );
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(reacquired._tag, "Success");
        if (reacquired._tag === "Success")
          assert.strictEqual(
            reacquired.success.permission,
            access === "control" ? "granted" : "view-only",
          );
        assert.strictEqual(fresh._tag, access === "control" ? "Success" : "Failure");
        assert.strictEqual(keys.filter((call) => call.endsWith(":left")).length, 0);
        assert.strictEqual(
          keys.filter((call) => call.endsWith(":right")).length,
          access === "control" ? 1 : 0,
        );
      }).pipe(Effect.ensuring(Deferred.succeed(deliver, undefined)), Effect.provide(harness.layer));
    }),
);

it.effect(
  "F049 expiry continuity: fresh input cannot renew an expired controller or revive old work",
  () =>
    Effect.gen(function* () {
      const accepted = yield* Deferred.make<void>();
      const deliver = yield* Deferred.make<void>();
      const admission = yield* Queue.unbounded<void>();
      const human = "human:expired-input";
      const harness = yield* managerHarness("expiry-fresh-input", {
        accessibility: true,
        afterGuestProcess: (input) =>
          input.arguments?.includes("insert-text")
            ? Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Deferred.await(deliver)))
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Expired input" });
        yield* manager.requestHumanControl(owner, human, desktop.id);
        const old = yield* manager
          .act(
            human,
            {
              actions: [
                { type: "type", text: "abc" },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(accepted);
        yield* TestClock.adjust("31 seconds");
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options),
              end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (options.name === "AgentDesktopManager.requireLease")
                Queue.offerUnsafe(admission, undefined);
            };
            return span;
          },
        });
        const fresh = yield* manager
          .act(human, { actions: [{ type: "press", key: "ArrowRight" }] }, desktop.id)
          .pipe(
            Effect.withTracer(tracer),
            Effect.result,
            Effect.tap(() => Queue.offer(admission, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Queue.take(admission);
        yield* Deferred.succeed(deliver, undefined);
        yield* TestClock.adjust("1 second");
        const oldResult = yield* Fiber.join(old);
        const freshResult = yield* Fiber.join(fresh);
        const keys = (yield* Ref.get(harness.calls)).filter((call) => call.startsWith("key:"));
        assert.strictEqual(oldResult._tag, "Failure");
        assert.strictEqual(freshResult._tag, "Failure");
        assert.lengthOf(keys, 0);
      }).pipe(Effect.ensuring(Deferred.succeed(deliver, undefined)), Effect.provide(harness.layer));
    }),
);

it.effect.each((["view", "control"] as const).map((access) => [access] as const))(
  "F049 expiry continuity: timely explicit %s preserves the already-admitted batch",
  ([access]) =>
    Effect.gen(function* () {
      const accepted = yield* Deferred.make<void>();
      const deliver = yield* Deferred.make<void>();
      const human = "human:timely-explicit";
      const harness = yield* managerHarness(`expiry-timely-explicit-${access}`, {
        accessibility: true,
        afterGuestProcess: (input) =>
          input.arguments?.includes("insert-text")
            ? Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Deferred.await(deliver)))
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Timely explicit renewal" });
        yield* manager.requestHumanControl(owner, human, desktop.id);
        const pending = yield* manager
          .act(
            human,
            {
              actions: [
                { type: "type", text: "abc" },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(accepted);
        yield* TestClock.adjust("29 seconds");
        const receipt = yield* access === "view"
          ? manager.requestHumanView(owner, human, desktop.id)
          : manager.requestHumanControl(owner, human, desktop.id);
        yield* TestClock.adjust("2 seconds");
        yield* Deferred.succeed(deliver, undefined);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(pending);
        assert.strictEqual(receipt.permission, "granted");
        assert.strictEqual(result._tag, "Success");
        assert.strictEqual(
          (yield* Ref.get(harness.calls)).filter((call) => call.endsWith(":left")).length,
          1,
        );
      }).pipe(Effect.ensuring(Deferred.succeed(deliver, undefined)), Effect.provide(harness.layer));
    }),
);

it.effect.each((["view", "control"] as const).map((access) => [access] as const))(
  "F049 expiry continuity: expired %s reacquisition refuses failed held-input cleanup",
  ([access]) =>
    Effect.gen(function* () {
      const human = "human:expired-cleanup";
      const harness = yield* managerHarness(`expiry-cleanup-${access}`, {
        failInputReleaseOnce: true,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Expired cleanup" });
        yield* manager.requestHumanControl(owner, human, desktop.id);
        yield* manager.act(
          human,
          { actions: [{ type: "key_down", key: "ShiftLeft" }] },
          desktop.id,
        );
        yield* TestClock.adjust("31 seconds");
        const failed = yield* (
          access === "view"
            ? manager.requestHumanView(owner, human, desktop.id)
            : manager.requestHumanControl(owner, human, desktop.id)
        ).pipe(Effect.result);
        const refused = yield* manager
          .act(human, { actions: [{ type: "press", key: "ArrowLeft" }] }, desktop.id)
          .pipe(Effect.result);
        const receipt = yield* (
          access === "view"
            ? manager.requestHumanView(owner, human, desktop.id)
            : manager.requestHumanControl(owner, human, desktop.id)
        ).pipe(Effect.result);
        assert.strictEqual(failed._tag, "Failure");
        assert.strictEqual(refused._tag, "Failure");
        assert.strictEqual(receipt._tag, "Success");
        if (receipt._tag === "Success")
          assert.strictEqual(
            receipt.success.permission,
            access === "control" ? "granted" : "view-only",
          );
        assert.isFalse((yield* Ref.get(harness.calls)).some((call) => call.endsWith(":left")));
        const releases = (yield* Ref.get(harness.inputEvents))
          .flat()
          .filter((event) => event.type === "key" && !event.data.down);
        assert.lengthOf(releases, 2);
        if (access === "view") yield* manager.requestHumanControl(owner, human, desktop.id);
        yield* manager.act(human, { actions: [{ type: "press", key: "ArrowRight" }] }, desktop.id);
        yield* manager.release(human, desktop.id);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each((["view", "control"] as const).map((access) => [access] as const))(
  "F049 expiry continuity: %s renewal never publishes revived old authority after a write delay",
  ([access]) =>
    Effect.gen(function* () {
      const human = "human:publication-continuity";
      const accepted = yield* Deferred.make<void>();
      const deliver = yield* Deferred.make<void>();
      const armWrite = yield* Ref.make(false);
      const writeRelease = yield* Deferred.make<void>();
      const milestone = yield* Queue.unbounded<"write" | "receipt" | "transition">();
      const harness = yield* managerHarness(`expiry-publication-${access}`, {
        accessibility: true,
        afterGuestProcess: (input) =>
          input.arguments?.includes("insert-text")
            ? Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Deferred.await(deliver)))
            : Effect.void,
        beforePersistContent: () =>
          Ref.getAndSet(armWrite, false).pipe(
            Effect.flatMap((block) =>
              block
                ? Queue.offer(milestone, "write").pipe(Effect.andThen(Deferred.await(writeRelease)))
                : Effect.void,
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Publication continuity" });
        yield* manager.requestHumanControl(owner, human, desktop.id);
        const pending = yield* manager
          .act(
            human,
            {
              actions: [
                { type: "type", text: "abc" },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(accepted);
        yield* TestClock.adjust("29 seconds");
        yield* Ref.set(armWrite, true);
        const tracer = Tracer.make({
          span(options) {
            if (options.name === "AgentDesktopManager.withInputTransition")
              Queue.offerUnsafe(milestone, "transition");
            return new Tracer.NativeSpan(options);
          },
        });
        const renewal = yield* (
          access === "view"
            ? manager.requestHumanView(owner, human, desktop.id)
            : manager.requestHumanControl(owner, human, desktop.id)
        ).pipe(
          Effect.withTracer(tracer),
          Effect.result,
          Effect.tap(() => Queue.offer(milestone, "receipt")),
          Effect.forkChild({ startImmediately: true }),
        );
        const boundary = yield* Queue.take(milestone);
        yield* TestClock.adjust("2 seconds");
        yield* Ref.set(armWrite, false);
        yield* Deferred.succeed(writeRelease, undefined);
        const afterWrite = boundary === "write" ? yield* Queue.take(milestone) : boundary;
        yield* Deferred.succeed(deliver, undefined);
        yield* TestClock.adjust("1 second");
        const receipt = yield* Fiber.join(renewal);
        const result = yield* Fiber.join(pending);
        const keys = (yield* Ref.get(harness.calls)).filter((call) => call.startsWith("key:"));
        const output = process.env.F049_PROBE_OUTPUT;
        if (output !== undefined)
          yield* harness.files.writeFileString(
            `${output}/expiry-publication-${access}.json`,
            JSON.stringify({ boundary, afterWrite, receipt, result, keys }, null, 2),
          );
        assert.strictEqual(receipt._tag, "Success");
        assert.strictEqual(result._tag, boundary === "receipt" ? "Success" : "Failure");
        assert.lengthOf(keys, boundary === "receipt" ? 1 : 0);
      }).pipe(
        Effect.ensuring(Ref.set(armWrite, false)),
        Effect.ensuring(Deferred.succeed(writeRelease, undefined)),
        Effect.ensuring(Deferred.succeed(deliver, undefined)),
        Effect.provide(harness.layer),
      );
    }),
);

it.effect.each(["status", "input", "explicit-view", "explicit-control", "timely-control"] as const)(
  "renewal clock boundary: %s cannot revive expired authority",
  (mode) =>
    Effect.gen(function* () {
      const accepted = yield* Deferred.make<void>();
      const deliver = yield* Deferred.make<void>();
      const parked = yield* Queue.unbounded<void>();
      const refreshed = yield* Queue.unbounded<void>();
      const human = "human:review8-clock";
      const h = yield* managerHarness(`review8-clock-${mode}`, {
        accessibility: true,
        afterGuestProcess: (input) =>
          input.arguments?.includes("insert-text")
            ? Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Deferred.await(deliver)))
            : Effect.void,
      });
      let continuation: (() => void) | undefined;
      const resume = Effect.sync(() => {
        const task = continuation;
        continuation = undefined;
        task?.();
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "review8 clock sample" });
        yield* manager.requestHumanControl(owner, human, desktop.id);
        const old = yield* manager
          .act(
            human,
            {
              actions: [
                { type: "type", text: "abc" },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(accepted);
        yield* TestClock.adjust("29 seconds");
        const base = yield* Scheduler.Scheduler;
        const clock = yield* Clock.Clock;
        let inRefresh = false;
        let armYield = false;
        let yielding = false;
        let clockBoundaryAt: number | undefined;
        let boundaryKind: "time-read" | "service-resolution" | undefined;
        const trace: string[] = [];
        const scheduler: Scheduler.Scheduler = {
          executionMode: base.executionMode,
          shouldYield(fiber) {
            if (armYield) {
              armYield = false;
              yielding = true;
              return true;
            }
            return base.shouldYield(fiber);
          },
          makeDispatcher() {
            const dispatcher = base.makeDispatcher();
            return {
              scheduleTask(task, priority) {
                if (yielding) {
                  yielding = false;
                  continuation = () => dispatcher.scheduleTask(task, priority);
                  trace.push("park-after-clock-before-update");
                  Queue.offerUnsafe(parked, undefined);
                } else dispatcher.scheduleTask(task, priority);
              },
              flush() {
                dispatcher.flush();
              },
            };
          },
        };
        const tracer = Tracer.make({
          context(primitive, fiber) {
            const isClock =
              ((primitive as unknown) === clock.currentTimeMillis ||
                (primitive as unknown) === Clock.Clock) &&
              inRefresh &&
              clockBoundaryAt === undefined;
            const sampled = isClock ? clock.currentTimeMillisUnsafe() : undefined;
            const next = primitive["~effect/Effect/evaluate"](fiber);
            if (isClock) {
              clockBoundaryAt = sampled;
              boundaryKind =
                (primitive as unknown) === Clock.Clock ? "service-resolution" : "time-read";
              armYield = true;
              trace.push(`unchanged-clock-boundary:${boundaryKind}:${sampled}`);
            }
            return next;
          },
          span(options) {
            if (options.name === "AgentDesktopManager.refreshHumanLease") inRefresh = true;
            trace.push(`start:${options.name}`);
            const span = new Tracer.NativeSpan(options),
              end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              trace.push(`end:${options.name}:${exit._tag}`);
              if (options.name === "AgentDesktopManager.refreshHumanLease") {
                inRefresh = false;
                Queue.offerUnsafe(refreshed, undefined);
              }
            };
            return span;
          },
        });
        const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.map((value): unknown => value),
            Effect.mapError(ComputerUse.toComputerAutomationFailure),
          );
        const request =
          mode === "status"
            ? observed(manager.status(human, desktop.id))
            : mode === "input"
              ? observed(
                  manager.act(
                    human,
                    { actions: [{ type: "press", key: "ArrowRight" }] },
                    desktop.id,
                  ),
                )
              : mode === "explicit-view"
                ? observed(manager.requestHumanView(owner, human, desktop.id))
                : observed(manager.requestHumanControl(owner, human, desktop.id));
        const renewal = yield* request.pipe(
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.withTracer(tracer),
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Queue.take(parked);
        assert.strictEqual(clockBoundaryAt, 29_000);
        assert.isFalse(
          trace.some((x) => x.startsWith("end:AgentDesktopManager.refreshHumanLease")),
        );
        yield* TestClock.adjust(mode === "timely-control" ? "500 millis" : "2 seconds");
        const resumedAt = yield* Clock.currentTimeMillis;
        yield* resume;
        yield* Queue.take(refreshed);
        yield* Deferred.succeed(deliver, undefined);
        yield* TestClock.adjust("1 second");
        const oldResult = yield* Fiber.join(old);
        const renewalResult = yield* Fiber.join(renewal);
        const keys = (yield* Ref.get(h.calls)).filter((x) => x.startsWith("key:"));
        const output = process.env.F049_PROBE_OUTPUT;
        if (output)
          yield* h.files.writeFileString(
            `${output}/clock-boundary-${mode}.json`,
            JSON.stringify(
              {
                mode,
                boundaryKind,
                clockBoundaryAt,
                resumedAt,
                oldResult,
                renewalResult,
                keys,
                trace,
              },
              null,
              2,
            ),
          );
        assert.strictEqual(oldResult._tag, mode === "timely-control" ? "Success" : "Failure");
        assert.strictEqual(
          keys.filter((x) => x.endsWith(":left")).length,
          mode === "timely-control" ? 1 : 0,
        );
        if (mode === "status" || mode === "input") {
          assert.strictEqual(renewalResult._tag, "Failure");
          if (renewalResult._tag === "Failure")
            assert.strictEqual(renewalResult.failure.code, "desktop-lease-required");
          assert.strictEqual(keys.filter((x) => x.endsWith(":right")).length, 0);
        } else {
          assert.strictEqual(renewalResult._tag, "Success");
          if (renewalResult._tag === "Success")
            assert.strictEqual(
              (yield* decodeEvidenceStatus(renewalResult.success)).available,
              true,
            );
          const fresh = yield* manager
            .act(human, { actions: [{ type: "press", key: "ArrowRight" }] }, desktop.id)
            .pipe(Effect.result);
          assert.strictEqual(fresh._tag, mode === "explicit-view" ? "Failure" : "Success");
        }
        if (oldResult._tag === "Failure") {
          const failure = ComputerUse.toComputerAutomationFailure(oldResult.failure);
          assert.strictEqual(failure.code, "request-cancelled");
          assert.strictEqual(failure.completedActionCount, 1);
          assert.strictEqual(failure.actionIndex, 1);
        }
      }).pipe(
        Effect.ensuring(resume),
        Effect.ensuring(Deferred.succeed(deliver, undefined)),
        Effect.provide(h.layer),
      );
    }),
);

it.effect.each(["expired", "timely", "expired-before-clock"] as const)(
  "per-action coherent admission: %s uses current expiry before dispatching a suffix",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* managerHarness(`review9-action-boundary-${mode}`, { accessibility: true });
      const parked = yield* Queue.unbounded<void>();
      let continuation: (() => void) | undefined;
      const resume = Effect.sync(() => {
        const task = continuation;
        continuation = undefined;
        task?.();
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "review9 per-action boundary" });
        const human = "human:review9-action-boundary";
        yield* manager.requestHumanControl(owner, human, desktop.id);
        const baseScheduler = yield* Scheduler.Scheduler;
        const clock = yield* Clock.Clock;
        let completed = 0;
        let clockBoundaryAt: number | undefined;
        let boundaryKind: "time-read" | "service-resolution" | undefined;
        let armYield = false;
        let yielding = false;
        const trace: string[] = [];
        const scheduler: Scheduler.Scheduler = {
          executionMode: baseScheduler.executionMode,
          shouldYield(fiber) {
            if (armYield) {
              armYield = false;
              yielding = true;
              return true;
            }
            return baseScheduler.shouldYield(fiber);
          },
          makeDispatcher() {
            const dispatcher = baseScheduler.makeDispatcher();
            return {
              scheduleTask(task, priority) {
                if (yielding) {
                  yielding = false;
                  continuation = () => dispatcher.scheduleTask(task, priority);
                  trace.push(
                    mode === "expired-before-clock"
                      ? "park-before-suffix-guard-clock"
                      : "park-after-suffix-guard-clock-before-authority-read",
                  );
                  Queue.offerUnsafe(parked, undefined);
                } else dispatcher.scheduleTask(task, priority);
              },
              flush() {
                dispatcher.flush();
              },
            };
          },
        };
        const tracer = Tracer.make({
          context(primitive, fiber) {
            const observe =
              completed === 3 &&
              clockBoundaryAt === undefined &&
              ((primitive as unknown) === clock.currentTimeMillis ||
                (primitive as unknown) === Clock.Clock);
            const at = observe ? clock.currentTimeMillisUnsafe() : undefined;
            const next = primitive["~effect/Effect/evaluate"](fiber);
            if (observe) {
              clockBoundaryAt = at;
              boundaryKind =
                (primitive as unknown) === Clock.Clock ? "service-resolution" : "time-read";
              armYield = mode !== "expired-before-clock";
              trace.push(`suffix-guard-clock-boundary:${boundaryKind}:${at}`);
            }
            return next;
          },
          span(options) {
            const span = new Tracer.NativeSpan(options);
            if (options.name === "AgentDesktopManager.executeAction")
              trace.push(`execute-start:${completed}:${clock.currentTimeMillisUnsafe()}`);
            const end = span.end.bind(span);
            span.end = (at, exit) => {
              end(at, exit);
              if (options.name === "AgentDesktopManager.executeAction" && Exit.isSuccess(exit)) {
                completed += 1;
                if (completed === 3 && mode === "expired-before-clock") armYield = true;
                trace.push(`execute-complete:${completed}:${clock.currentTimeMillisUnsafe()}`);
              }
            };
            return span;
          },
        });
        const old = yield* manager
          .act(
            human,
            {
              actions: [
                { type: "type", text: "abc" },
                { type: "wait", durationMs: 14000 },
                { type: "wait", durationMs: 14750 },
                { type: "press", key: "ArrowLeft" },
              ],
            },
            desktop.id,
          )
          .pipe(
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.withTracer(tracer),
            Effect.result,
            Effect.forkChild({ startImmediately: true }),
          );
        yield* TestClock.adjust("29 seconds");
        yield* Queue.take(parked);
        assert.strictEqual(clockBoundaryAt, mode === "expired-before-clock" ? undefined : 29000);
        assert.strictEqual(completed, 3);
        yield* TestClock.adjust(mode === "timely" ? "500 millis" : "2 seconds");
        const resumedAt = yield* Clock.currentTimeMillis;
        yield* resume;
        const result = yield* Fiber.join(old);
        const keys = (yield* Ref.get(h.calls)).filter((call) => call.startsWith("key:"));
        const output = process.env.F049_PROBE_OUTPUT;
        if (output)
          yield* h.files.writeFileString(
            `${output}/per-action-${mode}.json`,
            JSON.stringify(
              { mode, boundaryKind, clockBoundaryAt, resumedAt, result, keys, trace },
              null,
              2,
            ),
          );
        assert.strictEqual(result._tag, mode === "timely" ? "Success" : "Failure");
        assert.lengthOf(keys, mode === "timely" ? 1 : 0);
        if (result._tag === "Failure")
          assert.deepInclude(ComputerUse.toComputerAutomationFailure(result.failure), {
            code: "request-cancelled",
            completedActionCount: 3,
            actionIndex: 3,
          });
        else
          assert.deepInclude(yield* decodeEvidenceActionResult(result.success[0]), {
            type: "type",
            acceptedCodePoints: 3,
            confirmedCodePoints: 3,
          });
      }).pipe(Effect.ensuring(resume), Effect.provide(h.layer));
    }),
);

it.effect.each(["remove-after-resolve", "no-remove"] as const)(
  "runtime capture: %s returns typed outcomes when a desktop disappears",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* managerHarness(`review10-runtime-capture-${mode}`);
      const parked = yield* Queue.unbounded<void>();
      let continuation: (() => void) | undefined;
      const resume = Effect.sync(() => {
        const task = continuation;
        continuation = undefined;
        task?.();
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "review10 removal boundary" });
        yield* manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        const base = yield* Scheduler.Scheduler;
        let armYield = false;
        let yielding = false;
        let resolved = false;
        const trace: string[] = [];
        const scheduler: Scheduler.Scheduler = {
          executionMode: base.executionMode,
          shouldYield(fiber) {
            if (armYield) {
              armYield = false;
              yielding = true;
              return true;
            }
            return base.shouldYield(fiber);
          },
          makeDispatcher() {
            const dispatcher = base.makeDispatcher();
            return {
              scheduleTask(task, priority) {
                if (yielding) {
                  yielding = false;
                  continuation = () => dispatcher.scheduleTask(task, priority);
                  trace.push("park-after-resolve-before-runtime-capture");
                  Queue.offerUnsafe(parked, undefined);
                } else dispatcher.scheduleTask(task, priority);
              },
              flush() {
                dispatcher.flush();
              },
            };
          },
        };
        const tracer = Tracer.make({
          span(options) {
            trace.push(`start:${options.name}`);
            const span = new Tracer.NativeSpan(options),
              end = span.end.bind(span);
            span.end = (at, exit) => {
              end(at, exit);
              trace.push(`end:${options.name}:${exit._tag}`);
              if (
                !resolved &&
                options.name === "AgentDesktopManager.requireAccessibleDesktop" &&
                Exit.isSuccess(exit)
              ) {
                resolved = true;
                armYield = true;
              }
            };
            return span;
          },
        });
        const pending = yield* manager
          .act(owner.controllerId, { actions: [{ type: "press", key: "ArrowLeft" }] }, desktop.id)
          .pipe(
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.withTracer(tracer),
            Effect.exit,
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Queue.take(parked);
        if (mode === "remove-after-resolve")
          yield* manager.manage(owner, { operation: "delete-permanently", desktopId: desktop.id });
        yield* resume;
        const result = yield* Fiber.join(pending);
        const keys = (yield* Ref.get(h.calls)).filter((call) => call.startsWith("key:"));
        const output = process.env.F049_PROBE_OUTPUT;
        if (output)
          yield* h.files.writeFileString(
            `${output}/runtime-capture-${mode}.json`,
            JSON.stringify(
              {
                mode,
                result,
                keys,
                trace,
                causes: Exit.isFailure(result)
                  ? result.cause.reasons.map((reason) =>
                      reason._tag === "Die"
                        ? { kind: reason._tag, detail: String(reason.defect) }
                        : { kind: reason._tag },
                    )
                  : [],
              },
              null,
              2,
            ),
          );
        assert.strictEqual(result._tag, mode === "no-remove" ? "Success" : "Failure");
        assert.lengthOf(keys, mode === "no-remove" ? 1 : 0);
        if (Exit.isFailure(result)) {
          assert.isTrue(
            result.cause.reasons.every((reason) => reason._tag === "Fail"),
            "lifecycle revocation must return a typed refusal, not an undefined-runtime defect",
          );
          assert.lengthOf(result.cause.reasons, 1);
          const reason = result.cause.reasons[0];
          assert.isDefined(reason);
          if (reason?._tag === "Fail") {
            assert.instanceOf(reason.error, AgentDesktopManager.AgentDesktopManagerError);
            assert.strictEqual(reason.error.code, "desktop-lease-required");
            assert.strictEqual(reason.error.operation, "control");
          }
        }
      }).pipe(Effect.ensuring(resume), Effect.provide(h.layer));
    }),
);

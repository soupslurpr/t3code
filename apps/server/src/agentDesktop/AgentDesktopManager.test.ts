import type * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as Option from "effect/Option";
import {
  AgentDesktopId,
  AgentDesktopOwner,
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
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

import * as Bundle from "@t3tools/shared/agentDesktopBundle";
import * as AgentDesktopTransfer from "./AgentDesktopTransferService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ThreadWorkspaceQuery } from "../orchestration-v2/ThreadWorkspaceQuery.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";

import * as AgentDesktopEnvironment from "./AgentDesktopEnvironment.ts";
import * as ComputerUse from "../computer/ComputerAutomationFailure.ts";
import * as AgentDesktopManager from "./AgentDesktopManager.ts";
import * as QemuAgentDesktop from "./QemuAgentDesktop.ts";

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
  managedBaseImage: boolean,
  failInputReleaseOnce: boolean,
  failSendKeyOnce: boolean,
  textInsertionResponse: string,
  activationResponse: string,
  captureAvailable: boolean,
  windowActivationRequiresSwitch: boolean,
  blockMaintenance: boolean,
) =>
  Effect.gen(function* () {
    const baseImage = {
      path: "/base.qcow2",
      managed: managedBaseImage,
      generation: "arch-gnome-v1-test",
      sourceRelease: "20260801.566320",
      profileVersion: "arch-gnome-v1",
      builtAt: "2999-01-01T00:00:00.000Z",
    } as const;
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const inputEvents = yield* Ref.make<
      ReadonlyArray<ReadonlyArray<QemuAgentDesktop.QemuInputEvent>>
    >([]);
    const running = yield* Ref.make<ReadonlySet<AgentDesktopId>>(new Set());
    const parkedSnapshots = yield* Ref.make<ReadonlyMap<AgentDesktopId, number>>(new Map());
    const snapshotSequence = yield* Ref.make(0);
    const failedUpdateStep = yield* Ref.make<"none" | "start" | "prepare" | "install" | "repark">(
      "none",
    );
    const transferStarted = yield* Deferred.make<void>();
    const importReceiptReturned = yield* Ref.make(false);
    const releaseTransfer = yield* Deferred.make<void>();
    const blockTransfer = yield* Ref.make(false);
    const transferFailure = yield* Ref.make<"none" | "disconnected" | "exit" | "invalid">("none");
    const commandEnvironment = yield* Ref.make<ReadonlyArray<string>>([]);
    const commandStarted = yield* Deferred.make<void>();
    const releaseCommand = yield* Deferred.make<void>();
    const maintenanceStarted = yield* Deferred.make<void>();
    const releaseMaintenance = yield* Deferred.make<void>();
    const desktopParked = yield* Deferred.make<void>();
    const storageMaintained = yield* Deferred.make<void>();
    const inputReleaseFailed = yield* Ref.make(false);
    const sendKeyFailed = yield* Ref.make(false);
    const wheelAcknowledgementLost = yield* Ref.make(false);
    const captureEnabled = yield* Ref.make(captureAvailable);
    let windowActivationAttemptCount = 0;
    const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
    const failUpdateStep = (step: "start" | "prepare" | "install" | "repark") =>
      Effect.gen(function* () {
        if ((yield* Ref.get(failedUpdateStep)) !== step) return;
        yield* Ref.set(failedUpdateStep, "none");
        return yield* new QemuAgentDesktop.QemuAgentDesktopError({
          code: "internal-error",
          operation: step,
          detail: `test update ${step} failed`,
        });
      });
    const stopRunning = (id: AgentDesktopId) =>
      Ref.update(running, (current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    const service = QemuAgentDesktop.QemuAgentDesktop.of({
      probe: record("probe").pipe(
        Effect.as({
          available: true,
          baseImagePath: "/base.qcow2",
          baseImage,
          displayDevice: "virtio-vga",
          acceleratedGraphicsAvailable,
          requirements: [],
        }),
      ),
      setup: Effect.succeed({
        attempted: false,
        completed: true,
        packages: [],
        imageProvisioned: false,
        probe: {
          available: true,
          baseImagePath: "/base.qcow2",
          baseImage,
          displayDevice: "virtio-vga",
          acceleratedGraphicsAvailable,
          requirements: [],
        },
      }),
      currentBaseImage: Effect.succeed(baseImage),
      refreshBaseImage: Effect.gen(function* () {
        yield* record("refresh-base-image");
        yield* Deferred.succeed(maintenanceStarted, undefined);
        return {
          ...baseImage,
          builtAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        };
      }),
      pruneBaseImages: () => Deferred.succeed(storageMaintained, undefined).pipe(Effect.asVoid),
      paths: () => {
        throw new Error("paths are not used by the manager test");
      },
      create: (id) => record(`create:${id}`),
      clone: (source, destination) => record(`clone:${source}:${destination}`),
      start: (id, _resources, _routes, restoreParkedState, graphicsBackend) =>
        Effect.gen(function* () {
          yield* record(`start:${id}:${graphicsBackend}`);
          if ((yield* Ref.get(running)).has(id)) return;
          yield* failUpdateStep("start");
          if (restoreParkedState) {
            if (!(yield* Ref.get(parkedSnapshots)).has(id)) {
              return yield* new QemuAgentDesktop.QemuAgentDesktopError({
                code: "internal-error",
                operation: "start",
                detail: "Snapshot t3-parked does not exist",
              });
            }
            yield* record(`restore-parked:${id}`);
            yield* Ref.update(parkedSnapshots, (current) => {
              const next = new Map(current);
              next.delete(id);
              return next;
            });
          }
          yield* Ref.update(running, (current) => new Set(current).add(id));
        }),
      isRunning: (id) => Ref.get(running).pipe(Effect.map((current) => current.has(id))),
      stop: (id) => record(`stop:${id}`).pipe(Effect.andThen(stopRunning(id))),
      park: (id, saveMemoryState) =>
        Effect.gen(function* () {
          yield* record(`park:${id}:${saveMemoryState ? "memory" : "cold"}`);
          if (!(yield* Ref.get(running)).has(id)) return;
          yield* failUpdateStep("repark");
          if (saveMemoryState) {
            const sequence = yield* Ref.updateAndGet(snapshotSequence, (current) => current + 1);
            yield* Ref.update(parkedSnapshots, (current) => new Map(current).set(id, sequence));
          }
          yield* stopRunning(id);
          yield* Deferred.succeed(desktopParked, undefined);
        }),
      checkpoint: (id, saveMemoryState) =>
        record(`checkpoint:${id}:${saveMemoryState ? "memory" : "disk"}`),
      createUpdateRollback: (id) => record(`update-rollback-create:${id}`),
      restoreUpdateRollback: (id) =>
        record(`update-rollback-restore:${id}`).pipe(Effect.andThen(stopRunning(id))),
      discardUpdateRollback: (id) => record(`update-rollback-discard:${id}`),
      remove: (id) => record(`remove:${id}`),
      capture: (id) =>
        record(`capture:${id}`).pipe(
          Effect.andThen(Ref.get(captureEnabled)),
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
        const isTransfer = argumentsValue[0]?.endsWith("/transfer-helper.py") === true;
        const result = {
          exitCode: 0,
          stdout: isTransfer
            ? JSON.stringify({
                rootType: "file",
                fileCount: 1,
                directoryCount: 0,
                symlinkCount: 0,
                logicalBytes: 5,
                wireBytes: 5,
                compression: "none",
                sha256: "a".repeat(64),
              })
            : input.executable === "/usr/bin/getent"
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
          blockMaintenance && input.executable === "/run/t3-agent-desktop/maintenance.sh"
            ? Deferred.succeed(maintenanceStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseMaintenance)),
              )
            : input.executable === "/usr/bin/t3-block"
              ? Deferred.succeed(commandStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCommand)),
                )
              : Effect.void;
        return record(`exec:${id}:${input.executable}:${(input.arguments ?? []).join(" ")}`).pipe(
          Effect.andThen(Ref.set(commandEnvironment, input.environment ?? [])),
          Effect.andThen(execute),
          Effect.andThen(
            input.executable === "/usr/bin/install"
              ? failUpdateStep("prepare")
              : input.executable === "/run/t3-agent-desktop/maintenance.sh"
                ? failUpdateStep("install")
                : Effect.void,
          ),
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
          Effect.andThen(
            isTransfer
              ? Ref.get(blockTransfer).pipe(
                  Effect.flatMap((blocked) =>
                    blocked
                      ? Deferred.succeed(transferStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseTransfer)),
                        )
                      : Effect.void,
                  ),
                )
              : Effect.void,
          ),
          Effect.andThen(
            isTransfer
              ? Ref.get(transferFailure).pipe(
                  Effect.flatMap((failure) => {
                    if (failure === "disconnected")
                      return Effect.fail(
                        new QemuAgentDesktop.QemuAgentDesktopError({
                          code: "guest-disconnected",
                          operation: "guest-exec-status",
                          detail: "lost guest receipt",
                        }),
                      );
                    return Effect.succeed(
                      failure === "exit"
                        ? { ...result, exitCode: 143, stdout: "" }
                        : failure === "invalid"
                          ? { ...result, stdout: "incomplete receipt" }
                          : result,
                    );
                  }),
                )
              : Effect.succeed(result),
          ),
          Effect.tap(() =>
            isTransfer && argumentsValue.includes("extract")
              ? Ref.set(importReceiptReturned, true)
              : Effect.void,
          ),
        );
      },
      readGuestFile: (_id, path) =>
        Effect.succeed({
          data: new TextEncoder().encode(
            path === "/etc/t3-agent-desktop-profile"
              ? "arch-gnome-v1\n"
              : accessibility && path === "/etc/t3-agent-desktop-user"
                ? "t3test\n"
                : "hello",
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
      parkedSnapshots,
      failedUpdateStep,
      wheelAcknowledgementLost,
      captureEnabled,
      commandEnvironment,
      commandStarted,
      transferStarted,
      importReceiptReturned,
      releaseTransfer,
      blockTransfer,
      transferFailure,
      desktopParked,
      storageMaintained,
      inputEvents,
      releaseCommand,
      maintenanceStarted,
      releaseMaintenance,
      service,
    };
  });

/** Creates an isolated manager layer backed by one fake hypervisor. */
const managerHarness = (
  name: string,
  options?: {
    readonly accessibility?: boolean;
    readonly acceleratedGraphics?: boolean;
    readonly managedBaseImage?: boolean;
    readonly baseImageProvisioned?: boolean;
    readonly failInputReleaseOnce?: boolean;
    readonly failSendKeyOnce?: boolean;
    readonly inputHelper?: boolean;
    readonly textInsertionResponse?: string;
    readonly activationResponse?: string;
    readonly blockMaintenance?: boolean;
    readonly initialDocument?: string;
    readonly beforePersist?: Effect.Effect<void>;
    readonly beforePersistContent?: (content: string) => Effect.Effect<void>;
    readonly captureAvailable?: boolean;
    readonly windowActivationRequiresSwitch?: boolean;
  },
) =>
  Effect.gen(function* () {
    const accessibility = options?.accessibility === true;
    const qemu = yield* makeQemu(
      accessibility,
      options?.acceleratedGraphics === true,
      options?.managedBaseImage !== false,
      options?.failInputReleaseOnce === true,
      options?.failSendKeyOnce === true,
      options?.textInsertionResponse ?? "",
      options?.activationResponse ?? '{"ok":true,"result":{"keyboard":false}}',
      options?.captureAvailable === true,
      options?.windowActivationRequiresSwitch === true,
      options?.blockMaintenance === true,
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
    const transferResource = `${agentDesktopsDir}/transfer-helper.py`;
    yield* fileSystem.writeFileString(transferResource, "test transfer helper");
    const inputHelperResource = `${agentDesktopsDir}/input-helper.py`;
    if (options?.inputHelper === true) {
      yield* fileSystem.writeFileString(inputHelperResource, "test input helper");
    }
    const maintenanceResource = `${agentDesktopsDir}/maintenance.sh`;
    yield* fileSystem.writeFileString(maintenanceResource, "#!/usr/bin/bash\nexit 0\n");
    const environmentLayer = Layer.effect(
      AgentDesktopEnvironment.AgentDesktopEnvironment,
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return AgentDesktopEnvironment.AgentDesktopEnvironment.of({
          path,
          platform: "linux",
          processArch: "x64",
          agentDesktopsDir,
          agentDesktopBaseImage: Option.none(),
          resolveResourcePathCandidates: (resource: string) =>
            resource === "agent-desktop/accessibility.js" && accessibility
              ? [accessibilityResource]
              : resource === "agent-desktop/input-helper.py" && options?.inputHelper === true
                ? [inputHelperResource]
                : resource === "agent-desktop/maintenance.sh"
                  ? [maintenanceResource]
                  : resource === "agent-desktop/transfer-helper.py"
                    ? [transferResource]
                    : [],
        });
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      environmentLayer,
      Layer.succeed(QemuAgentDesktop.QemuAgentDesktop, {
        ...qemu.service,
        currentBaseImage: qemu.service.currentBaseImage.pipe(
          Effect.map((base) =>
            options?.baseImageProvisioned === false
              ? { ...base, generation: null, builtAt: null, profileVersion: null }
              : base,
          ),
        ),
      }),
    );
    return {
      files: fileSystem,
      directory: agentDesktopsDir,
      calls: qemu.calls,
      parkedSnapshots: qemu.parkedSnapshots,
      failedUpdateStep: qemu.failedUpdateStep,
      wheelAcknowledgementLost: qemu.wheelAcknowledgementLost,
      captureEnabled: qemu.captureEnabled,
      commandEnvironment: qemu.commandEnvironment,
      commandStarted: qemu.commandStarted,
      transferStarted: qemu.transferStarted,
      blockTransfer: qemu.blockTransfer,
      transferFailure: qemu.transferFailure,
      desktopParked: qemu.desktopParked,
      storageMaintained: qemu.storageMaintained,
      inputEvents: qemu.inputEvents,
      releaseCommand: qemu.releaseCommand,
      maintenanceStarted: qemu.maintenanceStarted,
      releaseMaintenance: qemu.releaseMaintenance,
      layer: AgentDesktopManager.layer.pipe(
        Layer.provide(
          Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fileSystem,
              writeFileString: (path, content, optionsValue) =>
                (path === `${agentDesktopsDir}/desktops.json.tmp`
                  ? Ref.get(qemu.importReceiptReturned).pipe(
                      Effect.flatMap((returned) =>
                        returned ? (options?.beforePersist ?? Effect.void) : Effect.void,
                      ),
                    )
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    path === `${agentDesktopsDir}/desktops.json.tmp`
                      ? (options?.beforePersistContent?.(content) ?? Effect.void)
                      : Effect.void,
                  ),
                  Effect.andThen(fileSystem.writeFileString(path, content, optionsValue)),
                ),
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

        yield* Ref.set(harness.parkedSnapshots, new Map([[desktopId, 1]]));
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

  it.effect("rolls back an interrupted desktop update before serving it", () =>
    Effect.gen(function* () {
      const desktopId = decodeAgentDesktopId("agent-interrupted-update");
      const harness = yield* managerHarness("interrupted-update", {
        initialDocument: encodeUnknownJson({
          version: 1,
          desktops: [
            {
              id: desktopId,
              label: "Interrupted update",
              owner,
              state: "ready",
              resources: {
                cpuCount: 4,
                memoryBytes: 4 * 1024 ** 3,
                diskVirtualBytes: 64 * 1024 ** 3,
                audio: false,
              },
              maintenance: {
                status: "installing",
                appliedProfileVersion: "arch-gnome-v0",
                lastUpdatedAt: "2026-08-01T00:00:00.000Z",
                startedAt: "2026-08-18T00:00:00.000Z",
                previousState: "parked",
                rollbackReady: true,
              },
              graphicsBackend: "virtio-gpu-2d",
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
        const recovered = (yield* manager.list).desktops[0];

        assert.equal(recovered?.id, desktopId);
        assert.equal(recovered?.state, "parked");
        assert.equal(recovered?.maintenance.status, "due");
        assert.include(recovered?.maintenance.detail ?? "", "interrupted update was rolled back");
        assert.include(yield* Ref.get(harness.calls), `update-rollback-restore:${desktopId}`);
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

  it.effect("derives Agent desktop detail frames from one virtual capture", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("detail-capture", { captureAvailable: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Detail capture" });
        yield* manager.requestView(owner, { kind: "agent", desktopId: desktop.id });

        const callsBefore = (yield* Ref.get(harness.calls)).length;
        const snapshot = yield* manager.snapshot(
          owner.controllerId,
          {
            includeAccessibility: false,
            screenshot: false,
            detailScreenshots: [
              {
                id: "upper-left",
                region: {
                  coordinateSpace: "desktop-logical",
                  displayId: "display-0",
                  x: 0,
                  y: 0,
                  width: 50,
                  height: 50,
                },
              },
              {
                id: "lower-right",
                purpose: "Inspect the changing value.",
                region: {
                  coordinateSpace: "desktop-logical",
                  displayId: "display-0",
                  x: 50,
                  y: 50,
                  width: 50,
                  height: 50,
                },
              },
            ],
          },
          desktop.id,
        );

        const snapshotCalls = (yield* Ref.get(harness.calls))
          .slice(callsBefore)
          .filter((call) => call.startsWith("capture:"));
        assert.deepEqual(snapshotCalls, [`capture:${desktop.id}`]);
        assert.isUndefined(snapshot.frame);
        assert.deepEqual(
          snapshot.detailScreenshots?.map(({ id, purpose, frame }) => ({ id, purpose, frame })),
          [
            {
              id: "upper-left",
              purpose: undefined,
              frame: {
                id: "agent-frame-1",
                displayId: "display-0",
                coordinateSpace: "image-pixels",
                width: 50,
                height: 50,
                toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
              },
            },
            {
              id: "lower-right",
              purpose: "Inspect the changing value.",
              frame: {
                id: "agent-frame-2",
                displayId: "display-0",
                coordinateSpace: "image-pixels",
                width: 50,
                height: 50,
                toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 50, offsetY: 50 },
              },
            },
          ],
        );
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
        assert.include(desktop.capabilities, "packet-capture");
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

  it.effect("does not park a desktop while system maintenance is active", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("active-maintenance", {
        blockMaintenance: true,
        captureAvailable: true,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Active maintenance" });
        yield* manager.manage(owner, { desktopId: desktop.id, operation: "stop" });
        yield* manager.update(owner, {
          target: { kind: "desktop", desktopId: desktop.id },
        });
        yield* Deferred.await(harness.maintenanceStarted);

        yield* TestClock.adjust(Duration.minutes(11));
        const duplicate = yield* manager.update(owner, {
          target: { kind: "desktop", desktopId: desktop.id },
        });
        assert.isFalse(duplicate.accepted);
        const busy = yield* manager
          .manage(owner, {
            desktopId: desktop.id,
            operation: "resume",
          })
          .pipe(Effect.flip);
        assert.equal(ComputerUse.toComputerAutomationFailure(busy).code, "desktop-busy");
        assert.isFalse((yield* Ref.get(harness.calls)).some((call) => call.startsWith("park:")));

        yield* Deferred.succeed(harness.releaseMaintenance, undefined);
        const maintenance = yield* manager.awaitUpdate(owner, {
          target: { kind: "desktop", desktopId: desktop.id },
        });
        assert.equal(maintenance.status, "current");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  function hostMemory(freeGiB = 12) {
    const host = NodeModule.createRequire(import.meta.url)("node:os") as typeof NodeOS;
    const free = vi.spyOn(host, "freemem").mockReturnValue(freeGiB * 1024 ** 3);
    const total = vi.spyOn(host, "totalmem").mockReturnValue(16 * 1024 ** 3);
    NodeModule.syncBuiltinESMExports();
    return {
      free(value: number) {
        free.mockReturnValue(value * 1024 ** 3);
        NodeModule.syncBuiltinESMExports();
      },
      [Symbol.dispose]() {
        free.mockRestore();
        total.mockRestore();
        NodeModule.syncBuiltinESMExports();
      },
    };
  }

  const initialOldDesktop = (id: string, retention: "automatic" | "preserve" = "automatic") => ({
    id,
    label: id,
    owner,
    state: "stopped",
    resources: {
      cpuCount: 4,
      memoryBytes: 4 * 1024 ** 3,
      diskVirtualBytes: 64 * 1024 ** 3,
      audio: false,
    },
    graphicsBackend: "virtio-gpu-2d",
    requirements: { retention, updatePolicy: "manual" },
    routes: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    lastActiveAt: "2026-07-01T00:00:00.000Z",
    recoverableUntil: null,
  });

  it.effect.each([
    { name: "keeps queued maintenance out of automatic retirement", queued: true },
    { name: "continues ordinary automatic retirement without a queued update", queued: false },
  ])("$name", ({ queued }) =>
    Effect.gen(function* () {
      using _memory = hostMemory();
      yield* TestClock.setTime(Date.parse("2026-08-19T00:00:00.000Z"));
      const targetId = decodeAgentDesktopId("agent-old-target");
      const otherId = decodeAgentDesktopId("agent-old-other");
      const protectedId = decodeAgentDesktopId("agent-old-preserve");
      const harness = yield* managerHarness("primary-retirement", {
        blockMaintenance: true,
        captureAvailable: true,
        managedBaseImage: false,
        initialDocument: encodeUnknownJson({
          version: 1,
          desktops: [
            initialOldDesktop(targetId),
            initialOldDesktop(otherId),
            initialOldDesktop(protectedId, "preserve"),
          ],
        }),
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const blocker = yield* manager.acquire(owner, {
          fresh: true,
          label: "Blocking update",
        });
        yield* manager.manage(owner, { desktopId: blocker.id, operation: "stop" });
        yield* manager.update(owner, { target: { kind: "desktop", desktopId: blocker.id } });
        yield* Deferred.await(harness.maintenanceStarted);
        if (queued)
          assert.isTrue(
            (yield* manager.update(owner, { target: { kind: "desktop", desktopId: targetId } }))
              .accepted,
          );
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Deferred.await(harness.storageMaintained);
        // update uses the same lifecycle permit and joins the completed cycle.
        assert.isFalse(
          (yield* manager.update(owner, { target: { kind: "desktop", desktopId: blocker.id } }))
            .accepted,
        );
        const listed = (yield* manager.list).desktops;
        const target = listed.find((d) => d.id === targetId);
        const other = listed.find((d) => d.id === otherId);
        const preserved = listed.find((d) => d.id === protectedId);
        yield* Deferred.succeed(harness.releaseMaintenance, undefined);
        yield* manager.awaitUpdate(owner, {
          target: { kind: "desktop", desktopId: blocker.id },
        });
        if (queued)
          yield* manager.awaitUpdate(owner, {
            target: { kind: "desktop", desktopId: targetId },
          });
        const after = (yield* manager.list).desktops.find((d) => d.id === targetId);
        assert.equal(other?.state, "recoverable");
        assert.equal(preserved?.state, "stopped");
        assert.equal(target?.state, queued ? "stopped" : "recoverable");
        if (queued) {
          assert.equal(target?.maintenance.status, "queued");
          assert.equal(target?.recoverableUntil, null);
          assert.equal(after?.maintenance.status, "current");
          assert.equal(after?.state, "stopped");
          assert.equal(after?.recoverableUntil, null);
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each([
    { name: "does not reclaim a desktop during system maintenance", updating: true },
    { name: "reclaims an idle desktop under memory pressure", updating: false },
  ])("$name", ({ updating }) =>
    Effect.gen(function* () {
      using memory = hostMemory();
      const harness = yield* managerHarness("primary-pressure", {
        blockMaintenance: true,
        captureAvailable: true,
        managedBaseImage: false,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, {
          fresh: true,
          label: "Existing desktop",
        });
        yield* manager.manage(owner, { desktopId: desktop.id, operation: "stop" });
        if (updating) {
          yield* manager.update(owner, { target: { kind: "desktop", desktopId: desktop.id } });
          yield* Deferred.await(harness.maintenanceStarted);
        } else {
          yield* manager.manage(owner, { desktopId: desktop.id, operation: "resume" });
        }
        memory.free(2);
        const result = yield* manager
          .acquire(owner, { fresh: true, label: "Pressure request" })
          .pipe(Effect.result);
        const calls = yield* Ref.get(harness.calls);
        const during = (yield* manager.list).desktops.find((d) => d.id === desktop.id);
        if (updating) {
          yield* Deferred.succeed(harness.releaseMaintenance, undefined);
          yield* manager.awaitUpdate(owner, {
            target: { kind: "desktop", desktopId: desktop.id },
          });
        }
        const parked = calls.some((call) => call.startsWith(`park:${desktop.id}:`));
        assert.equal(parked, !updating);
        assert.equal(result._tag, updating ? "Failure" : "Success");
        if (result._tag === "Failure")
          assert.equal(
            ComputerUse.toComputerAutomationFailure(result.failure).code,
            "resource-exhausted",
          );
        assert.equal(during?.state, updating ? "ready" : "parked");
        if (updating) {
          assert.equal(during?.maintenance.status, "installing");
          yield* manager.manage(owner, { desktopId: desktop.id, operation: "resume" });
          yield* manager.acquire(owner, { fresh: true, label: "After completed maintenance" });
          assert.isTrue(
            (yield* Ref.get(harness.calls)).some((call) => call.startsWith(`park:${desktop.id}:`)),
          );
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each(["view", "control"] as const)(
    "refuses an update while %s lease admission commits",
    (access) =>
      Effect.gen(function* () {
        const armed = yield* Ref.make(false);
        const leaseCommitReached = yield* Deferred.make<void>();
        const releaseLeaseCommit = yield* Deferred.make<void>();
        const harness = yield* managerHarness(`admission-${access}`, {
          managedBaseImage: false,
          blockMaintenance: true,
          captureAvailable: true,
          beforePersistContent: (content) =>
            Effect.gen(function* () {
              const document = JSON.parse(content);
              if (
                document.desktops.some(
                  (desktop: { state: string }) => desktop.state === "active",
                ) &&
                (yield* Ref.getAndSet(armed, false))
              ) {
                yield* Deferred.succeed(leaseCommitReached, undefined);
                yield* Deferred.await(releaseLeaseCommit);
              }
            }),
        });
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const desktop = yield* manager.acquire(owner, { fresh: true });
          yield* Ref.set(armed, true);
          const accessFiber = yield* (
            access === "view"
              ? manager.requestView(owner, { kind: "agent", desktopId: desktop.id })
              : manager.requestControl(owner, { kind: "agent", desktopId: desktop.id })
          ).pipe(Effect.forkChild);
          yield* Deferred.await(leaseCommitReached);
          const updateFiber = yield* manager
            .update(owner, { target: { kind: "desktop", desktopId: desktop.id } })
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(releaseLeaseCommit, undefined);
          yield* Fiber.join(accessFiber);
          const result = yield* Fiber.join(updateFiber);
          if (result._tag === "Success" && result.success.accepted) {
            yield* Deferred.await(harness.maintenanceStarted);
            yield* Deferred.succeed(harness.releaseMaintenance, undefined);
            yield* manager.awaitUpdate(owner, {
              target: { kind: "desktop", desktopId: desktop.id },
            });
          }
          const calls = yield* Ref.get(harness.calls);
          assert.isFalse(
            calls.some((call) =>
              call.startsWith(`exec:${desktop.id}:/run/t3-agent-desktop/maintenance.sh:`),
            ),
          );
          assert.isFalse(calls.some((call) => call === `stop:${desktop.id}`));
          const live = (yield* manager.list).desktops.find(
            (candidate) => candidate.id === desktop.id,
          );
          assert.equal(live?.viewerCount, 1);
          assert.equal(live?.controllerId, access === "control" ? owner.controllerId : null);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(
              ComputerUse.toComputerAutomationFailure(result.failure).code,
              "desktop-busy",
            );
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each(["view", "control"] as const)(
    "rejects an update after ordinary %s access commits",
    (access) =>
      Effect.gen(function* () {
        const harness = yield* managerHarness(`existing-${access}`, { managedBaseImage: false });
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const desktop = yield* manager.acquire(owner, { fresh: true });
          yield* access === "view"
            ? manager.requestView(owner, { kind: "agent", desktopId: desktop.id })
            : manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
          const result = yield* manager
            .update(owner, { target: { kind: "desktop", desktopId: desktop.id } })
            .pipe(Effect.flip);
          assert.equal(ComputerUse.toComputerAutomationFailure(result).code, "desktop-busy");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each(["view", "control"] as const)(
    "rejects %s access after maintenance starts",
    (access) =>
      Effect.gen(function* () {
        const harness = yield* managerHarness(`updating-${access}`, {
          managedBaseImage: false,
          blockMaintenance: true,
          captureAvailable: true,
        });
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const desktop = yield* manager.acquire(owner, { fresh: true });
          yield* manager.manage(owner, { desktopId: desktop.id, operation: "stop" });
          yield* manager.update(owner, { target: { kind: "desktop", desktopId: desktop.id } });
          yield* Deferred.await(harness.maintenanceStarted);
          const result = yield* (
            access === "view"
              ? manager.requestView(owner, { kind: "agent", desktopId: desktop.id })
              : manager.requestControl(owner, { kind: "agent", desktopId: desktop.id })
          ).pipe(Effect.result);
          yield* Deferred.succeed(harness.releaseMaintenance, undefined);
          yield* manager.awaitUpdate(owner, { target: { kind: "desktop", desktopId: desktop.id } });
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(
              ComputerUse.toComputerAutomationFailure(result.failure).code,
              "desktop-busy",
            );
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each(["view", "control"] as const)(
    "keeps a queued update when %s access arrives during publication",
    (access) =>
      Effect.gen(function* () {
        const queueReached = yield* Deferred.make<void>();
        const releaseQueue = yield* Deferred.make<void>();
        const harness = yield* managerHarness(`queued-access-${access}`, {
          managedBaseImage: false,
          blockMaintenance: true,
          captureAvailable: true,
          beforePersistContent: (content) => {
            const document = JSON.parse(content);
            return document.desktops.some(
              (desktop: { maintenance?: { status?: string } }) =>
                desktop.maintenance?.status === "queued",
            )
              ? Deferred.succeed(queueReached, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseQueue)),
                )
              : Effect.void;
          },
        });
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const desktop = yield* manager.acquire(owner, { fresh: true });
          const update = yield* manager
            .update(owner, { target: { kind: "desktop", desktopId: desktop.id } })
            .pipe(Effect.forkChild);
          yield* Deferred.await(queueReached);
          const accessing = yield* (
            access === "view"
              ? manager.requestView(owner, { kind: "agent", desktopId: desktop.id })
              : manager.requestControl(owner, { kind: "agent", desktopId: desktop.id })
          ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(releaseQueue, undefined);
          assert.isTrue((yield* Fiber.join(update)).accepted);
          const result = yield* Fiber.join(accessing);
          yield* Deferred.await(harness.maintenanceStarted);
          const during = (yield* manager.list).desktops.find((d) => d.id === desktop.id);
          yield* Deferred.succeed(harness.releaseMaintenance, undefined);
          const completed = yield* manager.awaitUpdate(owner, {
            target: { kind: "desktop", desktopId: desktop.id },
          });
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(
              ComputerUse.toComputerAutomationFailure(result.failure).code,
              "desktop-busy",
            );
          assert.equal(during?.viewerCount, 0);
          assert.equal(during?.controllerId, null);
          assert.equal(during?.maintenance.status, "installing");
          assert.equal(completed.status, "current");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each([
    { access: "view", outcome: "cancel" },
    { access: "control", outcome: "cancel" },
    { access: "view", outcome: "failure" },
    { access: "control", outcome: "failure" },
  ] as const)("releases publication permits after $access $outcome", ({ access, outcome }) =>
    Effect.gen(function* () {
      const armed = yield* Ref.make(false);
      const reached = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const harness = yield* managerHarness(`access-${access}-${outcome}`, {
        managedBaseImage: false,
        blockMaintenance: true,
        captureAvailable: true,
        beforePersistContent: (content) =>
          Effect.gen(function* () {
            const document = JSON.parse(content);
            if (
              document.desktops.some((desktop: { state: string }) => desktop.state === "active") &&
              (yield* Ref.getAndSet(armed, false))
            ) {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(finish);
              if (outcome === "failure") return yield* Effect.die("isolated pre-write failure");
            }
          }),
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { fresh: true });
        yield* Ref.set(armed, true);
        const accessing = yield* (
          access === "view"
            ? manager.requestView(owner, { kind: "agent", desktopId: desktop.id })
            : manager.requestControl(owner, { kind: "agent", desktopId: desktop.id })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(reached);
        if (outcome === "cancel") yield* Fiber.interrupt(accessing);
        else yield* Deferred.succeed(finish, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(accessing)));
        const before = (yield* manager.list).desktops.find((d) => d.id === desktop.id);
        assert.equal(before?.viewerCount, 0);
        assert.equal(before?.controllerId, null);
        assert.deepEqual(yield* Ref.get(harness.inputEvents), []);
        assert.isTrue(
          (yield* manager.update(owner, { target: { kind: "desktop", desktopId: desktop.id } }))
            .accepted,
        );
        yield* Deferred.await(harness.maintenanceStarted);
        yield* Deferred.succeed(harness.releaseMaintenance, undefined);
        assert.equal(
          (yield* manager.awaitUpdate(owner, {
            target: { kind: "desktop", desktopId: desktop.id },
          })).status,
          "current",
        );
        yield* access === "view"
          ? manager.requestView(owner, { kind: "agent", desktopId: desktop.id })
          : manager.requestControl(owner, { kind: "agent", desktopId: desktop.id });
        assert.equal(
          (yield* manager.list).desktops.find((d) => d.id === desktop.id)?.viewerCount,
          1,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each(["view", "control"] as const)(
    "keeps a concurrent handoff authoritative during %s preparation",
    (access) =>
      Effect.gen(function* () {
        const publications = yield* Ref.make<
          ReadonlyArray<{ controllerId: string; state: string }>
        >([]);
        const armed = yield* Ref.make(false);
        const prepared = yield* Deferred.make<void>();
        const releasePreparation = yield* Deferred.make<void>();
        const harness = yield* managerHarness(`changed-owner-${access}`, {
          managedBaseImage: false,
          beforePersistContent: (content) =>
            Effect.gen(function* () {
              const document = JSON.parse(content);
              yield* Ref.update(publications, (current) => [
                ...current,
                ...document.desktops.map(
                  (desktop: { owner: { controllerId: string }; state: string }) => ({
                    controllerId: desktop.owner.controllerId,
                    state: desktop.state,
                  }),
                ),
              ]);
              if (
                document.desktops.some((desktop: { state: string }) => desktop.state === "ready") &&
                (yield* Ref.getAndSet(armed, false))
              ) {
                yield* Deferred.succeed(prepared, undefined);
                yield* Deferred.await(releasePreparation);
              }
            }),
        });
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const desktop = yield* manager.acquire(owner, { fresh: true });
          const nextOwner = {
            ...owner,
            threadId: ThreadId.make("other-thread"),
            controllerId: "other-controller",
          };
          yield* Ref.set(armed, true);
          const accessing = yield* (
            access === "view"
              ? manager.requestView(owner, { kind: "agent", desktopId: desktop.id })
              : manager.requestControl(owner, { kind: "agent", desktopId: desktop.id })
          ).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(prepared);
          const handedOff = yield* manager
            .manage(owner, { operation: "handoff", desktopId: desktop.id, owner: nextOwner })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(releasePreparation, undefined);
          yield* Fiber.join(handedOff);
          const result = yield* Fiber.join(accessing);
          const current = (yield* manager.list).desktops.find((d) => d.id === desktop.id);
          if (result._tag === "Failure")
            assert.equal(
              ComputerUse.toComputerAutomationFailure(result.failure).code,
              access === "view" ? "desktop-target-mismatch" : "desktop-busy",
            );
          if (result._tag === "Success") {
            const events = yield* Ref.get(publications);
            const publishedAccess = events.findIndex(
              (event) => event.controllerId === owner.controllerId && event.state === "active",
            );
            const publishedHandoff = events.findIndex(
              (event) => event.controllerId === nextOwner.controllerId,
            );
            assert.isAtLeast(publishedAccess, 0);
            assert.isAbove(publishedHandoff, publishedAccess);
          }
          assert.deepEqual(current?.owner, nextOwner);
          assert.equal(current?.viewerCount, 0);
          assert.equal(current?.controllerId, null);
          assert.deepEqual(yield* Ref.get(harness.inputEvents), []);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each(
    (["queued", "installing"] as const).flatMap((phase) =>
      (["acquire", "control", "implicit-view", "edit", "explicit-view"] as const).map(
        (request) => ({ phase, request }),
      ),
    ),
  )("preserves a refused $request claim during $phase maintenance", ({ phase, request }) =>
    Effect.gen(function* () {
      using _memory = hostMemory();
      const harness = yield* managerHarness(`maintenance-claim-${phase}-${request}`, {
        managedBaseImage: false,
        blockMaintenance: true,
        captureAvailable: true,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const blockerOwner = {
          ...owner,
          threadId: ThreadId.make("maintenance-blocker"),
          controllerId: "maintenance-blocker",
        };
        const blocker =
          phase === "queued" ? yield* manager.acquire(blockerOwner, { fresh: true }) : undefined;
        if (blocker !== undefined) {
          yield* manager.manage(blockerOwner, { desktopId: blocker.id, operation: "stop" });
          yield* manager.update(blockerOwner, {
            target: { kind: "desktop", desktopId: blocker.id },
          });
          yield* Deferred.await(harness.maintenanceStarted);
        }
        const desktop = yield* manager.acquire(owner, {
          fresh: true,
          label: "Original workspace",
        });
        yield* manager.manage(owner, { desktopId: desktop.id, operation: "stop" });
        yield* manager.update(owner, { target: { kind: "desktop", desktopId: desktop.id } });
        yield* Deferred.await(harness.maintenanceStarted);
        const before = (yield* manager.list).desktops.find((entry) => entry.id === desktop.id);
        assert.equal(before?.maintenance.status, phase);
        const beforeBytes = yield* harness.files.readFileString(
          `${harness.directory}/desktops.json`,
        );
        const replacement = { ...owner, controllerId: "replacement-controller" };
        const result = yield* (
          request === "acquire"
            ? manager
                .acquire(replacement, { desktopId: desktop.id, label: "Rejected workspace" })
                .pipe(Effect.asVoid)
            : request === "control"
              ? manager
                  .requestControl(replacement, { kind: "agent", desktopId: desktop.id })
                  .pipe(Effect.asVoid)
              : request === "implicit-view"
                ? manager.requestView(replacement, { kind: "agent" }).pipe(Effect.asVoid)
                : request === "edit"
                  ? manager
                      .acquire(owner, {
                        desktopId: desktop.id,
                        label: "Rejected workspace",
                        requirements: {
                          retention: "preserve",
                          updatePolicy: "manual",
                          preventParking: true,
                        },
                      })
                      .pipe(Effect.asVoid)
                  : manager
                      .requestView(replacement, { kind: "agent", desktopId: desktop.id })
                      .pipe(Effect.asVoid)
        ).pipe(Effect.result);
        const after = (yield* manager.list).desktops.find((entry) => entry.id === desktop.id);
        const afterBytes = yield* harness.files.readFileString(
          `${harness.directory}/desktops.json`,
        );
        yield* Deferred.succeed(harness.releaseMaintenance, undefined);
        const receipt = yield* manager
          .awaitUpdate(owner, { target: { kind: "desktop", desktopId: desktop.id } })
          .pipe(Effect.result);
        if (receipt._tag === "Failure" && after !== undefined) {
          yield* manager.awaitUpdate(after.owner, {
            target: { kind: "desktop", desktopId: desktop.id },
          });
        }
        if (blocker !== undefined) {
          yield* manager.awaitUpdate(blockerOwner, {
            target: { kind: "desktop", desktopId: blocker.id },
          });
        }
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(
            ComputerUse.toComputerAutomationFailure(result.failure).code,
            "desktop-busy",
          );
        }
        assert.deepEqual(after, before);
        assert.equal(afterBytes, beforeBytes);
        assert.equal(receipt._tag, "Success");
        if (receipt._tag === "Success") assert.equal(receipt.success.status, "current");
        assert.deepEqual(yield* Ref.get(harness.inputEvents), []);
        assert.lengthOf((yield* manager.list).desktops, blocker === undefined ? 1 : 2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each(["active-auto", "active-manual", "idle-auto"] as const)(
    "automatic maintenance waits for admitted operations: %s",
    (kind) =>
      Effect.gen(function* () {
        using _memory = hostMemory();
        yield* TestClock.setTime(Date.parse("3000-01-01T00:00:00.000Z"));
        const harness = yield* managerHarness(`automatic-operation-${kind}`, {
          managedBaseImage: false,
          blockMaintenance: true,
          captureAvailable: true,
        });
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const updatePolicy = kind === "active-manual" ? "manual" : "automatic";
          const desktop = yield* manager.acquire(owner, {
            fresh: true,
            requirements: { retention: "preserve", updatePolicy },
          });
          const command =
            kind === "idle-auto"
              ? undefined
              : yield* manager
                  .command(owner, { desktopId: desktop.id, executable: "/usr/bin/t3-block" })
                  .pipe(Effect.forkChild);
          if (command !== undefined) yield* Deferred.await(harness.commandStarted);
          yield* manager.manage(owner, { desktopId: desktop.id, operation: "stop" });
          if (command !== undefined) {
            const refused = yield* manager
              .update(owner, { target: { kind: "desktop", desktopId: desktop.id } })
              .pipe(Effect.flip);
            assert.equal(ComputerUse.toComputerAutomationFailure(refused).code, "desktop-busy");
          }
          yield* TestClock.adjust(Duration.minutes(1));
          yield* Deferred.await(harness.storageMaintained);
          // The policy operation joins the cycle's lifecycle permit before reading its result.
          yield* manager
            .manage(owner, { desktopId: desktop.id, operation: "set-update-policy", updatePolicy })
            .pipe(Effect.result);
          const before = (yield* manager.list).desktops.find((entry) => entry.id === desktop.id);
          const admitted =
            before?.maintenance.status === "queued" || before?.maintenance.status === "installing";
          if (admitted) yield* Deferred.await(harness.maintenanceStarted);
          const calls = yield* Ref.get(harness.calls);
          if (command !== undefined) {
            yield* Deferred.succeed(harness.releaseCommand, undefined);
            yield* Fiber.join(command);
          }
          if (admitted) {
            yield* Deferred.succeed(harness.releaseMaintenance, undefined);
            yield* manager.awaitUpdate(owner, {
              target: { kind: "desktop", desktopId: desktop.id },
            });
          }
          assert.equal(admitted, kind === "idle-auto");
          assert.equal(
            calls.includes(`update-rollback-create:${desktop.id}`),
            kind === "idle-auto",
          );
          assert.equal(
            calls.some((call) =>
              call.startsWith(`exec:${desktop.id}:/run/t3-agent-desktop/maintenance.sh:`),
            ),
            kind === "idle-auto",
          );
          if (kind === "active-auto") {
            yield* TestClock.adjust(Duration.minutes(1));
            yield* Deferred.await(harness.maintenanceStarted);
            yield* Deferred.succeed(harness.releaseMaintenance, undefined);
            assert.equal(
              (yield* manager.awaitUpdate(owner, {
                target: { kind: "desktop", desktopId: desktop.id },
              })).status,
              "current",
            );
            assert.include(yield* Ref.get(harness.calls), `update-rollback-create:${desktop.id}`);
          }
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("selects an idle cold update after an earlier busy candidate", () =>
    Effect.gen(function* () {
      using _memory = hostMemory();
      yield* TestClock.setTime(Date.parse("3000-01-01T00:00:00.000Z"));
      const harness = yield* managerHarness("automatic-operation-order", {
        managedBaseImage: false,
        blockMaintenance: true,
        captureAvailable: true,
      });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const busy = yield* manager.acquire(owner, {
          fresh: true,
          requirements: { retention: "preserve" },
        });
        const idle = yield* manager.acquire(owner, {
          fresh: true,
          requirements: { retention: "preserve" },
        });
        const command = yield* manager
          .command(owner, { desktopId: busy.id, executable: "/usr/bin/t3-block" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(harness.commandStarted);
        yield* manager.manage(owner, { desktopId: busy.id, operation: "stop" });
        yield* manager.manage(owner, { desktopId: idle.id, operation: "stop" });
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Deferred.await(harness.maintenanceStarted);
        const calls = yield* Ref.get(harness.calls);
        yield* Deferred.succeed(harness.releaseCommand, undefined);
        yield* Fiber.join(command);
        yield* Deferred.succeed(harness.releaseMaintenance, undefined);
        yield* manager.awaitUpdate(owner, { target: { kind: "desktop", desktopId: busy.id } });
        yield* manager.awaitUpdate(owner, { target: { kind: "desktop", desktopId: idle.id } });
        assert.include(calls, `update-rollback-create:${idle.id}`);
        assert.notInclude(calls, `update-rollback-create:${busy.id}`);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("leaves an unconfigured manager idle across maintenance cycles", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("idle", { baseImageProvisioned: false });
      yield* Effect.gen(function* () {
        yield* AgentDesktopManager.AgentDesktopManager;
        yield* TestClock.adjust(Duration.minutes(10));
        assert.deepEqual(yield* Ref.get(harness.calls), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("adopts an older base-only setup and resumes its automatic maintenance", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("legacy-base", { managedBaseImage: true });
      yield* TestClock.setTime(Date.parse("3000-01-01T00:00:00.000Z"));
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Deferred.await(harness.maintenanceStarted);
        const maintenance = yield* manager.awaitUpdate(owner, { target: { kind: "base-image" } });
        assert.equal(maintenance.status, "current");
        assert.include(yield* Ref.get(harness.calls), "refresh-base-image");
        assert.deepEqual((yield* manager.list).desktops, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("maintains an explicitly provisioned base before its first desktop", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("configured-base", { managedBaseImage: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        yield* manager.setup;
        yield* TestClock.adjust(Duration.minutes(1));
        assert.include(yield* Ref.get(harness.calls), "probe");
        assert.deepEqual((yield* manager.list).desktops, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "persists manual updates independently of retention, skips automatic upgrades, and allows explicit upgrades",
    () =>
      Effect.gen(function* () {
        const harness = yield* managerHarness("manual-updates", {
          managedBaseImage: false,
          captureAvailable: true,
          blockMaintenance: true,
        });
        yield* TestClock.setTime(Date.parse("3000-01-01T00:00:00.000Z"));
        const manualId = yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const manual = yield* manager.acquire(owner, {
            fresh: true,
            requirements: { retention: "preserve" },
          });
          assert.equal(manual.updatePolicy, "automatic");
          yield* manager.manage(owner, {
            desktopId: manual.id,
            operation: "set-update-policy",
            updatePolicy: "manual",
          });
          const automatic = yield* manager.acquire(owner, {
            fresh: true,
            requirements: { retention: "preserve" },
          });
          yield* manager.manage(owner, { desktopId: manual.id, operation: "stop" });
          yield* manager.manage(owner, { desktopId: automatic.id, operation: "stop" });
          yield* TestClock.adjust(Duration.minutes(1));
          yield* Deferred.await(harness.maintenanceStarted);
          const before = yield* Ref.get(harness.calls);
          assert.include(before, `update-rollback-create:${automatic.id}`);
          assert.notInclude(before, `update-rollback-create:${manual.id}`);
          yield* Deferred.succeed(harness.releaseMaintenance, undefined);
          yield* manager.awaitUpdate(owner, {
            target: { kind: "desktop", desktopId: automatic.id },
          });
          yield* manager.update(owner, { target: { kind: "desktop", desktopId: manual.id } });
          assert.equal(
            (yield* manager.awaitUpdate(owner, {
              target: { kind: "desktop", desktopId: manual.id },
            })).status,
            "current",
          );
          assert.include(yield* Ref.get(harness.calls), `update-rollback-create:${manual.id}`);
          return manual.id;
        }).pipe(Effect.provide(harness.layer));
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const restored = (yield* manager.list).desktops.find(
            (desktop) => desktop.id === manualId,
          );
          assert.equal(restored?.updatePolicy, "manual");
          assert.equal(restored?.retention, "preserve");
          yield* manager.manage(owner, {
            desktopId: manualId,
            operation: "set-update-policy",
            updatePolicy: "automatic",
          });
          assert.equal(
            (yield* manager.list).desktops.find((desktop) => desktop.id === manualId)?.updatePolicy,
            "automatic",
          );
        }).pipe(Effect.provide(Layer.fresh(harness.layer)));
      }),
  );

  it.effect.each([
    { stage: "start", parked: true, accelerated: false },
    { stage: "prepare", parked: true, accelerated: false },
    { stage: "install", parked: true, accelerated: false },
    { stage: "verify", parked: true, accelerated: false },
    { stage: "verify", parked: false, accelerated: false },
    { stage: "verify", parked: true, accelerated: true },
    { stage: "none", parked: true, accelerated: false },
  ] as const)(
    "retains a resumable desktop after update $stage (parked=$parked, accelerated=$accelerated)",
    ({ stage, parked, accelerated }) =>
      Effect.gen(function* () {
        const harness = yield* managerHarness(`parked-update-${stage}-${parked}-${accelerated}`, {
          captureAvailable: stage !== "verify",
          acceleratedGraphics: accelerated,
        });
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const desktop = yield* manager.acquire(owner, {
            requirements: { graphics: accelerated ? "required" : "none" },
          });
          yield* manager.manage(owner, {
            desktopId: desktop.id,
            operation: parked ? "park" : "stop",
          });
          const originalSnapshot = (yield* Ref.get(harness.parkedSnapshots)).get(desktop.id);
          assert.equal(originalSnapshot !== undefined, parked && !accelerated);
          yield* Ref.set(harness.failedUpdateStep, stage === "verify" ? "none" : stage);

          const queued = yield* manager.update(owner, {
            target: { kind: "desktop", desktopId: desktop.id },
          });
          assert.isTrue(queued.accepted);
          const maintenance = yield* manager.awaitUpdate(owner, {
            target: { kind: "desktop", desktopId: desktop.id },
          });
          assert.equal(maintenance.status, stage === "none" ? "current" : "failed");
          const after = (yield* manager.list).desktops.find((value) => value.id === desktop.id);
          assert.equal(after?.state, parked ? "parked" : "stopped");
          const snapshot = (yield* Ref.get(harness.parkedSnapshots)).get(desktop.id);
          const callsBeforeResume = (yield* Ref.get(harness.calls)).length;
          const resume = yield* manager
            .manage(owner, { desktopId: desktop.id, operation: "resume" })
            .pipe(Effect.exit);
          assert.equal(resume._tag, "Success", "the reported lifecycle must be resumable");
          if (stage === "none") {
            assert.isDefined(snapshot);
            assert.notEqual(snapshot, originalSnapshot, "successful updates park the new guest");
          } else {
            assert.equal(
              snapshot,
              originalSnapshot,
              "rollback preserves the original resume point",
            );
            assert.include(maintenance.detail ?? "", "previous disk state was restored");
            assert.include(
              maintenance.detail ?? "",
              stage === "verify"
                ? "test virtual display disconnected"
                : `test update ${stage} failed`,
            );
          }
          assert.isFalse((yield* Ref.get(harness.parkedSnapshots)).has(desktop.id));
          const calls = yield* Ref.get(harness.calls);
          assert.equal(calls.includes(`update-rollback-restore:${desktop.id}`), stage !== "none");
          assert.equal(calls.includes(`update-rollback-discard:${desktop.id}`), stage === "none");
          assert.equal(
            calls.slice(callsBeforeResume).filter((call) => call === `restore-parked:${desktop.id}`)
              .length,
            parked && !accelerated ? 1 : 0,
          );
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each(["shutdown", "restart"] as const)(
    "keeps the parked resume point across an interrupted update: %s",
    (boundary) =>
      Effect.gen(function* () {
        const harness = yield* managerHarness(`parked-update-${boundary}`, {
          captureAvailable: true,
          blockMaintenance: true,
        });
        const serviceScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));
        const context = yield* Layer.buildWithScope(harness.layer, serviceScope);
        const manager = Context.get(context, AgentDesktopManager.AgentDesktopManager);
        const desktop = yield* manager.acquire(owner, { requirements: { graphics: "none" } });
        yield* manager.manage(owner, { desktopId: desktop.id, operation: "park" });
        const originalSnapshot = (yield* Ref.get(harness.parkedSnapshots)).get(desktop.id);
        assert.isDefined(originalSnapshot);
        yield* manager.update(owner, { target: { kind: "desktop", desktopId: desktop.id } });
        yield* Deferred.await(harness.maintenanceStarted);
        const interruptedDocument = yield* harness.files.readFileString(
          `${harness.directory}/desktops.json`,
        );
        const interruptedSnapshots = yield* Ref.get(harness.parkedSnapshots);
        yield* Scope.close(serviceScope, Exit.void);
        if (boundary === "restart") {
          // Reopen the persisted/native state captured before orderly shutdown recovery.
          yield* harness.files.writeFileString(
            `${harness.directory}/desktops.json`,
            interruptedDocument,
          );
          yield* Ref.set(harness.parkedSnapshots, interruptedSnapshots);
        }
        yield* Effect.gen(function* () {
          const recoveredManager = yield* AgentDesktopManager.AgentDesktopManager;
          const recovered = (yield* recoveredManager.list).desktops.find(
            (value) => value.id === desktop.id,
          );
          assert.equal(recovered?.state, "parked");
          assert.equal(
            recovered?.maintenance.status,
            boundary === "restart" ? "current" : "failed",
          );
          assert.include(
            recovered?.maintenance.detail ?? "",
            boundary === "restart"
              ? "interrupted update was rolled back"
              : "previous disk state was restored",
          );
          const snapshot = (yield* Ref.get(harness.parkedSnapshots)).get(desktop.id);
          const resumed = yield* recoveredManager
            .manage(owner, { desktopId: desktop.id, operation: "resume" })
            .pipe(Effect.exit);
          assert.equal(resumed._tag, "Success");
          assert.equal(snapshot, originalSnapshot);
          assert.isFalse((yield* Ref.get(harness.parkedSnapshots)).has(desktop.id));
          assert.include(yield* Ref.get(harness.calls), `update-rollback-restore:${desktop.id}`);
        }).pipe(Effect.provide(Layer.fresh(harness.layer)));
      }),
  );

  it.effect("consumes the saved resume point on ordinary resume without maintenance", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("ordinary-parked-resume");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { requirements: { graphics: "none" } });
        yield* manager.manage(owner, { desktopId: desktop.id, operation: "park" });
        assert.isTrue((yield* Ref.get(harness.parkedSnapshots)).has(desktop.id));
        yield* manager.manage(owner, { desktopId: desktop.id, operation: "resume" });
        assert.isFalse((yield* Ref.get(harness.parkedSnapshots)).has(desktop.id));
        const calls = yield* Ref.get(harness.calls);
        assert.include(calls, `restore-parked:${desktop.id}`);
        assert.isFalse(calls.some((call) => call.startsWith("update-rollback-")));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "does not claim old-state restoration if re-parking fails after the update commits",
    () =>
      Effect.gen(function* () {
        const harness = yield* managerHarness("committed-update-repark-failure", {
          captureAvailable: true,
        });
        yield* Effect.gen(function* () {
          const manager = yield* AgentDesktopManager.AgentDesktopManager;
          const desktop = yield* manager.acquire(owner, { requirements: { graphics: "none" } });
          yield* manager.manage(owner, { desktopId: desktop.id, operation: "park" });
          yield* Ref.set(harness.failedUpdateStep, "repark");
          yield* manager.update(owner, { target: { kind: "desktop", desktopId: desktop.id } });
          const maintenance = yield* manager.awaitUpdate(owner, {
            target: { kind: "desktop", desktopId: desktop.id },
          });
          assert.equal(maintenance.status, "failed");
          assert.include(maintenance.detail ?? "", "test update repark failed");
          assert.include(
            maintenance.detail ?? "",
            "updated disk was preserved and the desktop was stopped",
          );
          assert.notInclude(maintenance.detail ?? "", "previous disk state was restored");
          assert.equal(
            (yield* manager.list).desktops.find((value) => value.id === desktop.id)?.state,
            "stopped",
          );
          const callsBeforeResume = (yield* Ref.get(harness.calls)).length;
          yield* manager.manage(owner, { desktopId: desktop.id, operation: "resume" });
          const calls = yield* Ref.get(harness.calls);
          assert.include(calls, `update-rollback-discard:${desktop.id}`);
          assert.notInclude(calls, `update-rollback-restore:${desktop.id}`);
          assert.equal(
            calls.slice(callsBeforeResume).filter((call) => call === `restore-parked:${desktop.id}`)
              .length,
            0,
          );
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("updates a stopped desktop and commits only after verification", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("update-success", { captureAvailable: true });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Update success" });
        yield* manager.manage(owner, { desktopId: desktop.id, operation: "stop" });

        const queued = yield* manager.update(owner, {
          target: { kind: "desktop", desktopId: desktop.id },
        });
        assert.isTrue(queued.accepted);
        assert.equal(queued.maintenance.status, "queued");
        const maintenance = yield* manager.awaitUpdate(owner, {
          target: { kind: "desktop", desktopId: desktop.id },
        });
        assert.equal(maintenance.status, "current");

        const updated = (yield* manager.list).desktops.find(
          (candidate) => candidate.id === desktop.id,
        );
        assert.equal(updated?.state, "stopped");
        assert.equal(updated?.maintenance.status, "current");
        assert.equal(updated?.maintenance.appliedProfileVersion, "arch-gnome-v1");

        const calls = yield* Ref.get(harness.calls);
        assert.include(calls, `update-rollback-create:${desktop.id}`);
        assert.include(
          calls,
          `exec:${desktop.id}:/usr/bin/install:-d -m 0700 /run/t3-agent-desktop`,
        );
        assert.isTrue(
          calls.some(
            (call) =>
              call === `exec:${desktop.id}:/run/t3-agent-desktop/maintenance.sh:arch-gnome-v1`,
          ),
        );
        assert.isTrue(calls.some((call) => call === `capture:${desktop.id}`));
        assert.include(calls, `update-rollback-discard:${desktop.id}`);
        assert.notInclude(calls, `update-rollback-restore:${desktop.id}`);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refreshes the base image without changing existing desktop backing", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("base-update");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Existing generation" });

        const queued = yield* manager.update(owner, { target: { kind: "base-image" } });
        assert.isTrue(queued.accepted);
        assert.equal(queued.maintenance.status, "queued");
        assert.equal(queued.maintenance.appliedProfileVersion, "arch-gnome-v1");
        const maintenance = yield* manager.awaitUpdate(owner, {
          target: { kind: "base-image" },
        });
        assert.equal(maintenance.status, "current");

        const listed = yield* manager.list;
        assert.equal(listed.baseImage.maintenance.status, "current");
        assert.equal(
          listed.desktops.find((candidate) => candidate.id === desktop.id)?.baseGeneration,
          desktop.baseGeneration,
        );
        assert.include(yield* Ref.get(harness.calls), "refresh-base-image");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("leaves caller-supplied base images outside automatic maintenance", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("external-base", { managedBaseImage: false });
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        assert.isFalse((yield* manager.list).baseImage.managed);

        const error = yield* manager
          .update(owner, { target: { kind: "base-image" } })
          .pipe(Effect.flip);
        assert.equal(ComputerUse.toComputerAutomationFailure(error).code, "unsupported-operation");
        assert.notInclude(yield* Ref.get(harness.calls), "refresh-base-image");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("restores a stopped desktop when update verification fails", () =>
    Effect.gen(function* () {
      const harness = yield* managerHarness("update-rollback");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, { label: "Update rollback" });
        yield* manager.manage(owner, { desktopId: desktop.id, operation: "stop" });

        const queued = yield* manager.update(owner, {
          target: { kind: "desktop", desktopId: desktop.id },
        });
        assert.isTrue(queued.accepted);
        const maintenance = yield* manager.awaitUpdate(owner, {
          target: { kind: "desktop", desktopId: desktop.id },
        });
        assert.equal(maintenance.status, "failed");

        const restored = (yield* manager.list).desktops.find(
          (candidate) => candidate.id === desktop.id,
        );
        assert.equal(restored?.state, "stopped");
        assert.equal(restored?.maintenance.status, "failed");
        assert.include(restored?.maintenance.detail ?? "", "test virtual display disconnected");
        assert.include(restored?.maintenance.detail ?? "", "previous disk state was restored");

        const calls = yield* Ref.get(harness.calls);
        assert.include(calls, `update-rollback-create:${desktop.id}`);
        assert.include(calls, `update-rollback-restore:${desktop.id}`);
        assert.notInclude(calls, `update-rollback-discard:${desktop.id}`);
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
      const screenshot = snapshot.screenshot;
      assert.equal(screenshot?.state, "image");
      if (screenshot?.state !== "image") return;
      assert.equal(screenshot.mimeType, "image/webp");
      assert.deepEqual(screenshot.encoding, {
        format: "webp",
        mode: "lossless",
      });
      assert.equal(Buffer.from(screenshot.data, "base64").subarray(0, 4).toString("ascii"), "RIFF");

      const unchangedSnapshot = yield* manager.snapshot(
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
            unchangedIfContentHash: screenshot.contentHash,
          },
        },
        desktop.id,
      );
      assert.notEqual(unchangedSnapshot.frame?.id, snapshot.frame?.id);
      assert.deepEqual(unchangedSnapshot.screenshot, {
        state: "unchanged",
        contentHash: screenshot.contentHash,
        width: screenshot.width,
        height: screenshot.height,
      });

      const pngSnapshot = yield* manager.snapshot(
        owner.controllerId,
        {
          includeAccessibility: false,
          screenshot: { encoding: { format: "png" } },
        },
        desktop.id,
      );
      assert.equal(pngSnapshot.screenshot?.state, "image");
      if (pngSnapshot.screenshot?.state !== "image") return;
      assert.equal(pngSnapshot.screenshot.mimeType, "image/png");
      assert.deepEqual(pngSnapshot.screenshot.encoding, { format: "png" });
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

it.effect.each(["import", "export"] as const)(
  "transfers exact chunks in both directions and enforces %s cancellation ownership",
  (operation) =>
    Effect.gen(function* () {
      const h = yield* managerHarness("transfer", { accessibility: true });
      const archivePath = `${h.directory}/archive.bundle`;
      yield* h.files.writeFileString(archivePath, "hello");
      const progress: Array<readonly [number, number]> = [];
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, {});
        const imported = yield* manager.transfer(owner, {
          operation: "import",
          transferId: "import-one",
          desktopId: desktop.id,
          archivePath,
          guestPath: "~/imported",
          compression: "none",
          collision: "create",
          onProgress: (bytes, total) =>
            Effect.sync(() => {
              progress.push([bytes, total]);
            }),
          sizeBytes: 5,
          sha256: "a".repeat(64),
        });
        assert.equal(imported.transferId, "import-one");
        assert.equal(imported.wireBytes, 5);
        const exported = yield* manager.transfer(owner, {
          operation: "export",
          transferId: "export-one",
          desktopId: desktop.id,
          archivePath,
          guestPath: "~/source",
          compression: "none",
        });
        assert.equal(exported.transferId, "export-one");
        assert.equal(yield* h.files.readFileString(archivePath), "hello");
        assert.deepEqual(progress, [[5, 5]]);
        const calls = yield* Ref.get(h.calls);
        assert.isTrue(
          calls.some(
            (call) =>
              call.includes("--destination /home/t3test/imported") &&
              call.includes("--owner-uid 1000 --owner-gid 1000"),
          ),
        );
        yield* Ref.set(h.blockTransfer, true);
        const active = yield* manager
          .transfer(owner, {
            ...(operation === "import"
              ? { operation, collision: "create" as const, sizeBytes: 5, sha256: "a".repeat(64) }
              : { operation }),
            transferId: "cancel-one",
            desktopId: desktop.id,
            archivePath,
            guestPath: "~/source",
            compression: "none",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.transferStarted);
        const cleanupCount = (yield* Ref.get(h.calls)).filter((call) =>
          call.endsWith("/usr/bin/rm:-f -- /run/t3-agent-desktop/transfers/cancel-one.bundle"),
        ).length;
        const denied = yield* manager
          .cancelTransfer(
            { ...owner, controllerId: "foreign" },
            { transferId: "cancel-one", desktopId: desktop.id },
          )
          .pipe(Effect.flip);
        assert.deepInclude(denied, { code: "desktop-target-mismatch" });
        yield* manager.cancelTransfer(owner, { transferId: "cancel-one", desktopId: desktop.id });
        const cancelled = yield* Fiber.join(active).pipe(Effect.flip);
        assert.deepInclude(cancelled, { operation: "transfer-cancelled" });
        if (operation === "import")
          assert.match(cancelled.message, /publication outcome is unconfirmed/i);
        yield* manager.cancelTransfer(owner, { transferId: "cancel-one", desktopId: desktop.id });
        assert.equal(
          (yield* Ref.get(h.calls)).filter((call) =>
            call.endsWith("/usr/bin/rm:-f -- /run/t3-agent-desktop/transfers/cancel-one.bundle"),
          ).length,
          cleanupCount + (operation === "import" ? 0 : 1),
        );
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect.each(["disconnected", "exit", "invalid"] as const)(
  "reports an unconfirmed import after a %s guest receipt",
  (failure) =>
    Effect.gen(function* () {
      const h = yield* managerHarness("transfer-receipt", { accessibility: true });
      const archivePath = `${h.directory}/archive.bundle`;
      yield* h.files.writeFileString(archivePath, "hello");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, {});
        yield* Ref.set(h.transferFailure, failure);
        const result = yield* manager
          .transfer(owner, {
            operation: "import",
            transferId: "uncertain-import",
            desktopId: desktop.id,
            archivePath,
            guestPath: "~/imported",
            compression: "none",
            collision: "create",
            sizeBytes: 5,
            sha256: "a".repeat(64),
          })
          .pipe(Effect.flip);
        assert.match(result.message, /publication outcome is unconfirmed/i);
        assert.match(result.message, /inspect the destination before retrying/i);
      }).pipe(Effect.provide(h.layer));
    }),
);

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

const receiptProjectId = ProjectId.make("receipt-project");
const receiptProviderId = ProviderInstanceId.make("receipt-provider");
const receiptNow = "2026-08-14T00:00:00.000Z";
const receiptSelection = { instanceId: receiptProviderId, model: "test-model" } as const;
function receiptProjectionLayer(workspaceRoot: string, worktreePath: string | null = null) {
  return Layer.mock(ThreadWorkspaceQuery)({
    getThreadShellById: () =>
      Effect.succeedSome({
        id: owner.threadId,
        projectId: receiptProjectId,
        title: "Transfer test",
        pullRequests: [],
        modelSelection: receiptSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath,
        activeRunId: null,
        pendingRuntimeRequest: null,
        createdAt: receiptNow,
        updatedAt: receiptNow,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      }),
    getProjectShellById: () =>
      Effect.succeedSome({
        id: receiptProjectId,
        title: "Transfer test",
        workspaceRoot,
        defaultModelSelection: receiptSelection,
        scripts: [],
        createdAt: receiptNow,
        updatedAt: receiptNow,
      }),
  });
}

it.effect.each(["cancel", "timeout", "scope-close"] as const)(
  "keeps an accepted guest import through service %s before activity persistence",
  (scenario) =>
    Effect.gen(function* () {
      const armed = yield* Ref.make(false);
      const persisting = yield* Deferred.make<void>();
      const releasePersist = yield* Deferred.make<void>();
      const h = yield* managerHarness("accepted-service-receipt", {
        beforePersist: Ref.get(armed).pipe(
          Effect.flatMap((value) =>
            value
              ? Deferred.succeed(persisting, undefined).pipe(
                  Effect.andThen(Deferred.await(releasePersist)),
                )
              : Effect.void,
          ),
        ),
      });
      const tree = {
        rootType: "file" as const,
        fileCount: 1,
        directoryCount: 0,
        symlinkCount: 0,
        logicalBytes: 5,
      };
      using _pack = vi.spyOn(Bundle, "packAgentDesktopBundle").mockImplementation(async (input) => {
        await import("node:fs/promises").then((fs) => fs.writeFile(input.outputPath, "hello"));
        return {
          ...tree,
          archiveBytes: 5,
          wireBytes: 5,
          sha256: "a".repeat(64),
          compression: "none" as const,
        };
      });
      yield* h.files.writeFileString(`${h.directory}/source`, "hello");
      yield* Effect.gen(function* () {
        const manager = yield* AgentDesktopManager.AgentDesktopManager;
        const desktop = yield* manager.acquire(owner, {});
        yield* manager.command(owner, { desktopId: desktop.id, executable: "/usr/bin/true" });
        yield* Ref.set(armed, true);
        const serviceLayer = AgentDesktopTransfer.layer.pipe(
          Layer.provide(Layer.succeed(AgentDesktopManager.AgentDesktopManager, manager)),
          Layer.provide(ServerConfig.layerTest(h.directory, { prefix: "t3-accepted-transfer-" })),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(owner.environmentId),
            }),
          ),
        );
        const scope: McpThreadInvocationScope = {
          environmentId: owner.environmentId,
          thread: {
            threadId: owner.threadId,
            providerSessionId: owner.controllerId,
            controllerId: owner.controllerId,
            providerInstanceId: receiptProviderId,
          },
          requestNamespace: "accepted-receipt",
          client: undefined,
          capabilities: new Set(["computer"]),
          issuedAt: 0,
        };
        const serviceScope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(serviceLayer, serviceScope);
        const service = Context.get(context, AgentDesktopTransfer.AgentDesktopTransferService);
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(releasePersist, undefined).pipe(
            Effect.andThen(Scope.close(serviceScope, Exit.void)),
          ),
        );
        const transfer = yield* service
          .start(scope, {
            source: { kind: "workspace", path: "source" },
            destination: { kind: "agent", desktopId: desktop.id, path: "~/received" },
            compression: "none",
            waitMs: 0,
            timeoutMs: 1000,
          })
          .pipe(Effect.provide(receiptProjectionLayer(h.directory)));
        const id = transfer.id;
        yield* Effect.raceFirst(
          Deferred.await(persisting),
          service
            .status(scope, { transferId: id, waitMs: 60_000 })
            .pipe(
              Effect.flatMap((result) =>
                Effect.die(`Transfer finished before receipt barrier: ${JSON.stringify(result)}`),
              ),
            ),
        );
        try {
          assert.isTrue(
            (yield* Ref.get(h.calls)).some((call) => call.includes("transfer-helper.py extract")),
            JSON.stringify(yield* Ref.get(h.calls)),
          );
          if (scenario === "cancel") yield* service.cancel(scope, { transferId: id });
          else if (scenario === "timeout") yield* TestClock.adjust("1 second");
          else yield* Scope.close(serviceScope, Exit.void);
          const result = yield* service.status(scope, { transferId: id });
          assert.equal(result.state, "completed", result.error?.detail);
          assert.isNull(result.error);
          assert.equal(result.sha256, "a".repeat(64));
          assert.deepInclude(result.destination, { desktopId: desktop.id });
        } finally {
          yield* Deferred.succeed(releasePersist, undefined);
          yield* Ref.set(armed, false);
        }
        yield* Scope.close(serviceScope, Exit.void);
      }).pipe(Effect.provide(h.layer));
    }),
);

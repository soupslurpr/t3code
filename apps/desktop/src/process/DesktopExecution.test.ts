import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type DesktopThreadLifecycle } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Environment from "../app/DesktopEnvironment.ts";
import * as Grants from "../computer/DesktopGrants.ts";
import { approveGrant } from "../computer/DesktopGrantPolicy.ts";
import * as Identity from "../computer/UserDesktopIdentity.ts";
import { ElectronDialog } from "../electron/ElectronDialog.ts";
import { ElectronWindow } from "../electron/ElectronWindow.ts";
import * as Execution from "./DesktopExecution.ts";

it.effect(
  "checks execution grants at the destination and lets an authorized human stop an expired job",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        platform = yield* HostProcess.Platform;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-job-approval-" });
      const desktop = { kind: "user", desktopId: "enrolled" } as const;
      const owner = {
        environmentId: EnvironmentId.make("source"),
        threadId: ThreadId.make("thread"),
      };
      const lifecycle: DesktopThreadLifecycle = {
        version: 2,
        ...owner,
        revision: 1,
        activityRevision: 1,
        state: "active",
        serverNow: DateTime.formatIso(DateTime.makeUnsafe(0)),
        activityAt: null,
        settledAt: null,
      };
      const agent = {
        ...owner,
        lifecycle,
        controllerId: "agent",
        controllerKind: "agent",
        connectionGeneration: "current",
      } as const;
      const locals = Layer.mergeAll(
        Environment.layer({
          dirname: directory,
          homeDirectory: directory,
          platform,
          processArch: yield* HostProcess.Architecture,
          appVersion: "1.0",
          appPath: directory,
          isPackaged: true,
          resourcesPath: directory,
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: directory }))),
        Layer.succeed(Identity.UserDesktopIdentity, {
          registration: {
            desktopId: desktop.desktopId,
            protocolVersion: 1,
            defaultLabel: "Test desktop",
            platform: "linux",
            capabilities: ["execution"],
          },
        }),
        Layer.mock(ElectronDialog)({}),
        Layer.mock(ElectronWindow)({}),
      );
      const layer = Execution.layer.pipe(Layer.provideMerge(Grants.layer), Layer.provide(locals));
      yield* Effect.gen(function* () {
        const host = yield* Execution.DesktopExecution,
          store = yield* Grants.DesktopGrants;
        store.connect(owner.environmentId, "current");
        const cmd = {
          desktop,
          operation: "command",
          commandId: "owned",
          executable: process.execPath,
          arguments: ["-e", "process.stdin.resume()"],
          keepStdinOpen: true,
          waitMs: 0,
        } as const;
        expect(yield* Effect.flip(host.invoke(agent, cmd))).toMatchObject({
          code: "permission-denied",
        });
        expect(
          yield* Effect.flip(
            host.transfer(agent, {
              desktop,
              operation: "run",
              transferId: "unapproved",
              direction: "from-desktop",
              desktopPath: "notes.txt",
              collision: "create",
              compression: "none",
              timeoutMs: 1000,
              url: "/api/desktop-transfer/unapproved",
              token: "0".repeat(64),
            }),
          ),
        ).toMatchObject({ code: "permission-denied" });
        yield* store.withPermit(
          store.replace([
            approveGrant({
              owner,
              grantId: "grant",
              capability: "execution",
              source: lifecycle,
              now: store.now(),
              policy: {
                scope: "thread",
                lifetime: "until-time",
                remembered: false,
                deadline: DateTime.formatIso(DateTime.makeUnsafe(store.now() + 10_000)),
              },
            }),
          ]),
        );
        expect(yield* host.reserveWorktreeCleanup("cleanup")).toBe(true);
        expect(yield* Effect.flip(host.invoke(agent, cmd))).toMatchObject({
          code: "workspace-busy",
        });
        yield* host.releaseWorktreeCleanup("cleanup");
        const job = yield* host.invoke(agent, cmd);
        if (job.kind !== "process") throw Error("Expected a running job");
        expect(job.process.status).toBe("running");
        expect(yield* host.reserveWorktreeCleanup("cleanup")).toBe(false);
        const processId = job.process.processId;
        const read = {
          operation: "process",
          desktop,
          input: { desktop, processId, action: "read" },
        } as const;
        yield* TestClock.adjust(10_000);
        expect(yield* Effect.flip(host.invoke(agent, read))).toMatchObject({
          code: "permission-denied",
        });
        const human = { ...agent, controllerKind: "human" } as const;
        expect(yield* host.invoke(human, read)).toMatchObject({
          kind: "process",
          process: { processId },
        });
        expect(
          yield* Effect.flip(host.invoke(human, { ...cmd, commandId: "no-grant" })),
        ).toMatchObject({ code: "permission-denied" });
        expect(
          yield* host.invoke(human, {
            operation: "process",
            desktop,
            input: { desktop, action: "signal", processId, signal: "SIGKILL" },
          }),
        ).toMatchObject({ kind: "process", process: { status: "exited" } });
        store.disconnect(owner.environmentId, "current");
        expect(yield* Effect.flip(host.invoke(human, read))).toMatchObject({
          code: "connection-changed",
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, NodeCrypto.layer])),
);

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId, type UserDesktopCompletionInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as Receipts from "./DesktopCompletionReceipts.ts";
import * as Journal from "./DesktopProcessActivityJournal.ts";

const owner = { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("thread") };
const input: UserDesktopCompletionInput = {
  desktop: { kind: "user", desktopId: "target" },
  action: "register",
  waitId: "wait",
  processId: "process",
  runtimeGeneration: "runtime-before-restart",
};

it.effect(
  "resolves pending receipts as lost on native restart and prevents late registration after cancellation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "native-completion-restart-" });
      const environment = DesktopEnvironment.layer({
        dirname: path.join(stateDir, "dist-electron"),
        homeDirectory: stateDir,
        platform: "linux",
        processArch: "x64",
        appVersion: "1.0.0",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/repo/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: stateDir })),
        Layer.provide(NodeServices.layer),
      );
      const runtime = () => Receipts.layer.pipe(Layer.provideMerge(environment));
      yield* Effect.gen(function* () {
        const receipts = yield* Receipts.DesktopCompletionReceipts;
        yield* receipts.invoke(owner, input, ["grant"]);
      }).pipe(Effect.provide(runtime()));
      yield* Effect.gen(function* () {
        const receipts = yield* Receipts.DesktopCompletionReceipts;
        const native = yield* DesktopEnvironment.DesktopEnvironment;
        const pendingWrite = path.join(native.stateDir, "desktop-completion-receipts.json.new");
        yield* fs.makeDirectory(pendingWrite);
        assert.equal(
          (yield* receipts.resetRuntime("runtime-after-restart").pipe(Effect.flip)).reason,
          "write-failed",
        );
        assert.isNull(yield* receipts.invoke(owner, { ...input, action: "status" }));
        yield* fs.remove(pendingWrite, { recursive: true });
        yield* receipts.resetRuntime("runtime-after-restart");
        const receipt = yield* receipts.invoke(owner, { ...input, action: "status" });
        assert.equal(receipt?.status, "lost");
        assert.equal(receipt?.runtimeGeneration, input.runtimeGeneration);
        yield* fs.makeDirectory(pendingWrite);
        assert.equal(
          (yield* receipts.invoke(owner, { ...input, action: "acknowledge" }).pipe(Effect.flip))
            .reason,
          "write-failed",
        );
        assert.deepEqual(yield* receipts.invoke(owner, { ...input, action: "status" }), receipt);
        yield* fs.remove(pendingWrite, { recursive: true });
        yield* receipts.invoke(owner, { ...input, action: "acknowledge" });
        assert.equal(
          (yield* receipts.invoke(owner, input, ["new-grant"]).pipe(Effect.flip)).reason,
          "wait-cancelled",
        );
        const notYetRegistered = { ...input, waitId: "late-wait" };
        yield* receipts.invoke(owner, { ...notYetRegistered, action: "cancel" });
        assert.equal(
          (yield* receipts.invoke(owner, notYetRegistered, ["grant"]).pipe(Effect.flip)).reason,
          "wait-cancelled",
        );
      }).pipe(Effect.provide(runtime()));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "keeps unacknowledged activity across restart and acknowledges only the owning source",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "native-activity-journal-" });
      const environment = DesktopEnvironment.layer({
        dirname: path.join(stateDir, "dist-electron"),
        homeDirectory: stateDir,
        platform: "linux",
        processArch: "x64",
        appVersion: "1.0.0",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/repo/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: stateDir })),
        Layer.provide(NodeServices.layer),
      );
      const runtime = () => Journal.layer.pipe(Layer.provideMerge(environment));
      const activity = {
        ...owner,
        activityId: "runtime:process:completed",
        desktop: { kind: "user" as const, desktopId: "target" },
        processId: "process",
        commandId: "command",
        runtimeGeneration: "runtime",
        phase: "completed" as const,
        status: "exited",
        exitCode: 7,
        signal: null,
      };
      yield* Effect.gen(function* () {
        const journal = yield* Journal.DesktopProcessActivityJournal;
        yield* journal.record(activity);
        yield* journal.record(activity);
        assert.lengthOf(journal.pending(owner.environmentId), 1);
      }).pipe(Effect.provide(runtime()));
      yield* Effect.gen(function* () {
        const journal = yield* Journal.DesktopProcessActivityJournal;
        assert.deepEqual(journal.pending(owner.environmentId), [activity]);
        yield* journal.acknowledge(EnvironmentId.make("foreign"), [activity.activityId]);
        assert.lengthOf(journal.pending(owner.environmentId), 1);
        yield* journal.acknowledge(owner.environmentId, [activity.activityId]);
        assert.isEmpty(journal.pending(owner.environmentId));
        const native = yield* DesktopEnvironment.DesktopEnvironment;
        assert.notInclude(
          yield* fs.readFileString(path.join(native.stateDir, "desktop-process-activity.json")),
          "completed",
        );
      }).pipe(Effect.provide(runtime()));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

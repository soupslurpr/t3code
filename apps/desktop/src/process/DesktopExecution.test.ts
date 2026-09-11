/** Verifies local execution consent, scope, persistence, revocation, and target identity. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type DesktopComputerAutomationContext,
  type DesktopExecutionGrant,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as UserDesktopIdentity from "../computer/UserDesktopIdentity.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopExecution from "./DesktopExecution.ts";

const context: DesktopComputerAutomationContext = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  controllerId: "controller",
  controllerKind: "agent",
};

/** Builds an isolated host with a replaceable local consent dialog. */
function withExecution<A, E, R>(
  run: Effect.Effect<A, E, R>,
  approve: ElectronDialog.ElectronDialog["Service"]["showMessageBox"] = () =>
    Effect.succeed({ response: 1, checkboxChecked: false }),
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-execution-test-" });
    const environment = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: directory,
      platform: "linux",
      processArch: "x64",
      appVersion: "1.0.0",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/repo/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.merge(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: directory })),
      ),
    );
    const foundation = UserDesktopIdentity.layer.pipe(
      Layer.provideMerge(environment),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        Layer.effect(
          ElectronWindow.ElectronWindow,
          ElectronWindow.make.pipe(
            Effect.map((service) => ({
              ...service,
              currentMainOrFirst: Effect.succeed(Option.none()),
            })),
          ),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(ElectronDialog.ElectronDialog, {
          ...ElectronDialog.make,
          showMessageBox: approve,
        }),
      ),
    );
    return yield* run.pipe(
      Effect.provide(DesktopExecution.layer.pipe(Layer.provideMerge(foundation))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
}

describe("desktop execution permission", () => {
  it.effect("requires execution permission and exact target identity for file transfers", () =>
    withExecution(
      Effect.gen(function* () {
        const service = yield* DesktopExecution.DesktopExecution;
        const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
        const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
        const input = {
          operation: "run",
          desktop,
          transferId: "transfer-test",
          direction: "from-desktop",
          desktopPath: "file",
          collision: "create",
          compression: "auto",
          timeoutMs: 1000,
          token: "a".repeat(64),
          url: "http://127.0.0.1/api/user-desktop-transfers/transfer-test",
        } as const;
        assert.equal(
          (yield* service.transfer(context, input).pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.equal(
          (yield* service
            .transfer(context, { ...input, desktop: { kind: "user", desktopId: "wrong" } })
            .pipe(Effect.flip)).code,
          "desktop-target-mismatch",
        );
      }),
    ),
  );

  it.effect("requires local permission and enforces the selected scope and desktop", () =>
    withExecution(
      Effect.gen(function* () {
        const execution = yield* DesktopExecution.DesktopExecution;
        const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
        const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
        const input = {
          operation: "command",
          desktop,
          commandId: "echo",
          executable: process.execPath,
          arguments: ["-e", "process.stdout.write('ok')"],
          waitMs: 30_000,
        } as const;
        const denied = yield* execution.invoke(context, input).pipe(Effect.flip);
        assert.equal(denied.code, "permission-denied");
        const granted = yield* execution.invoke(context, {
          operation: "access",
          desktop,
          input: { action: "request", desktop, scope: "thread" },
        });
        assert.equal(granted.kind, "access");
        const result = yield* execution.invoke(context, input);
        assert.equal(result.kind, "process");
        if (result.kind === "process") assert.equal(result.stdout.data, "ok");
        const otherThread = yield* execution
          .invoke(
            { ...context, threadId: ThreadId.make("other") },
            { ...input, commandId: "other" },
          )
          .pipe(Effect.flip);
        assert.equal(otherThread.code, "permission-denied");
        const wrongTarget = yield* execution
          .invoke(context, { ...input, desktop: { kind: "user", desktopId: "wrong" } })
          .pipe(Effect.flip);
        assert.equal(wrongTarget.code, "desktop-target-mismatch");
      }),
    ),
  );

  it.effect("persists only permission explicitly remembered in the local dialog", () =>
    withExecution(
      Effect.gen(function* () {
        const execution = yield* DesktopExecution.DesktopExecution;
        const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
        yield* execution.invoke(context, {
          operation: "access",
          desktop,
          input: { action: "request", desktop, scope: "environment" },
        });
        const stored = yield* fs.readFileString(
          environment.path.join(environment.stateDir, "desktop-execution-grants.json"),
        );
        assert.include(stored, '"remembered":true');
        yield* execution.invoke(
          { ...context, controllerKind: "human" },
          { operation: "access", desktop, input: { action: "revoke", desktop } },
        );
        const revoked = yield* fs.readFileString(
          environment.path.join(environment.stateDir, "desktop-execution-grants.json"),
        );
        assert.include(revoked, '"grants":[]');
      }),
      () => Effect.succeed({ response: 1, checkboxChecked: true }),
    ),
  );

  it.effect("prevents a cancelled local prompt from granting access after revocation", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Electron.MessageBoxReturnValue>();
      yield* withExecution(
        Effect.gen(function* () {
          const execution = yield* DesktopExecution.DesktopExecution;
          const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
          const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
          const request = yield* execution
            .invoke(context, {
              operation: "access",
              desktop,
              input: { action: "request", desktop },
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(requested);
          yield* execution.invoke(
            { ...context, controllerKind: "human" },
            { operation: "access", desktop, input: { action: "revoke", desktop } },
          );
          yield* Deferred.succeed(response, { response: 1, checkboxChecked: true });
          const denied = yield* Fiber.join(request).pipe(Effect.flip);
          assert.equal(denied.code, "permission-denied");
          const status = yield* execution.invoke(context, {
            operation: "access",
            desktop,
            input: { action: "status", desktop },
          });
          if (status.kind === "access") assert.isFalse(status.granted);
        }),
        () => Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(response))),
      );
    }),
  );

  it("matches thread, environment, desktop, and expiry independently", () => {
    const owner = { environmentId: "environment", threadId: "thread" };
    const grant: DesktopExecutionGrant = {
      grantId: "grant",
      scope: "thread",
      environmentId: context.environmentId!,
      threadId: context.threadId!,
      remembered: false,
      expiresAt: null,
    };
    assert.isTrue(DesktopExecution.grantMatches(grant, owner, 0));
    assert.isFalse(DesktopExecution.grantMatches(grant, { ...owner, threadId: "other" }, 0));
    assert.isTrue(
      DesktopExecution.grantMatches(
        { ...grant, scope: "environment" },
        { ...owner, threadId: "other" },
        0,
      ),
    );
    assert.isFalse(DesktopExecution.grantMatches(grant, { ...owner, environmentId: "other" }, 0));
    assert.isTrue(
      DesktopExecution.grantMatches(
        { ...grant, scope: "desktop" },
        { environmentId: "other", threadId: "other" },
        0,
      ),
    );
    assert.isFalse(
      DesktopExecution.grantMatches(
        { ...grant, expiresAt: "1970-01-01T00:00:01.000Z" },
        owner,
        1000,
      ),
    );
  });
});

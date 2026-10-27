import * as TestClock from "effect/testing/TestClock";
/** Verifies local execution consent, scope, persistence, revocation, and target identity. */
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type DesktopComputerAutomationContext,
  type DesktopExecutionGrant,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as UserDesktopIdentity from "../computer/UserDesktopIdentity.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopExecution from "./DesktopExecution.ts";
import * as DesktopGrants from "../computer/DesktopGrants.ts";
import * as DesktopCompletionReceipts from "./DesktopCompletionReceipts.ts";
import { approveGrant } from "../computer/DesktopGrantPolicy.ts";

const context: DesktopComputerAutomationContext = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  controllerId: "controller",
  controllerKind: "agent",
  connectionGeneration: "test-generation",
  lifecycle: {
    version: 2,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    revision: 1,
    activityRevision: 1,
    state: "active",
    serverNow: "1970-01-01T00:00:00.000Z",
    activityAt: "1970-01-01T00:00:00.000Z",
    settledAt: null,
  },
};

/** Builds an isolated host with a replaceable local consent dialog. */
function withExecution<A, E, R>(
  run: Effect.Effect<A, E, R>,
  approve: ElectronDialog.ElectronDialog["Service"]["showMessageBox"] = () =>
    Effect.succeed({ response: 1, checkboxChecked: false }),
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const processArch = yield* HostProcess.Architecture;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-execution-test-" });
    // Model the emitted worker layout while executing the real supervisor source.
    const bundle = path.join(directory, "dist-electron");
    yield* fs.makeDirectory(path.join(bundle, "process"), { recursive: true });
    yield* fs.writeFileString(
      path.join(bundle, "process", "DesktopProcessSupervisor.cjs"),
      `import(${JSON.stringify(NodeURL.pathToFileURL(path.join(import.meta.dirname, "DesktopProcessSupervisor.ts")).href)});`,
    );
    const environment = DesktopEnvironment.layer({
      dirname: bundle,
      homeDirectory: directory,
      platform,
      processArch,
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
              currentMainOrFirst: Effect.succeedNone,
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
      Effect.provide(
        DesktopExecution.layer.pipe(
          Layer.provideMerge(DesktopGrants.layer.pipe(Layer.provideMerge(foundation))),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
}

describe("desktop execution permission", () => {
  it.effect(
    "lets native Settings edit and remove source permissions while preserving remote boundaries",
    () =>
      withExecution(
        Effect.gen(function* () {
          const execution = yield* DesktopExecution.DesktopExecution;
          const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
          const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
          const approved = yield* execution.invoke(context, {
            operation: "access",
            desktop,
            input: { action: "request", desktop },
          });
          if (approved.kind !== "access") return assert.fail("missing approval");
          const grant = approved.grants[0]!;
          const settings = {
            controllerKind: "local" as const,
            controllerId: "local-desktop-settings",
            environmentId: EnvironmentId.make("local-desktop"),
            threadId: ThreadId.make("local-desktop-settings"),
          };
          const statusInput = {
            operation: "access",
            desktop,
            input: { action: "status", desktop },
          } as const;
          const local = yield* execution.invoke(settings, statusInput);
          if (local.kind !== "access") return assert.fail("missing local permissions");
          assert.equal(local.grants[0]?.grantId, grant.grantId);
          const remote = yield* execution.invokeFromNativeBackend(
            {
              ...settings,
              controllerKind: "human",
              connectionGeneration: "native-backend",
            },
            statusInput,
          );
          if (remote.kind !== "access") return assert.fail("missing remote permissions");
          assert.isEmpty(remote.grants);
          const edit = {
            operation: "access",
            desktop,
            input: {
              action: "edit",
              desktop,
              scope: "thread",
              lifetime: "until-revoked",
              remembered: true,
              grantId: grant.grantId,
              revision: grant.revision,
            },
          } as const;
          const source = {
            ...settings,
            environmentId: grant.environmentId!,
            threadId: grant.threadId!,
          };
          const changed = yield* execution.invoke(source, edit);
          if (changed.kind !== "access") return assert.fail("missing changed permission");
          assert.lengthOf(changed.grants, 1);
          assert.equal(changed.grants[0]?.grantId, grant.grantId);
          assert.equal(changed.grants[0]?.environmentId, context.environmentId);
          assert.equal(changed.grants[0]?.threadId, context.threadId);
          assert.equal(changed.grants[0]?.revision, grant.revision + 1);
          assert.equal(changed.grants[0]?.lifetime, "until-revoked");
          assert.equal(
            (yield* execution.invoke(source, edit).pipe(Effect.flip)).code,
            "stale-policy",
          );
          yield* execution.authorization({
            operation: "disconnected",
            environmentId: context.environmentId!,
            connectionGeneration: context.connectionGeneration!,
          });
          const removed = yield* execution.invoke(settings, {
            operation: "access",
            desktop,
            input: {
              action: "revoke",
              desktop,
              grantId: grant.grantId,
              revision: grant.revision + 1,
              stopProcesses: false,
            },
          });
          if (removed.kind !== "access") return assert.fail("missing removed permission");
          assert.isEmpty(removed.grants);
        }),
      ),
  );

  it.effect.each(["approve", "deny"] as const)(
    "accepts a target-local Settings %s decision for a pending remote source",
    (action) =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<void>();
        yield* withExecution(
          Effect.gen(function* () {
            const execution = yield* DesktopExecution.DesktopExecution;
            const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
            const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
            const requester = yield* execution
              .invoke(context, {
                operation: "access",
                desktop,
                input: { action: "request", desktop },
              })
              .pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(opened);
            const local = {
              controllerKind: "local" as const,
              controllerId: "local-desktop-settings",
              environmentId: context.environmentId!,
              threadId: context.threadId!,
            };
            const status = yield* execution.invoke(local, {
              operation: "access",
              desktop,
              input: { action: "status", desktop },
            });
            if (status.kind !== "access") return assert.fail("missing status");
            assert.lengthOf(status.pendingRequests!, 1);
            const result = yield* execution.invoke(local, {
              operation: "access",
              desktop,
              input: {
                action,
                desktop,
                requestId: status.pendingRequests![0]!.requestId,
                scope: "desktop",
                lifetime: "until-revoked",
                remembered: false,
              },
            });
            const response = yield* Fiber.join(requester);
            if (result.kind !== "access") return assert.fail("missing decision");
            if (action === "approve") {
              assert.equal(response._tag, "Success");
              assert.equal(result.grants[0]?.scope, "desktop");
              assert.equal(result.grants[0]?.lifetime, "until-revoked");
            } else {
              assert.equal(response._tag, "Failure");
              assert.isEmpty(result.grants);
            }
          }),
          () => Deferred.succeed(opened, undefined).pipe(Effect.andThen(Effect.never)),
        );
      }),
  );

  it.effect(
    "recovers remote-owned commands locally after expiry and source loss without allowing input",
    () =>
      withExecution(
        Effect.gen(function* () {
          const execution = yield* DesktopExecution.DesktopExecution;
          const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
          const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
          yield* execution.invokeFromNativeBackend(
            { ...context, controllerKind: "human" },
            {
              operation: "access",
              desktop,
              input: {
                action: "edit",
                desktop,
                scope: "thread",
                lifetime: "until-time",
                deadline: "1970-01-01T00:01:00.000Z",
              },
            },
          );
          const started = yield* execution.invoke(context, {
            operation: "command",
            desktop,
            commandId: "local-recovery",
            executable: process.execPath,
            arguments: ["-e", "process.stdout.write('remote-owned');process.stdin.resume()"],
            keepStdinOpen: true,
            waitMs: 0,
          });
          if (started.kind !== "process") return assert.fail("missing process");
          const processId = started.process.processId;
          yield* execution.invoke(context, {
            operation: "process",
            desktop,
            input: { action: "read", desktop, processId, waitMs: 30_000 },
          });
          yield* TestClock.adjust("1 minute");
          yield* execution.authorization({
            operation: "disconnected",
            environmentId: context.environmentId!,
            connectionGeneration: context.connectionGeneration!,
          });
          const native = {
            controllerKind: "human" as const,
            controllerId: "native-human",
            environmentId: EnvironmentId.make("native-backend"),
            threadId: ThreadId.make("local-desktop-settings"),
            connectionGeneration: "native",
          };
          const listInput = {
            operation: "process",
            desktop,
            input: { action: "list", desktop },
          } as const;
          const remote = yield* execution.invokeFromNativeBackend(native, listInput);
          if (remote.kind !== "list") return assert.fail("missing remote list");
          assert.isEmpty(remote.processes);
          const local = { ...native, controllerKind: "local" as const };
          const jobs = yield* execution.invoke(local, listInput);
          if (jobs.kind !== "list") return assert.fail("missing local list");
          assert.equal(jobs.processes[0]?.processId, processId);
          assert.equal(jobs.processes[0]?.environmentId, context.environmentId);
          const read = {
            operation: "process",
            desktop,
            input: { action: "read", desktop, processId },
          } as const;
          yield* execution.invokeFromNativeBackend(native, read).pipe(Effect.flip);
          const output = yield* execution.invoke(local, read);
          if (output.kind !== "process") return assert.fail("missing output");
          assert.equal(output.stdout.data, "remote-owned");
          assert.equal(output.process.status, "running");
          for (const action of ["write", "resize"] as const) {
            const denied = yield* execution
              .invoke(local, {
                operation: "process",
                desktop,
                input: { action, desktop, processId, data: "new input", columns: 80, rows: 24 },
              })
              .pipe(Effect.flip);
            assert.equal(denied.code, "permission-denied");
          }
          yield* execution.invoke(local, {
            operation: "process",
            desktop,
            input: { action: "signal", desktop, processId, signal: "SIGTERM" },
          });
          const exited = yield* execution.invoke(local, {
            ...read,
            input: { ...read.input, waitMs: 30_000, stdoutOffset: output.stdout.nextOffset },
          });
          if (exited.kind !== "process") return assert.fail("missing completion");
          assert.equal(exited.process.status, "exited");
          yield* execution.invoke(local, {
            operation: "process",
            desktop,
            input: { action: "forget", desktop, processId },
          });
          const remaining = yield* execution.invoke(local, listInput);
          if (remaining.kind !== "list") return assert.fail("missing list after removal");
          assert.isEmpty(remaining.processes);
        }),
      ),
  );

  it.effect("creates a deliberate narrow human policy without replacing broader coverage", () =>
    withExecution(
      Effect.gen(function* () {
        const execution = yield* DesktopExecution.DesktopExecution;
        const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
        const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
        const human = { ...context, controllerKind: "human" as const };
        const broad = yield* execution.invokeFromNativeBackend(human, {
          operation: "access",
          desktop,
          input: { action: "edit", desktop, scope: "environment", lifetime: "until-revoked" },
        });
        const covered = yield* execution.invoke(context, {
          operation: "access",
          desktop,
          input: { action: "request", desktop, scope: "thread", lifetime: "automatic" },
        });
        if (broad.kind !== "access" || covered.kind !== "access")
          return assert.fail("missing access");
        assert.deepEqual(covered.grants, broad.grants);
        const create = {
          operation: "access",
          desktop,
          input: {
            action: "edit",
            desktop,
            scope: "thread",
            lifetime: "automatic",
            remembered: true,
          },
        } as const;
        const narrow = yield* execution.invokeFromNativeBackend(human, create);
        if (narrow.kind !== "access") return assert.fail("missing access");
        assert.deepEqual(
          narrow.grants.find((grant) => grant.scope === "environment"),
          broad.grants[0],
        );
        assert.equal(narrow.grants.find((grant) => grant.scope === "thread")?.remembered, true);
        assert.lengthOf(narrow.grants, 2);
        const stale = yield* execution.invokeFromNativeBackend(human, create).pipe(Effect.flip);
        assert.equal(stale.code, "stale-policy");
      }),
    ),
  );
  it.effect(
    "accepts a native backend human decision for its pending request only, without another prompt",
    () =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<void>();
        yield* withExecution(
          Effect.gen(function* () {
            const execution = yield* DesktopExecution.DesktopExecution;
            const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
            const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
            const requester = yield* execution
              .invoke(context, {
                operation: "access",
                desktop,
                input: { action: "request", desktop },
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(opened);
            const human = { ...context, controllerKind: "human" as const };
            const status = yield* execution.invokeFromNativeBackend(human, {
              operation: "access",
              desktop,
              input: { action: "status", desktop },
            });
            if (status.kind !== "access") return assert.fail("missing status");
            assert.isTrue(status.remoteApprovalAvailable);
            assert.lengthOf(status.pendingRequests!, 1);
            const requestId = status.pendingRequests![0]!.requestId;
            const approval = {
              operation: "access",
              desktop,
              input: {
                action: "approve",
                desktop,
                requestId,
                scope: "thread",
                lifetime: "automatic",
                remembered: false,
              },
            } as const;
            const untrusted = yield* execution.invoke(human, approval).pipe(Effect.flip);
            assert.equal(untrusted.code, "permission-denied");
            const other = yield* execution
              .invokeFromNativeBackend(
                {
                  ...human,
                  environmentId: EnvironmentId.make("other"),
                  lifecycle: { ...human.lifecycle!, environmentId: EnvironmentId.make("other") },
                },
                approval,
              )
              .pipe(Effect.flip);
            assert.equal(other.code, "request-cancelled");
            const approved = yield* execution.invokeFromNativeBackend(human, approval);
            const answer = yield* Fiber.join(requester);
            if (approved.kind !== "access" || answer.kind !== "access")
              return assert.fail("missing approval");
            assert.isTrue(answer.granted);
            assert.equal(answer.grants[0]?.grantId, approved.grants[0]?.grantId);
            const repeated = yield* execution.invokeFromNativeBackend(human, approval);
            if (repeated.kind !== "access") return assert.fail("missing repeated decision");
            assert.lengthOf(repeated.grants, 1);
            assert.equal(repeated.grants[0]?.revision, 1);
            const shared = yield* execution
              .invokeFromNativeBackend(human, {
                operation: "access",
                desktop,
                input: { action: "edit", desktop, scope: "desktop", lifetime: "until-revoked" },
              })
              .pipe(Effect.flip);
            assert.equal(shared.code, "permission-denied");
          }),
          () => Deferred.succeed(opened, undefined).pipe(Effect.andThen(Effect.never)),
        );
      }),
  );
  it.effect(
    "coalesces equivalent pending approvals and rejects a replaced connection's late answer",
    () =>
      Effect.gen(function* () {
        const requested = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<{ response: number; checkboxChecked: boolean }>();
        let prompts = 0;
        yield* withExecution(
          Effect.gen(function* () {
            const execution = yield* DesktopExecution.DesktopExecution;
            const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
            const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
            const request = {
              operation: "access",
              desktop,
              input: { action: "request", desktop },
            } as const;
            const first = yield* execution.invoke(context, request).pipe(Effect.forkChild);
            yield* Deferred.await(requested);
            const duplicate = yield* execution
              .invoke(context, request)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* execution.authorization({
              operation: "connected",
              environmentId: context.environmentId!,
              connectionGeneration: "replacement",
            });
            yield* Deferred.succeed(answer, { response: 1, checkboxChecked: true });
            assert.equal((yield* Fiber.join(first).pipe(Effect.flip)).code, "permission-denied");
            assert.equal(
              (yield* Fiber.join(duplicate).pipe(Effect.flip)).code,
              "permission-denied",
            );
            assert.equal(prompts, 1);
            const store = yield* DesktopGrants.DesktopGrants;
            assert.isEmpty(store.list());
          }),
          () => {
            prompts++;
            return Deferred.succeed(requested, undefined).pipe(
              Effect.andThen(Deferred.await(answer)),
            );
          },
        );
      }),
  );

  it.effect(
    "revokes every accepted historical revision of one grant while preserving independent authority",
    () =>
      withExecution(
        Effect.gen(function* () {
          const execution = yield* DesktopExecution.DesktopExecution;
          const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
          const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
          const human = { ...context, controllerKind: "human" as const };
          const first = yield* execution.invoke(context, {
            operation: "access",
            desktop,
            input: { action: "request", desktop },
          });
          if (first.kind !== "access") return assert.fail("missing grant");
          const original = first.grants[0]!;
          const command = {
            operation: "command",
            desktop,
            commandId: "revision-1",
            executable: process.execPath,
            arguments: ["-e", "process.stdin.resume()"],
            keepStdinOpen: true,
            waitMs: 0,
          } as const;
          const one = yield* execution.invoke(context, command);
          const edited = yield* execution.invokeFromNativeBackend(human, {
            operation: "access",
            desktop,
            input: {
              action: "edit",
              desktop,
              grantId: original.grantId,
              revision: original.revision,
            },
          });
          if (edited.kind !== "access" || one.kind !== "process")
            return assert.fail("missing grant or process");
          const replacement = edited.grants[0]!;
          assert.equal(replacement.grantId, original.grantId);
          assert.equal(replacement.revision, original.revision + 1);
          const two = yield* execution.invoke(context, { ...command, commandId: "revision-2" });
          if (two.kind !== "process") return assert.fail("missing process");
          assert.equal(one.process.grantRevision, 1);
          assert.equal(two.process.grantRevision, 2);
          yield* execution.invokeFromNativeBackend(human, {
            operation: "access",
            desktop,
            input: { action: "edit", desktop, scope: "environment" },
          });
          const stale = yield* execution
            .invokeFromNativeBackend(human, {
              operation: "access",
              desktop,
              input: {
                action: "revoke",
                desktop,
                grantId: original.grantId,
                revision: original.revision,
              },
            })
            .pipe(Effect.flip);
          assert.equal(stale.code, "stale-policy");
          yield* execution.invokeFromNativeBackend(human, {
            operation: "access",
            desktop,
            input: {
              action: "revoke",
              desktop,
              grantId: replacement.grantId,
              revision: replacement.revision,
            },
          });
          for (const processId of [one.process.processId, two.process.processId]) {
            const stopped = yield* execution.invokeFromNativeBackend(human, {
              operation: "process",
              desktop,
              input: { action: "read", desktop, processId, waitMs: 30_000 },
            });
            if (stopped.kind === "process") assert.equal(stopped.process.status, "exited");
          }
          const status = yield* execution.invoke(context, {
            operation: "access",
            desktop,
            input: { action: "status", desktop },
          });
          if (status.kind === "access") {
            assert.isTrue(status.granted);
            assert.equal(status.grants[0]!.scope, "environment");
          }
        }),
        (options) => Effect.succeed({ response: options.defaultId ?? 1, checkboxChecked: false }),
      ),
  );
  it.effect("reuses approval without renewal and physically prunes expired saved grants", () => {
    let prompts = 0;
    return withExecution(
      Effect.gen(function* () {
        const execution = yield* DesktopExecution.DesktopExecution;
        const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
        const request = {
          operation: "access",
          desktop,
          input: { action: "request", desktop },
        } as const;
        const first = yield* execution.invoke(context, request);
        yield* TestClock.adjust("1 hour");
        const again = yield* execution.invoke(context, request);
        assert.deepEqual(again, first);
        assert.equal(prompts, 2);
        yield* TestClock.adjust("23 hours");
        const expired = yield* execution.invoke(context, {
          ...request,
          input: { action: "status", desktop },
        });
        if (expired.kind !== "access") assert.fail("missing access status");
        else {
          assert.isFalse(expired.granted);
          assert.isEmpty(expired.grants);
        }
        const stored = yield* fs.readFileString(
          environment.path.join(environment.stateDir, "desktop-execution-grants.json"),
        );
        assert.include(stored, '"grants":[]');
        const fresh = yield* execution.invoke(context, request);
        if (first.kind === "access" && fresh.kind === "access")
          assert.notEqual(first.grants[0]!.grantId, fresh.grants[0]!.grantId);
      }),
      () => {
        prompts++;
        return Effect.succeed({ response: 1, checkboxChecked: true });
      },
    );
  });

  it.effect(
    "keeps broad grants separate from process ownership and agent policy administration",
    () =>
      withExecution(
        Effect.gen(function* () {
          const execution = yield* DesktopExecution.DesktopExecution;
          const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
          const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
          const other = {
            ...context,
            threadId: ThreadId.make("other"),
            lifecycle: { ...context.lifecycle!, threadId: ThreadId.make("other") },
          };
          yield* execution.invoke(context, {
            operation: "access",
            desktop,
            input: { action: "request", desktop, scope: "environment" },
          });
          const job = yield* execution.invoke(context, {
            operation: "command",
            desktop,
            commandId: "owner",
            executable: process.execPath,
            arguments: ["-e", "process.stdout.write('private')"],
            waitMs: 30_000,
          });
          if (job.kind !== "process") return assert.fail("missing process");
          const listing = yield* execution.invoke(other, {
            operation: "process",
            desktop,
            input: { action: "list", desktop },
          });
          if (listing.kind === "list") assert.isEmpty(listing.processes);
          for (const action of ["read", "write", "signal", "forget"] as const) {
            const error = yield* execution
              .invoke(other, {
                operation: "process",
                desktop,
                input: { action, desktop, processId: job.process.processId },
              })
              .pipe(Effect.flip);
            assert.equal(error.code, "process-not-found");
          }
          const denial = yield* execution
            .invoke(other, { operation: "access", desktop, input: { action: "revoke", desktop } })
            .pipe(Effect.flip);
          assert.equal(denial.code, "permission-denied");
          const status = yield* execution.invoke(context, {
            operation: "access",
            desktop,
            input: { action: "status", desktop },
          });
          if (status.kind === "access") assert.isTrue(status.granted);
        }),
        (options) =>
          Effect.succeed({
            response: options.title?.includes("scope") ? 2 : 1,
            checkboxChecked: false,
          }),
      ),
  );

  it.effect(
    "preserves human recovery after expiry, rejects stdin, and redacts a pending read and accepted start",
    () =>
      withExecution(
        Effect.gen(function* () {
          const execution = yield* DesktopExecution.DesktopExecution;
          const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
          const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
          yield* execution.invoke(context, {
            operation: "access",
            desktop,
            input: { action: "request", desktop },
          });
          const command = {
            operation: "command",
            desktop,
            commandId: "continuing",
            executable: process.execPath,
            arguments: ["-e", "process.stdout.write('private');process.stdin.resume()"],
            keepStdinOpen: true,
            waitMs: 0,
          } as const;
          const started = yield* execution.invoke(context, command);
          if (started.kind !== "process") return assert.fail("missing process");
          const processId = started.process.processId;
          const ready = yield* execution.invoke(context, {
            operation: "process",
            desktop,
            input: { action: "read", desktop, processId, waitMs: 30_000 },
          });
          if (ready.kind !== "process") return assert.fail("missing output");
          assert.equal(ready.stdout.data, "private");
          const read = yield* execution
            .invoke(context, {
              operation: "process",
              desktop,
              input: {
                action: "read",
                desktop,
                processId,
                stdoutOffset: ready.stdout.nextOffset,
                waitMs: 30_000,
              },
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          const retry = yield* execution
            .invoke(context, { ...command, waitMs: 30_000 })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust("24 hours");
          const human = { ...context, controllerKind: "human" as const };
          const recovery = yield* execution.invoke(human, {
            operation: "process",
            desktop,
            input: { action: "read", desktop, processId },
          });
          if (recovery.kind !== "process") return assert.fail("missing recovery");
          assert.equal(recovery.process.status, "running");
          assert.equal(recovery.stdout.data, "private");
          const deniedInput = yield* execution
            .invoke(human, {
              operation: "process",
              desktop,
              input: { action: "write", desktop, processId, data: "input" },
            })
            .pipe(Effect.flip);
          assert.equal(deniedInput.code, "permission-denied");
          yield* execution.invoke(human, {
            operation: "process",
            desktop,
            input: { action: "signal", desktop, processId, signal: "SIGKILL" },
          });
          assert.equal((yield* Fiber.join(read).pipe(Effect.flip)).code, "permission-denied");
          const receipt = yield* Fiber.join(retry);
          assert.equal(receipt.kind, "permission-required");
          assert.notProperty(receipt, "stdout");
          assert.notProperty(receipt, "process");
          if (receipt.kind === "permission-required") assert.equal(receipt.processId, processId);
        }),
      ),
  );
  it.effect("withholds in-flight output when the lifecycle feed becomes unavailable", () =>
    withExecution(
      Effect.gen(function* () {
        const execution = yield* DesktopExecution.DesktopExecution;
        const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
        const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
        yield* execution.invoke(context, {
          operation: "access",
          desktop,
          input: { action: "request", desktop },
        });
        const command = {
          operation: "command",
          desktop,
          commandId: "continuing",
          executable: process.execPath,
          arguments: ["-e", "process.stdout.write('private');process.stdin.resume()"],
          keepStdinOpen: true,
          waitMs: 0,
        } as const;
        const started = yield* execution.invoke(context, command);
        if (started.kind !== "process") return assert.fail("missing process");
        const processId = started.process.processId;
        const ready = yield* execution.invoke(context, {
          operation: "process",
          desktop,
          input: { action: "read", desktop, processId, waitMs: 30_000 },
        });
        if (ready.kind !== "process") return assert.fail("missing output");
        assert.equal(ready.stdout.data, "private");
        const read = yield* execution
          .invoke(context, {
            operation: "process",
            desktop,
            input: {
              action: "read",
              desktop,
              processId,
              stdoutOffset: ready.stdout.nextOffset,
              waitMs: 30_000,
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        const retry = yield* execution
          .invoke(context, { ...command, waitMs: 30_000 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* execution.authorization({
          operation: "unavailable",
          environmentId: context.environmentId!,
          connectionGeneration: context.connectionGeneration!,
          threadIds: [context.threadId!],
        });
        const { lifecycle: _oldSnapshot, ...withoutSnapshot } = context;
        const human = { ...withoutSnapshot, controllerKind: "human" as const };
        const recovery = yield* execution.invoke(human, {
          operation: "process",
          desktop,
          input: { action: "read", desktop, processId },
        });
        if (recovery.kind !== "process") return assert.fail("missing recovery");
        assert.equal(recovery.process.status, "running");
        assert.equal(recovery.stdout.data, "private");
        const deniedInput = yield* execution
          .invoke(human, {
            operation: "process",
            desktop,
            input: { action: "write", desktop, processId, data: "input" },
          })
          .pipe(Effect.flip);
        assert.equal(deniedInput.code, "permission-denied");
        yield* execution.invoke(human, {
          operation: "process",
          desktop,
          input: { action: "signal", desktop, processId, signal: "SIGKILL" },
        });
        assert.equal((yield* Fiber.join(read).pipe(Effect.flip)).code, "permission-denied");
        const receipt = yield* Fiber.join(retry);
        assert.equal(receipt.kind, "permission-required");
        assert.notProperty(receipt, "stdout");
        assert.notProperty(receipt, "process");
        if (receipt.kind === "permission-required") assert.equal(receipt.processId, processId);
      }),
    ),
  );
  it.effect(
    "delivers only a preauthorized terminal receipt after expiry and retains it across native restart",
    () =>
      withExecution(
        Effect.gen(function* () {
          const execution = yield* DesktopExecution.DesktopExecution;
          const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
          const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
          yield* execution.invoke(context, {
            operation: "access",
            desktop,
            input: { action: "request", desktop },
          });
          const started = yield* execution.invoke(context, {
            operation: "command",
            desktop,
            commandId: "wait-expiry",
            executable: process.execPath,
            arguments: ["-e", "process.stdin.resume()"],
            keepStdinOpen: true,
            waitMs: 0,
          });
          if (started.kind !== "process") return assert.fail("missing process");
          const input = {
            desktop,
            waitId: "preauthorized-wait",
            processId: started.process.processId,
            runtimeGeneration: started.process.runtimeGeneration!,
          };
          const pending = yield* execution.invoke(context, {
            operation: "completion",
            desktop,
            input: { ...input, action: "register" },
          });
          assert.equal(pending.kind, "completion");
          yield* TestClock.adjust("24 hours");
          const rejected = yield* execution
            .invoke(context, {
              operation: "completion",
              desktop,
              input: { ...input, waitId: "late-wait", action: "register" },
            })
            .pipe(Effect.flip);
          assert.equal(rejected.code, "permission-denied");
          const human = { ...context, controllerKind: "human" as const };
          yield* execution.invoke(human, {
            operation: "process",
            desktop,
            input: { desktop, action: "signal", processId: input.processId, signal: "SIGKILL" },
          });
          yield* execution.invoke(human, {
            operation: "process",
            desktop,
            input: { desktop, action: "read", processId: input.processId, waitMs: 30_000 },
          });
          const terminal = yield* execution.invoke(context, {
            operation: "completion",
            desktop,
            input: { ...input, action: "status" },
          });
          if (terminal.kind !== "completion" || terminal.receipt === null)
            return assert.fail("missing completion");
          assert.equal(terminal.receipt.status, "exited");
          assert.sameMembers(Object.keys(terminal.receipt), [
            "processId",
            "runtimeGeneration",
            "status",
            "exitCode",
            "signal",
            "completedAt",
          ]);
          assert.notProperty(terminal, "stdout");
          yield* Effect.gen(function* () {
            const restored = yield* DesktopCompletionReceipts.DesktopCompletionReceipts;
            yield* restored.resetRuntime("new-native-runtime");
            const receipt = yield* restored.invoke(
              { environmentId: context.environmentId!, threadId: context.threadId! },
              { ...input, action: "status" },
            );
            assert.deepEqual(receipt, terminal.receipt);
          }).pipe(Effect.provide(DesktopCompletionReceipts.layer));
        }),
      ),
  );

  it.effect("explicit keep-work revocation cancels waits while leaving the process running", () =>
    withExecution(
      Effect.gen(function* () {
        const execution = yield* DesktopExecution.DesktopExecution;
        const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
        const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
        const access = yield* execution.invoke(context, {
          operation: "access",
          desktop,
          input: { action: "request", desktop },
        });
        if (access.kind !== "access") return assert.fail("missing access");
        const started = yield* execution.invoke(context, {
          operation: "command",
          desktop,
          commandId: "wait-revoked",
          executable: process.execPath,
          arguments: ["-e", "process.stdin.resume()"],
          keepStdinOpen: true,
          waitMs: 0,
        });
        if (started.kind !== "process") return assert.fail("missing process");
        const input = {
          desktop,
          waitId: "revoked-wait",
          processId: started.process.processId,
          runtimeGeneration: started.process.runtimeGeneration!,
        };
        yield* execution.invoke(context, {
          operation: "completion",
          desktop,
          input: { ...input, action: "register" },
        });
        const human = { ...context, controllerKind: "human" as const };
        const grant = access.grants[0]!;
        yield* execution.invokeFromNativeBackend(human, {
          operation: "access",
          desktop,
          input: {
            action: "revoke",
            desktop,
            grantId: grant.grantId,
            revision: grant.revision,
            stopProcesses: false,
          },
        });
        const receipt = yield* execution.invoke(context, {
          operation: "completion",
          desktop,
          input: { ...input, action: "status" },
        });
        assert.equal(
          receipt.kind === "completion" && receipt.receipt?.status,
          "permission-revoked",
        );
        const list = yield* execution.invoke(human, {
          operation: "process",
          desktop,
          input: { desktop, action: "list" },
        });
        assert.equal(list.kind === "list" && list.processes[0]?.status, "running");
        const deleted = {
          ...context,
          lifecycle: { ...context.lifecycle!, revision: 2, state: "deleted" as const },
        };
        assert.equal(
          (yield* execution
            .invoke(deleted, {
              operation: "completion",
              desktop,
              input: { ...input, action: "status" },
            })
            .pipe(Effect.flip)).code,
          "thread-deleted",
        );
      }),
    ),
  );

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

  it.live("requires local permission and enforces the selected scope and desktop", () =>
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
            {
              ...context,
              threadId: ThreadId.make("other"),
              lifecycle: { ...context.lifecycle!, threadId: ThreadId.make("other") },
            },
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
        const approved = yield* execution.invoke(context, {
          operation: "access",
          desktop,
          input: { action: "request", desktop, scope: "environment" },
        });
        assert.equal(approved.kind, "access");
        if (approved.kind !== "access") return;
        const stored = yield* fs.readFileString(
          environment.path.join(environment.stateDir, "desktop-execution-grants.json"),
        );
        assert.include(stored, '"remembered":true');
        yield* execution.invoke(
          { ...context, controllerKind: "human" },
          {
            operation: "access",
            desktop,
            input: {
              action: "revoke",
              desktop,
              grantId: approved.grants[0]!.grantId,
              revision: approved.grants[0]!.revision,
            },
          },
        );
        const revoked = yield* fs.readFileString(
          environment.path.join(environment.stateDir, "desktop-execution-grants.json"),
        );
        assert.include(revoked, '"grants":[]');
      }),
      () => Effect.succeed({ response: 1, checkboxChecked: true }),
    ),
  );

  it.effect.each([
    { action: "request", cancel: "cancel" },
    { action: "edit", cancel: "cancel" },
    { action: "request", cancel: "connected" },
    { action: "edit", cancel: "connected" },
    { action: "request", cancel: "disconnected" },
    { action: "edit", cancel: "unavailable" },
  ] as const)("cancels $action during source preflight on $cancel", (scenario) =>
    Effect.gen(function* () {
      let prompts = 0;
      yield* withExecution(
        Effect.gen(function* () {
          const execution = yield* DesktopExecution.DesktopExecution;
          const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
          const store = yield* DesktopGrants.DesktopGrants;
          const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
          const human = { ...context, controllerKind: "human" as const };
          yield* execution.authorization({
            operation: "connected",
            environmentId: context.environmentId!,
            connectionGeneration: context.connectionGeneration!,
          });
          const unlock = yield* Deferred.make<void>();
          const blocker = yield* store
            .withPermit(Deferred.await(unlock))
            .pipe(Effect.forkChild({ startImmediately: true }));
          const request = yield* execution
            .invoke(human, {
              operation: "access",
              desktop,
              input: { action: scenario.action, desktop },
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          const references = yield* execution.authorization({
            operation: "references",
            environmentId: context.environmentId!,
            connectionGeneration: context.connectionGeneration!,
          });
          assert.include(references.threadIds, context.threadId!);
          assert.equal(prompts, 0);
          if (scenario.cancel === "cancel")
            yield* execution.invoke(human, { operation: "cancel", desktop });
          else
            yield* execution.authorization({
              operation: scenario.cancel,
              environmentId: context.environmentId!,
              connectionGeneration:
                scenario.cancel === "connected" ? "replacement" : context.connectionGeneration!,
            });
          yield* Deferred.succeed(unlock, undefined);
          yield* Fiber.join(blocker);
          assert.equal(
            (yield* Fiber.join(request).pipe(Effect.flip)).code,
            scenario.cancel === "connected" || scenario.cancel === "disconnected"
              ? "connection-changed"
              : "permission-denied",
          );
          assert.equal(prompts, 0);
          assert.isEmpty(store.list());
          // A fresh request is not suppressed by cancellation of its predecessor.
          const generation = scenario.cancel === "cancel" ? context.connectionGeneration! : "fresh";
          yield* execution.authorization({
            operation: "connected",
            environmentId: context.environmentId!,
            connectionGeneration: generation,
          });
          yield* execution.invoke(
            { ...human, connectionGeneration: generation },
            {
              operation: "access",
              desktop,
              input: { action: scenario.action, desktop },
            },
          );
          assert.equal(prompts, 2);
          assert.lengthOf(store.list(), 1);
        }),
        () =>
          Effect.sync(() => {
            prompts++;
            return { response: 1, checkboxChecked: false };
          }),
      );
    }),
  );

  it.effect.each(["request", "edit"] as const)(
    "rejects a cancelled human %s approval even when the local answer arrives late",
    (action) =>
      Effect.gen(function* () {
        const requested = yield* Deferred.make<void>();
        const response = yield* Deferred.make<Electron.MessageBoxReturnValue>();
        yield* withExecution(
          Effect.gen(function* () {
            const execution = yield* DesktopExecution.DesktopExecution;
            const identity = yield* UserDesktopIdentity.UserDesktopIdentity;
            const store = yield* DesktopGrants.DesktopGrants;
            const desktop = { kind: "user", desktopId: identity.registration.desktopId } as const;
            const human = { ...context, controllerKind: "human" as const };
            const request = yield* execution
              .invoke(human, { operation: "access", desktop, input: { action, desktop } })
              .pipe(Effect.forkChild);
            yield* Deferred.await(requested);
            yield* execution.invoke(human, { operation: "cancel", desktop });
            yield* Deferred.succeed(response, { response: 1, checkboxChecked: true });
            assert.equal((yield* Fiber.join(request).pipe(Effect.flip)).code, "permission-denied");
            assert.isEmpty(store.list());
          }),
          () =>
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(response))),
        );
      }),
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
          yield* execution.invokeFromNativeBackend(
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
    const grant: DesktopExecutionGrant = approveGrant({
      grantId: "grant",
      capability: "execution",
      owner,
      source: context.lifecycle,
      now: 0,
      policy: { scope: "thread", lifetime: "until-revoked", remembered: false, deadline: null },
    });
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

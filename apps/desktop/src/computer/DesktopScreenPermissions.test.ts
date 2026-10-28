import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type DesktopComputerAutomationContext } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ComputerUse from "./ComputerUse.ts";
import * as ComputerUseCoordinator from "./ComputerUseCoordinator.ts";
import * as DesktopGrants from "./DesktopGrants.ts";
import * as DesktopScreenPermissions from "./DesktopScreenPermissions.ts";
import * as UserDesktopIdentity from "./UserDesktopIdentity.ts";
import { approveGrant } from "./DesktopGrantPolicy.ts";

const source = (thread = "thread"): DesktopComputerAutomationContext => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make(thread),
  controllerId: thread,
  controllerKind: "agent",
  connectionGeneration: "generation",
  lifecycle: {
    version: 2,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make(thread),
    revision: 1,
    activityRevision: 1,
    state: "active",
    serverNow: "1970-01-01T00:00:00.000Z",
    activityAt: "1970-01-01T00:00:00.000Z",
    settledAt: null,
  },
});
const temporaryPolicy = {
  scope: "thread",
  lifetime: "automatic",
  remembered: false,
  deadline: null,
} as const;
const status = {
  available: true,
  backend: "gnome-wayland-portal",
  permission: "granted",
  rememberedAccess: ["view", "control"],
  displayState: "active",
  keepAwake: true,
  displays: [],
  cursor: null,
} as const;
const frame = {
  display: {
    id: "1",
    label: "Main",
    primary: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    scaleFactor: 1,
  },
  cursor: null,
  captureSource: "remote-desktop-stream",
} as const;

function withScreen<A, E, R>(
  run: Effect.Effect<A, E, R>,
  calls: string[],
  overrides: Partial<ComputerUse.ComputerUseShape> = {},
  prompt?: ElectronDialog.ElectronDialog["Service"]["showMessageBox"],
  beforeRename: () => Effect.Effect<void> = () => Effect.void,
  wrapFs?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const instrumentedFs = {
      ...fs,
      rename: (from: string, to: string) =>
        beforeRename().pipe(Effect.andThen(fs.rename(from, to))),
    };
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-screen-grants-" });
    const platform = yield* HostProcess.Platform;
    const processArch = yield* HostProcess.Architecture;
    const environment = DesktopEnvironment.layer({
      dirname: path.join(directory, "dist-electron"),
      homeDirectory: directory,
      platform,
      processArch,
      appVersion: "1.0.0",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/repo/resources",
      runningUnderArm64Translation: false,
    }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: directory })));
    const record = (operation: string) =>
      Effect.sync(() => {
        calls.push(operation);
      });
    const native = ComputerUse.ComputerUse.of({
      status: Effect.succeed(status),
      requestView: record("view").pipe(Effect.as(status)),
      requestControl: record("control").pipe(Effect.as(status)),
      rememberView: record("rememberView").pipe(Effect.as(status)),
      rememberControl: record("rememberControl").pipe(Effect.as(status)),
      requestAvailability: record("availability").pipe(Effect.as(status)),
      releaseAvailability: record("releaseAvailability").pipe(Effect.as(status)),
      snapshot: () => record("snapshot").pipe(Effect.as(frame)),
      act: () => Effect.succeed([]),
      releaseInputs: record("releaseInputs"),
      cancelPendingAccess: record("cancel"),
      release: record("release"),
      forget: record("forget"),
      ...overrides,
    });
    yield* run.pipe(
      Effect.provide(
        ComputerUseCoordinator.layer.pipe(
          Layer.provideMerge(DesktopScreenPermissions.layer),
          Layer.provideMerge(
            DesktopGrants.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  FileSystem.FileSystem,
                  wrapFs ? wrapFs(instrumentedFs) : instrumentedFs,
                ),
              ),
            ),
          ),
          Layer.provideMerge(Layer.succeed(ComputerUse.ComputerUse, native)),
          Layer.provideMerge(UserDesktopIdentity.layer),
          Layer.provideMerge(
            Layer.succeed(ElectronDialog.ElectronDialog, {
              ...ElectronDialog.make,
              showMessageBox:
                prompt ??
                (() => record("prompt").pipe(Effect.as({ response: 1, checkboxChecked: false }))),
            }),
          ),
          Layer.provideMerge(
            Layer.effect(
              ElectronWindow.ElectronWindow,
              ElectronWindow.make.pipe(
                Effect.map((service) => ({ ...service, currentMainOrFirst: Effect.succeedNone })),
              ),
            ),
          ),
          Layer.provideMerge(environment),
        ),
      ),
      Effect.provideService(FileSystem.FileSystem, instrumentedFs),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
}

function availableAuthorization(
  permissions: DesktopScreenPermissions.DesktopScreenPermissions["Service"],
  context: DesktopComputerAutomationContext,
) {
  const snapshot = permissions.authorization(context);
  if (snapshot === undefined) return assert.fail("expected an available authorization snapshot");
  return snapshot;
}

describe("scoped desktop screen permissions", () => {
  it.effect.each(
    (["caller", "edited-owner"] as const).flatMap((target) =>
      (["staging", "submitted"] as const).map((phase) => ({ target, phase })),
    ),
  )(
    "fences the $target source at $phase without rolling back accepted publication",
    ({ target, phase }) =>
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let armed = false;
        let stopped = false;
        const pause = () =>
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(resume)));
        yield* withScreen(
          Effect.gen(function* () {
            const store = yield* DesktopGrants.DesktopGrants;
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const fs = yield* FileSystem.FileSystem;
            const caller = source();
            const other = {
              ...source("remote"),
              environmentId: EnvironmentId.make("remote"),
              connectionGeneration: "remote-generation",
              lifecycle: {
                ...source("remote").lifecycle!,
                environmentId: EnvironmentId.make("remote"),
              },
            };
            for (const current of [caller, other])
              yield* store.synchronize(
                { environmentId: current.environmentId!, threadId: current.threadId! },
                current.lifecycle!,
                current.connectionGeneration!,
              );
            const old = approveGrant({
              grantId: "remote-control",
              capability: "control",
              owner: { environmentId: other.environmentId, threadId: other.threadId! },
              source: other.lifecycle,
              now: store.now(),
              policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
            });
            const independent = {
              ...old,
              grantId: "independent-execution",
              capability: "execution" as const,
            };
            yield* store.withPermit(store.replace([old, independent]));
            const file = environment.path.join(
              environment.stateDir,
              "desktop-execution-grants.json",
            );
            const before = yield* fs.readFileString(file);
            armed = true;
            const pending = yield* permissions
              .request(
                { ...caller, controllerKind: "local" },
                "control",
                { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
                { grantId: old.grantId, revision: old.revision },
              )
              .pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(held);
            const invalidated = target === "caller" ? caller : other;
            store.invalidate(invalidated.environmentId!, invalidated.connectionGeneration!, [
              invalidated.threadId!,
            ]);
            yield* Deferred.succeed(resume, undefined);
            assert.equal(
              (yield* Fiber.join(pending))._tag,
              phase === "staging" ? "Failure" : "Success",
            );
            assert.deepEqual(
              store.list().filter((grant) => grant.capability === "execution"),
              [independent],
            );
            assert.equal(
              store.list().find((grant) => grant.grantId === old.grantId)?.revision,
              phase === "staging" ? 1 : 2,
            );
            if (phase === "staging") assert.equal(yield* fs.readFileString(file), before);
          }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined))),
          [],
          {},
          () => Effect.succeed({ response: 3, checkboxChecked: true }),
          undefined,
          (fs) => ({
            ...fs,
            writeFileString: (file, contents, options) =>
              Effect.suspend(() => {
                if (
                  !armed ||
                  stopped ||
                  phase !== "staging" ||
                  !file.includes("desktop-execution-grants.json.")
                )
                  return fs.writeFileString(file, contents, options);
                stopped = true;
                return fs.writeFileString(file, contents, options).pipe(Effect.andThen(pause()));
              }),
            rename: (from, to) =>
              Effect.suspend(() => {
                if (
                  !armed ||
                  stopped ||
                  phase !== "submitted" ||
                  !from.includes("desktop-execution-grants.json.")
                )
                  return fs.rename(from, to);
                stopped = true;
                return pause().pipe(Effect.andThen(fs.rename(from, to)));
              }),
          }),
        );
      }),
  );
  it.effect(
    "fails native status if publication becomes uncertain after its awaited storage check",
    () =>
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let armed = false;
        yield* withScreen(
          Effect.gen(function* () {
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const store = yield* DesktopGrants.DesktopGrants;
            const context = source();
            const owner = { environmentId: context.environmentId!, threadId: context.threadId! };
            yield* store.synchronize(owner, context.lifecycle!, context.connectionGeneration!);
            const old = approveGrant({
              grantId: "control",
              capability: "control",
              owner,
              source: context.lifecycle,
              now: store.now(),
              policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
            });
            yield* store.withPermit(store.replace([old]));
            const prune = store.prune;
            let hold = true;
            store.prune = Effect.suspend(() => {
              if (!hold) return prune;
              hold = false;
              return prune.pipe(
                Effect.andThen(Deferred.succeed(checked, undefined)),
                Effect.andThen(Deferred.await(resume)),
              );
            });
            const human = { ...context, controllerKind: "human" as const };
            const waiting = yield* permissions
              .invokeFromNativeBackend(human, { action: "status" })
              .pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(checked);
            armed = true;
            assert.equal(
              (yield* permissions
                .invokeFromNativeBackend(human, {
                  action: "edit",
                  capability: "control",
                  permission: { grantId: old.grantId, revision: old.revision },
                  policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: false },
                })
                .pipe(Effect.result))._tag,
              "Failure",
            );
            armed = false;
            yield* Deferred.succeed(resume, undefined);
            const result = yield* Fiber.join(waiting);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure")
              assert.include(String(result.failure), "publication could not be confirmed");
            assert.isUndefined(permissions.authorization(human));
          }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined))),
          [],
          {},
          undefined,
          undefined,
          (fs) => ({
            ...fs,
            rename: (from, to) =>
              Effect.suspend(() =>
                armed && from.includes("desktop-execution-grants.json.")
                  ? fs.rename(from, to).pipe(Effect.andThen(fs.rename(`${from}.missing`, to)))
                  : fs.rename(from, to),
              ),
          }),
        );
      }),
  );

  it.effect(
    "staging failure preserves prior bytes without blocking a subsequent human approval",
    () =>
      Effect.gen(function* () {
        let armed = false;
        yield* withScreen(
          Effect.gen(function* () {
            const store = yield* DesktopGrants.DesktopGrants;
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const fs = yield* FileSystem.FileSystem;
            const context = source();
            const owner = { environmentId: context.environmentId!, threadId: context.threadId! };
            yield* store.synchronize(owner, context.lifecycle!, context.connectionGeneration!);
            const old = approveGrant({
              grantId: "view",
              capability: "view",
              owner,
              source: context.lifecycle,
              now: store.now(),
              policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
            });
            yield* store.withPermit(store.replace([old]));
            const file = environment.path.join(
              environment.stateDir,
              "desktop-execution-grants.json",
            );
            const before = yield* fs.readFileString(file);
            const human = { ...context, controllerKind: "human" as const };
            const request = {
              action: "request",
              capability: "control",
              policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
            } as const;
            armed = true;
            assert.equal(
              (yield* permissions.invokeFromNativeBackend(human, request).pipe(Effect.result))._tag,
              "Failure",
            );
            armed = false;
            assert.equal(yield* fs.readFileString(file), before);
            assert.deepEqual(store.list(), [old]);
            assert.isDefined(permissions.authorization(human));
            assert.equal(
              (yield* permissions.invokeFromNativeBackend(human, request).pipe(Effect.result))._tag,
              "Success",
            );
            assert.equal(store.select(owner, "control")?.remembered, true);
          }),
          [],
          {},
          undefined,
          undefined,
          (fs) => ({
            ...fs,
            writeFileString: (file, contents, options) =>
              Effect.suspend(() =>
                fs.writeFileString(
                  armed && file.includes("desktop-execution-grants.json.")
                    ? `${file}/missing-parent`
                    : file,
                  contents,
                  options,
                ),
              ),
          }),
        );
      }),
  );
  it.effect.each(["before", "after"] as const)(
    "blocks every grant writer and reports unavailable authority after a submitted %s-publication error",
    (fault) =>
      Effect.gen(function* () {
        const renaming = yield* Deferred.make<void>();
        const finishRename = yield* Deferred.make<void>();
        const prompted = yield* Deferred.make<void>();
        const finishPrompt = yield* Deferred.make<void>();
        let armed = false;
        let uncertain = false;
        let writes = 0;
        const calls: string[] = [];
        yield* withScreen(
          Effect.gen(function* () {
            const store = yield* DesktopGrants.DesktopGrants;
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const fs = yield* FileSystem.FileSystem;
            const context = source();
            const owner = { environmentId: context.environmentId!, threadId: context.threadId! };
            yield* store.synchronize(owner, context.lifecycle!, context.connectionGeneration!);
            const old = approveGrant({
              grantId: "control",
              capability: "control",
              owner,
              source: context.lifecycle,
              now: store.now(),
              policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
            });
            const independent = [
              { ...old, grantId: "view", capability: "view" as const },
              { ...old, grantId: "execution", capability: "execution" as const },
            ];
            const before = [old, ...independent];
            yield* store.withPermit(store.replace(before));
            yield* coordinator.requestControl(context);
            const waiting = yield* permissions
              .request({ ...source("waiting"), controllerKind: "human" }, "view", {
                ...temporaryPolicy,
                lifetime: "until-revoked",
                remembered: true,
              })
              .pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(prompted);
            const human = {
              ...context,
              controllerKind: "human" as const,
              controllerId: "human:test",
            };
            const selected = store.select;
            let selections = 0;
            store.select = (...args) => {
              if (uncertain) selections++;
              return selected(...args);
            };
            armed = true;
            const edit = yield* permissions
              .invokeFromNativeBackend(human, {
                action: "edit",
                capability: "control",
                permission: { grantId: old.grantId, revision: old.revision },
                policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: false },
              })
              .pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(renaming);
            const queued = yield* store
              .withPermit(store.replace(before))
              .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
            yield* Deferred.succeed(finishRename, undefined);
            const outcome = yield* Fiber.join(edit);
            armed = false;
            assert.equal(outcome._tag, "Failure");
            if (outcome._tag === "Failure")
              assert.include(String(outcome.failure), "could not be confirmed");
            assert.equal((yield* Fiber.join(queued))._tag, "Failure");
            const file = environment.path.join(
              environment.stateDir,
              "desktop-execution-grants.json",
            );
            const actualBytes = yield* fs.readFileString(file);
            const actualWrites = writes;
            assert.deepEqual(store.list(), before);
            const disk = JSON.parse(actualBytes).grants;
            assert.sameDeepMembers(disk, fault === "before" ? before : independent);
            yield* Deferred.succeed(finishPrompt, undefined);
            assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
            const local = { ...human, controllerKind: "local" as const };
            for (const attempt of [
              store.withPermit(store.replace(before)),
              permissions.revoke(
                local,
                { grantId: independent[0]!.grantId, revision: independent[0]!.revision },
                true,
              ),
              permissions.revokeOwn(context),
              permissions.revokeAll,
              store.prune,
              store.synchronize(owner, context.lifecycle!, context.connectionGeneration!),
              permissions.invokeFromNativeBackend(human, { action: "status" }),
            ])
              assert.equal((yield* attempt.pipe(Effect.result))._tag, "Failure");
            const snapshot = yield* coordinator.status(human);
            assert.isUndefined(snapshot.authorization);
            assert.include(snapshot.detail!, "Native diagnostic.");
            assert.include(snapshot.detail!, "publication could not be confirmed");
            assert.equal(snapshot.available, status.available);
            assert.deepEqual(snapshot.displays, status.displays);
            assert.deepEqual(snapshot.rememberedAccess, status.rememberedAccess);
            assert.equal((yield* coordinator.release(human).pipe(Effect.result))._tag, "Success");
            assert.equal(
              (yield* coordinator.forceRelease(human).pipe(Effect.result))._tag,
              "Success",
            );
            const deniedOperations: ReadonlyArray<
              Effect.Effect<unknown, ComputerUse.ComputerUseError>
            > = [
              coordinator.requestView(context),
              coordinator.requestControl(context),
              coordinator.requestControl(human, { returnControlToAgent: true }),
              coordinator.act(context, { actions: [{ type: "press", key: "A" }] }),
            ];
            for (const attempt of deniedOperations)
              assert.equal((yield* attempt.pipe(Effect.result))._tag, "Failure");
            assert.equal(selections, 0);
            assert.equal(writes, actualWrites);
            assert.equal(yield* fs.readFileString(file), actualBytes);
            assert.deepEqual(store.list(), before);
            yield* Effect.gen(function* () {
              const fresh = yield* DesktopGrants.DesktopGrants;
              yield* fresh.synchronize(owner, context.lifecycle!, context.connectionGeneration!);
              assert.sameDeepMembers(fresh.list(), fault === "before" ? before : independent);
            }).pipe(Effect.provide(Layer.fresh(DesktopGrants.layer)));
          }).pipe(
            Effect.ensuring(
              Effect.all([
                Deferred.succeed(finishRename, undefined),
                Deferred.succeed(finishPrompt, undefined),
              ]),
            ),
          ),
          calls,
          { status: Effect.succeed({ ...status, detail: "Native diagnostic." }) },
          (options) =>
            Deferred.succeed(prompted, undefined).pipe(
              Effect.andThen(Deferred.await(finishPrompt)),
              Effect.as({ response: options.buttons!.length - 1, checkboxChecked: true }),
            ),
          undefined,
          (fs) => ({
            ...fs,
            writeFileString: (file, contents, options) =>
              Effect.suspend(() => {
                if (file.includes("desktop-execution-grants.json.")) writes++;
                return fs.writeFileString(file, contents, options);
              }),
            rename: (from, to) =>
              Effect.suspend(() => {
                if (!armed || !from.includes("desktop-execution-grants.json."))
                  return fs.rename(from, to);
                return Deferred.succeed(renaming, undefined).pipe(
                  Effect.andThen(Deferred.await(finishRename)),
                  Effect.andThen(fault === "after" ? fs.rename(from, to) : Effect.void),
                  Effect.andThen(
                    Effect.sync(() => {
                      uncertain = true;
                    }),
                  ),
                  Effect.andThen(fs.rename(`${from}.missing`, to)),
                );
              }),
          }),
        );
      }),
  );

  it.effect.each([
    { kind: "local", scope: "thread" },
    { kind: "local", scope: "thread", cross: true },
    { kind: "local", scope: "thread", cross: true, session: true },
    { kind: "local", scope: "environment" },
    { kind: "local", scope: "environment", cross: true },
    { kind: "local", scope: "environment", cross: true, callerGrant: true },
    { kind: "local", scope: "environment", cross: true, callerGrant: true, capability: "view" },
    { kind: "local", scope: "environment", cross: true, session: true },
    { kind: "local", scope: "desktop" },
    { kind: "local", scope: "desktop", capability: "view", session: true },
    { kind: "human", scope: "thread" },
    { kind: "human", scope: "environment" },
    { kind: "human", scope: "thread", cross: true },
    { kind: "human", scope: "environment", cross: true },
    { kind: "agent", scope: "thread" },
    { kind: "agent", scope: "environment" },
    { kind: "local", scope: "environment", cross: true, offline: true },
    { kind: "local", scope: "thread", cross: true, offline: true },
  ] satisfies ReadonlyArray<{
    kind: "local" | "human" | "agent";
    scope: "thread" | "environment" | "desktop";
    cross?: boolean;
    session?: boolean;
    callerGrant?: boolean;
    capability?: "view";
    offline?: boolean;
  }>)("edits only the selected target: %j", (spec) =>
    withScreen(
      Effect.gen(function* () {
        const store = yield* DesktopGrants.DesktopGrants;
        const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const caller = source();
        const other = source("other-thread");
        const remote = spec.cross
          ? {
              ...other,
              environmentId: EnvironmentId.make("other-environment"),
              connectionGeneration: "other-generation",
              lifecycle: {
                ...other.lifecycle!,
                environmentId: EnvironmentId.make("other-environment"),
              },
            }
          : other;
        for (const context of [caller, remote])
          yield* store.synchronize(
            { environmentId: context.environmentId!, threadId: context.threadId! },
            context.lifecycle!,
            context.connectionGeneration!,
          );
        const makeGrant = (
          context: DesktopComputerAutomationContext,
          grantId: string,
          capability: "view" | "control" | "execution",
          scope: "thread" | "environment" | "desktop" = "thread",
        ) =>
          approveGrant({
            grantId,
            capability,
            owner: { environmentId: context.environmentId!, threadId: context.threadId! },
            source: context.lifecycle,
            now: store.now(),
            policy: { ...temporaryPolicy, scope, lifetime: "until-revoked", remembered: true },
          });
        const capability = spec.capability ?? "control";
        const old = makeGrant(remote, "selected-grant", capability, spec.scope);
        const independent = [
          makeGrant(source("independent"), "independent-execution", "execution"),
          makeGrant(
            source("independent"),
            "independent-screen",
            capability === "control" ? "view" : "control",
          ),
        ];
        if (spec.callerGrant)
          independent.push(makeGrant(caller, "caller-grant", capability, "environment"));
        yield* store.withPermit(store.replace([old, ...independent]));
        if (spec.offline)
          store.invalidate(remote.environmentId!, remote.connectionGeneration!, [remote.threadId!]);
        const file = environment.path.join(environment.stateDir, "desktop-execution-grants.json");
        const before = yield* fs.readFileString(file);
        const result = yield* permissions
          .request(
            { ...caller, controllerKind: spec.kind, controllerId: `${spec.kind}:settings` },
            capability,
            {
              ...temporaryPolicy,
              scope: spec.scope,
              lifetime: "until-revoked",
              remembered: !spec.session,
            },
            { grantId: old.grantId, revision: old.revision },
          )
          .pipe(Effect.result);
        const accepts = spec.kind === "local" || (spec.kind === "human" && !spec.cross);
        assert.equal(result._tag, accepts ? "Success" : "Failure");
        const next = store.list().find((grant) => grant.grantId === old.grantId);
        assert.deepEqual(
          store.list().filter((grant) => grant.grantId !== old.grantId),
          independent,
        );
        if (accepts) {
          assert.equal(store.list().length, independent.length + 1);
          assert.equal(next?.revision, 2);
          assert.equal(next?.remembered, !spec.session);
          for (const key of [
            "grantId",
            "capability",
            "scope",
            "environmentId",
            "threadId",
          ] as const)
            assert.equal(next?.[key], old[key]);
        } else {
          assert.equal(yield* fs.readFileString(file), before);
          assert.deepEqual(next, old);
        }
        const disk = JSON.parse(yield* fs.readFileString(file)).grants;
        const revision = accepts && spec.session ? undefined : accepts ? 2 : 1;
        assert.equal(
          disk.find((grant: { grantId: string }) => grant.grantId === old.grantId)?.revision,
          revision,
        );
        yield* Effect.gen(function* () {
          const fresh = yield* DesktopGrants.DesktopGrants;
          assert.equal(
            fresh.list().find((grant) => grant.grantId === old.grantId)?.revision,
            revision,
          );
          assert.sameDeepMembers(
            fresh.list().filter((grant) => grant.grantId !== old.grantId),
            independent,
          );
        }).pipe(Effect.provide(Layer.fresh(DesktopGrants.layer)));
      }),
      [],
      {},
      (options) =>
        Effect.succeed({ response: options.buttons!.length - 1, checkboxChecked: !spec.session }),
    ),
  );

  it.effect.each([
    ...(
      [
        "none",
        "absent-before",
        "invalidated",
        "disconnected",
        "equivalent-refresh",
        "source-advance",
        "generation-change",
        "deleted",
      ] as const
    ).map((change) => ({ seam: "consent" as const, change })),
    ...(["none", "absent-before", "invalidated", "disconnected"] as const).map((change) => ({
      seam: "synchronize" as const,
      change,
    })),
  ])("rechecks the edited owner through $seam after $change", ({ seam, change }) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      yield* withScreen(
        Effect.gen(function* () {
          const store = yield* DesktopGrants.DesktopGrants;
          const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fs = yield* FileSystem.FileSystem;
          const caller = source();
          const remote = {
            ...source("remote"),
            environmentId: EnvironmentId.make("remote-environment"),
            connectionGeneration: "remote-generation",
          };
          remote.lifecycle = { ...remote.lifecycle!, environmentId: remote.environmentId };
          const owner = { environmentId: remote.environmentId, threadId: remote.threadId! };
          yield* store.synchronize(owner, remote.lifecycle, remote.connectionGeneration);
          const old = approveGrant({
            grantId: "edited-control",
            capability: "control",
            owner,
            source: remote.lifecycle,
            now: store.now(),
            policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
          });
          const independent = {
            ...old,
            grantId: "independent-execution",
            capability: "execution" as const,
          };
          yield* store.withPermit(store.replace([old, independent]));
          if (change === "absent-before")
            store.invalidate(owner.environmentId, remote.connectionGeneration, [owner.threadId]);
          const synchronize = store.synchronize;
          let wait = seam === "synchronize";
          store.synchronize = (...args) =>
            Effect.suspend(() => {
              if (!wait) return synchronize(...args);
              wait = false;
              return Deferred.succeed(held, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(synchronize(...args)),
              );
            });
          const editing = yield* permissions
            .request(
              { ...caller, controllerKind: "local", controllerId: "local-settings" },
              "control",
              { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
              { grantId: old.grantId, revision: old.revision },
            )
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(held);
          if (change === "invalidated")
            store.invalidate(owner.environmentId, remote.connectionGeneration, [owner.threadId]);
          if (change === "disconnected")
            store.disconnect(owner.environmentId, remote.connectionGeneration);
          if (change === "equivalent-refresh")
            yield* synchronize(owner, { ...remote.lifecycle }, remote.connectionGeneration);
          if (change === "source-advance")
            yield* synchronize(
              owner,
              { ...remote.lifecycle, revision: 2, activityRevision: 2 },
              remote.connectionGeneration,
            );
          if (change === "generation-change") {
            store.connect(owner.environmentId, "replacement");
            yield* synchronize(owner, { ...remote.lifecycle }, "replacement");
          }
          if (change === "deleted")
            yield* synchronize(
              owner,
              { ...remote.lifecycle, state: "deleted", revision: 2 },
              remote.connectionGeneration,
            );
          const file = environment.path.join(environment.stateDir, "desktop-execution-grants.json");
          const before = yield* fs.readFileString(file);
          const memory = store.list();
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(editing);
          store.synchronize = synchronize;
          const accepts = [
            "none",
            "absent-before",
            "equivalent-refresh",
            "source-advance",
          ].includes(change);
          assert.equal(result._tag, accepts ? "Success" : "Failure");
          assert.deepEqual(
            store.list().filter((grant) => grant.capability === "execution"),
            memory.filter((grant) => grant.capability === "execution"),
          );
          const next = store.list().find((grant) => grant.grantId === old.grantId);
          if (accepts) {
            assert.equal(next?.revision, 2);
            assert.equal(next?.environmentId, owner.environmentId);
            assert.equal(next?.threadId, owner.threadId);
          } else {
            assert.equal(yield* fs.readFileString(file), before);
            assert.deepEqual(store.list(), memory);
          }
          yield* Effect.gen(function* () {
            const fresh = yield* DesktopGrants.DesktopGrants;
            assert.equal(
              fresh.list().find((grant) => grant.grantId === old.grantId)?.revision,
              next?.revision,
            );
          }).pipe(Effect.provide(Layer.fresh(DesktopGrants.layer)));
        }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined))),
        [],
        {},
        () =>
          (seam === "consent"
            ? Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(resume)))
            : Effect.void
          ).pipe(Effect.as({ response: 3, checkboxChecked: true })),
      );
    }),
  );

  it.effect.each(
    (["initial", "edit"] as const).flatMap((mode) =>
      [false, true].flatMap((remembered) =>
        (["write", "submit", "renamed", "cleanup"] as const).flatMap((phase) =>
          (["none", "human-release", "agent-release", "fiber", "invalidate"] as const).map(
            (action) => ({ mode, remembered, phase, action }),
          ),
        ),
      ),
    ),
  )(
    "publishes $mode remembered=$remembered at $phase independently of $action",
    ({ mode, remembered, phase, action }) =>
      Effect.gen(function* () {
        const saving = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const prompted = yield* Deferred.make<void>();
        const cancellationSeen = yield* Deferred.make<void>();
        const calls: string[] = [];
        let armed = false;
        let held = false;
        const pause = () =>
          Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(resume)));
        yield* withScreen(
          Effect.gen(function* () {
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const store = yield* DesktopGrants.DesktopGrants;
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const fs = yield* FileSystem.FileSystem;
            const context = source();
            const human = {
              ...context,
              controllerId: "human:publisher",
              controllerKind: "human" as const,
              connectionGeneration: "private-generation",
            };
            const owner = { environmentId: context.environmentId!, threadId: context.threadId! };
            yield* store.synchronize(owner, context.lifecycle!, context.connectionGeneration!);
            const old = approveGrant({
              grantId: "prior-control",
              capability: "control",
              owner,
              source: context.lifecycle,
              now: store.now(),
              policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
            });
            const independent = [
              { ...old, grantId: "independent-execution", capability: "execution" as const },
              {
                ...old,
                grantId: "independent-view",
                capability: "view" as const,
                threadId: ThreadId.make("independent"),
              },
              { ...old, grantId: "independent-control", threadId: ThreadId.make("independent") },
            ];
            const before = [...(mode === "edit" ? [old] : []), ...independent];
            yield* store.withPermit(store.replace(before));
            const file = environment.path.join(
              environment.stateDir,
              "desktop-execution-grants.json",
            );
            const beforeBytes = yield* fs.readFileString(file);
            const realCancel = permissions.cancel;
            permissions.cancel = (caller) =>
              realCancel(caller).pipe(
                Effect.tap(() => Deferred.succeed(cancellationSeen, undefined)),
              );
            const policy = { ...temporaryPolicy, lifetime: "until-revoked" as const, remembered };
            armed = mode === "edit";
            const original =
              mode === "initial"
                ? yield* coordinator.requestControl(context).pipe(
                    Effect.asVoid,
                    Effect.result,
                    Effect.map((result) => ({ _tag: result._tag })),
                    Effect.forkChild,
                  )
                : yield* permissions
                    .invokeFromNativeBackend(human, {
                      action: "edit",
                      capability: "control",
                      permission: { grantId: old.grantId, revision: old.revision },
                      policy,
                    })
                    .pipe(
                      Effect.asVoid,
                      Effect.result,
                      Effect.map((result) => ({ _tag: result._tag })),
                      Effect.forkChild,
                    );
            if (mode === "initial") yield* Deferred.await(prompted);
            const snapshot = permissions.authorization(human);
            assert.isDefined(snapshot);
            const requestId = snapshot!.pendingRequests?.[0]?.requestId;
            armed = true;
            const decision =
              mode === "initial"
                ? yield* permissions
                    .invokeFromNativeBackend(human, {
                      action: "approve",
                      requestId: requestId!,
                      policy,
                    })
                    .pipe(
                      Effect.asVoid,
                      Effect.result,
                      Effect.map((result) => ({ _tag: result._tag })),
                      Effect.forkChild,
                    )
                : undefined;
            yield* Deferred.await(saving);
            const cancellation =
              action === "fiber"
                ? yield* Fiber.interrupt(original).pipe(
                    Effect.asVoid,
                    Effect.forkChild({ startImmediately: true }),
                  )
                : action === "human-release" || action === "agent-release"
                  ? yield* coordinator
                      .release(action === "human-release" ? human : context)
                      .pipe(Effect.asVoid, Effect.forkChild({ startImmediately: true }))
                  : undefined;
            if (action === "human-release" || action === "agent-release")
              yield* Deferred.await(cancellationSeen);
            if (action === "invalidate")
              store.invalidate(owner.environmentId, context.connectionGeneration!, [
                owner.threadId,
              ]);
            yield* Deferred.succeed(resume, undefined);
            if (cancellation) yield* Fiber.await(cancellation);
            const decided = decision ? yield* Fiber.join(decision) : undefined;
            const originalExit = yield* Fiber.await(original);
            armed = false;
            const accepted = phase !== "write" || action === "none";
            const acquired = mode === "initial" && accepted && action === "none";
            if (decided) assert.equal(decided._tag, accepted ? "Success" : "Failure");
            if (mode === "initial")
              assert.equal(
                originalExit._tag === "Success" && originalExit.value._tag === "Success",
                acquired,
              );
            else if (action !== "fiber") {
              assert.isTrue(originalExit._tag === "Success");
              if (originalExit._tag === "Success")
                assert.equal(originalExit.value._tag, accepted ? "Success" : "Failure");
            }
            assert.equal(calls.includes("control"), acquired);
            const memory = store.list();
            const disk = JSON.parse(yield* fs.readFileString(file));
            assert.sameDeepMembers(
              memory.filter((grant) => grant.grantId.startsWith("independent-")),
              independent,
            );
            assert.sameDeepMembers(
              disk.grants.filter((grant: { grantId: string }) =>
                grant.grantId.startsWith("independent-"),
              ),
              independent,
            );
            if (!accepted) {
              assert.deepEqual(memory, before);
              assert.equal(yield* fs.readFileString(file), beforeBytes);
            } else {
              const next = memory.find(
                (grant) => grant.capability === "control" && grant.threadId === owner.threadId,
              );
              assert.isDefined(next);
              assert.equal(next!.remembered, remembered);
              assert.equal(next!.revision, mode === "edit" ? old.revision + 1 : 1);
              assert.equal(
                disk.grants.some(
                  (grant: { capability: string; threadId: string }) =>
                    grant.capability === "control" && grant.threadId === owner.threadId,
                ),
                remembered,
              );
            }
            if (mode === "initial" && !acquired) {
              assert.equal(
                (yield* coordinator
                  .act(context, { actions: [{ type: "press", key: "A" }] })
                  .pipe(Effect.result))._tag,
                "Failure",
              );
            }
            yield* Effect.gen(function* () {
              const restored = yield* DesktopGrants.DesktopGrants;
              yield* restored.synchronize(owner, context.lifecycle!, context.connectionGeneration!);
              assert.sameDeepMembers(
                restored.list().filter((grant) => grant.grantId.startsWith("independent-")),
                independent,
              );
              assert.equal(
                restored.select(owner, "control") !== undefined,
                accepted ? remembered : mode === "edit",
              );
            }).pipe(Effect.provide(Layer.fresh(DesktopGrants.layer)));
          }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined))),
          calls,
          {},
          () => Deferred.succeed(prompted, undefined).pipe(Effect.andThen(Effect.never)),
          undefined,
          (fs) => ({
            ...fs,
            writeFileString: (file, contents, options) =>
              Effect.suspend(() => {
                if (
                  armed &&
                  !held &&
                  phase === "write" &&
                  file.includes("desktop-execution-grants.json.")
                ) {
                  held = true;
                  return fs.writeFileString(file, contents, options).pipe(Effect.andThen(pause()));
                }
                return fs.writeFileString(file, contents, options);
              }),
            rename: (from, to) =>
              Effect.suspend(() => {
                if (armed && !held && from.includes("desktop-execution-grants.json.")) {
                  if (phase === "submit") {
                    held = true;
                    return pause().pipe(Effect.andThen(fs.rename(from, to)));
                  }
                  if (phase === "renamed") {
                    held = true;
                    return fs.rename(from, to).pipe(Effect.andThen(pause()));
                  }
                }
                return fs.rename(from, to);
              }),
            remove: (file, options) =>
              Effect.suspend(() => {
                if (
                  armed &&
                  !held &&
                  phase === "cleanup" &&
                  file.includes("desktop-execution-grants.json.")
                ) {
                  held = true;
                  return pause().pipe(Effect.andThen(fs.remove(file, options)));
                }
                return fs.remove(file, options);
              }),
          }),
        );
      }),
  );

  it.effect.each(
    (["write", "publication"] as const).flatMap((phase) =>
      [false, true].map((expired) => ({ phase, expired })),
    ),
  )(
    "keeps the publication outcome when cancelling $phase with expired=$expired",
    ({ phase, expired }) =>
      Effect.gen(function* () {
        const saving = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const calls: string[] = [];
        let holdSave = false;
        const beforeSave = (file: string) =>
          Effect.suspend(() => {
            if (!holdSave || !file.includes("desktop-execution-grants.json.")) return Effect.void;
            holdSave = false;
            return Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(resume)));
          });
        yield* withScreen(
          Effect.gen(function* () {
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const store = yield* DesktopGrants.DesktopGrants;
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const fs = yield* FileSystem.FileSystem;
            const context = source();
            const principal = {
              environmentId: context.environmentId!,
              threadId: context.threadId!,
            };
            yield* store.synchronize(principal, context.lifecycle!, context.connectionGeneration!);
            const previous = approveGrant({
              grantId: "remembered-control",
              capability: "control",
              owner: principal,
              source: context.lifecycle,
              now: store.now(),
              policy: { ...temporaryPolicy, lifetime: "until-revoked", remembered: true },
            });
            const independent = {
              ...previous,
              grantId: "independent-execution",
              capability: "execution" as const,
            };
            yield* store.withPermit(store.replace([previous, independent]));
            const human = {
              ...context,
              controllerKind: "human" as const,
              connectionGeneration: "private-native-generation",
            };
            holdSave = true;
            const edit = yield* permissions
              .invokeFromNativeBackend(human, {
                action: "edit",
                capability: "control",
                permission: { grantId: previous.grantId, revision: previous.revision },
                policy: {
                  ...temporaryPolicy,
                  lifetime: "until-time",
                  remembered: true,
                  deadline: "1970-01-01T00:01:00.000Z",
                },
              })
              .pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(saving);
            if (expired) yield* TestClock.adjust("2 minutes");
            yield* coordinator.release(human);
            yield* Deferred.succeed(resume, undefined);
            const accepted = phase === "publication";
            assert.equal((yield* Fiber.join(edit))._tag, accepted ? "Success" : "Failure");
            const current = store.list().find((grant) => grant.grantId === previous.grantId);
            if (!accepted) assert.deepEqual(current, previous);
            else if (expired) assert.isUndefined(current);
            else assert.equal(current?.revision, previous.revision + 1);
            assert.deepEqual(
              store.list().filter((grant) => grant.capability === "execution"),
              [independent],
            );
            const persisted = JSON.parse(
              yield* fs.readFileString(
                environment.path.join(environment.stateDir, "desktop-execution-grants.json"),
              ),
            );
            const saved = persisted.grants.find(
              (grant: { grantId: string }) => grant.grantId === previous.grantId,
            );
            assert.equal(saved?.revision, accepted ? previous.revision + 1 : previous.revision);
            yield* Effect.gen(function* () {
              const restored = yield* DesktopGrants.DesktopGrants;
              yield* restored.synchronize(
                principal,
                context.lifecycle!,
                context.connectionGeneration!,
              );
              const restoredControl = restored.select(principal, "control");
              assert.equal(restoredControl?.revision, accepted ? (expired ? undefined : 2) : 1);
              assert.deepEqual(
                restored.list().filter((grant) => grant.capability === "execution"),
                [independent],
              );
            }).pipe(Effect.provide(Layer.fresh(DesktopGrants.layer)));
            assert.notInclude(calls, "control");
          }),
          calls,
          {},
          undefined,
          undefined,
          (fs) => ({
            ...fs,
            writeFileString: (file, contents, options) =>
              (phase === "write" ? beforeSave(file) : Effect.void).pipe(
                Effect.andThen(fs.writeFileString(file, contents, options)),
              ),
            remove: (file, options) =>
              (phase === "publication" ? beforeSave(file) : Effect.void).pipe(
                Effect.andThen(fs.remove(file, options)),
              ),
          }),
        );
      }),
  );

  it.effect.each(
    (["write", "rename"] as const).flatMap((phase) =>
      (["invalidate", "disconnect", "replacement", "unrelated"] as const).map((loss) => ({
        phase,
        loss,
      })),
    ),
  )("fences $loss source changes during approval $phase", ({ phase, loss }) =>
    Effect.gen(function* () {
      const prompted = yield* Deferred.make<void>();
      const reprompted = yield* Deferred.make<void>();
      const saving = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const calls: string[] = [];
      let holdSave = false;
      let prompts = 0;
      const beforeSave = (file: string) =>
        Effect.suspend(() => {
          if (!holdSave || !file.includes("desktop-execution-grants.json.")) return Effect.void;
          holdSave = false;
          return Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(resume)));
        });
      yield* withScreen(
        Effect.gen(function* () {
          const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const store = yield* DesktopGrants.DesktopGrants;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fs = yield* FileSystem.FileSystem;
          const context = source();
          const principal = { environmentId: context.environmentId!, threadId: context.threadId! };
          const independentContext = source("independent");
          const independent = approveGrant({
            grantId: "independent-execution",
            capability: "execution",
            owner: { ...principal, threadId: independentContext.threadId! },
            source: independentContext.lifecycle,
            now: store.now(),
            policy: { ...temporaryPolicy, remembered: true },
          });
          yield* store.withPermit(store.replace([independent]));
          const original = yield* coordinator
            .requestControl(context)
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(prompted);
          const human = {
            ...context,
            controllerKind: "human" as const,
            connectionGeneration: "private-native-generation",
          };
          const requestId = availableAuthorization(permissions, human).pendingRequests![0]!
            .requestId;
          holdSave = true;
          const decision = yield* permissions
            .invokeFromNativeBackend(human, {
              action: "approve",
              requestId,
              policy: { ...temporaryPolicy, remembered: true },
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(saving);
          if (loss === "disconnect")
            store.disconnect(principal.environmentId, context.connectionGeneration!);
          else if (loss === "replacement")
            store.connect(principal.environmentId, "replacement-generation");
          else
            store.invalidate(principal.environmentId, context.connectionGeneration!, [
              loss === "unrelated" ? independentContext.threadId! : principal.threadId,
            ]);
          yield* Deferred.succeed(resume, undefined);
          const decisionResult = yield* Fiber.join(decision);
          const originalResult = yield* Fiber.join(original);
          const accepted = phase === "rename" || loss === "unrelated";
          const acquired = loss === "unrelated";
          assert.equal(decisionResult._tag, accepted ? "Success" : "Failure");
          assert.equal(originalResult._tag, acquired ? "Success" : "Failure");
          const persisted = JSON.parse(
            yield* fs.readFileString(
              environment.path.join(environment.stateDir, "desktop-execution-grants.json"),
            ),
          );
          assert.deepEqual(persisted.grants, store.list());
          assert.deepEqual(
            store.list().filter((grant) => grant.capability === "execution"),
            [independent],
          );
          assert.lengthOf(store.list(), accepted ? 2 : 1);
          assert.equal(calls.includes("control"), acquired);
          const generation =
            loss === "disconnect" || loss === "replacement"
              ? "fresh-automation-generation"
              : context.connectionGeneration!;
          assert.isTrue(store.connect(principal.environmentId, generation));
          yield* store.synchronize(principal, context.lifecycle!, generation);
          assert.equal(store.select(principal, "control") !== undefined, accepted);
          yield* Effect.gen(function* () {
            const restored = yield* DesktopGrants.DesktopGrants;
            yield* restored.synchronize(principal, context.lifecycle!, generation);
            assert.equal(restored.select(principal, "control") !== undefined, accepted);
          }).pipe(Effect.provide(Layer.fresh(DesktopGrants.layer)));
          if (!accepted) {
            const retryContext = { ...context, connectionGeneration: generation };
            const retry = yield* coordinator.requestControl(retryContext).pipe(Effect.forkChild);
            yield* Deferred.await(reprompted);
            assert.equal(prompts, 2);
            yield* coordinator.release(retryContext);
            yield* Fiber.join(retry).pipe(Effect.flip);
          }
        }),
        calls,
        {},
        () => {
          prompts++;
          return Deferred.succeed(prompts === 1 ? prompted : reprompted, undefined).pipe(
            Effect.andThen(Effect.never),
          );
        },
        undefined,
        (fs) => ({
          ...fs,
          writeFileString: (file, contents, options) =>
            (phase === "write" ? beforeSave(file) : Effect.void).pipe(
              Effect.andThen(fs.writeFileString(file, contents, options)),
            ),
          rename: (from, to) =>
            (phase === "rename" ? beforeSave(from) : Effect.void).pipe(
              Effect.andThen(fs.rename(from, to)),
            ),
        }),
      );
    }),
  );

  it.effect("rejects queued screen admission after source invalidation", () =>
    withScreen(
      Effect.gen(function* () {
        const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
        const store = yield* DesktopGrants.DesktopGrants;
        const context = source();
        yield* coordinator.requestView(context);
        const resume = yield* Deferred.make<void>();
        const blocking = yield* store
          .withPermit(Deferred.await(resume))
          .pipe(Effect.forkChild({ startImmediately: true }));
        const reading = yield* coordinator
          .snapshot(context, {})
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        store.invalidate(context.environmentId!, context.connectionGeneration!, [
          context.threadId!,
        ]);
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(blocking);
        assert.equal((yield* Fiber.join(reading))._tag, "Failure");
        yield* coordinator.requestView(context);
        yield* coordinator.snapshot(context, {});
      }),
      [],
    ),
  );

  it.effect("withholds a captured frame when obsolete lifecycle persistence finishes", () =>
    Effect.gen(function* () {
      const captured = yield* Deferred.make<void>();
      const finishFrame = yield* Deferred.make<void>();
      const persisting = yield* Deferred.make<void>();
      const finishPersist = yield* Deferred.make<void>();
      let hold = false;
      yield* withScreen(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const store = yield* DesktopGrants.DesktopGrants;
          const context = source();
          const owner = { environmentId: context.environmentId!, threadId: context.threadId! };
          yield* coordinator.requestView(context);
          const reading = yield* coordinator
            .snapshot(context, {})
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(captured);
          hold = true;
          const updating = yield* store
            .synchronize(
              owner,
              { ...context.lifecycle!, revision: 2, activityRevision: 2 },
              context.connectionGeneration!,
            )
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(persisting);
          store.invalidate(owner.environmentId, context.connectionGeneration!, [owner.threadId]);
          yield* Deferred.succeed(finishPersist, undefined);
          yield* Fiber.join(updating);
          yield* Deferred.succeed(finishFrame, undefined);
          assert.equal((yield* Fiber.join(reading))._tag, "Failure");
          assert.isUndefined(store.select(owner, "view"));
        }),
        [],
        {
          snapshot: () =>
            Deferred.succeed(captured, undefined).pipe(
              Effect.andThen(Deferred.await(finishFrame)),
              Effect.as(frame),
            ),
        },
        undefined,
        () =>
          hold
            ? Deferred.succeed(persisting, undefined).pipe(
                Effect.andThen(Deferred.await(finishPersist)),
              )
            : Effect.void,
      );
    }),
  );

  it.effect.each([
    { operation: "release", phase: "write" },
    { operation: "interrupt", phase: "write" },
    { operation: "fiber", phase: "write" },
    { operation: "release", phase: "publication" },
    { operation: "interrupt", phase: "publication" },
    { operation: "fiber", phase: "publication" },
  ] as const)(
    "$operation during native approval $phase preserves its publication outcome",
    ({ operation, phase }) =>
      Effect.gen(function* () {
        const prompted = yield* Deferred.make<void>();
        const reprompted = yield* Deferred.make<void>();
        const saving = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let prompts = 0;
        let holdSave = false;
        const calls: string[] = [];
        yield* withScreen(
          Effect.gen(function* () {
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const store = yield* DesktopGrants.DesktopGrants;
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const fs = yield* FileSystem.FileSystem;
            const context = source();
            const independent = approveGrant({
              grantId: "independent-execution",
              capability: "execution",
              owner: { environmentId: context.environmentId!, threadId: context.threadId! },
              source: context.lifecycle,
              now: store.now(),
              policy: { ...temporaryPolicy, remembered: true },
            });
            yield* store.withPermit(store.replace([independent]));
            const original = yield* coordinator.requestControl(context).pipe(Effect.forkChild);
            yield* Deferred.await(prompted);
            const human = { ...context, controllerKind: "human" as const };
            const requestId = availableAuthorization(permissions, human).pendingRequests![0]!
              .requestId;
            holdSave = true;
            const decision = yield* permissions
              .invokeFromNativeBackend(human, {
                action: "approve",
                requestId,
                policy: { ...temporaryPolicy, remembered: true },
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(saving);
            const cancellation = yield* (
              operation === "fiber" ? Fiber.interrupt(original) : coordinator[operation](context)
            ).pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.succeed(resume, undefined);
            yield* Fiber.join(cancellation);
            const originalExit = yield* Fiber.await(original);
            assert.equal(originalExit._tag, "Failure");
            const decisionResult = yield* Fiber.join(decision).pipe(Effect.result);
            const accepted = phase === "publication";
            assert.equal(decisionResult._tag, accepted ? "Success" : "Failure");
            assert.deepEqual(
              store.list().filter((grant) => grant.capability === "execution"),
              [independent],
            );
            const persisted = JSON.parse(
              yield* fs.readFileString(
                environment.path.join(environment.stateDir, "desktop-execution-grants.json"),
              ),
            );
            assert.equal(
              persisted.grants.some(
                (grant: { capability: string }) => grant.capability === "control",
              ),
              accepted,
            );
            const restored = yield* Effect.gen(function* () {
              const reloaded = yield* DesktopGrants.DesktopGrants;
              const owner = { environmentId: context.environmentId!, threadId: context.threadId! };
              yield* reloaded.synchronize(owner, context.lifecycle!, context.connectionGeneration!);
              return reloaded.select(owner, "control");
            }).pipe(Effect.provide(Layer.fresh(DesktopGrants.layer)));
            assert.equal(restored !== undefined, accepted);
            assert.notInclude(calls, "control");
            const retry = yield* coordinator
              .requestControl(context)
              .pipe(Effect.result, Effect.forkChild);
            if (accepted) {
              assert.equal((yield* Fiber.join(retry))._tag, "Success");
              assert.equal(prompts, 1);
              yield* coordinator.release(context);
            } else {
              yield* Deferred.await(reprompted);
              assert.equal(prompts, 2);
              yield* coordinator.release(context);
              assert.equal((yield* Fiber.join(retry))._tag, "Failure");
            }
          }),
          calls,
          {},
          () => {
            prompts++;
            return Deferred.succeed(prompts === 1 ? prompted : reprompted, undefined).pipe(
              Effect.andThen(Effect.never),
            );
          },
          undefined,
          (fs) => ({
            ...fs,
            writeFileString: (file, contents, options) =>
              holdSave && phase === "write" && file.includes("desktop-execution-grants.json.")
                ? Deferred.succeed(saving, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(fs.writeFileString(file, contents, options)),
                  )
                : fs.writeFileString(file, contents, options),
            remove: (file, options) =>
              holdSave && phase === "publication" && file.includes("desktop-execution-grants.json.")
                ? Deferred.succeed(saving, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(fs.remove(file, options)),
                  )
                : fs.remove(file, options),
          }),
        );
      }),
  );

  it.effect(
    "approves a named pending request through the native channel while retaining OS consent",
    () =>
      Effect.gen(function* () {
        const prompted = yield* Deferred.make<void>();
        const calls: string[] = [];
        const context = {
          ...source("named-thread"),
          lifecycle: {
            ...source("named-thread").lifecycle!,
            source: {
              environmentLabel: "coolcrab",
              projectName: "T3 Code",
              threadTitle: "Restore Wonder Full",
            },
          },
        };
        yield* withScreen(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const store = yield* DesktopGrants.DesktopGrants;
            const work = yield* coordinator.requestControl(context).pipe(Effect.forkChild);
            yield* Deferred.await(prompted);
            assert.notInclude(calls, "control");
            const human = {
              ...context,
              controllerKind: "human" as const,
              connectionGeneration: "private-native-generation",
            };
            const pending = availableAuthorization(permissions, human).pendingRequests!;
            assert.lengthOf(pending, 1);
            assert.equal(pending[0]!.source?.threadTitle, "Restore Wonder Full");
            const input = {
              action: "approve" as const,
              requestId: pending[0]!.requestId,
              policy: temporaryPolicy,
            };
            for (const rejected of [
              { ...human, environmentId: EnvironmentId.make("foreign") },
              { ...human, threadId: ThreadId.make("different-thread") },
              { ...context, controllerKind: "agent" as const },
            ]) {
              yield* permissions.invokeFromNativeBackend(rejected, input).pipe(Effect.flip);
              assert.isEmpty(store.list());
            }
            const approved = yield* permissions.invokeFromNativeBackend(human, input);
            assert.isTrue(approved.remoteApprovalAvailable);
            assert.isEmpty(approved.pendingRequests);
            yield* Fiber.join(work);
            assert.include(calls, "control");
            assert.equal(store.list()[0]!.threadId, context.threadId);
            assert.equal(store.list()[0]!.source?.projectName, "T3 Code");
            yield* coordinator.release(context);
            assert.lengthOf(store.list(), 1);
            yield* permissions.invokeFromNativeBackend(human, {
              action: "remove",
              permission: {
                grantId: store.list()[0]!.grantId,
                revision: store.list()[0]!.revision,
              },
            });
            assert.isEmpty(store.list());
          }),
          calls,
          {},
          (options) => {
            assert.include(options.detail!, "Thread: Restore Wonder Full");
            assert.include(options.detail!, "Project: T3 Code");
            assert.include(options.detail!, "Environment: coolcrab");
            return Deferred.succeed(prompted, undefined).pipe(Effect.andThen(Effect.never));
          },
        );
      }),
  );

  it.effect.each(["deleted", "settled", "reconnected"] as const)(
    "checks current lifecycle and connection before approving a pending request: %s",
    (state) =>
      Effect.gen(function* () {
        const prompted = yield* Deferred.make<void>();
        yield* withScreen(
          Effect.gen(function* () {
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const store = yield* DesktopGrants.DesktopGrants;
            const context = source();
            const work = yield* permissions.request(context, "control").pipe(Effect.forkChild);
            yield* Deferred.await(prompted);
            const human = {
              ...context,
              controllerKind: "human" as const,
              connectionGeneration: "private-native-generation",
              lifecycle: {
                ...context.lifecycle!,
                state: state === "reconnected" ? ("active" as const) : state,
                revision: 2,
                settledAt: state === "settled" ? "1970-01-01T00:00:00.000Z" : null,
              },
            };
            const requestId = availableAuthorization(permissions, human).pendingRequests![0]!
              .requestId;
            if (state === "reconnected")
              store.connect(context.environmentId!, "replacement-automation-generation");
            const decision = permissions.invokeFromNativeBackend(human, {
              action: "approve",
              requestId,
              policy: temporaryPolicy,
            });
            if (state === "settled") {
              yield* decision;
              yield* Fiber.join(work);
              assert.equal(store.list()[0]!.sourceState, "settled");
              assert.equal(store.list()[0]!.expiresAt, "1970-01-01T00:15:00.000Z");
            } else {
              yield* decision.pipe(Effect.flip);
              assert.isEmpty(store.list());
              yield* Fiber.interrupt(work);
            }
          }),
          [],
          {},
          () => Deferred.succeed(prompted, undefined).pipe(Effect.andThen(Effect.never)),
        );
      }),
  );

  it.effect.each(["deny", "cancel"] as const)(
    "rejects obsolete native decisions after %s",
    (action) =>
      Effect.gen(function* () {
        const prompted = yield* Deferred.make<void>();
        const calls: string[] = [];
        yield* withScreen(
          Effect.gen(function* () {
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const store = yield* DesktopGrants.DesktopGrants;
            const context = source();
            const human = { ...context, controllerKind: "human" as const };
            const work = yield* permissions.request(context, "control").pipe(Effect.forkChild);
            yield* Deferred.await(prompted);
            const requestId = availableAuthorization(permissions, human).pendingRequests![0]!
              .requestId;
            if (action === "deny")
              yield* permissions.invokeFromNativeBackend(human, { action: "deny", requestId });
            else yield* permissions.cancel(context);
            yield* Fiber.join(work).pipe(Effect.flip);
            yield* permissions
              .invokeFromNativeBackend(human, {
                action: "approve",
                requestId,
                policy: temporaryPolicy,
              })
              .pipe(Effect.flip);
            assert.isEmpty(store.list());
            assert.notInclude(calls, "control");
          }),
          calls,
          {},
          () => Deferred.succeed(prompted, undefined).pipe(Effect.andThen(Effect.never)),
        );
      }),
  );

  it.effect(
    "requires explicit native policy, current revision and local consent for shared permissions",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        yield* withScreen(
          Effect.gen(function* () {
            const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
            const store = yield* DesktopGrants.DesktopGrants;
            const context = source();
            store.connect(context.environmentId!, "active-automation-generation");
            const human = {
              ...context,
              controllerKind: "human" as const,
              connectionGeneration: "private-native-generation",
            };
            yield* permissions
              .invokeFromNativeBackend(human, { action: "request", capability: "view" })
              .pipe(Effect.flip);
            yield* permissions
              .invokeFromNativeBackend(human, {
                action: "request",
                capability: "view",
                policy: { ...temporaryPolicy, scope: "desktop", lifetime: "until-revoked" },
              })
              .pipe(Effect.flip);
            yield* permissions.invokeFromNativeBackend(human, {
              action: "request",
              capability: "view",
              policy: temporaryPolicy,
            });
            const grant = store.list()[0]!;
            yield* permissions
              .invokeFromNativeBackend(human, {
                action: "edit",
                capability: "view",
                permission: { grantId: grant.grantId, revision: grant.revision + 1 },
                policy: temporaryPolicy,
              })
              .pipe(Effect.flip);
            assert.equal(store.list()[0]!.revision, grant.revision);
            yield* permissions
              .invokeFromNativeBackend(human, {
                action: "edit",
                capability: "view",
                permission: { grantId: grant.grantId, revision: grant.revision },
                policy: { ...temporaryPolicy, scope: "environment", lifetime: "until-revoked" },
              })
              .pipe(Effect.flip);
            assert.deepEqual(store.list(), [grant]);
            yield* permissions.invokeFromNativeBackend(human, {
              action: "edit",
              capability: "view",
              permission: { grantId: grant.grantId, revision: grant.revision },
              policy: { ...temporaryPolicy, remembered: true },
            });
            assert.lengthOf(store.list(), 1);
            assert.equal(store.list()[0]!.revision, grant.revision + 1);
            assert.isTrue(store.list()[0]!.remembered);
            assert.equal(store.generation(context.environmentId!), "active-automation-generation");
            assert.isEmpty(calls);
          }),
          calls,
        );
      }),
  );
  it.effect.each(["release", "interrupt", "forceRelease", "forceForget"] as const)(
    "%s cancels screen permission before source preflight completes",
    (operation) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        yield* withScreen(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const store = yield* DesktopGrants.DesktopGrants;
            const context = source("requester");
            const unlock = yield* Deferred.make<void>();
            const blocker = yield* store
              .withPermit(Deferred.await(unlock))
              .pipe(Effect.forkChild({ startImmediately: true }));
            const request = yield* coordinator
              .requestView(context)
              .pipe(Effect.forkChild({ startImmediately: true }));
            assert.include(store.references(context.environmentId!), context.threadId!);
            assert.notInclude(calls, "prompt");
            const clearing = yield* coordinator[operation](
              operation === "release" || operation === "interrupt"
                ? context
                : { ...source("settings"), controllerKind: "human" },
            ).pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.succeed(unlock, undefined);
            yield* Fiber.join(blocker);
            yield* Fiber.join(clearing);
            assert.equal(
              (yield* Fiber.join(request).pipe(Effect.flip))._tag,
              "ComputerUseLeaseError",
            );
            assert.isEmpty(store.list());
            assert.notInclude(calls, "view");
            // Shared cleanup has its own confirmation, but obsolete access never prompts.
            assert.equal(
              calls.filter((call) => call === "prompt").length,
              operation === "forceRelease" || operation === "forceForget" ? 1 : 0,
            );
            assert.equal((yield* coordinator.status(context)).lease?.access, "none");
            yield* coordinator.requestView(context);
            assert.equal((yield* coordinator.status(context)).lease?.access, "view");
            assert.lengthOf(store.list(), 1);
          }),
          calls,
        );
      }),
  );

  it.effect.each([
    { operation: "forceRelease", stage: "scope" },
    { operation: "forceRelease", stage: "lifetime" },
    { operation: "forceForget", stage: "scope" },
    { operation: "forceForget", stage: "lifetime" },
  ] as const)("invalidates earlier $stage approvals on $operation", (scenario) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<Electron.MessageBoxReturnValue>();
      const calls: string[] = [];
      let holdPrompt = true;
      yield* withScreen(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const store = yield* DesktopGrants.DesktopGrants;
          const context = source("requester");
          const pending = yield* coordinator.requestView(context).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* coordinator[scenario.operation]({
            ...source("settings"),
            controllerKind: "human",
          });
          holdPrompt = false;
          yield* Deferred.succeed(answer, { response: 1, checkboxChecked: false });
          assert.equal(
            (yield* Fiber.join(pending).pipe(Effect.flip))._tag,
            "ComputerUseLeaseError",
          );
          assert.isEmpty(store.list());
          assert.notInclude(calls, "view");
          assert.equal((yield* coordinator.status(context)).lease?.access, "none");
          yield* coordinator.requestView(context);
          assert.equal((yield* coordinator.status(context)).lease?.access, "view");
          assert.lengthOf(store.list(), 1);
        }),
        calls,
        {},
        (options) =>
          holdPrompt && options.title === `Choose screen permission ${scenario.stage}`
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(answer)))
            : Effect.succeed({ response: 1, checkboxChecked: false }),
      );
    }),
  );

  it.effect.each([
    { controllerKind: "agent", hadView: false },
    { controllerKind: "agent", hadView: true },
    { controllerKind: "human", hadView: false },
    { controllerKind: "human", hadView: true },
  ] as const)(
    "preserves another viewer when $controllerKind releases pending control (view: $hadView)",
    (scenario) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const calls: string[] = [];
        yield* withScreen(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const context = { ...source("controller"), controllerKind: scenario.controllerKind };
            yield* coordinator.requestView(source("viewer"));
            if (scenario.hadView) yield* coordinator.requestView(context);
            const pending = yield* coordinator.requestControl(context).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* coordinator.release(context);
            yield* Deferred.succeed(finish, undefined);
            assert.equal(
              (yield* Fiber.join(pending).pipe(Effect.flip))._tag,
              "ComputerUseLeaseError",
            );
            assert.notInclude(calls, "release");
            assert.notInclude(calls, "releaseAvailability");
            assert.include(calls, "cancel");
            assert.equal((yield* coordinator.status(context)).lease?.access, "none");
            assert.equal((yield* coordinator.status(source("viewer"))).lease?.access, "view");
            yield* coordinator.snapshot(source("viewer"), {});
            assert.include(calls, "snapshot");
          }),
          calls,
          {
            requestControl: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as(status),
            ),
          },
        );
      }),
  );

  it.effect.each([
    { operation: "forceRelease", confirmed: false },
    { operation: "forceRelease", confirmed: true },
    { operation: "forceForget", confirmed: false },
    { operation: "forceForget", confirmed: true },
  ] as const)(
    "requires destination-native confirmation for human $operation ($confirmed)",
    (scenario) => {
      const calls: string[] = [];
      let sharedPrompts = 0;
      return withScreen(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const context = source();
          yield* coordinator.requestView(context);
          const operation = coordinator[scenario.operation];
          assert.equal((yield* operation(context).pipe(Effect.flip))._tag, "ComputerUseLeaseError");
          assert.equal(sharedPrompts, 0);
          const human = { ...context, controllerKind: "human" as const };
          if (scenario.confirmed) {
            yield* operation(human);
            assert.include(calls, scenario.operation === "forceForget" ? "forget" : "release");
            assert.equal((yield* coordinator.status(context)).lease?.access, "none");
          } else {
            assert.equal((yield* operation(human).pipe(Effect.flip))._tag, "ComputerUseLeaseError");
            assert.notInclude(calls, "forget");
            assert.notInclude(calls, "release");
            assert.notInclude(calls, "releaseAvailability");
            assert.equal((yield* coordinator.status(context)).lease?.access, "view");
          }
          assert.equal(sharedPrompts, 1);
        }),
        calls,
        {},
        (options) =>
          Effect.sync(() => {
            if (options.title === "Manage desktop screen access") {
              sharedPrompts++;
              return { response: scenario.confirmed ? 1 : 0, checkboxChecked: false };
            }
            return { response: 1, checkboxChecked: false };
          }),
      );
    },
  );
  it.effect.each(["revoke", "expire"] as const)(
    "preserves independent viewers when pending control permission is removed: %s",
    (loss) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const calls: string[] = [];
        yield* withScreen(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const store = yield* DesktopGrants.DesktopGrants;
            yield* coordinator.requestView(source("viewer"));
            const pending = yield* coordinator
              .requestControl(source("controller"), {
                permissionPolicy: {
                  scope: "thread",
                  lifetime: "automatic",
                  remembered: false,
                  deadline: "1970-01-01T00:00:01.000Z",
                },
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(started);
            if (loss === "revoke")
              yield* store.withPermit(
                store.replace(store.list().filter((grant) => grant.capability !== "control")),
              );
            else yield* TestClock.adjust("1 second");
            const rejected = Fiber.join(pending).pipe(Effect.flip);
            yield* Deferred.succeed(finish, undefined);
            assert.equal((yield* rejected)._tag, "ComputerUseLeaseError");
            assert.notInclude(calls, "release");
            assert.notInclude(calls, "releaseAvailability");
            assert.equal((yield* coordinator.status(source("viewer"))).lease?.access, "view");
            yield* coordinator.snapshot(source("viewer"), {});
            assert.include(calls, "snapshot");
          }),
          calls,
          {
            requestControl: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as(status),
            ),
          },
        );
      }),
  );
  it.effect(
    "does not treat remembered native consent as T3 access and checks held leases after expiry",
    () => {
      const calls: string[] = [];
      return withScreen(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          const store = yield* DesktopGrants.DesktopGrants;
          const context = source();
          yield* coordinator.requestView(context);
          assert.equal(calls.filter((call) => call === "prompt").length, 2);
          yield* coordinator.requestView(context);
          assert.equal(calls.filter((call) => call === "prompt").length, 2);
          yield* TestClock.adjust("24 hours");
          const denied = yield* coordinator.snapshot(context, {}).pipe(Effect.flip);
          assert.equal(denied._tag, "ComputerUseLeaseError");
          assert.isEmpty(store.list());
          yield* coordinator.requestView(context);
          assert.equal(calls.filter((call) => call === "prompt").length, 4);
          assert.notInclude(calls, "forget");
          assert.notInclude(calls, "releaseAvailability");
        }),
        calls,
      );
    },
  );

  it.effect("withholds a captured frame when permission expires before emission", () =>
    Effect.gen(function* () {
      const captured = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const calls: string[] = [];
      yield* withScreen(
        Effect.gen(function* () {
          const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
          yield* coordinator.requestView(source());
          const reading = yield* coordinator.snapshot(source(), {}).pipe(Effect.forkChild);
          yield* Deferred.await(captured);
          yield* TestClock.adjust("24 hours");
          yield* Deferred.succeed(finish, undefined);
          const rejected = yield* Fiber.join(reading).pipe(Effect.flip);
          assert.equal(rejected._tag, "ComputerUseLeaseError");
        }),
        calls,
        {
          snapshot: () =>
            Deferred.succeed(captured, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as(frame),
            ),
        },
      );
    }),
  );

  it.effect.each(["unavailable", "replacement"] as const)(
    "withholds a captured frame after source %s without replaying its admission snapshot",
    (loss) =>
      Effect.gen(function* () {
        const captured = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        yield* withScreen(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const store = yield* DesktopGrants.DesktopGrants;
            const context = source();
            const owner = { environmentId: context.environmentId!, threadId: context.threadId! };
            yield* coordinator.requestView(context);
            const reading = yield* coordinator.snapshot(context, {}).pipe(Effect.forkChild);
            yield* Deferred.await(captured);
            if (loss === "unavailable") {
              store.invalidate(owner.environmentId, context.connectionGeneration!, [
                owner.threadId,
              ]);
              assert.isUndefined(store.select(owner, "view"));
            } else {
              assert.isTrue(store.connect(owner.environmentId, "replacement"));
              yield* store.synchronize(owner, context.lifecycle!, "replacement");
              assert.isDefined(store.select(owner, "view"));
            }
            yield* Deferred.succeed(finish, undefined);
            const denied = yield* Fiber.join(reading).pipe(Effect.flip);
            assert.equal(denied._tag, "ComputerUseLeaseError");
            if (denied._tag === "ComputerUseLeaseError")
              assert.equal(denied.code, "permission-denied");
            if (loss === "unavailable") assert.isUndefined(store.source(owner));
          }),
          [],
          {
            snapshot: () =>
              Deferred.succeed(captured, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.as(frame),
              ),
          },
        );
      }),
  );

  it.effect(
    "releases expired control inputs while retaining independent view and another source",
    () =>
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>();
        const calls: string[] = [];
        yield* withScreen(
          Effect.gen(function* () {
            const coordinator = yield* ComputerUseCoordinator.ComputerUseCoordinator;
            const store = yield* DesktopGrants.DesktopGrants;
            const context = source();
            yield* coordinator.requestControl(context);
            yield* coordinator.requestView(source("other"));
            const view = approveGrant({
              grantId: "independent-view",
              capability: "view",
              owner: { environmentId: context.environmentId!, threadId: context.threadId! },
              source: context.lifecycle,
              now: store.now(),
              policy: {
                scope: "thread",
                lifetime: "until-revoked",
                remembered: false,
                deadline: null,
              },
            });
            yield* store.withPermit(
              store.replace([
                ...store.list().filter((grant) => grant.capability !== "control"),
                view,
              ]),
            );
            yield* Deferred.await(released);
            const first = yield* coordinator.status(context);
            const other = yield* coordinator.status(source("other"));
            assert.equal(first.lease?.access, "view");
            assert.equal(other.lease?.access, "view");
            assert.notInclude(calls, "release");
            assert.notInclude(calls, "forget");
            assert.notInclude(calls, "releaseAvailability");
            const cannotForgetShared = yield* coordinator.forceForget(context).pipe(Effect.flip);
            assert.equal(cannotForgetShared._tag, "ComputerUseLeaseError");
            yield* coordinator.forget(context);
            assert.equal((yield* coordinator.status(source("other"))).lease?.access, "view");
            assert.notInclude(calls, "forget");
          }),
          calls,
          { releaseInputs: Deferred.succeed(released, undefined).pipe(Effect.asVoid) },
        );
      }),
  );
});

it.effect(
  "requires local confirmation and the current revision to remove a shared screen grant without forgetting OS consent",
  () => {
    const calls: string[] = [];
    return withScreen(
      Effect.gen(function* () {
        const context = source();
        const permissions = yield* DesktopScreenPermissions.DesktopScreenPermissions;
        const store = yield* DesktopGrants.DesktopGrants;
        const grant = approveGrant({
          grantId: "shared-screen",
          owner: { environmentId: context.environmentId!, threadId: context.threadId! },
          capability: "view",
          source: context.lifecycle!,
          now: 0,
          policy: {
            scope: "environment",
            lifetime: "until-revoked",
            remembered: true,
            deadline: null,
          },
        });
        yield* store.withPermit(store.replace([grant]));
        const revision = { grantId: grant.grantId, revision: grant.revision };
        assert.equal(
          (yield* permissions.revoke(context, revision).pipe(Effect.flip)).code,
          "permission-denied",
        );
        assert.notInclude(calls, "prompt");
        const human = { ...context, controllerKind: "human" as const };
        assert.equal(
          (yield* permissions
            .revoke(human, { ...revision, revision: grant.revision + 1 })
            .pipe(Effect.flip)).code,
          "permission-denied",
        );
        yield* permissions.revoke(human, revision);
        assert.isEmpty(store.list());
        assert.deepEqual(calls, ["prompt"]);
      }),
      calls,
    );
  },
);

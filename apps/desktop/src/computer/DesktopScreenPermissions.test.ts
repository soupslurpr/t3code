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
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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
          Layer.provideMerge(DesktopGrants.layer),
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
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
}

describe("scoped desktop screen permissions", () => {
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

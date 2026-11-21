import * as HostProcess from "@t3tools/shared/HostProcess";
import type {
  AgentDesktopAcquireInput,
  AgentDesktopOwner,
  AgentDesktopHumanRequest,
  AgentDesktopCreatePortRouteInput,
  AgentDesktopList,
  ComputerHostError,
  AgentDesktopManageInput,
  AgentDesktopPacketCaptureInput,
  AgentDesktopUpdateInput,
  AgentDesktopUpdateResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { ServerConfig } from "../config.ts";
import { AgentDesktopRuntime } from "../computer/AgentComputerHost.ts";
import { AgentDesktopOperations } from "../computer/AgentDesktopOperations.ts";
import { hostFailure, type DesktopCaller } from "../computer/ComputerHostConnection.ts";
import { agentDesktopResource, makeDesktopImages } from "./AgentDesktopImage.ts";
import { makeGuestTools } from "./GuestTools.ts";
import { makeGuestDisplay } from "./GuestDisplay.ts";
import { makeGuestJobs } from "./GuestJobs.ts";
import { makeGuestTransfers } from "./GuestTransfers.ts";
import { makeDesktopLifecycle } from "./lifecycle/DesktopLifecycle.ts";
import { makeGuestNetwork } from "./transport/GuestNetwork.ts";
import { guestIo } from "./transport/GuestIo.ts";
import { agentIo, ownerOf } from "./AgentEffects.ts";
import { hostRequirements, prepareHost } from "./AgentDesktopHost.ts";

const make = Effect.gen(function* () {
  const host = { platform: yield* HostProcess.Platform, arch: yield* HostProcess.Architecture };
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const override = yield* Config.option(Config.String("T3CODE_AGENT_DESKTOP_HOME"));
  const custom = yield* Config.option(Config.String("T3CODE_AGENT_DESKTOP_IMAGE"));
  const directory = path.resolve(
    Option.getOrUndefined(override)?.trim() || path.join(config.stateDir, "agent-desktops"),
  );
  const images = makeDesktopImages(directory, Option.getOrUndefined(custom)?.trim() || undefined);
  const network = makeGuestNetwork(guestIo, agentDesktopResource);
  const lifecycle = yield* Effect.promise(() =>
    makeDesktopLifecycle({
      directory,
      images,
      guest: guestIo,
      network,
      resource: agentDesktopResource,
    }),
  );
  const tools = makeGuestTools(guestIo, agentDesktopResource);
  const display = yield* makeGuestDisplay(lifecycle, guestIo, tools);
  const jobs = makeGuestJobs(lifecycle, guestIo, tools);
  const transfer = makeGuestTransfers(lifecycle, guestIo, tools);
  yield* Effect.addFinalizer(() => Effect.promise(jobs.close));
  if (host.platform === "linux")
    yield* Effect.tryPromise({
      try: lifecycle.maintain,
      catch: (cause) => {
        const failures: readonly unknown[] =
          cause instanceof AggregateError ? cause.errors : [cause];
        return {
          _tag: "AgentDesktopMaintenanceError" as const,
          details: failures
            .slice(0, 8)
            .map((failure) =>
              failure instanceof Error
                ? failure.message.slice(0, 512)
                : "Unknown maintenance failure.",
            ),
        };
      },
    }).pipe(
      Effect.catch(({ details }) =>
        Effect.logWarning("Agent desktop maintenance could not finish.", details),
      ),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
  const list = Effect.fn("AgentDesktopService.list")(function* (
    caller: DesktopCaller,
    environmentWide = false,
  ) {
    return yield* agentIo(async (): Promise<AgentDesktopList> => {
      const [desktops, requirements, base] = await Promise.all([
        environmentWide
          ? lifecycle.listEnvironment(caller.environmentId)
          : lifecycle.list(ownerOf(caller)),
        hostRequirements(images, host),
        images.current(),
      ]);
      return {
        available: requirements.every((r) => !r.required || r.status === "ready"),
        desktops,
        requirements,
        baseImage: {
          managed: base.managed,
          generation: base.generation,
          sourceRelease: base.sourceRelease ?? null,
          builtAt: base.builtAt,
          maintenance: await lifecycle.baseMaintenance(base),
        },
      };
    });
  });
  const selected = Effect.fn("AgentDesktopService.select")(function* (
    caller: DesktopCaller,
    id?: string,
  ) {
    if (id) return id;
    const owner = ownerOf(caller);
    const rows = (yield* agentIo(() => lifecycle.list(owner))).filter(
      (r) => r.owner.controllerId === owner.controllerId && r.state !== "recoverable",
    );
    if (rows.length !== 1)
      return yield* hostFailure(
        "invalid-action",
        "invalid-input",
        "Select one Agent desktop by id.",
      );
    return rows[0]!.id;
  });
  const scope = yield* Effect.scope;
  const update = Effect.fn("AgentDesktopService.update")(function* (
    caller: DesktopCaller,
    { target }: AgentDesktopUpdateInput,
    assignment: AgentDesktopOwner = ownerOf(caller),
  ): Effect.fn.Return<AgentDesktopUpdateResult, ComputerHostError> {
    const id = target.kind === "desktop" ? target.desktopId : null;
    const admission = yield* Deferred.make<boolean, ComputerHostError>();
    yield* agentIo(() =>
      lifecycle.update(assignment, id, (accepted) => {
        Deferred.doneUnsafe(admission, Effect.succeed(accepted));
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!(yield* Deferred.fail(admission, error))) {
            yield* Effect.logWarning("Agent desktop update failed.", error.computerFailure);
          }
        }),
      ),
      Effect.forkIn(scope),
    );
    const accepted = yield* Deferred.await(admission);
    const status = yield* list(caller);
    const maintenance =
      id === null
        ? status.baseImage.maintenance
        : status.desktops.find((desktop) => desktop.id === id)?.maintenance;
    if (!maintenance)
      return yield* hostFailure(
        "desktop-target-mismatch",
        "invalid-input",
        "The selected desktop no longer exists.",
      );
    return { accepted, target, maintenance };
  });
  return {
    display,
    operations: { ...jobs, transfer },
    list,
    update,
    superviseMachine: (
      assignment: AgentDesktopOwner,
      request: Extract<
        AgentDesktopHumanRequest,
        { operation: "manage" | "inspect" | "create-route" | "remove-route" }
      >,
    ) => {
      switch (request.operation) {
        case "manage":
          return agentIo(() => lifecycle.manage(assignment, request.input, true));
        case "inspect":
          return agentIo(() =>
            lifecycle.inspect(assignment, request.desktopId, request.includeConnections === true),
          );
        case "create-route":
          return agentIo(() => lifecycle.route(assignment, request.input.desktopId, request.input));
        case "remove-route":
          return agentIo(() =>
            lifecycle.route(assignment, request.input.desktopId, request.input.routeId),
          );
      }
    },
    resolveOwner: (environmentId: DesktopCaller["environmentId"], id: string) =>
      agentIo(() => lifecycle.resolveOwner(environmentId, id)),
    setup: Effect.fn("AgentDesktopService.setup")(function* (caller: DesktopCaller) {
      const { packages, provisioned } = yield* agentIo(() =>
        prepareHost(images, host, lifecycle.ensureBase),
      );
      return {
        attempted: true,
        completed: true,
        packages,
        imageProvisioned: provisioned,
        status: yield* list(caller),
      };
    }),
    acquire: (caller: DesktopCaller, input: AgentDesktopAcquireInput) =>
      agentIo(() => lifecycle.acquire(ownerOf(caller), input)),
    manage: (caller: DesktopCaller, input: AgentDesktopManageInput) =>
      agentIo(() => lifecycle.manage(ownerOf(caller), input)),
    inspect: Effect.fn("AgentDesktopService.inspect")(function* (
      caller: DesktopCaller,
      input: { desktopId?: string | undefined; includeConnections?: boolean | undefined },
    ) {
      const id = yield* selected(caller, input.desktopId);
      return yield* agentIo(() =>
        lifecycle.inspect(ownerOf(caller), id, input.includeConnections === true),
      );
    }),
    route: Effect.fn("AgentDesktopService.route")(function* (
      caller: DesktopCaller,
      input: AgentDesktopCreatePortRouteInput | { desktopId?: string | undefined; routeId: string },
    ) {
      const id = yield* selected(caller, input.desktopId);
      return yield* agentIo(() =>
        lifecycle.route(ownerOf(caller), id, "routeId" in input ? input.routeId : input),
      );
    }),
    capture: Effect.fn("AgentDesktopService.capture")(function* (
      caller: DesktopCaller,
      input: AgentDesktopPacketCaptureInput,
    ) {
      if (input.filter?.trim())
        return yield* hostFailure(
          "unsupported-operation",
          "invalid-input",
          "This QEMU capture records the selected VM interface. Omit the packet filter.",
        );
      const id = yield* selected(caller, input.desktopId);
      return yield* agentIo(async (signal) => {
        const lease = await lifecycle.begin(ownerOf(caller), id, "owned");
        try {
          return await network.capture(lease.paths, input.durationMs, input.maxBytes, signal);
        } finally {
          await lease.release();
        }
      });
    }),
  };
});
export class AgentDesktopService extends Context.Service<
  AgentDesktopService,
  Effect.Success<typeof make>
>()("t3/agentDesktop/AgentDesktopService") {}
export const layer = Layer.effect(AgentDesktopService, make);
export const backend = Layer.mergeAll(
  Layer.effect(
    AgentDesktopRuntime,
    Effect.map(AgentDesktopService, (s) => s.display),
  ),
  Layer.effect(
    AgentDesktopOperations,
    Effect.map(AgentDesktopService, (s) => s.operations),
  ),
);

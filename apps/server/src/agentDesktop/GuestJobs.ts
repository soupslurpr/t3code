// @effect-diagnostics nodeBuiltinImport:off - Only the job ledger and controller bindings live on the host.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  makeAgentDesktopJobs,
  desktopJobCompletion,
  type DesktopJobPort,
  type DesktopJobAuthority,
} from "@t3tools/shared/desktopJobs";
import type { AgentDesktopOperationsPort } from "../computer/AgentDesktopOperations.ts";
import { hostFailure, type DesktopCaller } from "../computer/ComputerHostConnection.ts";
import { ownerOf, agentIo } from "./AgentEffects.ts";
import { guestJobExecutor } from "./GuestJobExecutor.ts";
import type { GuestTools } from "./GuestTools.ts";
import type { DesktopLifecycle, GuestIo } from "./MachinePorts.ts";

export function makeGuestJobs(lifecycle: DesktopLifecycle, guest: GuestIo, tools: GuestTools) {
  const stores = new Map<string, Promise<DesktopJobPort>>();
  const admitted = new WeakMap<DesktopJobAuthority, DesktopCaller>();
  const jobs: AgentDesktopOperationsPort["jobs"] = Effect.fn("GuestJobs.authorize")(
    function* (caller, desktop) {
      const clock = yield* Clock.Clock;
      return yield* agentIo(async () => {
        const owner = ownerOf(caller);
        const lease = await lifecycle.begin(owner, desktop.desktopId, "owned");
        try {
          const grantId =
            "vm-" +
            NodeCrypto.createHash("sha256")
              .update([desktop.desktopId, owner.environmentId, owner.threadId].join("\0"))
              .digest("hex");
          const authority: DesktopJobAuthority = {
            owner,
            grantId,
            revision: 1,
            inspectAllThreads: false,
            admit: async () => {
              const check = await lifecycle.begin(owner, desktop.desktopId, "owned");
              await check.release();
            },
          };
          admitted.set(authority, caller);
          let port = stores.get(desktop.desktopId);
          if (!port) {
            const vm = lease.paths;
            port = (async () => {
              const { username, home, uid } = await tools.identity(vm);
              return makeAgentDesktopJobs(
                {
                  desktop,
                  directory: NodePath.join(vm.directory, "jobs"),
                  homeDirectory: home,
                  environment: {
                    HOME: home,
                    USER: username,
                    LOGNAME: username,
                    PATH: "/usr/local/bin:/usr/bin",
                    LANG: "C.UTF-8",
                    XDG_RUNTIME_DIR: "/run/user/" + uid,
                    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/" + uid + "/bus",
                    WAYLAND_DISPLAY: "wayland-0",
                    DISPLAY: ":0",
                  },
                  platform: "linux",
                  user: username,
                  now: () => clock.currentTimeMillisUnsafe(),
                },
                guestJobExecutor(guest, vm, tools, username, async (auth) => {
                  const actor = admitted.get(auth);
                  if (!actor) throw new Error("Guest job authority has expired.");
                  return lifecycle.begin(ownerOf(actor), vm.id, "owned");
                }),
              );
            })();
            stores.set(vm.id, port);
            void port.catch(() => stores.delete(vm.id));
          }
          return { port: await port, authority };
        } finally {
          await lease.release();
        }
      });
    },
  );
  const access: AgentDesktopOperationsPort["access"] = Effect.fn("GuestJobs.access")(
    function* (caller, input) {
      if (input.desktop.kind !== "agent" || !["status", "request"].includes(input.action))
        return yield* hostFailure(
          "invalid-action",
          "invalid-input",
          "Agent desktop execution follows machine ownership.",
        );
      const selector = input.desktop;
      const id =
        selector.desktopId ??
        (yield* agentIo(() => lifecycle.acquire(ownerOf(caller), selector))).id;
      const desktop = { kind: "agent" as const, desktopId: id };
      const lease = yield* agentIo(() => lifecycle.begin(ownerOf(caller), id, "owned"));
      const user = yield* agentIo(() => tools.identity(lease.paths).finally(() => lease.release()));
      return {
        kind: "access" as const,
        desktop,
        user: user.username,
        homeDirectory: user.home,
        platform: "linux",
        granted: true,
        protocolVersion: 2 as const,
        grants: [],
      };
    },
  );
  const completion: AgentDesktopOperationsPort["completion"] = Effect.fn("GuestJobs.completion")(
    function* (caller, input) {
      const desktop = input.desktop;
      if (desktop.kind !== "agent")
        return yield* hostFailure("invalid-action", "invalid-input", "Select an Agent desktop.");
      const { port, authority } = yield* jobs(caller, desktop);
      const receipt = yield* agentIo(() =>
        desktopJobCompletion(port, authority.owner, input, authority),
      );
      return {
        kind: "completion" as const,
        protocolVersion: 2 as const,
        desktop,
        waitId: input.waitId,
        receipt,
      };
    },
  );
  return {
    jobs,
    access,
    completion,
    close: async () => {
      await Promise.allSettled([...stores.values()].map(async (port) => (await port).close()));
      stores.clear();
    },
  };
}

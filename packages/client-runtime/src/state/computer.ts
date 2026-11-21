import { WS_METHODS, type ComputerHostRegistration } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export function createComputerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    automationRequests: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:computer:host",
      idleTtlMs: 0,
      subscribe: (input: ComputerHostRegistration) =>
        subscribe(WS_METHODS.previewAutomationConnect, input, {
          resubscribeOnCompletionAfter: "1 second",
        }).pipe(Stream.rechunk(1)),
    }),
    respondToAutomation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:respond",
      tag: WS_METHODS.previewAutomationRespond,
    }),
    focusAutomationHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:focus",
      tag: WS_METHODS.previewAutomationFocusHost,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.clientId, input.connectionId]),
      },
    }),
    humanInvoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:supervise",
      tag: WS_METHODS.userDesktopHumanInvoke,
    }),
    agentInvoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-desktops:supervise",
      tag: WS_METHODS.agentDesktopHumanInvoke,
    }),
    threadMonitors: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread:monitors",
      tag: WS_METHODS.threadMonitorsSubscribe,
      idleTtlMs: 0,
    }),
    cancelMonitor: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread:cancel-monitor",
      tag: WS_METHODS.threadMonitorsCancel,
    }),
    inspectWatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread:inspect-watch",
      tag: WS_METHODS.threadMonitorsInspectWatch,
    }),
    updateWatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread:update-watch",
      tag: WS_METHODS.threadMonitorsUpdateWatch,
    }),
    detachWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread:detach-worktree",
      tag: WS_METHODS.threadWorktreeDetach,
    }),
    removeWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread:remove-worktree",
      tag: WS_METHODS.threadWorktreeRemove,
    }),
  };
}

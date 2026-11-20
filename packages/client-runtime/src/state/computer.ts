import { WS_METHODS, type ComputerHostRegistration } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

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
  };
}

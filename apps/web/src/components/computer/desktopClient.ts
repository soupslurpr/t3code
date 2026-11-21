import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AgentDesktopHumanRequest,
  EnvironmentId,
  ThreadId,
  UserDesktopHumanRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useContext, useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { m } from "~/i18n/messages";
import { computerEnvironment } from "~/state/computer";

export interface DesktopScope {
  environmentId: EnvironmentId;
  threadId?: ThreadId | undefined;
}

export interface ActionClient<Input, Output = unknown> {
  invoke(input: Input, signal?: AbortSignal): Promise<Output>;
  permission(input: Input): Atom.Atom<boolean>;
}

export interface DesktopClient<R> extends DesktopScope, ActionClient<R> {}

type Command<Input, Output, E> = AtomCommand<
  { environmentId: EnvironmentId; input: Input },
  Output,
  E
> & {
  permissionAtom(environmentId: EnvironmentId, input: Input): Atom.Atom<boolean>;
};

export function useScopedCommand<Input, Output, E>(
  environmentId: EnvironmentId,
  command: Command<Input, Output, E>,
): ActionClient<Input, Output> {
  const registry = useContext(RegistryContext);
  return {
    permission: (input) => command.permissionAtom(environmentId, input),
    invoke: async (input, signal) => {
      const result = await runAtomCommand(
        registry,
        command,
        { environmentId, input },
        {
          reportFailure: false,
          ...(signal ? { signal } : {}),
        },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
  };
}

type InvokeInput<R> = { threadId?: ThreadId; request: R };

function useDesktopClient<R, E>(
  { environmentId, threadId }: DesktopScope,
  command: Command<InvokeInput<R>, unknown, E>,
): DesktopClient<R> {
  const rpc = useScopedCommand(environmentId, command);
  const input = (request: R) => (threadId === undefined ? { request } : { threadId, request });
  return {
    environmentId,
    threadId,
    permission: (request) => rpc.permission(input(request)),
    invoke: (request, signal) => rpc.invoke(input(request), signal),
  };
}

export const useUserDesktopClient = (scope: DesktopScope): DesktopClient<UserDesktopHumanRequest> =>
  useDesktopClient(scope, computerEnvironment.humanInvoke);
export const useAgentDesktopClient = (
  scope: DesktopScope,
): DesktopClient<AgentDesktopHumanRequest> =>
  useDesktopClient(scope, computerEnvironment.agentInvoke);

export const desktopError = (error: unknown) => thrownErrorMessage(error, m) ?? String(error);
const disabled = Atom.make(false);

export function useDesktopRead<R, S extends Schema.Decoder<unknown>>(
  client: DesktopClient<R>,
  request: NoInfer<R> | null,
  schema: S,
  intervalMs?: number,
) {
  const allowed = useAtomValue(request === null ? disabled : client.permission(request));
  const key = JSON.stringify([client.environmentId, client.threadId, request]);
  const refetch = useRef<(() => void) | undefined>(undefined);
  const refresh = useStableCallback(() => refetch.current?.());
  const [result, setResult] = useState<{
    key: string;
    data: S["Type"] | null;
    error: string | null;
  }>();
  if (result && (!allowed || result.key !== key)) setResult(undefined);
  const load = useStableCallback(async (signal: AbortSignal) =>
    request === null
      ? null
      : Schema.decodeUnknownSync(schema)(await client.invoke(request, signal)),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this permission-bound RPC and cancels its timer and result when the target changes
  useEffect(() => {
    if (!allowed) return;
    let active: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      active?.abort();
      clearTimeout(timer);
      if (document.hidden) return;
      const controller = new AbortController();
      active = controller;
      try {
        const data = await load(controller.signal);
        if (!controller.signal.aborted) setResult({ key, data, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, data: null, error: desktopError(error) });
      }
      if (intervalMs && !controller.signal.aborted)
        timer = setTimeout(() => void read(), intervalMs);
    };
    const visible = () => void read();
    refetch.current = visible;
    document.addEventListener("visibilitychange", visible);
    void read();
    return () => {
      refetch.current = undefined;
      active?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [allowed, intervalMs, key, load]);
  const current = allowed && result?.key === key ? result : undefined;
  return { data: current?.data ?? null, error: current?.error ?? null, allowed, refresh };
}

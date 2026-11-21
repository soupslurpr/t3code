import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  ComputerDesktopTarget,
  EnvironmentId,
  ThreadId,
  type AgentDesktopHumanRequest,
  type UserDesktopHumanRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { m } from "../../i18n/messages";
import { useAppActive } from "../../lib/appState";
import { computerEnvironment } from "../../state/computer";
import { useAtomCommand } from "../../state/use-atom-command";

export type DesktopScope = { environmentId: EnvironmentId; threadId?: ThreadId | undefined };
export type DesktopRouteTarget = DesktopScope & {
  kind: "user" | "agent";
  desktopId: string;
  label: string;
};
export type DesktopRouteParams = Omit<DesktopRouteTarget, "label"> & { label?: string };
const routeIdentity = Schema.is(
  Schema.Struct({
    environmentId: EnvironmentId,
    threadId: Schema.optional(ThreadId),
  }),
);
const validTarget = Schema.is(ComputerDesktopTarget);
export function desktopRouteTarget(params: DesktopRouteParams): DesktopRouteTarget | null {
  if (!routeIdentity(params) || !validTarget(params)) return null;
  return {
    ...params,
    label: typeof params.label === "string" && params.label ? params.label : params.desktopId,
  };
}

export function commandValue<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

export function desktopError(cause: unknown) {
  return cause instanceof Error ? cause.message : m(msg("The environment request failed."));
}

export function useUserRequest({ environmentId, threadId }: DesktopScope) {
  const invoke = useAtomCommand(computerEnvironment.humanInvoke, { reportFailure: false });
  return async (request: UserDesktopHumanRequest, source = threadId) =>
    commandValue(
      await invoke({
        environmentId,
        input: { request, ...(source ? { threadId: source } : {}), timeoutMs: 120_000 },
      }),
    );
}

export function useAgentRequest({ environmentId, threadId }: DesktopScope) {
  const invoke = useAtomCommand(computerEnvironment.agentInvoke, { reportFailure: false });
  return async (request: AgentDesktopHumanRequest) =>
    commandValue(
      await invoke({ environmentId, input: { request, ...(threadId ? { threadId } : {}) } }),
    );
}

export function useUserPermission(scope: DesktopScope, request: UserDesktopHumanRequest) {
  return useAtomValue(
    computerEnvironment.humanInvoke.permissionAtom(scope.environmentId, {
      request,
      ...(scope.threadId ? { threadId: scope.threadId } : {}),
    }),
  );
}

export function useAgentPermission(scope: DesktopScope, request: AgentDesktopHumanRequest) {
  return useAtomValue(
    computerEnvironment.agentInvoke.permissionAtom(scope.environmentId, {
      request,
      ...(scope.threadId ? { threadId: scope.threadId } : {}),
    }),
  );
}

/** Run reads only while their keyed target is visible and discard replies after leaving it. */
export function useDesktopRead<A>(enabled: boolean, read: () => Promise<A>, intervalMs?: number) {
  const focused = useIsFocused();
  const foreground = useAppActive();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    revision: number;
    data: A | null;
    error: string | null;
  } | null>(null);
  const perform = useEffectEvent(read);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe the visible screen to remote desktop state for its focused lifetime.
  useEffect(() => {
    if (!enabled || !focused || !foreground) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const value = await perform();
        if (active) {
          setResult({ revision, data: value, error: null });
        }
      } catch (cause) {
        if (active) {
          setResult({ revision, data: null, error: desktopError(cause) });
        }
      }
      if (active && intervalMs !== undefined) timer = setTimeout(load, intervalMs);
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, focused, foreground, revision, intervalMs]);
  return {
    data: enabled ? (result?.data ?? null) : null,
    error: enabled ? (result?.error ?? null) : null,
    pending: enabled && result?.revision !== revision,
    refresh: () => setRevision((n) => n + 1),
  };
}

export function useDesktopAction() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(desktopError(cause));
    }
    running.current = false;
    setBusy(false);
  };
  return { busy, error, run };
}

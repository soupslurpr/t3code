import type { ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

export function triageCommandForEnvironment(
  config: Pick<ServerConfig, "environment" | "installedTriageCommand"> | null | undefined,
): string | null {
  if (!config) return null;
  return config.environment.forkBuild ? (config.installedTriageCommand ?? null) : "npx t3 triage";
}

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "metadata");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.descriptor(),
  );
});

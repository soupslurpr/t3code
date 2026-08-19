import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState,
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DESKTOP_ASSET_PROXY_PATH,
  type AssetResource,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl, type AssetUrlState } from "@t3tools/client-runtime/state/assets";

/** Resolves one signed asset through Electron's secure same-origin media route when available. */
export function resolveClientAssetUrl(
  httpBaseUrl: string,
  relativeUrl: string,
  desktopRendererUrl?: string,
): string | null {
  const assetUrl = resolveAssetUrl(httpBaseUrl, relativeUrl);
  if (assetUrl === null || desktopRendererUrl === undefined) return assetUrl;
  try {
    const target = new URL(assetUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    const proxyUrl = new URL(DESKTOP_ASSET_PROXY_PATH, desktopRendererUrl);
    proxyUrl.searchParams.set("url", target.toString());
    return proxyUrl.toString();
  } catch {
    return null;
  }
}

function currentDesktopRendererUrl(): string | undefined {
  return typeof window !== "undefined" && window.desktopBridge !== undefined
    ? window.location.href
    : undefined;
}

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const state = assetUrlStateFromResult(result, httpBaseUrl);
  if (state._tag !== "Success" || httpBaseUrl === null) return state;
  const url = resolveClientAssetUrl(httpBaseUrl, state.url, currentDesktopRendererUrl());
  return url === null
    ? { _tag: "Failure" }
    : {
        ...state,
        url,
      };
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const result = useAssetUrlState(environmentId, resource);
  return result._tag === "Success" ? result.url : null;
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<void> {
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null) return;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }, [environmentId, resource, refresh]);
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result)
              ? resolveClientAssetUrl(
                  preparedConnection.value.httpBaseUrl,
                  result.value.relativeUrl,
                  currentDesktopRendererUrl(),
                )
              : null,
          ),
    [preparedConnection, resources, results],
  );
}

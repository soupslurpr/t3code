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
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
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
  const fileAccess = useFilesystemReadAccess(environmentId);
  const canReadResource =
    fileAccess.canReadFiles ||
    (resource?._tag !== "workspace-file" &&
      resource?._tag !== "media-file" &&
      resource?._tag !== "draft-workspace-file");
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    !canReadResource || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  if (!canReadResource) return { _tag: fileAccess.isPending ? "Loading" : "Failure" };
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

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  }, [environmentId, resource, refresh, httpBaseUrl]);
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = useMemo(
    () =>
      canReadFiles
        ? resources
        : resources.filter(
            (resource) =>
              resource._tag !== "workspace-file" &&
              resource._tag !== "media-file" &&
              resource._tag !== "draft-workspace-file",
          ),
    [canReadFiles, resources],
  );
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  return useMemo(() => {
    if (preparedConnection._tag === "None") return resources.map(() => null);
    let resultIndex = 0;
    return resources.map((resource) => {
      if (
        !canReadFiles &&
        (resource._tag === "workspace-file" ||
          resource._tag === "media-file" ||
          resource._tag === "draft-workspace-file")
      )
        return null;
      const result = results[resultIndex++];
      return result && AsyncResult.isSuccess(result)
        ? resolveClientAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl, currentDesktopRendererUrl())
        : null;
    });
  }, [canReadFiles, preparedConnection, resources, results]);
}

import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState as RuntimeAssetUrlState,
  assetUrlStateFromResult,
  blockedAssetUrlState,
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

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState = RuntimeAssetUrlState & { readonly waiting?: boolean };

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
  const blocked = blockedAssetUrlState(resource, useFilesystemReadAccess(environmentId));
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  if (blocked !== null) return blocked;
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const state = {
    ...assetUrlStateFromResult(result, httpBaseUrl),
    ...(result.waiting ? { waiting: true } : {}),
  };
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
  return async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  };
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = canReadFiles
    ? resources
    : resources.filter((resource) => !isFileResource(resource));
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  if (preparedConnection._tag === "None") return resources.map(() => null);
  const urls: Array<string | null> = [];
  let resultIndex = 0;
  for (const resource of resources) {
    if (!canReadFiles && isFileResource(resource)) {
      urls.push(null);
      continue;
    }
    const result = results[resultIndex];
    resultIndex += 1;
    urls.push(
      result && AsyncResult.isSuccess(result)
        ? resolveClientAssetUrl(
            preparedConnection.value.httpBaseUrl,
            result.value.relativeUrl,
            currentDesktopRendererUrl(),
          )
        : null,
    );
  }
  return urls;
}

function isFileResource(resource: AssetResource): boolean {
  return (
    resource._tag === "workspace-file" ||
    resource._tag === "media-file" ||
    resource._tag === "draft-workspace-file"
  );
}

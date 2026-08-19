import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  DESKTOP_ASSET_PROXY_PATH,
  type AssetResource,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly url: string; readonly sourcePath?: string };

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
  environmentId: EnvironmentId,
  resource: AssetResource,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    assetEnvironment.createUrl({
      environmentId,
      input: { resource },
    }),
  );
  if (result._tag === "Failure") {
    return { _tag: "Failure" };
  }
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return { _tag: "Loading" };
  }
  const url = resolveClientAssetUrl(
    preparedConnection.value.httpBaseUrl,
    result.value.relativeUrl,
    currentDesktopRendererUrl(),
  );
  return url === null
    ? { _tag: "Failure" }
    : {
        _tag: "Success",
        url,
        ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
      };
}

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const result = useAssetUrlState(environmentId, resource);
  if (result._tag !== "Success") {
    return null;
  }
  return result.url;
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

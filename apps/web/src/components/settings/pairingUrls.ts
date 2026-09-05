/** Builds and decodes pairing URLs used by connection settings. */
import { buildHostedPairingUrl, readHostedPairingRequest } from "../../hostedPairing";
import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "../../pairingUrl";

/** Extracts connection fields after a complete pairing URL has been entered. */
export function parsePairingUrlFields(
  input: string,
  baseUrl: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, baseUrl);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      return { host: hostedPairingRequest.host, pairingCode: hostedPairingRequest.token };
    }
    const pairingCode = getPairingTokenFromUrl(url);
    return pairingCode ? { host: url.origin, pairingCode } : null;
  } catch {
    return null;
  }
}

/** Builds a pairing URL served by the selected environment. */
export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

/** Builds a hosted-client pairing URL for an HTTPS environment. */
export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}

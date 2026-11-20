import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
const DOWNLOAD_IDLE_TIMEOUT_MS = 2 * 60 * 1_000;
const DOWNLOAD_PROGRESS_BYTES = 64 * 1_024 * 1_024;
const DOWNLOAD_RETRY_COUNT = 3;
export const PINNED_ARCH_IMAGE = Object.freeze({
  release: "20261101.620452",
  fileName: "Arch-Linux-x86_64-cloudimg-20261101.620452.qcow2",
  url: "https://geo.mirror.pkgbuild.com/images/v20261101.620452/Arch-Linux-x86_64-cloudimg-20261101.620452.qcow2",
  sha256: "794eb4889b39e1f0ed7d5ae998b2a1ed2137db8cf8c3476cf2962c7437ecb003",
  sizeBytes: 576_697_856,
});
/** Reports a bounded pinned-image download failure. */
export class AgentDesktopImageDownloadError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

/** Creates the consistent cancellation failure propagated across child operations. */
export const abortError = () => new Error("agent desktop image provisioning was cancelled");
/** Computes one file's lowercase SHA-256 digest without retaining it in memory. */
export async function sha256File(path, signal) {
  const hash = NodeCrypto.createHash("sha256");
  const handle = await NodeFSP.open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      if (signal?.aborted) throw abortError();
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** Checks that a download URL stays on the official Arch mirror network. */
const allowedPinnedImageUrl = (url) =>
  url.protocol === "https:" &&
  (url.hostname === "mirror.pkgbuild.com" || url.hostname.endsWith(".mirror.pkgbuild.com"));

/** Parses one nonnegative HTTP integer without accepting unsafe values. */
const responseInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

/** Validates one pinned-image response and chooses append or replacement mode. */
export function pinnedImageDownloadPlan(statusCode, headers, requestedOffset, expectedSize) {
  if (statusCode !== 200 && statusCode !== 206) {
    throw new AgentDesktopImageDownloadError(
      `official Arch image server returned HTTP ${statusCode ?? "unknown"}`,
      statusCode === 408 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500),
    );
  }
  const append = requestedOffset > 0 && statusCode === 206;
  const initialBytes = append ? requestedOffset : 0;
  const contentLength = responseInteger(headers["content-length"]);
  if (contentLength !== expectedSize - initialBytes) {
    throw new AgentDesktopImageDownloadError(
      `official Arch image size mismatch: expected ${expectedSize - initialBytes} response bytes`,
    );
  }
  if (append) {
    const expectedContentRange = `bytes ${requestedOffset}-${expectedSize - 1}/${expectedSize}`;
    if (headers["content-range"] !== expectedContentRange) {
      throw new AgentDesktopImageDownloadError(
        "official Arch image returned an invalid byte range",
      );
    }
  }
  return { append, initialBytes };
}

/** Performs one validated, optionally resumed pinned-image download attempt. */
const downloadAttempt = (image, destination, requestedOffset, signal, onProgress, redirects = 0) =>
  new Promise((resolve, reject) => {
    const url = new URL(image.url);
    if (!allowedPinnedImageUrl(url)) {
      reject(
        new AgentDesktopImageDownloadError("pinned Arch image URL is not an approved HTTPS mirror"),
      );
      return;
    }
    const request = NodeHttps.get(
      url,
      {
        headers: requestedOffset === 0 ? {} : { Range: `bytes=${requestedOffset}-` },
        signal,
      },
      (response) => {
        const location = response.headers.location;
        if (
          response.statusCode !== undefined &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          location !== undefined
        ) {
          response.resume();
          if (redirects >= 3) {
            reject(
              new AgentDesktopImageDownloadError("official Arch image redirected too many times"),
            );
            return;
          }
          const redirected = new URL(location, url);
          if (!allowedPinnedImageUrl(redirected)) {
            reject(
              new AgentDesktopImageDownloadError(
                "official Arch image redirected off its approved mirrors",
              ),
            );
            return;
          }
          resolve(
            downloadAttempt(
              { ...image, url: redirected.href },
              destination,
              requestedOffset,
              signal,
              onProgress,
              redirects + 1,
            ),
          );
          return;
        }

        let plan;
        try {
          plan = pinnedImageDownloadPlan(
            response.statusCode,
            response.headers,
            requestedOffset,
            image.sizeBytes,
          );
        } catch (error) {
          response.resume();
          reject(error);
          return;
        }
        let receivedBytes = plan.initialBytes;
        let nextProgressBytes =
          Math.floor(receivedBytes / DOWNLOAD_PROGRESS_BYTES + 1) * DOWNLOAD_PROGRESS_BYTES;
        response.on("data", (chunk) => {
          receivedBytes += chunk.byteLength;
          if (receivedBytes >= nextProgressBytes || receivedBytes === image.sizeBytes) {
            onProgress?.(receivedBytes, image.sizeBytes);
            nextProgressBytes += DOWNLOAD_PROGRESS_BYTES;
          }
        });
        const output = NodeFS.createWriteStream(destination, {
          flags: plan.append ? "a" : "w",
          mode: 0o600,
        });
        NodeStreamPromises.pipeline(response, output, { signal }).then(resolve, reject);
      },
    );
    request.once("error", reject);
    request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      request.destroy(
        new AgentDesktopImageDownloadError("official Arch image download stalled", true),
      );
    });
  });

/** Waits for one bounded retry backoff while remaining cancellable. */
const retryDelay = (attempt, signal) =>
  new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, attempt * 1_000);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });

/** Downloads and verifies the immutable official Arch source image with resume support. */
export async function downloadPinnedAgentDesktopSource(options) {
  const image = options.image ?? PINNED_ARCH_IMAGE;
  await NodeFSP.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const source = NodePath.join(options.directory, image.fileName);
  const partial = `${source}.partial`;
  const verifyComplete = async (path) => {
    try {
      const stat = await NodeFSP.stat(path);
      if (stat.size !== image.sizeBytes) return false;
      return (await sha256File(path, options.signal)) === image.sha256;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  if (await verifyComplete(source)) {
    options.onStatus?.(`Using cached official Arch image ${image.release}`);
    return source;
  }
  await NodeFSP.rm(source, { force: true });
  if (await verifyComplete(partial)) {
    await NodeFSP.rename(partial, source);
    return source;
  }
  const partialStat = await NodeFSP.stat(partial).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (partialStat !== null && partialStat.size >= image.sizeBytes) {
    await NodeFSP.rm(partial, { force: true });
  }
  options.onStatus?.(`Downloading official Arch image ${image.release}`);
  let completed = false;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_COUNT && !completed; attempt += 1) {
    const offset = (
      await NodeFSP.stat(partial).catch((error) => {
        if (error?.code === "ENOENT") return { size: 0 };
        throw error;
      })
    ).size;
    try {
      await downloadAttempt(image, partial, offset, options.signal, options.onProgress);
      completed = true;
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      const retryable = !(error instanceof AgentDesktopImageDownloadError) || error.retryable;
      if (!retryable || attempt === DOWNLOAD_RETRY_COUNT) throw error;
      await retryDelay(attempt, options.signal);
    }
  }
  if (!(await verifyComplete(partial))) {
    await NodeFSP.rm(partial, { force: true });
    throw new AgentDesktopImageDownloadError(
      `official Arch image failed SHA-256 verification for ${image.sha256}`,
    );
  }
  await NodeFSP.rename(partial, source);
  return source;
}

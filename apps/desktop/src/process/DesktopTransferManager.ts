// @effect-diagnostics globalFetch:off - Native async stream lifecycle, called through the Effect execution boundary.
/** Streams workspace transfers under the native desktop execution grant. */
// @effect-diagnostics nodeBuiltinImport:off - Native filesystem and HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DESKTOP_TRANSFER_MANIFEST_HEADER,
  DESKTOP_TRANSFER_ROUTE_PREFIX,
  type UserDesktopTransferRequest,
  type UserDesktopTransferResult,
} from "@t3tools/contracts";
import {
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
} from "@t3tools/shared/agentDesktopBundle";
import {
  pruneDesktopTransferStaging,
  desktopTransferArchiveChunks,
  desktopTransferResponseChunks,
  receiveDesktopTransferArchive,
} from "@t3tools/shared/desktopTransfer";

import { DesktopExecutionError, type ProcessOwner } from "./DesktopProcessManager.ts";

type RunRequest = Extract<UserDesktopTransferRequest, { operation: "run" }>;
interface RunningTransfer {
  readonly owner: ProcessOwner;
  readonly grantId: string;
  readonly abort: AbortController;
  readonly result: Promise<UserDesktopTransferResult>;
}

/** Owns only active native transfers; terminal history belongs to the environment server. */
export class DesktopTransferManager {
  private readonly active = new Map<string, RunningTransfer>();

  private readonly options: { directory: string; homeDirectory: string; now: () => number };
  constructor(options: { directory: string; homeDirectory: string; now: () => number }) {
    this.options = options;
  }

  run(owner: ProcessOwner, grantId: string, input: RunRequest): Promise<UserDesktopTransferResult> {
    if (this.active.has(input.transferId))
      return Promise.reject(
        new DesktopExecutionError("transfer-in-progress", "This transfer is already running."),
      );
    if (this.active.size >= 8)
      return Promise.reject(
        new DesktopExecutionError(
          "resource-exhausted",
          "This desktop already has eight active transfers.",
        ),
      );
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(input.timeoutMs)]);
    const result = this.copy(input, signal).finally(() => this.active.delete(input.transferId));
    this.active.set(input.transferId, { owner, grantId, abort, result });
    return result;
  }

  async cancel(owner: ProcessOwner, transferId: string): Promise<UserDesktopTransferResult> {
    const transfer = this.active.get(transferId);
    if (transfer === undefined) return { transferId, cancelled: false };
    if (
      owner.environmentId !== transfer.owner.environmentId ||
      owner.threadId !== transfer.owner.threadId
    )
      throw new DesktopExecutionError(
        "permission-denied",
        "This transfer belongs to another thread.",
      );
    transfer.abort.abort();
    return await transfer.result.catch(() => ({ transferId, cancelled: true }));
  }

  async revoke(grantIds?: ReadonlySet<string>): Promise<void> {
    const transfers = [...this.active.values()].filter(
      (transfer) => grantIds === undefined || grantIds.has(transfer.grantId),
    );
    for (const transfer of transfers) transfer.abort.abort();
    await Promise.allSettled(transfers.map((transfer) => transfer.result));
  }

  private async copy(input: RunRequest, signal: AbortSignal): Promise<UserDesktopTransferResult> {
    const url = new URL(input.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== `${DESKTOP_TRANSFER_ROUTE_PREFIX}/${input.transferId}`
    )
      throw new DesktopExecutionError("invalid-destination", "Invalid environment transfer URL.");
    const desktopPath = NodePath.resolve(
      this.options.homeDirectory,
      input.desktopPath.startsWith("~/")
        ? input.desktopPath.slice(2)
        : input.desktopPath === "~"
          ? "."
          : input.desktopPath,
    );
    if (input.direction === "to-desktop" && desktopPath === NodePath.parse(desktopPath).root)
      throw new DesktopExecutionError(
        "invalid-destination",
        "The destination cannot be a filesystem root.",
      );
    signal.throwIfAborted();
    await NodeFSP.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await pruneDesktopTransferStaging(this.options.directory, "transfer-", this.options.now());
    const temporary = await NodeFSP.mkdtemp(NodePath.join(this.options.directory, "transfer-"));
    const archivePath = NodePath.join(temporary, "archive.bundle");
    try {
      const headers = { authorization: `Bearer ${input.token}` };
      if (input.direction === "to-desktop") {
        if (input.manifest === undefined)
          throw new DesktopExecutionError("integrity-failed", "Missing transfer manifest.");
        const response = await fetch(url, { headers, signal, redirect: "error" });
        if (!response.ok || response.body === null) {
          await response.body?.cancel();
          throw new DesktopExecutionError(
            "transport-failed",
            `Environment download failed (${response.status}).`,
          );
        }
        await receiveDesktopTransferArchive({
          archivePath,
          manifest: input.manifest,
          body: desktopTransferResponseChunks(response.body),
          signal,
        });
        await extractAgentDesktopBundle({
          archivePath,
          destinationPath: desktopPath,
          compression: input.manifest.compression,
          collision: input.collision,
          signal,
        });
        return { transferId: input.transferId, cancelled: false, manifest: input.manifest };
      }
      const manifest = await packAgentDesktopBundle({
        sourcePath: desktopPath,
        outputPath: archivePath,
        compression: input.compression,
        signal,
      });
      // Node Fetch supports a streaming async iterable with duplex: half.
      const request = {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "content-length": String(manifest.wireBytes),
          [DESKTOP_TRANSFER_MANIFEST_HEADER]: JSON.stringify(manifest),
        },
        body: desktopTransferArchiveChunks({ archivePath, signal }) as unknown as BodyInit,
        duplex: "half",
        signal,
        redirect: "error" as const,
      };
      const response = await fetch(url, request);
      await response.body?.cancel();
      if (!response.ok)
        throw new DesktopExecutionError(
          "transport-failed",
          `Environment upload failed (${response.status}).`,
        );
      return { transferId: input.transferId, cancelled: false, manifest };
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
  }
}

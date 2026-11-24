// @effect-diagnostics nodeBuiltinImport:off - Temporary bundle paths and private chunk streams belong to the guest.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopTransferManifest } from "@t3tools/contracts";
import { MAX_DESKTOP_TRANSFER_BYTES } from "@t3tools/shared/desktopTransfer";
import type { AgentDesktopOperationsPort } from "../computer/AgentDesktopOperations.ts";
import { DesktopTransferStream } from "../computer/DesktopTransferStream.ts";
import { hostFailure } from "../computer/ComputerHostConnection.ts";
import { checked, type GuestTools } from "./GuestTools.ts";
import { agentIo, ownerOf } from "./AgentEffects.ts";
import type { DesktopLifecycle, GuestIo } from "./MachinePorts.ts";

const chunk = 256 * 1024;
const files = ["transfer.py", "transfer_format.py", "transfer_extract.py", "transfer_pack.py"];
const decode = Schema.decodeSync(Schema.fromJsonString(DesktopTransferManifest));
export function makeGuestTransfers(
  lifecycle: DesktopLifecycle,
  guest: GuestIo,
  tools: GuestTools,
): AgentDesktopOperationsPort["transfer"] {
  const active = new Map<string, AbortController>();
  return Effect.fn("GuestTransfers.run")(function* (caller, input) {
    if (input.desktop.kind !== "agent")
      return yield* hostFailure("invalid-action", "invalid-input", "Select an Agent desktop.");
    const id = input.desktop.desktopId;
    const owner = ownerOf(caller);
    const key = [
      owner.environmentId,
      owner.threadId,
      owner.controllerId,
      id,
      input.transferId,
    ].join("\0");
    if (input.operation === "cancel") {
      active.get(key)?.abort();
      return { transferId: input.transferId, cancelled: true };
    }
    const stream = yield* DesktopTransferStream;
    if (!stream)
      return yield* hostFailure(
        "permission-denied",
        "authorization",
        "An admitted workspace transfer is required.",
      );
    return yield* agentIo(async (requestSignal) => {
      const lease = await lifecycle.begin(owner, id, "owned");
      const vm = lease.paths;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        requestSignal,
        controller.signal,
        AbortSignal.timeout(input.timeoutMs),
      ]);
      const directory = "/var/tmp/t3-agent-bundle-" + NodeCrypto.randomUUID();
      const archive = directory + "/transfer.bundle";
      const work = directory + "/work";
      const userArchive = work + "/transfer.bundle";
      active.set(key, controller);
      try {
        const user = await tools.identity(vm);
        const guestPath = NodePath.posix.resolve(user.home, input.desktopPath);
        const helper = (await tools.install(vm, files)) + "/transfer.py";
        await checked(
          guest,
          vm,
          {
            executable: "/usr/bin/install",
            args: ["-d", "-o", "root", "-g", user.gid, "-m", "0710", directory],
          },
          signal,
        );
        await checked(
          guest,
          vm,
          {
            executable: "/usr/bin/install",
            args: ["-d", "-o", user.uid, "-g", user.gid, "-m", "0700", work],
          },
          signal,
        );
        // QGA opens as root. Only open entries whose parent the session user cannot modify.
        await checked(
          guest,
          vm,
          {
            executable: "/usr/bin/install",
            args: ["-o", user.uid, "-g", user.gid, "-m", "0600", "/dev/null", archive],
          },
          signal,
        );
        let manifest: DesktopTransferManifest;
        if (input.direction === "to-desktop") {
          const incoming = await stream.download();
          if (!incoming || !input.manifest || incoming.manifest.sha256 !== input.manifest.sha256)
            throw new Error("The transfer archive is unavailable.");
          if (incoming.manifest.wireBytes > MAX_DESKTOP_TRANSFER_BYTES)
            throw new Error("Workspace archive exceeds the transfer limit.");
          let offset = 0;
          for await (const bytes of incoming.body) {
            for (let i = 0; i < bytes.length; i += chunk) {
              signal.throwIfAborted();
              const part = bytes.subarray(i, i + chunk);
              if (offset + part.length > incoming.manifest.wireBytes)
                throw new Error("Workspace sent more data than its transfer manifest.");
              await guest.write(vm, archive, offset, part);
              offset += part.length;
            }
          }
          if (offset !== incoming.manifest.wireBytes)
            throw new Error("Incomplete transfer archive.");
          await tools.session(
            vm,
            { executable: "/usr/bin/ln", args: ["-s", "--", archive, userArchive] },
            signal,
          );
          signal.throwIfAborted();
          manifest = decode(
            await tools.session(
              vm,
              {
                executable: "/usr/bin/python",
                args: [
                  "-B",
                  helper,
                  "extract",
                  "--archive",
                  userArchive,
                  "--destination",
                  guestPath,
                  "--collision",
                  input.collision,
                  "--compression",
                  incoming.manifest.compression,
                  "--sha256",
                  incoming.manifest.sha256,
                ],
                timeoutMs: input.timeoutMs,
              },
              signal,
            ),
          );
        } else {
          manifest = decode(
            await tools.session(
              vm,
              {
                executable: "/usr/bin/python",
                args: [
                  "-B",
                  helper,
                  "pack",
                  "--source",
                  guestPath,
                  "--output",
                  userArchive,
                  "--compression",
                  input.compression,
                ],
                timeoutMs: input.timeoutMs,
              },
              signal,
            ),
          );
          if (
            [manifest.wireBytes, manifest.archiveBytes, manifest.logicalBytes].some(
              (n) => n > MAX_DESKTOP_TRANSFER_BYTES,
            )
          )
            throw new Error("Guest archive exceeds the transfer limit.");
          await tools.session(
            vm,
            { executable: "/usr/bin/cp", args: ["--reflink=auto", "--", userArchive, archive] },
            signal,
          );
          async function* body() {
            let offset = 0;
            while (offset < manifest.wireBytes) {
              signal.throwIfAborted();
              const n = Math.min(chunk, manifest.wireBytes - offset);
              const bytes = await guest.read(vm, archive, offset, n);
              if (!bytes.length || bytes.length > n)
                throw new Error("Incomplete guest transfer archive.");
              offset += bytes.length;
              yield bytes;
            }
          }
          if (!(await stream.upload(manifest, body(), signal)))
            throw new Error("The workspace transfer is unavailable.");
        }
        return { transferId: input.transferId, cancelled: false, manifest };
      } finally {
        active.delete(key);
        try {
          await checked(guest, vm, { executable: "/usr/bin/rm", args: ["-rf", "--", directory] });
        } finally {
          await lease.release();
        }
      }
    });
  });
}

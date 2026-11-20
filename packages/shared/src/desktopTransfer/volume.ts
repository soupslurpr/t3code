// @effect-diagnostics nodeBuiltinImport:off - Binds workspace imports to opened filesystem objects.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { sameEntry, type EntryIdentity } from "./entryNative.ts";
import type { BoundTransferEntry } from "./entry.ts";
export type VolumeEntries = Map<string, Map<string, EntryIdentity>>;
export function volumeChildren(owned: VolumeEntries, parent: BoundTransferEntry) {
  const { dev, ino, mountId } = parent.identity;
  const key = `${dev}/${ino}/${mountId ?? ""}`;
  const existing = owned.get(key);
  if (existing) return existing;
  const children = new Map<string, EntryIdentity>();
  owned.set(key, children);
  return children;
}

type VolumeCopy = {
  readonly buffer: Buffer;
  readonly owned: VolumeEntries;
  readonly darwinRoot: BoundTransferEntry | null;
  readonly move: (
    from: BoundTransferEntry,
    source: BoundTransferEntry,
    into: BoundTransferEntry,
    name: string,
    verify: () => Promise<void>,
  ) => Promise<void>;
  readonly remove: (from: BoundTransferEntry, name: string) => Promise<void>;
  readonly signal?: AbortSignal;
};
export async function copyToWorkspaceVolume(
  path: string,
  parent: BoundTransferEntry,
  name: string,
  verify: () => Promise<void>,
  copy: VolumeCopy,
): Promise<void> {
  const { signal, buffer, owned, darwinRoot } = copy;
  signal?.throwIfAborted();
  await verify();
  const stats = await NodeFSP.lstat(path);
  // Darwin mkdirat and symlinkat lack RESOLVE_BENEATH. Create at the root, then attach with a rooted rename.
  const origin = darwinRoot ?? parent;
  const temporary = darwinRoot ? `.t3-entry-${NodeCrypto.randomUUID()}` : name;
  const createdHere = volumeChildren(owned, origin);
  const attach = async (created: BoundTransferEntry) => {
    if (!darwinRoot) return;
    await copy.move(origin, created, parent, name, verify);
    createdHere.delete(temporary);
    volumeChildren(owned, parent).set(name, created.identity);
  };
  const verifyCreated = async (created: BoundTransferEntry) => {
    await verify();
    await using named = await origin.child(temporary);
    if (!sameEntry(created.identity, named.identity))
      throw new Error("Filesystem staging changed during the copy.");
  };
  try {
    if (stats.isSymbolicLink()) {
      const directory =
        NodeProcess.platform === "win32" &&
        (await NodeFSP.stat(path).then(
          (s) => s.isDirectory(),
          () => false,
        ));
      const id = await origin.createLink(
        temporary,
        await NodeFSP.readlink(path),
        stats.mtimeMs,
        directory,
      );
      createdHere.set(temporary, id);
      await using link = await origin.child(temporary);
      if (!sameEntry(id, link.identity)) throw new Error("The staged link changed.");
      await attach(link);
      return;
    }
    if (!stats.isDirectory() && !stats.isFile())
      throw new Error("Unsupported staged workspace entry.");
    await using created = await origin.child(
      temporary,
      stats.isDirectory() ? "stageDirectory" : "stageFile",
    );
    createdHere.set(temporary, created.identity);
    if (stats.isDirectory()) {
      await NodeFSP.chmod(path, 0o700);
      for (const child of await NodeFSP.readdir(path))
        await copyToWorkspaceVolume(
          NodePath.join(path, child),
          created,
          child,
          () => verifyCreated(created),
          copy,
        );
    } else {
      await NodeFSP.chmod(path, 0o600);
      await using from = await NodeFSP.open(path, "r");
      let copied = 0;
      while (copied < stats.size) {
        signal?.throwIfAborted();
        const { bytesRead } = await from.read(
          buffer,
          0,
          Math.min(buffer.length, stats.size - copied),
          null,
        );
        if (!bytesRead) throw new Error("The staged workspace file was truncated.");
        for (let offset = 0; offset < bytesRead;) {
          signal?.throwIfAborted();
          const written = await created.write(buffer.subarray(offset, bytesRead));
          if (written < 1 || written > bytesRead - offset)
            throw new Error("Invalid filesystem write receipt.");
          offset += written;
        }
        copied += bytesRead;
      }
    }
    await verifyCreated(created);
    await attach(created);
    await created.metadata(stats.mode, stats.mtimeMs);
  } catch (cause) {
    if (darwinRoot && createdHere.has(temporary)) await copy.remove(origin, temporary);
    throw cause;
  }
}

// @effect-diagnostics nodeBuiltinImport:off - Opens single filesystem entries relative to native directory handles.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { WorkspaceMutationScope } from "./mutationScope.ts";
import { reportHandleCleanup, callNative, type Koffi } from "./native.ts";
import {
  bind,
  checkRenameMount,
  checkTransferName,
  closeFd,
  closeOnExec,
  chmodFd,
  fstat,
  nativeError,
  onTransferMount,
  platform,
  posixIdentity,
  readFd,
  sameEntry,
  utimesFd,
  writeFd,
  type Binding,
  type Access,
  type EntryIdentity,
} from "./entryNative.ts";
const bindings = new WeakMap<Koffi, Binding>();
type EntryKind = "directory" | "file" | "symlink" | "other";

export interface BoundTransferEntry extends AsyncDisposable {
  readonly handle: number | bigint;
  readonly identity: EntryIdentity;
  readonly mountId: () => Promise<bigint>;
  readonly kind: EntryKind;
  readonly path: string;
  readonly stats: { readonly size: number; readonly mtimeMs: number; readonly mode: number };
  readonly read: (buffer: Buffer) => Promise<number>;
  readonly child: (
    name: string,
    access?: Exclude<Access, "followAlias">,
    mutations?: WorkspaceMutationScope,
  ) => Promise<BoundTransferEntry>;
  readonly names: (limit?: number, signal?: AbortSignal) => Promise<string[]>;
  readonly allowDirectoryCleanup: () => Promise<void>;
  readonly write: (data: Buffer) => Promise<number>;
  readonly metadata: (mode: number, mtimeMs: number) => Promise<void>;
  readonly createLink: (
    name: string,
    target: string,
    mtimeMs: number,
    directory: boolean,
  ) => Promise<EntryIdentity>;
  readonly remove: (
    name: string,
    expected: BoundTransferEntry,
    mutations?: WorkspaceMutationScope,
    root?: BoundTransferEntry,
  ) => Promise<void>;
  readonly linkTarget: () => Promise<string>;
}

async function openEntry(
  koffi: Koffi,
  binding: Binding,
  path: string,
  parent?: BoundTransferEntry,
  access: Access = "inspect",
  mutations?: WorkspaceMutationScope,
): Promise<BoundTransferEntry> {
  const name = parent ? NodePath.basename(path) : path;
  const directory = access === "stageDirectory" || access === "privateDirectory";
  const creating = directory || access === "stageFile";
  let handle: number | bigint;
  let identity: EntryIdentity;
  let kind: EntryKind;
  let stats: BoundTransferEntry["stats"];
  let close: () => Promise<void>;
  if (binding.kind === "posix") {
    // Linux O_PATH | O_NOFOLLOW and Darwin O_SYMLINK bind the link itself.
    const flags =
      (platform === "linux"
        ? 0x200000 | (!parent && access === "followAlias" ? 0 : NodeFS.constants.O_NOFOLLOW)
        : 0x200000 | 0x8000 | NodeFS.constants.O_NONBLOCK) |
      (platform === "linux" ? 0x80000 : 0x1000000);
    const mutate = (operation: "mkdir" | "create", args: unknown[]) =>
      mutations ? mutations.run(operation, args) : callNative(binding, binding[operation], args);
    const relativeTo = parent?.handle ?? (platform === "linux" ? -100 : -2);
    if (directory) {
      const made = await mutate("mkdir", [relativeTo, name, 0o700]);
      if (made.value !== 0) throw nativeError("create directory", made.errnoCode);
    }
    const opened =
      access === "stageFile"
        ? await mutate("create", [
            relativeTo,
            name,
            NodeFS.constants.O_CREAT |
              NodeFS.constants.O_EXCL |
              NodeFS.constants.O_WRONLY |
              NodeFS.constants.O_NOFOLLOW |
              closeOnExec,
            0o600,
          ])
        : await callNative(binding, binding.open, [
            relativeTo,
            name,
            directory
              ? NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW | closeOnExec
              : flags,
          ]);
    if (typeof opened.value !== "number" || opened.value < 0)
      throw nativeError("open", opened.errnoCode);
    let fd = opened.value;
    handle = fd;
    close = () => closeFd(fd);
    try {
      const info = await fstat(fd, { bigint: true });
      identity = await posixIdentity(binding, fd, info);
      stats = {
        size: Number(info.size),
        mode: Number(info.mode),
        mtimeMs: Number(info.mtimeNs) / 1e6,
      };
      kind = info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : info.isSymbolicLink()
            ? "symlink"
            : "other";
      if (platform === "linux" && creating && parent) checkRenameMount({ identity, kind }, parent);
      if (kind === "file" && access === "list") {
        const opened = await callNative(binding, binding.open, [
          platform === "linux" ? -100 : (parent?.handle ?? -2),
          platform === "linux" ? `/proc/self/fd/${fd}` : name,
          NodeFS.constants.O_RDONLY |
            (platform === "linux" ? 0 : NodeFS.constants.O_NOFOLLOW) |
            NodeFS.constants.O_NONBLOCK |
            closeOnExec,
        ]);
        if (typeof opened.value !== "number" || opened.value < 0)
          throw nativeError("open for reading", opened.errnoCode);
        const reader = opened.value;
        const prior = fd;
        fd = reader;
        handle = reader;
        await closeFd(prior);
        const reading = await posixIdentity(binding, reader, await fstat(reader, { bigint: true }));
        if (!sameEntry(identity, reading))
          throw new Error("The workspace file changed before it could be read.");
      }
    } catch (error) {
      await close();
      throw error;
    }
  } else {
    const rights =
      0x80 | (creating ? 0x100 | 2 | 1 : access === "list" ? 1 : access === "rename" ? 0x10000 : 0);
    const sharing = creating || access === "pin" ? 3 : access === "rename" ? 0 : 7;
    if (!parent) {
      const result = await callNative(binding, binding.root, [
        NodePath.toNamespacedPath(path),
        rights,
        sharing,
        0n,
        3,
        0x02200000,
        0n,
      ]);
      if (typeof result.value !== "number" && typeof result.value !== "bigint")
        throw nativeError("open", result.errnoCode);
      handle = BigInt.asUintN(64, BigInt(result.value));
      if (handle === 0xffffffffffffffffn) throw nativeError("open", result.errnoCode);
    } else {
      const utf16 = Buffer.from(name, "utf16le");
      if (utf16.byteLength > 0xfffe) throw new Error("The transfer entry name is too long.");
      const string = Buffer.alloc(16);
      string.writeUInt16LE(utf16.byteLength);
      string.writeUInt16LE(utf16.byteLength, 2);
      string.writeBigUInt64LE(koffi.address(utf16), 8);
      const attributes = Buffer.alloc(48);
      attributes.writeUInt32LE(48);
      attributes.writeBigUInt64LE(BigInt(parent.handle), 8);
      attributes.writeBigUInt64LE(koffi.address(string), 16);
      attributes.writeUInt32LE(0x40, 24); // OBJ_CASE_INSENSITIVE
      const out = Buffer.alloc(8);
      // Keep referenced buffers alive until the worker releases OBJECT_ATTRIBUTES.
      const args = [out, rights | 0x100000, attributes, Buffer.alloc(16)];
      const options = 0x200000 | 0x20;
      let descriptor = 0n;
      if (access === "privateDirectory") {
        const flags = Buffer.alloc(4);
        const volume = await callNative(binding, binding.volume, [
          parent.handle,
          0n,
          0,
          0n,
          0n,
          flags,
          0n,
          0,
        ]);
        if (!volume.value || !(flags.readUInt32LE() & 8))
          throw new Error(
            "The destination volume cannot protect private transfer staging with a Windows ACL.",
          );
        const security = Buffer.alloc(8);
        const result = await callNative(binding, binding.descriptor, [
          "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)",
          1,
          security,
          0n,
        ]);
        if (!result.value) throw nativeError("protect", result.errnoCode);
        descriptor = security.readBigUInt64LE();
        attributes.writeBigUInt64LE(descriptor, 32);
      }
      try {
        const result = creating
          ? await callNative(
              binding,
              binding.create,
              [...args, 0n, 0, sharing, 2, options | (directory ? 1 : 0x40), 0n, 0],
              [utf16, string],
            )
          : await callNative(binding, binding.open, [...args, sharing, options], [utf16, string]);
        if (result.value !== 0) throw nativeError("open", binding.toError(result.value));
      } finally {
        if (descriptor) await callNative(binding, binding.free, [descriptor]);
      }
      handle = out.readBigUInt64LE();
    }
    close = async () => {
      const result = await callNative(binding, binding.close, [handle]);
      if (!result.value) throw nativeError("close", result.errnoCode);
    };
    try {
      const info = Buffer.alloc(52);
      const result = await callNative(binding, binding.info, [handle, info]);
      if (!result.value) throw nativeError("identify", result.errnoCode);
      identity = {
        dev: BigInt(info.readUInt32LE(28)),
        ino: (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48)),
      };
      const attributes = info.readUInt32LE();
      stats = {
        size: Number((BigInt(info.readUInt32LE(32)) << 32n) | BigInt(info.readUInt32LE(36))),
        mode: (attributes & 1 ? 0o444 : 0o666) | (attributes & 0x10 ? 0o111 : 0),
        mtimeMs: Number(info.readBigUInt64LE(20) - 116444736000000000n) / 10000,
      };
      kind =
        (attributes & 0x400) !== 0
          ? "symlink"
          : (attributes & 0x10) !== 0
            ? "directory"
            : (attributes & 0x40) !== 0
              ? "other"
              : "file";
    } catch (error) {
      await close();
      throw error;
    }
  }
  if (identity.ino === 0n) {
    await close();
    throw new Error("The filesystem did not supply a stable entry identity.");
  }
  let closed = false;
  const entry: BoundTransferEntry = {
    path,
    identity,
    kind,
    handle,
    stats,
    async mountId() {
      if (closed && platform === "linux") throw new Error("The transfer entry is closed.");
      return identity.mountId ?? identity.dev;
    },
    async read(buffer) {
      if (closed || kind !== "file" || access !== "list")
        throw new Error("The bound entry is unavailable for reading.");
      if (binding.kind === "posix")
        return (await readFd(Number(handle), buffer, 0, buffer.length, null)).bytesRead;
      const count = Buffer.alloc(4);
      const result = await callNative(binding, binding.read, [
        handle,
        buffer,
        buffer.length,
        count,
        0n,
      ]);
      if (!result.value && result.errnoCode !== 38) throw nativeError("read", result.errnoCode);
      return count.readUInt32LE();
    },
    async allowDirectoryCleanup() {
      if (closed || kind !== "directory") throw new Error("The retired directory is unavailable.");
      if ((stats.mode & 0o700) === 0o700) return;
      if (platform === "linux") await NodeFSP.chmod(`/proc/self/fd/${handle}`, 0o700);
      else if (platform === "darwin") await chmodFd(Number(handle), 0o700);
    },
    async write(data) {
      if (closed || access !== "stageFile") throw new Error("The staged file is unavailable.");
      if (binding.kind === "posix")
        return (await writeFd(Number(handle), data, 0, data.length, null)).bytesWritten;
      const count = Buffer.alloc(4);
      const result = await callNative(binding, binding.write, [
        handle,
        data,
        data.length,
        count,
        0n,
      ]);
      if (!result.value) throw nativeError("write", result.errnoCode);
      return count.readUInt32LE();
    },
    async metadata(mode, mtimeMs) {
      if (closed || !creating) throw new Error("The staged entry is unavailable.");
      if (binding.kind === "posix") {
        await utimesFd(Number(handle), mtimeMs / 1000, mtimeMs / 1000);
        await chmodFd(Number(handle), mode & 0o777);
      } else {
        const info = Buffer.alloc(40);
        const ticks = BigInt(Math.trunc(mtimeMs * 10000)) + 116444736000000000n;
        info.writeBigInt64LE(ticks, 8);
        info.writeBigInt64LE(ticks, 16);
        if (kind === "file") info.writeUInt32LE(mode & 0o222 ? 0x80 : 1, 32);
        const result = await callNative(binding, binding.setInfo, [handle, 0, info, info.length]);
        if (!result.value) throw nativeError("set metadata on", result.errnoCode);
      }
    },
    async createLink(name, target, mtimeMs, directory) {
      checkTransferName(name);
      if (closed || kind !== "directory") throw new Error("The staging directory is unavailable.");
      if (binding.kind === "posix") {
        const args = [target, handle, name];
        const created = mutations
          ? await mutations.run("symlink", args)
          : await callNative(binding, binding.symlink, args);
        if (created.value !== 0) throw nativeError("create link in", created.errnoCode);
        await using link = await entry.child(name);
        if (link.kind !== "symlink") throw new Error("The staged symbolic link changed.");
        if (platform === "linux") checkRenameMount(link, entry);
        if (platform === "darwin") {
          await utimesFd(Number(link.handle), mtimeMs / 1000, mtimeMs / 1000);
          return link.identity;
        }
        const times = Buffer.alloc(32);
        const seconds = Math.floor(mtimeMs / 1000);
        times.writeBigInt64LE(BigInt(seconds));
        times.writeBigInt64LE(BigInt(Math.trunc((mtimeMs - seconds * 1000) * 1e6)), 8);
        times.copy(times, 16, 0, 16);
        const applied = await callNative(binding, binding.linkTimes, [
          link.handle,
          "",
          times,
          0x1000 | 0x100,
        ]);
        if (applied.value !== 0) throw nativeError("set link time on", applied.errnoCode);
        return link.identity;
      } else {
        await using link = await entry.child(name, directory ? "stageDirectory" : "stageFile");
        const value = Buffer.from(target.replaceAll("/", "\\"), "utf16le");
        const data = Buffer.alloc(20 + value.length);
        data.writeUInt32LE(0xa000000c);
        data.writeUInt16LE(12 + value.length, 4);
        data.writeUInt16LE(value.length, 10);
        data.writeUInt16LE(value.length, 14);
        data.writeUInt32LE(1, 16);
        value.copy(data, 20);
        const result = await callNative(binding, binding.setReparse, [
          link.handle,
          0x900a4,
          data,
          data.length,
          0n,
          0,
          Buffer.alloc(4),
          0n,
        ]);
        if (!result.value)
          throw nativeError("create the relative symbolic link in", result.errnoCode);
        await link.metadata(0o777, mtimeMs);
        return link.identity;
      }
    },
    async remove(name, expected, scope = mutations, root) {
      checkTransferName(name);
      await using current = await entry.child(
        name,
        binding.kind === "windows" ? "rename" : "inspect",
      );
      if (
        !sameEntry(current.identity, expected.identity) ||
        (platform === "linux" && !onTransferMount(current, entry))
      )
        throw new Error("A changed staging entry was retained.");
      if (binding.kind === "posix") {
        const rooted = platform === "darwin" && root && !sameEntry(root.identity, entry.identity);
        const relative = rooted ? NodePath.relative(root.path, current.path) : name;
        if (
          !relative ||
          relative === ".." ||
          relative.startsWith(`..${NodePath.sep}`) ||
          NodePath.isAbsolute(relative)
        )
          throw new Error("The cleanup entry is outside the workspace.");
        const flags =
          (current.kind === "directory" ? (platform === "darwin" ? 0x80 : 0x200) : 0) |
          (rooted ? 0x2800 : 0);
        const args = [rooted ? root.handle : handle, relative, flags];
        const result = scope
          ? await scope.run("unlink", args)
          : await callNative(binding, binding.unlink, args);
        if (result.value !== 0) throw nativeError("remove", result.errnoCode);
      } else {
        const removeFlags = Buffer.alloc(4);
        removeFlags.writeUInt32LE(1 | 2 | 0x10);
        const removed = await callNative(binding, binding.setInfo, [
          current.handle,
          21,
          removeFlags,
          removeFlags.length,
        ]);
        if (removed.value) return;
        const disposition = Buffer.from([1]);
        const result = await callNative(binding, binding.setInfo, [
          current.handle,
          4,
          disposition,
          1,
        ]);
        if (!result.value) throw nativeError("remove", result.errnoCode);
      }
    },
    async [Symbol.asyncDispose]() {
      if (!closed) {
        closed = true;
        await close().catch((cause: unknown) => reportHandleCleanup(path, cause));
      }
    },
    child(name, access, scope = mutations) {
      if (closed || kind !== "directory") throw new Error("The transfer directory is unavailable.");
      checkTransferName(name);
      return openEntry(koffi, binding, NodePath.join(path, name), entry, access, scope);
    },
    async linkTarget() {
      if (kind !== "symlink" || closed) throw new Error("The bound symbolic link is unavailable.");
      const buffer = Buffer.alloc(16 * 1024);
      if (binding.kind === "posix") {
        const result = await callNative(
          binding,
          binding.readlink(),
          platform === "darwin"
            ? [handle, buffer, buffer.length]
            : [handle, "", buffer, buffer.length],
        );
        if (typeof result.value !== "number" || result.value < 0 || result.value >= buffer.length)
          throw nativeError("read link", result.errnoCode);
        return buffer.toString("utf8", 0, result.value);
      }
      const bytes = Buffer.alloc(4);
      const result = await callNative(binding, binding.control, [
        handle,
        0x900a8,
        0n,
        0,
        buffer,
        buffer.length,
        bytes,
        0n,
      ]);
      if (
        !result.value ||
        bytes.readUInt32LE() < 20 ||
        buffer.readUInt32LE() !== 0xa000000c ||
        buffer.readUInt32LE(16) !== 1
      )
        throw new Error("Only relative symbolic links can be copied from this workspace.");
      const start = 20 + buffer.readUInt16LE(8);
      const end = start + buffer.readUInt16LE(10);
      if (end > bytes.readUInt32LE()) throw new Error("Invalid symbolic link metadata.");
      return buffer.toString("utf16le", start, end).replaceAll("\\", "/");
    },
    async names(limit = Number.POSITIVE_INFINITY, signal?: AbortSignal) {
      if (kind !== "directory" || closed) throw new Error("The transfer directory is unavailable.");
      signal?.throwIfAborted();
      const names: string[] = [];
      if (limit <= 0) return names;
      if (binding.kind === "posix" && !binding.list) {
        const directory = await NodeFSP.opendir(`/proc/self/fd/${handle}`);
        for await (const child of directory) {
          signal?.throwIfAborted();
          names.push(child.name);
          if (names.length >= limit) break;
        }
        return names;
      }
      if (binding.kind === "posix") {
        const opened = await callNative(binding, binding.open, [
          handle,
          ".",
          NodeFS.constants.O_DIRECTORY | 0x1000000,
        ]);
        if (typeof opened.value !== "number" || opened.value < 0)
          throw nativeError("list", opened.errnoCode);
        try {
          const attributes = Buffer.alloc(24);
          attributes.writeUInt16LE(5);
          attributes.writeUInt32LE(0x80000001, 4); // ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            signal?.throwIfAborted();
            const result = await callNative(binding, binding.list!, [
              opened.value,
              attributes,
              buffer,
              buffer.length,
              0n,
            ]);
            if (typeof result.value !== "number" || result.value < 0)
              throw nativeError("list", result.errnoCode);
            if (result.value === 0) break;
            let offset = 0;
            for (let i = 0; i < result.value; i++) {
              const length = buffer.readUInt32LE(offset);
              const ref = offset + 24;
              const start = ref + buffer.readInt32LE(ref);
              const end = start + buffer.readUInt32LE(ref + 4);
              if (
                !(buffer.readUInt32LE(offset + 4) & 1) ||
                length < 32 ||
                start < ref + 8 ||
                end <= start ||
                end > offset + length ||
                offset + length > buffer.length
              )
                throw new Error("Invalid directory enumeration receipt.");
              names.push(buffer.toString("utf8", start, end - 1));
              if (names.length >= limit) return names;
              offset += length;
            }
          }
        } finally {
          await closeFd(opened.value);
        }
      } else {
        const buffer = Buffer.alloc(64 * 1024);
        for (let infoClass = 15; ; infoClass = 14) {
          signal?.throwIfAborted();
          const result = await callNative(binding, binding.list, [
            handle,
            infoClass,
            buffer,
            buffer.length,
          ]);
          if (!result.value) {
            if (result.errnoCode === 18) break;
            throw nativeError("list", result.errnoCode);
          }
          for (let offset = 0; ;) {
            const end = offset + 68 + buffer.readUInt32LE(offset + 60);
            if (end > buffer.length) throw new Error("Invalid directory enumeration receipt.");
            const name = buffer.toString("utf16le", offset + 68, end);
            if (name !== "." && name !== "..") names.push(name);
            if (names.length >= limit) return names;
            const next = buffer.readUInt32LE(offset);
            if (!next) break;
            offset += next;
          }
        }
      }
      return names;
    },
  };
  return entry;
}

export async function openTransferRoot(path: string, koffi: Koffi, access: Access = "inspect") {
  let binding = bindings.get(koffi);
  if (!binding) {
    binding = bind(koffi);
    bindings.set(koffi, binding);
  }
  return openEntry(koffi, binding, path, undefined, access);
}

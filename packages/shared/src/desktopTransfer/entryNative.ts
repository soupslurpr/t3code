// @effect-diagnostics nodeBuiltinImport:off - Opens single filesystem entries relative to native directory handles.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import { DesktopTransferError } from "./errors.ts";
import type { BoundTransferEntry } from "./entry.ts";
import { callNative, type Koffi } from "./native.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Directory handles use the executing kernel's ABI.
export const platform = process.platform;
export const fstat = NodeUtil.promisify(NodeFS.fstat);
export const closeFd = NodeUtil.promisify(NodeFS.close);
export const readFd = NodeUtil.promisify(NodeFS.read);
export const writeFd = NodeUtil.promisify(NodeFS.write);
export const chmodFd = NodeUtil.promisify(NodeFS.fchmod);
export const utimesFd = NodeUtil.promisify(NodeFS.futimes);
export const closeOnExec = platform === "linux" ? 0x80000 : 0x1000000;
export type Access =
  | "inspect"
  | "followAlias"
  | "rename"
  | "list"
  | "pin"
  | "stageFile"
  | "stageDirectory"
  | "privateDirectory";

export type EntryIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mountId?: bigint;
};
export const sameEntry = (a: EntryIdentity, b: EntryIdentity) =>
  a.ino === b.ino && a.dev === b.dev && a.mountId === b.mountId;

type EntryLocation = Pick<BoundTransferEntry, "identity" | "kind">;

// Btrfs subvolumes change a directory's device ID. OverlayFS can report a backing device for a file.
export function onTransferMount(entry: EntryLocation, parent: EntryLocation) {
  return (
    entry.identity.mountId === parent.identity.mountId &&
    (entry.identity.dev === parent.identity.dev ||
      (platform === "linux" && entry.kind !== "directory"))
  );
}

export function checkRenameMount(from: EntryLocation, into: EntryLocation) {
  if (!onTransferMount(from, into))
    throw new DesktopTransferError({
      code: "invalid-destination",
      message:
        "This entry crosses a mount or subvolume during publication. Copy directly into the mounted directory so entries can be renamed on the same filesystem.",
    });
}

async function linuxMountId(binding: Extract<Binding, { kind: "posix" }>, fd: number) {
  if (binding.statx) {
    // Linux struct statx is 256 bytes. stx_mask is at byte 0 and stx_mnt_id is at byte 144.
    const data = new BigUint64Array(32);
    const atEmptyPath = 0x1000;
    const mountMask = 0x1000;
    const result = await callNative(binding, binding.statx, [fd, "", atEmptyPath, mountMask, data]);
    if (result.value === 0 && (new Uint32Array(data.buffer)[0]! & mountMask) !== 0)
      return data[18]!;
  }
  const info = await NodeFSP.readFile(`/proc/self/fdinfo/${fd}`, "utf8").catch(() => "");
  const mount = /^mnt_id:[ \t]*(\d+)$/m.exec(info)?.[1];
  if (!mount)
    throw new DesktopTransferError({
      code: "unsupported-entry",
      message:
        "Cannot identify the transfer mount. Make /proc/self/fdinfo with mount IDs available to the T3 server and retry.",
    });
  return BigInt(mount);
}

export async function posixIdentity(
  binding: Extract<Binding, { kind: "posix" }>,
  fd: number,
  stats: NodeFS.BigIntStats,
): Promise<EntryIdentity> {
  return platform === "linux"
    ? { dev: stats.dev, ino: stats.ino, mountId: await linuxMountId(binding, fd) }
    : stats;
}

export function checkTransferName(name: string) {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0") ||
    (platform === "win32" &&
      (/[\\:<>"|?*\x00-\x1f]|[. ]$/u.test(name) ||
        /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])(?:\.|$)/iu.test(name)))
  )
    throw new Error("Invalid filesystem entry name for this transfer.");
}

export function nativeError(operation: string, errno: number) {
  const code =
    platform === "win32"
      ? errno === 2 || errno === 3
        ? "ENOENT"
        : "EIO"
      : errno === 2
        ? "ENOENT"
        : errno === 13
          ? "EACCES"
          : "EIO";
  return Object.assign(
    new Error(`Cannot ${operation} the bound transfer entry (system error ${errno}).`),
    { code },
  );
}

export function bind(koffi: Koffi) {
  if (platform === "linux" || platform === "darwin") {
    const libc = koffi.load(null);
    let statx;
    if (platform === "linux") {
      try {
        statx = libc.func("int statx(int, str, int, uint32_t, void *)");
      } catch {
        // Older libcs expose mount IDs only through procfs.
      }
    }
    return {
      kind: "posix" as const,
      statx,
      readError: () => koffi.errno(),
      open: libc.func("int openat(int, str, int)"),
      // Darwin's variadic wrapper uses a different ARM64 calling convention for the mode.
      create: libc.func(
        platform === "darwin"
          ? "int __openat(int, str, int, uint16_t)"
          : "int openat(int, str, int, uint32_t)",
      ),
      mkdir: libc.func("int mkdirat(int, str, uint32_t)"),
      symlink: libc.func("int symlinkat(str, int, str)"),
      unlink: libc.func("int unlinkat(int, str, int)"),
      linkTimes: libc.func("int utimensat(int, str, void *, int)"),
      readlink: () =>
        libc.func(
          platform === "darwin"
            ? "intptr_t freadlink(int, void *, uintptr_t)"
            : "intptr_t readlinkat(int, str, void *, uintptr_t)",
        ),
      list:
        platform === "darwin"
          ? libc.func("int getattrlistbulk(int, void *, void *, uintptr_t, uint64_t)")
          : null,
    };
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- OBJECT_ATTRIBUTES layout must match Windows pointer width.
  if (platform !== "win32" || !["arm64", "x64"].includes(process.arch))
    throw new Error("Bound workspace transfers are unavailable on this platform.");
  const kernel = koffi.load("kernel32.dll");
  const nt = koffi.load("ntdll.dll");
  const lastError = kernel.func("uint32_t __stdcall GetLastError(void)");
  return {
    kind: "windows" as const,
    readError: (): number => lastError(),
    volume: kernel.func(
      "int32_t __stdcall GetVolumeInformationByHandleW(uintptr_t, uintptr_t, uint32_t, uintptr_t, uintptr_t, void *, uintptr_t, uint32_t)",
    ),
    descriptor: koffi
      .load("advapi32.dll")
      .func(
        "int32_t __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32_t, void *, uintptr_t)",
      ),
    free: kernel.func("uintptr_t __stdcall LocalFree(uintptr_t)"),
    root: kernel.func(
      "uintptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, uintptr_t, uint32_t, uint32_t, uintptr_t)",
    ),
    open: nt.func(
      "int32_t __stdcall NtOpenFile(void *, uint32_t, void *, void *, uint32_t, uint32_t)",
    ),
    create: nt.func(
      "int32_t __stdcall NtCreateFile(void *, uint32_t, void *, void *, uintptr_t, uint32_t, uint32_t, uint32_t, uint32_t, uintptr_t, uint32_t)",
    ),
    write: kernel.func(
      "int32_t __stdcall WriteFile(uintptr_t, void *, uint32_t, void *, uintptr_t)",
    ),
    setInfo: kernel.func(
      "int32_t __stdcall SetFileInformationByHandle(uintptr_t, int32_t, void *, uint32_t)",
    ),
    setReparse: kernel.func(
      "int32_t __stdcall DeviceIoControl(uintptr_t, uint32_t, void *, uint32_t, uintptr_t, uint32_t, void *, uintptr_t)",
    ),
    toError: nt.func("uint32_t __stdcall RtlNtStatusToDosError(int32_t)"),
    close: kernel.func("int32_t __stdcall CloseHandle(uintptr_t)"),
    info: kernel.func("int32_t __stdcall GetFileInformationByHandle(uintptr_t, void *)"),
    read: kernel.func("int32_t __stdcall ReadFile(uintptr_t, void *, uint32_t, void *, uintptr_t)"),
    list: kernel.func(
      "int32_t __stdcall GetFileInformationByHandleEx(uintptr_t, int32_t, void *, uint32_t)",
    ),
    control: kernel.func(
      "int32_t __stdcall DeviceIoControl(uintptr_t, uint32_t, uintptr_t, uint32_t, void *, uint32_t, void *, uintptr_t)",
    ),
  };
}

export type Binding = ReturnType<typeof bind>;

// @effect-diagnostics nodeBuiltinImport:off - Native filesystem publication is a Node boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This native boundary must bind the executing process's actual OS ABI.
const nativePlatform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native handle layout must match the executing process's pointer width.
const nativeArchitecture = process.arch;

type Koffi = typeof import("koffi").default;
type NativeFunction = ReturnType<ReturnType<Koffi["load"]>["func"]>;
type NativeResult = { readonly value: unknown; readonly errnoCode: number };
// Native pointers do not retain JS buffers; keep arguments and library handles until completion.
const inFlight = new Set<object>();
const bindings = new Map<Koffi, ReturnType<typeof bindPublication>>();

function bindPublication(koffi: Koffi) {
  const library = koffi.load(nativePlatform === "win32" ? "kernel32.dll" : null);
  if (nativePlatform !== "win32") {
    return {
      kind: "posix" as const,
      library,
      rename: library.func(nativePlatform === "darwin" ? "renameatx_np" : "renameat2", "int32_t", [
        "int32_t",
        "str",
        "int32_t",
        "str",
        "uint32_t",
      ]),
      readError: () => koffi.errno(),
    };
  }
  const getLastError = library.func("uint32_t __stdcall GetLastError(void)");
  return {
    kind: "windows" as const,
    library,
    create: library.func(
      "uintptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, uintptr_t, uint32_t, uint32_t, uintptr_t)",
    ),
    info: library.func("int32_t __stdcall GetFileInformationByHandle(uintptr_t, void *)"),
    rename: library.func(
      "int32_t __stdcall SetFileInformationByHandle(uintptr_t, int32_t, void *, uint32_t)",
    ),
    close: library.func("int32_t __stdcall CloseHandle(uintptr_t)"),
    readError: (): number => getLastError(),
  };
}

function callNative(
  binding: ReturnType<typeof bindPublication>,
  operation: NativeFunction,
  args: unknown[],
): Promise<NativeResult> {
  const retained = { binding, operation, args };
  inFlight.add(retained);
  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = (error: unknown, value: unknown) => {
      // The worker's error state is valid only inside this callback, before any other native call.
      try {
        const errnoCode = binding.readError();
        if (settled) return;
        settled = true;
        if (error !== null && error !== undefined) reject(error);
        else resolve({ value, errnoCode });
      } catch (cause) {
        settled = true;
        reject(cause);
      } finally {
        inFlight.delete(retained);
      }
    };
    try {
      operation.async(...args, complete);
    } catch (cause) {
      if (!settled) {
        settled = true;
        inFlight.delete(retained);
        reject(cause);
      }
    }
  });
}
type ParentIdentity = Pick<NodeFS.BigIntStats, "dev" | "ino">;

export class RenameNoReplaceError extends Error {
  readonly code: "EEXIST" | "UNCONFIRMED";
  constructor(code: "EEXIST" | "UNCONFIRMED", message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "RenameNoReplaceError";
  }
}

function checkResult(result: NativeResult, collision: boolean) {
  throw new RenameNoReplaceError(
    collision ? "EEXIST" : "UNCONFIRMED",
    collision
      ? "destination already exists"
      : `Publication outcome is unconfirmed (${result.errnoCode}); inspect the destination before retrying.`,
  );
}

function boolSucceeded(result: NativeResult) {
  if (
    typeof result.value !== "number" ||
    !Number.isInteger(result.value) ||
    result.value < -0x80000000 ||
    result.value > 0x7fffffff
  ) {
    throw new RenameNoReplaceError(
      "UNCONFIRMED",
      "Publication receipt is invalid; inspect the destination before retrying.",
    );
  }
  return result.value !== 0;
}

function reportHandleCleanup(context: string, cause: unknown) {
  // A failed close may already have released the handle; never retry or replace the native receipt.
  try {
    NodeProcess.emitWarning(
      `Transfer handle cleanup failed (${context}): ${cause instanceof Error ? cause.message : String(cause)}`.slice(
        0,
        1024,
      ),
      { code: "T3_TRANSFER_HANDLE_CLEANUP" },
    );
  } catch {
    // A diagnostic failure cannot change an already-settled publication result.
  }
}

async function publicationResult(run: () => Promise<NativeResult>) {
  try {
    return await run();
  } catch (cause) {
    throw new RenameNoReplaceError(
      "UNCONFIRMED",
      "Publication outcome is unconfirmed; inspect the destination before retrying.",
      { cause },
    );
  }
}

async function renamePosix(
  binding: ReturnType<typeof bindPublication>,
  source: string,
  destination: string,
  signal: AbortSignal | undefined,
  parentIdentity: ParentIdentity,
) {
  const parentPath = NodePath.dirname(source);
  const parent = await NodeFSP.open(
    parentPath,
    // Linux O_PATH and Darwin O_SEARCH avoid requiring directory read permission.
    (nativePlatform === "darwin" ? 0x40000000 : 0x200000) | NodeFS.constants.O_DIRECTORY,
  );
  try {
    const [held, current] = await Promise.all([
      parent.stat({ bigint: true }),
      NodeFSP.stat(parentPath, { bigint: true }),
    ]);
    if (
      held.dev !== current.dev ||
      held.ino !== current.ino ||
      held.dev !== parentIdentity.dev ||
      held.ino !== parentIdentity.ino
    ) {
      throw new Error("The publication parent changed; no rename was submitted.");
    }
    signal?.throwIfAborted();
    const result = await publicationResult(() =>
      callNative(binding, binding.rename, [
        parent.fd,
        NodePath.basename(source),
        parent.fd,
        NodePath.basename(destination),
        nativePlatform === "darwin" ? 4 : 1,
      ]),
    );
    // Abort cannot roll back a submitted rename, and errno is stale on success.
    if (result.value !== 0) checkResult(result, result.errnoCode === 17);
  } finally {
    await parent.close().catch((cause: unknown) => reportHandleCleanup(parentPath, cause));
  }
}

async function renameWindows(
  binding: ReturnType<typeof bindPublication>,
  source: string,
  destination: string,
  signal: AbortSignal | undefined,
  parentIdentity: ParentIdentity,
) {
  if (nativeArchitecture !== "x64" && nativeArchitecture !== "arm64") {
    throw new Error(
      `No atomic publication binding is available for Windows ${nativeArchitecture}.`,
    );
  }
  if (binding.kind !== "windows") throw new Error("Windows publication binding is unavailable.");
  const createHandle = async (path: string, access: number, sharing: number) => {
    const result = await callNative(binding, binding.create, [
      path,
      access,
      sharing,
      0n,
      3,
      0x00200000 | 0x02000000,
      0n,
    ]);
    if (typeof result.value !== "number" && typeof result.value !== "bigint")
      throw new Error("The publication handle is invalid; no rename was submitted.");
    const handle = BigInt.asUintN(64, BigInt(result.value));
    if (handle === 0xffffffffffffffffn) {
      throw new Error(
        `Cannot open publication handle (${result.errnoCode}); no rename was submitted.`,
      );
    }
    return handle;
  };
  const closeHandle = async (handle: bigint) => {
    const result = await publicationResult(() => callNative(binding, binding.close, [handle]));
    if (!boolSucceeded(result)) checkResult(result, false);
  };
  const parent = await createHandle(NodePath.dirname(destination), 0x80, 7);
  try {
    const identity = Buffer.alloc(52);
    const queried = await callNative(binding, binding.info, [parent, identity]);
    const inode = (BigInt(identity.readUInt32LE(44)) << 32n) | BigInt(identity.readUInt32LE(48));
    if (
      !boolSucceeded(queried) ||
      BigInt(identity.readUInt32LE(28)) !== parentIdentity.dev ||
      inode !== parentIdentity.ino
    ) {
      throw new Error(
        "The publication parent identity could not be confirmed; no rename was submitted.",
      );
    }

    // An exclusive source handle prevents new source aliases during the collision check.
    const sourceHandle = await createHandle(source, 0x10000, 0);
    try {
      const existing = await NodeFSP.lstat(destination).catch((cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
        throw cause;
      });
      if (existing !== null) throw new RenameNoReplaceError("EEXIST", "destination already exists");
      const name = Buffer.from(NodePath.basename(destination), "utf16le");
      // FILE_RENAME_INFO: BOOLEAN/union at 0, HANDLE at 8, DWORD at 16, WCHAR[] at 20.
      const info = Buffer.alloc(Math.max(24, 20 + name.byteLength + 2));
      info.writeBigUInt64LE(parent, 8);
      info.writeUInt32LE(name.byteLength, 16);
      name.copy(info, 20);
      signal?.throwIfAborted();
      const result = await publicationResult(() =>
        callNative(binding, binding.rename, [sourceHandle, 3, info, info.byteLength]),
      );
      if (!boolSucceeded(result))
        checkResult(result, result.errnoCode === 80 || result.errnoCode === 183);
    } finally {
      await closeHandle(sourceHandle).catch((cause: unknown) => reportHandleCleanup(source, cause));
    }
  } finally {
    await closeHandle(parent).catch((cause: unknown) =>
      reportHandleCleanup(NodePath.dirname(destination), cause),
    );
  }
}

export async function renameNoReplace(input: {
  readonly source: string;
  readonly parentIdentity: ParentIdentity;
  readonly destination: string;
  readonly signal?: AbortSignal;
  readonly loadKoffi?: () => Promise<Koffi>;
}): Promise<void> {
  const { source, destination, signal } = input;
  if (
    !NodePath.isAbsolute(source) ||
    !NodePath.isAbsolute(destination) ||
    NodePath.dirname(source) !== NodePath.dirname(destination) ||
    source === destination ||
    [source, destination].some(
      (path) => path.includes("\0") || [".", "..", ""].includes(NodePath.basename(path)),
    )
  ) {
    throw new Error("Atomic publication requires distinct absolute sibling paths.");
  }
  signal?.throwIfAborted();
  if (!["linux", "darwin", "win32"].includes(nativePlatform)) {
    throw new Error(`Atomic no-replace publication is unavailable on ${nativePlatform}.`);
  }
  const koffi = await (input.loadKoffi ?? (async () => (await import("koffi")).default))();
  let binding = bindings.get(koffi);
  if (binding === undefined) {
    binding = bindPublication(koffi);
    bindings.set(koffi, binding);
  }
  if (nativePlatform === "win32")
    await renameWindows(binding, source, destination, signal, input.parentIdentity);
  else await renamePosix(binding, source, destination, signal, input.parentIdentity);
}

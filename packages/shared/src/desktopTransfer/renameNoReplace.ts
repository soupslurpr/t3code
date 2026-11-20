// @effect-diagnostics nodeBuiltinImport:off - Native filesystem publication is a Node boundary.
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import type { WorkspaceMutationScope } from "./mutationScope.ts";
import { callNative, type Koffi, type NativeResult } from "./native.ts";
import {
  checkRenameMount,
  checkTransferName,
  sameEntry,
  type EntryIdentity,
} from "./entryNative.ts";
import type { BoundTransferEntry } from "./entry.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This native boundary must bind the executing process's actual OS ABI.
const nativePlatform = process.platform;
const bindings = new WeakMap<Koffi, ReturnType<typeof bindPublication>>();

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
    rename: library.func(
      "int32_t __stdcall SetFileInformationByHandle(uintptr_t, int32_t, void *, uint32_t)",
    ),
    readError: (): number => getLastError(),
  };
}

export class RenameNoReplaceError extends Schema.TaggedError<RenameNoReplaceError>()(
  "RenameNoReplaceError",
  {
    code: Schema.Literals(["EEXIST", "UNCONFIRMED"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const isRenameNoReplaceError = Schema.is(RenameNoReplaceError);

function checkResult(result: NativeResult, collision: boolean) {
  throw new RenameNoReplaceError({
    code: collision ? "EEXIST" : "UNCONFIRMED",
    message: collision
      ? "destination already exists"
      : `Publication outcome is unconfirmed (${result.errnoCode}); inspect the destination before retrying.`,
  });
}

function boolSucceeded(result: NativeResult) {
  if (
    typeof result.value !== "number" ||
    !Number.isInteger(result.value) ||
    result.value < -0x80000000 ||
    result.value > 0x7fffffff
  ) {
    throw new RenameNoReplaceError({
      code: "UNCONFIRMED",
      message: "Publication receipt is invalid; inspect the destination before retrying.",
    });
  }
  return result.value !== 0;
}

async function publicationResult(run: () => Promise<NativeResult>) {
  try {
    return await run();
  } catch (cause) {
    throw new RenameNoReplaceError({
      code: "UNCONFIRMED",
      message: "Publication outcome is unconfirmed; inspect the destination before retrying.",
      cause,
    });
  }
}

async function submitWindowsRename(
  binding: Extract<ReturnType<typeof bindPublication>, { kind: "windows" }>,
  source: bigint | number,
  parent: bigint | number,
  destination: string,
  signal?: AbortSignal,
) {
  const name = Buffer.from(destination, "utf16le");
  // FILE_RENAME_INFO: BOOLEAN/union at 0, HANDLE at 8, DWORD at 16, WCHAR[] at 20.
  const info = Buffer.alloc(Math.max(24, 20 + name.byteLength + 2));
  info.writeBigUInt64LE(BigInt(parent), 8);
  info.writeUInt32LE(name.byteLength, 16);
  name.copy(info, 20);
  signal?.throwIfAborted();
  const result = await publicationResult(() =>
    callNative(binding, binding.rename, [source, 3, info, info.byteLength]),
  );
  if (!boolSucceeded(result))
    checkResult(result, result.errnoCode === 80 || result.errnoCode === 183);
}

export async function renameBoundNoReplace(input: {
  readonly sourceParent: BoundTransferEntry;
  readonly source: string;
  readonly sourceIdentity: EntryIdentity;
  readonly destinationParent: BoundTransferEntry;
  readonly destination: string;
  readonly koffi: Koffi;
  readonly signal?: AbortSignal;
  readonly beforeSubmit?: () => Promise<void>;
  readonly mutations?: WorkspaceMutationScope;
  readonly root: BoundTransferEntry;
}) {
  checkTransferName(input.source);
  checkTransferName(input.destination);
  checkRenameMount(input.sourceParent, input.destinationParent);
  const binding = publicationBinding(input.koffi);
  await input.mutations?.ready();
  await using source = await input.sourceParent.child(input.source, "rename");
  if (!sameEntry(source.identity, input.sourceIdentity))
    throw new Error("The transfer source identity changed before publication.");
  if (nativePlatform === "linux") checkRenameMount(source, input.sourceParent);
  input.signal?.throwIfAborted();
  if (binding.kind === "windows") {
    // Windows can report success when the target is already a hard link to the source.
    await using existing = await input.destinationParent
      .child(input.destination)
      .catch((cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
        throw cause;
      });
    if (existing)
      throw new RenameNoReplaceError({ code: "EEXIST", message: "destination already exists" });
    await input.beforeSubmit?.();
    await submitWindowsRename(
      binding,
      source.handle,
      input.destinationParent.handle,
      input.destination,
      input.signal,
    );
  } else {
    await input.beforeSubmit?.();
    await using current = await input.sourceParent.child(input.source);
    if (!sameEntry(current.identity, source.identity))
      throw new Error("The transfer source changed before publication.");
    input.signal?.throwIfAborted();
    // Darwin's rooted lookup and Linux's Landlock worker check containment inside the rename itself.
    const rooted = (parent: BoundTransferEntry, name: string) => {
      const relative = NodePath.relative(input.root.path, NodePath.join(parent.path, name));
      if (
        nativePlatform === "darwin" &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        relative !== ".." &&
        !NodePath.isAbsolute(relative)
      )
        return [input.root.handle, relative] as const;
      return [parent.handle, name] as const;
    };
    const from = rooted(input.sourceParent, input.source);
    const to = rooted(input.destinationParent, input.destination);
    const nested = from[1] !== input.source || to[1] !== input.destination;
    const args = [...from, ...to, nativePlatform === "darwin" ? (nested ? 0x34 : 4) : 1];
    const result = await publicationResult(() =>
      input.mutations
        ? input.mutations.run("rename", args)
        : callNative(binding, binding.rename, args),
    );
    if (result.value !== 0) checkResult(result, result.errnoCode === 17);
    await using published = await input.destinationParent
      .child(input.destination)
      .catch(() => null);
    if (!published || !sameEntry(published.identity, source.identity))
      throw new RenameNoReplaceError({
        code: "UNCONFIRMED",
        message: "The published entry identity changed. Inspect the destination before retrying.",
      });
  }
}

function publicationBinding(koffi: Koffi) {
  let binding = bindings.get(koffi);
  if (binding === undefined) {
    binding = bindPublication(koffi);
    bindings.set(koffi, binding);
  }
  return binding;
}

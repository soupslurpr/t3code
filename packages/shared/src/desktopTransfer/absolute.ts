// @effect-diagnostics nodeBuiltinImport:off - The broker has already admitted this absolute path.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import { DesktopTransferError } from "./errors.ts";
import { bindWorkspaceTransfer } from "./workspace.ts";
import type { Koffi } from "./native.ts";
import { AgentDesktopBundleError } from "./format.ts";

const requireNative = NodeModule.createRequire(import.meta.url);
export const loadTransferKoffi = async (): Promise<Koffi> => requireNative("koffi") as Koffi;

export async function existingAncestor(path: string) {
  let root = path;
  for (;;) {
    try {
      await NodeFSP.lstat(root);
      return root;
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      const parent = NodePath.dirname(root);
      if (root === parent) throw cause;
      root = parent;
    }
  }
}

export async function bindAbsoluteTransfer(
  path: string,
  source: boolean,
  loadKoffi = loadTransferKoffi,
  options?: Parameters<typeof bindWorkspaceTransfer>[4],
) {
  if (path.includes("\0") || !NodePath.isAbsolute(path))
    throw new DesktopTransferError({
      code: source ? "invalid-source" : "invalid-destination",
      message: "Absolute transfer paths must be valid absolute paths.",
    });
  const named = NodePath.resolve(path);
  const parent = NodePath.dirname(named);
  if (!source && named === parent)
    throw new DesktopTransferError({
      code: "invalid-destination",
      message: "Choose a child path as the destination.",
    });
  if (source) {
    const stats = await NodeFSP.lstat(named);
    if (!stats.isFile() && !stats.isDirectory())
      throw new AgentDesktopBundleError({
        code: stats.isSymbolicLink() ? "invalid-entry" : "unsupported-entry",
        message: "A bundle source must be a regular file or directory.",
        entryPath: ".",
      });
  }
  const root = source ? parent : await existingAncestor(parent);
  return bindWorkspaceTransfer(
    root,
    NodePath.relative(root, named) || ".",
    source,
    loadKoffi,
    options,
  );
}

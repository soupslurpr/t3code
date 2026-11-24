// @effect-diagnostics nodeBuiltinImport:off - Binds workspace imports to opened filesystem objects.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { DesktopTransferError } from "./errors.ts";
import { workspaceMutationScope } from "./mutationScope.ts";
import { openTransferRoot, type BoundTransferEntry } from "./entry.ts";
import { checkTransferName, onTransferMount, sameEntry } from "./entryNative.ts";
import type { Koffi } from "./native.ts";
import type { AgentDesktopBundleCollision } from "./format.ts";

const missing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const inodeKey = (entry: { readonly dev: bigint; readonly ino: bigint }) =>
  `${entry.dev}:${entry.ino}`;
const splitPathSegments = (value: string) =>
  (NodeProcess.platform === "win32" ? value.split(/[\\/]+/) : value.split(/\/+/)).filter(Boolean);
async function ancestorInodeKeys(startPath: string) {
  const keys = new Set<string>();
  let current = NodePath.resolve(startPath);
  for (;;) {
    try {
      keys.add(inodeKey(await NodeFSP.stat(current, { bigint: true })));
    } catch (cause) {
      if (!missing(cause)) throw cause;
    }
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return keys;
}
async function storageInodeKeys(rawPath: string) {
  const full = NodePath.isAbsolute(rawPath) ? rawPath : NodePath.join(NodeProcess.cwd(), rawPath);
  const keys = new Set<string>();
  const addLstat = async (path: string) => {
    const entry = await NodeFSP.lstat(path, { bigint: true });
    keys.add(inodeKey(entry));
    return entry;
  };
  let current = NodePath.parse(full).root;
  await addLstat(current);
  const pending = splitPathSegments(full.slice(current.length)).reverse();
  let symlinks = 0;
  while (pending.length > 0) {
    const segment = pending.pop()!;
    if (segment === ".") continue;
    if (segment === "..") {
      current = NodePath.dirname(current);
      await addLstat(current);
      continue;
    }
    const next = NodePath.join(current, segment);
    const entry = await addLstat(next);
    if (entry.isSymbolicLink()) {
      symlinks += 1;
      if (symlinks > 40) {
        throw new DesktopTransferError({
          code: "invalid-destination",
          message: "Transfer storage path has too many symbolic links.",
        });
      }
      const target = await NodeFSP.readlink(next);
      if (NodePath.isAbsolute(target)) {
        const targetRoot = NodePath.parse(target).root;
        current =
          NodeProcess.platform === "win32" && (targetRoot === "\\" || targetRoot === "/")
            ? NodePath.parse(current).root
            : targetRoot;
        await addLstat(current);
        pending.push(...splitPathSegments(target.slice(targetRoot.length)).reverse());
      } else {
        pending.push(...splitPathSegments(target).reverse());
      }
      continue;
    }
    current = next;
  }
  return keys;
}
export const linux = NodeProcess.platform === "linux";
export async function existingChild(parent: BoundTransferEntry, name: string, list = false) {
  try {
    return await parent.child(name, list ? "list" : "inspect");
  } catch (cause) {
    if (missing(cause)) return null;
    throw cause;
  }
}

const editControlNames = new Set([".git", "git~1", ".agents", ".codex", ".claude"]);
function checkEditComponents(components: ReadonlyArray<string>) {
  if (
    components.some((name) =>
      editControlNames.has((name.split(":")[0] ?? "").replace(/[ .]+$/, "").toLowerCase()),
    )
  )
    throw new DesktopTransferError({
      code: "permission-denied",
      message:
        "This destination includes repository or agent configuration. Use the provider’s approved write path for this change.",
    });
}

export function checkReplaceableMount(parent: BoundTransferEntry, entry: BoundTransferEntry) {
  if (linux && !onTransferMount(entry, parent))
    throw new DesktopTransferError({
      code: "unsupported-entry",
      message:
        "Cannot replace a Linux mount point, a subvolume, or a directory containing one. Choose a different destination or merge into the directory.",
    });
}

export async function checkReplacement(
  parent: BoundTransferEntry,
  entry: BoundTransferEntry,
  destination: string,
  checkEntry: typeof checkEditComponents | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  checkReplaceableMount(parent, entry);
  if (entry.kind !== "directory" || (!linux && !checkEntry)) return;
  try {
    // Linux can list the held O_PATH directory directly through /proc/self/fd.
    await using listed = linux ? null : await parent.child(NodePath.basename(entry.path), "list");
    if (listed && !sameEntry(listed.identity, entry.identity))
      throw new Error("The existing directory changed during permission checking.");
    const directory = listed ?? entry;
    for (const name of await directory.names()) {
      checkEntry?.([name]);
      await using child = await directory.child(name);
      await checkReplacement(
        directory,
        child,
        NodePath.join(destination, name),
        checkEntry,
        signal,
      );
    }
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "EACCES" || cause.code === "EPERM")
    )
      throw new DesktopTransferError({
        code: "permission-denied",
        message: `Cannot inspect the destination directory ${JSON.stringify(destination)} for replacement. Choose a different destination or grant the T3 server read and search access to this directory.`,
      });
    throw cause;
  }
}

export async function removePrivateWrapper(parent: BoundTransferEntry, entry: BoundTransferEntry) {
  checkReplaceableMount(parent, entry);
  if (entry.kind === "directory") {
    await entry.allowDirectoryCleanup();
    await using listed = await parent.child(NodePath.basename(entry.path), "list");
    if (!sameEntry(listed.identity, entry.identity))
      throw new Error("The private staging directory changed.");
    for (const name of await listed.names()) {
      await using child = await listed.child(name);
      await removePrivateWrapper(listed, child);
    }
  }
  await parent.remove(NodePath.basename(entry.path), entry);
}

export async function bindWorkspaceTransfer(
  rootPath: string,
  relativePath: string,
  source: boolean,
  loadKoffi: () => Promise<Koffi>,
  options?: {
    readonly editOnly: boolean;
    readonly stagingDirectory: string;
    readonly archiveDirectory?: string;
    readonly collision?: AgentDesktopBundleCollision;
  },
) {
  const invalid = (message: string) =>
    new DesktopTransferError({ code: source ? "invalid-source" : "invalid-destination", message });
  const root = NodePath.resolve(rootPath);
  const named = NodePath.resolve(root, relativePath);
  const inside = (base: string, value: string) => {
    const part = NodePath.relative(base, value);
    return part !== ".." && !part.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(part);
  };
  if (
    relativePath.includes("\0") ||
    NodePath.isAbsolute(relativePath) ||
    !inside(root, named) ||
    (!source && named === root)
  )
    throw invalid(
      "Workspace transfer paths must stay inside the thread workspace. Choose a child path as the destination.",
    );
  const checkEntry = options?.editOnly && !source ? checkEditComponents : undefined;
  checkEntry?.(NodePath.relative(root, named).split(NodePath.sep));
  const canonicalRoot = await NodeFSP.realpath(root);
  // Resolve in-root aliases once, then walk the canonical components from the held root.
  const parentPath = named === root ? root : NodePath.dirname(named);
  let existingPath = parentPath;
  const suffix: string[] = [];
  for (;;) {
    try {
      await NodeFSP.lstat(existingPath);
      break;
    } catch (cause) {
      if (!missing(cause) || source || existingPath === root) throw cause;
      suffix.unshift(NodePath.basename(existingPath));
      existingPath = NodePath.dirname(existingPath);
    }
  }
  const canonicalParent = await NodeFSP.realpath(existingPath);
  if (!inside(canonicalRoot, canonicalParent))
    throw invalid("The transfer path resolves outside the thread workspace.");
  const koffi = await loadKoffi();
  const resources = new AsyncDisposableStack();
  try {
    const rootEntry = resources.use(
      await openTransferRoot(canonicalRoot, koffi, source && named === root ? "list" : "inspect"),
    );
    const ancestors = [rootEntry];
    const changed = () =>
      invalid(
        "The admitted workspace entry changed. Inspect the destination and start a new copy.",
      );
    const verifyDirectory = async (path: string, expected: BoundTransferEntry) => {
      await using current = linux ? await openTransferRoot(path, koffi, "followAlias") : null;
      if (
        !sameEntry(
          expected.identity,
          current?.identity ?? (await NodeFSP.stat(path, { bigint: true })),
        )
      )
        throw changed();
    };
    if (rootEntry.kind !== "directory") throw changed();
    await verifyDirectory(root, rootEntry);
    let parent = rootEntry;
    for (const segment of NodePath.relative(canonicalRoot, canonicalParent)
      .split(NodePath.sep)
      .filter(Boolean)) {
      const next = resources.use(await parent.child(segment));
      if (next.kind !== "directory") throw changed();
      ancestors.push(next);
      parent = next;
    }
    const separateParent = existingPath !== root || parent !== rootEntry;
    if (separateParent) await verifyDirectory(existingPath, parent);
    const names = named === root ? [] : [...suffix, NodePath.basename(named)];
    names.forEach(checkTransferName);
    const leaf =
      names.length === 0
        ? rootEntry
        : resources.use(await existingChild(parent, names[0]!, source));
    if (suffix.length && leaf) throw changed();
    if (source && (!leaf || leaf.kind === "symlink" || leaf.kind === "other"))
      throw invalid("Choose an existing regular file or directory inside the workspace.");
    const verify = async (checkLeaf = true) => {
      await verifyDirectory(root, rootEntry);
      if (separateParent) await verifyDirectory(existingPath, parent);
      for (let index = 1; index < ancestors.length; index++) {
        const expected = ancestors[index]!;
        await using current = await ancestors[index - 1]!.child(NodePath.basename(expected.path));
        if (!sameEntry(current.identity, expected.identity)) throw changed();
      }
      if (checkLeaf && names.length) {
        await using current = await existingChild(parent, names[0]!);
        if (current && leaf ? !sameEntry(current.identity, leaf.identity) : current !== leaf)
          throw changed();
      }
    };
    const logicalTarget = NodePath.join(parent.path, ...names);
    checkEntry?.(NodePath.relative(canonicalRoot, logicalTarget).split(NodePath.sep));
    if (options && !source) {
      const targetAncestors = await ancestorInodeKeys(parent.path);
      for (const entry of ancestors) targetAncestors.add(inodeKey(entry.identity));
      const leafKey = leaf !== null ? inodeKey(leaf.identity) : null;
      const storageDirs =
        options.archiveDirectory && options.archiveDirectory !== options.stagingDirectory
          ? [options.stagingDirectory, options.archiveDirectory]
          : [options.stagingDirectory];
      for (const storageDir of storageDirs) {
        const configured = NodePath.resolve(storageDir);
        const storage = await NodeFSP.realpath(storageDir);
        const storageKey = inodeKey(await NodeFSP.stat(storage, { bigint: true }));
        const storageAncestors = await storageInodeKeys(storageDir);
        if (
          inside(logicalTarget, storage) ||
          inside(storage, logicalTarget) ||
          inside(logicalTarget, configured) ||
          inside(configured, logicalTarget) ||
          targetAncestors.has(storageKey) ||
          (leafKey !== null && (leafKey === storageKey || storageAncestors.has(leafKey)))
        )
          throw invalid("Choose a destination separate from the server's transfer storage.");
      }
    }
    const openPublication = async (
      storage: AsyncDisposableStack,
      directory: string,
      collision: AgentDesktopBundleCollision,
    ) => {
      const staging = storage.use(await openTransferRoot(directory, koffi));
      const recovery =
        options && options.stagingDirectory !== directory
          ? storage.use(await openTransferRoot(options.stagingDirectory, koffi))
          : staging;
      if (collision === "replace" && leaf) checkReplaceableMount(parent, leaf);
      const destination =
        linux && collision === "merge" && leaf?.kind === "directory" ? leaf : parent;
      const crossMount =
        !onTransferMount(staging, destination) ||
        (collision !== "create" && leaf !== null && !onTransferMount(recovery, destination));
      const stagingParent = !onTransferMount(destination, parent)
        ? destination
        : NodeProcess.platform === "darwin"
          ? ancestors.find((entry) => entry.identity.dev === parent.identity.dev)!
          : parent;
      const confined = linux
        ? storage.use(
            workspaceMutationScope([
              rootEntry.handle,
              staging.handle,
              ...(recovery === staging ? [] : [recovery.handle]),
            ]),
          )
        : null;
      if (
        confined &&
        (crossMount ||
          parent !== rootEntry ||
          (collision !== "create" && leaf?.kind === "directory"))
      ) {
        try {
          await confined.ready();
        } catch {
          throw new DesktopTransferError({
            code: "unsupported-entry",
            message:
              "This destination requires Landlock ABI 2 or newer on a Linux x64 or arm64 server. Choose a new entry in the workspace root on the same mount as transfer storage and, on Btrfs, in the same subvolume. You can also enable Landlock on a supported server.",
          });
        }
      }
      return { staging, recovery, confined, stagingParent, crossMount };
    };
    const pinParents = async (pins: AsyncDisposableStack) => {
      if (NodeProcess.platform !== "win32") return;
      // Denying delete sharing on each ancestor prevents reparenting during publication.
      let pinned = pins.use(await openTransferRoot(canonicalRoot, koffi, "pin"));
      if (!sameEntry(pinned.identity, rootEntry.identity)) throw changed();
      for (const ancestor of ancestors.slice(1)) {
        pinned = pins.use(await pinned.child(NodePath.basename(ancestor.path), "pin"));
        if (!sameEntry(pinned.identity, ancestor.identity)) throw changed();
      }
    };
    if (
      !source &&
      options?.collision === "replace" &&
      leaf?.kind === "directory" &&
      (linux || checkEntry)
    ) {
      await checkReplacement(parent, leaf, NodePath.relative(canonicalRoot, leaf.path), checkEntry);
      await verify();
    }
    const archiveDirectory = options?.archiveDirectory ?? options?.stagingDirectory;
    const collision = options?.collision ?? "create";
    const admittedStorage =
      linux && !source && archiveDirectory
        ? await openPublication(resources, archiveDirectory, collision)
        : null;
    const lifetime = resources.move();
    return {
      source,
      named,
      parent,
      root: rootEntry,
      leaf,
      names,
      verify,
      koffi,
      checkEntry,
      pinParents,
      publication: (
        storage: AsyncDisposableStack,
        directory: string,
        mode: AgentDesktopBundleCollision,
      ) =>
        admittedStorage && directory === archiveDirectory && mode === collision
          ? Promise.resolve(admittedStorage)
          : openPublication(storage, directory, mode),
      [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
    };
  } finally {
    await resources.disposeAsync();
  }
}

export type WorkspaceTransferPath = Awaited<ReturnType<typeof bindWorkspaceTransfer>>;

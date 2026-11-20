// @effect-diagnostics nodeBuiltinImport:off - Binds workspace imports to opened filesystem objects.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { DesktopTransferError } from "./errors.ts";
import { copyToWorkspaceVolume, volumeChildren, type VolumeEntries } from "./volume.ts";
import {
  existingChild,
  linux,
  checkReplaceableMount,
  checkReplacement,
  removePrivateWrapper,
  type WorkspaceTransferPath,
} from "./workspace.ts";
import { checkRenameMount, onTransferMount, sameEntry, type EntryIdentity } from "./entryNative.ts";
import type { BoundTransferEntry } from "./entry.ts";
import { renameBoundNoReplace } from "./renameNoReplace.ts";
import type { Koffi } from "./native.ts";
import type { AgentDesktopBundleCollision, AgentDesktopBundleRootType } from "./format.ts";
export async function publishWorkspaceTransfer(input: {
  readonly workspace: WorkspaceTransferPath;
  readonly stagingPath: string;
  readonly stagingIdentity: EntryIdentity;
  readonly beforePublish?: () => Promise<void>;
  readonly rootType: AgentDesktopBundleRootType;
  readonly collision: AgentDesktopBundleCollision;
  readonly loadKoffi?: () => Promise<Koffi>;
  readonly signal?: AbortSignal;
}) {
  const { workspace, signal } = input;
  const koffi = await (input.loadKoffi?.() ?? workspace.koffi);
  await workspace.verify(input.collision !== "create");
  signal?.throwIfAborted();
  const first = workspace.names[0];
  if (!first) throw new Error("Workspace import requires a child destination.");
  if (
    input.collision === "merge" &&
    (input.rootType !== "directory" || (workspace.leaf && workspace.leaf.kind !== "directory"))
  )
    throw new DesktopTransferError({
      code: "destination-type-mismatch",
      message: "Merge needs a directory source and directory destination.",
    });
  await using pins = new AsyncDisposableStack();
  await workspace.pinParents(pins);
  const privatePath = NodePath.dirname(input.stagingPath);
  const { staging, recovery, confined, stagingParent, crossMount } = await workspace.publication(
    pins,
    privatePath,
    input.collision,
  );
  const stageNameOnVolume = `.t3-transfer-${NodeCrypto.randomUUID()}`;
  let volumeStage: BoundTransferEntry | null = null;
  if (crossMount) {
    if (NodeProcess.platform === "darwin" && stagingParent !== workspace.root)
      throw new Error(
        "Open the mounted directory as the thread workspace to import onto this volume.",
      );
    await input.beforePublish?.();
    await workspace.verify(stagingParent === workspace.leaf);
    signal?.throwIfAborted();
    volumeStage = await stagingParent.child(
      stageNameOnVolume,
      "privateDirectory",
      confined ?? undefined,
    );
    if (NodeProcess.platform !== "win32" && (volumeStage.stats.mode & 0o077) !== 0) {
      await volumeStage[Symbol.asyncDispose]();
      await stagingParent.remove(
        stageNameOnVolume,
        volumeStage,
        confined ?? undefined,
        workspace.root,
      );
      throw new Error("The destination filesystem cannot create private transfer staging.");
    }
  }
  const backups = volumeStage ?? recovery;
  const verifyVolume = async () => {
    await workspace.verify(stagingParent === workspace.leaf);
    if (volumeStage) {
      await using named = await stagingParent.child(stageNameOnVolume);
      if (!sameEntry(named.identity, volumeStage.identity))
        throw new Error("Private staging on the workspace volume changed.");
    }
  };
  // Move each retired entry into private storage before deleting it. An open writer in the old tree
  // can replace children, so recursive pathname removal of a former workspace directory is unsafe.
  const discard = async (saved: BoundTransferEntry): Promise<void> => {
    checkReplaceableMount(backups, saved);
    if (saved.kind !== "directory") {
      await backups.remove(
        NodePath.basename(saved.path),
        saved,
        undefined,
        volumeStage ? workspace.root : undefined,
      );
      return;
    }
    await saved.allowDirectoryCleanup();
    await using directory = await backups.child(NodePath.basename(saved.path), "list");
    if (!sameEntry(directory.identity, saved.identity))
      throw new Error("The retired directory identity changed.");
    for (const name of await directory.names()) {
      const retired = `backup-${NodeCrypto.randomUUID()}`;
      await using child = await directory.child(name);
      await move(directory, child, backups, retired, undefined, false);
      await using moved = await backups.child(retired);
      if (!sameEntry(moved.identity, child.identity))
        throw new Error("A changed backup entry was retained in private transfer storage.");
      await discard(moved);
    }
    await directory[Symbol.asyncDispose]();
    await backups.remove(
      NodePath.basename(saved.path),
      saved,
      undefined,
      volumeStage ? workspace.root : undefined,
    );
  };
  const move = async (
    from: BoundTransferEntry,
    source: BoundTransferEntry,
    into: BoundTransferEntry,
    dest: string,
    beforeSubmit?: () => Promise<void>,
    cancellable = true,
  ) => {
    await renameBoundNoReplace({
      root: workspace.root,
      ...(confined &&
      (volumeStage ||
        [from, into].some((dir) => dir !== staging && dir !== recovery && dir !== workspace.root))
        ? { mutations: confined }
        : {}),
      sourceParent: from,
      source: NodePath.basename(source.path),
      sourceIdentity: source.identity,
      destinationParent: into,
      destination: dest,
      koffi,
      ...(beforeSubmit ? { beforeSubmit } : {}),
      ...(cancellable && signal ? { signal } : {}),
    });
  };
  const ownedOnVolume: VolumeEntries = new Map();
  const checkStagedTree = async (
    parent: BoundTransferEntry,
    entry: BoundTransferEntry,
  ): Promise<void> => {
    if (!volumeStage) return;
    signal?.throwIfAborted();
    const name = NodePath.basename(entry.path);
    const expected = volumeChildren(ownedOnVolume, parent).get(name);
    if (!expected || !sameEntry(expected, entry.identity))
      throw new Error("The staged workspace entry changed.");
    if (entry.kind !== "directory") return;
    await using listed = await parent.child(name, "list");
    if (!sameEntry(listed.identity, expected))
      throw new Error("The staged workspace directory changed.");
    const names = await listed.names();
    if (names.length !== volumeChildren(ownedOnVolume, listed).size)
      throw new Error("The staged directory contents changed.");
    for (const childName of names) {
      workspace.checkEntry?.([childName]);
      await using child = await listed.child(childName);
      await checkStagedTree(listed, child);
    }
  };
  const install = async (
    sourceParent: BoundTransferEntry,
    source: BoundTransferEntry,
    targetParent: BoundTransferEntry,
    targetName: string,
    target: BoundTransferEntry | null,
    merge: boolean,
    verify: () => Promise<void>,
  ): Promise<void> => {
    signal?.throwIfAborted();
    await verify();
    if (merge && source.kind === "directory" && target?.kind === "directory") {
      await using pinned =
        NodeProcess.platform === "win32" ? await targetParent.child(targetName, "pin") : null;
      if (pinned && !sameEntry(pinned.identity, target.identity))
        throw new Error("The destination directory changed.");
      const verifyChild = async () => {
        await verify();
        await using current = await targetParent.child(targetName);
        if (!sameEntry(current.identity, target.identity))
          throw new Error("The merge directory changed during installation.");
      };
      await using listed = await sourceParent.child(NodePath.basename(source.path), "list");
      if (!sameEntry(listed.identity, source.identity))
        throw new Error("The staged merge source changed.");
      const children = await listed.names();
      if (volumeStage && children.length !== volumeChildren(ownedOnVolume, listed).size)
        throw new Error("The staged merge directory changed.");
      children.sort((left, right) => left.localeCompare(right));
      for (const name of children) {
        signal?.throwIfAborted();
        workspace.checkEntry?.([name]);
        await using child = await source.child(name);
        if (volumeStage) {
          const expected = volumeChildren(ownedOnVolume, source).get(name);
          if (!expected || !sameEntry(expected, child.identity))
            throw new Error("The staged merge entry changed.");
        }
        await using previous = await existingChild(target, name);
        await install(source, child, target, name, previous, true, verifyChild);
      }
      return;
    }
    const destination = NodePath.relative(
      workspace.root.path,
      NodePath.join(targetParent.path, targetName),
    );
    const verifyWrite = async () => {
      await input.beforePublish?.();
      await verify();
    };
    const beforeInstall = async (saved?: BoundTransferEntry) => {
      await verifyWrite();
      await checkStagedTree(sourceParent, source);
      if (saved) {
        await using current = await backups.child(NodePath.basename(saved.path));
        if (!sameEntry(saved.identity, current.identity))
          throw new Error("The private backup changed before publication.");
        await checkReplacement(backups, current, destination, workspace.checkEntry, signal);
      }
      if (volumeStage || saved?.kind === "directory") await verifyWrite();
    };
    if (!target || input.collision === "create") {
      await move(sourceParent, source, targetParent, targetName, beforeInstall);
      return;
    }
    checkRenameMount(sourceParent, targetParent);
    checkRenameMount(target, targetParent);
    // Windows takes an exclusive rename handle before running the publication callback.
    if (!linux)
      await checkReplacement(targetParent, target, destination, workspace.checkEntry, signal);
    const backup = `backup-${NodeCrypto.randomUUID()}`;
    const restore = async (saved: BoundTransferEntry, error: unknown): Promise<never> => {
      try {
        await verify();
        await move(backups, saved, targetParent, targetName, verify, false);
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          `Could not confirm rollback. Inspect the destination and the private backup at ${saved.path} before retrying.`,
          { cause: rollback },
        );
      }
      throw error;
    };
    await verify();
    try {
      await move(targetParent, target, backups, backup, async () => {
        await verifyWrite();
        if (linux && target.kind === "directory") {
          await checkReplacement(targetParent, target, destination, workspace.checkEntry, signal);
          await verifyWrite();
        }
      });
    } catch (error) {
      // A lost native receipt may follow a successful move to private storage.
      await using saved = await existingChild(backups, backup);
      if (saved) await restore(saved, error);
      throw error;
    }
    await using saved = await backups.child(backup);
    try {
      if (!sameEntry(saved.identity, target.identity))
        throw new Error("The destination changed while being backed up.");
      await verify();
      await move(sourceParent, source, targetParent, targetName, () => beforeInstall(saved));
    } catch (error) {
      await restore(saved, error);
    }
    try {
      await discard(saved);
    } catch (cause) {
      throw new Error(
        `The workspace entry was published. Cleanup of the private backup at ${saved.path} could not be confirmed.`,
        { cause },
      );
    }
  };
  let stageName = NodePath.basename(input.stagingPath);
  let wrapper: string | undefined;
  let wrapperIdentity: EntryIdentity | undefined;
  const removeVolumePayload = async (parent: BoundTransferEntry, name: string): Promise<void> => {
    await verifyVolume();
    await using current = await existingChild(parent, name);
    if (!current) return;
    checkReplaceableMount(parent, current);
    const expected = volumeChildren(ownedOnVolume, parent).get(name);
    if (!expected || !sameEntry(current.identity, expected))
      throw new Error("A changed filesystem staging entry was retained.");
    if (current.kind === "directory") {
      await current.allowDirectoryCleanup();
      await using listed = await parent.child(name, "list");
      if (!sameEntry(listed.identity, expected)) throw new Error("The staging directory changed.");
      for (const child of await listed.names()) await removeVolumePayload(listed, child);
    }
    await parent.remove(name, current, undefined, workspace.root);
  };
  const cleanup = async () => {
    if (volumeStage) {
      try {
        await verifyVolume();
        await removeVolumePayload(volumeStage, "payload");
        const remaining = await volumeStage.names();
        if (!remaining.length) {
          await volumeStage[Symbol.asyncDispose]();
          await stagingParent.remove(stageNameOnVolume, volumeStage, confined ?? undefined);
        } else
          throw new Error(
            `Inspect retained transfer storage at ${volumeStage.path} before retrying.`,
          );
      } finally {
        await volumeStage[Symbol.asyncDispose]();
      }
    }
    if (wrapper && wrapperIdentity) {
      await using current = await existingChild(staging, NodePath.basename(wrapper));
      if (current && sameEntry(current.identity, wrapperIdentity)) {
        if (linux) await removePrivateWrapper(staging, current);
        else await NodeFSP.rm(wrapper, { recursive: true, force: true });
      }
    }
  };
  try {
    await using original = await staging.child(stageName);
    if (
      !onTransferMount(original, staging) ||
      original.identity.dev !== input.stagingIdentity.dev ||
      original.identity.ino !== input.stagingIdentity.ino
    )
      throw new Error("The staged payload identity changed.");
    if (workspace.names.length > 1) {
      wrapper = await NodeFSP.mkdtemp(NodePath.join(privatePath, "parents-"));
      await using created = await staging.child(NodePath.basename(wrapper));
      checkRenameMount(created, staging);
      wrapperIdentity = created.identity;
      const nested = NodePath.join(wrapper, ...workspace.names.slice(1));
      await NodeFSP.mkdir(NodePath.dirname(nested), { recursive: true });
      await NodeFSP.rename(input.stagingPath, nested);
      stageName = NodePath.basename(wrapper);
    }
    if (volumeStage) {
      await copyToWorkspaceVolume(
        NodePath.join(privatePath, stageName),
        volumeStage,
        "payload",
        async () => {
          await input.beforePublish?.();
          await verifyVolume();
        },
        {
          buffer: Buffer.allocUnsafe(256 * 1024),
          owned: ownedOnVolume,
          move,
          remove: removeVolumePayload,
          darwinRoot: NodeProcess.platform === "darwin" ? workspace.root : null,
          ...(signal ? { signal } : {}),
        },
      );
      stageName = "payload";
    }
    const sourceParent = volumeStage ?? staging;
    await using payload = await sourceParent.child(stageName);
    if (
      volumeStage &&
      !sameEntry(payload.identity, volumeChildren(ownedOnVolume, sourceParent).get(stageName)!)
    )
      throw new Error("The staged payload changed before publication.");
    await install(
      sourceParent,
      payload,
      workspace.parent,
      first,
      workspace.leaf,
      input.collision === "merge",
      verifyVolume,
    );
  } catch (cause) {
    const failure =
      cause instanceof Error && "code" in cause && cause.code === "EEXIST"
        ? new DesktopTransferError({
            code: "destination-exists",
            message: "The workspace destination already exists.",
          })
        : cause;
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [failure, cleanupError],
        `Workspace installation failed. Inspect the destination and retained staging at ${volumeStage?.path ?? privatePath}. ${String(failure)}. ${String(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw failure;
  }
  await cleanup();
}

// @effect-diagnostics nodeBuiltinImport:off - These fixtures exercise native file descriptors.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { expect, it } from "@effect/vitest";
import {
  bindAbsoluteTransfer,
  bindWorkspaceTransfer,
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
  sha256AgentDesktopBundle,
} from "./index.ts";
import { loadTransferKoffi } from "./absolute.ts";

const temp = () => NodeFSP.mkdtempDisposable(NodePath.join(NodeOS.tmpdir(), "t3-bundle-test-"));
const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

it("reads and writes the T3BNDL1 file fixture byte for byte", async () => {
  await using directory = await temp();
  const source = NodePath.join(directory.path, "file");
  const archive = NodePath.join(directory.path, "archive");
  const output = NodePath.join(directory.path, "output");
  const data = Buffer.from([0, 255, 42]);
  await NodeFSP.writeFile(source, data);
  await NodeFSP.chmod(source, 0o640);
  await NodeFSP.utimes(source, 1700000000, 1700000000);
  const header = Buffer.from(
    JSON.stringify({
      path: ".",
      type: "file",
      mode: NodeProcess.platform === "win32" ? 0o666 : 0o640,
      mtimeMs: 1700000000000,
      size: 3,
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const fixed = Buffer.concat([Buffer.from("T3BNDL1\n"), length, header, data, Buffer.alloc(4)]);
  const packed = await packAgentDesktopBundle({ sourcePath: source, outputPath: archive });
  expect(await NodeFSP.readFile(archive)).toEqual(fixed);
  expect(packed).toEqual({
    rootType: "file",
    fileCount: 1,
    directoryCount: 0,
    symlinkCount: 0,
    logicalBytes: 3,
    archiveBytes: fixed.length,
    wireBytes: fixed.length,
    compression: "none",
    sha256: NodeCrypto.createHash("sha256").update(fixed).digest("hex"),
  });
  expect(await sha256AgentDesktopBundle(archive)).toBe(packed.sha256);
  const result = await extractAgentDesktopBundle({
    archivePath: archive,
    destinationPath: output,
    compression: "none",
  });
  expect(result.rootType).toBe("file");
  expect(await NodeFSP.readFile(output)).toEqual(data);
  expect((await NodeFSP.stat(output)).mtimeMs).toBe(1700000000000);
});

it("confines nested workspace copies, preserves relative links, and compresses repetitive files", async () => {
  await using directory = await temp();
  const workspaceRoot = NodePath.join(directory.path, "workspace");
  const stagingDirectory = NodePath.join(directory.path, "private");
  const sourceDir = NodePath.join(workspaceRoot, "source");
  const nested = NodePath.join(sourceDir, "sub");
  await NodeFSP.mkdir(nested, { recursive: true });
  await NodeFSP.mkdir(stagingDirectory);
  await NodeFSP.writeFile(NodePath.join(nested, "payload"), Buffer.alloc(96 * 1024, 7));
  if (NodeProcess.platform !== "win32")
    await NodeFSP.symlink("sub/payload", NodePath.join(sourceDir, "link"));
  const options = { editOnly: true, stagingDirectory };
  await using source = await bindWorkspaceTransfer(
    workspaceRoot,
    "source",
    true,
    loadTransferKoffi,
    options,
  );
  const archive = NodePath.join(stagingDirectory, "archive");
  const packed = await packAgentDesktopBundle({
    workspace: source,
    sourcePath: source.named,
    outputPath: archive,
  });
  expect(packed.compression).toBe("gzip");
  expect(packed.wireBytes).toBeLessThan(packed.archiveBytes);
  await using target = await bindWorkspaceTransfer(
    workspaceRoot,
    "new/parent/target",
    false,
    loadTransferKoffi,
    options,
  );
  await extractAgentDesktopBundle({
    workspace: target,
    archivePath: archive,
    destinationPath: target.named,
    compression: packed.compression,
  });
  expect(await NodeFSP.readFile(NodePath.join(target.named, "sub", "payload"))).toEqual(
    Buffer.alloc(96 * 1024, 7),
  );
  if (NodeProcess.platform !== "win32")
    expect(await NodeFSP.readlink(NodePath.join(target.named, "link"))).toBe("sub/payload");
  await expect(
    bindWorkspaceTransfer(workspaceRoot, ".git/config", false, loadTransferKoffi, options),
  ).rejects.toMatchObject({ code: "permission-denied" });
  await expect(
    packAgentDesktopBundle({ workspace: source, sourcePath: target.named, outputPath: archive }),
  ).rejects.toMatchObject({ code: "invalid-entry" });
  expect(await NodeFSP.readdir(stagingDirectory)).toEqual(["archive"]);
});

it("uses atomic no-replace publication when two copies claim the same name", async () => {
  await using directory = await temp();
  const target = NodePath.join(directory.path, "winner");
  const archives = await Promise.all(
    ["first", "second"].map(async (text) => {
      const path = NodePath.join(directory.path, text);
      const archive = path + ".bundle";
      await NodeFSP.writeFile(path, text);
      await packAgentDesktopBundle({ sourcePath: path, outputPath: archive });
      return archive;
    }),
  );
  const results = await Promise.allSettled(
    archives.map((archive) =>
      extractAgentDesktopBundle({
        archivePath: archive,
        destinationPath: target,
        compression: "none",
        collision: "create",
      }),
    ),
  );
  const winner = results.findIndex((result) => result.status === "fulfilled");
  expect(winner).toBeGreaterThanOrEqual(0);
  expect(results[1 - winner]).toMatchObject({
    status: "rejected",
    reason: { code: "destination-exists" },
  });
  expect(await NodeFSP.readFile(target, "utf8")).toBe(["first", "second"][winner]);
});

it("requires a fresh source binding after an editor replaces the admitted file", async () => {
  await using directory = await temp();
  const source = NodePath.join(directory.path, "source");
  const edited = NodePath.join(directory.path, "edited");
  const archive = NodePath.join(directory.path, "archive");
  await NodeFSP.writeFile(source, "first version");
  await using bound = await bindWorkspaceTransfer(
    directory.path,
    "source",
    true,
    loadTransferKoffi,
  );
  await NodeFSP.writeFile(edited, "second version");
  await NodeFSP.rename(edited, source);
  await expect(
    packAgentDesktopBundle({ workspace: bound, sourcePath: source, outputPath: archive }),
  ).rejects.toMatchObject({ code: "invalid-source" });
  expect(await exists(archive)).toBe(false);
  await packAgentDesktopBundle({ sourcePath: source, outputPath: archive });
  const prior = await NodeFSP.readFile(archive);
  await expect(
    packAgentDesktopBundle({ sourcePath: source, outputPath: archive, compression: "gzip" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await NodeFSP.readFile(archive)).toEqual(prior);
  await expect(
    packAgentDesktopBundle({
      sourcePath: directory.path,
      outputPath: NodePath.join(directory.path, "missing", "output"),
    }),
  ).rejects.toMatchObject({ code: "invalid-entry" });
  expect(await exists(NodePath.join(directory.path, "missing"))).toBe(false);
  if (NodeProcess.platform !== "win32") {
    await NodeFSP.symlink("source", edited);
    await expect(
      packAgentDesktopBundle({ sourcePath: edited, outputPath: archive }),
    ).rejects.toMatchObject({
      code: "invalid-entry",
    });
  }
});

it("gives simultaneous and repeated exports of one held file independent read offsets", async () => {
  await using directory = await temp();
  const sourcePath = NodePath.join(directory.path, "source");
  await NodeFSP.writeFile(sourcePath, Buffer.alloc(1_100_000, 3));
  await using workspace = await bindWorkspaceTransfer(
    directory.path,
    "source",
    true,
    loadTransferKoffi,
  );
  const pack = (name: string) =>
    packAgentDesktopBundle({
      workspace,
      sourcePath,
      outputPath: NodePath.join(directory.path, name),
    });
  const first = await pack("first");
  const [second, third] = await Promise.allSettled([pack("second"), pack("third")]);
  expect(second).toMatchObject({ status: "fulfilled", value: { sha256: first.sha256 } });
  expect(third).toMatchObject({ status: "fulfilled", value: { sha256: first.sha256 } });
});

it("rejects malformed bundle framing before checking publication policy or changing the destination", async () => {
  await using directory = await temp();
  const archivePath = NodePath.join(directory.path, "archive");
  const destinationPath = NodePath.join(directory.path, "dest");
  await NodeFSP.writeFile(destinationPath, "held");
  const word = (n: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(n);
    return buffer;
  };
  const entry = (data: Record<string, unknown>) => {
    const json = Buffer.from(JSON.stringify({ path: ".", mode: 0o600, mtimeMs: 0, ...data }));
    return Buffer.concat([word(json.length), json]);
  };
  const root = entry({ type: "directory" });
  const magic = Buffer.from("T3BNDL1\n");
  let checked = 0;
  for (const [code, ...parts] of [
    ["invalid-bundle", magic, word(65_537)],
    ["invalid-bundle", magic, entry({ type: "file", size: 128 }), word(0)],
    ["invalid-bundle", magic, root, word(0), Buffer.from("trailing")],
    ["invalid-entry", magic, root, root, word(0)],
    ["invalid-entry", magic, entry({ path: "nested", type: "directory" }), word(0)],
  ] as const) {
    await NodeFSP.writeFile(archivePath, Buffer.concat(parts));
    await expect(
      extractAgentDesktopBundle({
        archivePath,
        destinationPath,
        compression: "none",
        collision: "replace",
        beforePublish: async () => {
          checked++;
        },
      }),
    ).rejects.toMatchObject({ code });
    expect(await NodeFSP.readFile(destinationPath, "utf8")).toBe("held");
    expect((await NodeFSP.readdir(directory.path)).toSorted()).toEqual(["archive", "dest"]);
  }
  expect(checked).toBe(0);
});

it("rechecks policy for each merge commit and keeps already accepted entries", async () => {
  await using directory = await temp();
  const source = NodePath.join(directory.path, "source");
  const target = NodePath.join(directory.path, "target");
  const archive = NodePath.join(directory.path, "archive");
  await NodeFSP.mkdir(source);
  await NodeFSP.mkdir(target);
  await NodeFSP.writeFile(NodePath.join(source, "a"), "a");
  await NodeFSP.writeFile(NodePath.join(source, "b"), "new b");
  await NodeFSP.writeFile(NodePath.join(target, "b"), "previous b");
  await NodeFSP.writeFile(NodePath.join(target, "kept"), "untouched");
  await packAgentDesktopBundle({ sourcePath: source, outputPath: archive });
  const revoke = new Error("grant revoked");
  const install = {
    archivePath: archive,
    destinationPath: target,
    compression: "none",
    collision: "merge",
  } as const;
  await expect(
    extractAgentDesktopBundle({
      ...install,
      beforePublish: async () => {
        if (await exists(NodePath.join(target, "a"))) throw revoke;
      },
    }),
  ).rejects.toBe(revoke);
  expect(await NodeFSP.readFile(NodePath.join(target, "a"), "utf8")).toBe("a");
  expect(await NodeFSP.readFile(NodePath.join(target, "b"), "utf8")).toBe("previous b");
  await extractAgentDesktopBundle(install);
  expect(await NodeFSP.readFile(NodePath.join(target, "b"), "utf8")).toBe("new b");
  expect(await NodeFSP.readFile(NodePath.join(target, "kept"), "utf8")).toBe("untouched");
});

it("restores a replacement if authorization changes between retirement and installation", async () => {
  await using directory = await temp();
  const source = NodePath.join(directory.path, "source");
  const target = NodePath.join(directory.path, "target");
  const archive = NodePath.join(directory.path, "archive");
  await NodeFSP.writeFile(source, "new");
  await NodeFSP.writeFile(target, "old");
  await packAgentDesktopBundle({ sourcePath: source, outputPath: archive });
  const revoked = new Error("grant revoked");
  const install = {
    archivePath: archive,
    destinationPath: target,
    compression: "none",
    collision: "replace",
  } as const;
  await expect(
    extractAgentDesktopBundle({
      ...install,
      beforePublish: async () => {
        if (!(await exists(target))) throw revoked;
      },
    }),
  ).rejects.toBe(revoked);
  expect(await NodeFSP.readFile(target, "utf8")).toBe("old");
  await extractAgentDesktopBundle(install);
  expect(await NodeFSP.readFile(target, "utf8")).toBe("new");
  expect((await NodeFSP.readdir(directory.path)).toSorted()).toEqual([
    "archive",
    "source",
    "target",
  ]);
});

it.skipIf(NodeProcess.platform === "win32")(
  "rejects absolute destinations that overwrite symlinks traversed before .. to transfer storage",
  async () => {
    await using directory = await temp();
    const realRoot = NodePath.join(directory.path, "real");
    const sub = NodePath.join(realRoot, "sub");
    const storage = NodePath.join(realRoot, "storage");
    const links = NodePath.join(directory.path, "links");
    const hop = NodePath.join(links, "hop");
    const entry = NodePath.join(links, "entry");
    await NodeFSP.mkdir(sub, { recursive: true });
    await NodeFSP.mkdir(storage, { recursive: true });
    await NodeFSP.mkdir(links, { recursive: true });
    await NodeFSP.symlink(sub, hop);
    await NodeFSP.symlink("hop/../storage", entry);

    for (const protectedPath of [hop, entry, storage, realRoot]) {
      await expect(
        bindAbsoluteTransfer(protectedPath, false, loadTransferKoffi, {
          editOnly: false,
          stagingDirectory: entry,
          collision: "replace",
        }),
      ).rejects.toMatchObject({ code: "invalid-destination" });
    }

    const literalBackslashStorage = NodePath.join(directory.path, "store\\dir");
    const destination = NodePath.join(directory.path, "dest.txt");
    await NodeFSP.mkdir(literalBackslashStorage, { recursive: true });
    await using admitted = await bindAbsoluteTransfer(destination, false, loadTransferKoffi, {
      editOnly: false,
      stagingDirectory: literalBackslashStorage,
      collision: "replace",
    });
    expect(admitted.names).toEqual(["dest.txt"]);
  },
);

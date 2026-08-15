// @effect-diagnostics nodeBuiltinImport:off - Tests exercise real streamed filesystem bundles.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  AgentDesktopBundleError,
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
} from "./agentDesktopBundle.ts";

/** Runs one bundle test inside a scoped temporary directory. */
const withTempDirectory = <A>(run: (directory: string) => Promise<A>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-agent-desktop-bundle-",
    });
    return yield* Effect.promise(() => run(directory));
  }).pipe(Effect.provide(NodeServices.layer));

describe("Agent desktop bundle", () => {
  it.effect("round trips files, directories, metadata, and internal symlinks", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      const output = NodePath.join(directory, "bundle.t3b");
      const destination = NodePath.join(directory, "destination");
      await NodeFSP.mkdir(NodePath.join(source, "nested"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(source, "hello.txt"), "hello\n");
      await NodeFSP.writeFile(
        NodePath.join(source, "nested", "bytes.bin"),
        Uint8Array.from([0, 1, 2, 255]),
      );
      await NodeFSP.symlink("hello.txt", NodePath.join(source, "hello-link"));
      await NodeFSP.chmod(NodePath.join(source, "hello.txt"), 0o640);

      const packed = await packAgentDesktopBundle({
        sourcePath: source,
        outputPath: output,
        compression: "none",
      });
      const extracted = await extractAgentDesktopBundle({
        archivePath: output,
        destinationPath: destination,
        compression: packed.compression,
      });

      assert.equal(packed.rootType, "directory");
      assert.equal(packed.fileCount, 2);
      assert.equal(packed.directoryCount, 2);
      assert.equal(packed.symlinkCount, 1);
      assert.equal(extracted.logicalBytes, 10);
      assert.equal(
        await NodeFSP.readFile(NodePath.join(destination, "hello.txt"), "utf8"),
        "hello\n",
      );
      assert.deepEqual(
        [...(await NodeFSP.readFile(NodePath.join(destination, "nested", "bytes.bin")))],
        [0, 1, 2, 255],
      );
      assert.equal(await NodeFSP.readlink(NodePath.join(destination, "hello-link")), "hello.txt");
      assert.equal(
        (await NodeFSP.stat(NodePath.join(destination, "hello.txt"))).mode & 0o777,
        0o640,
      );
    }),
  );

  it.effect("selects compression from sampled content and verifies hashes", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source.txt");
      await NodeFSP.writeFile(source, "compressible source text\n".repeat(20_000));
      const output = NodePath.join(directory, "bundle.t3b.gz");

      const packed = await packAgentDesktopBundle({ sourcePath: source, outputPath: output });

      assert.equal(packed.compression, "gzip");
      assert.isBelow(packed.wireBytes, packed.archiveBytes / 10);
      assert.match(packed.sha256, /^[a-f0-9]{64}$/);
      const destination = NodePath.join(directory, "copied.txt");
      await extractAgentDesktopBundle({
        archivePath: output,
        destinationPath: destination,
        compression: packed.compression,
      });
      assert.equal(
        await NodeFSP.readFile(destination, "utf8"),
        await NodeFSP.readFile(source, "utf8"),
      );
    }),
  );

  it.effect("skips ineffective automatic compression", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "random.bin");
      const bytes = Buffer.allocUnsafe(512 * 1024);
      let state = 0x12345678;
      for (let index = 0; index < bytes.length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[index] = state & 255;
      }
      await NodeFSP.writeFile(source, bytes);

      const packed = await packAgentDesktopBundle({
        sourcePath: source,
        outputPath: NodePath.join(directory, "bundle.t3b"),
      });

      assert.equal(packed.compression, "none");
    }),
  );

  it.effect("supports create, replace, and directory merge policies", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      const output = NodePath.join(directory, "bundle.t3b");
      const destination = NodePath.join(directory, "destination");
      await NodeFSP.mkdir(source);
      await NodeFSP.writeFile(NodePath.join(source, "new.txt"), "new");
      await packAgentDesktopBundle({ sourcePath: source, outputPath: output, compression: "none" });
      await NodeFSP.mkdir(destination);
      await NodeFSP.writeFile(NodePath.join(destination, "old.txt"), "old");

      await expect(
        extractAgentDesktopBundle({
          archivePath: output,
          destinationPath: destination,
          compression: "none",
          collision: "create",
        }),
      ).rejects.toMatchObject({ code: "destination-exists" });
      await extractAgentDesktopBundle({
        archivePath: output,
        destinationPath: destination,
        compression: "none",
        collision: "merge",
      });
      assert.equal(await NodeFSP.readFile(NodePath.join(destination, "old.txt"), "utf8"), "old");
      assert.equal(await NodeFSP.readFile(NodePath.join(destination, "new.txt"), "utf8"), "new");

      await NodeFSP.writeFile(NodePath.join(source, "new.txt"), "replacement");
      const replacement = NodePath.join(directory, "replacement.t3b");
      await packAgentDesktopBundle({
        sourcePath: source,
        outputPath: replacement,
        compression: "none",
      });
      await extractAgentDesktopBundle({
        archivePath: replacement,
        destinationPath: destination,
        compression: "none",
        collision: "replace",
      });
      assert.isFalse(
        await NodeFSP.access(NodePath.join(destination, "old.txt")).then(
          () => true,
          () => false,
        ),
      );
      assert.equal(
        await NodeFSP.readFile(NodePath.join(destination, "new.txt"), "utf8"),
        "replacement",
      );
    }),
  );

  it.effect("rejects bundles that escape through entry paths or symlink targets", () =>
    withTempDirectory(async (directory) => {
      const writeBundle = async (path: string, headers: ReadonlyArray<object>) => {
        const entries = headers.flatMap((header) => {
          const encoded = Buffer.from(JSON.stringify(header));
          const length = Buffer.alloc(4);
          length.writeUInt32BE(encoded.byteLength);
          return [length, encoded];
        });
        await NodeFSP.writeFile(
          path,
          Buffer.concat([Buffer.from("T3BNDL1\n"), ...entries, Buffer.alloc(4)]),
        );
      };
      const traversal = NodePath.join(directory, "traversal.t3b");
      await writeBundle(traversal, [
        {
          path: "../outside",
          type: "directory",
          mode: 0o755,
          mtimeMs: 1,
        },
      ]);
      await expect(
        extractAgentDesktopBundle({
          archivePath: traversal,
          destinationPath: NodePath.join(directory, "destination"),
          compression: "none",
        }),
      ).rejects.toBeInstanceOf(AgentDesktopBundleError);

      const rootSymlink = NodePath.join(directory, "root-symlink.t3b");
      await writeBundle(rootSymlink, [
        {
          path: ".",
          type: "symlink",
          mode: 0o777,
          mtimeMs: 1,
          target: "target",
        },
      ]);
      await expect(
        extractAgentDesktopBundle({
          archivePath: rootSymlink,
          destinationPath: NodePath.join(directory, "root-link"),
          compression: "none",
        }),
      ).rejects.toMatchObject({ code: "invalid-entry" });

      const symlink = NodePath.join(directory, "symlink.t3b");
      await writeBundle(symlink, [
        { path: ".", type: "directory", mode: 0o755, mtimeMs: 1 },
        {
          path: "nested/link",
          type: "symlink",
          mode: 0o777,
          mtimeMs: 1,
          target: "../../outside",
        },
      ]);
      await expect(
        extractAgentDesktopBundle({
          archivePath: symlink,
          destinationPath: NodePath.join(directory, "link"),
          compression: "none",
        }),
      ).rejects.toBeInstanceOf(AgentDesktopBundleError);
    }),
  );

  it.effect("rejects unsafe symlink targets while packing", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      await NodeFSP.mkdir(source);
      await NodeFSP.symlink("../outside", NodePath.join(source, "outside-link"));
      await expect(
        packAgentDesktopBundle({
          sourcePath: source,
          outputPath: NodePath.join(directory, "bundle.t3b"),
          compression: "none",
        }),
      ).rejects.toMatchObject({ code: "invalid-entry" });
    }),
  );

  it.effect("rejects a standalone symlink source", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source-link");
      await NodeFSP.symlink("target", source);
      await expect(
        packAgentDesktopBundle({
          sourcePath: source,
          outputPath: NodePath.join(directory, "bundle.t3b"),
          compression: "none",
        }),
      ).rejects.toMatchObject({ code: "invalid-entry" });
    }),
  );

  it.effect("never removes a pre-existing output on pack failure", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source.txt");
      const output = NodePath.join(directory, "existing.bundle");
      await NodeFSP.writeFile(source, "source");
      await NodeFSP.writeFile(output, "keep me");

      await expect(
        packAgentDesktopBundle({ sourcePath: source, outputPath: output, compression: "none" }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      assert.equal(await NodeFSP.readFile(output, "utf8"), "keep me");
    }),
  );
});

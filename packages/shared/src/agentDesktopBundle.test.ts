// @effect-diagnostics nodeBuiltinImport:off - Tests exercise real streamed filesystem bundles.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
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
import { renameNoReplace } from "./renameNoReplace.ts";

/** Runs one bundle test inside a scoped temporary directory. */
const withTempDirectory = Effect.fn("agentDesktopBundle.withTempDirectory")(function* <A>(
  run: (directory: string) => Promise<A>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-agent-desktop-bundle-",
  });
  return yield* Effect.promise(() => run(directory));
}, Effect.provide(NodeServices.layer));

// Separate processes pause at the destination claim, after any legacy absence check.
const createWorkerSource = String.raw`
import fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import pathModule from "node:path";
const [moduleUrl, archivePath, destinationPath, optionsJson] = process.argv.slice(1);
const options = JSON.parse(optionsJson);
const controller = new AbortController();
let reachedClaim = false;
async function claim() {
  if (options.failure === "symlink-metadata" || reachedClaim) return;
  reachedClaim = true;
  const resume = once(process, "message");
  process.send({ type: "ready" });
  await resume;
}
const lstat = fs.lstat;
fs.lstat = async (path, ...args) => {
  try { return await lstat(path, ...args); }
  catch (error) {
    if (path === destinationPath && error.code === "ENOENT") await claim();
    throw error;
  }
};
const rename = fs.rename;
fs.rename = async (source, destination, ...args) => {
  await rename(source, destination, ...args);
  if (options.failure === "cancel-merge" && destination === pathModule.join(destinationPath, options.abortAfterRelativePath)) {
    await claim();
    controller.abort(Object.assign(new Error("cancel after one merged entry"), { code: "TEST_CANCELLED" }));
  }
};
const open = fs.open;
fs.open = async (path, ...args) => {
  const handle = await open(path, ...args);
  if (options.failure === "cancel-staging" && path.includes(".t3-transfer-")) {
    const write = handle.write.bind(handle);
    handle.write = async (...args) => {
      const result = await write(...args);
      await claim();
      controller.abort(Object.assign(new Error("cancel during staging"), { code: "TEST_CANCELLED" }));
      return result;
    };
  }
  if (["handle-close", "uncertain-close"].includes(options.failure) && path === pathModule.dirname(destinationPath)) {
    const close = handle.close.bind(handle);
    handle.close = async () => { await close(); throw Object.assign(new Error("injected handle close failure"), { code: "EIO" }); };
  }
  return handle;
};
const koffi = createRequire(moduleUrl)("koffi");
const kernel = process.platform === "win32" ? koffi.load("kernel32.dll") : null;
const getError = kernel?.func("uint32_t __stdcall GetLastError(void)") ?? (() => koffi.errno());
const setError = kernel?.func("void __stdcall SetLastError(uint32_t)") ?? ((code) => koffi.errno(code));
const loadKoffi = async () => {
  if (options.failure === "cancel-before") {
    await claim();
    controller.abort(Object.assign(new Error("test cancellation before publication"), { code: "TEST_CANCELLED" }));
  }
  return { ...koffi, load: (...args) => {
    const library = koffi.load(...args);
    return { ...library, func: (...definition) => {
      const fn = library.func(...definition);
      if (String(definition[0]).includes("CloseHandle") && ["handle-close", "uncertain-close"].includes(options.failure)) {
        return Object.assign((...args) => fn(...args), fn, { async: (...args) => {
          const callback = args.pop();
          fn.async(...args, (error, value) => callback(error ?? new Error("injected handle close failure"), value));
        }});
      }
      if (!/renameat2|renameatx_np|SetFileInformationByHandle/.test(String(definition[0]))) return fn;
      return Object.assign((...args) => fn(...args), fn, { async: (...args) => {
        const callback = args.pop();
        claim().then(() => {
          if (["cleanup", "uncertain-close"].includes(options.failure)) {
            if (process.platform === "win32") args[1] = -1;
            else args[args.length - 1] = 0xffffffff;
          }
          fn.async(...args, (error, value) => {
            const code = getError();
            (async () => {
              if (options.pauseAfterCommit) {
                const resume = once(process, "message"); process.send({ type: "published" }); await resume;
              }
              if (options.failure === "cancel-after") controller.abort(new Error("test cancellation after publication"));
              if (options.failure === "lost-receipt") { callback(new Error("injected lost receipt after commit")); return; }
              setError(options.failure === "post-commit-error" ? 5 : code);
              callback(error, options.failure === "post-commit-error" ? (process.platform === "win32" ? 0 : -1) : value);
            })().catch(callback);
          });
        }).catch(callback);
      }});
    }};
  }};
};
for (const operation of ["unlink", "rmdir"]) {
  const original = fs[operation];
  fs[operation] = async (path, ...args) => {
    if (["cleanup", "collision-cleanup"].includes(options.failure) && path.includes(".t3-transfer-")) throw new Error("injected cleanup failure");
    return original(path, ...args);
  };
}
if (options.failure === "symlink-metadata") {
  fs.lutimes = async () => { throw Object.assign(new Error("injected symlink metadata failure"), { code: "EIO" }); };
}
syncBuiltinESMExports();
const { extractAgentDesktopBundle } = await import(moduleUrl);
try {
  await extractAgentDesktopBundle({ loadKoffi, archivePath, destinationPath, compression: "none", collision: options.collision ?? "create", signal: controller.signal, allowExternalSymlinks: options.allowExternalSymlinks });
  process.send({ type: "result", status: "fulfilled" });
} catch (error) {
  process.send({ type: "result", status: "rejected", code: error.code, message: error.message });
}
process.disconnect();
`;

function createWorker(
  archivePath: string,
  destinationPath: string,
  options: {
    collision?: "create" | "replace" | "merge";
    abortAfterRelativePath?: string;
    allowExternalSymlinks?: boolean;
    pauseAfterCommit?: boolean;
    failure?:
      | "cancel-staging"
      | "cancel-before"
      | "cancel-after"
      | "cancel-merge"
      | "post-commit-error"
      | "lost-receipt"
      | "cleanup"
      | "handle-close"
      | "uncertain-close"
      | "collision-cleanup"
      | "symlink-metadata";
  } = {},
) {
  const ready = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const result = Promise.withResolvers<{ status: string; code?: string; message?: string }>();
  void result.promise.catch(() => undefined);
  const exited = Promise.withResolvers<void>();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      createWorkerSource,
      new URL("./agentDesktopBundle.ts", import.meta.url).href,
      archivePath,
      destinationPath,
      JSON.stringify(options),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  let completed = false;
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.on(
    "message",
    (message: { type?: string; status: string; code?: string; message?: string }) => {
      if (message.type === "ready") ready.resolve();
      if (message.type === "published") published.resolve();
      if (message.type === "result") {
        completed = true;
        result.resolve(message);
      }
    },
  );
  child.once("error", (error) => {
    ready.reject(error);
    result.reject(error);
  });
  child.once("exit", (code) => {
    exited.resolve();
    if (!completed) {
      const error = new Error(`Extraction worker exited ${code}: ${stderr}`);
      ready.reject(error);
      result.reject(error);
    }
  });
  return {
    ready: ready.promise,
    published: published.promise,
    stop: async (signal: NodeJS.Signals) => {
      child.kill(signal);
      await exited.promise;
    },
    result: result.promise,
    resume: () => child.send("claim"),
    async [Symbol.asyncDispose]() {
      if (!completed && child.exitCode === null && child.signalCode === null) child.kill();
      await exited.promise;
    },
  };
}

async function writeSymlinkBundle(archive: string, target: string) {
  const header = Buffer.from(
    JSON.stringify({ path: ".", type: "symlink", target, mode: 0o777, mtimeMs: 1 }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.byteLength);
  await NodeFSP.writeFile(
    archive,
    Buffer.concat([Buffer.from("T3BNDL1\n"), length, header, Buffer.alloc(4)]),
  );
}

async function createArchiveFixture(
  directory: string,
  rootType: "file" | "directory" | "empty-directory" | "symlink",
) {
  const archive = NodePath.join(directory, "source.bundle");
  const source = NodePath.join(directory, "source");
  await NodeFSP.writeFile(NodePath.join(directory, "target"), "untouched target");
  if (rootType === "symlink") {
    await writeSymlinkBundle(archive, "target");
  } else {
    if (rootType === "directory" || rootType === "empty-directory") {
      await NodeFSP.mkdir(source);
      if (rootType === "directory")
        await NodeFSP.writeFile(NodePath.join(source, "payload"), "new payload");
    } else await NodeFSP.writeFile(source, "new payload");
    await packAgentDesktopBundle({ sourcePath: source, outputPath: archive, compression: "none" });
  }
  return archive;
}

describe("Agent desktop bundle", () => {
  it.live.each([".", "nested"])(
    "stops a merge after the accepted entry when cancelled: %s",
    (subdirectory) =>
      withTempDirectory(async (directory) => {
        const source = NodePath.join(directory, "source");
        const destination = NodePath.join(directory, "destination");
        const archive = NodePath.join(directory, "bundle");
        await NodeFSP.mkdir(NodePath.join(source, subdirectory), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(destination, subdirectory), { recursive: true });
        for (const name of ["a", "b", "c"]) {
          await NodeFSP.writeFile(NodePath.join(source, subdirectory, name), `new ${name}`);
          await NodeFSP.writeFile(NodePath.join(destination, subdirectory, name), `old ${name}`);
        }
        await NodeFSP.writeFile(NodePath.join(destination, "keep"), "retained");
        await packAgentDesktopBundle({
          sourcePath: source,
          outputPath: archive,
          compression: "none",
        });
        await using worker = createWorker(archive, destination, {
          collision: "merge",
          failure: "cancel-merge",
          abortAfterRelativePath: NodePath.join(subdirectory, "a"),
        });
        await worker.ready;
        expect(await NodeFSP.readFile(NodePath.join(destination, subdirectory, "a"), "utf8")).toBe(
          "new a",
        );
        worker.resume();
        const result = await worker.result;
        expect(await NodeFSP.readFile(NodePath.join(destination, subdirectory, "b"), "utf8")).toBe(
          "old b",
        );
        expect(await NodeFSP.readFile(NodePath.join(destination, subdirectory, "c"), "utf8")).toBe(
          "old c",
        );
        expect(result).toMatchObject({ status: "rejected", code: "TEST_CANCELLED" });
        expect(await NodeFSP.readFile(NodePath.join(destination, "keep"), "utf8")).toBe("retained");
        expect(
          (await NodeFSP.readdir(directory)).filter((path) => path.includes(".t3-transfer-")),
        ).toEqual([]);
      }),
  );

  it.live("refuses to include its own growing archive in the copied tree", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      await NodeFSP.mkdir(source);
      await NodeFSP.writeFile(NodePath.join(source, "keep"), "unchanged");
      await expect(
        packAgentDesktopBundle({
          sourcePath: source,
          outputPath: NodePath.join(source, "archive.bundle"),
        }),
      ).rejects.toMatchObject({ code: "invalid-entry" });
      assert.deepEqual(await NodeFSP.readdir(source), ["keep"]);
    }),
  );

  it.live.each([false, true])(
    "preserves the native receipt through handle close failure, collision=%s",
    (collision) =>
      withTempDirectory(async (directory) => {
        const archive = await createArchiveFixture(directory, "directory");
        const destination = NodePath.join(directory, "destination");
        if (collision) await NodeFSP.writeFile(destination, "existing");
        await using worker = createWorker(archive, destination, { failure: "handle-close" });
        await worker.ready;
        worker.resume();
        expect(await worker.result).toMatchObject(
          collision ? { status: "rejected", code: "destination-exists" } : { status: "fulfilled" },
        );
        expect(
          await NodeFSP.readFile(
            collision ? destination : NodePath.join(destination, "payload"),
            "utf8",
          ),
        ).toBe(collision ? "existing" : "new payload");
        expect(
          (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
        ).toEqual([]);
      }),
  );

  it.live("keeps an uncertain refusal through handle cleanup failure", () =>
    withTempDirectory(async (directory) => {
      const archive = await createArchiveFixture(directory, "directory");
      const destination = NodePath.join(directory, "destination");
      await using worker = createWorker(archive, destination, { failure: "uncertain-close" });
      await worker.ready;
      worker.resume();
      const result = await worker.result;
      expect(result).toMatchObject({ status: "rejected", code: "UNCONFIRMED" });
      expect(result.message).toMatch(/publication outcome is unconfirmed/i);
      expect(await NodeFSP.lstat(destination).catch(() => null)).toBeNull();
      expect(
        (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
      ).toEqual([]);
    }),
  );

  it.live(
    "retains destination-exists and the owned stage diagnostic when staging cleanup fails",
    () =>
      withTempDirectory(async (directory) => {
        const archive = await createArchiveFixture(directory, "file");
        const destination = NodePath.join(directory, "destination");
        await NodeFSP.writeFile(destination, "existing");
        await using worker = createWorker(archive, destination, { failure: "collision-cleanup" });
        await worker.ready;
        worker.resume();
        const result = await worker.result;
        expect(result).toMatchObject({ status: "rejected", code: "destination-exists" });
        expect(result.message).toMatch(/staging cleanup was not confirmed/i);
        expect(await NodeFSP.readFile(destination, "utf8")).toBe("existing");
        const stages = (await NodeFSP.readdir(directory)).filter((name) =>
          name.includes(".t3-transfer-"),
        );
        expect(stages).toHaveLength(1);
        expect(await NodeFSP.readFile(NodePath.join(directory, stages[0]!), "utf8")).toBe(
          "new payload",
        );
      }),
  );

  it.live("keeps concurrent native success and collision receipts separate", () =>
    withTempDirectory(async (directory) => {
      const parentIdentity = await NodeFSP.stat(directory, { bigint: true });
      const inputs = await Promise.all(
        Array.from({ length: 24 }, async (_, index) => {
          const source = NodePath.join(directory, `source-${index}`);
          const destination = NodePath.join(directory, `destination-${index}`);
          await NodeFSP.writeFile(source, `new-${index}`);
          if (index % 2 === 0) await NodeFSP.writeFile(destination, `existing-${index}`);
          return { source, destination, parentIdentity };
        }),
      );
      const results = await Promise.allSettled(inputs.map((input) => renameNoReplace(input)));
      for (const [index, result] of results.entries()) {
        if (index % 2 === 0)
          expect(result).toMatchObject({ status: "rejected", reason: { code: "EEXIST" } });
        else expect(result.status).toBe("fulfilled");
        expect(await NodeFSP.readFile(inputs[index]!.destination, "utf8")).toBe(
          index % 2 === 0 ? `existing-${index}` : `new-${index}`,
        );
      }
    }),
  );

  it.live.each(["inline-callback", "queue-refusal"] as const)(
    "cleans staging after native %s and admits the next publication",
    (failure) =>
      withTempDirectory(async (directory) => {
        const archive = await createArchiveFixture(directory, "file");
        const destination = NodePath.join(directory, "received");
        const koffi = (await import("koffi")).default;
        let refused = false;
        const injected: typeof koffi = {
          ...koffi,
          load: (...args) => {
            const library = koffi.load(...args);
            return {
              ...library,
              func: ((...definition: Parameters<typeof library.func>) => {
                const fn = library.func(...definition);
                if (
                  !/renameat2|renameatx_np|SetFileInformationByHandle/.test(String(definition[0]))
                )
                  return fn;
                return Object.assign(fn.bind(null), fn, {
                  async: (...args: unknown[]) => {
                    if (refused) return fn.async(...args);
                    refused = true;
                    const error = new Error(`injected ${failure}`);
                    if (failure === "queue-refusal") throw error;
                    const callback = args.at(-1) as (error: Error) => void;
                    callback(error);
                  },
                });
              }) as typeof library.func,
            };
          },
        };
        const input = {
          archivePath: archive,
          destinationPath: destination,
          compression: "none" as const,
          loadKoffi: async () => injected,
        };
        await expect(extractAgentDesktopBundle(input)).rejects.toMatchObject({
          code: "UNCONFIRMED",
        });
        await expect(NodeFSP.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
        ).toEqual([]);
        await extractAgentDesktopBundle(input);
        expect(await NodeFSP.readFile(destination, "utf8")).toBe("new payload");
      }),
  );

  it.live.each(["file", "directory", "empty-directory", "symlink"] as const)(
    "publishes a %s into a write-and-search-only parent",
    (rootType) =>
      withTempDirectory(async (directory) => {
        const archive = await createArchiveFixture(directory, rootType);
        const parent = NodePath.join(directory, "receiving");
        const destination = NodePath.join(parent, "received");
        await NodeFSP.mkdir(parent, { mode: 0o300 });
        try {
          await extractAgentDesktopBundle({
            archivePath: archive,
            destinationPath: destination,
            compression: "none",
            allowExternalSymlinks: rootType === "symlink",
          });
          const installed = await NodeFSP.lstat(destination);
          expect(installed.isSymbolicLink()).toBe(rootType === "symlink");
          expect(installed.isDirectory()).toBe(
            rootType === "directory" || rootType === "empty-directory",
          );
          if (rootType === "file" || rootType === "directory")
            expect(
              await NodeFSP.readFile(
                rootType === "file" ? destination : NodePath.join(destination, "payload"),
                "utf8",
              ),
            ).toBe("new payload");
        } finally {
          await NodeFSP.chmod(parent, 0o700);
        }
        expect(await NodeFSP.readdir(parent)).toEqual(["received"]);
      }),
  );

  it.live("claims explicit root symlinks without following or replacing them", () =>
    withTempDirectory(async (directory) => {
      const firstArchive = NodePath.join(directory, "first.bundle");
      const secondArchive = NodePath.join(directory, "second.bundle");
      await NodeFSP.writeFile(NodePath.join(directory, "first-target"), "first payload");
      await NodeFSP.writeFile(NodePath.join(directory, "second-target"), "second payload");
      await writeSymlinkBundle(firstArchive, "first-target");
      await writeSymlinkBundle(secondArchive, "second-target");
      const destination = NodePath.join(directory, "destination");
      await expect(
        extractAgentDesktopBundle({
          archivePath: firstArchive,
          destinationPath: destination,
          compression: "none",
        }),
      ).rejects.toMatchObject({ code: "invalid-entry" });
      await expect(NodeFSP.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      await using first = createWorker(firstArchive, destination, { allowExternalSymlinks: true });
      await using second = createWorker(secondArchive, destination, {
        allowExternalSymlinks: true,
      });
      await Promise.all([first.ready, second.ready]);
      first.resume();
      expect(await first.result).toMatchObject({ status: "fulfilled" });
      second.resume();
      expect(await second.result).toMatchObject({ status: "rejected", code: "destination-exists" });
      expect((await NodeFSP.lstat(destination)).isSymbolicLink()).toBe(true);
      expect(await NodeFSP.readlink(destination)).toBe("first-target");
      expect(await NodeFSP.readFile(destination, "utf8")).toBe("first payload");
      expect(await NodeFSP.readFile(NodePath.join(directory, "second-target"), "utf8")).toBe(
        "second payload",
      );
      expect(
        (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
      ).toEqual([]);
    }),
  );

  it.live.each(["file", "directory", "symlink"] as const)(
    "preserves existing destination kinds when creating a %s",
    (rootType) =>
      withTempDirectory(async (directory) => {
        const archive = await createArchiveFixture(directory, rootType);
        for (const existing of ["file", "directory", "symlink", "dangling-symlink"] as const) {
          const destination = NodePath.join(directory, existing);
          if (existing === "file") await NodeFSP.writeFile(destination, "kept payload");
          else if (existing === "directory") {
            await NodeFSP.mkdir(destination);
            await NodeFSP.writeFile(NodePath.join(destination, "keep"), "kept payload");
          } else await NodeFSP.symlink(existing === "symlink" ? "target" : "missing", destination);
          const before = await NodeFSP.lstat(destination);
          await expect(
            extractAgentDesktopBundle({
              archivePath: archive,
              destinationPath: destination,
              compression: "none",
              allowExternalSymlinks: rootType === "symlink",
            }),
          ).rejects.toMatchObject({ code: "destination-exists" });
          const after = await NodeFSP.lstat(destination);
          expect(after.mode).toBe(before.mode);
          expect(after.mtimeMs).toBe(before.mtimeMs);
          if (existing === "file" || existing === "directory") {
            expect(
              await NodeFSP.readFile(
                existing === "file" ? destination : NodePath.join(destination, "keep"),
                "utf8",
              ),
            ).toBe("kept payload");
          } else
            expect(await NodeFSP.readlink(destination)).toBe(
              existing === "symlink" ? "target" : "missing",
            );
        }
        expect(await NodeFSP.readFile(NodePath.join(directory, "target"), "utf8")).toBe(
          "untouched target",
        );
        expect(
          (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
        ).toEqual([]);
      }),
  );
  it.live.each(
    (["file", "directory", "symlink"] as const).flatMap((rootType) =>
      (
        [
          "cancel-before",
          "cancel-after",
          "post-commit-error",
          "lost-receipt",
          "cleanup",
          ...(rootType === "symlink" ? [] : ["cancel-staging" as const]),
        ] as const
      ).map((failure) => ({ rootType, failure })),
    ),
  )("preserves atomic $rootType publication through $failure", ({ rootType, failure }) =>
    withTempDirectory(async (directory) => {
      const archive = await createArchiveFixture(directory, rootType);
      const destination = NodePath.join(directory, "destination");
      await using worker = createWorker(archive, destination, {
        failure,
        allowExternalSymlinks: rootType === "symlink",
      });
      await worker.ready;
      worker.resume();
      const result = await worker.result;
      if (failure === "cancel-after") expect(result.status).toBe("fulfilled");
      else {
        expect(result.status).toBe("rejected");
        if (failure === "cancel-before" || failure === "cancel-staging")
          expect(result.code).toBe("TEST_CANCELLED");
        else expect(result.message).toMatch(/unconfirmed|cleanup was not confirmed/i);
      }
      if (failure === "cancel-before" || failure === "cancel-staging" || failure === "cleanup") {
        await expect(NodeFSP.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      } else if (rootType === "symlink") expect(await NodeFSP.readlink(destination)).toBe("target");
      else
        expect(
          await NodeFSP.readFile(
            rootType === "directory" ? NodePath.join(destination, "payload") : destination,
            "utf8",
          ),
        ).toBe("new payload");
      expect(await NodeFSP.readFile(NodePath.join(directory, "target"), "utf8")).toBe(
        "untouched target",
      );
      const staging = (await NodeFSP.readdir(directory)).filter((name) =>
        name.includes(".t3-transfer-"),
      );
      if (failure === "cleanup") {
        expect(staging).toHaveLength(1);
        expect(result.message).toContain(NodePath.join(directory, staging[0]!));
      } else expect(staging).toEqual([]);
    }),
  );

  it.live.each(["file", "directory", "empty-directory"] as const)(
    "allows exactly one concurrent create of a %s across processes",
    (rootType) =>
      withTempDirectory(async (directory) => {
        const archives: string[] = [];
        for (const [index, payload] of ["first", "second"].entries()) {
          const source = NodePath.join(directory, payload);
          if (rootType === "file") await NodeFSP.writeFile(source, payload);
          else {
            await NodeFSP.mkdir(source);
            if (rootType === "directory") {
              await NodeFSP.writeFile(NodePath.join(source, "payload"), payload);
              await NodeFSP.symlink("payload", NodePath.join(source, "link"));
            }
          }
          await NodeFSP.chmod(source, index === 0 ? 0o750 : 0o700);
          await NodeFSP.utimes(source, 1_680_000_000 + index, 1_680_000_000 + index);
          const archive = NodePath.join(directory, `${payload}.bundle`);
          await packAgentDesktopBundle({
            sourcePath: source,
            outputPath: archive,
            compression: "none",
          });
          archives.push(archive);
        }
        const destination = NodePath.join(directory, "destination");
        await using first = createWorker(archives[0]!, destination);
        await using second = createWorker(archives[1]!, destination);
        await Promise.all([first.ready, second.ready]);
        first.resume();
        expect(await first.result).toMatchObject({ status: "fulfilled" });
        second.resume();
        expect(await second.result).toMatchObject({
          status: "rejected",
          code: "destination-exists",
        });
        if (rootType !== "empty-directory") {
          expect(
            await NodeFSP.readFile(
              rootType === "file" ? destination : NodePath.join(destination, "payload"),
              "utf8",
            ),
          ).toBe("first");
        }
        if (rootType === "directory")
          expect(await NodeFSP.readlink(NodePath.join(destination, "link"))).toBe("payload");
        const original = await NodeFSP.stat(NodePath.join(directory, "first"));
        const installed = await NodeFSP.stat(destination);
        expect(installed.mode & 0o777).toBe(original.mode & 0o777);
        expect(installed.mtimeMs).toBe(original.mtimeMs);
        expect(
          (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
        ).toEqual([]);
      }),
  );

  it.live.each(["file", "directory", "empty-directory", "symlink"] as const)(
    "refuses independent destination creators at publication of a %s",
    (rootType) =>
      withTempDirectory(async (directory) => {
        const archive = await createArchiveFixture(directory, rootType);
        for (const existing of [
          "file",
          "directory",
          "empty-directory",
          "symlink",
          "dangling-symlink",
          ...(rootType === "file" ? ["hardlink"] : []),
        ]) {
          const destination = NodePath.join(directory, `Unicode ’ ${existing}`);
          await using worker = createWorker(archive, destination, {
            allowExternalSymlinks: rootType === "symlink",
          });
          await worker.ready;
          await expect(NodeFSP.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
          if (existing === "file") await NodeFSP.writeFile(destination, "independent");
          else if (existing === "directory" || existing === "empty-directory") {
            await NodeFSP.mkdir(destination);
            if (existing === "directory")
              await NodeFSP.writeFile(NodePath.join(destination, "keep"), "independent");
          } else if (existing === "hardlink") {
            const stage = (await NodeFSP.readdir(directory)).find((name) =>
              name.startsWith(`Unicode ’ ${existing}.t3-transfer-`),
            );
            expect(stage).toBeDefined();
            await NodeFSP.link(NodePath.join(directory, stage!), destination);
          } else await NodeFSP.symlink(existing === "symlink" ? "target" : "missing", destination);
          const before = await NodeFSP.lstat(destination);
          worker.resume();
          expect(await worker.result).toMatchObject({
            status: "rejected",
            code: "destination-exists",
          });
          const after = await NodeFSP.lstat(destination);
          expect([after.dev, after.ino, after.mode, after.mtimeMs]).toEqual([
            before.dev,
            before.ino,
            before.mode,
            before.mtimeMs,
          ]);
          if (existing === "file")
            expect(await NodeFSP.readFile(destination, "utf8")).toBe("independent");
          else if (existing === "directory")
            expect(await NodeFSP.readFile(NodePath.join(destination, "keep"), "utf8")).toBe(
              "independent",
            );
          else if (existing === "hardlink")
            expect(await NodeFSP.readFile(destination, "utf8")).toBe("new payload");
          else if (existing === "empty-directory")
            expect(await NodeFSP.readdir(destination)).toEqual([]);
          else
            expect(await NodeFSP.readlink(destination)).toBe(
              existing === "symlink" ? "target" : "missing",
            );
        }
        expect(
          (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
        ).toEqual([]);
      }),
  );

  it.live.each(
    (["file", "directory", "empty-directory", "symlink"] as const).flatMap((rootType) =>
      (["SIGTERM", "SIGKILL"] as const).flatMap((signal) =>
        ([false, true] as const).map((afterCommit) => ({ rootType, signal, afterCommit })),
      ),
    ),
  )(
    "leaves $rootType absent or complete on $signal, afterCommit=$afterCommit",
    ({ rootType, signal, afterCommit }) =>
      withTempDirectory(async (directory) => {
        const archive = await createArchiveFixture(directory, rootType);
        const destination = NodePath.join(directory, "destination");
        await using worker = createWorker(archive, destination, {
          allowExternalSymlinks: rootType === "symlink",
          pauseAfterCommit: true,
        });
        await worker.ready;
        const stage = (await NodeFSP.readdir(directory)).find((name) =>
          name.startsWith("destination.t3-transfer-"),
        )!;
        const prepared = await NodeFSP.lstat(NodePath.join(directory, stage));
        if (afterCommit) {
          worker.resume();
          await worker.published;
        }
        await worker.stop(signal);
        if (!afterCommit)
          await expect(NodeFSP.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
        else {
          const installed = await NodeFSP.lstat(destination);
          expect([
            installed.dev,
            installed.ino,
            installed.mode,
            installed.mtimeMs,
            installed.uid,
            installed.gid,
          ]).toEqual([
            prepared.dev,
            prepared.ino,
            prepared.mode,
            prepared.mtimeMs,
            prepared.uid,
            prepared.gid,
          ]);
          if (rootType === "empty-directory")
            expect(await NodeFSP.readdir(destination)).toEqual([]);
          else if (rootType === "symlink")
            expect(await NodeFSP.readlink(destination)).toBe("target");
          else
            expect(
              await NodeFSP.readFile(
                rootType === "directory" ? NodePath.join(destination, "payload") : destination,
                "utf8",
              ),
            ).toBe("new payload");
          await expect(NodeFSP.lstat(NodePath.join(directory, stage))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      }),
  );

  it.live(
    "cleans restrictive owned staging when native loading fails or cancellation precedes publication",
    () =>
      withTempDirectory(async (directory) => {
        const source = NodePath.join(directory, "source");
        await NodeFSP.mkdir(source);
        await NodeFSP.writeFile(NodePath.join(source, "payload"), "read only");
        await NodeFSP.chmod(NodePath.join(source, "payload"), 0o400);
        await NodeFSP.chmod(source, 0o500);
        const archive = NodePath.join(directory, "bundle");
        try {
          await packAgentDesktopBundle({
            sourcePath: source,
            outputPath: archive,
            compression: "none",
          });
          for (const failure of ["loader", "cancel"]) {
            const controller = new AbortController();
            const destination = NodePath.join(directory, failure);
            await expect(
              extractAgentDesktopBundle({
                archivePath: archive,
                destinationPath: destination,
                compression: "none",
                signal: controller.signal,
                loadKoffi: async () => {
                  if (failure === "loader") throw new Error("native binding unavailable");
                  controller.abort(new Error("cancel before publication"));
                  return (await import("koffi")).default;
                },
              }),
            ).rejects.toThrow(
              failure === "loader" ? "native binding unavailable" : "cancel before publication",
            );
            await expect(NodeFSP.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
            expect(
              (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
            ).toEqual([]);
          }
        } finally {
          await NodeFSP.chmod(source, 0o700);
        }
      }),
  );

  it.live("refuses a changed parent and retains a reused staging pathname", () =>
    withTempDirectory(async (directory) => {
      const parent = NodePath.join(directory, "parent");
      const moved = NodePath.join(directory, "moved");
      await NodeFSP.mkdir(parent);
      const archive = await createArchiveFixture(parent, "file");
      let stage = "";
      await expect(
        extractAgentDesktopBundle({
          archivePath: archive,
          destinationPath: NodePath.join(parent, "destination"),
          compression: "none",
          loadKoffi: async () => {
            stage = (await NodeFSP.readdir(parent)).find((name) => name.includes(".t3-transfer-"))!;
            await NodeFSP.rename(parent, moved);
            await NodeFSP.mkdir(parent);
            await NodeFSP.writeFile(NodePath.join(parent, stage), "foreign object");
            return (await import("koffi")).default;
          },
        }),
      ).rejects.toThrow(/staging cleanup was not confirmed.*parent changed/i);
      expect(await NodeFSP.readFile(NodePath.join(parent, stage), "utf8")).toBe("foreign object");
      expect(await NodeFSP.readFile(NodePath.join(moved, stage), "utf8")).toBe("new payload");
      await expect(NodeFSP.lstat(NodePath.join(parent, "destination"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }),
  );

  it.live.each(["create", "replace", "merge"] as const)(
    "preserves linked and dangling symlink times with %s without changing targets",
    (collision) =>
      withTempDirectory(async (directory) => {
        const source = NodePath.join(directory, "source");
        const destination = NodePath.join(directory, "destination");
        const archive = NodePath.join(directory, "bundle");
        await NodeFSP.mkdir(source);
        await NodeFSP.writeFile(NodePath.join(source, "target"), "target bytes");
        await NodeFSP.utimes(NodePath.join(source, "target"), 1_600_000_010, 1_600_000_010);
        await NodeFSP.symlink("target", NodePath.join(source, "linked"));
        await NodeFSP.symlink("missing", NodePath.join(source, "dangling"));
        await NodeFSP.lutimes(NodePath.join(source, "linked"), 1_600_000_000, 1_600_000_000);
        await NodeFSP.lutimes(NodePath.join(source, "dangling"), 1_600_000_001, 1_600_000_001);
        if (collision !== "create") {
          await NodeFSP.mkdir(destination);
          await NodeFSP.writeFile(NodePath.join(destination, "keep"), "independent");
        }
        await packAgentDesktopBundle({
          sourcePath: source,
          outputPath: archive,
          compression: "none",
        });
        await extractAgentDesktopBundle({
          archivePath: archive,
          destinationPath: destination,
          compression: "none",
          collision,
        });
        for (const entry of ["linked", "dangling", "target"]) {
          expect((await NodeFSP.lstat(NodePath.join(destination, entry))).mtimeMs).toBe(
            (await NodeFSP.lstat(NodePath.join(source, entry))).mtimeMs,
          );
        }
        expect(await NodeFSP.readlink(NodePath.join(destination, "linked"))).toBe("target");
        expect(await NodeFSP.readlink(NodePath.join(destination, "dangling"))).toBe("missing");
        expect(await NodeFSP.readFile(NodePath.join(destination, "target"), "utf8")).toBe(
          "target bytes",
        );
        expect(
          await NodeFSP.lstat(NodePath.join(destination, "keep")).then(
            () => true,
            () => false,
          ),
        ).toBe(collision === "merge");
      }),
  );

  it.live.each(["create", "replace"] as const)(
    "preserves an explicitly allowed root symlink time with %s",
    (collision) =>
      withTempDirectory(async (directory) => {
        const archive = NodePath.join(directory, "bundle");
        const destination = NodePath.join(directory, "destination");
        const target = NodePath.join(directory, "target");
        await NodeFSP.writeFile(target, "untouched target");
        await NodeFSP.utimes(target, 1_600_000_010, 1_600_000_010);
        const before = await NodeFSP.stat(target);
        await writeSymlinkBundle(archive, "target");
        if (collision === "replace") await NodeFSP.writeFile(destination, "old destination");
        await extractAgentDesktopBundle({
          archivePath: archive,
          destinationPath: destination,
          compression: "none",
          collision,
          allowExternalSymlinks: true,
        });
        expect((await NodeFSP.lstat(destination)).mtimeMs).toBe(1);
        expect(await NodeFSP.readlink(destination)).toBe("target");
        expect((await NodeFSP.stat(target)).mtimeMs).toBe(before.mtimeMs);
        expect(await NodeFSP.readFile(target, "utf8")).toBe("untouched target");
      }),
  );

  it.live.each([
    { rootType: "directory", collision: "create" },
    { rootType: "directory", collision: "replace" },
    { rootType: "directory", collision: "merge" },
    { rootType: "symlink", collision: "create" },
    { rootType: "symlink", collision: "replace" },
  ] as const)(
    "cleans an unpublished $rootType after symlink metadata failure with $collision",
    ({ rootType, collision }) =>
      withTempDirectory(async (directory) => {
        const archive = NodePath.join(directory, "bundle");
        const destination = NodePath.join(directory, "destination");
        if (rootType === "symlink") await writeSymlinkBundle(archive, "missing");
        else {
          const source = NodePath.join(directory, "source");
          await NodeFSP.mkdir(source);
          await NodeFSP.symlink("missing", NodePath.join(source, "link"));
          await packAgentDesktopBundle({
            sourcePath: source,
            outputPath: archive,
            compression: "none",
          });
        }
        if (collision !== "create") {
          await NodeFSP.mkdir(destination);
          await NodeFSP.writeFile(NodePath.join(destination, "keep"), "prior payload");
        }
        const before = await NodeFSP.lstat(destination).catch(() => null);
        await using worker = createWorker(archive, destination, {
          collision,
          failure: "symlink-metadata",
          allowExternalSymlinks: rootType === "symlink",
        });
        expect(await worker.result).toMatchObject({ status: "rejected", code: "EIO" });
        const after = await NodeFSP.lstat(destination).catch(() => null);
        if (before === null) expect(after).toBeNull();
        else {
          expect([after?.dev, after?.ino, after?.mode, after?.mtimeMs]).toEqual([
            before.dev,
            before.ino,
            before.mode,
            before.mtimeMs,
          ]);
          expect(await NodeFSP.readFile(NodePath.join(destination, "keep"), "utf8")).toBe(
            "prior payload",
          );
        }
        expect(
          (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
        ).toEqual([]);
      }),
  );

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
      await NodeFSP.chmod(NodePath.join(source, "hello.txt"), 0o770);

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
        0o770,
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

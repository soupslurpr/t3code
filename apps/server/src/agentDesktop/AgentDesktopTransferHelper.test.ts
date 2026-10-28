// @effect-diagnostics nodeBuiltinImport:off - Interop tests execute the packaged Python boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
} from "@t3tools/shared/agentDesktopBundle";
import { assert, describe, it, expect } from "@effect/vitest";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const helperPath = NodeURL.fileURLToPath(
  new URL("../../resources/agent-desktop/transfer-helper.py", import.meta.url),
);

const concurrentGuestCreate = String.raw`
import json, os, subprocess, sys
helper, directory, kind, full = sys.argv[1:]
destination = os.path.join(directory, "destination")
worker = '''import hashlib,importlib.util,json,os,sys
helper,source,destination,kind,full=sys.argv[1:]
spec=importlib.util.spec_from_file_location("transfer",helper)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
claimed=False
def claim():
 global claimed
 if claimed:return
 claimed=True
 print("ready",flush=True);assert sys.stdin.readline().strip()=="go"
original_exists=os.path.lexists
def exists(path):
 value=original_exists(path)
 if path==destination and not value:claim()
 return value
os.path.lexists=exists
def wrap(operation):
 original=getattr(os,operation)
 def invoke(*args,**kwargs):
  if args[0 if operation=="mkdir" else 1]==destination:claim()
  return original(*args,**kwargs)
 return invoke
for operation in ["mkdir","link","symlink"]:setattr(os,operation,wrap(operation))
if hasattr(module,"rename_no_replace"):
 original_rename=module.rename_no_replace
 def rename(source,destination,*args):
  claim();return original_rename(source,destination,*args)
 module.rename_no_replace=rename
try:
 if full=="yes":
  archive=source+".bundle"
  module.extract(archive,destination,"none","create",hashlib.sha256(open(archive,"rb").read()).hexdigest(),os.getuid(),os.getgid())
 else:module.install_staging(source,destination,kind,"create")
 result={"status":"fulfilled"}
except Exception as error:result={"status":"rejected","code":getattr(error,"code",None)}
print(json.dumps(result),flush=True)
'''
children=[]
try:
 for name in ["first","second"]:
  children.append(subprocess.Popen([sys.executable,"-B","-u","-c",worker,helper,os.path.join(directory,name),destination,kind,full],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True))
 for child in children:assert child.stdout.readline().strip()=="ready"
 results=[]
 for child in children:
  child.stdin.write("go\n");child.stdin.flush()
  results.append(json.loads(child.stdout.readline()))
  assert child.wait()==0,child.stderr.read()
 print(json.dumps(results))
finally:
 for child in children:
  if child.poll() is None:child.terminate();child.wait()
`;

/** Runs one test body in a disposable host directory. */
async function withTempDirectory(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-transfer-helper-"));
  try {
    await operation(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

/** Runs the dependency-free guest helper and parses its single JSON result. */
async function runHelper(argumentsValue: ReadonlyArray<string>): Promise<Record<string, unknown>> {
  const result = await execFile("python3", ["-B", helperPath, ...argumentsValue], {
    encoding: "utf8",
    maxBuffer: 128 * 1024,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Runs one expected helper failure and parses its structured stderr result. */
async function runHelperFailure(
  argumentsValue: ReadonlyArray<string>,
): Promise<Record<string, unknown>> {
  try {
    await execFile("python3", ["-B", helperPath, ...argumentsValue], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
    });
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stderr" in cause &&
      typeof cause.stderr === "string"
    ) {
      return JSON.parse(cause.stderr) as Record<string, unknown>;
    }
    throw cause;
  }
  throw new Error("the guest helper unexpectedly succeeded");
}

/** Writes the representative portable tree used by both codec directions. */
async function writeFixture(source: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.join(source, "nested"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(source, "Unicode ’ →.txt"), "Dinner: crème brûlée\n");
  await NodeFSP.writeFile(
    NodePath.join(source, "nested", "binary.dat"),
    Uint8Array.from([0, 1, 2, 127, 128, 254, 255]),
  );
  await NodeFSP.symlink("../Unicode ’ →.txt", NodePath.join(source, "nested", "link"));
}

/** Verifies exact file bytes and internal symlink preservation. */
async function verifyFixture(destination: string): Promise<void> {
  assert.equal(
    await NodeFSP.readFile(NodePath.join(destination, "Unicode ’ →.txt"), "utf8"),
    "Dinner: crème brûlée\n",
  );
  assert.deepEqual(
    await NodeFSP.readFile(NodePath.join(destination, "nested", "binary.dat")),
    Buffer.from([0, 1, 2, 127, 128, 254, 255]),
  );
  assert.equal(
    await NodeFSP.readlink(NodePath.join(destination, "nested", "link")),
    "../Unicode ’ →.txt",
  );
}

describe("Agent desktop transfer helper", () => {
  it.each([
    ["success", "handle"],
    ["collision", "handle"],
    ["uncertain", "handle"],
    ["success", "raw-spool"],
    ["collision", "raw-spool"],
    ["uncertain", "raw-spool"],
  ] as const)(
    "preserves the guest receipt through cleanup failure: %s %s",
    async (scenario, cleanup) =>
      withTempDirectory(async (directory) => {
        const source = NodePath.join(directory, "source");
        const archive = NodePath.join(directory, "bundle");
        const destination = NodePath.join(directory, "destination");
        await NodeFSP.writeFile(source, "complete payload");
        const packed = await packAgentDesktopBundle({
          sourcePath: source,
          outputPath: archive,
          compression: cleanup === "raw-spool" ? "gzip" : "none",
        });
        if (scenario === "collision") await NodeFSP.writeFile(destination, "existing");
        const worker = String.raw`
import errno,importlib.util,os,sys
helper=sys.argv[1];spec=importlib.util.spec_from_file_location("transfer",helper);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
if sys.argv[3] == "handle":
 original=os.close
 def close(fd):
  original(fd)
  raise OSError(errno.EIO,"injected handle cleanup failure")
 os.close=close
else:
 original=os.unlink
 def unlink(path,*args,**kwargs):
  if str(path).endswith(".raw"):raise OSError(errno.EIO,"injected raw cleanup failure")
  return original(path,*args,**kwargs)
 os.unlink=unlink
if sys.argv[2] == "uncertain":
 original_cdll=module.ctypes.CDLL
 def load(*args,**kwargs):
  library=original_cdll(*args,**kwargs)
  native=library.renameat2
  native.argtypes=[module.ctypes.c_int,module.ctypes.c_char_p,module.ctypes.c_int,module.ctypes.c_char_p,module.ctypes.c_uint]
  native.restype=module.ctypes.c_int
  def invalid_flags(*args):
   return native(*args[:-1],0xffffffff)
  library.renameat2=invalid_flags
  return library
 module.ctypes.CDLL=load
raise SystemExit(module.main(sys.argv[4:]))
`;
        const run = execFile("python3", [
          "-B",
          "-c",
          worker,
          helperPath,
          scenario,
          cleanup,
          "extract",
          "--archive",
          archive,
          "--destination",
          destination,
          "--compression",
          packed.compression,
          "--collision",
          "create",
          "--sha256",
          packed.sha256,
        ]);
        if (scenario !== "success") {
          const failure = await run.then(
            () => {
              throw new Error("collision unexpectedly succeeded");
            },
            (error: { stderr: string; code: number }) => error,
          );
          expect(failure.code).toBe(1);
          expect(JSON.parse(failure.stderr)).toMatchObject({
            code: scenario === "collision" ? "destination-exists" : "invalid-destination",
          });
          if (scenario === "uncertain")
            expect(failure.stderr).toMatch(/publication outcome is unconfirmed/i);
          expect(failure.stderr).toContain("cleanup");
          if (cleanup === "raw-spool") {
            const retained = (await NodeFSP.readdir(directory)).filter((path) =>
              path.endsWith(".raw"),
            );
            expect(retained).toHaveLength(1);
            expect(JSON.parse(failure.stderr).detail).toContain(
              NodePath.join(directory, retained[0]!),
            );
          }
        } else {
          const result = await run;
          expect(JSON.parse(result.stdout)).toMatchObject({
            rootType: "file",
            sha256: packed.sha256,
          });
          expect(result.stderr).toContain("cleanup");
          if (cleanup === "raw-spool") {
            const retained = (await NodeFSP.readdir(directory)).filter((path) =>
              path.endsWith(".raw"),
            );
            expect(retained).toHaveLength(1);
            expect(result.stderr).toContain(NodePath.join(directory, retained[0]!));
          }
        }
        if (scenario === "uncertain")
          expect(await NodeFSP.lstat(destination).catch(() => null)).toBeNull();
        else
          expect(await NodeFSP.readFile(destination, "utf8")).toBe(
            scenario === "collision" ? "existing" : "complete payload",
          );
        expect(
          (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
        ).toEqual([]);
      }),
  );

  it.each(["file", "directory", "empty-directory"] as const)(
    "publishes a guest %s into a write-and-search-only parent",
    async (rootType) =>
      withTempDirectory(async (directory) => {
        const source = NodePath.join(directory, "source");
        const archive = NodePath.join(directory, "bundle");
        const parent = NodePath.join(directory, "receiving");
        const destination = NodePath.join(parent, "received");
        if (rootType === "file") await NodeFSP.writeFile(source, "payload");
        else {
          await NodeFSP.mkdir(source);
          if (rootType === "directory")
            await NodeFSP.writeFile(NodePath.join(source, "payload"), "payload");
        }
        const packed = await packAgentDesktopBundle({
          sourcePath: source,
          outputPath: archive,
          compression: "none",
        });
        await NodeFSP.mkdir(parent, { mode: 0o300 });
        try {
          await runHelper([
            "extract",
            "--archive",
            archive,
            "--destination",
            destination,
            "--compression",
            "none",
            "--collision",
            "create",
            "--sha256",
            packed.sha256,
          ]);
          expect((await NodeFSP.lstat(destination)).isDirectory()).toBe(rootType !== "file");
          if (rootType !== "empty-directory")
            expect(
              await NodeFSP.readFile(
                rootType === "file" ? destination : NodePath.join(destination, "payload"),
                "utf8",
              ),
            ).toBe("payload");
        } finally {
          await NodeFSP.chmod(parent, 0o700);
        }
        expect(await NodeFSP.readdir(parent)).toEqual(["received"]);
      }),
  );

  it.each([
    ...(["file", "directory", "empty-directory", "symlink"] as const).map((rootType) => ({
      rootType,
      full: false,
    })),
    ...(["file", "directory", "empty-directory"] as const).map((rootType) => ({
      rootType,
      full: true,
    })),
  ])(
    "claims a $rootType only once across guest helper processes, full extraction=$full",
    async ({ rootType, full }) =>
      withTempDirectory(async (directory) => {
        for (const [index, payload] of ["first", "second"].entries()) {
          const source = NodePath.join(directory, payload);
          if (rootType === "file") await NodeFSP.writeFile(source, payload);
          else if (rootType === "symlink") {
            await NodeFSP.writeFile(`${source}-target`, payload);
            await NodeFSP.symlink(`${payload}-target`, source);
          } else {
            await NodeFSP.mkdir(source);
            if (rootType === "directory")
              await NodeFSP.writeFile(NodePath.join(source, "payload"), payload);
          }
          if (rootType === "symlink")
            await NodeFSP.lutimes(source, 1_680_000_000 + index, 1_680_000_000 + index);
          else {
            await NodeFSP.chmod(source, index === 0 ? 0o750 : 0o700);
            await NodeFSP.utimes(source, 1_680_000_000 + index, 1_680_000_000 + index);
          }
        }
        if (full) {
          for (const name of ["first", "second"])
            await packAgentDesktopBundle({
              sourcePath: NodePath.join(directory, name),
              outputPath: NodePath.join(directory, `${name}.bundle`),
              compression: "none",
            });
        }
        const original = await NodeFSP.lstat(NodePath.join(directory, "first"));
        const result = await execFile("python3", [
          "-B",
          "-c",
          concurrentGuestCreate,
          helperPath,
          directory,
          rootType === "empty-directory" ? "directory" : rootType,
          full ? "yes" : "no",
        ]);
        expect(JSON.parse(result.stdout)).toEqual([
          { status: "fulfilled" },
          { status: "rejected", code: "destination-exists" },
        ]);
        const destination = NodePath.join(directory, "destination");
        const installed = await NodeFSP.lstat(destination);
        expect(installed.mode & 0o777).toBe(original.mode & 0o777);
        expect(installed.mtimeMs).toBe(original.mtimeMs);
        expect(installed.uid).toBe(original.uid);
        expect(installed.gid).toBe(original.gid);
        if (rootType !== "empty-directory")
          expect(
            await NodeFSP.readFile(
              rootType === "directory" ? NodePath.join(destination, "payload") : destination,
              "utf8",
            ),
          ).toBe("first");
        if (rootType === "symlink")
          expect(await NodeFSP.readlink(destination)).toBe("first-target");
        if (!full)
          await expect(NodeFSP.lstat(NodePath.join(directory, "first"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        else
          expect(
            (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
          ).toEqual([]);
        expect((await NodeFSP.lstat(NodePath.join(directory, "second"))).mode & 0o777).toBe(
          rootType === "symlink" ? 0o777 : 0o700,
        );
      }),
  );

  it.each(["file", "directory", "empty-directory"] as const)(
    "preserves existing destination kinds through the real guest extractor for %s",
    async (rootType) =>
      withTempDirectory(async (directory) => {
        const source = NodePath.join(directory, "source");
        if (rootType === "file") await NodeFSP.writeFile(source, "new payload");
        else {
          await NodeFSP.mkdir(source);
          if (rootType === "directory")
            await NodeFSP.writeFile(NodePath.join(source, "new"), "new payload");
        }
        const archive = NodePath.join(directory, "bundle");
        const packed = await packAgentDesktopBundle({
          sourcePath: source,
          outputPath: archive,
          compression: "none",
        });
        for (const existing of [
          "file",
          "directory",
          "empty-directory",
          "symlink",
          "dangling-symlink",
        ]) {
          const destination = NodePath.join(directory, existing);
          if (existing === "file") await NodeFSP.writeFile(destination, "keep");
          else if (existing === "directory" || existing === "empty-directory") {
            await NodeFSP.mkdir(destination);
            if (existing === "directory")
              await NodeFSP.writeFile(NodePath.join(destination, "keep"), "keep");
          } else await NodeFSP.symlink(existing === "symlink" ? "source" : "missing", destination);
          const before = await NodeFSP.lstat(destination);
          const result = await runHelperFailure([
            "extract",
            "--archive",
            archive,
            "--destination",
            destination,
            "--compression",
            "none",
            "--collision",
            "create",
            "--sha256",
            packed.sha256,
          ]);
          expect(result.code).toBe("destination-exists");
          const after = await NodeFSP.lstat(destination);
          expect([after.dev, after.ino, after.mode, after.mtimeMs]).toEqual([
            before.dev,
            before.ino,
            before.mode,
            before.mtimeMs,
          ]);
        }
        expect(
          (await NodeFSP.readdir(directory)).filter((name) => name.includes(".t3-transfer-")),
        ).toEqual([]);
      }),
  );

  it.each(
    (["file", "directory", "empty-directory"] as const).flatMap((rootType) =>
      ([false, true] as const).map((afterCommit) => ({ rootType, afterCommit })),
    ),
  )(
    "keeps real guest $rootType extraction absent or complete on interruption, afterCommit=$afterCommit",
    async ({ rootType, afterCommit }) =>
      withTempDirectory(async (directory) => {
        const source = NodePath.join(directory, "source");
        if (rootType === "file") await NodeFSP.writeFile(source, "complete tree");
        else {
          await NodeFSP.mkdir(source);
          if (rootType === "directory")
            await NodeFSP.writeFile(NodePath.join(source, "payload"), "complete tree");
        }
        const archive = NodePath.join(directory, "bundle");
        const packed = await packAgentDesktopBundle({
          sourcePath: source,
          outputPath: archive,
          compression: "none",
        });
        const probe = String.raw`
import json,os,signal,subprocess,sys
helper,archive,directory,digest,after=sys.argv[1:]
worker='''import importlib.util,json,os,sys
helper,archive,destination,digest,after=sys.argv[1:]
spec=importlib.util.spec_from_file_location("transfer",helper);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
original=module.rename_no_replace
def rename(source,destination,*args):
 info=os.lstat(source)
 if after=="yes":original(source,destination,*args)
 print(json.dumps({"stage":source,"dev":info.st_dev,"ino":info.st_ino,"mode":info.st_mode,"mtimeNs":str(info.st_mtime_ns),"uid":info.st_uid,"gid":info.st_gid}),flush=True)
 assert sys.stdin.readline().strip()=="go"
 if after!="yes":original(source,destination,*args)
module.rename_no_replace=rename
module.extract(archive,destination,"none","create",digest,os.getuid(),os.getgid())
'''
rows=[]
for signum in [signal.SIGTERM,signal.SIGKILL]:
 destination=os.path.join(directory,"received-"+str(signum))
 child=subprocess.Popen([sys.executable,"-B","-u","-c",worker,helper,archive,destination,digest,after],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  row=json.loads(child.stdout.readline());child.send_signal(signum);code=child.wait();assert code==-signum
  rows.append({**row,"destination":destination,"signal":signum})
 finally:
  if child.poll() is None:child.kill();child.wait()
print(json.dumps(rows))
`;
        const output = await execFile("python3", [
          "-B",
          "-c",
          probe,
          helperPath,
          archive,
          directory,
          packed.sha256,
          afterCommit ? "yes" : "no",
        ]);
        const rows = JSON.parse(output.stdout) as Array<{
          stage: string;
          destination: string;
          dev: number;
          ino: number;
          mode: number;
          mtimeNs: string;
          uid: number;
          gid: number;
        }>;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          if (!afterCommit)
            await expect(NodeFSP.lstat(row.destination)).rejects.toMatchObject({ code: "ENOENT" });
          else {
            const installed = await NodeFSP.lstat(row.destination, { bigint: true });
            expect([
              installed.dev,
              installed.ino,
              installed.mode,
              installed.mtimeNs,
              installed.uid,
              installed.gid,
            ]).toEqual([
              BigInt(row.dev),
              BigInt(row.ino),
              BigInt(row.mode),
              BigInt(row.mtimeNs),
              BigInt(row.uid),
              BigInt(row.gid),
            ]);
            if (rootType === "empty-directory")
              expect(await NodeFSP.readdir(row.destination)).toEqual([]);
            else
              expect(
                await NodeFSP.readFile(
                  rootType === "directory"
                    ? NodePath.join(row.destination, "payload")
                    : row.destination,
                  "utf8",
                ),
              ).toBe("complete tree");
          }
        }
      }),
  );

  it.each(["unsupported", "after-commit", "reused-stage"] as const)(
    "reports %s without deleting a guest destination or foreign staging",
    async (failure) =>
      withTempDirectory(async (directory) => {
        const source = NodePath.join(directory, "source");
        await NodeFSP.mkdir(source);
        await NodeFSP.writeFile(NodePath.join(source, "payload"), "complete tree");
        const archive = NodePath.join(directory, "bundle");
        const packed = await packAgentDesktopBundle({
          sourcePath: source,
          outputPath: archive,
          compression: "none",
        });
        const destination = NodePath.join(directory, "destination");
        const probe = String.raw`
import ctypes,errno,importlib.util,json,os,sys,types
helper,archive,destination,digest,failure=sys.argv[1:]
spec=importlib.util.spec_from_file_location("transfer",helper);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
real=ctypes.CDLL(None,use_errno=True).renameat2
real.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];real.restype=ctypes.c_int
stage=None
def invoke(parent,source,target_parent,target,flags):
 global stage
 stage=os.path.join(os.path.dirname(destination),os.fsdecode(source))
 if failure=="unsupported":return real(parent,source,target_parent,target,0xffffffff)
 result=real(parent,source,target_parent,target,flags);assert result==0
 if failure=="reused-stage":open(stage,"w").write("foreign stage")
 ctypes.set_errno(errno.EIO);return -1
module.ctypes.CDLL=lambda *args,**kwargs:types.SimpleNamespace(renameat2=invoke)
try:
 module.extract(archive,destination,"none","create",digest,os.getuid(),os.getgid());raise AssertionError("unexpected success")
except module.TransferError as error:print(json.dumps({"code":error.code,"detail":str(error),"stage":stage}))
`;
        const output = await execFile("python3", [
          "-B",
          "-c",
          probe,
          helperPath,
          archive,
          destination,
          packed.sha256,
          failure,
        ]);
        const result = JSON.parse(output.stdout) as { code: string; detail: string; stage: string };
        expect(result.code).toBe("invalid-destination");
        expect(result.detail).toMatch(/publication outcome is unconfirmed/i);
        if (failure === "unsupported")
          await expect(NodeFSP.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
        else
          expect(await NodeFSP.readFile(NodePath.join(destination, "payload"), "utf8")).toBe(
            "complete tree",
          );
        if (failure === "reused-stage") {
          expect(await NodeFSP.readFile(result.stage, "utf8")).toBe("foreign stage");
          expect(result.detail).toContain("Staging cleanup was not confirmed");
        } else await expect(NodeFSP.lstat(result.stage)).rejects.toMatchObject({ code: "ENOENT" });
      }),
  );

  it("extracts bundles produced by the host codec", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      const archive = NodePath.join(directory, "host.bundle");
      const destination = NodePath.join(directory, "guest-result");
      await writeFixture(source);
      const packed = await packAgentDesktopBundle({
        sourcePath: source,
        outputPath: archive,
        compression: "gzip",
      });

      const result = await runHelper([
        "extract",
        "--archive",
        archive,
        "--destination",
        destination,
        "--compression",
        packed.compression,
        "--collision",
        "create",
        "--sha256",
        packed.sha256,
      ]);

      assert.deepInclude(result, {
        rootType: "directory",
        fileCount: 2,
        directoryCount: 2,
        symlinkCount: 1,
        logicalBytes: 31,
        compression: "gzip",
        sha256: packed.sha256,
      });
      await verifyFixture(destination);
    }));

  it("extracts bundles produced by the guest codec", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      const archive = NodePath.join(directory, "guest.bundle");
      const destination = NodePath.join(directory, "host-result");
      await writeFixture(source);

      const result = await runHelper([
        "pack",
        "--source",
        source,
        "--output",
        archive,
        "--compression",
        "auto",
      ]);
      assert.match(String(result.sha256), /^[a-f0-9]{64}$/);
      const extracted = await extractAgentDesktopBundle({
        archivePath: archive,
        destinationPath: destination,
        compression: result.compression === "gzip" ? "gzip" : "none",
      });

      assert.deepInclude(extracted, {
        rootType: "directory",
        fileCount: 2,
        directoryCount: 2,
        symlinkCount: 1,
        logicalBytes: 31,
      });
      await verifyFixture(destination);
    }));

  it("rejects escaping symlinks while packing in the guest helper", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source");
      await NodeFSP.mkdir(source);
      await NodeFSP.symlink("../outside", NodePath.join(source, "outside-link"));

      const failure = await runHelperFailure([
        "pack",
        "--source",
        source,
        "--output",
        NodePath.join(directory, "guest.bundle"),
        "--compression",
        "none",
      ]);

      assert.equal(failure.code, "unsupported-entry");
      assert.match(String(failure.detail), /escapes the copied tree/u);
    }));

  it("reports destination collisions structurally", () =>
    withTempDirectory(async (directory) => {
      const source = NodePath.join(directory, "source.txt");
      const archive = NodePath.join(directory, "guest.bundle");
      const destination = NodePath.join(directory, "existing.txt");
      await NodeFSP.writeFile(source, "source");
      await NodeFSP.writeFile(destination, "existing");
      const packed = await runHelper([
        "pack",
        "--source",
        source,
        "--output",
        archive,
        "--compression",
        "none",
      ]);

      const failure = await runHelperFailure([
        "extract",
        "--archive",
        archive,
        "--destination",
        destination,
        "--compression",
        "none",
        "--collision",
        "create",
        "--sha256",
        String(packed.sha256),
      ]);

      assert.deepEqual(failure, {
        code: "destination-exists",
        detail: `destination already exists: ${destination}`,
      });
      assert.equal(await NodeFSP.readFile(destination, "utf8"), "existing");
    }));
});

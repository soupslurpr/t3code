/** Downloads, verifies, provisions, and atomically installs Agent desktop images. */

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const DEFAULT_DISK_SIZE = "64G";
const DEFAULT_MEMORY_MIB = 4_096;
const MAX_BUILD_CPUS = 6;
const BUILD_TIMEOUT_MS = 45 * 60 * 1_000;
const PROCESS_TERMINATE_GRACE_MS = 10_000;
const SEED_SIZE_BYTES = 4 * 1_024 * 1_024;
const MIN_PROVISION_FREE_BYTES = 8 * 1_024 * 1_024 * 1_024;
const QEMU_EXECUTABLE = "/usr/bin/qemu-system-x86_64";
const QEMU_IMG_EXECUTABLE = "/usr/bin/qemu-img";
const MFORMAT_EXECUTABLE = "/usr/bin/mformat";
const MCOPY_EXECUTABLE = "/usr/bin/mcopy";
const OVMF_CODE_PATH = "/usr/share/edk2/x64/OVMF_CODE.4m.fd";
const OVMF_VARS_PATH = "/usr/share/edk2/x64/OVMF_VARS.4m.fd";
const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repositoryRoot = NodePath.resolve(scriptDirectory, "../../../..");

import {
  abortError,
  downloadPinnedAgentDesktopSource,
  PINNED_ARCH_IMAGE,
  sha256File,
} from "./image-download.mjs";
import {
  cloudConfig,
  PROVISIONED_MARKER,
  AGENT_DESKTOP_PROFILE_VERSION,
} from "./image-profile.mjs";
/** Reports invalid image-builder arguments without partially creating an image. */
export class AgentDesktopImageArgumentError extends Error {}

/** Parses the dependency-free Agent desktop image-builder command line. */
export function parseAgentDesktopImageArguments(argumentsValue, environment = process.env) {
  const options = {
    source: environment.T3_AGENT_DESKTOP_SOURCE_IMAGE,
    output:
      environment.T3_AGENT_DESKTOP_OUTPUT_IMAGE ??
      NodePath.join(repositoryRoot, "release/agent-desktop/base.qcow2"),
    expectedSha256: environment.T3_AGENT_DESKTOP_SOURCE_SHA256,
    diskSize: environment.T3_AGENT_DESKTOP_DISK_SIZE ?? DEFAULT_DISK_SIZE,
    downloadPinned: environment.T3_AGENT_DESKTOP_DOWNLOAD_PINNED === "1",
    force: false,
    skipChecksum: false,
    cleanOnFailure: false,
  };
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    const value = () => {
      const next = argumentsValue[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new AgentDesktopImageArgumentError(`${argument} requires a value`);
      }
      index += 1;
      return next;
    };
    switch (argument) {
      case "--source":
        options.source = value();
        break;
      case "--output":
        options.output = value();
        break;
      case "--sha256":
        options.expectedSha256 = value();
        break;
      case "--disk-size":
        options.diskSize = value();
        break;
      case "--download-pinned":
        options.downloadPinned = true;
        options.source = undefined;
        break;
      case "--force":
        options.force = true;
        break;
      case "--skip-checksum":
        options.skipChecksum = true;
        break;
      case "--clean-on-failure":
        options.cleanOnFailure = true;
        break;
      default:
        throw new AgentDesktopImageArgumentError(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  if (options.downloadPinned && options.source !== undefined) {
    throw new AgentDesktopImageArgumentError("--download-pinned cannot be combined with --source");
  }
  if (
    !options.downloadPinned &&
    (options.source === undefined || options.source.trim().length === 0)
  ) {
    throw new AgentDesktopImageArgumentError(
      "provide --source, --download-pinned, or T3_AGENT_DESKTOP_SOURCE_IMAGE",
    );
  }
  if (!/^[1-9][0-9]*[GMTP]$/u.test(options.diskSize)) {
    throw new AgentDesktopImageArgumentError("--disk-size must use a QEMU size such as 64G");
  }
  if (options.expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/u.test(options.expectedSha256)) {
    throw new AgentDesktopImageArgumentError("--sha256 must contain 64 hexadecimal characters");
  }
  return {
    ...options,
    source: options.source === undefined ? undefined : NodePath.resolve(options.source),
    output: NodePath.resolve(options.output),
    expectedSha256: options.expectedSha256?.toLowerCase(),
  };
}

/** Runs one bounded host command and returns its captured output. */
async function runCommand(executable, argumentsValue, options = {}) {
  if (options.signal?.aborted) throw abortError();
  const child = NodeChildProcess.spawn(executable, argumentsValue, {
    cwd: options.cwd,
    env: options.environment ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let forceKill = null;
  const abort = () => {
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), PROCESS_TERMINATE_GRACE_MS);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => {
    options.signal?.removeEventListener("abort", abort);
    if (forceKill !== null) clearTimeout(forceKill);
  });
  if (options.signal?.aborted) throw abortError();
  if (result.exitCode !== 0) {
    const detail = (
      Buffer.concat(stderr).toString("utf8") ||
      Buffer.concat(stdout).toString("utf8") ||
      result.signal ||
      "unknown failure"
    ).trim();
    throw new Error(`${executable} failed: ${detail}`);
  }
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

/** Reads the first SHA-256 digest from an Arch image sidecar when present. */
async function readSidecarSha256(source) {
  try {
    const sidecar = await NodeFSP.readFile(`${source}.SHA256`, "utf8");
    return /^[a-fA-F0-9]{64}\b/u.exec(sidecar.trim())?.[0]?.toLowerCase();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Verifies the source image format and its required or explicitly skipped digest. */
export async function verifyAgentDesktopSourceImage(options) {
  const info = await runCommand(QEMU_IMG_EXECUTABLE, ["info", "--output=json", options.source], {
    signal: options.signal,
  });
  const image = JSON.parse(info.stdout);
  if (image.format !== "qcow2") throw new Error("the source image must use qcow2 format");
  const expected = options.expectedSha256 ?? (await readSidecarSha256(options.source));
  if (expected === undefined && !options.skipChecksum) {
    throw new Error("provide --sha256, a .SHA256 sidecar, or explicitly use --skip-checksum");
  }
  if (expected !== undefined) {
    const actual = await sha256File(options.source, options.signal);
    if (actual !== expected) throw new Error(`source SHA-256 mismatch: expected ${expected}`);
  }
}

/** Creates a NoCloud FAT seed without cloud-image-utils or ISO tooling. */
async function createSeedImage(directory, signal) {
  const seedPath = NodePath.join(directory, "cidata.img");
  const userDataPath = NodePath.join(directory, "user-data");
  const metaDataPath = NodePath.join(directory, "meta-data");
  const seed = await NodeFSP.open(seedPath, "w", 0o600);
  await seed.truncate(SEED_SIZE_BYTES);
  await seed.close();
  await NodeFSP.writeFile(userDataPath, cloudConfig, { mode: 0o600 });
  await NodeFSP.writeFile(
    metaDataPath,
    "instance-id: t3-agent-desktop-image-v1\nlocal-hostname: t3-agent-desktop\n",
    { mode: 0o600 },
  );
  const environment = { ...process.env, MTOOLS_SKIP_CHECK: "1" };
  await runCommand(MFORMAT_EXECUTABLE, ["-i", seedPath, "-v", "cidata", "::"], {
    environment,
    signal,
  });
  await runCommand(MCOPY_EXECUTABLE, ["-i", seedPath, userDataPath, "::user-data"], {
    environment,
    signal,
  });
  await runCommand(MCOPY_EXECUTABLE, ["-i", seedPath, metaDataPath, "::meta-data"], {
    environment,
    signal,
  });
  return seedPath;
}

/** Boots the build overlay until cloud-init powers the guest off. */
async function provisionImage(input) {
  const cpuCount = Math.max(2, Math.min(MAX_BUILD_CPUS, NodeOS.availableParallelism()));
  const argumentsValue = [
    "-name",
    "T3 Agent Desktop Image Builder",
    "-machine",
    "q35,accel=kvm",
    "-cpu",
    "host",
    "-smp",
    String(cpuCount),
    "-m",
    String(DEFAULT_MEMORY_MIB),
    "-nodefaults",
    "-no-reboot",
    "-display",
    "none",
    "-monitor",
    "none",
    "-drive",
    `if=pflash,format=raw,readonly=on,file=${OVMF_CODE_PATH}`,
    "-drive",
    `if=pflash,format=qcow2,file=${input.nvram}`,
    "-drive",
    `if=virtio,format=qcow2,cache=none,discard=unmap,file=${input.disk}`,
    "-drive",
    `if=virtio,format=raw,readonly=on,file=${input.seed}`,
    "-netdev",
    JSON.stringify({
      type: "passt",
      id: "net0",
      param: ["--tcp-ports", "none", "--udp-ports", "none", "--no-map-gw"].map((str) => ({ str })),
    }),
    "-device",
    "virtio-net-pci,netdev=net0",
    "-device",
    "virtio-rng-pci",
    "-serial",
    `file:${input.serialLog}`,
  ];
  const child = NodeChildProcess.spawn(QEMU_EXECUTABLE, argumentsValue, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32_768);
  });
  let forceKill = null;
  const terminate = () => {
    if (forceKill !== null) return;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), PROCESS_TERMINATE_GRACE_MS);
  };
  const timeout = setTimeout(terminate, BUILD_TIMEOUT_MS);
  input.signal?.addEventListener("abort", terminate, { once: true });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => {
    clearTimeout(timeout);
    if (forceKill !== null) clearTimeout(forceKill);
    input.signal?.removeEventListener("abort", terminate);
  });
  if (input.signal?.aborted) throw abortError();
  if (result.exitCode !== 0) {
    throw new Error(
      `QEMU provisioning failed (${result.signal ?? result.exitCode}): ${stderr.trim()}`,
    );
  }
  const serial = await NodeFSP.readFile(input.serialLog, "utf8");
  if (!serial.includes(PROVISIONED_MARKER)) {
    throw new Error(`cloud-init did not complete: ${serial.slice(-8_192).trim()}`);
  }
}

/** Ensures the managed image directory has enough temporary build capacity. */
async function requireProvisionSpace(output) {
  const directory = NodePath.dirname(output);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const fileSystem = await NodeFSP.statfs(directory);
  const freeBytes = fileSystem.bavail * fileSystem.bsize;
  if (freeBytes < MIN_PROVISION_FREE_BYTES) {
    throw new Error(
      `agent desktop image provisioning requires at least 8 GiB free; ${Math.floor(freeBytes / 1_073_741_824)} GiB is available`,
    );
  }
}

/** Builds and atomically installs one clean Agent desktop base image. */
export async function buildAgentDesktopImage(options) {
  await requireProvisionSpace(options.output);
  await verifyAgentDesktopSourceImage(options);
  if (!options.force) {
    try {
      await NodeFSP.access(options.output);
      throw new Error(`output already exists: ${options.output}; pass --force to replace it`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const buildDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(options.output), ".agent-desktop-build-"),
  );
  const disk = NodePath.join(buildDirectory, "disk.qcow2");
  const nvram = NodePath.join(buildDirectory, "nvram.qcow2");
  const serialLog = NodePath.join(buildDirectory, "serial.log");
  const outputTemporary = `${options.output}.building-${process.pid}`;
  let completed = false;
  try {
    await runCommand(
      QEMU_IMG_EXECUTABLE,
      ["create", "-f", "qcow2", "-F", "qcow2", "-b", options.source, disk, options.diskSize],
      { signal: options.signal },
    );
    await runCommand(
      QEMU_IMG_EXECUTABLE,
      ["convert", "-f", "raw", "-O", "qcow2", OVMF_VARS_PATH, nvram],
      { signal: options.signal },
    );
    const seed = await createSeedImage(buildDirectory, options.signal);
    await provisionImage({ disk, nvram, seed, serialLog, signal: options.signal });
    await runCommand(QEMU_IMG_EXECUTABLE, ["check", "-f", "qcow2", disk], {
      signal: options.signal,
    });
    await runCommand(
      QEMU_IMG_EXECUTABLE,
      [
        "convert",
        "-p",
        "-c",
        "-O",
        "qcow2",
        "-o",
        "compat=1.1,lazy_refcounts=on,compression_type=zstd",
        disk,
        outputTemporary,
      ],
      { signal: options.signal },
    );
    await NodeFSP.chmod(outputTemporary, 0o600);
    await NodeFSP.rename(outputTemporary, options.output);
    completed = true;
  } catch (error) {
    if (!options.cleanOnFailure && error instanceof Error) {
      error.message = `${error.message}\nbuild artifacts retained at ${buildDirectory}`;
    }
    throw error;
  } finally {
    await NodeFSP.rm(outputTemporary, { force: true });
    if (completed || options.cleanOnFailure) {
      await NodeFSP.rm(buildDirectory, { recursive: true, force: true });
    }
  }
  return options.output;
}

export async function buildPinnedImage(output) {
  await requireProvisionSpace(output);
  const source = await downloadPinnedAgentDesktopSource({
    directory: NodePath.join(NodePath.dirname(output), "sources"),
  });
  await buildAgentDesktopImage({
    output,
    source,
    expectedSha256: PINNED_ARCH_IMAGE.sha256,
    diskSize: DEFAULT_DISK_SIZE,
    cleanOnFailure: true,
  });
  return {
    profileVersion: AGENT_DESKTOP_PROFILE_VERSION,
    sourceRelease: PINNED_ARCH_IMAGE.release,
  };
}

/** Runs the command-line image builder. */
export async function main(argumentsValue = process.argv.slice(2), environment = process.env) {
  const options = parseAgentDesktopImageArguments(argumentsValue, environment);
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await requireProvisionSpace(options.output);
    const source = options.downloadPinned
      ? await downloadPinnedAgentDesktopSource({
          directory: NodePath.join(NodePath.dirname(options.output), "sources"),
          signal: abortController.signal,
          onStatus: (status) => console.log(status),
          onProgress: (completedBytes, totalBytes) =>
            console.log(`Downloaded ${completedBytes} of ${totalBytes} bytes`),
        })
      : options.source;
    if (source === undefined) throw new AgentDesktopImageArgumentError("source image is missing");
    console.log(`Building Agent desktop image from ${source}`);
    const output = await buildAgentDesktopImage({
      ...options,
      source,
      expectedSha256: options.downloadPinned ? PINNED_ARCH_IMAGE.sha256 : options.expectedSha256,
      signal: abortController.signal,
    });
    console.log(`Agent desktop image ready at ${output}`);
    return output;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  await main();
}

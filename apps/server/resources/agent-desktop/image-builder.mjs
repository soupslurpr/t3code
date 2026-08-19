/** Downloads, verifies, provisions, and atomically installs Agent desktop images. */

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeURL from "node:url";

const DEFAULT_DISK_SIZE = "64G";
const DEFAULT_MEMORY_MIB = 4_096;
const MAX_BUILD_CPUS = 8;
const BUILD_TIMEOUT_MS = 45 * 60 * 1_000;
const PROCESS_TERMINATE_GRACE_MS = 10_000;
const SEED_SIZE_BYTES = 4 * 1_024 * 1_024;
const DOWNLOAD_RETRY_COUNT = 3;
const DOWNLOAD_IDLE_TIMEOUT_MS = 2 * 60 * 1_000;
const DOWNLOAD_PROGRESS_BYTES = 64 * 1_024 * 1_024;
const MIN_PROVISION_FREE_BYTES = 8 * 1_024 * 1_024 * 1_024;
const PROVISIONED_MARKER = "T3 Agent desktop image provisioned";
const QEMU_EXECUTABLE = "/usr/bin/qemu-system-x86_64";
const QEMU_IMG_EXECUTABLE = "/usr/bin/qemu-img";
const MFORMAT_EXECUTABLE = "/usr/bin/mformat";
const MCOPY_EXECUTABLE = "/usr/bin/mcopy";
const OVMF_CODE_PATH = "/usr/share/edk2/x64/OVMF_CODE.4m.fd";
const OVMF_VARS_PATH = "/usr/share/edk2/x64/OVMF_VARS.4m.fd";
const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repositoryRoot = NodePath.resolve(scriptDirectory, "../../../..");

export const PINNED_ARCH_IMAGE = Object.freeze({
  release: "20260801.566320",
  fileName: "Arch-Linux-x86_64-cloudimg-20260801.566320.qcow2",
  url: "https://geo.mirror.pkgbuild.com/images/v20260801.566320/Arch-Linux-x86_64-cloudimg-20260801.566320.qcow2",
  sha256: "9ca8d4b0a60e53b8aa1ac2317166ecffc4e9eae8d0b28b7ca0e3d333578f9a07",
  sizeBytes: 556_424_192,
});
export const AGENT_DESKTOP_PROFILE_VERSION = "arch-gnome-v1";

const cloudConfig = `#cloud-config
hostname: t3-agent-desktop
manage_etc_hosts: true
timezone: Etc/UTC
locale: en_US.UTF-8
disable_root: true
ssh_pwauth: false
users:
  - name: t3agent
    gecos: T3 Agent
    groups: [wheel]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
package_update: true
package_upgrade: true
packages:
  - at-spi2-core
  - base-devel
  - chromium
  - curl
  - git
  - gjs
  - gdm
  - gnome-backgrounds
  - gnome-calculator
  - gnome-console
  - gnome-control-center
  - gnome-session
  - gnome-settings-daemon
  - gnome-shell
  - gnome-text-editor
  - gst-plugin-pipewire
  - gst-plugins-base-libs
  - gst-plugins-good
  - gstreamer
  - jq
  - mesa
  - nautilus
  - networkmanager
  - nodejs
  - noto-fonts
  - noto-fonts-emoji
  - npm
  - pipewire
  - python
  - qemu-guest-agent
  - ripgrep
  - mesa-utils
  - sudo
  - wireplumber
  - xdg-desktop-portal-gnome
  - xdg-user-dirs
  - xorg-xwayland
write_files:
  - path: /etc/t3-agent-desktop-profile
    permissions: "0644"
    content: |
      ${AGENT_DESKTOP_PROFILE_VERSION}
  - path: /etc/gdm/custom.conf
    permissions: "0644"
    defer: true
    content: |
      [daemon]
      AutomaticLoginEnable=True
      AutomaticLogin=t3agent

      [security]

      [xdmcp]

      [chooser]

      [debug]
  - path: /etc/dconf/profile/user
    permissions: "0644"
    content: |
      user-db:user
      system-db:local
  - path: /etc/dconf/db/local.d/00-t3-agent-desktop
    permissions: "0644"
    content: |
      [org/gnome/desktop/session]
      idle-delay=uint32 0

      [org/gnome/desktop/interface]
      toolkit-accessibility=true

      [org/gnome/desktop/screensaver]
      lock-enabled=false

      [org/gnome/settings-daemon/plugins/power]
      sleep-inactive-ac-type='nothing'
      sleep-inactive-battery-type='nothing'
  - path: /etc/t3-agent-desktop-user
    permissions: "0644"
    content: |
      t3agent
  - path: /var/lib/AccountsService/users/t3agent
    permissions: "0600"
    content: |
      [User]
      Language=en_US.UTF-8
      XSession=gnome
      SystemAccount=false
runcmd:
  - [dconf, update]
  - [install, -d, -o, t3agent, -g, t3agent, /home/t3agent/.config]
  - [touch, /home/t3agent/.config/gnome-initial-setup-done]
  - [chown, -R, t3agent:t3agent, /home/t3agent/.config]
  - [systemctl, enable, gdm.service]
  - [systemctl, enable, NetworkManager.service]
  - [systemctl, enable, qemu-guest-agent.service]
  - [systemctl, set-default, graphical.target]
  - [systemctl, disable, --now, sshd.service]
  - [systemctl, mask, sshd.service, sshd.socket]
  - [rm, -rf, /root/.ssh, /home/t3agent/.ssh]
  - [sh, -c, "rm -f /etc/ssh/ssh_host_* /var/lib/systemd/random-seed"]
  - [sh, -c, "rm -rf /var/cache/pacman/pkg/* /var/log/journal/*"]
  - [touch, /etc/cloud/cloud-init.disabled]
  - [sh, -c, ": > /etc/machine-id"]
  - [sync]
power_state:
  mode: poweroff
  message: Powering off the provisioned Agent desktop image
  timeout: 120
  condition: true
final_message: ${PROVISIONED_MARKER}
`;

/** Reports invalid image-builder arguments without partially creating an image. */
export class AgentDesktopImageArgumentError extends Error {}

/** Reports a bounded pinned-image download failure. */
export class AgentDesktopImageDownloadError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

/** Returns the deterministic cloud-init document used for Agent desktop images. */
export function agentDesktopCloudConfig() {
  return cloudConfig;
}

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

/** Creates the consistent cancellation failure propagated across child operations. */
const abortError = () => new Error("agent desktop image provisioning was cancelled");

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

/** Computes one file's lowercase SHA-256 digest without retaining it in memory. */
async function sha256File(path, signal) {
  const hash = NodeCrypto.createHash("sha256");
  const handle = await NodeFSP.open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      if (signal?.aborted) throw abortError();
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
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

/** Checks that a download URL stays on the official Arch mirror network. */
const allowedPinnedImageUrl = (url) =>
  url.protocol === "https:" &&
  (url.hostname === "mirror.pkgbuild.com" || url.hostname.endsWith(".mirror.pkgbuild.com"));

/** Parses one nonnegative HTTP integer without accepting unsafe values. */
const responseInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

/** Validates one pinned-image response and chooses append or replacement mode. */
export function pinnedImageDownloadPlan(statusCode, headers, requestedOffset, expectedSize) {
  if (statusCode !== 200 && statusCode !== 206) {
    throw new AgentDesktopImageDownloadError(
      `official Arch image server returned HTTP ${statusCode ?? "unknown"}`,
      statusCode === 408 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500),
    );
  }
  const append = requestedOffset > 0 && statusCode === 206;
  const initialBytes = append ? requestedOffset : 0;
  const contentLength = responseInteger(headers["content-length"]);
  if (contentLength !== expectedSize - initialBytes) {
    throw new AgentDesktopImageDownloadError(
      `official Arch image size mismatch: expected ${expectedSize - initialBytes} response bytes`,
    );
  }
  if (append) {
    const expectedContentRange = `bytes ${requestedOffset}-${expectedSize - 1}/${expectedSize}`;
    if (headers["content-range"] !== expectedContentRange) {
      throw new AgentDesktopImageDownloadError(
        "official Arch image returned an invalid byte range",
      );
    }
  }
  return { append, initialBytes };
}

/** Performs one validated, optionally resumed pinned-image download attempt. */
const downloadAttempt = (image, destination, requestedOffset, signal, onProgress, redirects = 0) =>
  new Promise((resolve, reject) => {
    const url = new URL(image.url);
    if (!allowedPinnedImageUrl(url)) {
      reject(
        new AgentDesktopImageDownloadError("pinned Arch image URL is not an approved HTTPS mirror"),
      );
      return;
    }
    const request = NodeHttps.get(
      url,
      {
        headers: requestedOffset === 0 ? {} : { Range: `bytes=${requestedOffset}-` },
        signal,
      },
      (response) => {
        const location = response.headers.location;
        if (
          response.statusCode !== undefined &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          location !== undefined
        ) {
          response.resume();
          if (redirects >= 3) {
            reject(
              new AgentDesktopImageDownloadError("official Arch image redirected too many times"),
            );
            return;
          }
          const redirected = new URL(location, url);
          if (!allowedPinnedImageUrl(redirected)) {
            reject(
              new AgentDesktopImageDownloadError(
                "official Arch image redirected off its approved mirrors",
              ),
            );
            return;
          }
          resolve(
            downloadAttempt(
              { ...image, url: redirected.href },
              destination,
              requestedOffset,
              signal,
              onProgress,
              redirects + 1,
            ),
          );
          return;
        }

        let plan;
        try {
          plan = pinnedImageDownloadPlan(
            response.statusCode,
            response.headers,
            requestedOffset,
            image.sizeBytes,
          );
        } catch (error) {
          response.resume();
          reject(error);
          return;
        }
        let receivedBytes = plan.initialBytes;
        let nextProgressBytes =
          Math.floor(receivedBytes / DOWNLOAD_PROGRESS_BYTES + 1) * DOWNLOAD_PROGRESS_BYTES;
        response.on("data", (chunk) => {
          receivedBytes += chunk.byteLength;
          if (receivedBytes >= nextProgressBytes || receivedBytes === image.sizeBytes) {
            onProgress?.(receivedBytes, image.sizeBytes);
            nextProgressBytes += DOWNLOAD_PROGRESS_BYTES;
          }
        });
        const output = NodeFS.createWriteStream(destination, {
          flags: plan.append ? "a" : "w",
          mode: 0o600,
        });
        NodeStreamPromises.pipeline(response, output, { signal }).then(resolve, reject);
      },
    );
    request.once("error", reject);
    request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      request.destroy(
        new AgentDesktopImageDownloadError("official Arch image download stalled", true),
      );
    });
  });

/** Waits for one bounded retry backoff while remaining cancellable. */
const retryDelay = (attempt, signal) =>
  new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, attempt * 1_000);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });

/** Downloads and verifies the immutable official Arch source image with resume support. */
export async function downloadPinnedAgentDesktopSource(options) {
  const image = options.image ?? PINNED_ARCH_IMAGE;
  await NodeFSP.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const source = NodePath.join(options.directory, image.fileName);
  const partial = `${source}.partial`;
  const verifyComplete = async (path) => {
    try {
      const stat = await NodeFSP.stat(path);
      if (stat.size !== image.sizeBytes) return false;
      return (await sha256File(path, options.signal)) === image.sha256;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  if (await verifyComplete(source)) {
    options.onStatus?.(`Using cached official Arch image ${image.release}`);
    return source;
  }
  await NodeFSP.rm(source, { force: true });
  if (await verifyComplete(partial)) {
    await NodeFSP.rename(partial, source);
    return source;
  }
  const partialStat = await NodeFSP.stat(partial).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (partialStat !== null && partialStat.size >= image.sizeBytes) {
    await NodeFSP.rm(partial, { force: true });
  }
  options.onStatus?.(`Downloading official Arch image ${image.release}`);
  let completed = false;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_COUNT && !completed; attempt += 1) {
    const offset = (
      await NodeFSP.stat(partial).catch((error) => {
        if (error?.code === "ENOENT") return { size: 0 };
        throw error;
      })
    ).size;
    try {
      await downloadAttempt(image, partial, offset, options.signal, options.onProgress);
      completed = true;
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      const retryable = !(error instanceof AgentDesktopImageDownloadError) || error.retryable;
      if (!retryable || attempt === DOWNLOAD_RETRY_COUNT) throw error;
      await retryDelay(attempt, options.signal);
    }
  }
  if (!(await verifyComplete(partial))) {
    await NodeFSP.rm(partial, { force: true });
    throw new AgentDesktopImageDownloadError(
      `official Arch image failed SHA-256 verification for ${image.sha256}`,
    );
  }
  await NodeFSP.rename(partial, source);
  return source;
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
    "user,id=net0",
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

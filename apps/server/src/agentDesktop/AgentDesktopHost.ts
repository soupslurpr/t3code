// @effect-diagnostics nodeBuiltinImport:off - Probe and repair the local Linux virtualization prerequisites.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import type { AgentDesktopRequirement, AgentDesktopRequirementId } from "@t3tools/contracts";
import type { DesktopImages } from "./MachinePorts.ts";
const run = NodeUtil.promisify(NodeChildProcess.execFile);
const exists = (file: string, mode = NodeFSP.constants.F_OK) =>
  NodeFSP.access(file, mode).then(
    () => true,
    () => false,
  );
const ok = (command: string, args: string[]) =>
  run(command, args, { timeout: 5000, maxBuffer: 16 * 1024 }).then(
    () => true,
    () => false,
  );
const installed = (paths: readonly string[]) =>
  Promise.all(paths.map((x) => exists(x, NodeFSP.constants.X_OK))).then((all) =>
    all.every(Boolean),
  );

export async function hostRequirements(
  images: DesktopImages,
  host: { platform: string; arch: string },
): Promise<AgentDesktopRequirement[]> {
  const arch = await exists("/etc/arch-release");
  const image = await images.current();
  const specs: {
    id: AgentDesktopRequirementId;
    label: string;
    test: Promise<boolean>;
    packages?: string[];
    hint: string;
  }[] = [
    {
      id: "platform",
      label: "Linux x86-64",
      test: Promise.resolve(host.platform === "linux" && host.arch === "x64"),
      hint: "Use an x86-64 Linux host with KVM.",
    },
    {
      id: "hypervisor",
      label: "QEMU",
      test: installed(["/usr/bin/qemu-system-x86_64", "/usr/bin/qemu-img"]),
      packages: ["qemu-system-x86", "qemu-img"],
      hint: "Install QEMU system emulation and qemu-img.",
    },
    {
      id: "hardware-virtualization",
      label: "KVM",
      test: exists("/dev/kvm", NodeFSP.constants.R_OK | NodeFSP.constants.W_OK),
      hint: "Enable hardware virtualization and grant the server account access to /dev/kvm.",
    },
    {
      id: "service-manager",
      label: "systemd user services",
      test: ok("/usr/bin/systemctl", ["--user", "show", "--property=Version", "--value"]),
      hint: "Start a systemd user manager for the server account.",
    },
    {
      id: "network-backend",
      label: "passt",
      test: installed(["/usr/bin/passt", "/usr/bin/pesto"]),
      packages: ["passt"],
      hint: "Install passt with the pesto configuration utility.",
    },
    {
      id: "firmware",
      label: "OVMF UEFI",
      test: Promise.all(
        ["CODE", "VARS"].map((p) => exists("/usr/share/edk2/x64/OVMF_" + p + ".4m.fd")),
      ).then((a) => a.every(Boolean)),
      packages: ["edk2-ovmf"],
      hint: "Install the x86-64 4 MiB OVMF firmware pair.",
    },
    {
      id: "image-builder",
      label: "NoCloud image tools",
      test: installed(["/usr/bin/mformat", "/usr/bin/mcopy"]),
      packages: ["mtools"],
      hint: "Install mtools to build the NoCloud seed.",
    },
    {
      id: "base-image",
      label: "Arch guest image",
      test: exists(image.path),
      hint: "Provision the pinned base image or configure a custom qcow2.",
    },
  ];
  return Promise.all(
    specs.map(async (p) => {
      const ready = await p.test;
      const required = p.id !== "image-builder" || image.managed;
      const remedy: AgentDesktopRequirement["remedy"] =
        p.id === "base-image" && image.managed
          ? { kind: "provision-image", automatic: true, detail: p.hint }
          : arch && p.packages
            ? { kind: "install-packages", automatic: true, packages: p.packages, detail: p.hint }
            : { kind: "manual", automatic: false, detail: p.hint };
      return {
        id: p.id,
        label: p.label,
        required,
        status: ready ? "ready" : "missing",
        ...(!ready ? { remedy, detail: p.hint } : {}),
      };
    }),
  );
}
export async function prepareHost(
  images: DesktopImages,
  host: { platform: string; arch: string },
  ensureBase: () => Promise<void>,
) {
  const initial = await hostRequirements(images, host);
  const packages = [
    ...new Set(
      initial.flatMap((r) =>
        r.required && r.remedy?.kind === "install-packages" ? (r.remedy.packages ?? []) : [],
      ),
    ),
  ];
  if (packages.length)
    await run(
      "/usr/bin/pkexec",
      ["/usr/bin/pacman", "-S", "--needed", "--noconfirm", ...packages],
      { timeout: 15 * 60 * 1000, maxBuffer: 128 * 1024 },
    );
  const requirements = packages.length ? await hostRequirements(images, host) : initial;
  const missing = requirements.find(
    (r) => r.required && r.status !== "ready" && r.id !== "base-image",
  );
  if (missing) throw new Error(missing.detail ?? missing.label);
  const provisioned = requirements.some((r) => r.id === "base-image" && r.status !== "ready");
  await ensureBase();
  return { packages, provisioned };
}

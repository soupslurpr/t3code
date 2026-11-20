// @effect-diagnostics nodeBuiltinImport:off - These paths address private host Unix sockets and QEMU disks.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { MachinePaths } from "./MachinePorts.ts";

export function machinePaths(root: string, id: string): MachinePaths {
  if (!/^agent-[a-f0-9]{32}$/u.test(id)) throw new Error("Invalid Agent desktop id.");
  const directory = NodePath.join(root, "machines", id);
  const runtimeDirectory = NodePath.join(NodeOS.tmpdir(), `t3ad-${id.slice(-16)}`);
  return {
    id,
    directory,
    runtimeDirectory,
    disk: NodePath.join(directory, "disk.qcow2"),
    nvram: NodePath.join(directory, "nvram.qcow2"),
    qmpSocket: NodePath.join(runtimeDirectory, "qmp.sock"),
    qgaSocket: NodePath.join(runtimeDirectory, "qga.sock"),
    vncSocket: NodePath.join(runtimeDirectory, "vnc.sock"),
    passtControlSocket: NodePath.join(runtimeDirectory, "passt-control.sock"),
    captureDirectory: NodePath.join(directory, "captures"),
    unitName: `t3-agent-desktop-${id.slice(6)}`,
  };
}

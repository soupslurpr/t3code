// @effect-diagnostics nodeBuiltinImport:off - Run the packaged guest helper against filesystem fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DesktopTransferManifest } from "@t3tools/contracts";
import {
  extractAgentDesktopBundle,
  MAX_DESKTOP_TRANSFER_BYTES,
  packAgentDesktopBundle,
} from "@t3tools/shared/desktopTransfer";
import { it, expect } from "vite-plus/test";
import { agentDesktopResource } from "./AgentDesktopImage.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const manifest = Schema.decodeSync(Schema.fromJsonString(DesktopTransferManifest));

it.runIf(HostProcess.Platform.defaultValue() === "linux")(
  "round-trips a workspace bundle through the guest helper and rejects an oversized sparse file",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "qga-bundle-"));
    try {
      const script = await agentDesktopResource("guest/transfer.py");
      const guest = async (...args: string[]) =>
        manifest((await exec("python3", ["-B", script, ...args])).stdout);
      const source = NodePath.join(root, "source"),
        target = NodePath.join(root, "guest");
      const archive = NodePath.join(root, "to.bundle"),
        response = NodePath.join(root, "from.bundle");
      await NodeFSP.mkdir(source);
      await NodeFSP.writeFile(NodePath.join(source, "text"), "雪🙂\n");
      await NodeFSP.symlink("text", NodePath.join(source, "link"));
      const packed = await packAgentDesktopBundle({
        sourcePath: source,
        outputPath: archive,
        compression: "gzip",
      });
      const decoded = await guest(
        "extract",
        "--archive",
        archive,
        "--destination",
        target,
        "--collision",
        "create",
        "--compression",
        "gzip",
        "--sha256",
        packed.sha256,
      );
      expect(decoded).toEqual(packed);
      const result = await guest(
        "pack",
        "--source",
        target,
        "--output",
        response,
        "--compression",
        "gzip",
      );
      expect(result).toMatchObject({
        logicalBytes: packed.logicalBytes,
        symlinkCount: 1,
        fileCount: 1,
      });
      const destination = NodePath.join(root, "restored");
      await extractAgentDesktopBundle({
        archivePath: response,
        destinationPath: destination,
        compression: result.compression,
      });
      expect(await NodeFSP.readlink(NodePath.join(destination, "link"))).toBe("text");
      expect(await NodeFSP.readFile(NodePath.join(destination, "link"), "utf8")).toBe("雪🙂\n");
      await NodeFSP.truncate(NodePath.join(target, "text"), MAX_DESKTOP_TRANSFER_BYTES + 1);
      await expect(
        guest("pack", "--source", target, "--output", response + ".huge", "--compression", "none"),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("resource-exhausted") });
      expect((await NodeFSP.readdir(root)).some((name) => name.includes(".huge"))).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

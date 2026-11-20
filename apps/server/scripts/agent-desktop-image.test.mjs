import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  AgentDesktopImageDownloadError,
  downloadPinnedAgentDesktopSource,
  pinnedImageDownloadPlan,
} from "../resources/agent-desktop/image-download.mjs";

it("resumes only the exact requested range and replaces a partial when the mirror sends the full image", () => {
  expect(
    pinnedImageDownloadPlan(
      206,
      { "content-length": "60", "content-range": "bytes 40-99/100" },
      40,
      100,
    ),
  ).toEqual({ append: true, initialBytes: 40 });
  expect(pinnedImageDownloadPlan(200, { "content-length": "100" }, 40, 100)).toEqual({
    append: false,
    initialBytes: 0,
  });
  expect(() =>
    pinnedImageDownloadPlan(
      206,
      { "content-length": "60", "content-range": "bytes 0-59/100" },
      40,
      100,
    ),
  ).toThrow(AgentDesktopImageDownloadError);
  expect(() => pinnedImageDownloadPlan(200, { "content-length": "99" }, 0, 100)).toThrow(
    /size mismatch/u,
  );
});

it("replaces a same-size corrupt cache entry with a checksum-verified complete partial", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "arch-download-"));
  const fileName = "image.qcow2";
  const good = Buffer.from("verified");
  const image = {
    fileName,
    release: "fixture",
    sizeBytes: good.length,
    sha256: NodeCrypto.createHash("sha256").update(good).digest("hex"),
  };
  const output = NodePath.join(directory, fileName);
  try {
    await NodeFSP.writeFile(output, Buffer.alloc(good.length));
    await NodeFSP.writeFile(output + ".partial", good);
    expect(await downloadPinnedAgentDesktopSource({ directory, image })).toBe(output);
    expect(await NodeFSP.readFile(output)).toEqual(good);
    expect(await NodeFSP.readdir(directory)).toEqual([fileName]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

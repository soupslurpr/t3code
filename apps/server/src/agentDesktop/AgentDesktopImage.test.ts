// @effect-diagnostics nodeBuiltinImport:off - Exercise publication on a private filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it, vi } from "vite-plus/test";
import { makeDesktopImages } from "./AgentDesktopImage.ts";

it("atomically selects a complete build, coalesces provisioning and retains referenced generations", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-images-"));
  const build = vi.fn(async (file: string) => {
    await NodeFSP.writeFile(file, "image");
    return { profileVersion: "arch-gnome-v1", sourceRelease: "fixture" };
  });
  try {
    const images = makeDesktopImages(root, undefined, build);
    const [one, alsoOne] = await Promise.all([images.ensure(), images.ensure()]);
    expect(one).toEqual(alsoOne);
    expect(build).toHaveBeenCalledTimes(1);
    const two = await images.refresh();
    const three = await images.refresh();
    const four = await images.refresh();
    expect((await NodeFSP.stat(four.path)).mode & 0o222).toBe(0);
    build.mockImplementationOnce(async (file) => {
      await NodeFSP.writeFile(file, "unfinished");
      throw new Error("interrupted");
    });
    await expect(images.refresh()).rejects.toThrow("interrupted");
    expect(await images.current()).toEqual(four);
    await Promise.all(
      [one, two, three, four].map((image, index) =>
        NodeFSP.utimes(image.path, index + 1, index + 1),
      ),
    );
    await images.prune(new Set([one.generation!]));
    expect(await NodeFSP.readdir(NodePath.dirname(one.path))).toEqual(
      expect.arrayContaining([one, three, four].map((i) => NodePath.basename(i.path))),
    );
    await expect(NodeFSP.access(two.path)).rejects.toMatchObject({ code: "ENOENT" });
    const custom = makeDesktopImages(root, one.path, build);
    expect((await custom.ensure()).generation).toBeNull();
    await expect(custom.refresh()).rejects.toThrow("caller-managed");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("opens an existing pre-manifest base without rebuilding and fails closed on a broken selection", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-legacy-image-"));
  try {
    const base = NodePath.join(root, "base");
    await NodeFSP.mkdir(base);
    await NodeFSP.writeFile(NodePath.join(base, "agent-desktop.qcow2"), "legacy");
    const images = makeDesktopImages(root);
    expect((await images.ensure()).path).toBe(NodePath.join(base, "agent-desktop.qcow2"));
    await NodeFSP.writeFile(NodePath.join(base, "current.json"), "{}");
    await expect(images.ensure()).rejects.toThrow();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

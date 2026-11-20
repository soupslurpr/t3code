// @effect-diagnostics nodeBuiltinImport:off -- Real independent inventory instances are opened under a disposable local directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { Admission, GIB } from "./Admission.ts";
import { Inventory } from "./Inventory.ts";

it.each(["memory", "cpu", "disk"] as const)(
  "atomically reserves %s before concurrent starts can use the same capacity",
  async (limit) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-admission-"));
    try {
      const inventory = new Inventory(directory);
      const capacity = async () => ({
        cpu: limit === "cpu" ? 2 : 32,
        totalMemory: 16 * GIB,
        freeMemory: (limit === "memory" ? 8 : 16) * GIB,
        totalDisk: 100 * GIB,
        freeDisk: (limit === "disk" ? 10 : 64) * GIB,
      });
      const admission = new Admission(
        inventory,
        { usage: async () => ({ memory: 0, cpu: 0 }) },
        capacity,
      );
      const fixed = { cpuCount: 2, memoryBytes: 4 * GIB, diskVirtualBytes: 64 * GIB, audio: false };
      const make = (id: string) =>
        admission.vm(id, { expectedTemporaryDiskBytes: 4 * GIB }, false, fixed);
      const results = await Promise.allSettled([make("first"), make("second")]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
      const [first] = results;
      if (first.status === "fulfilled") first.value.release();
      const admitted = await make("second");
      expect(admitted.resources).toEqual(fixed);
      admitted.release();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

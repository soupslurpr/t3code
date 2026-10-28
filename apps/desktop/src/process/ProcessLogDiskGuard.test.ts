import { describe, expect, it } from "vite-plus/test";

import { ProcessLogDiskGuard } from "./ProcessLogDiskGuard.ts";

const reserve = 512 * 1024 * 1024;
const mib = 1024 * 1024;

describe("process log disk guard", () => {
  it("accounts for a pending write before admitting another stream near the reserve", async () => {
    let available = reserve + 3;
    const guard = new ProcessLogDiskGuard(
      async () => available,
      () => 0,
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const saved: string[] = [];
    const first = guard.write(2, async () => {
      entered.resolve();
      await release.promise;
      available -= 2;
      saved.push("ab");
    });
    await entered.promise;
    const second = guard.write(2, async () => {
      available -= 2;
      saved.push("cd");
    });
    release.resolve();
    await first;
    await expect(second).rejects.toThrow("512 MiB");
    expect(saved).toEqual(["ab"]);
    expect(available).toBe(reserve + 1);
  });

  it("rechecks available space after other writers consume it", async () => {
    let available = reserve + 100 * mib;
    let now = 0;
    const guard = new ProcessLogDiskGuard(
      async () => available,
      () => now,
    );
    const write = (size: number) =>
      guard.write(size, async () => {
        available -= size;
      });
    await write(8 * mib);
    available = reserve - 1;
    await expect(write(1)).rejects.toThrow("incomplete");
    expect(available).toBe(reserve - 1);

    available = reserve + 100 * mib;
    await write(1);
    available = reserve - 1;
    now = 1000;
    await expect(write(1)).rejects.toThrow("incomplete");
    expect(available).toBe(reserve - 1);
  });

  it("allows a large write when space is available and avoids checks for every small chunk", async () => {
    let available = reserve + 100 * mib;
    let checks = 0;
    const guard = new ProcessLogDiskGuard(
      async () => {
        checks++;
        return available;
      },
      () => 0,
    );
    const write = (size: number) =>
      guard.write(size, async () => {
        available -= size;
      });
    await write(16 * mib);
    await Promise.all(Array.from({ length: 100 }, () => write(1024)));
    expect(available).toBe(reserve + 84 * mib - 100 * 1024);
    expect(checks).toBeLessThanOrEqual(2);
  });

  it("reports inspection failures and lets later commands retry after storage recovers", async () => {
    let unavailable = true;
    const guard = new ProcessLogDiskGuard(
      async () => {
        if (unavailable) throw new Error("filesystem unavailable");
        return reserve + mib;
      },
      () => 0,
    );
    let saved = 0;
    const write = () =>
      guard.write(1, async () => {
        saved++;
      });
    await expect(write()).rejects.toThrow("cannot check free disk space (filesystem unavailable)");
    expect(saved).toBe(0);
    unavailable = false;
    await write();
    expect(saved).toBe(1);
  });
});

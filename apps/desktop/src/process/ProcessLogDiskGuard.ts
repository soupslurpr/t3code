const RESERVE_BYTES = 512 * 1024 * 1024;
const CHECK_AFTER_BYTES = 8 * 1024 * 1024;
const CHECK_AFTER_MS = 1000;

/** Shares disk accounting across command logs without a filesystem query per chunk. */
export class ProcessLogDiskGuard {
  private readonly availableBytes: () => Promise<number>;
  private readonly now: () => number;
  private pending = Promise.resolve();
  private checkedAt = -Infinity;
  private remainingBytes = 0;
  private bytesSinceCheck = 0;

  constructor(availableBytes: () => Promise<number>, now: () => number) {
    this.availableBytes = availableBytes;
    this.now = now;
  }

  /** Serialize checks and writes so concurrent streams cannot spend the same free space. */
  write(byteLength: number, write: () => Promise<void>): Promise<void> {
    if (byteLength === 0) return write();
    const pending = this.pending.then(async () => {
      const now = this.now();
      if (
        now < this.checkedAt ||
        now - this.checkedAt >= CHECK_AFTER_MS ||
        this.bytesSinceCheck + byteLength > CHECK_AFTER_BYTES ||
        byteLength > this.remainingBytes
      ) {
        try {
          const available = await this.availableBytes();
          if (!Number.isFinite(available) || available < 0) {
            throw new Error("filesystem returned an invalid free-space value");
          }
          this.remainingBytes = available - RESERVE_BYTES;
          this.bytesSinceCheck = 0;
          this.checkedAt = this.now();
        } catch (cause) {
          throw new Error(
            `Output capture stopped: cannot check free disk space (${cause instanceof Error ? cause.message : String(cause)}). Saved output is incomplete.`,
            { cause },
          );
        }
      }
      if (byteLength > this.remainingBytes) {
        throw new Error(
          "Output capture stopped to keep 512 MiB of disk space free. Saved output is incomplete.",
        );
      }
      this.remainingBytes -= byteLength;
      this.bytesSinceCheck += byteLength;
      await write();
    });
    // A failed log must not block writes from other commands after space is freed.
    this.pending = pending.catch(() => {
      this.checkedAt = -Infinity;
      this.remainingBytes = 0;
    });
    return pending;
  }
}

// @effect-diagnostics nodeBuiltinImport:off - The local child streams into positioned files with native backpressure.
import * as NodeFSP from "node:fs/promises";
import * as NodeStream from "node:stream";
import type { DesktopProcessOutput } from "@t3tools/contracts";
import { DesktopJobError } from "./request.ts";
import type { ProcessLogDiskGuard } from "./disk.ts";

async function readFully(handle: NodeFSP.FileHandle, buffer: Buffer, position: number) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (!bytesRead)
      throw new DesktopJobError({
        code: "output-unavailable",
        message: "The retained output file is incomplete.",
      });
    offset += bytesRead;
  }
}

/** Captures one stream with backpressure and byte-addressable reads. */
export class ProcessLog {
  totalBytes = 0;
  storedBytes = 0;
  error: string | null = null;

  readonly path: string;
  private readonly handle: NodeFSP.FileHandle;
  private readonly prefixLimit: number;
  private readonly tailLimit: number;
  private prefixBytes = 0;
  private tail: Buffer | null = Buffer.alloc(0);
  private tailBytes = 0;
  private tailStart = 0;
  private readonly notify: () => void;
  private readonly diskGuard: ProcessLogDiskGuard;
  private closing: Promise<void> | undefined;

  constructor(
    path: string,
    handle: NodeFSP.FileHandle,
    limit: number,
    notify: () => void,
    diskGuard: ProcessLogDiskGuard,
  ) {
    this.path = path;
    this.handle = handle;
    this.tailLimit = Number.isFinite(limit) ? Math.min(64 * 1024, Math.floor(limit / 4)) : 0;
    this.prefixLimit = limit - this.tailLimit;
    this.notify = notify;
    this.diskGuard = diskGuard;
  }

  async append(bytes: Buffer): Promise<void> {
    if (this.error === null) {
      try {
        const prefix = bytes.subarray(0, Math.max(0, this.prefixLimit - this.prefixBytes));
        const write = async (data: Buffer, position: number) => {
          let offset = 0;
          while (offset < data.length) {
            const { bytesWritten } = await this.handle.write(
              data,
              offset,
              data.length - offset,
              position + offset,
            );
            if (bytesWritten === 0) throw new Error("output file accepted no bytes");
            offset += bytesWritten;
          }
        };
        const remainder = bytes.subarray(prefix.length);
        const tail =
          this.tailLimit === 0
            ? Buffer.alloc(0)
            : Buffer.from(
                Buffer.concat([this.tail ?? Buffer.alloc(0), remainder]).subarray(-this.tailLimit),
              );
        await this.diskGuard.write(prefix.length + tail.length, async () => {
          await write(prefix, this.prefixBytes);
          if (tail.length > 0) await write(tail, this.prefixLimit);
        });
        // Publish a coherent prefix/tail snapshot only after the file writes.
        // Readers use the immutable tail buffer while a later append overwrites it.
        this.prefixBytes += prefix.length;
        this.tail = tail;
        this.tailBytes = tail.length;
        this.tailStart = this.totalBytes + bytes.length - this.tailBytes;
        this.storedBytes = this.prefixBytes + this.tailBytes;
      } catch (cause) {
        this.error = cause instanceof Error ? cause.message : "output capture failed";
      }
    }
    this.totalBytes += bytes.length;
    this.notify();
  }

  sink(): NodeStream.Writable {
    return new NodeStream.Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        void this.append(chunk).then(() => callback(), callback);
      },
    });
  }

  async read(
    offset: number,
    maxBytes: number,
    encoding: "utf8" | "base64",
    complete: boolean,
  ): Promise<DesktopProcessOutput> {
    const { storedBytes, totalBytes, prefixBytes, tailBytes, tail } = this;
    if (offset > totalBytes)
      throw new DesktopJobError({
        code: "invalid-offset",
        message: "output offset exceeds total output",
      });
    const tailOffset = this.tailStart;
    const retainedEnd = tailBytes > 0 ? tailOffset + tailBytes : prefixBytes;
    if (offset >= prefixBytes) offset = Math.max(offset, tailOffset);
    const end = offset < prefixBytes && tailOffset > prefixBytes ? prefixBytes : retainedEnd;
    const count = Math.max(0, Math.min(maxBytes, end - offset));
    const prefixLength = Math.min(count, Math.max(0, prefixBytes - offset));
    const prefix = Buffer.alloc(prefixLength);
    const tailLength = count - prefixLength;
    const tailPosition = Math.max(0, offset + prefixLength - tailOffset);
    const suffix =
      tail === null
        ? Buffer.alloc(tailLength)
        : tail.subarray(tailPosition, tailPosition + tailLength);
    if (prefix.length || (tail === null && suffix.length)) {
      // Finishing the process can close its writer between two partial reads.
      const handle = await NodeFSP.open(this.path, "r");
      try {
        await readFully(handle, prefix, offset);
        if (tail === null) await readFully(handle, suffix, prefixBytes + tailPosition);
      } finally {
        await handle.close();
      }
    }
    let bytes = Buffer.concat([prefix, suffix]);
    // Never strand the cursor on a codepoint cut by retention. Within a
    // contiguous range, incomplete UTF-8 remains for the next page.
    if (
      encoding === "utf8" &&
      (offset + bytes.length < end || (!complete && end === totalBytes && this.error === null))
    ) {
      let boundary = bytes.length - 1;
      while (boundary >= 0 && (bytes[boundary]! & 0xc0) === 0x80) boundary--;
      if (boundary >= 0) {
        const lead = bytes[boundary]!;
        const length =
          lead >= 0xf0 && lead <= 0xf4
            ? 4
            : lead >= 0xe0 && lead <= 0xef
              ? 3
              : lead >= 0xc2 && lead <= 0xdf
                ? 2
                : 1;
        if (boundary + length > bytes.length) bytes = bytes.subarray(0, boundary);
      }
    }
    let invalidUtf8 = false;
    if (encoding === "utf8") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        invalidUtf8 = true;
      }
    }
    return {
      data: bytes.toString(encoding === "base64" ? "base64" : "utf8"),
      encoding,
      offset,
      nextOffset: offset + bytes.length,
      totalBytes,
      storedBytes,
      tailOffset,
      retainedEnd,
      truncated: totalBytes > storedBytes,
      invalidUtf8,
    };
  }

  close(): Promise<void> {
    return (this.closing ??= this.handle.close().then(() => {
      if (this.error === null) this.tail = null;
    }));
  }
}

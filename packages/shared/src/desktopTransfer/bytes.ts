// @effect-diagnostics nodeBuiltinImport:off - The transfer codec measures streaming input and output.
import * as NodeStream from "node:stream";
import { DesktopTransferError } from "./errors.ts";

export const MAX_DESKTOP_TRANSFER_BYTES = 1024 ** 3;

export function transferByteLimit(requested = MAX_DESKTOP_TRANSFER_BYTES): number {
  if (!Number.isSafeInteger(requested) || requested < 0)
    throw new DesktopTransferError({
      code: "resource-exhausted",
      message: "Invalid transfer byte limit.",
    });
  return Math.min(requested, MAX_DESKTOP_TRANSFER_BYTES);
}

export function checkBytes(bytes: number, limit: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit)
    throw new DesktopTransferError({
      code: "resource-exhausted",
      message: "Transfer exceeds its byte limit.",
    });
}

export function integrity(message: string): DesktopTransferError {
  return new DesktopTransferError({ code: "integrity-failed", message });
}

export function boundedBytes(limit: number, expected?: number): NodeStream.Transform {
  let bytes = 0;
  return new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (expected !== undefined && bytes > expected) {
        callback(integrity("Archive exceeds its advertised size."));
      } else if (bytes > limit) {
        callback(
          new DesktopTransferError({
            code: "resource-exhausted",
            message: "Transfer exceeds its byte limit.",
          }),
        );
      } else {
        callback(null, chunk);
      }
    },
    flush(callback) {
      callback(
        expected !== undefined && bytes !== expected
          ? integrity("Archive size differs from its manifest.")
          : null,
      );
    },
  });
}

/** Verifies streaming WebM finalization against fixed EBML layouts. */

import { describe, expect, it, vi } from "vite-plus/test";

import { withBrowserRecordingDuration } from "./browserRecordingDuration";

/** Decodes readable, deterministic binary fixtures. */
function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.split(/\s+/).filter(Boolean), (byte) => Number.parseInt(byte, 16));
}

const STREAM_HEADER = bytes("1a 45 df a3 80 18 53 80 67 01 ff ff ff ff ff ff ff");
const CLUSTER = bytes("16 54 ae 6b 80 1f 43 b6 75 ff e7 81 00 a3 84 81 00 00 80");

/** Builds a stream with explicit metadata and an unchanged encoded block. */
function stream(info: Uint8Array<ArrayBuffer>, tail: BlobPart = CLUSTER): Blob {
  return new Blob([STREAM_HEADER, bytes("15 49 a9 66"), info, tail], {
    type: "video/webm;codecs=av01",
  });
}

/** Returns the complete bytes of a small test artifact. */
async function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("withBrowserRecordingDuration", () => {
  it("adds a big-endian duration without changing encoded blocks", async () => {
    const blob = stream(bytes("87 2a d7 b1 83 0f 42 40"));
    const result = await withBrowserRecordingDuration(blob, 1_500);

    expect(result.type).toBe(blob.type);
    expect(await readBytes(result)).toEqual(
      await readBytes(stream(bytes("92 2a d7 b1 83 0f 42 40 44 89 88 40 97 70 00 00 00 00 00"))),
    );
  });

  it.each([
    ["80", "40 97 70 00 00 00 00 00"],
    ["84 2a d7 b1 80", "40 97 70 00 00 00 00 00"],
    ["87 2a d7 b1 83 1e 84 80", "40 87 70 00 00 00 00 00"],
  ])("uses declared or default timestamp units for %s", async (metadata, duration) => {
    const result = await readBytes(
      await withBrowserRecordingDuration(stream(bytes(metadata)), 1_500),
    );
    expect(
      result.subarray(result.length - CLUSTER.length - 11, result.length - CLUSTER.length),
    ).toEqual(bytes(`44 89 88 ${duration}`));
  });

  it("widens the Info size before its reserved unknown-size value", async () => {
    const info = new Uint8Array(117);
    info.set(bytes("f4 ec f2"));
    const result = await readBytes(await withBrowserRecordingDuration(stream(info), 1_500));
    expect(result.subarray(STREAM_HEADER.length + 4, STREAM_HEADER.length + 6)).toEqual(
      bytes("40 7f"),
    );
    expect(result.subarray(result.length - CLUSTER.length)).toEqual(CLUSTER);
  });

  it("skips large blocks and handles headers crossing the read buffer", async () => {
    const block = new Uint8Array(65_503);
    block.set(bytes("a3 20 ff db"));
    const tail = new Blob([bytes("1f 43 b6 75 ff"), block, bytes("1f 43 b6 75 83 e7 81 01")]);
    const blob = stream(bytes("80"), tail);
    const fullRead = vi.spyOn(blob, "arrayBuffer");
    const result = await withBrowserRecordingDuration(blob, 1_500);
    expect(fullRead).not.toHaveBeenCalled();
    expect(result.size).toBe(blob.size + 11);
    expect(await readBytes(result.slice(-tail.size))).toEqual(await readBytes(tail));
  });

  it.each([
    ["existing duration", "8b 44 89 88 40 59 00 00 00 00 00 00"],
    ["metadata checksum", "86 bf 84 00 00 00 00"],
    ["zero timestamp scale", "85 2a d7 b1 81 00"],
    ["duplicate timestamp scale", "88 2a d7 b1 80 2a d7 b1 80"],
    ["unknown metadata size", "ff"],
    ["truncated metadata", "fe"],
    ["invalid element header", "81 00"],
  ])("preserves streams with %s", async (_name, info) => {
    const blob = stream(bytes(info));
    expect(await withBrowserRecordingDuration(blob, 1_500)).toBe(blob);
  });

  it.each([
    ["seek index", "11 4d 9b 74 80"],
    ["cues", "1c 53 bb 6b 80"],
    ["absolute cluster position", "1f 43 b6 75 ff a7 81 00"],
    ["truncated block", "1f 43 b6 75 ff a3 fe"],
    ["unknown block size", "1f 43 b6 75 ff a3 ff"],
    ["second segment", "18 53 80 67 ff"],
  ])("preserves offsets in streams containing %s", async (_name, suffix) => {
    const blob = stream(bytes("80"), new Blob([CLUSTER, bytes(suffix)]));
    expect(await withBrowserRecordingDuration(blob, 1_500)).toBe(blob);
  });

  it("preserves segment checksums", async () => {
    const blob = stream(bytes("80"), new Blob([bytes("bf 84 00 00 00 00"), CLUSTER]));
    expect(await withBrowserRecordingDuration(blob, 1_500)).toBe(blob);
  });

  it.each([0, -1, Infinity, NaN])(
    "preserves recordings with unusable duration %s",
    async (duration) => {
      const blob = stream(bytes("80"));
      expect(await withBrowserRecordingDuration(blob, duration)).toBe(blob);
    },
  );

  it("preserves other formats and already finalized segments", async () => {
    const blobs = [
      new Blob(["mp4 content"], { type: "video/mp4" }),
      new Blob(["invalid webm"], { type: "video/webm" }),
      new Blob([], { type: "video/webm" }),
      new Blob([bytes("1a 45 df a3 80 18 53 80 67 85 15 49 a9 66 80")], { type: "video/webm" }),
    ];
    for (const blob of blobs) expect(await withBrowserRecordingDuration(blob, 1_500)).toBe(blob);
  });
});

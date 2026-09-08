/** Adds duration metadata to unindexed WebM streams produced by MediaRecorder. */

const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const TRACKS_ID = 0x1654ae6b;
const CLUSTER_ID = 0x1f43b675;
const TIMESTAMP_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
const CRC_ID = 0xbf;
const VOID_ID = 0xec;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const DEFAULT_TIMESTAMP_SCALE = NANOSECONDS_PER_MILLISECOND;
const HEADER_BUFFER_BYTES = 64 * 1_024;
const MAX_ELEMENT_ID_BYTES = 4;
const MAX_ELEMENT_SIZE_BYTES = 8;
const MAX_ELEMENT_HEADER_BYTES = MAX_ELEMENT_ID_BYTES + MAX_ELEMENT_SIZE_BYTES;
const DURATION_HEADER = new Uint8Array([0x44, 0x89, 0x88]);
const CLUSTER_CHILD_IDS = new Set([
  0xe7, // Timestamp
  0xa3, // SimpleBlock
  0xa0, // BlockGroup
  0x5854, // SilentTracks
  0xab, // PrevSize
  CRC_ID,
  VOID_ID,
]);

interface ElementHeader {
  readonly id: number;
  readonly sizeOffset: number;
  readonly dataOffset: number;
  readonly end: number | null;
}

/** Decodes a bounded EBML header, retaining unknown sizes without numeric overflow. */
function readElementHeader(bytes: Uint8Array, offset: number): ElementHeader | null {
  const idWidth = 8 - Math.floor(Math.log2(bytes[0] ?? 0));
  if (idWidth < 1 || idWidth > MAX_ELEMENT_ID_BYTES || bytes.length <= idWidth) return null;
  let id = 0;
  for (const byte of bytes.subarray(0, idWidth)) id = id * 256 + byte;
  const firstSizeByte = bytes[idWidth]!;
  const sizeWidth = 8 - Math.floor(Math.log2(firstSizeByte));
  if (sizeWidth < 1 || sizeWidth > MAX_ELEMENT_SIZE_BYTES || bytes.length < idWidth + sizeWidth)
    return null;
  const sizeMask = (1 << (8 - sizeWidth)) - 1;
  let size = firstSizeByte & sizeMask;
  let unknownSize = size === sizeMask;
  for (const byte of bytes.subarray(idWidth + 1, idWidth + sizeWidth)) {
    size = size * 256 + byte;
    unknownSize &&= byte === 0xff;
  }
  const dataOffset = offset + idWidth + sizeWidth;
  const end = unknownSize ? null : dataOffset + size;
  if (end !== null && !Number.isSafeInteger(end)) return null;
  return { id, sizeOffset: offset + idWidth, dataOffset, end };
}

/** Reads element headers while skipping encoded frames and bounding temporary memory. */
function createHeaderReader(blob: Blob) {
  let buffer = new Uint8Array();
  let bufferOffset = 0;
  return async (offset: number): Promise<ElementHeader | null> => {
    const requiredEnd = Math.min(blob.size, offset + MAX_ELEMENT_HEADER_BYTES);
    if (offset < bufferOffset || requiredEnd > bufferOffset + buffer.length) {
      buffer = new Uint8Array(await blob.slice(offset, offset + HEADER_BUFFER_BYTES).arrayBuffer());
      bufferOffset = offset;
    }
    const element = readElementHeader(buffer.subarray(offset - bufferOffset), offset);
    return element && (element.end === null || element.end <= blob.size) ? element : null;
  };
}

/** Rejects indexes and absolute cluster positions that would need offset rewriting. */
async function hasUnindexedClusters(
  readHeader: ReturnType<typeof createHeaderReader>,
  offset: number,
  end: number,
): Promise<boolean> {
  let hasCluster = false;
  while (offset < end) {
    const element = await readHeader(offset);
    if (!element) return false;
    if (element.id === TRACKS_ID || element.id === VOID_ID) {
      if (element.end === null) return false;
      offset = element.end;
      continue;
    }
    if (element.id !== CLUSTER_ID) return false;
    hasCluster = true;
    offset = element.dataOffset;
    const clusterEnd = element.end ?? end;
    while (offset < clusterEnd) {
      const child = await readHeader(offset);
      if (!child) return false;
      if (!CLUSTER_CHILD_IDS.has(child.id)) {
        if (element.end !== null) return false;
        break;
      }
      if (child.end === null || child.end > clusterEnd) return false;
      offset = child.end;
    }
  }
  return hasCluster;
}

/** Reads timestamp units only from metadata that can be extended without invalidating a CRC. */
function readTimestampScale(bytes: Uint8Array): number | null {
  let scale = DEFAULT_TIMESTAMP_SCALE;
  let hasScale = false;
  for (let offset = 0; offset < bytes.length;) {
    const child = readElementHeader(bytes.subarray(offset), offset);
    if (!child || child.end === null || child.end > bytes.length) return null;
    if (child.id === DURATION_ID || child.id === CRC_ID) return null;
    if (child.id === TIMESTAMP_SCALE_ID) {
      if (hasScale || child.end - child.dataOffset > 8) return null;
      hasScale = true;
      if (child.end > child.dataOffset) {
        scale = 0;
        for (const byte of bytes.subarray(child.dataOffset, child.end)) scale = scale * 256 + byte;
        if (!Number.isSafeInteger(scale) || scale <= 0) return null;
      }
    }
    offset = child.end;
  }
  return scale;
}

/** Encodes a known EBML size, widening before reaching the reserved unknown-size value. */
function encodeSize(size: number): Uint8Array<ArrayBuffer> {
  let width = 1;
  while (size >= 2 ** (7 * width) - 1) width += 1;
  const bytes = new Uint8Array(width);
  for (let offset = width - 1; offset >= 0; offset -= 1) {
    bytes[offset] = size % 256;
    size = Math.floor(size / 256);
  }
  bytes[0] = bytes[0]! | (1 << (8 - width));
  return bytes;
}

/** Finalizes streaming WebM metadata without re-encoding or copying the recording payload. */
export async function withBrowserRecordingDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (
    blob.type.split(";", 1)[0] !== "video/webm" ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return blob;
  }
  const readHeader = createHeaderReader(blob);
  const header = await readHeader(0);
  if (header?.id !== EBML_ID || header.end === null) return blob;
  const segment = await readHeader(header.end);
  if (segment?.id !== SEGMENT_ID || segment.end !== null) return blob;
  const info = await readHeader(segment.dataOffset);
  if (
    info?.id !== INFO_ID ||
    info.end === null ||
    info.end - info.dataOffset > HEADER_BUFFER_BYTES
  ) {
    return blob;
  }
  const metadata = new Uint8Array(await blob.slice(info.dataOffset, info.end).arrayBuffer());
  const scale = readTimestampScale(metadata);
  if (scale === null || !(await hasUnindexedClusters(readHeader, info.end, blob.size))) return blob;
  const durationTicks = durationMs * (NANOSECONDS_PER_MILLISECOND / scale);
  if (!Number.isFinite(durationTicks) || durationTicks <= 0) return blob;

  const duration = new Uint8Array(DURATION_HEADER.length + Float64Array.BYTES_PER_ELEMENT);
  duration.set(DURATION_HEADER);
  new DataView(duration.buffer).setFloat64(DURATION_HEADER.length, durationTicks);
  return new Blob(
    [
      blob.slice(0, info.sizeOffset),
      encodeSize(metadata.length + duration.length),
      blob.slice(info.dataOffset, info.end),
      duration,
      blob.slice(info.end),
    ],
    { type: blob.type },
  );
}

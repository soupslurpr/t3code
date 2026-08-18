/** Captures raw frames from QEMU's private VNC listener without external libraries. */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeNet from "node:net";

const PROTOCOL_VERSION_BYTES = 12;
const PIXEL_BYTES = 4;
const MAX_DIMENSION = 16_384;
const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const MAX_SERVER_NAME_BYTES = 4_096;
const MAX_SERVER_MESSAGE_BYTES = 64 * 1024;
const CAPTURE_TIMEOUT_MS = 10_000;
const SECURITY_TYPE_NONE = 1;
const SERVER_FRAMEBUFFER_UPDATE = 0;
const SERVER_SET_COLOR_MAP = 1;
const SERVER_BELL = 2;
const SERVER_CUT_TEXT = 3;
const ENCODING_RAW = 0;

/** Reports a bounded private-VNC negotiation or frame failure. */
export class QemuVncError extends Schema.TaggedErrorClass<QemuVncError>()("QemuVncError", {
  code: Schema.Literals([
    "connection-failed",
    "timed-out",
    "unsupported-server",
    "invalid-frame",
    "cancelled",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
const isQemuVncError = Schema.is(QemuVncError);

/** Contains one full frame in Electron's native BGRA bitmap layout. */
export interface QemuVncFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

interface PendingRead {
  readonly size: number;
  readonly resolve: (value: Buffer) => void;
  readonly reject: (cause: Error) => void;
}

/** Buffers a socket until exact protocol fields can be consumed. */
class SocketReader {
  private readonly buffers: Buffer[] = [];
  private bufferedBytes = 0;
  private headOffset = 0;
  private readonly pending: PendingRead[] = [];
  private failure: Error | undefined;

  constructor(socket: NodeNet.Socket) {
    socket.on("data", (chunk) => {
      this.buffers.push(chunk);
      this.bufferedBytes += chunk.byteLength;
      this.drain();
    });
    socket.on("error", (cause) => this.fail(cause));
    socket.on("close", () => this.fail(new Error("VNC socket closed before returning a frame")));
  }

  /** Reads exactly the requested number of bytes. */
  read(size: number): Promise<Buffer> {
    if (!Number.isInteger(size) || size < 0 || size > MAX_FRAME_BYTES) {
      return Promise.reject(new Error(`invalid VNC read size ${size}`));
    }
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.bufferedBytes >= size) return Promise.resolve(this.take(size));
    return new Promise((resolve, reject) => {
      this.pending.push({ size, resolve, reject });
      this.drain();
    });
  }

  private take(size: number): Buffer {
    if (size === 0) return Buffer.alloc(0);
    const first = this.buffers[0]!;
    const firstBytes = first.byteLength - this.headOffset;
    if (firstBytes >= size) {
      const value = first.subarray(this.headOffset, this.headOffset + size);
      this.headOffset += size;
      this.bufferedBytes -= size;
      if (this.headOffset === first.byteLength) {
        this.buffers.shift();
        this.headOffset = 0;
      }
      return value;
    }
    const value = Buffer.allocUnsafe(size);
    let destinationOffset = 0;
    while (destinationOffset < size) {
      const buffer = this.buffers[0]!;
      const copied = Math.min(size - destinationOffset, buffer.byteLength - this.headOffset);
      buffer.copy(value, destinationOffset, this.headOffset, this.headOffset + copied);
      destinationOffset += copied;
      this.headOffset += copied;
      if (this.headOffset === buffer.byteLength) {
        this.buffers.shift();
        this.headOffset = 0;
      }
    }
    this.bufferedBytes -= size;
    return value;
  }

  private drain(): void {
    while (this.pending.length > 0 && this.bufferedBytes >= this.pending[0]!.size) {
      const pending = this.pending.shift()!;
      pending.resolve(this.take(pending.size));
    }
  }

  private fail(cause: Error): void {
    if (this.failure !== undefined) return;
    this.failure = cause;
    for (const pending of this.pending.splice(0)) pending.reject(cause);
  }
}

const invalidFrame = (detail: string): QemuVncError =>
  new QemuVncError({ code: "invalid-frame", detail });

const validateFrameSize = (width: number, height: number): number => {
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw invalidFrame(`VNC returned invalid frame dimensions ${width}x${height}`);
  }
  const bytes = width * height * PIXEL_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_FRAME_BYTES) {
    throw invalidFrame(`VNC frame exceeded ${MAX_FRAME_BYTES} bytes`);
  }
  return bytes;
};

const writePixelFormat = (socket: NodeNet.Socket): void => {
  socket.write(Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]));
};

const writeRawEncoding = (socket: NodeNet.Socket): void => {
  const message = Buffer.alloc(8);
  message[0] = 2;
  message.writeUInt16BE(1, 2);
  message.writeInt32BE(ENCODING_RAW, 4);
  socket.write(message);
};

const writeFullFrameRequest = (socket: NodeNet.Socket, width: number, height: number): void => {
  const message = Buffer.alloc(10);
  message[0] = 3;
  message.writeUInt16BE(width, 6);
  message.writeUInt16BE(height, 8);
  socket.write(message);
};

const readFailureReason = async (reader: SocketReader): Promise<string> => {
  const length = (await reader.read(4)).readUInt32BE();
  if (length > MAX_SERVER_MESSAGE_BYTES) return "VNC server returned an oversized failure";
  return (await reader.read(length)).toString("utf8");
};

const negotiate = async (
  socket: NodeNet.Socket,
  reader: SocketReader,
): Promise<{ readonly width: number; readonly height: number }> => {
  const version = await reader.read(PROTOCOL_VERSION_BYTES);
  if (!/^RFB 003\.00[78]\n$/u.test(version.toString("ascii"))) {
    throw new QemuVncError({
      code: "unsupported-server",
      detail: `unsupported VNC protocol ${version.toString("ascii").trim()}`,
    });
  }
  socket.write(version);

  const securityTypeCount = (await reader.read(1))[0]!;
  if (securityTypeCount === 0) {
    throw new QemuVncError({
      code: "connection-failed",
      detail: await readFailureReason(reader),
    });
  }
  const securityTypes = await reader.read(securityTypeCount);
  if (!securityTypes.includes(SECURITY_TYPE_NONE)) {
    throw new QemuVncError({
      code: "unsupported-server",
      detail: "private VNC server unexpectedly requires authentication",
    });
  }
  socket.write(Buffer.from([SECURITY_TYPE_NONE]));
  if ((await reader.read(4)).readUInt32BE() !== 0) {
    throw new QemuVncError({
      code: "connection-failed",
      detail: await readFailureReason(reader),
    });
  }

  socket.write(Buffer.from([1]));
  const serverInit = await reader.read(24);
  const width = serverInit.readUInt16BE(0);
  const height = serverInit.readUInt16BE(2);
  validateFrameSize(width, height);
  const nameLength = serverInit.readUInt32BE(20);
  if (nameLength > MAX_SERVER_NAME_BYTES) {
    throw new QemuVncError({
      code: "unsupported-server",
      detail: "VNC server name exceeded its protocol bound",
    });
  }
  await reader.read(nameLength);
  writePixelFormat(socket);
  writeRawEncoding(socket);
  writeFullFrameRequest(socket, width, height);
  return { width, height };
};

const readFramebufferUpdate = async (
  reader: SocketReader,
  width: number,
  height: number,
): Promise<Uint8Array | undefined> => {
  const update = await reader.read(3);
  const rectangleCount = update.readUInt16BE(1);
  if (rectangleCount === 0) return undefined;
  const frame = Buffer.alloc(validateFrameSize(width, height));
  for (let rectangleIndex = 0; rectangleIndex < rectangleCount; rectangleIndex++) {
    const rectangle = await reader.read(12);
    const x = rectangle.readUInt16BE(0);
    const y = rectangle.readUInt16BE(2);
    const rectangleWidth = rectangle.readUInt16BE(4);
    const rectangleHeight = rectangle.readUInt16BE(6);
    const encoding = rectangle.readInt32BE(8);
    if (
      encoding !== ENCODING_RAW ||
      rectangleWidth === 0 ||
      rectangleHeight === 0 ||
      x + rectangleWidth > width ||
      y + rectangleHeight > height
    ) {
      throw invalidFrame(`VNC returned invalid rectangle ${rectangleIndex}`);
    }
    const source = await reader.read(validateFrameSize(rectangleWidth, rectangleHeight));
    for (let row = 0; row < rectangleHeight; row++) {
      const sourceStart = row * rectangleWidth * PIXEL_BYTES;
      const destinationStart = ((y + row) * width + x) * PIXEL_BYTES;
      source.copy(frame, destinationStart, sourceStart, sourceStart + rectangleWidth * PIXEL_BYTES);
    }
  }
  for (let alpha = 3; alpha < frame.byteLength; alpha += PIXEL_BYTES) frame[alpha] = 255;
  return frame;
};

const readFrame = async (
  socket: NodeNet.Socket,
  reader: SocketReader,
  width: number,
  height: number,
): Promise<Uint8Array> => {
  while (true) {
    const messageType = (await reader.read(1))[0]!;
    if (messageType === SERVER_FRAMEBUFFER_UPDATE) {
      const frame = await readFramebufferUpdate(reader, width, height);
      if (frame !== undefined) return frame;
      writeFullFrameRequest(socket, width, height);
      continue;
    }
    if (messageType === SERVER_SET_COLOR_MAP) {
      const header = await reader.read(5);
      const colorCount = header.readUInt16BE(3);
      await reader.read(colorCount * 6);
      continue;
    }
    if (messageType === SERVER_BELL) continue;
    if (messageType === SERVER_CUT_TEXT) {
      const header = await reader.read(7);
      const textLength = header.readUInt32BE(3);
      if (textLength > MAX_SERVER_MESSAGE_BYTES) {
        throw invalidFrame("VNC server clipboard message exceeded its protocol bound");
      }
      await reader.read(textLength);
      continue;
    }
    throw invalidFrame(`VNC returned unsupported server message ${messageType}`);
  }
};

/** Captures one complete BGRA frame from a private QEMU VNC Unix socket. */
export const captureFrame = (socketPath: string): Effect.Effect<QemuVncFrame, QemuVncError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<QemuVncFrame>((resolve, reject) => {
        const socket = NodeNet.createConnection({ path: socketPath });
        const reader = new SocketReader(socket);
        let settled = false;
        const finish = (complete: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          socket.destroy();
          complete();
        };
        const fail = (cause: unknown) => finish(() => reject(cause));
        const abort = () =>
          fail(new QemuVncError({ code: "cancelled", detail: "VNC capture was cancelled" }));
        signal.addEventListener("abort", abort, { once: true });
        socket.setTimeout(CAPTURE_TIMEOUT_MS, () =>
          fail(new QemuVncError({ code: "timed-out", detail: "VNC frame capture timed out" })),
        );
        socket.once("connect", () => {
          void negotiate(socket, reader)
            .then(async ({ width, height }) => {
              return { width, height, data: await readFrame(socket, reader, width, height) };
            })
            .then(
              (frame) => finish(() => resolve(frame)),
              (cause) => fail(cause),
            );
        });
        socket.once("error", fail);
      }),
    catch: (cause) =>
      isQemuVncError(cause)
        ? cause
        : new QemuVncError({
            code: "connection-failed",
            detail: String(cause).slice(0, 512),
          }),
  });

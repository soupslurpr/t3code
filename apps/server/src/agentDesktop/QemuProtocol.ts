import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeNet from "node:net";

const MAX_PROTOCOL_BUFFER_BYTES = 48 * 1024 * 1024;
const DEFAULT_PROTOCOL_TIMEOUT_MS = 10_000;
const COMMAND_ID = "t3-command";
const CAPABILITIES_ID = "t3-capabilities";

type JsonRecord = Readonly<Record<string, unknown>>;

/** Reports a bounded QEMU monitor or guest-agent transport failure. */
export class QemuProtocolError extends Schema.TaggedErrorClass<QemuProtocolError>()(
  "QemuProtocolError",
  {
    channel: Schema.Literals(["qmp", "qga"]),
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.channel} ${this.code}: ${this.detail}`;
  }
}
export const isQemuProtocolError = Schema.is(QemuProtocolError);

interface ExchangeInput {
  readonly channel: "qmp" | "qga";
  readonly socketPath: string;
  readonly execute: string;
  readonly arguments?: JsonRecord;
  readonly timeoutMs?: number;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedDetail = (value: unknown): string => String(value).slice(0, 512);

/** Exchanges one command over a fresh capability-scoped Unix socket. */
function exchange(input: ExchangeInput, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection({ path: input.socketPath });
    let buffer = Buffer.alloc(0);
    let settled = false;
    let qmpCapabilitiesAccepted = input.channel === "qga";

    const fail = (code: string, detail: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new QemuProtocolError({
          channel: input.channel,
          code,
          detail: boundedDetail(detail),
        }),
      );
    };

    const succeed = (value: unknown) => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(value);
    };

    const send = (message: JsonRecord) => {
      socket.write(`${JSON.stringify(message)}\n`);
    };

    const sendCommand = () => {
      send({
        execute: input.execute,
        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
        id: COMMAND_ID,
      });
    };

    const handleMessage = (value: unknown) => {
      if (!isRecord(value)) return;
      if (input.channel === "qmp" && !qmpCapabilitiesAccepted) {
        if (value.id === CAPABILITIES_ID) {
          if ("error" in value) {
            fail("capabilities-rejected", JSON.stringify(value.error));
            return;
          }
          qmpCapabilitiesAccepted = true;
          sendCommand();
          return;
        }
        if ("QMP" in value) {
          send({ execute: "qmp_capabilities", id: CAPABILITIES_ID });
        }
        return;
      }
      if (value.id !== COMMAND_ID) return;
      if ("error" in value) {
        const error = isRecord(value.error) ? value.error : {};
        fail(
          typeof error.class === "string" ? error.class : "command-failed",
          typeof error.desc === "string" ? error.desc : JSON.stringify(value.error),
        );
        return;
      }
      succeed(value.return);
    };

    const parseBufferedMessages = () => {
      while (true) {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex < 0) return;
        const rawLine = buffer.subarray(0, newlineIndex);
        buffer = buffer.subarray(newlineIndex + 1);
        const firstObjectByte = rawLine.indexOf(0x7b);
        if (firstObjectByte < 0) continue;
        try {
          handleMessage(JSON.parse(rawLine.subarray(firstObjectByte).toString("utf8")));
        } catch (cause) {
          fail("invalid-json", cause);
          return;
        }
      }
    };

    const abort = () => fail("cancelled", "operation cancelled");
    signal.addEventListener("abort", abort, { once: true });
    socket.setTimeout(input.timeoutMs ?? DEFAULT_PROTOCOL_TIMEOUT_MS);
    socket.on("connect", () => {
      if (input.channel === "qga") {
        socket.write(Buffer.from([0xff]));
        sendCommand();
      }
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_PROTOCOL_BUFFER_BYTES) {
        fail("response-too-large", `response exceeded ${MAX_PROTOCOL_BUFFER_BYTES} bytes`);
        return;
      }
      parseBufferedMessages();
    });
    socket.on("timeout", () => fail("timed-out", "command response timed out"));
    socket.on("error", (cause) => fail("connection-failed", cause));
    socket.on("close", () => {
      signal.removeEventListener("abort", abort);
      if (!settled) fail("disconnected", "channel closed before returning a response");
    });
  });
}

/** Invokes one QEMU machine-protocol command. */
export const invokeQmp = (
  socketPath: string,
  execute: string,
  argumentsValue?: JsonRecord,
  timeoutMs?: number,
): Effect.Effect<unknown, QemuProtocolError> =>
  Effect.tryPromise({
    try: (signal) =>
      exchange(
        {
          channel: "qmp",
          socketPath,
          execute,
          ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        signal,
      ),
    catch: (cause) =>
      isQemuProtocolError(cause)
        ? cause
        : new QemuProtocolError({
            channel: "qmp",
            code: "connection-failed",
            detail: boundedDetail(cause),
          }),
  });

/** Invokes one QEMU guest-agent command. */
export const invokeQga = (
  socketPath: string,
  execute: string,
  argumentsValue?: JsonRecord,
): Effect.Effect<unknown, QemuProtocolError> =>
  Effect.tryPromise({
    try: (signal) =>
      exchange(
        {
          channel: "qga",
          socketPath,
          execute,
          ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
        },
        signal,
      ),
    catch: (cause) =>
      isQemuProtocolError(cause)
        ? cause
        : new QemuProtocolError({
            channel: "qga",
            code: "connection-failed",
            detail: boundedDetail(cause),
          }),
  });

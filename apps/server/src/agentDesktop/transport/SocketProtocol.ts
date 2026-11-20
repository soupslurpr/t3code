// @effect-diagnostics nodeBuiltinImport:off - QMP and QGA use private host Unix sockets and binary framing.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as Schema from "effect/Schema";

type Fields = Readonly<Record<string, unknown>>;
const pending = new Map<string, Promise<void>>();

export function serialized<A>(
  key: string,
  run: () => Promise<A>,
  signal?: AbortSignal,
): Promise<A> {
  signal?.throwIfAborted();
  const previous = pending.get(key) ?? Promise.resolve();
  let cancel: (() => void) | undefined;
  const result = previous.then(() => {
    if (cancel) signal?.removeEventListener("abort", cancel);
    signal?.throwIfAborted();
    return run();
  });
  const done = () => {
    if (pending.get(key) === tail) pending.delete(key);
  };
  const tail = result.then(done, done);
  pending.set(key, tail);
  if (!signal) return result;
  return new Promise((resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    result.then(resolve, reject);
  });
}

export function fields(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid QEMU response object.");
  }
  return value as Fields;
}

class CommandRejected extends Schema.TaggedError<
  CommandRejected,
  { readonly brand: unique symbol }
>()("GuestCommandRejected", {
  message: Schema.String,
}) {}
class OutcomeUnknown extends Schema.TaggedError<
  OutcomeUnknown,
  { readonly brand: unique symbol }
>()("GuestOutcomeUnknown", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const isCommandRejected = Schema.is(CommandRejected);
export const isOutcomeUnknown = Schema.is(OutcomeUnknown);

function exchange(
  channel: "qga" | "qmp",
  path: string,
  execute: string,
  args: Fields | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const commandId = NodeCrypto.randomUUID();
  const request = JSON.stringify({ execute, arguments: args, id: commandId }) + "\n";
  if (Buffer.byteLength(request) > 48 * 1024 * 1024)
    throw new Error("QEMU request exceeds the transport limit.");
  const nonce = NodeCrypto.randomBytes(6).readUIntBE(0, 6);
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection({ path });
    let phase: "sync" | "greeting" | "capabilities" | "command" =
      channel === "qga" ? "sync" : "greeting";
    let sentinel = false;
    let fragments: Buffer[] = [];
    let length = 0;
    let settled = false;

    const close = () => {
      settled = true;
      signal.removeEventListener("abort", abort);
      socket.destroy();
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      close();
      reject(
        phase === "command" && !isCommandRejected(cause)
          ? new OutcomeUnknown({
              message: `${channel} ${execute} outcome is unknown after the request was sent.`,
              cause,
            })
          : cause,
      );
    };
    const abort = () => fail(signal.reason);
    const send = (name: string, id: string, argumentsValue?: Fields) =>
      socket.write(JSON.stringify({ execute: name, arguments: argumentsValue, id }) + "\n");
    const command = () => {
      phase = "command";
      socket.write(request);
    };
    const receive = (raw: Buffer) => {
      if (phase === "sync") {
        sentinel = false;
        let value: Fields;
        try {
          value = fields(JSON.parse(raw.toString("utf8")));
        } catch {
          return;
        }
        if (value.return === nonce) command();
        return;
      }
      const value = fields(JSON.parse(raw.toString("utf8")));
      switch (phase) {
        case "greeting":
          if (value.QMP) {
            phase = "capabilities";
            send("qmp_capabilities", "capabilities");
          }
          return;
        case "capabilities":
        case "command":
          if (value.id !== (phase === "capabilities" ? "capabilities" : commandId)) return;
          if (value.error) {
            const error = fields(value.error);
            throw new CommandRejected({
              message: `${channel} ${execute}: ${String(error.desc ?? error.class).slice(0, 512)}`,
            });
          }
          if (!("return" in value)) throw new Error("QEMU reply has no result.");
          if (phase === "capabilities") command();
          else {
            close();
            resolve(value.return);
          }
      }
    };
    socket.on("connect", () => {
      if (phase === "sync") {
        socket.write(Buffer.from([0xff]));
        send("guest-sync-delimited", "sync", { id: nonce });
      }
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        for (let pos = 0; pos < chunk.length;) {
          if (settled) return;
          const newline = chunk.indexOf(10, pos);
          const end = newline === -1 ? chunk.length : newline;
          let part = chunk.subarray(pos, end);
          pos = end + 1;
          if (phase === "sync") {
            const marker = part.lastIndexOf(255);
            if (marker >= 0) {
              fragments = [];
              length = 0;
              sentinel = true;
              part = part.subarray(marker + 1);
            }
            if (!sentinel) continue;
          }
          length += part.length;
          // QGA may return two 16 MiB base64-encoded exec streams in one reply.
          if (length > 48 * 1024 * 1024)
            throw new Error("QEMU response exceeds the transport limit.");
          if (part.length) fragments.push(part);
          if (newline !== -1 && length) {
            const line = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, length);
            fragments = [];
            length = 0;
            receive(line);
          }
        }
      } catch (error) {
        fail(error);
      }
    });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error(`${channel} socket closed before the reply.`)));
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function invoke(
  channel: "qga" | "qmp",
  path: string,
  execute: string,
  args?: Fields,
  timeoutMs = 10_000,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return serialized(path, () => exchange(channel, path, execute, args, stop), stop);
}

// @effect-diagnostics nodeBuiltinImport:off - These are native process arguments and filesystem paths.
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { DesktopJobStart, DesktopJobOperation } from "@t3tools/contracts";
import type { DesktopJobOptions, DesktopJobOwner } from "./port.ts";

export class DesktopJobError extends Schema.TaggedError<
  DesktopJobError,
  { readonly brand: unique symbol }
>()("DesktopJobError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export const failure = (code: string, message: string) => new DesktopJobError({ code, message });
export const cancelled = () =>
  failure("request-cancelled", "The desktop job request was cancelled.");
export const denied = () =>
  failure("permission-denied", "This desktop job operation was not admitted.");
export const notFound = () =>
  failure("process-not-found", "The process is unavailable in this scope.");
export const sameOwner = (a: DesktopJobOwner, b: DesktopJobOwner) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function inputBytes(data = "", encoding: "utf8" | "base64" = "utf8"): Buffer {
  const bytes = Buffer.from(data, encoding);
  if (bytes.length > 1024 * 1024) throw failure("invalid-input", "Input exceeds one MiB.");
  if (encoding === "base64" && bytes.toString("base64") !== data)
    throw failure("invalid-input", "Invalid base64 input.");
  return bytes;
}

export function desktopCommandEnvironment(
  inherited: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  input: Pick<DesktopJobStart, "inheritEnvironment" | "environment" | "terminal">,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.assign(
    Object.create(null),
    input.inheritEnvironment === false ? {} : inherited,
  );
  const normalize = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
  const names = new Map(Object.keys(env).map((n) => [normalize(n), n]));
  if (input.terminal && !names.has("TERM")) {
    env.TERM = "xterm-256color";
    names.set("TERM", "TERM");
  }
  for (const [name, value] of Object.entries(input.environment ?? {})) {
    const prior = names.get(normalize(name));
    if (prior !== undefined) delete env[prior];
    if (value !== null) {
      env[name] = value;
      names.set(normalize(name), name);
    }
  }
  return env;
}

export function commandConfig(options: DesktopJobOptions, input: DesktopJobStart) {
  return {
    executable: input.executable,
    args: [...(input.arguments ?? [])],
    cwd: (options.platform === "win32" ? NodePath.win32 : NodePath.posix).resolve(
      options.homeDirectory,
      input.workingDirectory ?? ".",
    ),
    environment: desktopCommandEnvironment(options.environment, options.platform, input),
    terminal: input.terminal === true ? { columns: 120, rows: 30 } : input.terminal || null,
  };
}

export function fingerprint(
  input: DesktopJobStart,
  config: ReturnType<typeof commandConfig>,
  bytes: Buffer,
) {
  const settings = [
    config.executable,
    config.args,
    config.cwd,
    Object.entries(config.environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    config.terminal?.columns,
    config.terminal?.rows,
    input.keepStdinOpen ?? false,
    input.timeoutMs ?? null,
    input.maxStoredOutputBytes ?? null,
  ];
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(settings))
    .update(bytes)
    .digest("hex");
}

export function cancelledIf(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
}

export async function interruptible<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  const stopped = Promise.withResolvers<never>();
  const onAbort = () => stopped.reject(cancelled());
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([pending, stopped.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export type OutputOptions = Pick<
  DesktopJobOperation,
  "stdoutOffset" | "stderrOffset" | "maxBytes" | "encoding"
>;

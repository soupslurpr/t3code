import {
  isDesktopProcessLive,
  type DesktopProcess,
  type DesktopProcessOutput,
  type DesktopProcessResult,
  type UserDesktopCommandToolInput,
  type UserDesktopToolProcessResult,
} from "@t3tools/contracts";

const streams = ["stdout", "stderr"] as const;

/** Keep the output budget independent of a provider's tokenizer and message framing. */
export function desktopCommandOutputOptions(
  input: Pick<
    UserDesktopCommandToolInput,
    "maxOutputTokens" | "maxBytes" | "stdoutOffset" | "stderrOffset" | "encoding"
  >,
  includeOutputPaths = false,
) {
  const binary = input.encoding === "base64";
  const byteBudget = (input.maxOutputTokens ?? 10_000) * 4;
  const rawBudget = binary ? Math.floor(byteBudget / 4) * 3 : byteBudget;
  return {
    binary,
    byteBudget,
    includeOutputPaths,
    paged:
      binary ||
      input.maxBytes !== undefined ||
      input.stdoutOffset !== undefined ||
      input.stderrOffset !== undefined,
    maxBytes: Math.max(4, Math.min(input.maxBytes ?? rawBudget, rawBudget)),
  };
}

type OutputOptions = ReturnType<typeof desktopCommandOutputOptions>;

/** Share one budget fairly, assigning unused capacity to the other stream. */
function splitBudget(stdout: number, stderr: number, budget: number) {
  let out = Math.min(stdout, Math.ceil(budget / 2));
  const err = Math.min(stderr, budget - out);
  out = Math.min(stdout, budget - err);
  return { stdout: out, stderr: err };
}

export function desktopCommandOutputBudgets(result: DesktopProcessResult, options: OutputOptions) {
  const size = (stream: DesktopProcessOutput) =>
    options.paged
      ? Math.min(stream.nextOffset - stream.offset, options.maxBytes)
      : Math.max(0, stream.totalBytes - stream.offset);
  if (!options.binary) {
    // Four-byte units ensure that even the smallest page can advance over a
    // complete UTF-8 character when both streams have output.
    const budget = splitBudget(
      Math.ceil(size(result.stdout) / 4),
      Math.ceil(size(result.stderr) / 4),
      options.byteBudget / 4,
    );
    return { stdout: budget.stdout * 4, stderr: budget.stderr * 4 };
  }
  const budget = splitBudget(
    Math.ceil(size(result.stdout) / 3),
    Math.ceil(size(result.stderr) / 3),
    Math.floor(options.byteBudget / 4),
  );
  return { stdout: budget.stdout * 3, stderr: budget.stderr * 3 };
}

export function compactDesktopProcess(process: DesktopProcess) {
  const live = isDesktopProcessLive(process);
  return {
    processId: process.processId,
    status: process.status,
    exitCode: process.exitCode,
    ...(live && process.pid !== null ? { pid: process.pid } : {}),
    ...(live && process.terminal ? { terminal: true as const } : {}),
    ...(live && process.stdinClosed ? { stdinClosed: true as const } : {}),
    ...(live && process.runtimeGeneration !== undefined
      ? { runtimeGeneration: process.runtimeGeneration }
      : {}),
    ...(process.signal === null ? {} : { signal: process.signal }),
    ...(process.timedOut ? { timedOut: true as const } : {}),
    ...(process.outputError === null ? {} : { outputError: process.outputError }),
  };
}

const bytes = (stream: DesktopProcessOutput) =>
  Buffer.from(stream.data, stream.encoding === "base64" ? "base64" : "utf8");

/** Leave an incomplete UTF-8 character for a subsequent read instead of replacing it. */
function utf8PrefixEnd(buffer: Buffer, end: number) {
  let start = end - 1;
  while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start--;
  if (start < 0) return end;
  const lead = buffer[start]!;
  const length =
    lead >= 0xf0 && lead <= 0xf4
      ? 4
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xc2 && lead <= 0xdf
          ? 2
          : 1;
  return start + length > end ? start : end;
}

/** Selects the actual retained tail, with up to three leading continuation bytes removed. */
function tailSlice(stream: DesktopProcessOutput, end: number, budget: number, live: boolean) {
  const buffer = bytes(stream);
  let to = Math.max(0, Math.min(buffer.length, end - stream.offset));
  if (live || stream.offset + to < stream.totalBytes) to = utf8PrefixEnd(buffer, to);
  let from = Math.max(0, to - budget);
  for (let n = 0; n < 3 && from < to && (buffer[from]! & 0xc0) === 0x80; n++) from++;
  return { data: buffer.subarray(from, to), offset: stream.offset + from, end: stream.offset + to };
}

/** Presents output without changing the full process records used by desktop clients. */
export function compactDesktopCommandOutput(
  result: DesktopProcessResult,
  options: OutputOptions,
  tail?: DesktopProcessResult,
  tailUnavailable = false,
): UserDesktopToolProcessResult {
  const live = isDesktopProcessLive(result.process);
  const budgets = desktopCommandOutputBudgets(result, options);
  const value: UserDesktopToolProcessResult = {
    ...compactDesktopProcess(result.process),
    ...(options.binary ? { encoding: "base64" } : {}),
    ...(tailUnavailable ? { tailUnavailable: true } : {}),
  };
  const output: { stdout?: string; stderr?: string } = {};
  const paths: { stdoutPath?: string; stderrPath?: string } = {};
  const cursors: {
    stdout?: NonNullable<UserDesktopToolProcessResult["cursor"]>["stdout"];
    stderr?: NonNullable<UserDesktopToolProcessResult["cursor"]>["stderr"];
  } = {};
  let needsCursor = false;
  const invalidUtf8: Array<(typeof streams)[number]> = [];
  for (const name of streams) {
    const stream = result[name];
    const buffer = bytes(stream);
    const end = stream.retainedEnd ?? stream.totalBytes;
    const omitted =
      !options.paged &&
      (end - stream.offset > budgets[name] || (stream.truncated && stream.nextOffset < end));
    const tailBudget = budgets[name] >= 8 ? Math.floor(budgets[name] / 2) : 0;
    const headBudget = omitted ? budgets[name] - tailBudget : budgets[name];
    let headEnd = Math.min(buffer.length, headBudget);
    if (!options.binary && (headEnd < buffer.length || live || stream.offset + headEnd < end)) {
      headEnd = utf8PrefixEnd(buffer, headEnd);
    }
    const head = buffer.subarray(0, headEnd);
    // Lossy UTF-8 cannot provide byte-accurate cursors.
    // Read from the original offset (in base64 if needed) to recover those bytes.
    const nextOffset = stream.invalidUtf8 ? stream.offset : stream.offset + headEnd;
    const tailSource = tail?.[name] ?? stream;
    const suffix =
      omitted && !options.binary && tailSource.nextOffset >= end
        ? tailSlice(tailSource, end, tailBudget, live)
        : undefined;
    const usableTail =
      suffix !== undefined &&
      suffix.data.length > 0 &&
      suffix.offset >= nextOffset &&
      suffix.end <= end
        ? suffix
        : undefined;
    let text = head.toString(options.binary ? "base64" : "utf8");
    if (usableTail !== undefined && usableTail.offset > nextOffset) {
      text += stream.invalidUtf8
        ? "\n... output omitted ...\n"
        : `\n... ${usableTail.offset - nextOffset} bytes omitted ...\n`;
    } else if (omitted && usableTail === undefined) {
      text += "\n... output omitted; read this process for more ...\n";
    }
    if (usableTail !== undefined) text += usableTail.data.toString("utf8");
    if (text.length > 0) output[name] = text;
    if (!options.binary) {
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        decoder.decode(head);
        if (usableTail !== undefined) decoder.decode(usableTail.data);
        if (stream.invalidUtf8) invalidUtf8.push(name);
      } catch {
        invalidUtf8.push(name);
      }
    }
    // Paths keep searching/copying on the selected desktop possible without
    // transferring a large log into model context. Explicit reads discover
    // paths even when the entire output fits in the response.
    if (
      options.includeOutputPaths ||
      stream.offset > 0 ||
      nextOffset < stream.totalBytes ||
      stream.truncated ||
      invalidUtf8.includes(name)
    ) {
      paths[`${name}Path`] = result.process[`${name}Path`];
    }
    needsCursor ||=
      live || nextOffset < stream.totalBytes || stream.truncated || stream.invalidUtf8;
    cursors[name] = {
      offset: stream.offset,
      nextOffset,
      totalBytes: stream.totalBytes,
      ...(usableTail === undefined
        ? {}
        : { tailOffset: usableTail.offset, tailEnd: usableTail.end }),
      ...(stream.truncated
        ? {
            truncated: true,
            storedBytes: stream.storedBytes,
            ...(stream.tailOffset === undefined ? {} : { retainedTailOffset: stream.tailOffset }),
            ...(stream.retainedEnd === undefined ? {} : { retainedEnd: stream.retainedEnd }),
          }
        : {}),
    };
  }
  return {
    ...value,
    ...output,
    ...paths,
    ...(needsCursor ? { cursor: cursors } : {}),
    ...(invalidUtf8.length === 0 ? {} : { invalidUtf8 }),
  };
}

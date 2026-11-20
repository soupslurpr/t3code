// @effect-diagnostics nodeBuiltinImport:off - Native filesystem publication is a Node boundary.
import * as NodeProcess from "node:process";

export type Koffi = typeof import("koffi").default;
type NativeFunction = ReturnType<ReturnType<Koffi["load"]>["func"]>;
export type NativeResult = { readonly value: unknown; readonly errnoCode: number };
// Native pointers do not retain JS buffers; keep arguments and library handles until completion.
const inFlight = new Set<object>();
export function callNative(
  binding: { readonly readError: () => number },
  operation: NativeFunction,
  args: unknown[],
  references?: ReadonlyArray<unknown>,
): Promise<NativeResult> {
  const retained = { binding, operation, args, references };
  inFlight.add(retained);
  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = (error: unknown, value: unknown) => {
      // The worker's error state is valid only inside this callback, before any other native call.
      try {
        const errnoCode = binding.readError();
        if (settled) return;
        settled = true;
        if (error !== null && error !== undefined) reject(error);
        else resolve({ value, errnoCode });
      } catch (cause) {
        settled = true;
        reject(cause);
      } finally {
        inFlight.delete(retained);
      }
    };
    try {
      operation.async(...args, complete);
    } catch (cause) {
      if (!settled) {
        settled = true;
        inFlight.delete(retained);
        reject(cause);
      }
    }
  });
}

export function reportHandleCleanup(context: string, cause: unknown) {
  // A failed close may already have released the handle; never retry or replace the native receipt.
  try {
    NodeProcess.emitWarning(
      `Transfer handle cleanup failed (${context}): ${cause instanceof Error ? cause.message : String(cause)}`.slice(
        0,
        1024,
      ),
      { code: "T3_TRANSFER_HANDLE_CLEANUP" },
    );
  } catch {
    // A diagnostic failure cannot change an already-settled publication result.
  }
}

import type { DesktopTransferManifest } from "@t3tools/contracts";
import * as Context from "effect/Context";

export interface DesktopArchiveStream {
  readonly download: () => {
    readonly manifest: DesktopTransferManifest;
    readonly body: AsyncIterable<Uint8Array>;
  } | null;
  readonly upload: (
    manifest: DesktopTransferManifest,
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ) => Promise<boolean>;
}
/** An in-process guest receives only the already admitted transfer's byte stream. */
export const DesktopTransferStream = Context.Reference<DesktopArchiveStream | null>(
  "t3/computer/DesktopTransferStream",
  { defaultValue: () => null },
);

import type {
  ComputerDesktopSelector,
  DesktopJobOperation,
  DesktopJobResult,
  DesktopJobStart,
  DesktopProcess,
} from "@t3tools/contracts";

export interface DesktopJobOwner {
  readonly environmentId: string;
  readonly threadId: string;
}
export interface DesktopJobAuthority {
  readonly owner: DesktopJobOwner;
  readonly grantId: string;
  readonly revision: number;
  /** The destination rechecks its current grant or human inspection right at acceptance. */
  readonly admit: (action: "start" | "read" | "write" | "stop") => Promise<void>;
  readonly inspectAllThreads: boolean;
}
export interface DesktopJobPort {
  readonly start: (
    authority: DesktopJobAuthority,
    input: DesktopJobStart,
    signal?: AbortSignal,
  ) => Promise<DesktopJobResult>;
  readonly operate: (
    authority: DesktopJobAuthority,
    input: DesktopJobOperation,
    signal?: AbortSignal,
  ) => Promise<DesktopJobResult>;
  readonly list: (authority: DesktopJobAuthority) => Promise<readonly DesktopProcess[]>;
  readonly revoke: (grants: ReadonlySet<string>) => Promise<void>;
  readonly close: () => Promise<void>;
}
export interface DesktopJobOptions {
  readonly desktop: ComputerDesktopSelector;
  readonly directory: string;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly user: string;
  readonly now: () => number;
  readonly onStatusChange?: (process: DesktopProcess) => void;
}

export interface DesktopJobProcess {
  readonly connected: Promise<void>;
  readonly done: Promise<{
    code: number | null;
    signal: string | null;
    error?: string;
    unconfirmed?: boolean;
  }>;
  readonly configure: (
    config: ReturnType<typeof import("./request.ts").commandConfig>,
  ) => Promise<number>;
  readonly write: (bytes: Buffer, close: boolean) => Promise<void>;
  readonly resize: (columns: number, rows: number) => Promise<void>;
  readonly signal: (name: string) => Promise<void>;
}
export interface DesktopJobExecutor {
  readonly checkDirectory: (cwd: string) => Promise<void>;
  /** Connect to the selected runtime. A command starts only after configure receives destination admission. */
  readonly connect: (
    cwd: string,
    stdout: import("node:stream").Writable,
    stderr: import("node:stream").Writable,
    authority: DesktopJobAuthority,
  ) => DesktopJobProcess;
}

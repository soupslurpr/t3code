import type {
  AgentDesktop,
  AgentDesktopAcquireInput,
  AgentDesktopCreatePortRouteInput,
  AgentDesktopManageInput,
  AgentDesktopMaintenance,
  AgentDesktopNetworkTelemetry,
  AgentDesktopOwner,
  AgentDesktopPacketCapture,
  AgentDesktopPortRoute,
} from "@t3tools/contracts";

export interface MachinePaths {
  readonly id: string;
  readonly directory: string;
  readonly disk: string;
  readonly nvram: string;
  readonly runtimeDirectory: string;
  readonly qmpSocket: string;
  readonly qgaSocket: string;
  readonly vncSocket: string;
  readonly passtControlSocket: string;
  readonly captureDirectory: string;
  readonly unitName: string;
}

export interface DesktopImage {
  readonly path: string;
  readonly generation: string | null;
  readonly managed: boolean;
  readonly sourceRelease?: string;
  readonly profileVersion: string | null;
  readonly builtAt: string | null;
}
export interface DesktopImages {
  readonly current: () => Promise<DesktopImage>;
  readonly ensure: () => Promise<DesktopImage>;
  readonly refresh: () => Promise<DesktopImage>;
  readonly prune: (referencedGenerations: ReadonlySet<string>) => Promise<void>;
}

export interface GuestCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface GuestIo {
  readonly qmp: (
    vm: MachinePaths,
    execute: string,
    args?: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  readonly qga: (
    vm: MachinePaths,
    execute: string,
    args?: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  readonly exec: (
    vm: MachinePaths,
    command: GuestCommand,
    signal?: AbortSignal,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly read: (
    vm: MachinePaths,
    path: string,
    offset: number,
    length: number,
  ) => Promise<Uint8Array>;
  readonly write: (
    vm: MachinePaths,
    path: string,
    offset: number,
    bytes: Uint8Array,
  ) => Promise<void>;
}

export interface GuestNetwork {
  readonly route: (
    vm: MachinePaths,
    input: AgentDesktopCreatePortRouteInput,
  ) => Promise<AgentDesktopPortRoute>;
  readonly apply: (
    vm: MachinePaths,
    route: AgentDesktopPortRoute,
    action: "add" | "remove",
  ) => Promise<void>;
  readonly inspect: (
    vm: MachinePaths,
    routes: readonly AgentDesktopPortRoute[],
    includeConnections: boolean,
  ) => Promise<AgentDesktopNetworkTelemetry>;
  readonly capture: (
    vm: MachinePaths,
    durationMs: number,
    maxBytes: number,
    signal?: AbortSignal,
  ) => Promise<AgentDesktopPacketCapture>;
  readonly reconcile: (vm: MachinePaths) => Promise<void>;
  readonly reconcileRoutes: (
    vm: MachinePaths,
    desired: readonly AgentDesktopPortRoute[],
  ) => Promise<readonly AgentDesktopPortRoute[]>;
}

export type DesktopOwner = AgentDesktopOwner;
export interface DesktopLease {
  readonly desktop: AgentDesktop;
  readonly paths: MachinePaths;
  readonly release: () => Promise<void>;
}
export interface DesktopLifecycle {
  readonly list: (owner: DesktopOwner) => Promise<readonly AgentDesktop[]>;
  readonly acquire: (owner: DesktopOwner, input: AgentDesktopAcquireInput) => Promise<AgentDesktop>;
  readonly manage: (owner: DesktopOwner, input: AgentDesktopManageInput) => Promise<AgentDesktop>;
  readonly lease: (
    owner: DesktopOwner,
    id: string,
    access: "view" | "control" | "release",
  ) => Promise<AgentDesktop>;
  readonly begin: (
    owner: DesktopOwner,
    id: string,
    permission: "owned" | "view" | "control",
  ) => Promise<DesktopLease>;
  readonly inspect: (
    owner: DesktopOwner,
    id: string,
    connections: boolean,
  ) => Promise<AgentDesktop>;
  readonly route: (
    owner: DesktopOwner,
    id: string,
    input: AgentDesktopCreatePortRouteInput | string,
  ) => Promise<readonly AgentDesktopPortRoute[]>;
  readonly ensureBase: () => Promise<void>;
  readonly baseMaintenance: (image: DesktopImage) => Promise<AgentDesktopMaintenance>;
  readonly update: (
    owner: DesktopOwner,
    id: string | null,
    onAdmitted?: (accepted: boolean) => void,
  ) => Promise<void>;
  readonly maintain: () => Promise<void>;
}
export interface LifecycleOptions {
  readonly directory: string;
  readonly images: DesktopImages;
  readonly guest: GuestIo;
  readonly network: GuestNetwork;
  readonly resource: (name: string) => Promise<string>;
}

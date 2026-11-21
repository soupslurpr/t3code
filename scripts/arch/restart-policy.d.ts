import type { ManagedPolicyDocument, ServerSettings } from "@t3tools/contracts";

export interface RestartPolicy {
  defaults: ServerSettings;
  withDefaults: (raw: unknown) => unknown;
  effective: (settings: ServerSettings) => ServerSettings;
}

export function restartPolicy(document: ManagedPolicyDocument | undefined): RestartPolicy;

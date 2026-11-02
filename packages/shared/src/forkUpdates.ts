import { forkBuildIdentity } from "./forkBuildIdentity.ts";

export const FORK_UPDATE_BLOCK_REASON =
  "This fork cannot use in-app updates: no authenticated release proves fork provenance and exact upstream, fork, and legacy migration compatibility. Update through the fork's manual package procedure. Inspect and resolve any retained launcher pending update before replacing or starting its launcher; see docs/operations/fork-updates.md.";

export function forkBuildUpdateBlockReason(): string | undefined {
  return forkBuildIdentity === undefined ? undefined : FORK_UPDATE_BLOCK_REASON;
}

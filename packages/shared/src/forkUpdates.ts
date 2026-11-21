import { forkBuildIdentity } from "./forkBuildIdentity.ts";

export function forkBuildUpdateBlockReason(): string | undefined {
  return forkBuildIdentity === undefined
    ? undefined
    : "Built-in updates are disabled for this fork. Update the installed package using docs/operations/local-arch-package.md.";
}

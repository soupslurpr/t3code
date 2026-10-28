import type { VcsListRefsInput, EnvironmentId, VcsRef as ContractVcsRef } from "@t3tools/contracts";

export interface VcsRefTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
}

export type VcsRef = ContractVcsRef;

export function vcsRefPageInput(
  cwd: string,
  query: string,
  cursor: number | undefined,
  limit: number,
): VcsListRefsInput {
  return {
    cwd,
    ...(query.length > 0 ? { query } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    ...(query.length === 0 && cursor === undefined ? { refresh: true } : {}),
    limit,
  };
}

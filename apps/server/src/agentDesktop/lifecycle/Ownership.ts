import type { AgentDesktopAcquireInput } from "@t3tools/contracts";
import type { DesktopOwner } from "../MachinePorts.ts";
import { backend, type Machine, type Inventory } from "./Inventory.ts";
import { virtualDisk } from "./Admission.ts";

export const sameThread = (a: DesktopOwner, b: DesktopOwner) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;
export const sameOwner = (a: DesktopOwner, b: DesktopOwner) =>
  sameThread(a, b) && a.controllerId === b.controllerId;
export const trashed = (row: Machine) => row.state === "recoverable" || row.state === "deleting";
export const suitable = (row: Machine, { requirements: r = {} }: AgentDesktopAcquireInput) =>
  !(r.graphics === "required" && backend(row) !== "virgl") &&
  !(r.graphics === "none" && backend(row) === "virgl") &&
  (!r.audio || row.resources.audio) &&
  (r.expectedTemporaryDiskBytes === undefined ||
    row.resources.diskVirtualBytes >= virtualDisk(r.expectedTemporaryDiskBytes));

export async function acquisitionCandidates(
  inventory: Inventory,
  owner: DesktopOwner,
  input: AgentDesktopAcquireInput,
) {
  return input.desktopId
    ? [await inventory.get(input.desktopId)]
    : input.fresh
      ? []
      : (await inventory.read()).desktops
          .filter(
            (r) =>
              sameThread(r.owner, owner) &&
              !trashed(r) &&
              r.state !== "failed" &&
              suitable(r, input),
          )
          .sort(
            (a, b) =>
              Number(sameOwner(b.owner, owner)) - Number(sameOwner(a.owner, owner)) ||
              b.lastActiveAt.localeCompare(a.lastActiveAt),
          );
}

import type {
  ComputerAutomationDisplay,
  ComputerAutomationObservationOptions,
  ComputerAutomationScreenshotOptions,
} from "@t3tools/contracts";

type DisplayBounds = ComputerAutomationDisplay["bounds"];
type HostDisplay = { readonly id: number; readonly bounds: DisplayBounds };

export function legacyDisplayId(options: ComputerAutomationObservationOptions) {
  const ids = [options.displayId];
  for (const shot of [options.screenshot, ...(options.detailScreenshots ?? [])]) {
    if (shot && shot.region && "displayId" in shot.region) ids.push(shot.region.displayId);
  }
  return ids.find((id) => id !== undefined && /^-?\d+$/u.test(id));
}

export function migrateGnomeDisplay(
  options: ComputerAutomationObservationOptions,
  legacyId: string,
  host: ReadonlyArray<HostDisplay>,
  shared: ReadonlyArray<Pick<ComputerAutomationDisplay, "id" | "bounds">>,
): ComputerAutomationObservationOptions | null {
  const display = host.find((d) => String(d.id) === legacyId);
  if (!display) return null;
  const sameBounds = ({ bounds }: { readonly bounds: DisplayBounds }) =>
    bounds.x === display.bounds.x &&
    bounds.y === display.bounds.y &&
    bounds.width === display.bounds.width &&
    bounds.height === display.bounds.height;
  const matches = shared.filter(sameBounds);
  // Mirrored displays can have identical geometry on either side of the portal.
  let selected =
    matches.length === 1 && host.filter(sameBounds).length === 1 ? matches[0] : undefined;
  if (
    !selected &&
    host.length === 1 &&
    shared.length === 1 &&
    ![options.screenshot, ...(options.detailScreenshots ?? [])].some((s) => s && s.region)
  ) {
    selected = shared[0];
  }
  if (!selected) return null;
  const id = selected.id;
  const view = <T extends ComputerAutomationScreenshotOptions>(shot: T): T =>
    shot.region && "displayId" in shot.region && shot.region.displayId === legacyId
      ? { ...shot, region: { ...shot.region, displayId: id } }
      : shot;
  return {
    ...options,
    ...(options.displayId === legacyId ? { displayId: id } : {}),
    ...(options.screenshot ? { screenshot: view(options.screenshot) } : {}),
    ...(options.detailScreenshots
      ? { detailScreenshots: options.detailScreenshots.map(view) }
      : {}),
  };
}

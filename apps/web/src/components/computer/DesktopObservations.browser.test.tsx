import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ComputerObservationUpdate,
  type UserDesktopHumanRequest,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { DesktopObservations } from "./DesktopObservations";
import type { DesktopClient } from "./desktopClient";

it("keeps the selected environment’s evidence when the previous environment finishes later", async () => {
  const oldRequested = Promise.withResolvers<void>();
  const oldResult = Promise.withResolvers<ComputerObservationUpdate>();
  const allowed = Atom.make(true);
  const threadId = ThreadId.make("thread");
  const desktopId = "shared-desktop-id";
  const observation = (site: string) => ({
    id: site + "-capture",
    desktopId,
    threadId,
    observedAt: "2026-01-02T03:04:05.000Z",
    source: "snapshot" as const,
    recipient: {
      kind: "controller" as const,
      instanceId: ProviderInstanceId.make(site + "-controller"),
    },
    images: [],
  });
  const panel = (site: string) => {
    const entry = observation(site);
    const client: DesktopClient<UserDesktopHumanRequest> = {
      environmentId: EnvironmentId.make(site),
      threadId,
      permission: () => allowed,
      async invoke(request) {
        if (request.operation === "observation-list")
          return {
            observations: [{ ...entry, imageCount: 0, hasAccessibility: false }],
          };
        if (request.operation !== "observation") throw new Error("Unexpected request");
        if (site === "old") {
          oldRequested.resolve();
          return oldResult.promise;
        }
        return { latestId: entry.id, observation: entry };
      },
    };
    return <DesktopObservations desktopId={desktopId} client={client} />;
  };
  await using screen = await render(panel("old"));
  await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
  await oldRequested.promise;
  await screen.rerender(panel("new"));
  await expect.element(screen.getByText("new-controller", { exact: false })).toBeVisible();
  await act(async () => {
    const entry = observation("old");
    oldResult.resolve({ latestId: entry.id, observation: entry });
    await oldResult.promise;
  });
  await expect.element(screen.getByText("new-controller", { exact: false })).toBeVisible();
  await expect
    .element(screen.getByText("old-controller", { exact: false }))
    .not.toBeInTheDocument();
});

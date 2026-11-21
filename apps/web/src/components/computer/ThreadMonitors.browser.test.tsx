import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ThreadMonitors } from "./ThreadMonitors";

const { cancel } = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("~/state/computer", () => ({
  computerEnvironment: {
    threadMonitors: () =>
      Atom.make(
        AsyncResult.success({
          monitors: ["triggered", "delivered"].map((status) => ({
            id: status,
            label: status,
            status,
            condition: "signal",
          })),
        }),
      ),
  },
}));
vi.mock("./desktopClient", () => ({
  desktopError: String,
  useDesktopRead: vi.fn(),
  useScopedCommand: () => ({ permission: () => Atom.make(true), invoke: cancel }),
}));

it("cancels a triggered monitor while its continuation is waiting for delivery", async () => {
  cancel.mockReset();
  const threadId = ThreadId.make("thread");
  await using screen = await render(
    <ThreadMonitors target={{ environmentId: EnvironmentId.make("environment"), threadId }} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel monitor" }));
  expect(cancel.mock.calls[0]?.[0]).toEqual({ threadId, monitorId: "triggered" });
});

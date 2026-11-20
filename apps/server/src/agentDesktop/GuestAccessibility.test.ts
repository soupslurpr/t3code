import { expect, it, vi } from "vite-plus/test";
import { makeGuestAccessibility } from "./GuestAccessibility.ts";
import { machinePaths } from "./MachinePaths.ts";
import type { GuestTools } from "./GuestTools.ts";

it("scopes target generations per controller and consumes each generation once", async () => {
  const snapshot = {
    available: true,
    coordinateSpace: "focused-window",
    window: null,
    windows: [
      {
        window: { application: "Editor", name: "Document", focused: true },
        locator: { processId: 100, objectPath: "/window" },
      },
    ],
    targets: [],
    truncated: false,
  };
  const tools: GuestTools = {
    install: async () => "/private",
    identity: async () => {
      throw new Error();
    },
    session: vi.fn(async (_vm, args) =>
      JSON.stringify({
        ok: true,
        result: args.args?.includes("snapshot") ? snapshot : { activated: true },
      }),
    ),
  };
  const vm = machinePaths("/tmp", "agent-" + "1".repeat(32));
  const controller = makeGuestAccessibility(tools, vm),
    viewer = makeGuestAccessibility(tools, vm);
  const id = (await controller.snapshot()).windows[0]!.id;
  await viewer.snapshot();
  await expect(controller.consume()(id, true)).resolves.toBe(false);
  await expect(controller.consume()(id, true)).rejects.toThrow("expired");
  const old = (await controller.snapshot()).windows[0]!.id;
  await controller.snapshot();
  await expect(controller.consume()(old, true)).rejects.toThrow("expired");
});

import {
  EnvironmentId,
  type ComputerAutomationSnapshot,
  type ComputerAutomationStatus,
  type UserDesktopHumanRequest,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import type { DesktopClient } from "./desktopClient";
import { DesktopViewer } from "./DesktopViewer";

const status: ComputerAutomationStatus = {
  available: true,
  backend: "gnome-wayland-portal",
  permission: "granted",
  displayState: "active",
  keepAwake: true,
  cursor: null,
  displays: [],
  rememberedAccess: [],
  lease: { access: "control", controller: null, canReturnControl: true },
};
const capture: ComputerAutomationSnapshot = {
  display: {
    id: "primary",
    label: "Primary",
    primary: true,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
  },
  frame: {
    id: "f",
    displayId: "primary",
    coordinateSpace: "image-pixels",
    width: 1,
    height: 1,
    toDesktopLogical: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  },
  cursor: null,
  captureSource: "virtual-display",
  screenshot: {
    state: "image",
    contentHash: "sha256-bgra8-v2:" + "a".repeat(43),
    width: 1,
    height: 1,
    mimeType: "image/png",
    encoding: { format: "png" },
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    sizeBytes: 70,
  },
};
function clientWith(
  invoke: DesktopClient<UserDesktopHumanRequest>["invoke"],
): DesktopClient<UserDesktopHumanRequest> {
  const allowed = Atom.make(true);
  return { environmentId: EnvironmentId.make("environment"), permission: () => allowed, invoke };
}

it("releases held physical keys before handing control back to an agent", async () => {
  const calls: string[] = [];
  const client = clientWith(async (request) => {
    if (request.operation === "act")
      calls.push(...request.input.actions.map((a) => a.type + ("key" in a ? " " + a.key : "")));
    else calls.push(request.operation);
    return request.operation === "snapshot" ? capture : status;
  });
  await using screen = await render(
    <DesktopViewer
      desktopId="desktop"
      client={client}
      status={status}
      canControl
      onChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Take control" }));
  const image = screen.getByRole("img", { name: "Live desktop view" });
  await expect.element(image).toBeVisible();
  await act(() => {
    const el = image.element() as HTMLImageElement;
    el.focus();
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", bubbles: true }),
    );
  });
  await vi.waitFor(() => expect(calls).toContain("key_down ShiftLeft"));
  await userEvent.click(screen.getByRole("button", { name: "Return control to agent" }));
  await vi.waitFor(() => expect(calls).toContain("release"));
  expect(calls.indexOf("key_up ShiftLeft")).toBeGreaterThan(calls.indexOf("key_down ShiftLeft"));
  expect(calls.indexOf("return-control")).toBeGreaterThan(calls.indexOf("key_up ShiftLeft"));
  expect(calls.indexOf("release")).toBeGreaterThan(calls.indexOf("return-control"));
});

it("drains an in-flight capture before switching desktops and discards its frame", async () => {
  const started = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<ComputerAutomationSnapshot>();
  const requested: string[] = [];
  const client = clientWith(async (request) => {
    if (!("desktopId" in request)) throw new Error("Missing desktop");
    requested.push(request.desktopId + ":" + request.operation);
    if (request.operation !== "snapshot") return status;
    if (request.desktopId === "old") {
      started.resolve();
      return delayed.promise;
    }
    return { ...capture, screenshot: undefined };
  });
  const panel = (id: string) => (
    <DesktopViewer
      key={id}
      desktopId={id}
      client={client}
      status={status}
      canControl
      onChange={() => {}}
    />
  );
  await using screen = await render(panel("old"));
  try {
    await userEvent.click(screen.getByRole("button", { name: "View live" }));
    await started.promise;
    await screen.rerender(panel("new"));
    await userEvent.click(screen.getByRole("button", { name: "View live" }));
    expect(requested).not.toContain("new:request-view");
  } finally {
    delayed.resolve(capture);
  }
  await vi.waitFor(() => expect(requested).toContain("new:snapshot"));
  expect(requested.indexOf("old:release")).toBeLessThan(requested.indexOf("new:request-view"));
  await expect.element(screen.getByRole("img")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it("cancels a pending open when the user closes the viewer during another desktop’s release", async () => {
  const closing = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const requests: string[] = [];
  const client = clientWith(async (request) => {
    if (!("desktopId" in request)) throw new Error("Missing desktop");
    requests.push(request.desktopId + ":" + request.operation);
    if (request.desktopId === "old" && request.operation === "release") {
      closing.resolve();
      await released.promise;
    }
    return request.operation === "snapshot" ? capture : status;
  });
  const panel = (id: string) => (
    <DesktopViewer
      key={id}
      desktopId={id}
      client={client}
      status={status}
      canControl
      onChange={() => {}}
    />
  );
  await using screen = await render(panel("old"));
  try {
    await userEvent.click(screen.getByRole("button", { name: "View live" }));
    await expect.element(screen.getByRole("img")).toBeVisible();
    await screen.rerender(panel("new"));
    await closing.promise;
    await userEvent.click(screen.getByRole("button", { name: "View live" }));
    await userEvent.click(screen.getByRole("button", { name: "Close viewer" }));
  } finally {
    released.resolve();
  }
  await expect.element(screen.getByRole("button", { name: "View live" })).toBeEnabled();
  expect(requests).not.toContain("new:request-view");
  await expect.element(screen.getByRole("img")).not.toBeInTheDocument();
});

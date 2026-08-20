import type { ReactElement } from "react";
import {
  AgentDesktopControllerId,
  AgentDesktopId,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const effects = vi.hoisted(() => ({
  pending: [] as Array<() => void | (() => void)>,
}));

const commands = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => effects.pending.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("~/state/entities", () => ({
  useThreadShells: () => [],
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: EnvironmentId.make("remote-device"), label: "Laptop" }],
  }),
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { invokeAgentDesktopHuman: Symbol("invokeAgentDesktopHuman") },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => commands.invoke,
}));

import { AgentDesktopSettings } from "./AgentDesktopSettings";

const environmentId = EnvironmentId.make("remote-device");

function renderSettings(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return AgentDesktopSettings() as ReactElement<Record<string, unknown>>;
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (node === null || typeof node !== "object" || !("props" in node)) return "";
  return textContent((node as ReactElement<Record<string, unknown>>).props.children);
}

async function applyEffects(): Promise<void> {
  const pending = effects.pending.splice(0);
  for (const effect of pending) effect();
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe("AgentDesktopSettings compatibility", () => {
  beforeEach(() => {
    hooks.reset();
    effects.pending = [];
    commands.invoke.mockReset().mockResolvedValue({
      _tag: "Success",
      value: {
        available: true,
        desktops: [
          {
            id: AgentDesktopId.make("legacy-desktop"),
            label: "Existing desktop",
            owner: {
              environmentId,
              threadId: ThreadId.make("legacy-thread"),
              controllerId: AgentDesktopControllerId.make("legacy-controller"),
            },
            state: "parked",
            automaticParking: true,
            capabilities: ["computer"],
            controllerId: null,
            viewerCount: 0,
            createdAt: "2026-08-18T00:00:00.000Z",
            lastActiveAt: "2026-08-18T00:00:00.000Z",
            recoverableUntil: null,
            graphics: {
              backend: "virtio-gpu-2d",
              hardwareAccelerated: false,
              renderer: "software",
              checkpointMode: "disk-consistent",
            },
          },
        ],
        requirements: [],
      },
    });
  });

  it("renders an older environment response without maintenance fields", async () => {
    renderSettings();
    await applyEffects();

    let settings: ReactElement<Record<string, unknown>> | undefined;
    expect(() => {
      settings = renderSettings();
    }).not.toThrow();

    expect(textContent(settings)).toContain(
      "Update this environment's T3 Code server to manage Agent desktop system updates.",
    );
    expect(textContent(settings)).toContain("Existing desktop");
  });
});

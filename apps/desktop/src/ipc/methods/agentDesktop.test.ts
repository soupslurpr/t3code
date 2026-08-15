import {
  EnvironmentId,
  ThreadId,
  type AgentDesktop,
  type AgentDesktopOwner,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentDesktopManager from "../../agentDesktop/AgentDesktopManager.ts";
import { command, human, list, setup } from "./agentDesktop.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const owner: AgentDesktopOwner = {
  environmentId,
  threadId,
  controllerId: "controller-1",
};
const desktop: AgentDesktop = {
  id: "desktop-1",
  label: "Agent desktop",
  owner,
  state: "ready",
  capabilities: ["command"],
  graphics: {
    backend: "virtio-gpu-2d",
    hardwareAccelerated: false,
    renderer: "virtio-gpu 2D",
    checkpointMode: "full-state",
  },
  controllerId: null,
  viewerCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  recoverableUntil: null,
};

/** Creates the narrow Agent desktop manager used at the IPC boundary. */
const managerLayer = (commandOwner?: (value: AgentDesktopOwner) => void) => {
  const unexpected = Effect.die("unexpected Agent desktop operation");
  return Layer.succeed(
    AgentDesktopManager.AgentDesktopManager,
    AgentDesktopManager.AgentDesktopManager.of({
      list: Effect.succeed({
        available: true,
        requirements: [],
        desktops: [
          desktop,
          {
            ...desktop,
            id: "desktop-2",
            owner: { ...owner, controllerId: "controller-2" },
          },
        ],
      }),
      setup: Effect.succeed({
        attempted: true,
        completed: true,
        packages: ["passt"],
        imageProvisioned: false,
        status: { available: true, desktops: [], requirements: [] },
      }),
      acquire: () => unexpected,
      manage: () => unexpected,
      command: (receivedOwner) =>
        Effect.sync(() => commandOwner?.(receivedOwner)).pipe(
          Effect.as({
            desktopId: desktop.id,
            exitCode: 0,
            stdout: "ok\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.001Z",
            durationMs: 1,
          }),
        ),
      readFile: () => unexpected,
      writeFile: () => unexpected,
      transfer: () => unexpected,
      cancelTransfer: () => unexpected,
      inspect: () => unexpected,
      createPortRoute: () => unexpected,
      removePortRoute: () => unexpected,
      capturePackets: () => unexpected,
      requestView: () => unexpected,
      requestControl: () => unexpected,
      requestHumanView: () => unexpected,
      requestHumanControl: () => unexpected,
      status: () => unexpected,
      snapshot: () => unexpected,
      act: () => unexpected,
      release: () => unexpected,
      forget: () => unexpected,
    }),
  );
};

describe("Agent desktop IPC methods", () => {
  it.effect("filters an agent list to the broker owner", () =>
    list.handler(owner).pipe(
      Effect.provide(managerLayer()),
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.deepEqual(result, {
            ok: true,
            value: { available: true, desktops: [desktop], requirements: [] },
          });
        }),
      ),
    ),
  );

  it.effect("carries the durable owner into a guest operation", () => {
    let receivedOwner: AgentDesktopOwner | undefined;
    return command
      .handler({
        context: owner,
        input: { executable: "/usr/bin/true" },
      })
      .pipe(
        Effect.provide(
          managerLayer((value) => {
            receivedOwner = value;
          }),
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            assert.deepEqual(receivedOwner, owner);
            assert.equal((result as { readonly ok: boolean }).ok, true);
          }),
        ),
      );
  });

  it.effect("routes host setup and returns its resulting readiness", () =>
    setup.handler({ context: owner }).pipe(
      Effect.provide(managerLayer()),
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.deepEqual(result, {
            ok: true,
            value: {
              attempted: true,
              completed: true,
              packages: ["passt"],
              imageProvisioned: false,
              status: { available: true, desktops: [], requirements: [] },
            },
          });
        }),
      ),
    ),
  );

  it.effect("rejects a guest operation without a durable scope", () =>
    command
      .handler({
        context: { controllerId: owner.controllerId },
        input: { executable: "/usr/bin/true" },
      })
      .pipe(
        Effect.provide(managerLayer()),
        Effect.tap((result) =>
          Effect.sync(() => {
            assert.deepEqual(result, {
              ok: false,
              error: {
                code: "agent-desktop-unavailable",
                category: "resource",
                message: "An Agent desktop is not available on this environment.",
              },
            });
          }),
        ),
      ),
  );

  it.effect("scopes human desktop discovery to its environment", () =>
    human
      .handler({
        context: owner,
        input: { operation: "list" },
      })
      .pipe(
        Effect.provide(managerLayer()),
        Effect.tap((result) =>
          Effect.sync(() => {
            const envelope = result as
              | {
                  readonly ok: true;
                  readonly value: { readonly desktops: ReadonlyArray<AgentDesktop> };
                }
              | { readonly ok: false };
            assert.equal(envelope.ok, true);
            if (envelope.ok) {
              assert.deepEqual(
                envelope.value.desktops.map((value) => value.id),
                ["desktop-1", "desktop-2"],
              );
            }
          }),
        ),
      ),
  );

  it.effect("routes human-approved setup without requiring a desktop owner", () =>
    human
      .handler({
        context: owner,
        input: { operation: "setup" },
      })
      .pipe(
        Effect.provide(managerLayer()),
        Effect.tap((result) =>
          Effect.sync(() => {
            const envelope = result as
              | { readonly ok: true; readonly value: { readonly completed: boolean } }
              | { readonly ok: false };
            assert.equal(envelope.ok, true);
            if (envelope.ok) assert.equal(envelope.value.completed, true);
          }),
        ),
      ),
  );

  it.effect("rejects human management across environments", () =>
    human
      .handler({
        context: owner,
        input: {
          operation: "manage",
          owner: { ...owner, environmentId: EnvironmentId.make("environment-2") },
          input: { operation: "stop", desktopId: desktop.id },
        },
      })
      .pipe(
        Effect.provide(managerLayer()),
        Effect.tap((result) =>
          Effect.sync(() => {
            const envelope = result as
              | { readonly ok: true }
              | { readonly ok: false; readonly error: { readonly code: string } };
            assert.equal(envelope.ok, false);
            if (!envelope.ok) assert.equal(envelope.error.code, "desktop-target-mismatch");
          }),
        ),
      ),
  );
});

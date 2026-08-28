import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as UserDesktops from "./UserDesktops.ts";

const host = {
  protocolVersion: 1 as const,
  desktopId: "user-desktop-1",
  defaultLabel: "coolcrab",
  platform: "linux" as const,
  capabilities: ["view" as const, "control" as const, "availability" as const],
};
const auditThreadId = ThreadId.make("thread-audit-1");

const layer = it.layer(UserDesktops.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("UserDesktopRepository", (it) => {
  it.effect("preserves user metadata while refreshing host registration", () =>
    Effect.gen(function* () {
      const repository = yield* UserDesktops.UserDesktopRepository;
      yield* repository.upsertHost(host, "2026-08-23T00:00:00.000Z");
      yield* repository.rename({ desktopId: host.desktopId, label: "Workstation" });
      yield* repository.markActive(host.desktopId, "2026-08-23T00:01:00.000Z");
      yield* repository.upsertHost(
        { ...host, defaultLabel: "coolcrab.local", capabilities: ["view", "control"] },
        "2026-08-23T00:02:00.000Z",
      );

      assert.deepEqual(yield* repository.list(), [
        {
          desktopId: host.desktopId,
          defaultLabel: "coolcrab.local",
          customLabel: "Workstation",
          platform: "linux",
          capabilities: ["view", "control"],
          lastSeenAt: "2026-08-23T00:02:00.000Z",
          lastActiveAt: "2026-08-23T00:01:00.000Z",
        },
      ]);

      yield* repository.recordAudit({
        desktopId: host.desktopId,
        occurredAt: "2026-08-23T00:03:00.000Z",
        actorKind: "agent",
        action: "view-granted",
        threadId: auditThreadId,
        actorLabel: "codex",
        takeover: false,
      });
      yield* repository.recordAudit({
        desktopId: host.desktopId,
        occurredAt: "2026-08-23T00:04:00.000Z",
        actorKind: "human",
        action: "control-granted",
        takeover: true,
      });
      assert.deepEqual(yield* repository.listAudit(host.desktopId), {
        events: [
          {
            sequence: 2,
            desktopId: host.desktopId,
            occurredAt: "2026-08-23T00:04:00.000Z",
            actorKind: "human",
            action: "control-granted",
            takeover: true,
          },
          {
            sequence: 1,
            desktopId: host.desktopId,
            occurredAt: "2026-08-23T00:03:00.000Z",
            actorKind: "agent",
            action: "view-granted",
            threadId: auditThreadId,
            actorLabel: "codex",
            takeover: false,
          },
        ],
      });

      yield* repository.remove(host.desktopId);
      assert.deepEqual(yield* repository.list(), []);
      assert.deepEqual(yield* repository.listAudit(host.desktopId), { events: [] });
    }),
  );
});

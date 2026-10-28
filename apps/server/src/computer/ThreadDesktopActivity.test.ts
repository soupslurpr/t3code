import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { UserDesktopTransfers } from "./UserDesktopTransfers.ts";
import { AgentDesktopTransferService } from "../agentDesktop/AgentDesktopTransferService.ts";
import { layer, ThreadDesktopActivityService } from "./ThreadDesktopActivity.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const environmentId = EnvironmentId.make("selected-environment");
const threadId = ThreadId.make("selected-thread");

it.effect(
  "bounds command output and history to the owning thread and scopes both transfer registries",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (let ordinal = 0; ordinal < 25; ordinal++) {
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${`command-${ordinal}`}, ${threadId}, ${ordinal}, 'dynamic_tool', 'completed', '2026-10-14T00:00:00Z', ${encode({ toolName: "mcp__t3_code__agent_desktop_command", input: "x".repeat(10_000), output: "y".repeat(20_000) })})`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
    VALUES ('foreign', 'another-thread', 100, 'dynamic_tool', 'completed', '2026-10-14T00:00:00Z', ${encode({ toolName: "user_desktop_command", output: "Foreign output" })})`;
      const calls: string[] = [];
      const result = yield* Effect.gen(function* () {
        return yield* (yield* ThreadDesktopActivityService).read(threadId);
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
            ),
            Layer.provide(
              Layer.mock(UserDesktopTransfers)({
                download: () => null,
                listForThread: (environment, thread) =>
                  Effect.sync(() => {
                    calls.push(`user:${environment}:${thread}`);
                    return [];
                  }),
              }),
            ),
            Layer.provide(
              Layer.mock(AgentDesktopTransferService)({
                listForThread: (environment, thread) =>
                  Effect.sync(() => {
                    calls.push(`agent:${environment}:${thread}`);
                    return [];
                  }),
              }),
            ),
          ),
        ),
      );
      assert.equal(result.commands.length, 20);
      assert.equal(result.commands[0]?.id, "command-24");
      assert.equal(result.commands.at(-1)?.id, "command-5");
      assert.equal(result.commands[0]?.input.length, 4096);
      assert.equal(result.commands[0]?.output.length, 8192);
      assert.deepEqual(calls, [
        `user:${environmentId}:${threadId}`,
        `agent:${environmentId}:${threadId}`,
      ]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

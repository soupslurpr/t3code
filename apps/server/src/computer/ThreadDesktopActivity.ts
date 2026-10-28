import { ThreadDesktopActivityError, ThreadDesktopCommand, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { AgentDesktopTransferService } from "../agentDesktop/AgentDesktopTransferService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { UserDesktopTransfers } from "./UserDesktopTransfers.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* ServerEnvironment;
  const userTransfers = yield* UserDesktopTransfers;
  const agentTransfers = yield* AgentDesktopTransferService;
  // Read only recent tool rows and truncate large outputs in SQLite, before decoding or sending.
  const commands = SqlSchema.findAll({
    Request: ThreadId,
    Result: ThreadDesktopCommand,
    execute: (threadId) => sql`
      SELECT turn_item_id AS id, json_extract(payload_json, '$.toolName') AS tool,
        status, updated_at AS "updatedAt",
        substr(COALESCE(json_extract(payload_json, '$.input'), ''), 1, 4096) AS input,
        substr(COALESCE(json_extract(payload_json, '$.output'), ''), 1, 8192) AS output
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND type = 'dynamic_tool'
        AND (json_extract(payload_json, '$.toolName') LIKE '%user_desktop_command'
          OR json_extract(payload_json, '$.toolName') LIKE '%user_desktop_process'
          OR json_extract(payload_json, '$.toolName') LIKE '%agent_desktop_command'
          OR json_extract(payload_json, '$.toolName') LIKE '%desktop_copy')
      ORDER BY ordinal DESC, turn_item_id DESC LIMIT 20
    `,
  });
  const read = Effect.fn("ThreadDesktopActivity.read")(
    function* (threadId: ThreadId) {
      const environmentId = yield* environment.getEnvironmentId;
      const users = yield* userTransfers.listForThread(environmentId, threadId);
      const agents = yield* agentTransfers.listForThread(environmentId, threadId);
      return {
        commands: yield* commands(threadId),
        transfers: [
          ...users.map((transfer) => ({
            id: `user:${transfer.id}`,
            label: `${transfer.workspacePath} · ${transfer.desktop.desktopId} · ${transfer.direction}`,
            state: transfer.state,
            transferredBytes: transfer.transferredBytes,
            totalBytes: transfer.totalBytes,
            error: transfer.error?.detail ?? null,
          })),
          ...agents.map((transfer) => ({
            id: `agent:${transfer.id}`,
            label: `${transfer.source.path} → ${transfer.destination.path}`,
            state: transfer.state,
            transferredBytes: transfer.transferredBytes,
            totalBytes: transfer.totalBytes,
            error: transfer.error?.detail ?? null,
          })),
        ],
      };
    },
    Effect.mapError(
      () =>
        new ThreadDesktopActivityError({
          message: "Could not read desktop activity for this thread.",
        }),
    ),
  );
  return { read };
});
export class ThreadDesktopActivityService extends Context.Service<
  ThreadDesktopActivityService,
  Effect.Success<typeof make>
>()("t3/computer/ThreadDesktopActivity/ThreadDesktopActivityService") {}
export const layer = Layer.effect(ThreadDesktopActivityService, make);

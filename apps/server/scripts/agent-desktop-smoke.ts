// @effect-diagnostics nodeBuiltinImport:off - The smoke harness owns isolated host files.
/** Verifies the server-owned Agent desktop runtime against an isolated state directory. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentDesktopTransferId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  extractAgentDesktopBundle,
  packAgentDesktopBundle,
} from "@t3tools/shared/agentDesktopBundle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentDesktopEnvironment from "../src/agentDesktop/AgentDesktopEnvironment.ts";
import * as AgentDesktopManager from "../src/agentDesktop/AgentDesktopManager.ts";
import * as QemuAgentDesktop from "../src/agentDesktop/QemuAgentDesktop.ts";
import * as ComputerAutomationRouter from "../src/computer/ComputerAutomationRouter.ts";
import * as ServerConfig from "../src/config.ts";
import * as PreviewAutomationBroker from "../src/mcp/PreviewAutomationBroker.ts";
import * as UserDesktops from "../src/persistence/UserDesktops.ts";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../..");
const verifyUpdate = process.argv.slice(2).includes("--update");
const verifyBaseUpdate = process.argv.slice(2).includes("--update-base");
const runtimeArguments = process.argv
  .slice(2)
  .filter(
    (argument) => argument !== "--" && argument !== "--update" && argument !== "--update-base",
  );
if (runtimeArguments.length !== 1) {
  throw new Error(
    "usage: node scripts/agent-desktop-smoke.ts <isolated-base-directory> [--update] [--update-base]",
  );
}
const runtimeRootArgument = runtimeArguments[0]!;
const runtimeRoot = NodePath.resolve(runtimeRootArgument);
const userT3Root = process.env.HOME && NodePath.resolve(process.env.HOME, ".t3");
if (
  userT3Root !== undefined &&
  (runtimeRoot === userT3Root || runtimeRoot.startsWith(`${userT3Root}${NodePath.sep}`))
) {
  throw new Error("refusing to run Agent desktop smoke test inside the user's T3 home");
}

const environmentLayer = AgentDesktopEnvironment.layer.pipe(
  Layer.provide(ServerConfig.layerTest(repositoryRoot, runtimeRoot)),
  Layer.provide(NodeServices.layer),
);
const qemuLayer = QemuAgentDesktop.layer.pipe(
  Layer.provide(environmentLayer),
  Layer.provide(NodeServices.layer),
);
const managerLayer = AgentDesktopManager.layer.pipe(
  Layer.provide(qemuLayer),
  Layer.provide(environmentLayer),
  Layer.provide(NodeServices.layer),
);
const brokerLayer = PreviewAutomationBroker.layer.pipe(
  Layer.provide(UserDesktops.layerMemory),
  Layer.provide(NodeServices.layer),
);
const computerLayer = ComputerAutomationRouter.layer.pipe(
  Layer.provide(brokerLayer),
  Layer.provide(managerLayer),
);
const runtimeLayer = Layer.merge(managerLayer, computerLayer);

const scope = {
  environmentId: EnvironmentId.make("environment-server-smoke"),
  threadId: ThreadId.make("thread-server-smoke"),
  providerSessionId: "controller-server-smoke",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["computer"] as const),
  issuedAt: 0,
};
const owner = {
  environmentId: scope.environmentId,
  threadId: scope.threadId,
  controllerId: scope.providerSessionId,
};
const message = "environment server transfer: exact Unicode ’ →\n";

const program = Effect.scoped(
  Effect.gen(function* () {
    const manager = yield* AgentDesktopManager.AgentDesktopManager;
    const computer = yield* ComputerAutomationRouter.ComputerAutomationRouter;
    const listed = yield* manager.list;
    if (!listed.available) throw new Error(listed.detail ?? "Agent desktops unavailable");
    const runDirectory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(runtimeRoot, "smoke-")),
    );
    const sourceDirectory = NodePath.join(runDirectory, "transfer-source");
    const importedArchive = NodePath.join(runDirectory, "import.bundle");
    const exportedArchive = NodePath.join(runDirectory, "export.bundle");
    const extractedDirectory = NodePath.join(runDirectory, "transfer-result");
    const baseMaintenance = verifyBaseUpdate
      ? yield* Effect.gen(function* () {
          const queued = yield* manager.update(owner, { target: { kind: "base-image" } });
          if (!queued.accepted) throw new Error("Agent desktop base update was already active");
          const completed = yield* manager.awaitUpdate(owner, {
            target: { kind: "base-image" },
          });
          if (completed.status !== "current") {
            throw new Error(completed.detail ?? `Agent desktop base update ${completed.status}`);
          }
          const refreshed = (yield* manager.list).baseImage;
          if (refreshed.generation === null || refreshed.maintenance.status !== "current") {
            throw new Error("Agent desktop base update did not activate a managed generation");
          }
          return refreshed;
        })
      : undefined;

    const desktop = yield* manager.acquire(owner, {
      fresh: true,
      label: "Environment server smoke",
      requirements: { graphics: "none", latency: "interactive" },
    });
    return yield* Effect.gen(function* () {
      const control = yield* computer.requestControl(scope, {
        desktop: { kind: "agent", desktopId: desktop.id },
        observation: false,
      });
      const snapshot = yield* computer.snapshot(scope, {
        desktop: { kind: "agent", desktopId: desktop.id },
        includeAccessibility: false,
        screenshot: { maxWidth: 800, maxHeight: 450 },
      });
      if (snapshot.screenshot?.state !== "image") {
        throw new Error("Agent desktop snapshot did not return an image");
      }
      const actions = yield* computer.act(scope, {
        desktop: { kind: "agent", desktopId: desktop.id },
        actions: [{ type: "press", key: "Meta" }],
        observation: {
          includeAccessibility: false,
          delayMs: 1_000,
          screenshot: { maxWidth: 800, maxHeight: 450 },
        },
      });
      if (actions.snapshot?.screenshot?.state !== "image") {
        throw new Error("Agent desktop post-input snapshot did not return an image");
      }
      const evidenceScreenshot = actions.snapshot.screenshot;
      const evidencePath = NodePath.join(
        runDirectory,
        `agent-desktop-smoke.${evidenceScreenshot.mimeType === "image/png" ? "png" : "webp"}`,
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(evidencePath, Buffer.from(evidenceScreenshot.data, "base64")),
      );

      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sourceDirectory, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(sourceDirectory, "message.txt"), message);
      });
      const packed = yield* Effect.promise(() =>
        packAgentDesktopBundle({
          sourcePath: sourceDirectory,
          outputPath: importedArchive,
          compression: "gzip",
        }),
      );
      const imported = yield* manager.transfer(owner, {
        operation: "import",
        transferId: AgentDesktopTransferId.make("transfer-server-smoke-import"),
        desktopId: desktop.id,
        archivePath: importedArchive,
        guestPath: "~/server-runtime-smoke",
        collision: "replace",
        compression: packed.compression,
        sizeBytes: packed.wireBytes,
        sha256: packed.sha256,
      });
      const verified = yield* manager.command(owner, {
        desktopId: desktop.id,
        executable: "/usr/bin/cat",
        arguments: ["/home/t3agent/server-runtime-smoke/message.txt"],
      });
      if (verified.exitCode !== 0 || verified.stdout !== message) {
        throw new Error(`guest import verification failed: ${verified.stderr}`);
      }

      const exported = yield* manager.transfer(owner, {
        operation: "export",
        transferId: AgentDesktopTransferId.make("transfer-server-smoke-export"),
        desktopId: desktop.id,
        archivePath: exportedArchive,
        guestPath: "~/server-runtime-smoke",
        compression: "gzip",
      });
      const extracted = yield* Effect.promise(() =>
        extractAgentDesktopBundle({
          archivePath: exportedArchive,
          destinationPath: extractedDirectory,
          compression: exported.compression,
          collision: "create",
        }),
      );
      const roundTripMessage = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(extractedDirectory, "message.txt"), "utf8"),
      );
      if (roundTripMessage !== message) throw new Error("guest export changed file contents");

      const released = yield* computer.release(scope, {
        desktop: { kind: "agent", desktopId: desktop.id },
      });
      const maintenance = verifyUpdate
        ? yield* Effect.gen(function* () {
            yield* manager.manage(owner, { operation: "stop", desktopId: desktop.id });
            const queued = yield* manager.update(owner, {
              target: { kind: "desktop", desktopId: desktop.id },
            });
            if (!queued.accepted) throw new Error("Agent desktop update was already active");
            const completed = yield* manager.awaitUpdate(owner, {
              target: { kind: "desktop", desktopId: desktop.id },
            });
            if (completed.status !== "current") {
              throw new Error(completed.detail ?? `Agent desktop update ${completed.status}`);
            }
            yield* manager.acquire(owner, { desktopId: desktop.id });
            yield* computer.requestControl(scope, {
              desktop: { kind: "agent", desktopId: desktop.id },
              observation: false,
            });
            const verifiedSnapshot = yield* computer.snapshot(scope, {
              desktop: { kind: "agent", desktopId: desktop.id },
              includeAccessibility: false,
              screenshot: { maxWidth: 800, maxHeight: 450 },
            });
            if (verifiedSnapshot.screenshot?.state !== "image") {
              throw new Error("updated Agent desktop snapshot did not return an image");
            }
            yield* computer.release(scope, {
              desktop: { kind: "agent", desktopId: desktop.id },
            });
            return completed;
          })
        : undefined;
      return {
        prerequisites: listed.requirements.length,
        runDirectory,
        ...(baseMaintenance === undefined ? {} : { baseMaintenance }),
        desktopId: desktop.id,
        backend: control.status?.backend,
        screenshot: {
          width: evidenceScreenshot.width,
          height: evidenceScreenshot.height,
          sizeBytes: evidenceScreenshot.sizeBytes,
          encoding: evidenceScreenshot.encoding,
          path: evidencePath,
        },
        actionResults: actions.actionResults,
        released: released.permission,
        ...(maintenance === undefined ? {} : { maintenance }),
        imported: {
          wireBytes: imported.wireBytes,
          sha256: imported.sha256,
          tree: imported.tree,
        },
        exported: {
          wireBytes: exported.wireBytes,
          sha256: exported.sha256,
          tree: exported.tree,
        },
        extracted,
      };
    }).pipe(
      Effect.ensuring(
        manager
          .manage(owner, { operation: "delete-permanently", desktopId: desktop.id })
          .pipe(Effect.ignore),
      ),
    );
  }),
).pipe(Effect.provide(runtimeLayer));

const result = await Effect.runPromise(program);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

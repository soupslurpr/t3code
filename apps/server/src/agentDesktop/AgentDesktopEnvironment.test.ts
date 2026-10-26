import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as AgentDesktopEnvironment from "./AgentDesktopEnvironment.ts";

it.effect("keeps Agent state below its server and honors explicit image overrides", () =>
  Effect.gen(function* () {
    const make = (env: Record<string, string>) =>
      AgentDesktopEnvironment.make.pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-environment-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      );
    const defaults = yield* make({});
    assert.match(defaults.agentDesktopsDir, /t3-agent-environment-.*[/\\]agent-desktops$/);
    const custom = yield* make({
      T3CODE_AGENT_DESKTOP_HOME: " /isolated/agents ",
      T3CODE_AGENT_DESKTOP_IMAGE: " /images/base.qcow2 ",
    });
    assert.equal(custom.agentDesktopsDir, "/isolated/agents");
    assert.deepEqual(custom.agentDesktopBaseImage, Option.some("/images/base.qcow2"));
  }),
);

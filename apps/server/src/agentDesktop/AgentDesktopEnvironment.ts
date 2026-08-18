/** Resolves host paths and resources for the environment-owned Agent desktop runtime. */
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/** Reads one optional environment override without retaining blank values. */
const optionalTrimmedString = (name: string) =>
  Config.string(name).pipe(
    Config.option,
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed.length === 0 ? Option.none() : Option.some(trimmed);
      }),
    ),
  );

export interface AgentDesktopEnvironmentShape {
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly agentDesktopsDir: string;
  readonly agentDesktopBaseImage: Option.Option<string>;
  readonly resolveResourcePathCandidates: (fileName: string) => ReadonlyArray<string>;
}

export class AgentDesktopEnvironment extends Context.Service<
  AgentDesktopEnvironment,
  AgentDesktopEnvironmentShape
>()("t3/agentDesktop/AgentDesktopEnvironment") {}

/** Creates the Agent desktop environment from server-owned configuration. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcessPlatform;
  const processArch = yield* HostProcessArchitecture;
  const overrides = yield* Config.all({
    home: optionalTrimmedString("T3CODE_AGENT_DESKTOP_HOME"),
    image: optionalTrimmedString("T3CODE_AGENT_DESKTOP_IMAGE"),
  });
  const agentDesktopsDir = Option.getOrElse(overrides.home, () =>
    path.join(config.stateDir, "agent-desktops"),
  );

  return AgentDesktopEnvironment.of({
    path,
    platform,
    processArch,
    agentDesktopsDir,
    agentDesktopBaseImage: overrides.image,
    resolveResourcePathCandidates: (fileName) => [
      path.resolve(import.meta.dirname, "../../resources", fileName),
      path.resolve(import.meta.dirname, "resources", fileName),
      path.resolve(config.cwd, "apps/server/resources", fileName),
    ],
  });
});

export const layer = Layer.effect(AgentDesktopEnvironment, make);

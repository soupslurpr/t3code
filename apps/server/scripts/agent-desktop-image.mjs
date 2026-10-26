/** Exposes the packaged Agent desktop image builder as a repository command. */

import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { main } from "../resources/agent-desktop/image-builder.mjs";

export {
  AGENT_DESKTOP_PROFILE_VERSION,
  AgentDesktopImageArgumentError,
  AgentDesktopImageDownloadError,
  PINNED_ARCH_IMAGE,
  agentDesktopCloudConfig,
  buildAgentDesktopImage,
  downloadPinnedAgentDesktopSource,
  parseAgentDesktopImageArguments,
  pinnedImageDownloadPlan,
  verifyAgentDesktopSourceImage,
} from "../resources/agent-desktop/image-builder.mjs";

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  await main();
}

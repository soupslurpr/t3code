import { createFileRoute } from "@tanstack/react-router";

import { AgentDesktopSettings } from "../components/settings/AgentDesktopSettings";

export const Route = createFileRoute("/settings/agent-desktops")({
  component: AgentDesktopSettings,
});

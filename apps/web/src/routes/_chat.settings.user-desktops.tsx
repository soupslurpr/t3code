import { createFileRoute } from "@tanstack/react-router";

import { UserDesktopSettings } from "../components/settings/UserDesktopSettings";

export const Route = createFileRoute("/_chat/settings/user-desktops")({
  component: UserDesktopSettings,
});

import { createFileRoute } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { AgentDesktops } from "~/components/computer/AgentDesktops";
import { SettingsPageContainer } from "~/components/settings/settingsLayout";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";

function SettingsAgentDesktops() {
  const { environment } = useSettingsScope();
  const gt = useGT();
  return (
    <SettingsPageContainer>
      {environment ? (
        <AgentDesktops key={environment.environmentId} environmentId={environment.environmentId} />
      ) : (
        gt("Connect an environment to manage desktops.")
      )}
    </SettingsPageContainer>
  );
}
export const Route = createFileRoute("/_chat/settings/agent-desktops")({
  component: SettingsAgentDesktops,
});

import { createFileRoute } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { UserDesktops } from "~/components/computer/UserDesktops";
import { SettingsPageContainer } from "~/components/settings/settingsLayout";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";

function SettingsUserDesktops() {
  const { environment } = useSettingsScope();
  const gt = useGT();
  return (
    <SettingsPageContainer>
      {environment ? (
        <UserDesktops key={environment.environmentId} environmentId={environment.environmentId} />
      ) : (
        gt("Connect an environment to manage desktops.")
      )}
    </SettingsPageContainer>
  );
}
export const Route = createFileRoute("/_chat/settings/user-desktops")({
  component: SettingsUserDesktops,
});

import { useAtomValue } from "@effect/atom-react";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import {
  AuthFilesystemReadScope,
  type AuthGrantScope,
  type EnvironmentId,
  type UserDesktopPairingPreset,
  isUserDesktopId,
  userDesktopHostPairingScopes,
} from "@t3tools/contracts";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { authEnvironment } from "../../state/auth";
import { serverEnvironment } from "../../state/server";
import { environmentSession, readEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { CopyTextButton } from "../threads/CopyTextButton";
import { Errors, Panel } from "./SupervisionLayout";
import { commandValue, useDesktopAction } from "./desktopRequests";

function scopesEqual(
  left: ReadonlyArray<AuthGrantScope>,
  right: ReadonlyArray<AuthGrantScope>,
): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

interface IssuedMobileEnrollment {
  readonly id: string;
  readonly preset: UserDesktopPairingPreset;
  readonly scopes: ReadonlyArray<AuthGrantScope>;
  readonly value: string;
}

export function DesktopEnrollment({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const messages = useMessages();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const issue = useAtomCommand(authEnvironment.createPairingCredential, { reportFailure: false });
  const [desktopId, setDesktopId] = useState("");
  const [preset, setPreset] = useState<UserDesktopPairingPreset | null>(null);
  const [issued, setIssued] = useState<IssuedMobileEnrollment | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const action = useDesktopAction();
  const issuer = AsyncResult.isSuccess(session) ? session.value : null;
  const hostOnly = issuer ? userDesktopHostPairingScopes("host-only", issuer) : null;
  if (
    !config?.environment.capabilities?.userDesktopHostPairing ||
    managedCapabilityDenial(config.managedPolicy, "remoteClients", messages) ||
    issuer === null ||
    hostOnly === null
  )
    return null;
  const standard = userDesktopHostPairingScopes("standard", issuer);
  const hostCommands = userDesktopHostPairingScopes("host-commands", issuer);
  const selection =
    preset === "standard"
      ? standard
      : preset === "host-commands"
        ? hostCommands
        : preset === "host-only"
          ? hostOnly
          : null;
  const id = desktopId.trim();
  const omittedLabels =
    preset === "standard" && standard
      ? standard.omitted.map((scope) => {
          const option = AUTH_SCOPE_OPTIONS.find((candidate) => candidate.scope === scope);
          return option ? messages(option.title) : scope;
        })
      : [];
  const missingFileRead =
    preset === "standard" &&
    standard !== null &&
    standard.omitted.includes(AuthFilesystemReadScope);
  const activeIssued =
    selection !== null &&
    issued !== null &&
    issued.id === id &&
    issued.preset === preset &&
    scopesEqual(issued.scopes, selection.scopes)
      ? issued
      : null;
  const selectPreset = (next: UserDesktopPairingPreset) => {
    setPreset(next);
    setIssued(null);
    setSelectionError(null);
  };
  return (
    <Panel title={gt("Pair a User desktop")}>
      <Text>
        {gt(
          "Enter the ID shown in User desktops on the destination computer. Use the pairing code in that desktop app under Environments → Add environment.",
        )}
      </Text>
      <AppTextInput
        accessibilityLabel={gt("User desktop ID")}
        placeholder={gt("User desktop ID")}
        value={desktopId}
        onChangeText={(value) => {
          setDesktopId(value);
          if (value.trim() !== id) setPreset(null);
          setIssued(null);
          setSelectionError(null);
        }}
        maxLength={128}
        editable={!action.busy}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View>
        <ListChoiceRow
          label={
            standard && standard.omitted.length > 0
              ? gt("Standard desktop (limited)")
              : gt("Standard desktop")
          }
          description={
            standard && standard.omitted.length > 0
              ? gt(
                  "Standard client permissions your current session can grant, plus desktop hosting.",
                )
              : gt(
                  "Standard T3 Code client access (files, Git, terminals, settings, access) plus desktop hosting.",
                )
          }
          selected={preset === "standard"}
          disabled={action.busy || standard === null}
          onPress={() => selectPreset("standard")}
        />
        <ListChoiceRow
          separated
          label={gt("Desktop hosting + commands")}
          description={gt(
            "Desktop hosting with thread, preview, and terminal/command-management access for this session.",
          )}
          selected={preset === "host-commands"}
          disabled={action.busy || hostCommands === null}
          onPress={() => selectPreset("host-commands")}
        />
        <ListChoiceRow
          separated
          label={gt("Desktop hosting only")}
          description={gt(
            "Desktop hosting with thread and preview control; omits file browsing, Git writes, settings changes, and terminal access for this session.",
          )}
          selected={preset === "host-only"}
          disabled={action.busy}
          onPress={() => selectPreset("host-only")}
        />
      </View>
      {omittedLabels.length > 0 && (
        <View className="gap-1">
          <Text className="text-xs text-foreground-muted">
            {gt("Not included with your current permissions: {permissions}.", {
              permissions: omittedLabels.join(", "),
            })}
          </Text>
          {missingFileRead && (
            <Text className="text-xs text-warning-foreground">
              {gt("This desktop will not be able to open host files in the built-in file viewer.")}
            </Text>
          )}
        </View>
      )}
      <Text className="text-xs text-foreground-muted">
        {gt(
          "Pairing again at the same address replaces that desktop’s saved permissions for this connection.",
        )}
      </Text>
      <Button
        size="compact"
        label={gt("Create desktop pairing code")}
        disabled={!isUserDesktopId(id) || selection === null}
        loading={action.busy}
        onPress={() =>
          void action.run(async () => {
            if (!isUserDesktopId(id) || preset === null || selection === null) return;
            const liveSession = readEnvironmentSessionState(environmentId);
            const live = liveSession ? userDesktopHostPairingScopes(preset, liveSession) : null;
            if (live === null || !scopesEqual(live.scopes, selection.scopes)) {
              setIssued(null);
              setSelectionError(
                gt("Your permissions changed. Review the selected permissions and try again."),
              );
              return;
            }
            setSelectionError(null);
            setIssued(null);
            const result = commandValue(
              await issue({
                environmentId,
                input: {
                  purpose: "user-desktop-host",
                  userDesktopId: id,
                  label: gt("User desktop {id}", { id }),
                  scopes: selection.scopes,
                },
              }),
            );
            setIssued({ id, preset, scopes: selection.scopes, value: result.credential });
          })
        }
      />
      <Errors error={selectionError ?? action.error} />
      {activeIssued && (
        <>
          <Text>
            <T>
              On that desktop, enter the environment address and this one-time code in Add
              environment, or Add route for a saved environment.
            </T>
          </Text>
          <View className="flex-row items-center gap-2">
            <Text selectable className="font-mono">
              {activeIssued.value}
            </Text>
            <CopyTextButton
              accessibilityLabel={gt("Copy pairing code")}
              text={activeIssued.value}
            />
          </View>
        </>
      )}
    </Panel>
  );
}

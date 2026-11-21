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
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { authEnvironment } from "~/state/auth";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentSessionState, useEnvironmentSessionState } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { DesktopError, DesktopSection } from "./DesktopControls";
import { desktopError } from "./desktopClient";

function isUserDesktopPairingPreset(value: unknown): value is UserDesktopPairingPreset {
  return value === "standard" || value === "host-commands" || value === "host-only";
}

function scopesEqual(
  left: ReadonlyArray<AuthGrantScope>,
  right: ReadonlyArray<AuthGrantScope>,
): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

interface IssuedEnrollmentCode {
  readonly id: string;
  readonly preset: UserDesktopPairingPreset;
  readonly scopes: ReadonlyArray<AuthGrantScope>;
  readonly value: string;
}

export function DesktopEnrollment({
  environmentId,
  nativeHostId,
}: {
  environmentId: EnvironmentId;
  nativeHostId: string | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [local] = useState(() => window.desktopBridge?.getUserDesktopHost?.());
  const [knownNativeHostId, setKnownNativeHostId] = useState<string | null>(nativeHostId);
  if (nativeHostId !== null && nativeHostId !== knownNativeHostId) {
    setKnownNativeHostId(nativeHostId);
  }
  const resolvedNativeHostId = nativeHostId ?? knownNativeHostId;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const { data: session, hasError } = useEnvironmentSessionState(environmentId);
  const [desktopId, setId] = useState("");
  const [preset, setPreset] = useState<UserDesktopPairingPreset | null>(null);
  const [code, setCode] = useState<IssuedEnrollmentCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const issue = useAtomCommand(authEnvironment.createPairingCredential, { reportFailure: false });
  const copy = useCopyToClipboard({ onError: (cause) => setError(cause.message) });
  const id = desktopId.trim();
  const pairingDenial = managedCapabilityDenial(config?.managedPolicy, "remoteClients", messages);
  const supportsHostPairing = config?.environment.capabilities?.userDesktopHostPairing === true;
  const unavailableReason =
    pairingDenial ??
    (config !== null && !supportsHostPairing
      ? gt("This environment does not support User desktop enrollment.")
      : null);
  const issuer = !hasError && session ? session : null;
  const standard = issuer ? userDesktopHostPairingScopes("standard", issuer) : null;
  const hostCommands = issuer ? userDesktopHostPairingScopes("host-commands", issuer) : null;
  const hostOnly = issuer ? userDesktopHostPairingScopes("host-only", issuer) : null;
  const selection =
    preset === "standard"
      ? standard
      : preset === "host-commands"
        ? hostCommands
        : preset === "host-only"
          ? hostOnly
          : null;
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
  const activeCode =
    unavailableReason === null &&
    selection !== null &&
    code !== null &&
    code.id === id &&
    code.id !== resolvedNativeHostId &&
    code.preset === preset &&
    scopesEqual(code.scopes, selection.scopes)
      ? code
      : null;

  const enroll = async () => {
    if (
      unavailableReason !== null ||
      !isUserDesktopId(id) ||
      id === resolvedNativeHostId ||
      preset === null ||
      selection === null
    ) {
      return;
    }
    const liveSession = readEnvironmentSessionState(environmentId);
    const live = liveSession ? userDesktopHostPairingScopes(preset, liveSession) : null;
    if (live === null || !scopesEqual(live.scopes, selection.scopes)) {
      setCode(null);
      setError(gt("Your permissions changed. Review the selected permissions and try again."));
      return;
    }
    setError(null);
    setBusy(true);
    setCode(null);
    const result = await issue({
      environmentId,
      input: { purpose: "user-desktop-host", userDesktopId: id, scopes: selection.scopes },
    });
    if (result._tag === "Failure") setError(desktopError(squashAtomCommandFailure(result)));
    else setCode({ id, preset, scopes: selection.scopes, value: result.value.credential });
    setBusy(false);
  };

  return (
    <DesktopSection title={gt("Enroll a desktop")}>
      {local && (
        <p>
          {gt("This desktop’s ID")} <code className="select-all">{local.desktopId}</code>{" "}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void copy.copyToClipboard(local.desktopId)}
          >
            {gt("Copy ID")}
          </Button>
          {session?.userDesktopHostId === local.desktopId && <span> · {gt("Enrolled")}</span>}
        </p>
      )}
      {unavailableReason !== null ? (
        <p className="text-sm text-muted-foreground">{unavailableReason}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {gt(
              "Enter the ID shown in User desktops on the destination computer. Use the pairing code in that desktop app under Environments → Add environment.",
            )}
          </p>
          <label className="grid gap-1 text-sm">
            {gt("Desktop ID")}
            <Input
              value={desktopId}
              maxLength={128}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value;
                setId(next);
                if (next.trim() !== id) setPreset(null);
                setCode(null);
                setError(null);
              }}
            />
          </label>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{gt("Access level")}</legend>
            <RadioGroup
              value={preset ?? ""}
              onValueChange={(value) => {
                if (!isUserDesktopPairingPreset(value)) return;
                setPreset(value);
                setCode(null);
                setError(null);
              }}
            >
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 px-3 py-2 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60">
                <Radio value="standard" disabled={busy || standard === null} className="mt-0.5" />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">
                    {standard && standard.omitted.length > 0
                      ? gt("Standard desktop (limited)")
                      : gt("Standard desktop")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {standard && standard.omitted.length > 0
                      ? gt(
                          "Standard client permissions your current session can grant, plus desktop hosting.",
                        )
                      : gt(
                          "Standard T3 Code client access (files, Git, terminals, settings, access) plus desktop hosting.",
                        )}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 px-3 py-2 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60">
                <Radio
                  value="host-commands"
                  disabled={busy || hostCommands === null}
                  className="mt-0.5"
                />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">{gt("Desktop hosting + commands")}</span>
                  <span className="text-xs text-muted-foreground">
                    {gt(
                      "Desktop hosting with thread, preview, and terminal/command-management access for this session.",
                    )}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 px-3 py-2 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60">
                <Radio value="host-only" disabled={busy || hostOnly === null} className="mt-0.5" />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">{gt("Desktop hosting only")}</span>
                  <span className="text-xs text-muted-foreground">
                    {gt(
                      "Desktop hosting with thread and preview control; omits file browsing, Git writes, settings changes, and terminal access for this session.",
                    )}
                  </span>
                </span>
              </label>
            </RadioGroup>
          </fieldset>
          {omittedLabels.length > 0 && (
            <div className="grid gap-1 text-xs text-muted-foreground">
              <p>
                {gt("Not included with your current permissions: {permissions}.", {
                  permissions: omittedLabels.join(", "),
                })}
              </p>
              {missingFileRead && (
                <p className="text-warning-foreground">
                  {gt(
                    "This desktop will not be able to open host files in the built-in file viewer.",
                  )}
                </p>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {gt(
              "Pairing again at the same address replaces that desktop’s saved permissions for this connection.",
            )}
          </p>
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy || selection === null || !isUserDesktopId(id) || id === resolvedNativeHostId
              }
              onClick={() => void enroll()}
            >
              {gt("Create pairing code")}
            </Button>
          </div>
          {activeCode && (
            <div className="grid gap-2">
              <label className="grid gap-1">
                {gt("Pairing code")}
                <Input
                  readOnly
                  value={activeCode.value}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void copy.copyToClipboard(activeCode.value)}
                >
                  {gt("Copy pairing code")}
                </Button>
              </div>
            </div>
          )}
          {id && id === resolvedNativeHostId && (
            <p>{gt("This environment enrolls its native desktop automatically.")}</p>
          )}
        </>
      )}
      <DesktopError message={error} />
    </DesktopSection>
  );
}

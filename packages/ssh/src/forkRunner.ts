import { forkBuildIdentity } from "@t3tools/shared/forkBuildIdentity";

import { shellSingleQuote } from "./command.ts";

export const forkSshRecovery =
  "Install the audited fork package on the SSH host, or pin its audited standalone CLI with T3CODE_SSH_FORK_CLI_SHA256. See https://github.com/soupslurpr/t3code/blob/main/docs/operations/local-arch-package.md#desktop-ssh. For another running installation, use its own pairing URL.";

export interface RunningForkBuild {
  readonly version: string;
  readonly revision: string | null;
}

export function buildForkRunner(input: {
  readonly nodeEnv: string;
  readonly nodeScriptPath: string;
  readonly version: string;
  readonly runningBuild?: RunningForkBuild | undefined;
}) {
  const identity = `${forkBuildIdentity.repository} ${forkBuildIdentity.channel}`;
  const expectedVersion = input.runningBuild?.version ?? input.version;
  const sourceCheck = expectedVersion
    ? `[ "$T3_ID" = ${shellSingleQuote(`${identity} ${expectedVersion}`)} ]`
    : `[ "\${T3_ID% *}" = ${shellSingleQuote(identity)} ]`;
  const revisionArgument = input.runningBuild?.revision
    ? ` ${shellSingleQuote(input.runningBuild.revision)}`
    : "";
  const select = input.nodeScriptPath
    ? `ensure_remote_node_path || return 1
  T3_EXE=node
  T3_ENTRY=${shellSingleQuote(input.nodeScriptPath)}
  matches_fork_build`
    : `T3_PACKAGE=t3code-soupslurpr-bin
  T3_ROOT="$(pacman -Qlq "$T3_PACKAGE" 2>/dev/null | sed -n 's,/resources/app[.]asar$,,p')"
  T3_EXE="$T3_ROOT/t3code"
  T3_ASAR="$T3_ROOT/resources/app.asar"
  if [ -n "$T3_ROOT" ] && [ "$(pacman -Qqo "$T3_EXE" 2>/dev/null)" = "$T3_PACKAGE" ] &&
     [ "$(pacman -Qqo "$T3_ASAR" 2>/dev/null)" = "$T3_PACKAGE" ]; then
    export ELECTRON_RUN_AS_NODE=1
    T3_ENTRY="$T3_ASAR/apps/server/dist/bin.mjs"
    if matches_fork_build; then
      unset T3CODE_CLI_PATH
      export T3CODE_RESOURCE_MONITOR_PATH="$T3_ROOT/resources/resource-monitor/t3-resource-monitor"
      return 0
    fi
    unset ELECTRON_RUN_AS_NODE
  fi
  T3_PIN="\${T3CODE_SSH_FORK_CLI_SHA256:-}"
  [ "\${#T3_PIN}" -eq 64 ] || return 1
  T3_ENTRY=""
  T3_VERSION=${shellSingleQuote(input.version)}
  for T3_CANDIDATE in "$(command -v t3 2>/dev/null || :)" "$HOME/.t3/runtime/versions/$T3_VERSION/t3"; do
    [ -f "$T3_CANDIDATE" ] && [ -x "$T3_CANDIDATE" ] || continue
    # The open descriptor binds the hash, identity query and execution across an atomic replacement.
    command exec 3<"$T3_CANDIDATE" || continue
    T3_EXE=/dev/fd/3
    # A checksum of a shell or npm shim would leave the runtime it dispatches to unverified.
    case "$(od -An -N4 -tx1 "$T3_EXE" | tr -d '[:space:]')" in
      7f454c46|cffaedfe|feedfacf|cafebabe|bebafeca|cafebabf|bfbafeca) ;;
      *) continue ;;
    esac
    if command -v sha256sum >/dev/null 2>&1; then
      T3_SUM="$(sha256sum < "$T3_EXE")" || continue
    else
      T3_SUM="$(shasum -a 256 < "$T3_EXE")" || continue
    fi
    [ "\${T3_SUM%% *}" = "$T3_PIN" ] && matches_fork_build && return 0
  done
  return 1`;
  return `#!/bin/sh
set -eu
${input.nodeScriptPath ? input.nodeEnv : ""}
fork_cli() {
  if [ -n "$T3_ENTRY" ]; then set -- "$T3_ENTRY" "$@"; fi
  exec "$T3_EXE" "$@"
}
matches_fork_build() {
  T3_ID="$(T3CODE_HOME=/dev/null fork_cli __ssh-fork-identity${revisionArgument} 2>/dev/null)" && ${sourceCheck}
}
select_fork_cli() {
  ${select}
}
if [ "$#" -gt 0 ]; then
  if select_fork_cli; then fork_cli "$@"; fi
  printf '%s\\n' ${shellSingleQuote(forkSshRecovery)} >&2
  exit 1
fi`;
}

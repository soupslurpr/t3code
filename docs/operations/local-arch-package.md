# Local Arch package

The x86_64 package is `t3code-soupslurpr-bin`. This fork ships a
source-bound identity. Desktop and server updaters, release-track switches,
`t3 update`, `t3 up`, the Connect setup alias and service downloaders
refuse upstream releases, including on a fresh installation. Update the
installed package from the fork checkout. Keep its provenance receipt.

## Build and audit

Start with a clean checkout at the commit you intend to install. Install
Arch devtools, base-devel, desktop-file-utils and the repository's Node,
Vite+ and Rust toolchains. Building the Linux helpers also needs libei,
libwebp, GStreamer development files, pkg-config and libsecret.

```sh
vp i
vp run dist:desktop:linux
vp run package:desktop:arch:prepare
```

Prepare reads the version and commit from the AppImage's embedded ASAR
and picks the next package release across installed and published versions.
It derives the fork PKGBUILD from the tracked AUR recipe and checks the
license, source checksums and generated `.SRCINFO`. Use `--appimage PATH`
for a different artifact location or `--pkgrel N` for an explicit release.

```sh
(cd release/arch-package && set -o pipefail && extra-x86_64-build 2>&1 | tee extra-x86_64-build.log)
vp run package:desktop:arch:publish
```

Publish verifies clean-chroot provenance, package metadata, launcher and
icons, Chromium's mode-4755 sandbox, and the full installed payload against
the AppImage. It compares Agent desktop resources and native binaries to
the source checkout. VM images and debug builds stay outside the package.

The audited package and its SHA-256 provenance file appear in `release/`.
Publish removes the stage on success. Use `--keep-stage` to inspect it, or
`vp run package:desktop:arch:clean` to remove a prepared stage.

## Install and verify

Install the exact file printed by publish with `sudo pacman -U <package>`.
Pacman asks to replace the conflicting upstream package on the first
installation. Retain the current data directory through upgrades. Quit
and reopen Desktop for a manual restart.

```sh
vp run package:desktop:arch:verify installation --commit FULL_COMMIT --hashes --port PORT
```

## Supervise a restart

Dry-run with the app’s user unit, its backend listener PID, its open database and an active root thread.

```sh
vp run package:desktop:arch:restart --package /absolute/package.pkg.tar.zst \
  --commit FULL_COMMIT --unit UNIT --backend-pid PID \
  --state-db /absolute/userdata/statev2.sqlite --thread-id THREAD
```

Use `--backend-unit UNIT` for a separate backend or `--migration-monitor ID` for the first V1 upgrade.
`--apply` installs and schedules the restart after 60 seconds (`--delay-seconds` accepts 1–600).
Before signalling, the worker rechecks the package, hashes, PIDs, units, cgroups and database.
Project settings and managed policy must allow continuation. A stop, blocking request, settlement
or snooze prevents the V2 handoff. The active turn must already show provider work. Verify the printed plan.

```sh
vp run package:desktop:arch:verify restart /absolute/restart-directory/plan.json --port PORT
```

Verification checks provider output, executed tools or generated tokens for the exact turn that
continued, superseded or finished the captured work. V1 requires execution of the imported monitor’s
input. Delivery into an existing turn also needs a provider receipt for that message. `terminalOutcome`
reports completion, interruption or failure when known. Silent turns and older records without proof
stay pending. Verify again after work appears. `--cleanup` removes recovery files only on success.

## Desktop SSH

Install this audited fork on the SSH host or pin its standalone CLI with
`T3CODE_SSH_FORK_CLI_SHA256`. A running server must match the selected
build. Use the installed fork CLI for pairing, service recovery and triage.
Report fork startup issues to [the fork](https://github.com/soupslurpr/t3code/issues).

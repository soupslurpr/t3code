# Local Arch package

This runbook builds and installs the `soupslurpr/t3code` desktop fork on Arch Linux. It packages a
locally built AppImage and must not be confused with the official `t3code-bin` AUR package, which
downloads artifacts from `pingdotgg/t3code`.

## Prerequisites

Install the Arch build tools once:

```bash
sudo pacman -Syu --needed base-devel devtools desktop-file-utils
```

The workspace also needs Node and Vite+ as described in the
[developer setup](../../CONTRIBUTING.md#developer-setup).

## Update and verify the source

1. Record the current upstream base, then fetch only upstream `main` and the fork's `main`.
2. Review the incoming upstream range and report notable changes using the
   [fork maintenance guidance](../../AGENTS.md#fork-maintenance), including features that default
   to off. Share the findings before installing or restarting the updated app.
3. Rebase the fork commits onto the selected upstream commit. Do not introduce merge commits or
   duplicate fork changes.
4. Install dependencies with `vp i` when the lockfile changed.
5. Run focused tests, typechecks, lint, and formatting checks for the integrated changes.
6. Commit every integration adjustment and push the clean linear `main` branch.

The package helper requires a clean checkout and later rejects publication if `HEAD` changed after
preparation. A moving upstream remote does not invalidate the selected build commit; start another
update only after finishing or abandoning the current package.

## Build the AppImage

From the repository root:

```bash
vp run dist:desktop:linux
```

This produces `release/T3-Code-<version>-x86_64.AppImage`. Audit any behavior-specific invariants
that focused tests cannot prove before preparing the package.

## Prepare the clean-chroot package

Run:

```bash
vp run package:desktop:arch:prepare
```

Preparation:

- verifies that the AppImage's embedded version and commit match the clean checkout;
- selects one greater than the highest matching installed or published `pkgrel`;
- derives a local-source recipe from the current in-repo AUR `PKGBUILD`;
- copies the AppImage and license into `release/arch-package`;
- records source, recipe, AppImage, and license hashes in a stage manifest; and
- runs PKGBUILD syntax, source checksum, and `.SRCINFO` preflight checks.

Use `--pkgrel N`, `--appimage PATH`, or `--stage-dir PATH` only for an intentional recovery or
nonstandard artifact. Preparation refuses to overwrite an existing stage.

## Build in the clean Arch chroot

Run the exact command printed by preparation:

```bash
cd /home/soupslurpr/projects/t3code/release/arch-package
set -o pipefail
extra-x86_64-build 2>&1 | tee extra-x86_64-build.log
```

`extra-x86_64-build` may request host authorization because it maintains the clean chroot. Do not
replace it with an ordinary host `makepkg` build: that would weaken build isolation and provenance.

## Audit and publish

After the clean-chroot build succeeds, return to the repository root and run:

```bash
vp run package:desktop:arch:publish
```

Publication fails closed unless all of these hold:

- package name, version, fork URL, architecture, and `devtools` build provenance are exact;
- the Chromium sandbox is recorded as mode `4755`;
- the `/opt/t3code-bin` payload is byte-for-byte identical to the verified AppImage;
- launchers, desktop metadata, licenses, icons, and directory permissions are valid;
- packaged desktop and Agent desktop resources match the committed sources;
- the ASAR version and commit match the stage manifest; and
- no VM image, partial disk, debug tree, or obsolete external Agent desktop resource is bundled.

The command copies the audited package to `release/`, writes a provenance JSON sidecar, removes the
temporary stage, and prints the package SHA-256 and installation command. Pass `--keep-stage` only
when retaining clean-chroot logs for diagnosis.

If a prepared stage must be abandoned, remove it safely with:

```bash
vp run package:desktop:arch:clean
```

The cleanup command refuses to remove a directory without a valid generated-stage manifest.

## Install

Run the command printed by publication, for example:

```bash
sudo pacman -U /home/soupslurpr/projects/t3code/release/t3code-bin-0.0.33-38-x86_64.pkg.tar.zst
```

Fully quit and relaunch T3 Code after installation. Future fork updates repeat this runbook and use a
new package release. Do not update this installation with `yay -S t3code-bin`: that package follows
official upstream releases and can replace the fork behavior.

### Restart from the thread doing the update

When the controlling agent runs inside the app being updated, use the guarded helper instead of
manually installing and quitting. This Linux/user-systemd workflow keeps the installed app's state
location and resumes the existing durable thread; it does not preserve the old provider process.

1. Record the selected full commit, audited package path, completed checks, and any database backup
   in saved work notes. Keep rollback packages and never restore a database automatically.
2. Enable automatic thread continuation after restart in the environment's settings and keep this
   turn running. The helper checks that both durable session records identify the same unfinished
   turn and that the provider has a resume cursor. T3 resumes that turn when the server restarts;
   no monitor or extra wait is needed.
3. Resolve the current app's user systemd unit and backend listening-port owner again. The unit may
   be a `.service` or a desktop-launcher `.scope`. Confirm the app executable, backend ASAR path,
   and state database before supplying their identities. If GNOME moved the app after it spawned the
   backend, their control groups differ; supply the backend's exact unit with `--backend-unit`.
   Both units must remain active, and any service must still identify this app as its main process.
   Preview:

   ```bash
   vp run package:desktop:arch:restart \
     --package /absolute/path/to/audited.pkg.tar.zst \
     --commit FULL_40_CHARACTER_COMMIT \
     --unit CURRENT_APP.scope --backend-pid BACKEND_PID \
     --state-db /absolute/path/to/userdata/state.sqlite \
     --thread-id CURRENT_THREAD_ID
   ```

4. Repeat with `--apply` to install and queue the restart. The helper requires noninteractive sudo
   authorization for `pacman -U` if the package is not installed yet. It verifies package hashes,
   installed metadata, file integrity, exact process ownership and the selected continuation.
   A copied standalone worker and private plan live under `~/.local/state/t3code-maintenance/`, so
   relaunch does not depend on the provider, checkout, or temporary build directories surviving.
5. Record the printed recovery-plan path and service/timer names in saved work notes and continue working.
   Do not finish the turn before restart: an idle thread has no unfinished work to resume. The
   independent worker starts after sixty seconds, checks that the captured turn is still running,
   revalidates the handoff, sends only SIGTERM to the captured app, and waits for that app and backend
   to exit before replacing itself with the installed launcher. It never forces termination or
   starts a second app after a shutdown timeout.
6. On continuation, inspect the restart service's journal and discover the actual new app unit,
   backend, and port. GNOME may move the relaunched app into a fresh `.scope` even while the service
   still reports its MainPID. Check HTTP readiness and the embedded commit against the recovery
   plan, and confirm this same thread resumed. A queued timer or successful package installation
   alone is not deployment completion.

The repository verifier prints JSON and returns a failing exit status when installation or restart
checks fail. It reads process identities, active units, and database file descriptors without opening
the database. Use the actual listening port:

```bash
vp run package:desktop:arch:verify workspace /absolute/path/to/checkout
vp run package:desktop:arch:verify installation --commit FULL_40_CHARACTER_COMMIT --hashes --port PORT
vp run package:desktop:arch:verify restart /absolute/path/to/plan.json --port PORT
```

Each command has a five-second deadline. `--app-dir` selects another installed desktop directory.

If a guard fails, inspect the exact error and recovery plan before retrying; the helper does not
silently bypass a failed check. Cancel an abandoned restart timer explicitly. Installations
with custom app arguments or a backend not directly owned by the app need a separately reviewed
restart procedure. Never reuse recorded PIDs as future restart targets or edit live T3 state.

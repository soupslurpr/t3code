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

1. Fetch only upstream `main` and the fork's `main`.
2. Rebase the fork commits onto the selected upstream commit. Do not introduce merge commits or
   duplicate fork changes.
3. Install dependencies with `vp i` when the lockfile changed.
4. Run focused tests, typechecks, lint, and formatting checks for the integrated changes.
5. Commit every integration adjustment and push the clean linear `main` branch.

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
   in the current thread tracker. Keep rollback packages and never restore a database automatically.
2. Create a durable `monitor_start` timer in this thread, with `continuation: "resume-thread"` and a
   deadline about ten minutes away. Its `resumePrompt` must say to read the tracker, avoid repeating
   completed deployment steps, verify the new service/backend, HTTP readiness, installed/running
   commit and same-thread resumption, and report any failure. Do not use an in-process sleep.
3. Resolve the current app's user service and backend listening-port owner again. Confirm the app
   executable, backend ASAR path, and state database before supplying their identities. Preview:

   ```bash
   vp run package:desktop:arch:restart \
     --package /absolute/path/to/audited.pkg.tar.zst \
     --commit FULL_40_CHARACTER_COMMIT \
     --service CURRENT_APP.service --backend-pid BACKEND_PID \
     --state-db /absolute/path/to/userdata/state.sqlite \
     --thread-id CURRENT_THREAD_ID --monitor-id PENDING_MONITOR_ID
   ```

4. Repeat with `--apply` to install and queue the restart. The helper requires noninteractive sudo
   authorization for `pacman -U` if the package is not installed yet. It verifies package hashes,
   installed metadata, file integrity, exact process ownership and a persisted future continuation.
   A copied standalone worker and private plan live under `~/.local/state/t3code-maintenance/`, so
   relaunch does not depend on the provider, checkout, or temporary build directories surviving.
5. Record the printed recovery-plan path and service/timer names in the tracker and finish the turn.
   The independent worker starts after sixty seconds, revalidates the handoff, sends only SIGTERM
   to the captured app service's main process, waits for that app and backend to exit, then replaces
   itself with the installed launcher. It never escalates to a forced kill or starts a second app
   after a shutdown timeout.
6. On continuation, inspect the new service and its journal, discover the new backend/port, check
   HTTP readiness and the embedded commit against the recovery plan, and confirm this same thread
   resumed. A queued timer or successful package installation alone is not deployment completion.

If a guard fails, inspect the exact error and recovery plan before retrying; the helper does not
silently bypass a failed check. Cancel an abandoned timer and continuation explicitly. Installations
with custom app arguments or a backend not directly owned by the app need a separately reviewed
restart procedure. Never reuse recorded PIDs as future restart targets or edit live T3 state.

## Retain rollback builds

Preview reclaimable build artifacts with `vp run package:desktop:arch:prune`. Add `--apply` to
delete the listed archives and AppImages, or `--keep N` to retain more than three builds. The
helper preserves the newest builds, the installed build and its recent rollback candidates,
and all publication receipts. It verifies retained packages and deletion candidates before
removing anything. Deleted binaries can be rebuilt, but are not moved to trash.

Only direct `release/` artifacts with matching publication receipts and hashes qualify. Unmanaged
files, unpublished AppImages, database backups, test directories, and VM/backing disks are left
alone. Do not prune concurrently with packaging or installation. Inspect backing chains and live
references separately before removing old test state; a retired VM directory can still supply a
base disk to another desktop.

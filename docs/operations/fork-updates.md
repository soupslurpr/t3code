# Updating a fork installation

This fork blocks built-in desktop and server updates, track switches, `t3 update`,
`t3 up`, its `t3 connect` setup alias, and service install/repair paths that fetch or replace a runtime. CLI
refusal precedes configuration initialization, network-setting changes, and
rollback restarts. The upstream release feed does not authenticate a target's fork provenance or acknowledge the
exact upstream, fork, and legacy migration history. A version, channel, Git hash
in JSON, successful `--version`, or `.install-complete` file is not that proof.
Use the fork's audited manual package procedure, such as
[local Arch packaging](local-arch-package.md). Manual package-manager operations
are outside the built-in update guard and still need their own compatibility review.

The guard uses source-bound build identity even for a fresh database. Recorded
fork or legacy history also blocks an otherwise upstream build of the guard.
Unreadable histories, gaps, or mismatched known identities also block updates.
A retained upstream launcher accepts a contiguous newer upstream suffix when
there is no fork provenance; its target can add migrations beyond the launcher's
own manifest. This does not supply target proof for a fork installation. All local
backends are covered by the fork desktop's refusal before any track change or
download. Connecting that desktop to a genuine upstream remote environment does
not change the remote environment's own update policy.

## Retained launcher transition

Replacing the server does not replace a launcher that is already running. Older
launchers can start a cached pending target before the new server's guard runs.
This transition is **not code-covered**. Promotion to each environment remains
blocked until its operator completes and records all of the following:

1. Inventory that environment's service manager unit or launch agent, exact
   launcher PID and process start identity, executable path and hash, command,
   T3 home, `runtime/service-state.json`, and active/pending runtime paths and
   hashes. Obtain the PID from the specific service manager or a captured spawn,
   not process-name matching. On Linux, inspect that PID's `/proc` executable,
   command and start identity; do not dump the process environment or credentials.
   Record all backend database paths, including a pending record's `dbPath`.
2. Revalidate ownership and process start identity, then stop only that captured
   owned launcher and its known service unit so it cannot automatically restart.
   Wait for its owned child to finish. Never use a pattern kill. If ownership or
   a child's drain cannot be established, stop the transition for investigation.
3. Inspect the state and database histories read-only after shutdown. Preserve
   copies and hashes of the state, relevant database/WAL files, and any existing
   update backup or restore marker. Do not start a runtime against them to
   discover whether it is compatible. A pending update may already have migrated
   the database, so simply deleting its record or choosing its previous version
   is unsafe. Resolve it using verified matching history and recovery evidence,
   or quarantine the pending state and associated recovery material without
   deleting anything. Keep the environment stopped if a safe resolution is unknown.
4. Replace the launcher and package with the audited fork artifacts. Check the
   service's actual executable path, not just the command found on `PATH`.
   Confirm that the selected active runtime is also the intended fork build.
   Do not use the blocked `t3 update` or service install/repair downloader as a
   workaround; install the verified package and configure its owned launcher
   through the approved manual installation procedure.
5. Start the new launcher with a captured PID. A still-pending incompatible
   update must report `Pending update retained without starting any runtime`
   and stop before spawning a child, clearing markers, making a database backup,
   restoring data, or rewriting state. Resolve that refusal manually; do not
   change the cached target's version marker to bypass it. After safe resolution,
   verify the launched child is the approved active fork runtime and no cached
   target started before the guard. Record the launcher and child binary hashes,
   logs, state/database hashes and process evidence.

An isolated new-launcher test does not complete this checklist for an installed
environment. Record that environment's retained-launcher acceptance as
`BLOCKED-UNAVAILABLE` until the actual transition has been performed and evidenced.
Do not delete recovery material as part of this transition.

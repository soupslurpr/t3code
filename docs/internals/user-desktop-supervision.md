# User Desktop Supervision

> For maintainers. Using T3 Code? See [Computer use](../user/computer-use.md).

User desktop supervision lets an authenticated human inspect and control the physical graphical
session exposed by a T3 desktop client. It reuses the computer-automation contract and desktop host;
the environment server remains the authenticated routing and metadata boundary.

## Identity And Routing

The desktop client registers one stable opaque User desktop id, label, platform, and capability set
on every environment connection. Each environment persists an offline inventory, but the physical
desktop host owns active permission and lease state. Routes from several environments therefore
converge on one host-wide control boundary. A duplicate live identity inside one environment is an
identity conflict and blocks routing.

Every request names the exact User desktop id. The preview-automation broker routes only to a live
host claiming that id; client focus is selection metadata and never a fallback. A disconnected or
unsupported target fails explicitly. Human supervision uses the same privileged environment RPC as
other User desktop Settings operations and does not depend on an active agent.

This is an operational authorization boundary, not a sandbox between an authorized coding agent and
the machine running it. The provider already runs under the environment owner's operating-system
account. The portal prompt, lease model, indicators, and audit history make graphical capture and
input explicit, attributable, and reversible; they do not claim to isolate the host from an
otherwise privileged provider.

## Host-Wide Leases

The desktop coordinator keys holders by environment, thread, logical controller, and controller
kind. View leases are shared. Control is exclusive:

- an agent cannot preempt another controller;
- a human can preempt an agent in the same environment directly;
- a human taking over another human or a controller from another environment must return the opaque
  id of the exact conflicting lease reported by status;
- a human takeover acquires the action semaphore, invalidates queued agent actions, and releases
  tracked keys and pointer buttons before installing the new controller.

The displaced same-environment agent remains a viewer. While the human still controls, an explicit
return operation can atomically restore control to that still-viewing agent. Releasing human control
to view instead leaves the controller slot empty and clears the return candidate. Neither operation
stops the provider turn.

Status reveals the controller kind everywhere but includes its thread only on the same environment
route. This makes a cross-environment conflict and confirmation possible without leaking another
environment's thread identity.

Human holders have a 30-second lease renewed by status, snapshots, and actions. A five-second sweep
removes expired holders, releases tracked input when necessary, closes native sharing when the last
holder leaves, and removes the human keep-awake request when the last human lease ends. Web/desktop
also releases when the supervisor closes or becomes hidden; mobile releases when its route closes or
the app backgrounds. The expiry remains the disconnect backstop. Local physical input does not
mutate remote lease ownership. The owner-only force-release operation clears every holder and pending
authorization.

## Passive Lens And Live Viewing

Opening supervision is passive. The User desktop Settings RPC lists retained observation summaries
without requesting portal access or capturing a frame. The shared observation store keeps the latest
entry per desktop, thread, and recipient, preserving the exact image bytes and coordinate transform
already delivered by a computer tool or watch evaluator. Reads are scoped to the current environment
and selected desktop.

The store is memory-only. Entries expire after 30 minutes and are globally bounded to 128
observations and 128 MiB of compressed images, evicting the least-recent entries while retaining the
newest valid result. Summary reads omit image bytes; selecting an id reads that exact observation.

Live is a separate explicit view request. Clients poll snapshots at a low fixed cadence, retain prior
bytes when the content fingerprint is unchanged, and refresh after input. They expose the host's
display list. Web and desktop require full screen for human keyboard capture; mobile uses a dedicated
route. The web client suppresses Live for its own physical User desktop to prevent recursive
mirroring while preserving Lens and access management.

## Durable Access Metadata

After a host reports a successful access transition, the broker best-effort records one
environment-local audit row. Recorded actions cover view and control grants, release to view, return
to agent, releasing one holder, force-releasing all holders, remembering view or control, and
forgetting approval. Each row contains:

- desktop id, sequence, and ISO timestamp;
- human or agent actor kind;
- agent thread and provider label when applicable;
- action and a boolean indicating confirmed takeover.

The table never receives screenshots, typed text, accessibility data, action payloads, session ids,
or opaque takeover tokens. Reads return the newest 50 rows, and removing an offline inventory record
also deletes that desktop's rows. No time-based retention promise is defined yet.

Web/desktop and mobile merge audit windows from every route to the same physical desktop, sort them
by occurrence time, and surface the newest entries on its Settings card. Routine five-second
inventory polling reuses the prior audit window; initial, manual, and post-mutation refreshes fetch
it again.

## Related

- [Computer-use contracts][contracts]
- [Desktop lease coordinator][coordinator]
- [Preview-automation routing][broker]
- [Observation retention][observations]
- [User desktop persistence][persistence]
- [Agent desktops](./agent-desktops.md)

[contracts]: ../../packages/contracts/src/computerAutomation.ts
[coordinator]: ../../apps/desktop/src/computer/ComputerUseCoordinator.ts
[broker]: ../../apps/server/src/mcp/PreviewAutomationBroker.ts
[observations]: ../../apps/server/src/computer/ComputerObservationStore.ts
[persistence]: ../../apps/server/src/persistence/UserDesktops.ts

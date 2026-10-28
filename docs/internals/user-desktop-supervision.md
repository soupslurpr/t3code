# User desktop supervision

A User desktop is a physical graphical session exposed by a desktop client. Its stable identity
is shared across environment routes, but each environment keeps its own offline inventory.
The host owns the active native permission and logical leases: two environment servers must not
both grant exclusive control independently. Duplicate live identities fail routing explicitly;
client focus never substitutes for the requested desktop.

The environment authenticates human requests independently of any active agent turn. The broker
supplies controller kind from that authenticated scope; callers cannot choose it in an action.
The host keys holders by controller kind, environment and logical controller. Agent controller
identities already include the owning thread. Status reveals a controller's thread only to the
same environment route.

View is shared and control is exclusive. An agent cannot preempt another controller. A human may
preempt an agent in the same environment; taking over a human or a different environment requires
the opaque token of the conflicting lease. The handoff cancels active and queued agent input and
releases tracked keys and buttons before control changes. The displaced agent remains a viewer,
so an explicit return can restore its control without stopping either provider turn. Release
removes one holder; the owner-only force release clears all holders and pending authorization.

Human leases renew on status, snapshots and actions. Expiry releases native access when the last
holder leaves and removes human keep-awake requests while preserving separate agent availability.
It is a disconnect backstop, not remembered access. Native consent and remembered access remain
separate decisions. These boundaries make graphical use attributable and reversible; they do not
sandbox a provider already running as the environment's operating-system user.

Retained model observations and live capture are separate. The observation service lists summaries
without native access and reads exact bytes scoped to environment and desktop. It retains the
latest entry per recipient and thread in bounded, expiring memory; restart clears this evidence.
A later capture cannot reconstruct what a model previously saw.

See the [lease coordinator](../../apps/desktop/src/computer/ComputerUseCoordinator.ts),
[human request service](../../apps/server/src/computer/UserDesktopHuman.ts), and
[observation store](../../apps/server/src/computer/ComputerObservationStore.ts).

Access history belongs to the environment that routed the successful request.
Clients combine those histories by physical desktop identity while retaining
the environment on each event. The durable audit stores only access metadata;
retained observation images remain bounded, ephemeral evidence in memory.

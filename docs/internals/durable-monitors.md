# Durable thread monitors

A durable wait outlives its provider process. The owning thread comes from the
MCP caller, and delivery uses that thread's current provider and permission
configuration. Trigger summaries and evidence are observational data, never
instructions. The existing conversation supplies continuation context.

Monitor restoration must start after V2 recovery and legacy shell import.
Otherwise an imported thread can look absent and its waits can be retired as
orphans. Liveness comes from persisted outstanding rows; system notices wake
projection subscribers after each lifecycle change.

A continuation keeps one logical message ID across retries. Native steering
stays pending until provider acceptance; a cancelled outbox effect after
shutdown can retry it as a follow-up. Provider acceptance and its durable
receipt cannot commit atomically, so delivery is at least once across a crash.
Stable IDs prevent duplicate timeline entries. Reconcile accepted messages
before checking current work, which may be the continuation itself.

Fork migrations have a separate ledger from upstream. Recognition of released
ID/name pairs precedes both migrators under one SQLite write transaction. An
existing fork ledger cannot prove adoption completed; both histories must be
validated, and missing migrations must be verified before committing.

Computer watches store durable desktop coordinates, never expiring frame IDs.
Their stable monitor controller owns only a view lease; release must not
depend on reading a thread that deletion has already removed. Restart checks
reacquire that same view identity. Exact evaluator selection is persisted; an
unavailable provider or model degrades the watch without substitution.

Throttling coalesces observations, not images. Persist a pending evaluation
when a change occurs inside the budget window; an unchanged later sample
still needs evaluation when that window expires, including after restart.

A region plan and its baseline images form one revision and must commit in the
same transaction. The controller supplies the expected revision; the evaluator
only reports facts and cannot alter strategy. Reviews keep the monitor active
and use a separate, revision-bound delivery identity. Recover an accepted review
before checking whether its resulting run now makes the thread busy.

The default health-review policy applies to new watches only. Preserve a stored
null policy or explicitly disabled failure threshold when revising a watch;
normalizing omission to the new default would silently re-enable warnings.

Monitor continuations are V2 notifications, not user-message turn items. Keep
structured observations separate from harness facts and render the full
provider input at start or native steering. Live delivery preserves the active
selection and waits for approvals or user-input requests. Codex uses standalone
harness tool output and must reject unsupported protocol versions; silently
falling back to user input would change the event's provenance. Other adapters
receive explicitly labelled provider-neutral text. The orchestrator queues a
follow-up when native input is unsupported or would interrupt tools. A Codex
completion race can start another native turn in the same app attempt; Stop
and background-work ownership must follow that replacement. The legacy message column must remain for deferred V1 import.

Usage fields remain independent: input, cached input, cache-write input and
output are reported exactly when supplied, with null for unavailable data.
Migration must not reset a retained cache-write count or rebucket other
counts. Older append-only review events may lack the cache-write field.

Controller cache timing must come from that thread's exact current provider
instance and model, never an evaluator or a custom-model fallback. A minimum
lifetime starts when an eligible cache entry is created or refreshed; it is
not a remaining lifetime or expiration deadline. Omit it when unknown.

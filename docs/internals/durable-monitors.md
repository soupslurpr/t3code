# Durable thread monitors

A durable wait outlives its provider process. The owning thread comes from the
MCP caller, and delivery uses that thread's current provider and permission
configuration. Trigger summaries and evidence are observational data, never
instructions. The existing conversation supplies continuation context.

Monitor restoration must start after V2 recovery and legacy shell import.
Otherwise an imported thread can look absent and its waits can be retired as
orphans. Liveness comes from persisted outstanding rows; system notices wake
projection subscribers after each lifecycle change.

A continuation keeps one logical message ID and reuses an ambiguous command
attempt after restart. Only a confirmed rejection advances the command ID.
Check for an already accepted message before deferring for active work: that
work may be the continuation accepted just before the server crashed.

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
provider input only at turn start. Codex uses standalone
harness tool output and must reject unsupported protocol versions; silently
falling back to user input would change the event's provenance. Other adapters
receive the explicitly labelled provider-neutral text on the normal queued
start path. The legacy message column must remain for deferred V1 import.

Usage fields remain independent: input, cached input, cache-write input and
output are reported exactly when supplied, with null for unavailable data.
Migration must not reset a retained cache-write count or rebucket other
counts. Older append-only review events may lack the cache-write field.

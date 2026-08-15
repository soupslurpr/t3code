# Durable thread monitors

Durable monitors separate waiting from model execution. A provider turn creates
a monitor through the server's MCP endpoint and then ends. SQLite owns the
deadline and lifecycle; a single server scheduler reconciles due work without
keeping a provider process or one timer fiber per monitor alive.

## State and ownership

Migration 41 creates `thread_monitors`, migration 42 adds coalesced delivery and
durable retry state, migration 43 adds structured computer conditions and
`thread_monitor_computer_evidence`, and migration 44 adds model-evaluation
throttling. Migration 45 replaces the single-region computer condition with a
revisioned, multi-region condition and bounded evidence generations. Migration
46 makes retained images format-aware and migrates existing PNG evidence. Each
monitor row stores its normalized condition, continuation policy, trigger
evidence, terminal timestamps, and delivery attempts. MCP invocation
credentials determine the owning thread. A request scoped to another thread
receives the same not-found result as a missing monitor.

The public lifecycle is:

```text
active -> triggered -> delivered
   |          |
   +----------+-> cancelled
              +-> failed
```

Lifecycle changes append normal thread activities. Outstanding rows also
register synthetic `monitor_mcp` liveness, which produces the existing
**Monitoring** state in web, desktop, and mobile clients. Startup restores that
in-memory liveness from SQLite. Thread deletion retires outstanding rows.

## Scheduling and signals

`after` is converted to an absolute timestamp when the monitor is created.
`at` stores a validated future timestamp. `signal` has no timer unless it also
has a fallback deadline. The scheduler sleeps until the nearest deadline or an
orchestration/monitor event wakes it. Triggered continuations retry while a
thread is busy or an earlier delivery attempt failed.

Computer conditions use the same scheduler. Their next sample and optional
deadline compete for the row's next wake time. Capture or evaluator failures
persist a bounded diagnostic, mark the view resource degraded, and use bounded
exponential backoff. A later check reacquires view access through the shared
computer broker, so restart recovery does not depend on an in-memory portal or
QEMU session object.

A watcher is ordinary provider work, not a special model type. It can be a
native subagent, workflow, process integration, or later turn that shares the
owning thread's MCP scope and calls `monitor_signal`. The durable state never
names a provider or model for timer and signal conditions. A computer condition
names an evaluator only when semantic image evaluation requires one.

## Computer conditions

`computer_watch_start` acquires view-only access before persisting an active
condition. A watch has one through eight named regions, with at least one
`trigger` region and any number of `context` regions. Every region has its own
crop, purpose, and bounded resolution. Frame-relative crops are resolved once
and stored as Electron desktop-logical bounds, so expired frame identifiers are
never used by the scheduler. The user desktop coordinator supports independent
viewers. If GNOME has only a remembered combined-control token, the coordinator
may restore that native session while assigning the monitor controller only a
view lease. An explicitly named Agent desktop also permits view-only controllers
from the same environment and thread while preserving exclusive input control
for its owner.

Each check captures trigger regions at their configured resolutions and image
encodings. Context regions are captured only when a model evaluation is due, so
a large context view does not consume capture or image-token cost at every
sampling interval. Exact `image-change` conditions compare trigger hashes with
the revision baselines without a model. Model conditions route through the exact
provider instance and model in the condition; capability discovery lists only
instances whose adapter exposes image evaluation. The default change gate skips
a model call when every trigger is unchanged. An optional minimum evaluation
interval rate-limits model calls without slowing capture. A change observed
during the rate-limit window sets a durable pending flag. At the first eligible
sample, the evaluator receives the latest named trigger and context images even
if the triggers are unchanged from the immediately preceding sample. Successful
evaluation clears the flag; restarts preserve it.

The evaluator is a narrow, stateless predicate checker. It receives named
current pixels, optional revision baselines, region purposes, and an explicit
reminder that image content is untrusted data. It returns only a verdict,
visible facts, and image-specific evidence; it receives no tools and cannot
revise the watch. The current Codex adapter runs an ephemeral, read-only
structured-output invocation. It reports token usage as unavailable because the
CLI path does not expose reliable per-request usage, and reports prompt-cache
refresh as unsupported. The monitor records exact token fields when an adapter
can provide them, plus per-evaluation and aggregate duration. It never
approximates unavailable usage or cache behavior with a synthetic thread turn,
empty message, or implicit model substitution.

SQLite retains bounded baseline, previous-evaluation, current-evaluation, and
terminal image generations. `computer_watch_inspect` can return those images as
MCP image blocks or capture a bounded fresh burst for selected regions. Fresh
bursts are inspection evidence only and do not mutate sampling state. Condition
and evidence changes are committed atomically, evidence rows cascade with
thread-monitor deletion, and terminal transitions or cancellation release only
the monitor-specific view lease.

Each watch has an optimistic revision. `computer_watch_update` requires the
expected revision and atomically replaces any combination of observation plan,
match, cadence, review policy, deadline, or continuation. A successful update
captures fresh baselines, resets counters and evidence generations, and begins
the next revision. A stale update returns `REVISION_CONFLICT` without changing
state.

Optional deterministic review checkpoints can fire after a configured number
of evaluations, consecutive uncertain verdicts, consecutive failures, or at a
wall-clock time. A review starts a normal system-role continuation for the
capable thread controller, which may inspect evidence and revise the strategy.
New watches default to one review after three consecutive failures, and include
the latest bounded observation error in that continuation. An explicit null
review disables all checkpoints; a null consecutive-failure threshold disables
only the automatic health review. Existing persisted revisions retain their
stored policy.
The evaluator never receives this responsibility. A delivered review leaves the
watch active and does not repeat within that revision; acknowledging it through
an update begins a fresh revision. Controllers can place reviews before an
expected provider prompt-cache expiry when the saved context cost justifies a
check-in, but the server does not invent model-specific cache policy.

## Continuation delivery

The default continuation dispatches an internal `thread.turn.start` with a
system-role message. Client commands remain user-only, so automation cannot be
mistaken for user speech. The delivery reads the thread's current provider
configuration instead of preserving the model that created the monitor.
Trigger summaries and evidence are explicitly identified as untrusted data;
only the stored continuation prompt is presented as an instruction.

Delivery waits for running or starting sessions, pending approvals, pending
user input, and newly queued turns to settle. Every retry uses the same logical
message id. An in-flight delivery also reuses its orchestration command id, so
an accepted command receipt closes the crash window before the monitor is
marked delivered. Only a confirmed rejected receipt advances to a new attempt.
A `record-only` monitor reaches `delivered` without requesting a provider turn.

The provider command reactor handles the resulting turn through the normal
session-start, permission, error, and runtime-event paths. This deliberately
avoids a monitor-specific provider adapter or model-selection policy.

# Durable thread monitors

Durable monitors separate waiting from model execution. A provider turn creates
a monitor through the server's MCP endpoint and then ends. SQLite owns the
deadline and lifecycle; a single server scheduler reconciles due work without
keeping a provider process or one timer fiber per monitor alive.

## State and ownership

MCP invocation credentials determine the owning thread. A request scoped to
another thread receives the same not-found result as a missing monitor.

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

`monitor_capabilities` resolves the invoking thread's current controller model
before a caller chooses a timer. Its optional `controllerPromptCache` reports a
provider-backed minimum lifetime and provenance, not an exact expiration or
remaining lifetime. The lookup is read-only and does not require computer
access.

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
structured-output invocation. The CLI emits terminal per-request usage,
including input, cached input, cache-write input, and output tokens when
supplied, and reports prompt-cache refresh as unsupported. The monitor records
exact token fields plus per-evaluation and aggregate duration. It leaves an
unavailable field null and never approximates usage or cache behavior with a
synthetic thread turn, empty message, or implicit model substitution.

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

Review checkpoints bound evaluation costs while leaving decisions about watch
strategy to the controller. Evaluation checkpoints pause model calls
until the controller inspects and acknowledges the review; the evaluator only
reports observations. The [review policy](../../packages/contracts/src/threadMonitor.ts)
defines the available checkpoints and defaults. A delivered review leaves the
watch active and does not repeat within that revision; acknowledging it through
an update begins a fresh revision. Controllers can place reviews before an
expected provider prompt-cache expiry when the saved context cost justifies a
check-in. Computer-watch capabilities include the same current-controller cache
timing as generic monitor capabilities so the watch-planning call remains
self-contained. The duration begins when an eligible entry is created or
refreshed, is not an expiration deadline, and is omitted when unknown.

## Continuation delivery

The default continuation dispatches an internal `thread.turn.start` with a
typed `monitor.continuation` system event. Client commands remain user-only, so
automation cannot be mistaken for user speech. The event mechanically separates
trusted harness facts, untrusted trigger observations, and the fact that it
grants no new authorization. Computer-watch
checkpoints use the related `monitor.review` event. The projected message stores
the structured event once and only a compact fallback label as text; the
provider reactor renders the full provider-neutral input at delivery time.
Codex receives it through native `toolOutput`, which requires Codex 0.151.0 or
later. Sending it as user input would cause compaction to retain automated
notifications as user requests. Other providers keep the attributed text input.

Web and mobile clients show these messages as compact, collapsible event cards
instead of user bubbles. The delivery reads the thread's current provider
configuration instead of preserving the model that created the monitor.

Delivery waits for running or starting sessions, pending approvals, pending
user input, and newly queued turns to settle. Every retry uses the same logical
message id. An in-flight delivery also reuses its orchestration command id, so
an accepted command receipt closes the crash window before the monitor is
marked delivered. Only a confirmed rejected receipt advances to a new attempt.
A `record-only` monitor reaches `delivered` without requesting a provider turn.

The provider command reactor handles the resulting turn through the normal
session-start, permission, error, and runtime-event paths. This deliberately
avoids a monitor-specific provider adapter or model-selection policy.

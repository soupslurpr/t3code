# Durable thread monitors

Durable monitors separate waiting from model execution. A provider turn creates
a monitor through the server's MCP endpoint and then ends. SQLite owns the
deadline and lifecycle; a single server scheduler reconciles due work without
keeping a provider process or one timer fiber per monitor alive.

## State and ownership

Migration 41 creates `thread_monitors`, migration 42 adds coalesced delivery and
durable retry state, and migration 43 adds structured computer conditions and
`thread_monitor_computer_evidence`. Each monitor row stores its normalized
condition, continuation policy, trigger evidence, terminal timestamps, and
delivery attempts. MCP invocation credentials determine the owning thread. A
request scoped to another thread receives the same not-found result as a
missing monitor.

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
condition. A frame-relative crop is resolved once and stored as a display plus
Electron desktop-logical bounds, so expired frame identifiers are never used by
the scheduler. The user desktop coordinator already supports independent
viewers. If GNOME has only a remembered combined-control token, the coordinator
may restore that native session while assigning the monitor controller only a
view lease. An explicitly named Agent desktop also permits view-only controllers
from the same environment and thread while preserving exclusive input control
for its owner.

Each check captures only the stored region at the requested bounded resolution.
The service hashes the PNG and discards the sample after the check. Exact
`image-change` conditions compare that hash with the initial hash without a
model. Model conditions route through the exact provider instance and model in
the condition; capability discovery lists only instances whose adapter exposes
image evaluation. The default change gate skips a model call when the sample is
unchanged. An optional minimum evaluation interval rate-limits model calls
without slowing capture. A change observed during the rate-limit window sets a
durable pending flag. At the first eligible sample, the evaluator receives the
latest image even if that image is unchanged from the immediately preceding
sample. Successful evaluation clears the flag; restarts preserve it.

The evaluator receives current pixels, an optional retained baseline, and an
explicit reminder that image content is untrusted data. The current Codex
adapter runs an ephemeral, read-only structured-output invocation. It reports
token usage as unavailable because the CLI path does not expose reliable
per-request usage. It also reports prompt-cache refresh as unsupported. The
monitor system never approximates either capability with a synthetic thread
turn, an empty message, or an implicit model substitution.

Only optional baseline and terminal matching PNGs are retained. Ordinary
samples are not written to SQLite. Evidence rows cascade with thread-monitor
deletion. Terminal transitions and cancellation release the monitor-specific
view lease; they do not disturb another controller's view or control lease.

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

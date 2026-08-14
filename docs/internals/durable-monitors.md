# Durable thread monitors

Durable monitors separate waiting from model execution. A provider turn creates
a monitor through the server's MCP endpoint and then ends. SQLite owns the
deadline and lifecycle; a single server scheduler reconciles due work without
keeping a provider process or one timer fiber per monitor alive.

## State and ownership

Migration 41 creates `thread_monitors`. Each row stores a normalized time or
signal condition, continuation policy, trigger evidence, terminal timestamps,
and delivery attempts. MCP invocation credentials determine the owning thread.
A request scoped to another thread receives the same not-found result as a
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

A watcher is ordinary provider work, not a special model type. It can be a
native subagent, workflow, process integration, or later turn that shares the
owning thread's MCP scope and calls `monitor_signal`. The durable state never
names a provider or model.

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

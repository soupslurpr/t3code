# Durable waits and monitoring

An agent can leave a durable wait when work should resume later. T3 Code stores
the wait locally, lets the current turn finish, and shows the thread as
**Monitoring**. No model stays active and no model tokens are used while a
timer is dormant.

Durable waits support:

- a delay, such as two hours;
- a specific future time;
- a signal from background work or automation, optionally with a fallback
  deadline.

When a wait triggers, T3 Code normally resumes the same thread. It uses the
provider, model, permission mode, and interaction mode configured for that
thread at delivery time. If another turn, approval, or user-input request is
active, the continuation waits until the thread is available. An agent can
also record a result without starting another turn.

Waits survive a T3 server restart. T3 Code does not run timers in a hosted
service while the environment is offline; an overdue wait is reconciled the
next time that server starts. Deleting a thread cancels its outstanding waits.
When the desktop host is configured to stay awake for agent work, an
outstanding wait counts as monitoring so its deadline can run on time. This
does not bypass manual locking or unlock a workstation.

Ask the agent to list or cancel its waits at any time. Signal-based monitoring
usually combines a durable wait with background work that reports when its
condition is satisfied. If that background work can stop independently, use a
fallback deadline when missing the wake-up would matter.

# Durable waits and monitoring

An agent can leave a durable wait when work should resume later. T3 Code stores
the wait locally, lets the current turn finish, and shows the thread as
**Monitoring**. No model process stays active while a monitor is dormant.
Timers and exact image-change watches use no model tokens. A semantic screen
watch uses tokens only when its selected evaluator examines a changed sample.

Durable waits support:

- a delay, such as two hours;
- a specific future time;
- a signal from background work or automation, optionally with a fallback
  deadline;
- a durable area of the user desktop or a specific Agent desktop, checked for
  an exact image change or a visible condition described in plain language.

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

Screen watches request view-only access when they are created, before the
creating turn ends. A watch never acquires keyboard or pointer control. It can
observe a full display or convert a crop from a current screenshot into stable
desktop coordinates, and the agent can choose its capture resolution and
sampling interval. An Agent desktop remains usable by its controlling agent
while another agent in the same thread holds a view-only watch.

For a semantic condition, the agent selects an exact configured provider
instance and model. T3 Code does not silently substitute a cheaper or different
model. It normally skips evaluation while the crop is byte-for-byte unchanged;
the agent can disable that gate when periodic interpretation is more useful.
The agent can also set a minimum interval between model evaluations independently
of the capture interval. Changes during that interval remain pending and
coalesce into one evaluation of the latest sample. Omitting the minimum keeps
evaluation unthrottled. A throttled watch can miss a condition that appears and
disappears before the next evaluation, so transient conditions need a short or
omitted minimum.
Evaluator availability, token reporting, and explicit prompt-cache refresh are
adapter capabilities. T3 Code reports unsupported capabilities instead of
creating synthetic keepalive turns or hidden conversation messages.

Ordinary screen samples are discarded after comparison. T3 Code stores hashes
and bounded status details with the monitor, can optionally retain the initial
PNG for visual comparison, and retains the terminal matching PNG for audit.
Those images live in the environment's local T3 data until the owning thread is
deleted. Cancelling, matching, reaching a deadline, or deleting the thread
releases the watch's view lease. A temporary capture or evaluator failure is
recorded and retried with bounded exponential backoff.
After three consecutive failures, a screen watch normally resumes its controller once with the
current diagnostic so the agent can inspect or revise an ineffective watch. The watch keeps retrying
and does not repeat the warning within the same revision. An agent can disable this safeguard while
retaining other review checkpoints, or disable reviews entirely when silence is intentional.

Ask the agent to list or cancel its waits at any time. Signal-based monitoring
usually combines a durable wait with background work that reports when its
condition is satisfied. If that background work can stop independently, use a
fallback deadline when missing the wake-up would matter.

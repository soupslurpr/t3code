# Desktop Computer Use

Agents running through T3 Code can capture and control native desktop applications when a supported
T3 Code desktop client is attached to the same environment. This is separate from the collaborative
browser: it targets the host desktop itself.

The current implementation is intentionally host-specific. It supports Linux desktop builds running
in a GNOME Wayland session with the system GJS runtime and XDG Remote Desktop portal. It installs no
input-driver package and reports computer use as unavailable on other systems.

## Permission And Safety

Desktop access has two agent-facing levels. A fresh view-only approval asks GNOME only for the
selected monitors and permits snapshots without exposing keyboard or pointer access. A control
session combines those monitor streams with keyboard and pointer access. The agent requests the least
access it expects to need near the start of a task, giving you a chance to answer GNOME's native
consent dialog before leaving. Requesting access does not itself send input.

By default, T3 Code keeps the computer available while agents work. Ordinary agent work prevents
system suspend but still permits the display to blank and lock. When an agent may need the user
desktop later, it can retain a desktop-availability lease without opening monitor sharing. Requesting
view or control access retains the same lease automatically. It prevents automatic locking and suspend
until explicitly released, even after the sharing session closes and across later tasks. This behavior
does not need a separate per-session confirmation. You can turn it off persistently with **Keep
computer awake for agents** in General settings; T3 Code does not change the operating system's
persistent power or lock settings.

If you share a monitor during a control request but leave **Allow Remote Interaction** disabled, T3
Code keeps the resulting view-only session instead of immediately closing it. Snapshots continue to
work, while input remains unavailable until the agent requests control again and GNOME grants both
keyboard and pointer access.

After approval, GNOME can return separate opaque restore tokens for view and control access. T3 Code
stores them in its local state directory with owner-only file permissions and uses them to reconnect
without a routine dialog. GNOME remains in control: it can reject or invalidate a token, require
approval again, and shows its active sharing indicator whenever a session is connected. T3 Code does
not receive or store your portal choices directly.

A remembered control grant necessarily includes its monitor stream, so status reports it as both
view and control access. When that combined token is the only reusable grant, T3 Code can restore its
native Remote Desktop session for a view-only request while giving the requesting agent or screen
watch only a shared view lease. Input remains unavailable to that caller. This avoids another routine
monitor prompt without broadening what the agent requested or what you previously approved.

The agent can call `computer_release` to cancel pending authorization or end the active sharing
session immediately. This removes capture and input access but retains both GNOME restore tokens and
desktop availability, so a later task can reconnect before automatic locking makes the user desktop
unavailable. A later `computer_status` reports `remembered` while no sharing session is active, and
`keepAwake` remains true while availability is retained. The agent can call
`computer_release_availability`, or you can select **Allow locking** in General settings, to remove
only the availability lease without disabling the persistent policy. `computer_forget_control` ends
the session, deletes both restore tokens, and releases availability, so the next request requires
fresh approval and may require unlocking. Quitting the desktop app releases availability while
retaining remembered consent.

Agents treat desktop changes as temporary by default. When it is appropriate for the task, they
close programs or windows opened only for the task and return focus to the application that was
active beforehand. This is guidance rather than an enforced cleanup script: an agent can leave a
useful result visible or preserve intentionally requested state when that better serves the task.

Manual locking or suspending always takes priority and ends desktop access and retained availability.
Manual locking does not stop the underlying agent turn, so its suspend-only inhibitor can remain
until that work finishes.
The power policy never authorizes T3 Code to bypass an existing lock screen. If the display is blank
but logind confirms that the session is still unlocked, T3 Code may wake it to show GNOME's consent
prompt or continue approved work. A locked session requires you to unlock it.

Snapshots read the active session's GNOME PipeWire stream and do not use the separate Screenshot
portal. The agent must request view or control access before its first snapshot. Each snapshot reads
one current frame on demand; T3 Code does not continuously record the stream or save a video. When
the focused application exposes enough semantic information, the agent can omit the image from an
inspection. This keeps routine intermediate checks small while leaving full images available for
visual decisions and confirmation.

Every complete screenshot includes an exact, versioned fingerprint of its bounded pixels. An agent
can return that fingerprint with a later capture when it only needs a new image if the pixels
changed. A matching capture still returns fresh semantic data, coordinate transforms, and a valid
frame identifier, but skips image encoding and transfer. The comparison token belongs to the caller
rather than hidden desktop state, so reconnecting clients and parallel agents cannot overwrite one
another's reference frame.

Computer status reports frame-capture health separately for each display. It includes the latest
successful and failed frame times, consecutive failure count, and a bounded backend diagnostic.
This distinguishes working permission from a working stream: a session can remain approved while
PipeWire, the virtual display, or another capture component is degraded.

Access requests and `computer_act` return a fresh screen observation by default. Action calls also
return one ordered execution receipt per completed action, even when the agent skips the image. The
agent can choose the image resolution and encoding, crop a region from a prior frame, omit the image
when semantic targets are sufficient, adjust the capture delay, or skip a predictable post-action
observation entirely. One action call can group a bounded sequence of predictable pointer and
keyboard actions, so the agent does not need a tool round trip or image between steps that require no
visual decision. When the next step depends on the resulting UI, the agent uses a one-action batch and
inspects its observation first. A standalone snapshot remains available for inspection without acting
or recovery after a failed follow-up capture. Typing can pause briefly and submit with Enter in the
same action.

One observation can return a primary overview plus up to eight named detail images. T3 Code reads the
native display once, then derives every crop, resolution, encoding, fingerprint, and actionable frame
from those exact pixels. The primary image can be omitted when only details are useful. This lets an
agent inspect several related areas without paying for repeated native captures or risking that the
screen changes between an overview and its details. All images in one observation select the same
display.

For motion and transient UI, an agent can request a bounded sequence of timestamped screenshots with
its own crop, resolution, encoding, frame count, and interval. It can also capture the sequence before,
during, or after an action batch so the starting state and resulting transition remain visible. These
frames are returned only to that tool call under the existing view permission and are not saved as a
video. A separately retained recording remains a distinct, intentional operation.

For a longer visual wait, an agent can create a durable watch with several independently cropped,
sized, and encoded regions. Trigger regions are sampled on the chosen cadence; context regions are
captured only when an evaluator or controller needs them. The agent that owns the task chooses the
exact condition, sampling policy, deadline, model, and optional review checkpoints. A selected
evaluator receives named current images and optional revision baselines and returns only a verdict,
visible facts, and image-linked evidence. It cannot act on the desktop or rewrite the monitoring
strategy. Watches use exact fingerprints automatically, so a matching sample skips compression and
image transfer as well as model evaluation. Changed samples remain complete standalone images rather
than depending on a chain of image deltas.

Starting a watch returns the exact images T3 Code captured as that revision's baseline, rather than
assuming an earlier screenshot is still current. The owning agent can therefore catch a transient,
wrong window, or late UI change and immediately rebaseline before it leaves the task unattended.
Updates return their new baselines in the same way. When the agent already holds an image with the
same exact region fingerprint, it can request metadata-only confirmation instead of receiving the
same bytes again; it can also omit baseline images when direct review is unnecessary.

Each watch has a revision. At a review checkpoint, the owning agent can inspect bounded baseline,
previous, current, terminal, or freshly captured frames, then atomically update the regions or policy
against the revision it inspected. A stale update is rejected instead of overwriting a newer one.
Reviews leave the watch active, and each successful update begins a fresh revision with new baselines
and metrics. An agent may time a review before its provider's prompt cache expires when another turn
is expected to cost less than rebuilding that context; it can instead let the cache expire for a long
or low-value wait. These retained frames are bounded monitoring evidence, not a continuous recording.

Desktop screenshots can contain information from any visible application. They become part of the
agent's tool context, so close or hide sensitive windows before allowing computer use. This matters
especially when you control an agent remotely: approval grants control of the machine running the
attached desktop client, not the phone or browser you are holding.

When available, T3 Code also reads the focused application's AT-SPI accessibility tree to identify
visible controls. It does not expose text-control contents; after direct text insertion, it compares
only the inserted range with the requested text and returns counts rather than content. Portal
dialogs and GNOME Shell are excluded, and semantic activation still requires an approved
desktop-control session. It uses the control's native accessibility action where available, or
focuses it and sends an ordinary Enter key event. Target and window identifiers expire after
activation, on the next snapshot, or when control is released.

Starting a view or control session temporarily enables GNOME toolkit accessibility, even when the
initial observation omits semantic data. This lets applications launched afterward register with
AT-SPI before the agent needs their controls or windows. T3 Code restores the prior setting when
access is released and does not disable it if a screen reader became active in the meantime.
Chromium- and Electron-based applications that were already open may still need to be restarted
before they expose semantic data. Screenshots and coordinate controls remain available without a
restart.

Atomic hotkey actions normalize common key aliases and release every key acquired by the chord in
reverse order. Key-down and key-up actions remain available for transient keyboard UI. For example,
an agent can
hold Alt and press Tab in one batch, inspect the returned application-switcher observation, then
release Alt in a later batch to select the highlighted application. T3 Code tracks keys held this way
and releases them before ending control. Mouse drags similarly use explicit button-down, interpolated
movement, and button-up events. After an input failure, T3 Code releases tracked keys and buttons or
closes the portal session as a final safety fallback.

Text actions request exact Unicode, including smart punctuation, arrows, combining characters, and
emoji. A focused editable accessibility control receives the text directly and confirms the exact
inserted substring. The action receipt separates requested, backend-accepted, and
application-confirmed code-point counts and labels verification as exact, partial, or unavailable.
Backend acceptance alone never claims that an application consumed or rendered key events. When
direct insertion is not available, both desktop kinds use keyboard events only for exact ASCII and report
`exact-text-unavailable` for non-ASCII instead of claiming success after a compositor or application
silently drops it, or replaying a Unicode input-method sequence that an application might
misinterpret. Agent desktop key chords use explicit key-down, hold, reverse key-up, and settle
phases instead of QEMU's asynchronous timed-key shortcut. Keyboard taps and pointer clicks use
short human-equivalent transition timing to avoid dropped events or accidental repeats, and typing
waits briefly for the application input queue before returning. Neither path reads or changes the
clipboard. On either desktop, a focused multiline
editable control accepts a whole text block directly; elsewhere Newline and Tab remain real key
events. Exact insertion never replays text through the keyboard after an uncertain partial failure.

Taking over an Agent desktop enters full screen and captures host-reserved shortcuts so keys such as
Super reach only the guest. GNOME may show a first-use prompt to allow shortcut inhibition. Its
emergency Super+Escape chord immediately restores host shortcuts, and leaving full screen releases
the human control lease.

## Agent Tools

The environment exposes tools for:

- checking support, active permission, remembered access, and displays
- requesting view-only access early without requesting input
- requesting combined screen-and-input access early without sending input
- capturing one display as an overview, named same-frame details, or a focused region with selectable
  image resolution and best-effort semantic targets and top-level windows
- capturing a bounded, ephemeral sequence of timestamped screen frames for motion or transient UI
- running bounded action batches that can move, click, drag, emit discrete wheel ticks, type, press
  hotkeys or hold keys, wait for a duration or a visual change, and activate a current semantic
  target or window
- leaving a revisioned, view-only multi-region watch that checks for an exact image change or asks an
  explicitly selected evaluator whether a visible condition has been met, with tools to inspect and
  adapt it at review checkpoints
- releasing the active session or forgetting remembered consent

Full-display screenshots preserve aspect ratio and default to a maximum of 1600 by 900 pixels. An
agent can request other bounded dimensions or return a sharper crop of a prior frame. Images use
lossless 8-bit WebP by default. An agent can instead choose near-lossless or lossy WebP when smaller
transfers are worth reduced fidelity, or PNG when a downstream consumer requires it. Every result
reports its exact content hash, actual encoding, and compressed byte size. Each observation also has
a frame identifier and an explicit transform from its image pixels to Electron desktop-logical
coordinates. Pointer actions reference that frame, preventing a crop or resolution change from
silently moving a click. Display bounds continue to report logical desktop dimensions.

GNOME Wayland does not expose the current pointer position to ordinary applications. Status and
snapshot results therefore report `cursor: null`. After a pointer operation, snapshots draw a
high-contrast marker at T3 Code's last commanded position. This is a memory aid, not a live cursor
reading, because you may have moved the mouse yourself in the meantime.

Agents can move without clicking and inspect the returned observation after hover UI settles before
deciding what to do. Wheel actions use the portal's discrete mouse-wheel events rather than an
accessibility or touchpad-scroll gesture; small tick increments with observations in between are the
most predictable. A visual-change wait compares a bounded region from a current frame for up to one
minute and returns its elapsed time and sample count without placing every intermediate image in the
agent context. Selecting the smallest stable region avoids unrelated animation. Omit `displayId`
from a standalone snapshot to capture the primary display.

Execution errors distinguish invalid input, unsupported operations, stale frames or semantic
targets, authorization failures, capture failures, and input-injection failures. A failed batch
reports the action index, number of actions already completed, best-known injection phase, and
whether held keys and buttons were released. Validation diagnostics may include bounded field and
expected-value metadata, but T3 Code does not echo typed text.

Wayland applications do not expose their window's screen origin through AT-SPI. Semantic target
bounds are therefore relative to the focused window named in the result, not to the screenshot.
Agents use target identifiers for control activation, window identifiers to focus exposed top-level
windows, and screenshot coordinates for mouse interaction. All semantic identifiers expire with the
next semantic observation or action batch. Screenshot-only Agent desktop viewers and monitors do not
consume them. Semantic control targets are currently disabled on multi-display desktops to avoid
associating them with the wrong captured display, while the coordinate-free top-level window list
remains available.

## Agent Desktops

An agent can use a separate Agent desktop when it should work without moving the pointer, changing
focus, or opening windows on your desktop. Each Agent desktop is a complete GNOME machine with its
own display, files, processes, and network connection. The same computer tools work against it, but
the virtual machine remains on the device hosting its T3 environment. Other connected T3 clients can
watch or control it remotely without installing QEMU or creating a second local inventory. The
environment server must remain running, but no particular T3 client needs to stay connected. The
machine does not need the host-desktop sharing dialog because its display and emulated input devices
exist specifically for agent work.

An agent can ask for a clean desktop, reuse a suitable prior desktop, or select a known desktop
explicitly. Access returns the concrete desktop identifier, and every later status, snapshot, action,
release, or forget operation names that identifier. Every computer operation explicitly names either
your desktop or a concrete Agent desktop; a missing target is rejected rather than inferred. This
stateless routing lets parallel agents in one thread hold independent desktops without silently
redirecting or releasing each other's sessions.
A provider or harness restart does not strand prior desktops: they remain listed for the same thread,
and acquiring one explicitly reclaims it when no other controller is actively using it. Automatic
acquisition prefers the current controller's suitable desktop, then the most recent suitable idle
desktop from the thread. It never steals an active control lease; agents use a fresh desktop for
intentional parallel work.
A human can temporarily view or take control of an Agent desktop; agent input is revoked during that
takeover and can resume after the human lease ends.
The Watch dialog also has an Agent lens mode. It overlays the exact latest image regions delivered
to the controller or watch evaluator over the live desktop, identifies their recipient, resolution,
encoding, and capture time, and can display the original pixels at 1:1. Temporal frames and retained
watch generations remain selectable. The live desktop continues underneath, while the lens changes
only when a model receives another observation; ordinary watch refreshes and unchanged monitor
samples do not pretend that the model saw a frame. The lens reuses existing observation bytes,
retains only bounded short-lived memory, and performs no additional capture or model call.
An agent can also attach a durable view-only watch to an explicitly named Agent desktop already owned
by another controller in the same thread. The watcher can capture that desktop but cannot inject input,
and releasing it does not release the owner's control lease.

The host chooses CPU, memory, and virtual disk capacity from current pressure and the task's stated
needs. Agents describe needs such as graphics, interactivity, temporary disk use, audio, or whether a
desktop must stay running; they do not select arbitrary host resource values. Idle desktops normally
park to disk after ten minutes, while active operations, viewers, controllers, and explicit
prevent-parking requests keep them running. An agent can also stop, park, checkpoint, clone, reset,
recover, hand off, or delete a desktop explicitly.

Stopped or parked desktops using automatic retention enter a seven-day recovery window after 30
days without activity. The host also maintains a free-space reserve of five percent of the Agent
desktop filesystem, bounded between 2 GiB and 20 GiB. When storage falls below that reserve,
desktops idle for at least one day can enter the same recovery window, oldest first and only until
enough pending space has been identified. This never skips recovery: disk space is reclaimed when
the window expires, or when a user explicitly confirms permanent deletion in Settings. Agents can
mark state that must be kept with the preserve retention policy, which exempts it from automatic
retirement. Settings shows the recovery deadline and provides both Restore and confirmed Delete
permanently actions.

New desktops use host GPU acceleration automatically when the complete QEMU, graphics-driver, and
device-access path is available. An agent can prefer acceleration while accepting a software
fallback, require it for a graphics-heavy task, or request software graphics. Desktop status reports
the backend that was actually selected. Software desktops can preserve full running machine state
when parked or checkpointed. Accelerated desktops cleanly shut down when parked and use
disk-consistent checkpoints because their live GPU state cannot be serialized.

Each desktop has an independent NAT connection and its own byte, packet, drop, rate, address, and
bounded connection accounting. Outbound networking works by default. Inbound guest services stay
private until an agent publishes an exact guest port as loopback-only, tailnet-visible, or
network-visible. Packet contents are not retained during ordinary accounting; a bounded capture is
created only when an agent explicitly requests one.

Guest commands use an exact executable and argument vector over a private guest channel rather than
an implicit shell. Bounded file reads and writes use that same channel. The default command user is
root inside the guest, so isolation separates those privileges from the host rather than pretending
the guest itself is unprivileged. Private QEMU control sockets and machine state are owner-only on the
host.

Agents can also copy complete files or directory trees between the current thread workspace and an
Agent desktop. Workspace paths stay inside that thread's project or worktree. Relative Agent desktop
paths resolve below the graphical guest user's home; files installed there are owned by that user so
GUI applications can edit them. Safe internal symlinks are preserved, while standalone or escaping
symlinks are rejected. Create, replace, and directory-merge collision policies are explicit.

Large copies do not pass file bytes through the model response, renderer IPC, or WebSocket JSON. T3
Code samples content before deciding whether compression is worthwhile, streams bounded chunks
locally between the environment server and its guest, verifies SHA-256 and the copied-tree summary,
and stages the complete destination before installing it. The initiating agent can wait briefly,
inspect exact progress later, or cancel an active copy. Transfer status remains available for 24
hours while the server process remains running.

The current implementation targets x86-64 Arch Linux hosts with KVM, a systemd user manager, QEMU,
UEFI firmware, and passt networking. `agent_desktop_list` reports every prerequisite separately.
When an official Arch package can repair one, `agent_desktop_setup` offers to install only the exact
reported package set through PolicyKit and then probes again. On first use, the same approved setup
downloads a pinned official Arch cloud image, checks its exact size and SHA-256, provisions the
private graphical guest, and atomically installs it. An interrupted download can resume, and a
verified source image is cached for recovery. Allow up to 75 minutes, 8 GiB of temporary free space,
and roughly 3 GiB of retained storage. Missing KVM access, firmware settings, GPU device access, or
graphics drivers remain explicit manual remedies. A custom `T3CODE_AGENT_DESKTOP_IMAGE` path also
remains caller-managed. Setup applies to the environment server, so the same Agent desktop inventory
is available whether the thread is opened from a local desktop app, a remote browser, or mobile.

## Troubleshooting

Keep the T3 Code desktop app open and connected to the environment used by the thread. If status says
computer use is unavailable, confirm that the session is GNOME on Wayland and that `/usr/bin/gjs` and
the XDG Remote Desktop and ScreenCast portals are present. Capturing a session stream also requires
the system GStreamer runtime with its PipeWire source and PNG encoder plugins. A browser-only or
mobile-only connection cannot host these operations.

GNOME inhibits new ScreenCast and Remote Desktop sessions while the display is blanked or locked. T3
Code distinguishes those states before asking the portal, safely wakes a blank but unlocked display,
and refuses to bypass a lock. This check also prevents an unused remembered token from being consumed
by an inhibited request.

Semantic targets additionally require the system AT-SPI typelib, normally provided by the official
`at-spi2-core` package. If the focused application does not expose accessibility information,
or if the typelib is missing, screenshots and coordinate controls continue to work.

If you reject GNOME's native prompt, the attempted action fails without sending input. Retained
desktop availability remains independent of that sharing choice and can be released from General
settings. During a control request, selecting a monitor without enabling remote interaction grants
view-only access instead. Try the control request again when you are ready to approve keyboard and
pointer access.

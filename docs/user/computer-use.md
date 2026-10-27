# Computer Use

Agents running through T3 Code can capture and control native graphical applications when a
supported T3 Code desktop client is attached to the same environment. This is separate from the
collaborative browser. Computer use targets either a concrete user desktop exposed by a desktop
client or a managed, isolated Agent desktop.

User-desktop access supports Linux desktop builds running
in a GNOME Wayland session with the system GJS runtime and XDG Remote Desktop portal. It installs no
input-driver package. Isolated Agent desktops use QEMU/KVM on supported Linux hosts.

## Permission And Safety

User-desktop access has two levels. A view-only session shares the selected monitors and permits snapshots
without requesting keyboard or pointer access. A control session combines those monitor streams with
keyboard and pointer access. The agent requests the least access it expects to need near the start of
a task, giving you a chance to answer GNOME's native consent dialog before leaving. Requesting access
does not itself send input.

Agent desktops have separate displays and input devices and do not require host screen-sharing approval. Viewers can observe an Agent desktop while one controller holds its input lease.

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

Ordinary agent access requests are transient. T3 Code asks GNOME for a nonpersistent portal session,
so approving one request does not create remembered access. **Settings → User desktops** provides
separate **Remember view** and **Remember control** actions when you intentionally want reusable
approval for a particular user desktop. Those actions can receive separate opaque GNOME restore
tokens. T3 Code stores the tokens in its local state directory with owner-only file permissions and
uses them to reconnect without a routine dialog. GNOME remains in control: it can reject or
invalidate a token, require approval again, and shows its active sharing indicator whenever a
session is connected. T3 Code does not receive or store your portal choices directly.

The same Settings page can end all active access or forget approval for a selected user desktop.
Those user actions interrupt every agent lease on that desktop, including pending authorization,
rather than waiting for the agent that acquired access to release it.

The agent can call `computer_release` to cancel pending authorization, in-flight or queued input, or
the active sharing session immediately. Held keys and mouse buttons are released before the final
status returns. This removes capture and input access but retains any restore tokens you explicitly
created in Settings and retains desktop availability, so a later task can reconnect before automatic
locking makes the user desktop unavailable. A later `computer_status` reports `remembered` only when
reusable approval exists, and `keepAwake` remains true while availability is retained. The agent can
call
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

Every complete screenshot includes an exact, versioned fingerprint of its bounded pixels, region, display, and encoding. An agent
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
agent can choose the image resolution, crop a region from a prior frame, omit the image when semantic
targets are sufficient, adjust the capture delay, or skip a predictable post-action observation
entirely. One action call can group a bounded sequence of predictable pointer and keyboard actions,
so the agent does not need a tool round trip or image between steps that require no visual decision.
When the next step depends on the resulting UI, the agent uses a one-action batch and inspects its
observation first. A standalone snapshot remains available for inspection without acting or recovery
after a failed follow-up capture. Typing can pause briefly and submit with Enter in the same action.

One observation can return an overview plus up to eight named detail images from one display capture.
An agent can inspect several areas at different resolutions without the screen changing between
images. Each image has its own action coordinates. The overview can be omitted when only details
are useful.

For motion and transient UI, an agent can request a bounded sequence of timestamped screenshots with
its own crop, resolution, frame count, and interval. It can also capture the sequence before, during,
or after an action batch so the starting state and resulting transition remain visible. These frames
are returned only to that tool call under the existing view permission and are not saved as a video.
A separately retained recording remains a distinct, intentional operation.

For longer waits, ask your agent to watch the relevant screen regions. It can sample a small trigger
region frequently and capture wider context only when a change needs evaluation. You can ask it to
set a deadline or a review checkpoint, inspect the retained evidence, revise the watch, or cancel it.
The selected evaluator reports visible facts; the agent that owns the task chooses the strategy.
Watches skip compression and image transfer when an exact fingerprint matches. Changed samples remain
complete standalone images. Fingerprints include the crop, display, and encoding, so
changing those settings always produces new image bytes.
Starting a watch returns the exact images T3 Code captured as that revision's baseline, rather than
assuming an earlier screenshot is still current. The owning agent can therefore catch a transient,
wrong window, or late UI change and immediately rebaseline before it leaves the task unattended.
Updates return their new baselines in the same way. When the agent already holds an image with the
same exact region fingerprint, it can request metadata-only confirmation instead of receiving the
same bytes again; it can also omit baseline images when direct review is unnecessary.

Reviews leave the watch active. Each revision replaces its baselines and clears its metrics, while a
stale update is rejected. Retained evidence is bounded and is not a continuous recording.

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
direct insertion is not available, both desktop kinds use keyboard events for exact ASCII and a
temporary IBus engine for non-ASCII text. That fallback requires Python, PyGObject, and IBus. If exact delivery is unavailable, the action reports
`exact-text-unavailable` instead of claiming success after a compositor or application silently
drops input. Agent desktop key chords combine QEMU's timed self-release with a delayed explicit
key-up safeguard. Keyboard taps and pointer clicks use
short human-equivalent transition timing to avoid dropped events or accidental repeats, and typing
waits briefly for the application input queue before returning. Neither path reads or changes the
clipboard. On either desktop, a focused multiline
editable control accepts a whole text block directly. Elsewhere, a type action containing Newline or
Tab fails before injecting any text; agents use explicit press or hotkey actions when they intend
those control keys. Exact insertion never replays text through the keyboard after an uncertain
partial failure.

Taking over an Agent desktop enters full screen and captures host-reserved shortcuts so keys such as
Super reach only the guest. GNOME may show a first-use prompt to allow shortcut inhibition. Its
emergency Super+Escape chord immediately restores host shortcuts, and leaving full screen releases
the human control lease.

## Supervise a User Desktop

In **Settings → User desktops**, choose **Supervise** to inspect the exact
images delivered to an agent. Opening supervision does not start screen
sharing. Choose **Start Live** for the current display, or select an Agent
lens observation to inspect its original pixels and semantic information.
Live viewing is disabled for the desktop hosting the current window to
avoid capturing the viewer inside itself.

**Take control** enters full screen and captures host shortcuts. A conflicting
human or foreign-environment controller requires confirmation. **Release
control** keeps live viewing; **Return control** explicitly resumes a
displaced agent when available. Closing supervision or hiding the client
releases its access. Leaving full screen releases human input control.

On mobile, open **Settings → User Desktops → Supervise**. Live supports
touch input and a text field after taking control. Leaving the screen,
backgrounding the app, or losing the environment connection releases
transient access. Reopening supervision starts passively again.

## Agent Tools

The environment exposes tools for:

- listing known user desktops with stable opaque identifiers, labels, online state, platform, and
  limited activity metadata before selecting one
- checking support, active permission, remembered access, and displays
- requesting view-only access early without requesting input
- requesting combined screen-and-input access early without sending input
- capturing one display as an overview, named same-frame details, or a focused region with selectable
  image resolution and best-effort semantic targets and top-level windows
- capturing a bounded, ephemeral sequence of timestamped screen frames for motion or transient UI
- running bounded action batches that can move, click, drag, emit discrete wheel ticks, type, press
  hotkeys or hold keys, wait for a duration or a visual change, and activate a current semantic
  target or window
- leaving a durable, view-only multi-region watch that checks for an exact image change or asks an
  explicitly selected capable model whether a visible condition has been met
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
machine does not need the GNOME user-desktop sharing dialog because its display and emulated input devices
exist specifically for agent work.

An agent can ask for a clean Agent desktop, reuse a suitable prior Agent desktop, or select a known
desktop explicitly. Each user desktop also has a durable opaque identifier and an editable label in
**Settings → User desktops**. An agent lists those user desktops before selection and passes the exact
selected target to every later status, access, snapshot, action, release, or forget operation. The
approval prompt appears on that selected desktop, even when the thread is being viewed from another
client. A disconnected target fails as offline; T3 Code never redirects the operation to a different
user desktop. A missing target is rejected rather than inferred. This stateless routing lets parallel
agents in one thread hold independent desktops without silently redirecting or releasing each other's
sessions.
A provider or harness restart does not strand prior desktops: they remain listed for the same thread,
and acquiring one explicitly reclaims it when no other controller is actively using it. Automatic
acquisition prefers the current controller's suitable desktop, then the most recent suitable idle
desktop from the thread. It never steals an active control lease; agents use a fresh desktop for
intentional parallel work.
A human can temporarily view or take control of an Agent desktop; agent input is revoked during that
takeover and can resume after the human lease ends.

In Settings, open an Agent desktop's Watch view and choose Agent lens to inspect
the latest images delivered to its controller or watch evaluator. You can select
temporal frames or watch generations and view their original pixels at 1:1. Live
shows the current desktop; the lens changes only on a new model observation and
expires after thirty minutes or when the server restarts.

The host chooses CPU, memory, and virtual disk capacity from current pressure and the task's stated
needs. Agents describe needs such as graphics, interactivity, temporary disk use, audio, or whether a
desktop must stay running; they do not select arbitrary host resource values. Idle desktops normally
park to disk after ten minutes, while active operations, viewers, controllers, and explicit
prevent-parking requests keep them running. An agent can also stop, park, checkpoint, clone, reset,
recover, hand off, or delete a desktop explicitly.

Agent desktop system maintenance is asynchronous and survives ordinary client or provider changes.
`agent_desktop_list` reports the installed profile and update phase for the environment's base image
and every desktop. `agent_desktop_update` can queue either target explicitly. A desktop update is
accepted only after control, viewers, and guest operations have been released. T3 Code snapshots its
system and firmware disks, installs the complete signed Arch upgrade, reapplies the current guest
profile, reboots, and verifies the graphical desktop. A failed or interrupted update restores the
prior disks automatically.

The base image is a sequence of immutable generations rather than one file rewritten in place. A
refresh fully provisions and verifies a new generation before future desktops select it; existing
desktops remain attached to the generation they were created from. T3 Code retains the current base,
every generation still referenced by a desktop, and one prior unreferenced generation. It checks for
updates after a guest-profile change or seven days. An overdue base may refresh automatically when
the host has enough free memory and temporary disk space. Existing desktops update automatically
only while stopped or cold-parked; running work, human or agent access, active guest operations, and
software desktops with saved memory are not interrupted. Settings shows due, active, failed, and
completed maintenance and can queue the same safe path manually. Set a desktop's
`updatePolicy` to `manual` when acquiring it or with `set-update-policy` to
prevent background upgrades; switch back to `automatic` to resume them.
Manual policy does not prevent explicit updates or change retention.

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

The current implementation targets x86-64 Arch Linux hosts with KVM, a systemd user manager, QEMU,
UEFI firmware, and passt networking. `agent_desktop_list` reports every prerequisite separately.
When an official Arch package can repair one, `agent_desktop_setup` offers to install only the exact
reported package set through PolicyKit and then probes again. On first use, the same approved setup
downloads a pinned official Arch cloud image, checks its exact size and SHA-256, provisions the
private graphical guest, and atomically installs its first immutable generation. An interrupted
download can resume, and a verified source image is cached for recovery. Allow up to 75 minutes and
8 GiB of temporary free space. Retained storage includes the compressed source, current and prior
base generations, any older generations still backing desktops, and each desktop's sparse changes.
Missing KVM access, firmware settings, GPU device access, or graphics drivers remain explicit manual
remedies. A custom `T3CODE_AGENT_DESKTOP_IMAGE` path also remains caller-managed. Setup applies to
the environment server, so the same Agent desktop inventory is available whether the thread is
opened from a local desktop app, a remote browser, or mobile.

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

A durable screen watch can observe an explicitly named Agent desktop owned by
another controller in the same thread. The watch has view access only, and
releasing it leaves the controlling agent's access intact.

Agents can copy files or directory trees between the current thread workspace and an Agent desktop
with `agent_desktop_copy`. Workspace paths stay inside that thread's project or worktree. Relative
Agent desktop paths resolve below the graphical user's home and are installed with that user's
ownership. Safe internal symlinks are preserved; standalone and escaping links are rejected.
Choose create, replace, or directory merge explicitly. Use `agent_desktop_transfer_status` to follow
an active copy and `agent_desktop_transfer_cancel` to stop it. Completed status remains available for
24 hours while the server stays running.

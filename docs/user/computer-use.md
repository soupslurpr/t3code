# Desktop Computer Use

Agents running through T3 Code can capture and control native desktop applications when a supported
T3 Code desktop client is attached to the same environment. This is separate from the collaborative
browser: it targets the host desktop itself.

The current implementation is intentionally host-specific. It supports Linux desktop builds running
in a GNOME Wayland session with the system GJS runtime and XDG Remote Desktop portal. It installs no
input-driver package and reports computer use as unavailable on other systems.

## Permission And Safety

Desktop access has two levels. A view-only session shares the selected monitors and permits snapshots
without requesting keyboard or pointer access. A control session combines those monitor streams with
keyboard and pointer access. The agent requests the least access it expects to need near the start of
a task, giving you a chance to answer GNOME's native consent dialog before leaving. Requesting access
does not itself send input.

By default, T3 Code keeps the computer available while agents work. Ordinary agent work prevents
system suspend but still permits the display to blank and lock. An active view or control session also
prevents automatic screen locking so the agent does not lose its portal stream. This behavior does not
need a separate per-session confirmation. You can turn it off persistently with **Keep computer awake
for agents** in General settings; T3 Code does not change the operating system's persistent power or
lock settings.

If you share a monitor during a control request but leave **Allow Remote Interaction** disabled, T3
Code keeps the resulting view-only session instead of immediately closing it. Snapshots continue to
work, while input remains unavailable until the agent requests control again and GNOME grants both
keyboard and pointer access.

After approval, GNOME can return separate opaque restore tokens for view and control access. T3 Code
stores them in its local state directory with owner-only file permissions and uses them to reconnect
without a routine dialog. GNOME remains in control: it can reject or invalidate a token, require
approval again, and shows its active sharing indicator whenever a session is connected. T3 Code does
not receive or store your portal choices directly.

The agent can call `computer_release` to cancel pending authorization or end the active session
immediately. This also removes the desktop-access idle inhibitor. A suspend-only inhibitor remains
only while an agent is still working. Release retains restore tokens and returns the final permission
and inhibitor state. A later `computer_status` reports `remembered` while no session is active. Its
`rememberedAccess` field identifies which access levels can be restored; `displayState` and
`keepAwake` report the host display and desktop-access inhibitor state.
`computer_forget_control` ends the session and deletes both tokens, so the next request requires fresh
approval. Quitting the desktop app also ends the active session while retaining remembered consent.

Agents treat desktop changes as temporary by default. When it is appropriate for the task, they
close programs or windows opened only for the task and return focus to the application that was
active beforehand. This is guidance rather than an enforced cleanup script: an agent can leave a
useful result visible or preserve intentionally requested state when that better serves the task.

Manual locking or suspending always takes priority and ends desktop access. Manual locking does not
stop the underlying agent turn, so its suspend-only inhibitor can remain until that work finishes.
The power policy never authorizes T3 Code to bypass an existing lock screen. If the display is blank
but logind confirms that the session is still unlocked, T3 Code may wake it to show GNOME's consent
prompt or continue approved work. A locked session requires you to unlock it.

Snapshots read the active session's GNOME PipeWire stream and do not use the separate Screenshot
portal. The agent must request view or control access before its first snapshot. Each snapshot reads
one current frame on demand; T3 Code does not continuously record the stream or save a video. When
the focused application exposes enough semantic information, the agent can omit the image from an
inspection. This keeps routine intermediate checks small while leaving full images available for
visual decisions and confirmation.

Access requests and `computer_act` return a fresh screen observation by default. The agent can choose
the image resolution, crop a region from a prior frame, omit the image when semantic targets are
sufficient, adjust the capture delay, or skip a predictable post-action observation entirely. One
action call can group a bounded sequence of predictable pointer and keyboard actions, so the agent
does not need a tool round trip or image between steps that require no visual decision. When the next
step depends on the resulting UI, the agent uses a one-action batch and inspects its observation
first. A standalone snapshot remains available for inspection without acting or recovery after a
failed follow-up capture. Typing can pause briefly and submit with Enter in the same action.

Desktop screenshots can contain information from any visible application. They become part of the
agent's tool context, so close or hide sensitive windows before allowing computer use. This matters
especially when you control an agent remotely: approval grants control of the machine running the
attached desktop client, not the phone or browser you are holding.

When available, T3 Code also reads the focused application's AT-SPI accessibility tree to identify
visible controls. It does not read text-control contents. Portal dialogs and GNOME Shell are
excluded, and semantic activation still requires an approved desktop-control session. It uses the
control's native accessibility action where available, or focuses it and sends an ordinary Enter key
event. Target identifiers expire after activation, on the next snapshot, or when control is
released.

The first semantic observation temporarily enables GNOME toolkit accessibility for the active view
or control session. T3 Code restores the prior setting when access is released and does not disable
it if a screen reader became active in the meantime. Chromium- and Electron-based applications only
register with AT-SPI during startup, so an application that was already open may need to be restarted
before it exposes semantic targets. Screenshots and coordinate controls remain available without a
restart.

Atomic hotkey actions normalize common key aliases and release every key acquired by the chord in
reverse order. Key-down and key-up actions remain available for transient keyboard UI. For example,
an agent can
hold Alt and press Tab in one batch, inspect the returned application-switcher observation, then
release Alt in a later batch to select the highlighted application. T3 Code tracks keys held this way
and releases them before ending control. Mouse drags similarly use explicit button-down, interpolated
movement, and button-up events. After an input failure, T3 Code releases tracked keys and buttons or
closes the portal session as a final safety fallback.

Text actions preserve exact Unicode, including smart punctuation, arrows, combining characters, and
emoji. Printable ASCII continues through virtual key events. Non-ASCII code points use GNOME's
layout-independent Unicode input method because GNOME can silently discard Unicode keysyms that the
active keyboard layout cannot produce. This path does not read or change the clipboard. Newline and
Tab remain real key events.

## Agent Tools

The desktop host exposes tools for:

- checking support, active permission, remembered access, and displays
- requesting view-only access early without requesting input
- requesting combined screen-and-input access early without sending input
- capturing one display or a focused region with selectable image resolution and best-effort
  semantic targets
- running bounded action batches that can move, click, drag, emit discrete wheel ticks, type, press
  hotkeys or hold keys, wait, and activate a current semantic target
- releasing the active session or forgetting remembered consent

Full-display screenshots preserve aspect ratio and default to a maximum of 1600 by 900 pixels. An
agent can request other bounded dimensions or return a sharper crop of a prior frame. Each image has
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
most predictable. Omit `displayId` from a standalone snapshot to capture the primary display.

Execution errors distinguish invalid input, unsupported operations, stale frames or semantic
targets, authorization failures, capture failures, and input-injection failures. A failed batch
reports the action index, number of actions already completed, best-known injection phase, and
whether held keys and buttons were released. Validation diagnostics may include bounded field and
expected-value metadata, but T3 Code does not echo typed text.

Wayland applications do not expose their window's screen origin through AT-SPI. Semantic target
bounds are therefore relative to the focused window named in the result, not to the screenshot.
Agents use the target identifier for semantic activation and use screenshot coordinates for mouse
interaction. Semantic targets are currently disabled on multi-display desktops to avoid associating
them with the wrong captured display.

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

If you reject GNOME's native prompt, the attempted action fails without sending input and the
desktop-access inhibitor is removed. During a control request, selecting a monitor without enabling
remote interaction grants view-only access instead. Try the control request again when you are ready
to approve keyboard and pointer access.

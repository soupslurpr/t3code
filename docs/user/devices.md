# Devices

The Device panel shows a live iOS Simulator or Android Emulator next to a
thread, so you can watch an agent verify mobile work and tap the device
yourself. Agents get the same device through `device_*` tools and the
`agent-device` command line, which T3 Code sets up for them.

## Open a device

Open the right panel in a project thread and choose **Device**. Device support
and agent access default to on in new and existing installations. Explicitly
saved off settings stay off; change them in **Settings → Integrations → Devices**.
Helpers are downloaded and started when you first discover or open devices,
not when T3 starts or an ordinary agent session begins. Changing the switches
alone does not install or start anything. Node and npm are needed for setup.

Choose a running device to watch it, or choose **Start** next to a stopped
device to boot it. The panel shows when you or an agent starts a device.
Each device opens in its own tab. Use **+ → Device** to open another, and
double-click a tab name or choose **Rename** from its context menu to rename it.
Only the visible tab streams video; switching tabs keeps both devices running.
Choose **Float device over chat** in the toolbar to keep watching and tapping the
device in a small window while the right panel shows something else; drag the
window by its handle, resize it from any edge, and use **Open in right panel**
to bring it back.
Turn off the device hub in **Settings → Integrations → Devices** to stop the
helper processes; simulators and emulators keep running until you power them
off.

Simulators run on the machine that hosts the environment server. iOS needs
macOS with Xcode. Android needs the SDK Platform-Tools, Android Emulator,
and Command-line Tools (latest), plus a virtual device created in Android
Studio's Device Manager. T3 Code detects standard SDK locations; set
`ANDROID_HOME` for a custom location. The panel explains missing dependencies.
After installing them, restart the environment server and refresh devices.

The screen is interactive: click and drag to touch, type while the screen is
focused, and use the toolbar for Home, Back, and Recents on Android, rotate on
iOS, and power off. Close the tab to stop watching; the device keeps running
unless you power it off. Closed tabs stay closed after a reload. To watch the
device again, choose it from **+ → Device**.

## Tools

The toolbar's **Tools** button opens a drawer for the open device. It shows the
foreground app, and lets you switch light and dark mode, change text size,
flip accessibility settings, overlay the accessibility element frames on the
screen, set a fake location, and grant or revoke app permissions. iOS also
exposes Liquid Glass, color filters, VoiceOver, and sending a test push
notification; Android adds orientation and toggling the network. The drawer
only shows what the platform can do, and every control reflects the value read
back from the device after a change.

## Agents and devices

When an agent opens a device, it floats over the chat in web and desktop clients
connected to the thread, the same way an agent-driven browser does. Turn off
**Auto-show floating preview** in **Settings → Integrations → Browser** to open a
right-panel tab instead. Mobile clients show device activity in the thread
timeline. Agents drive the device through the `agent-device` command line. T3
Code installs its managed CLI when an agent first opens a device. The returned
command includes the host and session, allowing several devices to be used
independently. Native commands and standalone automation remain available;
T3 does not change the agent's PATH. iOS taps build a small test runner on
first use, which can take a couple of minutes.

Turn off **Agent device access** in **Settings → Integrations → Devices** to
stop the agent helper and deny access to new agent sessions. The manual Device
panel remains available. Restart an existing agent session after granting
access so it receives the new permission. A disabled tool may still appear in
an agent's tool catalog, but calls are rejected.

## Remote connections

The device stream goes through the environment server, so it works over the
local network, Tailscale, and T3 Connect. Live video needs a secure page
(HTTPS or localhost); on a plain-HTTP remote origin iOS falls back to a slower
still-image stream and Android cannot show video.

## SSH device hosts

In Settings → Integrations → Devices, select one connected environment
and add a host under **Device hosts**. Enter an SSH alias or `user@host`, with
an optional identity file and port. These resolve on the environment server,
so use the SSH configuration and keys available there. Password prompts are
not supported.

**Test connection** checks SSH, Node, npm, and platform tools without installing
anything. The first device listing installs pinned device tools on the host.
Node 22 or newer and npm must be available to non-interactive SSH commands.
T3 checks common Homebrew and Android SDK locations; custom installations need
the appropriate PATH and ANDROID_HOME on the host.

The picker identifies devices by host when several hosts are configured.
Connections recover after interruptions. Removing a host closes its device
sessions and stops its T3 helpers when reachable; simulators keep running.

T3 provides discovery, streaming, and control. Arrange app builds,
installation, and connectivity to development servers such as Metro separately.
A simulator on another machine cannot reach Metro through your environment's
localhost without forwarding or another reachable address.

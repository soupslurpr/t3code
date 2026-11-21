# Computer use

A thread can work on an enrolled computer or in a virtual machine provided by
its environment. Open **Settings → User desktops** for a physical computer or
**Settings → Agent desktops** for a virtual machine. Select the environment
that owns the thread. These controls also work from another connected client.

## Connect a User desktop

T3 Desktop hosts the connection on the computer you want to share. A browser
or phone can supervise a desktop from anywhere it can reach the environment.
Screen control on Linux requires a supported GNOME Wayland session. Command
access has its own permission and can be available without screen sharing.

1. Open User desktops in T3 Desktop on the computer you want to share. Copy
   its desktop ID.
2. On a client that can manage access to the destination environment, enter that
   ID in **User desktops** and choose an access level before creating the
   pairing code. All three options include the thread and preview operation
   permissions required for desktop hosting: **Standard desktop** grants
   standard T3 Code client access (files, Git, terminals, settings, access) plus
   desktop hosting (or, when shown as **Standard desktop (limited)**, only the
   standard permissions the issuing session holds); **Desktop hosting +
   commands** adds terminal and command-management access for that paired
   session; and **Desktop hosting only** omits file browsing, Git writes,
   settings changes, and terminal access for that session. Hosted commands run
   on an enrolled desktop remain governed by the requester's permissions and
   the desktop's own approval.
3. On the computer from step 1, add the environment in T3 Desktop and redeem
   the credential there. Pairing again at the same address replaces that
   desktop's saved permissions for that connection. If a desktop lost file or
   client access after a host-only enrollment, issue a fresh **Standard
   desktop** enrollment from a client holding the needed permissions and redeem
   it at the same address.
4. Select the destination in User desktops and check that the computer is
   online. The desktop app must stay connected to host requests.

The desktop that runs an environment's native backend can already host for
that environment. For a standalone or remote server, enroll each host. The
same desktop can participate in more than one environment. Rename it to make
it easy to select when several computers are online.

You can also issue an enrollment from the environment's installed CLI with
`t3 auth pairing create --user-desktop-id <desktop-id> --base-url <environment-url>`.
The CLI grants desktop hosting by default. To add command access, repeat
`--scope` for `preview:operate`, `orchestration:read`, `orchestration:operate`,
and `terminal:operate` when creating the credential.
Revoke the paired client in **Sharing & access** to withdraw its credential.
Remove an offline desktop from the inventory to forget its name.

## Prepare access

Select the desktop and review its availability and permissions before leaving
it unattended. Availability keeps the session awake for work. It does not
unlock a manually locked computer. Release availability when the work ends
and you want the host's normal idle locking and suspend settings to apply.

View permission allows screen observations. Control permission also allows
keyboard and pointer input. A host may still need the operating system's
screen-sharing dialog. Complete that dialog on the desktop you selected.

For unattended work, prepare view or control access on the host in advance.
Managing these grants requires terminal operation permission on the environment.
Preparing a grant leaves the current controller in place.
Remembered native access lets the operating system attempt to restore the
selected access later. The host can still request consent after a session
change. A T3 capability grant separately identifies who may use that access.

Grant access to a thread, an environment, or the desktop. A thread grant can
cover its descendants. Choose an automatic expiry, a deadline, or access
until revoked. Remember a grant across restart only when the work needs it.
Review existing grants and remove the specific grant when its task ends.

A client connected to the selected desktop's native backend may approve
eligible requests remotely. Requests for another host may require someone
at that host. Use the pending request's source and scope to check which
thread or environment will receive access.

## Watch and take control

Open the live viewer for a concrete desktop. Viewing leaves the current
controller in charge. To interact, request control. A conflict with another
human can require confirmation of the current lease. Switching to another
desktop requires a separate grant on that target.

Keep the viewer focused while using the keyboard. Leaving it releases held
keys. Close the viewer to release its lease. If you displaced an agent that
is still viewing, return control when you are finished and it can continue
from the same application state.

A retained observation shows the pixels delivered to the agent at the
recorded time. Select an observation to inspect its overview, detail regions
or accessibility information when present. Use the live view to see the
desktop's current state.

## Run commands and follow transfers

A command runs as the operating-system account hosting the selected desktop.
Review the command permission independently of screen permissions. Inspect
which thread requested access and the lifetime of its grant before approving.

Use the command panel to start an authorized command and inspect its output.
Interactive processes can accept input while running. Closing a viewer or
releasing keyboard control leaves independently authorized commands running.
Stop a process explicitly when the work should end.

To copy files, ask the agent to name the source, destination and desktop.
Paths on a User desktop belong to that computer. Workspace paths belong to
the environment running the thread. A transfer reports progress through
staging, transfer, verification and installation. Review active transfers
before disconnecting a host or detaching a worktree they use.

## Manage an Agent desktop

Agent desktops run in the selected environment. Check the host requirements
and prepare the base image before asking a thread for a desktop. A thread can
reuse a suitable guest or ask for a fresh one for independent work.

Select a VM to inspect CPU, memory, disk allocation and sampled network
traffic. Open its connection details to inspect sockets. A port route
forwards a host port to a service in one guest. Choose the intended
visibility and remove the route when the service is no longer needed.

Check maintenance status before starting conflicting work. Automatic updates
can maintain an idle guest. Choose manual updates when you need to pin its
state. You can request a guest update or refresh the base for future guests.
If an update fails, inspect its reported maintenance or rollback state.

Parking preserves a guest for later use. Close viewers and let active work
finish before parking or deleting it. Deleting a guest moves it to trash
for seven days. Restore it during that window or permanently delete it when
you are ready to discard its disks.

## Supervise a thread

Open the thread's monitors to inspect its outstanding waits. For a screen
watch, inspect the current revision and its retained baseline, preceding,
current or terminal evidence. A review request can pause evaluation until
the controller acknowledges or revises the watch. Cancel a wait when its
outcome no longer matters. See [Durable waits and monitoring](./durable-monitors.md).

When moving a thread back to the project checkout, choose whether to keep
its worktree directory. Stop work that uses the checkout before removing
it. Inspect local changes before forcing removal. If detachment succeeded
but cleanup failed, the thread has already moved. Use the reported checkout
path and failure reason to finish recovery.

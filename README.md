# T3 Code (soupslurpr fork)

T3 Code with native desktop control, commands on connected computers, isolated agent desktops, and
persistent monitoring.

This is an independent fork of [T3 Code](https://github.com/pingdotgg/t3code), a web, desktop, and mobile
interface for coding agents. It extends agents' reach into desktop applications and connected
computers, with controls for watching their work and managing access.

## What agents can do

- **Use desktop applications.** Inspect screens, work with windows and controls, and enter text on an
  explicitly selected desktop.
- **Run commands on connected computers.** Choose a T3 desktop, execute commands, provide input, and
  read their output independently of screen sharing.
- **Work in isolated desktops.** Give agents their own Linux virtual machines. Reuse a desktop across
  turns, transfer files, and checkpoint or clone it before making changes.
- **Monitor conditions and resume work.** Wait for a time, an external signal, or a change on screen,
  then continue the same thread. Waits survive server restarts; timers and exact image-change checks
  use no model tokens.

See the [computer-use guide](./docs/user/computer-use.md) and
[monitoring guide](./docs/user/durable-monitors.md) for setup and examples.

## Supervise the work

Use **Settings → User desktops** on web, desktop, or mobile to manage connected desktops. Inspect the
observations an agent received, open a live view, take control, or return control to the agent.

Screen access and command execution have separate permissions. You can grant viewing without input
control, manage remembered access, revoke grants, inspect command output, and stop running commands. The
[desktop supervision guide](./docs/user/computer-use.md#supervising-user-desktops) explains the controls
and access history.

## Defaults and compatibility

- **Codex defaults to GPT-6-Astra with Max reasoning when available.** Explicit project, thread, and
  saved composer selections take precedence. See [Codex configuration](./docs/user/providers-codex.md).
- **Long threads load incrementally.** T3 pages Codex history, bounds the thread data it keeps in
  memory, and compacts completed tool activity.
- **Existing threads carry forward.** Codex sessions can be resumed, and compatibility migrations
  handle state from earlier fork builds.

T3 retains support for Codex, Claude Code, Cursor, Grok Build, OpenCode, and Antigravity. Configure an
authenticated provider on the machine hosting the environment; see
[provider setup](./docs/user/install.md#providers) and [permission modes](./docs/user/permission-modes.md).

| Capability                        | Host requirements                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Native screen viewing and control | A T3 desktop client on Linux with GNOME Wayland and the required desktop portals.                                                             |
| Commands on a connected desktop   | A compatible T3 desktop client on Linux, macOS, or Windows.                                                                                   |
| Isolated agent desktops           | An x86-64 Arch Linux environment host with KVM, QEMU, and the prerequisites in the [setup guide](./docs/user/computer-use.md#agent-desktops). |

Web and mobile clients can supervise supported remote desktops. Use matching builds of this fork on
the server and clients for its additional controls; the public web app and store apps follow upstream.

## Install this fork

Build from this repository. The installers at `t3.codes`, `npx t3@latest`, the official
package-manager listings, and [upstream releases](https://github.com/pingdotgg/t3code/releases) install upstream T3 Code. This fork
currently has no published release downloads.

The checkout requires Node.js 24.13.1 or later in the 24.x series, plus Vite+ (`vp`).

### Install `vp`

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows:

```powershell
irm https://vite.plus/ps1 | iex
```

See the [Vite+ getting started guide](https://viteplus.dev/guide/) for more options.

### Run from source

```bash
git clone https://github.com/soupslurpr/t3code.git
cd t3code
vp i
vp run dev
```

Open the pairing URL printed by the development runner. To launch the Electron desktop app, use
`vp run dev:desktop` instead of `vp run dev`.

### Build and install

- **Arch Linux:** Follow the [local Arch package guide](./docs/operations/local-arch-package.md) to build
  an AppImage, package it in a clean chroot, and install the audited fork package.
- **Other desktop builds:** Follow the [desktop build guide](./docs/operations/development.md#desktop-artifacts)
  for platform prerequisites and artifact commands.
- **Mobile:** Follow the [mobile build guide](./apps/mobile/README.md) to build a matching client.

The [development guide](./docs/operations/development.md) covers local state, ports, testing, and remote
development. [Remote access](./docs/user/remote-access.md) covers connecting another device.

## Documentation

- [Computer use and desktop commands](./docs/user/computer-use.md)
- [Durable waits and monitoring](./docs/user/durable-monitors.md)
- [Working with threads](./docs/user/thread-sidebar.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Remote access](./docs/user/remote-access.md)
- [Project settings](./docs/user/project-settings.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [All documentation](./docs/README.md)

## Upstream and license

T3 Code is developed by the [upstream maintainers](https://github.com/pingdotgg/t3code). This fork adds
its own capabilities and defaults on top of their work. See [LICENSE](./LICENSE) and
[CREDITS](./CREDITS) for licensing and attribution.

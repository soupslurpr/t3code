# Agent desktops

Each environment owns its QEMU/KVM machines. The system and writable UEFI
disks live under `agent-desktops/machines`. A version 1 `desktops.json`
records their owner, backing generation, published routes, lifecycle and
maintenance state. An idle assignment can pass to a new controller in the
same thread. Moving it to another thread requires an explicit handoff.

A manifest selects the immutable Arch base for new machines. Existing
overlays, clones and seven-day trash keep their backing files alive. A
custom base supplied through `T3CODE_AGENT_DESKTOP_IMAGE` remains under
the administrator's control. Software graphics can save and resume guest
memory. Virgl uses a clean shutdown because its GPU state cannot migrate.

Guest updates need a rollback point on **both** disks. Persist the marker
before changing guest packages and reconcile interrupted maintenance on
reattach, before accepting an operation. Active leases and work prevent
parking. The ten-minute idle timer, explicit parking preference, automatic
update policy and thirty-day retirement policy are separate decisions.

The computer router admits operations for a concrete desktop. Rust reads
the private VNC socket and returns the framebuffer geometry used for QMP
tablet input. AT-SPI locators belong to one controller observation.
Screenshot-only captures can run between observation and activation.
Guest commands use the shared job ledger. Workspace transfers use the
same stream and bundle checks as User desktops, with bounded QGA reads
and writes between the server and guest.

Passt binds local routes to loopback, tailnet routes to the Tailscale IPv4
address and network routes to all IPv4 interfaces. Telemetry samples
the VM's systemd cgroup and guest interfaces on demand. A packet capture
owns a unique QEMU filter and an independent deadline. Reattachment must
remove abandoned filters. Publish a private PCAP only after the writer is
detached and the file ends on a complete record.

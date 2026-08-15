# Agent Desktops

Agent desktops are environment-local QEMU/KVM machines that let multiple agents perform GUI work
without colliding with the user's desktop or with one another. The feature reuses the computer-use
observation and action contract; only desktop selection and lifecycle ownership differ.

## Routing And Ownership

The MCP toolkit sends Agent desktop operations through the existing preview-automation broker to the
desktop client attached to that environment. The desktop process owns the hypervisor and persists a
versioned inventory below its Agent desktop state directory. A desktop owner is the tuple of
environment, thread, and controller identifiers. Every lifecycle, guest, and computer-use request
checks that tuple before acting.

Computer requests select either the user desktop or an Agent desktop. Omitting an Agent desktop id
lets the manager reuse the controller's suitable assignment or acquire a new machine. The computer
router keeps the two backends behind one current request shape; there is no legacy host-only IPC
request path.

## Machine Boundary

Each machine runs as one transient systemd user service with KVM acceleration, UEFI, a qcow2 overlay,
private QMP and guest-agent Unix sockets, emulated keyboard and tablet devices, virtio networking, and
a bounded cgroup memory policy. Runtime socket directories and persistent machine directories are
owner-only. The manager invokes guest commands and file operations through QEMU Guest Agent, captures
software-display frames through QMP, and injects input through QEMU's input events. Accelerated
desktops render OpenGL with virgl through EGL headless. They expose a raw framebuffer over a
private Unix-domain VNC socket so observation does not require a visible host window or another
runtime dependency. QEMU events provide hardware-like pointer input and deliberate key holds. Timed
QEMU key chords provide self-releasing presses, hotkeys, and exact ASCII fallback text. Exact
Unicode uses the guest AT-SPI editable-text interface when one active target can be identified and
verifies the inserted substring without reading or changing the clipboard. If that interface is
unavailable, non-ASCII input fails explicitly instead of risking an application-dependent Unicode
entry sequence.

The guest image boots directly into a dedicated GNOME user. It enables toolkit accessibility,
disables guest idle locking and suspend, starts QEMU Guest Agent, and does not expose SSH. Packaged
builds include a dependency-free image builder. Approved first-use setup downloads an immutable,
pinned official Arch qcow2 image over HTTPS, validates its exact size and embedded published SHA-256,
provisions through a NoCloud FAT seed, validates the result, and atomically installs a compressed
base image. Downloads resume through a private partial file; verified sources are cached while failed
build overlays are removed. Setup is serialized so concurrent agents cannot race the same image.
The repository command can still consume a caller-supplied qcow2 image and requires a SHA-256 unless
verification is explicitly skipped.

Semantic observations run a bounded AT-SPI helper inside the guest. Target and top-level window
identifiers include an accessibility generation and expire under the same one-action rule as host
semantic identifiers. This keeps stale target behavior identical across both desktop kinds.

## Workspace Transfer Boundary

The Agent desktop toolkit copies files and directory trees only across a typed workspace/guest
boundary. The server resolves the current thread's project or worktree from the projection, rejects
absolute workspace paths, and checks canonical source and destination ancestors before touching
disk. A standalone symlink and every link that lexically leaves the copied tree are rejected.

Transfer metadata and control use MCP, the preview-automation broker, and typed Electron IPC. File
bytes do not: the server creates a 256-bit, six-hour bearer capability for one exact upload or
download, and the desktop main process streams bounded 8 MiB ranges directly against the
environment HTTP endpoint. Capability paths are accepted only in their server-issued relative form,
carry no query or redirect target, and are removed when the operation settles. Uploads are
sequential and idempotent, so a lost response can retry an already stored range only when its bytes
match. Each upload has its own semaphore, preserving parallel transfers across desktops.

Both sides implement the same small versioned bundle format. The host codec streams Node files; a
packaged dependency-free Python helper does the same inside the guest through QEMU Guest Agent.
Directories are traversed in lexical order, portable modes and modification times are retained, and
auto compression uses a bounded sample before choosing fast gzip. The receiver verifies SHA-256,
entry paths, entry counts, file lengths, link targets, and the complete tree summary. Extraction
occurs in a fresh sibling staging path before an atomic create or replacement, or a type-checked
directory merge. Home-directory imports are assigned to the graphical guest user; explicit system
paths retain root ownership. Active progress is kept in one server registry shared by MCP and the
HTTP routes, terminal results remain queryable for 24 hours, cancellation interrupts both sides,
and stale transport archives are pruned on startup.

## Resources And Lifecycle

Admission keeps at least 2 GiB and 20 percent of host memory free. A guest receives 2–8 GiB of memory,
up to six virtual CPUs divided fairly across running desktops, and a sparse virtual disk sized from
the declared temporary-disk need. Work that prefers or requires graphics targets 6 GiB; ordinary
work targets 4 GiB. New desktops automatically select accelerated graphics when the complete host path is usable.
Tasks can require acceleration, prefer it with a software fallback, or explicitly request software
graphics. The selected backend, acceleration status, and checkpoint mode are part of every desktop
summary. The systemd unit applies memory high and maximum bounds in addition to the guest's
configured memory.

Unleased desktops park after ten idle minutes unless their task requests `preventParking`. That
request persists across releases and restarts until the owning agent explicitly acquires the same
desktop with `preventParking: false`; summaries and Settings surface whether automatic parking is
enabled. Parking
saves complete machine state for software graphics, stops QEMU, and frees CPU and memory. Virgl GPU
state is not migratable, so accelerated desktops instead perform a clean guest shutdown and cold
boot on resume. Their checkpoints atomically snapshot the system and firmware disks while the guest
filesystem is frozen; software desktops retain full machine-state checkpoints. Cloning pauses and
flushes both live drives, converts them with shared-source access, and resumes the source even if
copying fails. Deletes are recoverable for seven days unless permanent deletion is explicitly
requested.

## Networking

Every machine receives an independent passt NAT connection. The manager combines host interface
counters with bounded guest socket inspection for per-desktop totals, rates, drops, addresses, and
optional process attribution. Ordinary telemetry retains no packet bodies.

Port publication is explicit. The manager allocates a host port and asks passt to map it to one guest
port. Visibility determines whether the host bind is loopback, the active Tailscale address, or all
interfaces. Routes persist with the desktop and are restored on start. Packet capture is a separate,
bounded operation that returns a private artifact only after an explicit request.

## Verification

Focused unit tests cover contracts, admission, routing, input conversion, private framebuffer
decoding, prerequisite remedies, pinned download validation, image generation, host/guest bundle
interoperability, ranged downloads, resumable uploads, integrity checks, and cancellation. The
retained AppImage smoke test can require fresh image provisioning and then exercises prerequisite
reporting, guest commands, a multi-chunk directory transfer with Unicode, binary data, symlinks,
ownership and collision handling, network access, screenshots, semantic targets, graphical input,
human takeover, checkpoint, live clone, park/resume, and cleanup against a real KVM guest.

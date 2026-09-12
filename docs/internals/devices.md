# Devices

The environment server owns simulators and emulators the way it owns
terminals: discovery, streaming, and agent access all run there, and every
client reaches them through the environment connection. This is what makes the
Device panel work over Tailscale and T3 Connect, including when an SSH host runs the devices.

## Two external tools, one seam

[expo-device-hub](../../apps/server/src/device/LocalDeviceHost.ts) streams and
[agent-device](../../apps/server/src/device/AgentDeviceShim.ts) drives. Helpers
are prepared when devices are used so ordinary agent sessions incur no device
setup or process overhead. The hub runs in a supervised child because serve-sim
loads private CoreSimulator frameworks through a native addon, and a crash there
must not take the server down.

Everything platform-specific sits behind
[`DeviceHost`](../../apps/server/src/device/DeviceHost.ts). The service lists,
boots, and shuts down devices through the host's device operations, and the
proxy and the MCP tools only see a hub origin and an agent-device endpoint.
Hosts that run expo-device-hub share one hub-backed implementation of those
operations, so a host whose devices live elsewhere only replaces them.
SSH hosts forward both endpoints to server loopback. Every proxied request
also carries the host id; device ids alone are not unique across hosts.

## EAS Simulator hosts are billed sessions

An [EAS host](../../apps/server/src/device/EasDeviceHost.ts) has no machine:
each opened device is an EAS Simulator session that bills the Expo account
until it stops. Every session is created with the host's run and idle limits,
the host refuses to start past its session limit, and closing the host stops
its sessions. Sessions it starts are recorded under the state directory and
stopped by the next server if this one dies; sessions other tools started on
the same account are never touched.

Each session brings its own serve-sim preview host and agent-device daemon,
with their own tokens. The proxy asks the host to route each request
(`DeviceHostReady.upstream`) and adds the session token server-side, so
clients never hold it. Agent config files are written per device
(`DeviceOperations.agentEndpoint`), which is why `device_open` opens the
device before targeting it. Device settings run `simctl` on the simulator's
machine, which EAS does not expose, so they are unavailable there.

## The hub is never exposed

serve-sim has a shell-exec route whose token is readable from its own
unauthenticated `/api`, and serve-emu's action routes have no auth at all. The
hub binds loopback and the only way in is the
[proxy](../../apps/server/src/device/DeviceHubProxy.ts), which allowlists the
stream, config, and screenshot routes and authenticates every request as an
environment session. `<img>` and `WebSocket` cannot carry headers, so the proxy
authenticates like the `/ws` upgrade: cookie, or a short-lived `wsTicket` that
bearer and DPoP clients mint over authenticated HTTP. The ticket is stripped
before the request reaches the hub.

Stream responses carry `Cache-Control: no-transform`; the compression
middleware would otherwise buffer an MJPEG body that never ends. Browsers paint an
MJPEG part only once the next part begins and the hub writes one only when the
screen changes, so the proxy
[re-sends the last part](../../apps/server/src/device/mjpegStillFrame.ts) after a
short quiet period. In browser dev, the Vite proxy must forward WebSocket
upgrades for `/api`, not only `/ws`.

## Device settings never go through the hub

serve-sim's preview drives its Tools panel by sending shell commands over that
same exec channel. Proxying it, even allowlisted, would hand any environment
session arbitrary command execution on the host, so T3 does not. The
[`device.action`](../../apps/server/src/device/DeviceActions.ts) RPC runs the
underlying `simctl`, `adb`, and serve-sim helper binaries itself through
`DeviceHostReady.run`, one typed action per control, and returns the settings
it reads back. The proxy allowlist grows only with read routes (accessibility
tree, foreground app, event log) and refuses non-GET methods everywhere except
screenshot capture and stream tuning.

## Agent access

Agents can use T3's managed CLI or their existing device tools. `device_open`
returns an explicit launcher, leaving the provider's PATH unchanged so installed
tools remain usable. Platform readiness belongs to the selected device host,
allowing environments without local simulator support to use remote hosts.

Detailed driving guidance arrives when a device is opened, keeping ordinary
threads' context small and the instructions aligned with the installed tool.

## The viewer decodes both vendored protocols

The hub vendors two streaming servers with different wire formats. iOS video is
an HTTP body of AVCC envelopes decoded with WebCodecs, with input on a separate
binary WebSocket; Android multiplexes SEMU-framed H.264 and JSON gestures over
one WebSocket. [`deviceStream.ts`](../../apps/web/src/components/device/deviceStream.ts)
speaks both so one panel covers both platforms.

Simulators encode H.264 High 5.1. Hardware decoders on some machines and all
headless browsers reject that profile, and WebCodecs is secure-context only, so
the viewer probes `isConfigSupported` and falls back to the MJPEG endpoint on
iOS. Android has no MJPEG; there the panel reports that it cannot decode.

serve-sim can also be locked to WebRTC, as on EAS Simulator, and then refuses
AVCC with a 409 naming the transport. The viewer still asks for AVCC first, so
hubs that serve it pay nothing, and switches on that 409, or when its MJPEG
image fails in a browser that has `RTCPeerConnection`. Offers are not trickled:
serve-sim takes one offer with every candidate. The video element only feeds
the same canvas sink, so the panel and the mobile WebView keep one surface.

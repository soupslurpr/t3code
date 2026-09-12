// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - hashed, bundled installer inputs, also sent to SSH hosts.
import { createHash } from "node:crypto";
import hubLock from "./toolchain/expo-device-hub.lock.json" with { type: "json" };
import agentLock from "./toolchain/agent-device.lock.json" with { type: "json" };
import nativeAssets from "./toolchain/node-datachannel.assets.json" with { type: "json" };

export const DEVICE_HUB_VERSION = hubLock.packages[""].dependencies["expo-device-hub"];
export const AGENT_DEVICE_VERSION = agentLock.packages[""].dependencies["agent-device"];

export const deviceToolLocks = {
  "expo-device-hub": hubLock,
  "agent-device": agentLock,
};

export type DeviceToolName = keyof typeof deviceToolLocks;

/** Changing the dependency closure creates a separate install, including across running servers. */
export const deviceToolRevision = (name: DeviceToolName) =>
  createHash("sha256")
    .update(
      JSON.stringify([deviceToolLocks[name], name === "expo-device-hub" ? nativeAssets : null, 1]),
    )
    .digest("hex")
    .slice(0, 16);

/** Only this reviewed native artifact is installed; npm lifecycle scripts stay disabled. */
export const finishDeviceNativeInstall = `async function (directory) {
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  const { createGunzip } = require('node:zlib');
  const assets = ${JSON.stringify(nativeAssets)};
  const platform = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'linuxmusl' : process.platform;
  const arch = process.arch === 'ia32' ? 'x86' : process.arch;
  const asset = 'node-datachannel-v0.32.3-napi-v8-' + platform + '-' + arch + '.tar.gz';
  const expected = assets[asset];
  if (!expected) throw Error('No reviewed device streaming binary for ' + platform + '/' + arch);
  const response = await fetch('https://github.com/murat-dogan/node-datachannel/releases/download/v0.32.3/' + asset, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error('Downloading device streaming binary: HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Device streaming binary checksum mismatch');
  const nativeDir = path.join(directory, 'node_modules/node-datachannel');
  const tar = require(path.join(directory, 'node_modules/tar-fs'));
  await pipeline(Readable.from([bytes]), createGunzip(), tar.extract(nativeDir, {
    ignore: (_, header) => header.type !== 'directory' && !(header.type === 'file' && header.name === 'build/Release/node_datachannel.node'),
  }));
  require(path.join(nativeDir, 'build/Release/node_datachannel.node'));
}`;

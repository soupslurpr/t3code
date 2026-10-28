// @effect-diagnostics nodeBuiltinImport:off - synchronous digests define shared local/SSH install paths.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
  NodeCrypto.createHash("sha256")
    .update(
      encodeJson([deviceToolLocks[name], name === "expo-device-hub" ? nativeAssets : null, 1]),
    )
    .digest("hex")
    .slice(0, 16);

/** npm verifies locked packages; verify the exact native payload before marking the install ready. */
export const finishDeviceNativeInstall = `async function (directory) {
  const path = require('node:path');
  const fs = require('node:fs');
  const { createHash } = require('node:crypto');
  const assets = ${encodeJson(nativeAssets)};
  const libc = process.platform === 'linux' ? require(path.join(directory, 'node_modules/detect-libc')) : null;
  const suffix = process.platform === 'linux' ? (libc.familySync() === libc.MUSL ? '-musl' : '-gnu') : process.platform === 'win32' ? '-msvc' : '';
  const target = process.platform + '-' + process.arch + suffix;
  const expected = assets[target];
  if (!expected) throw Error('No reviewed device streaming binary for ' + target);
  const nativeDir = path.join(directory, 'node_modules/@node-datachannel', target);
  const version = JSON.parse(fs.readFileSync(path.join(nativeDir, 'package.json'), 'utf8')).version;
  if (version !== expected.version) throw Error('Device streaming binary version mismatch');
  const binary = path.join(nativeDir, 'node_datachannel.node');
  if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== expected.sha256) throw Error('Device streaming binary checksum mismatch');
  require(binary);
}`;

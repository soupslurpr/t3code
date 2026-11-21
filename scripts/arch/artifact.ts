// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Arch packaging runs host tools and verifies files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { extractFile } from "@electron/asar";
import { assertInvariant, runCommand } from "./common.ts";

interface EmbeddedBuildInfo {
  readonly version: string;
  readonly buildVersion: string;
  readonly commitHash: string;
}

export function extractAppImage(appImagePath: string, tempRoot: string): string {
  const extractDir = NodePath.join(tempRoot, "appimage");
  NodeFS.mkdirSync(extractDir);
  runCommand(appImagePath, ["--appimage-extract"], {
    cwd: extractDir,
    quiet: true,
    discardOutput: true,
  });
  const appImageRoot = NodePath.join(extractDir, "squashfs-root");
  assertInvariant(
    NodeFS.statSync(appImageRoot).isDirectory(),
    "AppImage extraction produced no root",
  );
  return appImageRoot;
}

export function readEmbeddedBuildInfo(asarPath: string): EmbeddedBuildInfo {
  const packageJson = JSON.parse(extractFile(asarPath, "package.json").toString("utf8")) as {
    readonly version?: unknown;
    readonly buildVersion?: unknown;
    readonly t3codeCommitHash?: unknown;
  };
  assertInvariant(typeof packageJson.version === "string", "AppImage ASAR has no version");
  assertInvariant(
    typeof packageJson.buildVersion === "string",
    "AppImage ASAR has no build version",
  );
  assertInvariant(
    typeof packageJson.t3codeCommitHash === "string" &&
      /^[a-f0-9]{40}$/u.test(packageJson.t3codeCommitHash),
    "AppImage ASAR has no commit hash",
  );
  return {
    version: packageJson.version,
    buildVersion: packageJson.buildVersion,
    commitHash: packageJson.t3codeCommitHash,
  };
}

export function verifyAppImageBuild(
  appImageRoot: string,
  version: string,
  gitCommit: string,
): EmbeddedBuildInfo {
  const asarPath = NodePath.join(appImageRoot, "resources/app.asar");
  assertInvariant(NodeFS.statSync(asarPath).isFile(), "AppImage is missing resources/app.asar");
  const buildInfo = readEmbeddedBuildInfo(asarPath);
  assertInvariant(buildInfo.version === version, "AppImage version does not match desktop package");
  assertInvariant(
    buildInfo.buildVersion === version,
    "AppImage build version does not match desktop package",
  );
  assertInvariant(
    gitCommit === buildInfo.commitHash,
    "AppImage commit does not match the committed source",
  );
  return buildInfo;
}

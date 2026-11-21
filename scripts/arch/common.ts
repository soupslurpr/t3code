// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Arch packaging runs host tools and verifies files on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export const PACKAGE_NAME = "t3code-soupslurpr-bin";

export const PACKAGE_ARCH = "x86_64";

export const STAGE_MANIFEST_NAME = ".t3code-local-arch-package.json";

export const STAGE_DIR_NAME = "arch-package";

export const MANIFEST_SCHEMA_VERSION = 1;

export const FORK_URL = "https://github.com/soupslurpr/t3code";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

export class LocalArchPackageError extends Schema.TaggedError<LocalArchPackageError>()(
  "LocalArchPackageError",
  { message: Schema.String },
) {}

export function assertInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new LocalArchPackageError({ message });
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function sha256Buffer(buffer: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(buffer).digest("hex");
}

export function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly quiet?: boolean | undefined;
    readonly discardOutput?: boolean | undefined;
    readonly allowFailure?: boolean | undefined;
  },
): { readonly stdout: string; readonly stderr: string; readonly status: number } {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.discardOutput
      ? ["ignore", "ignore", "pipe"]
      : options.quiet
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "inherit"],
  });
  if (result.error) {
    throw new LocalArchPackageError({
      message: `failed to run ${command}: ${result.error.message}`,
    });
  }
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    const stderr = (result.stderr ?? "").trim();
    throw new LocalArchPackageError({
      message:
        stderr.length > 0
          ? `${command} exited with status ${status}: ${stderr}`
          : `${command} exited with status ${status}`,
    });
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status,
  };
}

function commandExists(command: string, cwd: string): boolean {
  return (
    runCommand("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      cwd,
      quiet: true,
      allowFailure: true,
    }).status === 0
  );
}

export function requireCommands(commands: ReadonlyArray<string>, cwd: string): void {
  const missingCommands = commands.filter((command) => !commandExists(command, cwd));
  assertInvariant(
    missingCommands.length === 0,
    `missing required commands: ${missingCommands.join(", ")}`,
  );
}

export function readCleanGitCommit(rootDir: string): string {
  const status = runCommand("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: rootDir,
    quiet: true,
  }).stdout.trim();
  assertInvariant(status.length === 0, "source checkout must be clean before packaging");
  const commit = runCommand("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    quiet: true,
  }).stdout.trim();
  assertInvariant(/^[0-9a-f]{40}$/.test(commit), "failed to resolve the packaging commit");
  return commit;
}

export function readDesktopVersion(rootDir: string): string {
  const packageJsonPath = NodePath.join(rootDir, "apps/desktop/package.json");
  const packageJson = JSON.parse(NodeFS.readFileSync(packageJsonPath, "utf8")) as {
    readonly version?: unknown;
  };
  assertInvariant(
    typeof packageJson.version === "string" && VERSION_PATTERN.test(packageJson.version),
    `invalid desktop version in ${packageJsonPath}`,
  );
  return packageJson.version;
}

export function readInstalledPackageVersion(rootDir: string): string | undefined {
  const result = runCommand("pacman", ["-Q", PACKAGE_NAME], {
    cwd: rootDir,
    quiet: true,
    allowFailure: true,
  });
  if (result.status === 0) return result.stdout.trim();
  const legacy = runCommand("pacman", ["-Q", "t3code-bin"], {
    cwd: rootDir,
    quiet: true,
    allowFailure: true,
  });
  return legacy.status === 0 ? legacy.stdout.trim() : undefined;
}

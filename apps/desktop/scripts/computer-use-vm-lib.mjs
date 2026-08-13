import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:29222";
const DEFAULT_SSH_HOST = "127.0.0.1";
const DEFAULT_SSH_PORT = 22022;
const DEFAULT_SSH_USER = "t3test";
const CDP_DISCOVERY_TIMEOUT_MS = 10_000;
const CDP_EVALUATION_TIMEOUT_MS = 120_000;
const APP_RENDERER_URL = "t3code://app/";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repositoryRoot = NodePath.resolve(scriptDirectory, "../../..");

/** Parses one bounded positive integer environment value. */
function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/** Resolves the local endpoints and SSH identity for the retained VM fixture. */
export function resolveComputerUseVmConfig(environment = process.env) {
  return {
    cdpEndpoint: environment.T3_COMPUTER_USE_VM_CDP_URL ?? DEFAULT_CDP_ENDPOINT,
    sshHost: environment.T3_COMPUTER_USE_VM_SSH_HOST ?? DEFAULT_SSH_HOST,
    sshPort: positiveInteger(
      environment.T3_COMPUTER_USE_VM_SSH_PORT,
      DEFAULT_SSH_PORT,
      "T3_COMPUTER_USE_VM_SSH_PORT",
    ),
    sshUser: environment.T3_COMPUTER_USE_VM_SSH_USER ?? DEFAULT_SSH_USER,
    sshKeyPath:
      environment.T3_COMPUTER_USE_VM_SSH_KEY ??
      NodePath.join(repositoryRoot, "release/computer-use-vm/seed/id_ed25519"),
    knownHostsPath:
      environment.T3_COMPUTER_USE_VM_KNOWN_HOSTS ??
      NodePath.join(repositoryRoot, "release/computer-use-vm/seed/known_hosts"),
  };
}

/** Selects the app renderer while allowing its normal hash-based navigation. */
export function selectComputerUseVmTarget(targets) {
  return targets.find(
    ({ type, url }) =>
      type === "page" && (url === APP_RENDERER_URL || url.startsWith(`${APP_RENDERER_URL}#`)),
  );
}

/** Evaluates one expression in the retained VM's T3 Code renderer. */
export async function evaluateComputerUseVm(
  config,
  expression,
  { timeoutMs = CDP_EVALUATION_TIMEOUT_MS } = {},
) {
  const targetsUrl = new URL("/json/list", config.cdpEndpoint);
  const response = await fetch(targetsUrl, {
    signal: AbortSignal.timeout(CDP_DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
  }
  const targets = await response.json();
  const target = selectComputerUseVmTarget(targets);
  if (target === undefined) throw new Error("T3 Code renderer target is unavailable");

  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      socket.close(4000, "evaluation timed out");
      reject(new Error(`CDP evaluation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (operation) => {
      clearTimeout(timeout);
      socket.close();
      operation();
    };
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
        }),
      );
    });
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id !== 1) return;
      if (message.error !== undefined) {
        finish(() => reject(new Error(message.error.message ?? "CDP evaluation failed")));
        return;
      }
      if (message.result?.exceptionDetails !== undefined) {
        const detail = message.result.exceptionDetails;
        const description =
          detail.exception?.description ?? detail.text ?? "renderer evaluation failed";
        finish(() => reject(new Error(description)));
        return;
      }
      finish(() => resolve(message.result?.result?.value));
    });
    socket.addEventListener("error", () => {
      finish(() => reject(new Error("CDP WebSocket failed")));
    });
  });
}

/** Reads GNOME's persistent toolkit-accessibility setting inside the VM. */
export async function readVmToolkitAccessibility(config) {
  const { stdout } = await execFile(
    "ssh",
    [
      "-i",
      config.sshKeyPath,
      "-p",
      String(config.sshPort),
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${config.knownHostsPath}`,
      `${config.sshUser}@${config.sshHost}`,
      "gsettings get org.gnome.desktop.interface toolkit-accessibility",
    ],
    { cwd: repositoryRoot, timeout: 10_000 },
  );
  const value = stdout.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`unexpected toolkit-accessibility value ${JSON.stringify(value)}`);
}

/** Converts a base64 PNG length to its exact decoded byte count. */
export function decodedBase64Bytes(data) {
  if (data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** Estimates GPT-5.6 original-detail image tokens from 32-pixel patches. */
export function gpt56OriginalImageTokens(width, height) {
  return width === 0 || height === 0 ? 0 : Math.ceil(width / 32) * Math.ceil(height / 32);
}

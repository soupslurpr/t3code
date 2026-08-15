import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:39223";
const CDP_DISCOVERY_TIMEOUT_MS = 60_000;
const CDP_EVALUATION_TIMEOUT_MS = 76 * 60 * 1_000;
const keepDesktopOnFailure = process.env.T3_AGENT_DESKTOP_SMOKE_KEEP_ON_FAILURE === "1";
const screenshotOutput = process.env.T3_AGENT_DESKTOP_SMOKE_SCREENSHOT;
const requireImageProvisioning = process.env.T3_AGENT_DESKTOP_SMOKE_REQUIRE_PROVISION === "1";

const makeSmokeExpression = (transferUrl) => String.raw`(async () => {
  const keepDesktopOnFailure = ${JSON.stringify(keepDesktopOnFailure)};
  const includeDiagnosticScreenshot = ${JSON.stringify(screenshotOutput !== undefined)};
  const requireImageProvisioning = ${JSON.stringify(requireImageProvisioning)};
  const transferUrl = ${JSON.stringify(transferUrl)};
  const agentDesktop = window.desktopBridge?.agentDesktop;
  const computer = window.desktopBridge?.computer;
  if (agentDesktop === undefined || computer === undefined) {
    throw new Error("Agent desktop bridges are unavailable");
  }

  const context = {
    environmentId: "agent-desktop-smoke-environment",
    threadId: "agent-desktop-smoke-thread",
    controllerId: "agent-desktop-smoke-controller",
  };
  const humanContext = { ...context, controllerId: "human:agent-desktop-smoke" };
  const result = {
    available: false,
    prerequisites: false,
    setup: false,
    imageProvisioned: false,
    graphics: null,
    graphicsAcceleration: false,
    desktopId: null,
    accessDisplaySynchronized: false,
    command: false,
    files: false,
    transfer: false,
    transferCollision: false,
    network: false,
    screenshot: null,
    semanticWindow: null,
    semanticTargets: 0,
    humanView: false,
    humanControl: false,
    checkpoint: false,
    clone: false,
    parkResume: false,
    cleanup: false,
    failure: null,
    diagnosticScreenshot: null,
  };
  let desktop = null;
  let clone = null;

  const valueOf = (envelope, step) => {
    if (envelope?.ok === true) return envelope.value;
    throw new Error(step + " failed: " + JSON.stringify(envelope?.error ?? envelope));
  };
  const manage = async (target, operation) =>
    valueOf(
      await agentDesktop.manage({ operation, desktopId: target.id }, context),
      operation,
    );

  try {
    valueOf(await agentDesktop.list(context), "list");
    const prepared = valueOf(await agentDesktop.setup(context), "setup");
    const status = prepared.status;
    result.available = status.available;
    result.imageProvisioned = prepared.imageProvisioned;
    result.setup = prepared.completed && status.available;
    if (!result.setup) throw new Error(prepared.detail ?? status.detail ?? "setup failed");
    if (requireImageProvisioning && !result.imageProvisioned) {
      throw new Error("setup did not provision a fresh base image");
    }
    result.prerequisites =
      status.requirements.length > 0 &&
      status.requirements.every(
        (requirement) =>
          requirement.status === "ready" || requirement.status === "degraded",
      );
    if (!result.prerequisites) throw new Error("host prerequisites were not reported as ready");

    desktop = valueOf(
      await agentDesktop.acquire(
        {
          fresh: true,
          label: "Agent desktop smoke test",
          requirements: { graphics: "required", preventParking: true },
        },
        context,
      ),
      "acquire",
    );
    result.desktopId = desktop.id;
    const computerTarget = { kind: "agent", desktopId: desktop.id };
    result.graphics = desktop.graphics;
    if (
      desktop.graphics?.hardwareAccelerated !== true ||
      desktop.graphics.backend !== "virgl" ||
      desktop.graphics.checkpointMode !== "disk-consistent"
    ) {
      throw new Error("Agent desktop did not select accelerated graphics");
    }

    const graphics = valueOf(
      await agentDesktop.command(
        {
          desktopId: desktop.id,
          executable: "/usr/bin/runuser",
          arguments: [
            "-u",
            "t3agent",
            "--",
            "/usr/bin/eglinfo",
            "-p",
            "gbm",
            "-B",
          ],
          timeoutMs: 30000,
          maxOutputBytes: 65536,
        },
        context,
      ),
      "guest graphics",
    );
    result.graphicsAcceleration =
      graphics.exitCode === 0 &&
      /OpenGL core profile renderer:\s*virgl\b/iu.test(graphics.stdout);
    if (!result.graphicsAcceleration) {
      throw new Error(
        "guest virgl acceleration was unavailable: " +
          JSON.stringify({
            exitCode: graphics.exitCode,
            stdout: graphics.stdout.slice(0, 2048),
            stderr: graphics.stderr.slice(0, 2048),
          }),
      );
    }

    const command = valueOf(
      await agentDesktop.command(
        {
          desktopId: desktop.id,
          executable: "/usr/bin/printf",
          arguments: ["Agent desktop command OK"],
        },
        context,
      ),
      "command",
    );
    result.command = command.exitCode === 0 && command.stdout === "Agent desktop command OK";
    if (!result.command) throw new Error("guest command returned unexpected output");

    const exactFileText = "Agent desktop files: café → 😀\n";
    valueOf(
      await agentDesktop.writeFile(
        { desktopId: desktop.id, path: "/home/t3agent/t3-smoke.txt", data: exactFileText },
        context,
      ),
      "write file",
    );
    const file = valueOf(
      await agentDesktop.readFile(
        { desktopId: desktop.id, path: "/home/t3agent/t3-smoke.txt" },
        context,
      ),
      "read file",
    );
    result.files = file.data === exactFileText && file.eof;
    if (!result.files) throw new Error("guest file round trip was not exact");

    const transferSource = "/home/t3agent/t3-transfer-source";
    const transferDestination = "/home/t3agent/t3-transfer-copy";
    const transferPayloadBytes = 9 * 1024 * 1024 + 19;
    valueOf(
      await agentDesktop.command(
        {
          desktopId: desktop.id,
          executable: "/usr/bin/mkdir",
          arguments: ["-p", transferSource + "/nested"],
        },
        context,
      ),
      "create transfer fixture",
    );
    valueOf(
      await agentDesktop.writeFile(
        {
          desktopId: desktop.id,
          path: transferSource + "/Unicode ’ →.txt",
          data: "Dinner: crème brûlée 😀\n",
        },
        context,
      ),
      "write transfer Unicode fixture",
    );
    const payload = valueOf(
      await agentDesktop.command(
        {
          desktopId: desktop.id,
          executable: "/usr/bin/python",
          arguments: [
            "-c",
            "import random,sys; open(sys.argv[1], 'wb').write(random.Random(0).randbytes(int(sys.argv[2])))",
            transferSource + "/nested/payload.bin",
            String(transferPayloadBytes),
          ],
          timeoutMs: 30000,
        },
        context,
      ),
      "write deterministic transfer payload",
    );
    if (payload.exitCode !== 0) throw new Error("transfer payload generation failed");
    const link = valueOf(
      await agentDesktop.command(
        {
          desktopId: desktop.id,
          executable: "/usr/bin/ln",
          arguments: ["-s", "../Unicode ’ →.txt", transferSource + "/nested/link"],
        },
        context,
      ),
      "create transfer symlink",
    );
    if (link.exitCode !== 0) throw new Error("transfer symlink creation failed");
    const exported = valueOf(
      await agentDesktop.transfer(
        {
          operation: "export",
          transferId: "agent-desktop-smoke-export",
          desktopId: desktop.id,
          url: transferUrl,
          guestPath: transferSource,
          compression: "none",
        },
        context,
      ),
      "export transfer fixture",
    );
    if (exported.wireBytes <= 8 * 1024 * 1024 || exported.tree.fileCount !== 2) {
      throw new Error("export did not exercise a multi-chunk directory transfer");
    }
    const imported = valueOf(
      await agentDesktop.transfer(
        {
          operation: "import",
          transferId: "agent-desktop-smoke-import",
          desktopId: desktop.id,
          url: transferUrl,
          guestPath: transferDestination,
          collision: "create",
          compression: exported.compression,
          sizeBytes: exported.wireBytes,
          sha256: exported.sha256,
        },
        context,
      ),
      "import transfer fixture",
    );
    const comparison = valueOf(
      await agentDesktop.command(
        {
          desktopId: desktop.id,
          executable: "/usr/bin/cmp",
          arguments: [
            transferSource + "/nested/payload.bin",
            transferDestination + "/nested/payload.bin",
          ],
          timeoutMs: 30000,
        },
        context,
      ),
      "compare transferred payload",
    );
    const transferredText = valueOf(
      await agentDesktop.readFile(
        { desktopId: desktop.id, path: transferDestination + "/Unicode ’ →.txt" },
        context,
      ),
      "read transferred Unicode fixture",
    );
    const transferredLink = valueOf(
      await agentDesktop.command(
        {
          desktopId: desktop.id,
          executable: "/usr/bin/readlink",
          arguments: [transferDestination + "/nested/link"],
        },
        context,
      ),
      "read transferred symlink",
    );
    const transferredOwner = valueOf(
      await agentDesktop.command(
        {
          desktopId: desktop.id,
          executable: "/usr/bin/stat",
          arguments: ["-c", "%U:%G", transferDestination + "/nested/payload.bin"],
        },
        context,
      ),
      "read transferred ownership",
    );
    result.transfer =
      imported.sha256 === exported.sha256 &&
      imported.wireBytes === exported.wireBytes &&
      comparison.exitCode === 0 &&
      transferredText.data === "Dinner: crème brûlée 😀\n" &&
      transferredLink.stdout.trim() === "../Unicode ’ →.txt" &&
      transferredOwner.stdout.trim() === "t3agent:t3agent";
    if (!result.transfer) throw new Error("Agent desktop directory transfer was not exact");
    const collision = await agentDesktop.transfer(
      {
        operation: "import",
        transferId: "agent-desktop-smoke-collision",
        desktopId: desktop.id,
        url: transferUrl,
        guestPath: transferDestination,
        collision: "create",
        compression: exported.compression,
        sizeBytes: exported.wireBytes,
        sha256: exported.sha256,
      },
      context,
    );
    result.transferCollision =
      collision?.ok === false && collision.error?.backendCode === "destination-exists";
    if (!result.transferCollision) {
      throw new Error("Agent desktop transfer collision was not categorized");
    }

    const resolved = valueOf(
      await agentDesktop.command(
        {
          desktopId: desktop.id,
          executable: "/usr/bin/getent",
          arguments: ["hosts", "example.com"],
          timeoutMs: 30000,
        },
        context,
      ),
      "guest network",
    );
    result.network = resolved.exitCode === 0 && resolved.stdout.trim().length > 0;
    if (!result.network) throw new Error("guest network resolution failed");

    const access = valueOf(
      await computer.requestControl(
        {
          desktop: { kind: "agent", desktopId: desktop.id },
          observation: {
            screenshot: { maxWidth: 800, maxHeight: 450 },
            includeAccessibility: true,
          },
        },
        context,
      ),
      "request Agent desktop control",
    );
    const observedDisplay = access.snapshot?.display;
    const statusDisplay = access.status?.displays.find(
      (display) => display.id === observedDisplay?.id,
    );
    result.accessDisplaySynchronized =
      observedDisplay !== undefined &&
      statusDisplay !== undefined &&
      statusDisplay.bounds.x === observedDisplay.bounds.x &&
      statusDisplay.bounds.y === observedDisplay.bounds.y &&
      statusDisplay.bounds.width === observedDisplay.bounds.width &&
      statusDisplay.bounds.height === observedDisplay.bounds.height;
    if (!result.accessDisplaySynchronized) {
      throw new Error("access status and initial snapshot display bounds diverged");
    }
    valueOf(
      await computer.act(
        {
          desktop: computerTarget,
          actions: [
            { type: "wait", durationMs: 3000 },
            { type: "hotkey", keys: ["Alt", "F2"] },
            { type: "wait", durationMs: 300 },
            { type: "type", text: "gnome-calculator", submit: true },
            { type: "wait", durationMs: 1000 },
            { type: "press", key: "Escape" },
          ],
          observation: false,
        },
        context,
      ),
      "launch Calculator",
    );

    const accessibilityDeadline = Date.now() + 10000;
    let accessibility = null;
    while (
      Date.now() < accessibilityDeadline &&
      (accessibility?.available !== true ||
        accessibility.targets.length === 0 ||
        !/calculator/iu.test(
          (accessibility.window?.application ?? "") + " " + (accessibility.window?.name ?? ""),
        ))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      accessibility = valueOf(
        await computer.snapshot(
          {
            desktop: computerTarget,
            screenshot: false,
            includeAccessibility: true,
          },
          context,
        ),
        "semantic snapshot",
      ).accessibility;
    }
    if (
      accessibility?.available !== true ||
      accessibility.targets.length === 0 ||
      !/calculator/iu.test(
        (accessibility.window?.application ?? "") + " " + (accessibility.window?.name ?? ""),
      )
    ) {
      const diagnostic = valueOf(
        await computer.snapshot(
          {
            desktop: computerTarget,
            screenshot: { maxWidth: 800, maxHeight: 450 },
            includeAccessibility: true,
          },
          context,
        ),
        "launch diagnostic snapshot",
      );
      const diagnosticImage = diagnostic.screenshot;
      result.screenshot =
        diagnosticImage === undefined
          ? null
          : { width: diagnosticImage.width, height: diagnosticImage.height };
      if (includeDiagnosticScreenshot && diagnosticImage !== undefined) {
        result.diagnosticScreenshot = diagnosticImage.data;
      }
      throw new Error(accessibility?.detail ?? "Calculator semantic targets were unavailable");
    }

    const calculator = valueOf(
      await computer.act(
        {
          desktop: computerTarget,
          actions: [
            { type: "type", text: "2026*37", submit: true },
            { type: "wait", durationMs: 500 },
          ],
          observation: {
            screenshot: { maxWidth: 800, maxHeight: 450 },
            includeAccessibility: true,
          },
        },
        context,
      ),
      "calculate result",
    );
    const screenshot = calculator.snapshot?.screenshot;
    result.screenshot =
      screenshot === undefined ? null : { width: screenshot.width, height: screenshot.height };
    if (includeDiagnosticScreenshot && screenshot !== undefined) {
      result.diagnosticScreenshot = screenshot.data;
    }
    if (screenshot === undefined) throw new Error("Agent desktop screenshot was missing");
    accessibility = calculator.snapshot?.accessibility ?? accessibility;
    result.semanticWindow = accessibility?.window?.application ?? null;
    result.semanticTargets = accessibility?.targets.length ?? 0;
    if (
      accessibility?.available !== true ||
      accessibility.targets.length === 0 ||
      !/calculator/iu.test(
        (accessibility.window?.application ?? "") + " " + (accessibility.window?.name ?? ""),
      )
    ) {
      throw new Error(accessibility?.detail ?? "Calculator semantic targets were unavailable");
    }
    valueOf(
      await agentDesktop.humanInvoke(
        { operation: "request-view", owner: desktop.owner, desktopId: desktop.id },
        humanContext,
      ),
      "human view",
    );
    const humanSnapshot = valueOf(
      await agentDesktop.humanInvoke(
        {
          operation: "snapshot",
          owner: desktop.owner,
          desktopId: desktop.id,
          input: {
            includeAccessibility: false,
            screenshot: { maxWidth: 400, maxHeight: 225 },
          },
        },
        humanContext,
      ),
      "human snapshot",
    );
    result.humanView = humanSnapshot.screenshot?.width > 0;
    valueOf(
      await agentDesktop.humanInvoke(
        { operation: "request-control", owner: desktop.owner, desktopId: desktop.id },
        humanContext,
      ),
      "human takeover",
    );
    valueOf(
      await agentDesktop.humanInvoke(
        {
          operation: "act",
          owner: desktop.owner,
          desktopId: desktop.id,
          input: { actions: [{ type: "hotkey", keys: ["Alt", "F4"] }], observation: false },
        },
        humanContext,
      ),
      "human input",
    );
    result.humanControl = true;
    valueOf(
      await agentDesktop.humanInvoke(
        { operation: "release", owner: desktop.owner, desktopId: desktop.id },
        humanContext,
      ),
      "human release",
    );

    valueOf(
      await computer.release({ desktop: computerTarget }, context),
      "agent release after takeover",
    );
    valueOf(
      await computer.requestControl(
        { desktop: { kind: "agent", desktopId: desktop.id }, observation: false },
        context,
      ),
      "restore agent control",
    );
    valueOf(await computer.release({ desktop: computerTarget }, context), "agent release");

    await manage(desktop, "snapshot");
    result.checkpoint = true;
    clone = valueOf(
      await agentDesktop.manage(
        { operation: "clone", desktopId: desktop.id, label: "Agent desktop smoke clone" },
        context,
      ),
      "clone",
    );
    result.clone = clone.state === "stopped";

    await manage(desktop, "park");
    await manage(desktop, "resume");
    const resumed = valueOf(
      await computer.requestView(
        {
          desktop: { kind: "agent", desktopId: desktop.id },
          observation: {
            screenshot: { maxWidth: 400, maxHeight: 225 },
            includeAccessibility: false,
          },
        },
        context,
      ),
      "view resumed desktop",
    );
    result.parkResume = resumed.snapshot?.screenshot?.width > 0;
    valueOf(
      await computer.release({ desktop: computerTarget }, context),
      "release resumed desktop",
    );

    await manage(clone, "delete-permanently");
    clone = null;
    await manage(desktop, "delete-permanently");
    desktop = null;
    result.cleanup = true;
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (desktop !== null) {
      const computerTarget = { desktop: { kind: "agent", desktopId: desktop.id } };
      try {
        await computer.release(computerTarget, humanContext);
      } catch {}
      try {
        await computer.release(computerTarget, context);
      } catch {}
    }
    if (clone !== null && (!keepDesktopOnFailure || result.failure === null)) {
      try {
        await manage(clone, "delete-permanently");
      } catch {}
    }
    if (desktop !== null && (!keepDesktopOnFailure || result.failure === null)) {
      try {
        await manage(desktop, "delete-permanently");
      } catch {}
    }
  }
  return result;
})()`;

/** Waits for the isolated desktop renderer and returns its debug target. */
async function discoverRenderer(endpoint) {
  const deadline = Date.now() + CDP_DISCOVERY_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/json/list", endpoint), {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          ({ type, url }) =>
            type === "page" && (url === "t3code://app/" || url === "t3code-dev://app/"),
        );
        if (target !== undefined) return target;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`T3 Code renderer discovery timed out: ${String(lastError)}`);
}

/** Evaluates the retained Agent desktop workflow in an isolated T3 Code renderer. */
async function evaluateSmoke(endpoint, expression) {
  const target = await discoverRenderer(endpoint);
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      socket.close(4000, "evaluation timed out");
      reject(new Error("Agent desktop smoke evaluation timed out"));
    }, CDP_EVALUATION_TIMEOUT_MS);
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
        finish(() =>
          reject(
            new Error(detail.exception?.description ?? detail.text ?? "smoke evaluation failed"),
          ),
        );
        return;
      }
      finish(() => resolve(message.result?.result?.value));
    });
    socket.addEventListener("error", () => {
      finish(() => reject(new Error("CDP WebSocket failed")));
    });
  });
}

/** Starts the bounded loopback endpoint used to exercise native transfer streaming. */
async function startTransferFixture() {
  const capabilityPath = `/api/agent-desktop-transfers/${"A".repeat(43)}`;
  let archive = Buffer.alloc(0);
  let totalBytes = null;
  const server = NodeHttp.createServer((request, response) => {
    const fail = (status, detail) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(detail);
    };
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== capabilityPath || requestUrl.search.length > 0) {
      fail(404, "not found");
      return;
    }
    if (request.method === "GET") {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (match === null) {
        fail(416, "a byte range is required");
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (start < 0 || end < start || end >= archive.byteLength) {
        fail(416, "the byte range is unavailable");
        return;
      }
      const body = archive.subarray(start, end + 1);
      response.writeHead(206, {
        "accept-ranges": "bytes",
        "content-length": String(body.byteLength),
        "content-range": `bytes ${start}-${end}/${archive.byteLength}`,
        "content-type": "application/octet-stream",
      });
      response.end(body);
      return;
    }
    if (request.method !== "PUT") {
      fail(405, "method not allowed");
      return;
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers["content-range"] ?? "");
    if (match === null) {
      fail(400, "Content-Range is required");
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const declaredTotal = Number(match[3]);
    const contentLength = Number(request.headers["content-length"]);
    const chunks = [];
    let receivedBytes = 0;
    request.on("data", (chunk) => {
      chunks.push(chunk);
      receivedBytes += chunk.byteLength;
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks, receivedBytes);
      if (
        contentLength !== body.byteLength ||
        end - start + 1 !== body.byteLength ||
        end >= declaredTotal ||
        (totalBytes !== null && totalBytes !== declaredTotal)
      ) {
        fail(400, "the upload range is invalid");
        return;
      }
      totalBytes = declaredTotal;
      if (start < archive.byteLength) {
        const replay = archive.subarray(start, end + 1);
        if (replay.byteLength === body.byteLength && replay.equals(body)) {
          response.writeHead(409, { "upload-offset": String(end + 1) });
          response.end();
          return;
        }
        fail(409, "the upload range conflicts with stored bytes");
        return;
      }
      if (start !== archive.byteLength) {
        fail(409, "the upload range is not sequential");
        return;
      }
      archive = Buffer.concat([archive, body], archive.byteLength + body.byteLength);
      response.writeHead(archive.byteLength === declaredTotal ? 201 : 204, {
        "upload-offset": String(archive.byteLength),
      });
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("transfer fixture did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}${capabilityPath}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      ),
  };
}

/** Runs and reports the isolated Agent desktop integration workflow. */
async function main() {
  const endpoint = process.env.T3_AGENT_DESKTOP_CDP_URL ?? DEFAULT_CDP_ENDPOINT;
  const transferFixture = await startTransferFixture();
  let result;
  try {
    result = await evaluateSmoke(endpoint, makeSmokeExpression(transferFixture.url));
  } finally {
    await transferFixture.close();
  }
  const diagnosticScreenshot = result?.diagnosticScreenshot;
  if (typeof result === "object" && result !== null) delete result.diagnosticScreenshot;
  if (screenshotOutput !== undefined && typeof diagnosticScreenshot === "string") {
    await NodeFSP.writeFile(screenshotOutput, Buffer.from(diagnosticScreenshot, "base64"));
  }
  console.log(JSON.stringify(result, null, 2));
  if (result?.failure !== null) throw new Error(result?.failure ?? "smoke test returned no result");
  for (const field of [
    "available",
    "prerequisites",
    "setup",
    "graphicsAcceleration",
    "command",
    "files",
    "transfer",
    "transferCollision",
    "network",
    "humanView",
    "humanControl",
    "checkpoint",
    "clone",
    "parkResume",
    "cleanup",
  ]) {
    if (result[field] !== true) throw new Error(`smoke test did not verify ${field}`);
  }
  if (result.screenshot?.width <= 0 || result.semanticTargets <= 0) {
    throw new Error("smoke test did not verify visual and semantic observations");
  }
}

await main();

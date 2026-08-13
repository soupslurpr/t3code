import {
  evaluateComputerUseVm,
  readVmToolkitAccessibility,
  resolveComputerUseVmConfig,
} from "./computer-use-vm-lib.mjs";

const smokeExpression = String.raw`(async () => {
  const computer = window.desktopBridge?.computer;
  if (computer === undefined) throw new Error("desktop computer bridge is unavailable");

  const state = {
    chromiumTargets: 0,
    calculatorTargets: 0,
    clickCount: 0,
    wheelEvents: 0,
    rightDragPhases: [],
    unicodeExact: false,
    clipboardUnchanged: false,
    invalidKeyFailure: null,
    staleTargetFailure: null,
    transform: null,
    postTypeCapture: null,
    release: null,
    failure: null,
  };
  const fixtureId = "t3-computer-use-vm-smoke";
  const exactText = "That’s exact → café e\u0301 😀\nSecond line stays exact";
  const clipboardSentinel = "T3 computer-use VM smoke sentinel";
  let browserOpen = false;
  let calculatorOpen = false;
  let clipboardBefore = null;
  let changedWindowState = false;

  const valueOf = (result, step) => {
    if (result.ok) return result.value;
    throw new Error(step + " failed: " + JSON.stringify(result.error));
  };
  const removeFixture = () => document.getElementById(fixtureId)?.remove();

  try {
    if (!document.hasFocus()) {
      throw new Error("T3 Code must be the focused VM window before the smoke test starts");
    }
    const wasMaximized =
      window.outerWidth >= window.screen.availWidth - 2 &&
      window.outerHeight >= window.screen.availHeight - 2;
    const control = valueOf(
      await computer.requestControl({
        observation: {
          screenshot: { maxWidth: 800, maxHeight: 450 },
          includeAccessibility: true,
        },
      }),
      "request control",
    );
    if (control.status?.permission !== "granted") {
      throw new Error("control permission was not granted");
    }

    let snapshot = control.snapshot;
    if (!wasMaximized) {
      const maximized = valueOf(
        await computer.act({
          actions: [
            { type: "hotkey", keys: ["Meta", "ArrowUp"] },
            { type: "wait", durationMs: 500 },
          ],
          observation: {
            screenshot: { maxWidth: 800, maxHeight: 450 },
            includeAccessibility: false,
          },
        }),
        "maximize T3 Code",
      );
      snapshot = maximized.snapshot;
      changedWindowState = true;
    }
    const frame = snapshot?.frame;
    if (frame === undefined) throw new Error("the initial observation did not return a frame");
    if (frame.toDesktopLogical.scaleX <= 1 || frame.toDesktopLogical.scaleY <= 1) {
      throw new Error("the VM smoke test requires a downscaled observation");
    }
    state.transform = frame.toDesktopLogical;

    removeFixture();
    const fixture = document.createElement("div");
    fixture.id = fixtureId;
    fixture.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#111;color:white;" +
      "font:16px sans-serif;";
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Computer use smoke input");
    input.style.cssText =
      "position:absolute;left:10%;top:8%;width:80%;height:96px;font:24px sans-serif;";
    const target = document.createElement("button");
    target.textContent = "Scaled pointer target";
    target.style.cssText =
      "position:absolute;left:25%;top:35%;width:50%;height:30%;font:24px sans-serif;";
    target.addEventListener("click", () => {
      state.clickCount += 1;
    });
    target.addEventListener("wheel", (event) => {
      state.wheelEvents += 1;
      event.preventDefault();
    });
    target.addEventListener("pointerdown", (event) => {
      if (event.button === 2) state.rightDragPhases.push("down");
    });
    target.addEventListener("pointermove", (event) => {
      if ((event.buttons & 2) !== 0 && !state.rightDragPhases.includes("move")) {
        state.rightDragPhases.push("move");
      }
    });
    target.addEventListener("pointerup", (event) => {
      if (event.button === 2) state.rightDragPhases.push("up");
    });
    target.addEventListener("contextmenu", (event) => event.preventDefault());
    fixture.append(input, target);
    document.body.append(fixture);

    const centerX = Math.round(frame.width / 2);
    const centerY = Math.round(frame.height / 2);
    const dragStartX = Math.round(frame.width * 0.4);
    const dragEndX = Math.round(frame.width * 0.6);
    valueOf(
      await computer.act({
        actions: [
          {
            type: "move",
            frameId: frame.id,
            x: centerX,
            y: centerY,
            durationMs: 200,
            settleMs: 100,
          },
          { type: "click", frameId: frame.id, x: centerX, y: centerY },
          {
            type: "wheel",
            frameId: frame.id,
            x: centerX,
            y: centerY,
            deltaY: 3,
            unit: "ticks",
          },
          {
            type: "drag",
            frameId: frame.id,
            startX: dragStartX,
            startY: centerY,
            endX: dragEndX,
            endY: centerY,
            button: "right",
            durationMs: 200,
            steps: 6,
          },
          { type: "wait", durationMs: 250 },
        ],
        observation: false,
      }),
      "scaled pointer actions",
    );
    if (state.clickCount !== 1) throw new Error("the scaled click missed its DOM target");
    if (state.wheelEvents < 1) throw new Error("the discrete wheel event missed its DOM target");
    if (state.rightDragPhases.join(",") !== "down,move,up") {
      throw new Error("the right-button drag did not deliver a complete pointer sequence");
    }

    input.focus();
    clipboardBefore = await navigator.clipboard.readText();
    await navigator.clipboard.writeText(clipboardSentinel);
    const typed = valueOf(
      await computer.act({
        actions: [{ type: "type", text: exactText, intervalMs: 2 }],
        observation: {
          screenshot: { maxWidth: 400, maxHeight: 225 },
          includeAccessibility: false,
        },
      }),
      "Unicode typing",
    );
    state.unicodeExact = input.value === exactText;
    state.clipboardUnchanged = (await navigator.clipboard.readText()) === clipboardSentinel;
    state.postTypeCapture = typed.snapshot?.screenshot && {
      width: typed.snapshot.screenshot.width,
      height: typed.snapshot.screenshot.height,
    };
    if (!state.unicodeExact) throw new Error("Unicode text did not survive desktop typing exactly");
    if (!state.clipboardUnchanged) throw new Error("desktop typing changed the clipboard");
    removeFixture();

    const invalidKey = await computer.act({
      actions: [{ type: "hotkey", keys: ["Control", "Ctrl", "N"] }],
      observation: false,
    });
    if (invalidKey.ok) throw new Error("the duplicate hotkey was unexpectedly accepted");
    state.invalidKeyFailure = invalidKey.error;
    if (
      invalidKey.error.code !== "invalid-key-name" ||
      invalidKey.error.actionIndex !== 0 ||
      invalidKey.error.field !== "actions[0].keys[1]" ||
      invalidKey.error.cleanup?.keys !== "not-needed" ||
      invalidKey.error.cleanup?.buttons !== "not-needed"
    ) {
      throw new Error("the duplicate hotkey did not return precise validation details");
    }

    const chromium = valueOf(
      await computer.act({
        actions: [
          { type: "hotkey", keys: ["Alt", "F2"] },
          { type: "wait", durationMs: 250 },
          {
            type: "type",
            text: "chromium --incognito --no-first-run --disable-default-apps --force-renderer-accessibility=complete --user-data-dir=/tmp/t3-computer-use-smoke-chromium",
            submit: true,
          },
          { type: "wait", durationMs: 2500 },
        ],
        observation: { screenshot: false, includeAccessibility: true },
      }),
      "launch Chromium",
    );
    browserOpen = true;
    const chromiumAccessibility = chromium.snapshot?.accessibility;
    state.chromiumTargets = chromiumAccessibility?.targets.length ?? 0;
    if (chromiumAccessibility?.window?.application !== "Chromium") {
      throw new Error(chromiumAccessibility?.detail ?? "Chromium did not expose an AT-SPI window");
    }
    if (
      !chromiumAccessibility.targets.some(
        (target) => target.role === "entry" && target.name === "Address and search bar",
      )
    ) {
      throw new Error("Chromium did not expose its semantic address target");
    }
    valueOf(
      await computer.act({
        actions: [{ type: "hotkey", keys: ["Alt", "F4"] }, { type: "wait", durationMs: 750 }],
        observation: false,
      }),
      "close Chromium",
    );
    browserOpen = false;

    const calculator = valueOf(
      await computer.act({
        actions: [
          { type: "press", key: "Meta" },
          { type: "wait", durationMs: 250 },
          { type: "type", text: "Calculator", submit: true },
          { type: "wait", durationMs: 1250 },
        ],
        observation: { screenshot: false, includeAccessibility: true },
      }),
      "launch Calculator",
    );
    calculatorOpen = true;
    const calculatorAccessibility = calculator.snapshot?.accessibility;
    state.calculatorTargets = calculatorAccessibility?.targets.length ?? 0;
    const closeTarget = calculatorAccessibility?.targets.find(
      (target) => target.application === "gnome-calculator" && target.name === "Close",
    );
    if (closeTarget === undefined) throw new Error("Calculator did not expose semantic Close");
    const refreshedCalculator = valueOf(
      await computer.snapshot({ screenshot: false, includeAccessibility: true }),
      "refresh Calculator semantics",
    );
    const staleActivation = await computer.act({
      actions: [{ type: "activate", targetId: closeTarget.id }],
      observation: false,
    });
    if (staleActivation.ok) throw new Error("a stale semantic target was unexpectedly accepted");
    state.staleTargetFailure = staleActivation.error;
    if (
      staleActivation.error.code !== "stale-semantic-target" ||
      staleActivation.error.actionIndex !== 0 ||
      staleActivation.error.field !== "actions[0].targetId"
    ) {
      throw new Error("stale semantic activation did not return precise target details");
    }
    const freshCloseTarget = refreshedCalculator.accessibility?.targets.find(
      (target) => target.application === "gnome-calculator" && target.name === "Close",
    );
    if (freshCloseTarget === undefined) {
      throw new Error("the refreshed Calculator snapshot did not expose semantic Close");
    }
    valueOf(
      await computer.act({
        actions: [{ type: "activate", targetId: freshCloseTarget.id }],
        observation: false,
      }),
      "semantic Calculator close",
    );
    calculatorOpen = false;

    if (changedWindowState) {
      valueOf(
        await computer.act({
          actions: [
            { type: "hotkey", keys: ["Meta", "ArrowDown"] },
            { type: "wait", durationMs: 500 },
          ],
          observation: false,
        }),
        "restore T3 Code window",
      );
      changedWindowState = false;
    }
  } catch (error) {
    state.failure = error instanceof Error ? error.message : String(error);
  } finally {
    removeFixture();
    if (browserOpen || calculatorOpen || !document.hasFocus()) {
      try {
        await computer.act({
          actions: [{ type: "hotkey", keys: ["Alt", "F4"] }, { type: "wait", durationMs: 500 }],
          observation: false,
        });
      } catch {}
    }
    if (changedWindowState) {
      try {
        await computer.act({
          actions: [{ type: "hotkey", keys: ["Meta", "ArrowDown"] }],
          observation: false,
        });
      } catch {}
    }
    if (clipboardBefore !== null) {
      try {
        await navigator.clipboard.writeText(clipboardBefore);
      } catch {}
    }
    state.release = await computer.release({});
  }

  return state;
})()`;

/** Runs the isolated computer-use regression workflow. */
async function main() {
  const config = resolveComputerUseVmConfig();
  const accessibilityBefore = await readVmToolkitAccessibility(config);
  const result = await evaluateComputerUseVm(config, smokeExpression);
  const accessibilityAfter = await readVmToolkitAccessibility(config);

  if (result?.failure !== null)
    throw new Error(result?.failure ?? "VM smoke test returned no result");
  if (result.release?.ok !== true) throw new Error("computer release failed");
  if (result.release.value.permission !== "remembered") {
    throw new Error(`unexpected released permission ${result.release.value.permission}`);
  }
  if (result.release.value.keepAwake !== false) {
    throw new Error("computer release left keep-awake enabled");
  }
  if (accessibilityAfter !== accessibilityBefore) {
    throw new Error("computer release did not restore GNOME toolkit accessibility");
  }

  console.log(
    JSON.stringify(
      {
        passed: true,
        accessibilityRestored: accessibilityAfter,
        chromiumTargets: result.chromiumTargets,
        calculatorTargets: result.calculatorTargets,
        clickCount: result.clickCount,
        wheelEvents: result.wheelEvents,
        rightDragPhases: result.rightDragPhases,
        unicodeExact: result.unicodeExact,
        clipboardUnchanged: result.clipboardUnchanged,
        invalidKeyFailure: result.invalidKeyFailure,
        staleTargetFailure: result.staleTargetFailure,
        transform: result.transform,
        postTypeCapture: result.postTypeCapture,
        permission: result.release.value.permission,
        keepAwake: result.release.value.keepAwake,
      },
      null,
      2,
    ),
  );
}

await main();

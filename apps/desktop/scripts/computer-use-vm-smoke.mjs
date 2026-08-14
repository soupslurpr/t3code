import {
  evaluateComputerUseVm,
  readVmToolkitAccessibility,
  resolveComputerUseVmConfig,
} from "./computer-use-vm-lib.mjs";

const smokeExpression = String.raw`(async () => {
  const computer = window.desktopBridge?.computer;
  if (computer === undefined) throw new Error("desktop computer bridge is unavailable");

  const state = {
    textEditorTargets: 0,
    calculatorTargets: 0,
    clickCount: 0,
    wheelEvents: 0,
    rightDragPhases: [],
    asciiExact: false,
    asciiReceived: "",
    asciiTypeResult: null,
    unicodeExact: false,
    typeResult: null,
    editorFocused: false,
    clipboardUnchanged: false,
    waitForChange: null,
    windowActivation: false,
    invalidKeyFailure: null,
    staleTargetFailure: null,
    focusRestored: false,
    transform: null,
    postTypeCapture: null,
    release: null,
    availabilityRetained: false,
    availabilityRelease: null,
    failure: null,
  };
  const fixtureId = "t3-computer-use-vm-smoke";
  const asciiText = "ASCII -> exact fallback";
  const exactText = "That’s exact → café e\u0301 😀\nSecond line stays exact";
  const clipboardSentinel = "T3 computer-use VM smoke sentinel";
  const textEditorApplications = ["gnome-text-editor", "org.gnome.TextEditor", "Text Editor"];
  const calculatorApplications = ["gnome-calculator", "Calculator"];
  let editorOpen = false;
  let calculatorOpen = false;
  let clipboardBefore = null;
  let changedWindowState = false;

  const valueOf = (result, step) => {
    if (result.ok) return result.value;
    throw new Error(step + " failed: " + JSON.stringify(result.error));
  };
  const removeFixture = () => document.getElementById(fixtureId)?.remove();
  const waitForApplication = async (applications, timeoutMs, isReady = () => true) => {
    const applicationLabel = applications.join(" or ");
    const deadline = performance.now() + timeoutMs;
    while (true) {
      const observed = valueOf(
        await computer.snapshot({
          screenshot: { maxWidth: 800, maxHeight: 450 },
          includeAccessibility: true,
        }),
        "observe " + applicationLabel,
      );
      const applicationActive = applications.includes(
        observed.accessibility?.window?.application,
      );
      if (applicationActive && isReady(observed.accessibility)) return observed;
      const observedFrame = observed.frame;
      if (observedFrame === undefined) {
        throw new Error("waiting for " + applicationLabel + " did not return a frame");
      }
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0) return observed;
      if (applicationActive) {
        valueOf(
          await computer.act({
            actions: [{ type: "wait", durationMs: Math.min(remainingMs, 250) }],
            observation: false,
          }),
          "wait for " + applicationLabel + " semantics",
        );
        continue;
      }
      const changed = valueOf(
        await computer.act({
          actions: [
            {
              type: "wait_for_change",
              frameId: observedFrame.id,
              x: 0,
              y: 0,
              width: observedFrame.width,
              height: observedFrame.height,
              timeoutMs: Math.min(remainingMs, 5_000),
              pollIntervalMs: 250,
            },
          ],
          observation: false,
        }),
        "wait for " + applicationLabel,
      );
      if (changed.actionResults?.[0]?.changed !== true) {
        continue;
      }
    }
  };

  try {
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

    const visualChange = window.setTimeout(() => {
      fixture.style.background = "#18243a";
    }, 3000);
    const changeWait = valueOf(
      await computer.act({
        actions: [
          {
            type: "wait_for_change",
            frameId: frame.id,
            x: 0,
            y: 0,
            width: frame.width,
            height: frame.height,
            timeoutMs: 8000,
            pollIntervalMs: 100,
          },
        ],
        observation: false,
      }),
      "visual-change wait",
    );
    window.clearTimeout(visualChange);
    state.waitForChange = changeWait.actionResults?.[0] ?? null;
    if (state.waitForChange?.type !== "wait_for_change" || !state.waitForChange.changed) {
      throw new Error("the visual-change wait did not observe the fixture update");
    }

    input.focus();
    clipboardBefore = await navigator.clipboard.readText();
    await navigator.clipboard.writeText(clipboardSentinel);
    const asciiTyped = valueOf(
      await computer.act({
        actions: [{ type: "type", text: asciiText, intervalMs: 2 }],
        observation: false,
      }),
      "ASCII typing",
    );
    state.asciiReceived = input.value;
    state.asciiExact = input.value === asciiText;
    state.asciiTypeResult = asciiTyped.actionResults?.[0] ?? null;
    const clipboardUnchangedAfterAscii =
      (await navigator.clipboard.readText()) === clipboardSentinel;
    if (!state.asciiExact) throw new Error("ASCII text did not survive desktop typing exactly");
    if (
      state.asciiTypeResult?.type !== "type" ||
      state.asciiTypeResult.requestedCodePoints !== Array.from(asciiText).length ||
      state.asciiTypeResult.injectedCodePoints !== Array.from(asciiText).length
    ) {
      throw new Error("ASCII typing did not return an accurate action receipt");
    }
    if (!clipboardUnchangedAfterAscii) throw new Error("ASCII typing changed the clipboard");
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

    valueOf(
      await computer.act({
        actions: [
          { type: "hotkey", keys: ["Alt", "F2"] },
          { type: "wait", durationMs: 1000 },
          { type: "type", text: "gnome-text-editor --standalone", submit: true },
        ],
        observation: false,
      }),
      "launch Text Editor",
    );
    editorOpen = true;
    const editorSnapshot = await waitForApplication(
      textEditorApplications,
      30_000,
      (accessibility) =>
        accessibility?.targets.some((target) => target.role === "text" && target.enabled) === true,
    );
    const editorAccessibility = editorSnapshot.accessibility;
    state.textEditorTargets = editorAccessibility?.targets.length ?? 0;
    if (!textEditorApplications.includes(editorAccessibility?.window?.application)) {
      throw new Error(
        editorAccessibility?.detail ?? "Text Editor did not expose an AT-SPI window",
      );
    }
    const editorTarget = editorAccessibility.targets.find(
      (target) => target.role === "text" && target.enabled,
    );
    if (editorTarget === undefined) {
      throw new Error("Text Editor did not expose its semantic editable document");
    }
    const editorActivation = valueOf(
      await computer.act({
        actions: [{ type: "activate", targetId: editorTarget.id }],
        observation: { screenshot: false, includeAccessibility: true },
      }),
      "focus Text Editor document",
    );
    state.editorFocused =
      editorActivation.snapshot?.accessibility?.targets.find(
        (target) => target.role === "text" && target.enabled,
      )?.focused === true;
    if (!state.editorFocused) {
      throw new Error("Text Editor semantic document activation did not establish focus");
    }
    const typed = valueOf(
      await computer.act({
        actions: [{ type: "type", text: exactText, intervalMs: 2 }],
        observation: {
          screenshot: { maxWidth: 400, maxHeight: 225 },
          includeAccessibility: true,
        },
      }),
      "Unicode typing",
    );
    const exactCodePoints = Array.from(exactText).length;
    state.typeResult = typed.actionResults?.[0] ?? null;
    state.unicodeExact =
      state.typeResult?.type === "type" &&
      state.typeResult.requestedCodePoints === exactCodePoints &&
      state.typeResult.injectedCodePoints === exactCodePoints &&
      state.typeResult.confirmedCodePoints === exactCodePoints &&
      state.typeResult.delivery === "accessibility" &&
      state.typeResult.focusedEditable;
    state.postTypeCapture = typed.snapshot?.screenshot && {
      width: typed.snapshot.screenshot.width,
      height: typed.snapshot.screenshot.height,
    };
    if (!state.unicodeExact) {
      throw new Error("Unicode typing did not return exact accessibility confirmation");
    }

    valueOf(
      await computer.act({
        actions: [
          { type: "hotkey", keys: ["Alt", "F2"] },
          { type: "wait", durationMs: 1000 },
          { type: "type", text: "gnome-calculator", submit: true },
        ],
        observation: false,
      }),
      "launch Calculator",
    );
    calculatorOpen = true;
    const calculatorSnapshot = await waitForApplication(
      calculatorApplications,
      20_000,
      (accessibility) =>
        accessibility?.targets.some((target) => target.name === "Close" && target.enabled) === true,
    );
    const initialCalculatorAccessibility = calculatorSnapshot.accessibility;
    const editorWindow = initialCalculatorAccessibility?.windows.find((window) =>
      textEditorApplications.includes(window.application),
    );
    if (editorWindow === undefined) {
      throw new Error("the semantic window list omitted Text Editor");
    }
    const reactivatedEditor = valueOf(
      await computer.act({
        actions: [{ type: "activate_window", windowId: editorWindow.id }],
        observation: { screenshot: false, includeAccessibility: true },
      }),
      "activate Text Editor window",
    );
    const calculatorWindow = reactivatedEditor.snapshot?.accessibility?.windows.find((window) =>
      calculatorApplications.includes(window.application),
    );
    if (calculatorWindow === undefined) {
      throw new Error("the refreshed semantic window list omitted Calculator");
    }
    const reactivatedCalculator = valueOf(
      await computer.act({
        actions: [{ type: "activate_window", windowId: calculatorWindow.id }],
        observation: { screenshot: false, includeAccessibility: true },
      }),
      "activate Calculator window",
    );
    const refreshedEditorWindow = reactivatedCalculator.snapshot?.accessibility?.windows.find(
      (window) => textEditorApplications.includes(window.application),
    );
    if (refreshedEditorWindow === undefined) {
      throw new Error("the refreshed semantic window list lost Text Editor");
    }
    valueOf(
      await computer.act({
        actions: [{ type: "activate_window", windowId: refreshedEditorWindow.id }],
        observation: { screenshot: false, includeAccessibility: true },
      }),
      "reactivate Text Editor window",
    );
    state.windowActivation = true;
    valueOf(
      await computer.act({
        actions: [
          { type: "hotkey", keys: ["Control", "A"] },
          { type: "press", key: "Backspace" },
          { type: "wait", durationMs: 250 },
        ],
        observation: false,
      }),
      "clear Text Editor document",
    );

    const editorClose = valueOf(
      await computer.act({
        actions: [{ type: "hotkey", keys: ["Alt", "F4"] }, { type: "wait", durationMs: 750 }],
        observation: { screenshot: false, includeAccessibility: true },
      }),
      "close Text Editor",
    );
    const editorCloseAccessibility = editorClose.snapshot?.accessibility;
    if (
      editorCloseAccessibility?.windows.some((window) =>
        textEditorApplications.includes(window.application),
      )
    ) {
      const discardTarget = editorCloseAccessibility.targets.find((target) => {
        const name = target.name.toLowerCase();
        return name.includes("discard") || name.includes("close without saving");
      });
      if (discardTarget === undefined) {
        throw new Error("Text Editor did not expose its discard confirmation");
      }
      valueOf(
        await computer.act({
          actions: [{ type: "activate", targetId: discardTarget.id }],
          observation: false,
        }),
        "discard Text Editor document",
      );
    }
    editorOpen = false;

    const activeCalculator = await waitForApplication(
      calculatorApplications,
      10_000,
      (accessibility) =>
        accessibility?.targets.some((target) => target.name === "Close" && target.enabled) === true,
    );
    const calculatorAccessibility = activeCalculator.accessibility;
    state.calculatorTargets = calculatorAccessibility?.targets.length ?? 0;
    const closeTarget = calculatorAccessibility?.targets.find(
      (target) => calculatorApplications.includes(target.application) && target.name === "Close",
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
      (target) => calculatorApplications.includes(target.application) && target.name === "Close",
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

    const finalWindowSnapshot = valueOf(
      await computer.snapshot({ screenshot: false, includeAccessibility: true }),
      "observe original window for focus restoration",
    );
    const originalWindow = finalWindowSnapshot.accessibility?.windows.find(
      (window) => window.application === "t3code",
    );
    if (originalWindow === undefined) {
      throw new Error("the semantic window list omitted the original T3 Code window");
    }
    valueOf(
      await computer.act({
        actions: [
          { type: "activate_window", windowId: originalWindow.id },
          { type: "wait", durationMs: 250 },
        ],
        observation: false,
      }),
      "restore original T3 Code focus",
    );
    state.focusRestored = document.hasFocus();
    if (!state.focusRestored) throw new Error("T3 Code did not regain document focus");

    state.clipboardUnchanged = (await navigator.clipboard.readText()) === clipboardSentinel;
    if (!state.clipboardUnchanged) throw new Error("desktop typing changed the clipboard");

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
    if (editorOpen) {
      try {
        const cleanupSnapshot = valueOf(
          await computer.snapshot({ screenshot: false, includeAccessibility: true }),
          "observe Text Editor during cleanup",
        );
        const editorWindow = cleanupSnapshot.accessibility?.windows.find((window) =>
          textEditorApplications.includes(window.application),
        );
        if (editorWindow !== undefined) {
          valueOf(
            await computer.act({
              actions: [{ type: "activate_window", windowId: editorWindow.id }],
              observation: false,
            }),
            "activate Text Editor during cleanup",
          );
          const editorClose = valueOf(
            await computer.act({
              actions: [
                { type: "hotkey", keys: ["Alt", "F4"] },
                { type: "wait", durationMs: 500 },
              ],
              observation: { screenshot: false, includeAccessibility: true },
            }),
            "close Text Editor during cleanup",
          );
          const discardTarget = editorClose.snapshot?.accessibility?.targets.find((target) => {
            const name = target.name.toLowerCase();
            return name.includes("discard") || name.includes("close without saving");
          });
          if (discardTarget !== undefined) {
            valueOf(
              await computer.act({
                actions: [{ type: "activate", targetId: discardTarget.id }],
                observation: false,
              }),
              "discard Text Editor document during cleanup",
            );
            editorOpen = false;
          } else if (
            editorClose.snapshot?.accessibility?.windows.some((window) =>
              textEditorApplications.includes(window.application),
            ) !== true
          ) {
            editorOpen = false;
          }
        }
      } catch {}
    }
    if (calculatorOpen) {
      try {
        const cleanupSnapshot = valueOf(
          await computer.snapshot({ screenshot: false, includeAccessibility: true }),
          "observe Calculator during cleanup",
        );
        const calculatorWindow = cleanupSnapshot.accessibility?.windows.find((window) =>
          calculatorApplications.includes(window.application),
        );
        if (calculatorWindow !== undefined) {
          valueOf(
            await computer.act({
              actions: [{ type: "activate_window", windowId: calculatorWindow.id }],
              observation: false,
            }),
            "activate Calculator during cleanup",
          );
          valueOf(
            await computer.act({
              actions: [
                { type: "hotkey", keys: ["Alt", "F4"] },
                { type: "wait", durationMs: 500 },
              ],
              observation: false,
            }),
            "close Calculator during cleanup",
          );
          calculatorOpen = false;
        }
      } catch {}
    }
    if (changedWindowState && !editorOpen && !calculatorOpen) {
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
    state.availabilityRetained = state.release.value?.keepAwake === true;
    state.availabilityRelease = await computer.releaseAvailability({});
  }

  return state;
})()`;

/** Runs the isolated computer-use regression workflow. */
async function main() {
  const config = resolveComputerUseVmConfig();
  const accessibilityBefore = await readVmToolkitAccessibility(config);
  const result = await evaluateComputerUseVm(config, smokeExpression);
  const accessibilityAfter = await readVmToolkitAccessibility(config);

  if (result?.failure !== null) {
    throw new Error(
      `${result?.failure ?? "VM smoke test returned no result"}\n${JSON.stringify(result, null, 2)}`,
    );
  }
  if (result.release?.ok !== true) throw new Error("computer release failed");
  if (result.release.value.permission !== "remembered") {
    throw new Error(`unexpected released permission ${result.release.value.permission}`);
  }
  if (!result.availabilityRetained || result.release.value.keepAwake !== true) {
    throw new Error("computer release did not retain desktop availability");
  }
  if (result.availabilityRelease?.ok !== true) {
    throw new Error("computer availability release failed");
  }
  if (result.availabilityRelease.value.keepAwake !== false) {
    throw new Error("computer availability release left keep-awake enabled");
  }
  if (accessibilityAfter !== accessibilityBefore) {
    throw new Error("computer release did not restore GNOME toolkit accessibility");
  }

  console.log(
    JSON.stringify(
      {
        passed: true,
        accessibilityRestored: accessibilityAfter,
        textEditorTargets: result.textEditorTargets,
        calculatorTargets: result.calculatorTargets,
        clickCount: result.clickCount,
        wheelEvents: result.wheelEvents,
        rightDragPhases: result.rightDragPhases,
        asciiExact: result.asciiExact,
        asciiReceived: result.asciiReceived,
        asciiTypeResult: result.asciiTypeResult,
        unicodeExact: result.unicodeExact,
        typeResult: result.typeResult,
        editorFocused: result.editorFocused,
        clipboardUnchanged: result.clipboardUnchanged,
        waitForChange: result.waitForChange,
        windowActivation: result.windowActivation,
        invalidKeyFailure: result.invalidKeyFailure,
        staleTargetFailure: result.staleTargetFailure,
        focusRestored: result.focusRestored,
        transform: result.transform,
        postTypeCapture: result.postTypeCapture,
        permission: result.release.value.permission,
        availabilityRetained: result.availabilityRetained,
        keepAwake: result.availabilityRelease.value.keepAwake,
      },
      null,
      2,
    ),
  );
}

await main();

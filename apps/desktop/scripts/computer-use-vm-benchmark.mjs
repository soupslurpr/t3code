import {
  decodedBase64Bytes,
  evaluateComputerUseVm,
  gpt56OriginalImageTokens,
  resolveComputerUseVmConfig,
  targetComputerUseVmBridge,
} from "./computer-use-vm-lib.mjs";

const benchmarkExpression = String.raw`(async () => {
  const targetComputerUseVmBridge = ${targetComputerUseVmBridge.toString()};
  const computer = targetComputerUseVmBridge(window.desktopBridge);
  const results = [];
  const iterations = 3;

  const valueOf = (result, step) => {
    if (result.ok) return result.value;
    throw new Error(step + " failed: " + JSON.stringify(result.error));
  };
  const decodedBase64Bytes = ${decodedBase64Bytes.toString()};
  const gpt56OriginalImageTokens = ${gpt56OriginalImageTokens.toString()};
  const summarize = (label, elapsedMs, snapshot) => {
    const screenshot = snapshot.screenshot;
    const accessibility = snapshot.accessibility;
    return {
      label,
      elapsedMs,
      width: screenshot?.width ?? 0,
      height: screenshot?.height ?? 0,
      pixels: (screenshot?.width ?? 0) * (screenshot?.height ?? 0),
      gpt56OriginalImageTokens:
        screenshot === undefined
          ? 0
          : gpt56OriginalImageTokens(screenshot.width, screenshot.height),
      pngBytes: screenshot === undefined ? 0 : decodedBase64Bytes(screenshot.data),
      jsonBytes: new TextEncoder().encode(JSON.stringify(snapshot)).length,
      semanticBytes:
        accessibility === undefined
          ? 0
          : new TextEncoder().encode(JSON.stringify(accessibility)).length,
      semanticTargets: accessibility?.targets.length ?? 0,
    };
  };
  const measure = async (label, input) => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const startedAt = performance.now();
      const snapshot = valueOf(await computer.snapshot(input), label);
      results.push(summarize(label, Math.round(performance.now() - startedAt), snapshot));
    }
  };

  let calculatorOpen = false;
  let failure = null;
  let release = null;
  try {
    valueOf(await computer.requestAvailability({}), "request availability");
    valueOf(await computer.requestControl({ observation: false }), "request control");
    valueOf(
      await computer.act({
        actions: [
          { type: "hotkey", keys: ["Alt", "F2"] },
          { type: "wait", durationMs: 250 },
          { type: "type", text: "gnome-calculator", submit: true },
          { type: "wait", durationMs: 1250 },
        ],
        observation: false,
      }),
      "launch Calculator",
    );
    calculatorOpen = true;

    await measure("semantics-only", { screenshot: false, includeAccessibility: true });
    await measure("overview-400x225", {
      screenshot: { maxWidth: 400, maxHeight: 225 },
      includeAccessibility: false,
    });
    await measure("balanced-800x450", {
      screenshot: { maxWidth: 800, maxHeight: 450 },
      includeAccessibility: false,
    });
    await measure("balanced-plus-semantics", {
      screenshot: { maxWidth: 800, maxHeight: 450 },
      includeAccessibility: true,
    });
    await measure("detailed-1600x900", {
      screenshot: { maxWidth: 1600, maxHeight: 900 },
      includeAccessibility: false,
    });

    const source = valueOf(
      await computer.snapshot({
        screenshot: { maxWidth: 800, maxHeight: 450 },
        includeAccessibility: false,
      }),
      "crop source",
    );
    const frame = source.frame;
    if (frame === undefined) throw new Error("crop source did not return a frame");
    const region = {
      frameId: frame.id,
      x: Math.floor(frame.width / 4),
      y: Math.floor(frame.height / 4),
      width: Math.floor(frame.width / 2),
      height: Math.floor(frame.height / 2),
    };
    await measure("focused-region-400x225", {
      screenshot: { region, maxWidth: 400, maxHeight: 225 },
      includeAccessibility: false,
    });

    const semanticSnapshot = valueOf(
      await computer.snapshot({ screenshot: false, includeAccessibility: true }),
      "semantic close target",
    );
    const closeTarget = semanticSnapshot.accessibility?.targets.find(
      (target) => target.application === "gnome-calculator" && target.name === "Close",
    );
    if (closeTarget === undefined) throw new Error("Calculator did not expose semantic Close");
    valueOf(
      await computer.act({
        actions: [{ type: "activate", targetId: closeTarget.id }],
        observation: false,
      }),
      "close Calculator",
    );
    calculatorOpen = false;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (calculatorOpen) {
      try {
        await computer.act({
          actions: [{ type: "hotkey", keys: ["Alt", "F4"] }],
          observation: false,
        });
      } catch {}
    }
    await computer.release({});
    release = await computer.releaseAvailability({});
  }
  return { failure, iterations, release, results };
})()`;

/** Calculates one rounded arithmetic mean. */
function mean(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** Aggregates repeated observation measurements by policy. */
function aggregate(rows) {
  const byLabel = Map.groupBy(rows, ({ label }) => label);
  return Array.from(byLabel, ([label, measurements]) => ({
    label,
    milliseconds: mean(measurements.map(({ elapsedMs }) => elapsedMs)),
    dimensions:
      measurements[0].width === 0
        ? "semantic"
        : `${measurements[0].width}x${measurements[0].height}`,
    pixels: measurements[0].pixels,
    gpt56OriginalImageTokens: measurements[0].gpt56OriginalImageTokens,
    pngBytes: mean(measurements.map(({ pngBytes }) => pngBytes)),
    jsonBytes: mean(measurements.map(({ jsonBytes }) => jsonBytes)),
    semanticBytes: mean(measurements.map(({ semanticBytes }) => semanticBytes)),
    semanticTargets: measurements[0].semanticTargets,
  }));
}

/** Runs and prints the retained VM observation-cost benchmark. */
async function main() {
  const result = await evaluateComputerUseVm(resolveComputerUseVmConfig(), benchmarkExpression);
  if (result?.failure !== null)
    throw new Error(result?.failure ?? "VM benchmark returned no result");
  if (result.release?.ok !== true || result.release.value.keepAwake !== false) {
    throw new Error("VM benchmark did not release computer control cleanly");
  }

  const rows = aggregate(result.results);
  console.table(rows);
  console.log(
    JSON.stringify(
      {
        iterations: result.iterations,
        permission: result.release.value.permission,
        keepAwake: result.release.value.keepAwake,
        observations: rows,
      },
      null,
      2,
    ),
  );
}

await main();

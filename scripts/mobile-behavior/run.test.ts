// @effect-diagnostics nodeBuiltinImport:off - tests the harness's Node subprocess and filesystem boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import { main, runTarget } from "../mobile-behavior.ts";
import { Device as PoolDevice, type Pool } from "../mobile-e2e/device.ts";
import { CASES, selectCases } from "./cases.ts";
import { makeDevice } from "./device.ts";
import * as Environment from "./environment.ts";
import { scriptOf } from "./fake-fx.ts";
import {
  blockingResults,
  caseResult,
  checkFails,
  feedMotion,
  frameStats,
  resultsFor,
  type SampleRow,
} from "./grade.ts";
import { command } from "./run.ts";

vi.mock(import("node:child_process"), async (original) => ({ ...(await original()) }));
vi.mock(import("node:fs"), async (original) => ({ ...(await original()) }));
vi.mock(import("node:fs/promises"), async (original) => ({ ...(await original()) }));

const steady = (count: number, gap: number) =>
  Array.from({ length: count }, (_, index) => index * gap);

it("counts the frames a long gap swallowed, against the device's own refresh rate", () => {
  const at120 = steady(120, 1000 / 120);
  expect(frameStats(at120, "ui")).toMatchObject({ uiRefreshHz: 120, uiDroppedPct: 0 });

  // One 50 ms stall at 60 Hz hides two frames.
  const stalled = [...steady(60, 1000 / 60), 59 * (1000 / 60) + 50];
  expect(frameStats(stalled, "js")).toMatchObject({ jsRefreshHz: 60, jsDroppedPct: 3.2 });

  // JS rAF fires on a timer, so a late frame makes the next gap short; the UI rate sets the budget.
  const jittered = steady(300, 1000 / 60).map((time, index) =>
    index % 15 === 7 ? time + 6 : time,
  );
  expect(frameStats(jittered, "js")).toMatchObject({ jsRefreshHz: 120 });
  expect(frameStats(jittered, "js", 1000 / 60)).toMatchObject({ jsRefreshHz: 60, jsDroppedPct: 0 });

  // A steady 20 FPS is two dropped frames in every three, not a slow display.
  expect(frameStats(steady(60, 50), "ui")).toMatchObject({ uiRefreshHz: 60, uiDroppedPct: 66.7 });
});

it("reads row motion on screen, so an offset change that keeps content still is not a jump", () => {
  const rows = (entries: Record<string, number>) => ({ threadId: "t", ready: true, rows: entries });
  // Scrolling up: rows move down the screen; the list then grows above and shifts its offset.
  const smooth = [rows({ a: 100, b: 400 }), rows({ a: 180, b: 480 }), rows({ a: 180, b: 480 })];
  expect(feedMotion(smooth, 1)).toMatchObject({ backwardPx: 0, teleports: 0, largestStepPx: 80 });

  const jerk = [rows({ a: 100 }), rows({ a: 180 }), rows({ a: 60 })];
  expect(feedMotion(jerk, 1)).toMatchObject({ backwardPx: 120 });

  const teleport = [rows({ a: 100 }), rows({ a: 1300 })];
  expect(feedMotion(teleport, 1)).toMatchObject({ teleports: 1, largestStepPx: 1200 });

  // A jump past every visible row leaves no shared row; the offset change is the move.
  const offset = (scroll: number, entries: Record<string, number>) => ({
    ...rows(entries),
    scroll,
    content: 9000,
  });
  expect(feedMotion([offset(6000, { a: 100 }), offset(1000, { z: 100 })], 1)).toMatchObject({
    teleports: 1,
    largestStepPx: 5000,
  });
});

it("fails a case when half or more of its graded samples fail", () => {
  const row = (pass: boolean | null, value: number): SampleRow => ({
    id: "c",
    device: "phone",
    sample: 1,
    pass,
    failures: [],
    metrics: { backwardPx: value },
  });
  expect(
    caseResult("c", "phone", "backwardPx", [row(true, 1), row(true, 3), row(false, 90)]),
  ).toMatchObject({
    pass: true,
    key: 3,
  });
  expect(caseResult("c", "phone", "backwardPx", [row(true, 1), row(false, 90)]).pass).toBe(false);
  expect(caseResult("c", "phone", "backwardPx", [row(null, 0)]).pass).toBe(null);

  // Errors that outnumber graded samples leave the case incomplete, not passing.
  const errored: SampleRow = { ...row(null, 0), error: "Inspector timed out" };
  expect(caseResult("c", "phone", "backwardPx", [row(true, 1), errored, errored])).toMatchObject({
    pass: null,
    errors: 2,
  });
});

it("checks exact values and bounds", () => {
  expect(checkFails({ metric: "rowStatus", equals: "input" }, { rowStatus: "working" })).toBe(
    "rowStatus=working, want input",
  );
  expect(checkFails({ metric: "backwardPx", max: 24 }, { backwardPx: 24 })).toBe(null);
  expect(checkFails({ metric: "contentGrewPx", min: 500 }, {})).toBe("contentGrewPx missing");
});

it("reads the fake provider's script from the prompt marker", () => {
  expect(scriptOf("Write it. [[eval:stream:4000:25]]")).toMatchObject({
    kind: "stream",
    words: 4000,
    chunkMs: 25,
  });
  expect(scriptOf("Run. [[eval:hold:bg-1]]")).toMatchObject({ kind: "hold", key: "bg-1" });
  expect(scriptOf("plain text")).toMatchObject({ kind: "reply" });
});

const gradingCases = [
  { id: "guard", key: "measured", kind: "guard" },
  { id: "control", key: "measured", kind: "control" },
  { id: "bad", key: "measured", kind: "bad" },
];
const plan = ["phone", "tablet"].map((device) => ({
  device,
  caseIds: gradingCases.map(({ id }) => id),
  samples: 2,
}));
const completeRows = (): SampleRow[] =>
  plan.flatMap(({ device, caseIds, samples }) =>
    caseIds.flatMap((id) =>
      Array.from({ length: samples }, (_, index) => ({
        device,
        id,
        sample: index + 1,
        pass: id !== "bad",
        failures: id === "bad" ? ["known failure"] : [],
        metrics: { measured: 1 },
      })),
    ),
  );

it("accepts a complete matrix, including a known bad case that was actually graded", () => {
  const results = resultsFor(completeRows(), gradingCases, plan);
  expect(results).toHaveLength(6);
  expect(blockingResults(results, gradingCases)).toEqual([]);
});

it.each(["guard", "control", "bad", "tablet", "sample", "all"] as const)(
  "blocks a run missing %s rows",
  (missing) => {
    const rows = completeRows().filter((row) =>
      missing === "all"
        ? false
        : missing === "tablet"
          ? row.device !== "tablet"
          : missing === "sample"
            ? !(row.device === "phone" && row.id === "guard" && row.sample === 2)
            : row.id !== missing,
    );
    const results = resultsFor(rows, gradingCases, plan);
    expect(blockingResults(results, gradingCases).length).toBeGreaterThan(0);
  },
);

it.each(["duplicate", "out-of-range", "ungraded", "error"] as const)(
  "rejects a %s sample even when other samples pass",
  (defect) => {
    const rows = completeRows();
    rows[1] = {
      ...rows[1]!,
      ...(defect === "duplicate" ? { sample: 1 } : {}),
      ...(defect === "out-of-range" ? { sample: 3 } : {}),
      ...(defect === "ungraded" ? { pass: null } : {}),
      ...(defect === "error" ? { pass: null, error: "measurement stopped" } : {}),
    };
    expect(blockingResults(resultsFor(rows, gradingCases, plan), gradingCases)).toMatchObject([
      { id: "guard", device: "phone", pass: null },
    ]);
  },
);

it("blocks an ungraded known-bad case instead of waiving missing evidence", () => {
  const rows = completeRows().map((row) =>
    row.id === "bad" ? { ...row, pass: null, error: "probe disconnected" } : row,
  );
  expect(blockingResults(resultsFor(rows, gradingCases, plan), gradingCases)).toHaveLength(2);
});

it.each([0, -1])("rejects a %i-sample plan", (samples) => {
  expect(() => resultsFor([], gradingCases, [{ ...plan[0]!, samples }])).toThrow(/positive/i);
});

it.each([0, -1])(
  "rejects --samples %i before the pool wrapper touches a device",
  async (samples) => {
    using spawn = vi.spyOn(NodeChildProcess, "spawn").mockImplementation(() => {
      throw new Error("unexpected child");
    });
    await expect(main(["--samples", String(samples)])).rejects.toThrow(/positive/i);
    expect(spawn).not.toHaveBeenCalled();
  },
);

it.effect.each([0, -1])(
  "rejects --samples %i before the one-device runner creates its fixture",
  (samples) =>
    Effect.gen(function* () {
      using scratch = temporaryDirectory();
      const out = NodePath.join(scratch.path, "output");
      using start = vi
        .spyOn(Environment, "startEnvironment")
        .mockReturnValue(
          Effect.fail(new Environment.EnvironmentError({ message: "unexpected fixture" })),
        );
      const error = yield* Command.runWith(command, { version: "test" })([
        "--out",
        out,
        "--samples",
        String(samples),
        "--device-config",
        "unused",
        "--device-session",
        "synthetic",
        "--host",
        "127.0.0.1",
      ]).pipe(Effect.flip, Effect.provide(NodeServices.layer));
      expect(String(error)).toMatch(/positive/i);
      expect(start).not.toHaveBeenCalled();
      expect(NodeFS.existsSync(out)).toBe(false);
    }),
);

it("requires background-scroll measurements and still accepts a stationary recording", () => {
  const testCase = CASES.find(({ id }) => id === "background-finish-keeps-scroll")!;
  const failures = (metrics: ReturnType<typeof feedMotion>) =>
    testCase.checks.flatMap((check) => checkFails(check, metrics) ?? []);
  expect(failures(feedMotion([], 0)).length).toBeGreaterThan(0);
  const frame = { threadId: "t", ready: true, rows: { a: 50 }, scroll: 500, content: 1000 };
  expect(failures(feedMotion([frame], 0)).length).toBeGreaterThan(0);
  expect(failures(feedMotion([frame, frame], 0))).toEqual([]);
  expect(failures(feedMotion([frame, { ...frame, rows: { a: 70 } }], 0)).length).toBeGreaterThan(0);
});

it("does not treat placeholder feed frames as measured background-scroll stability", () => {
  const checks = CASES.find(({ id }) => id === "background-finish-keeps-scroll")!.checks;
  const failures = (frames: Parameters<typeof feedMotion>[0]) =>
    checks.flatMap((check) => checkFails(check, feedMotion(frames, 0)) ?? []);
  expect(
    failures([
      { threadId: "t", ready: false },
      { threadId: "t", ready: false },
    ]).length,
  ).toBeGreaterThan(0);
  expect(
    failures([
      { threadId: "t", ready: true },
      { threadId: "t", ready: true },
    ]).length,
  ).toBeGreaterThan(0);
  expect(
    failures([
      { threadId: "t", ready: true, scroll: 50, content: 1000 },
      { threadId: "t", ready: true, scroll: 50, content: 1000 },
    ]),
  ).toEqual([]);
});

function temporaryDirectory() {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-behavior-test-"));
  return { path, [Symbol.dispose]: () => NodeFS.rmSync(path, { recursive: true, force: true }) };
}

function childThatCloses(code: number | null, error?: Error) {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
  });
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    if (error) child.emit("error", error);
    child.emit("close", code);
  });
  return child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams;
}

function targetFixture(root: string) {
  const streams: NodeFS.WriteStream[] = [];
  const createWriteStream = NodeFS.createWriteStream;
  const trace = vi.spyOn(NodeFS, "createWriteStream").mockImplementation((...args) => {
    const stream = createWriteStream(...args);
    streams.push(stream);
    return stream;
  });
  const target = {
    id: "iphone-18-pro",
    device: "iPhone 18 Pro",
    form: "phone",
    behaviorPose: "phone",
  } as const;
  const config = NodePath.join(root, "agent-device.json");
  const pool: Pool = {
    repoRoot: NodePath.resolve(import.meta.dirname, "../.."),
    agentDevice: "/synthetic/agent-device",
    agentDeviceUrl: "https://synthetic.invalid/v1/agent-device",
    workspace: root,
    env: { PATH: "/synthetic/bin", PWD: root, AGENT_DEVICE_CONFIG: config },
  };
  const device = Object.assign(Object.create(PoolDevice.prototype) as PoolDevice, {
    session: "isolated-session",
    pool,
    install: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  });
  const directory = NodePath.join(root, target.id);
  NodeFS.mkdirSync(directory);
  const run = () => runTarget(target, pool, "test", root, config, root, "synthetic-token", []);
  return {
    device,
    directory,
    pool,
    run,
    async [Symbol.asyncDispose]() {
      try {
        await Promise.all(streams.map((stream) => NodeStreamPromises.finished(stream)));
      } finally {
        trace.mockRestore();
      }
    },
  };
}

it.each([0, 1, null])(
  "keeps child exit %s authoritative even when a partial results file exists",
  async (code) => {
    using scratch = temporaryDirectory();
    await using fixture = targetFixture(scratch.path);
    NodeFS.writeFileSync(
      NodePath.join(fixture.directory, "results.jsonl"),
      `${JSON.stringify(completeRows()[0])}\n`,
    );
    using lease = vi.spyOn(PoolDevice, "lease").mockResolvedValue(fixture.device);
    using spawn = vi
      .spyOn(NodeChildProcess, "spawn")
      .mockImplementation(() => childThatCloses(code));
    const result = await fixture.run();
    expect(Boolean(result.error)).toBe(code !== 0);
    expect(lease).toHaveBeenCalledOnce();
    expect(fixture.device.install).toHaveBeenCalledOnce();
    expect(fixture.device.release).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
  },
);

it("keeps the lease workspace, config and session on the behavior child", async () => {
  using scratch = temporaryDirectory();
  await using fixture = targetFixture(scratch.path);
  NodeFS.writeFileSync(NodePath.join(fixture.directory, "results.jsonl"), "");
  using _lease = vi.spyOn(PoolDevice, "lease").mockResolvedValue(fixture.device);
  using spawn = vi.spyOn(NodeChildProcess, "spawn").mockImplementation(() => childThatCloses(0));
  await fixture.run();
  const [, args, options] = spawn.mock.calls[0]!;
  expect(options?.cwd).toBe(fixture.pool.workspace);
  expect(options?.env?.PWD).toBe(fixture.pool.workspace);
  expect(options?.env?.AGENT_DEVICE_CONFIG).toBe(fixture.pool.env.AGENT_DEVICE_CONFIG);
  expect(args).toEqual(
    expect.arrayContaining([
      "--device-config",
      fixture.pool.env.AGENT_DEVICE_CONFIG,
      "--device-session",
      fixture.device.session,
    ]),
  );
  expect(NodePath.isAbsolute(String(args?.[0]))).toBe(true);
});

it("releases an installed lease when launching the child throws", async () => {
  using scratch = temporaryDirectory();
  await using fixture = targetFixture(scratch.path);
  using _lease = vi.spyOn(PoolDevice, "lease").mockResolvedValue(fixture.device);
  using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockImplementation(() => {
    throw new Error("launch refused");
  });
  await expect(fixture.run()).rejects.toThrow("launch refused");
  expect(fixture.device.release).toHaveBeenCalledOnce();
});

it.effect("keeps exact lease ownership on every device CLI invocation", () =>
  Effect.gen(function* () {
    const workspace = "/synthetic/lease-workspace";
    const targetArgs = [
      "--config",
      "/synthetic/device.json",
      "--session",
      "session-a",
      "--platform",
      "ios",
    ];
    const options = {
      agentDevice: "/synthetic/agent-device",
      targetArgs,
      workspace,
      metro: "http://unused.invalid",
      deviceName: "",
    };
    using exec = vi.spyOn(NodeChildProcess, "execFileSync").mockReturnValue("{} ");
    const device = makeDevice(options);
    yield* device.press("test-button");
    yield* device.type("sample");
    yield* device.home;
    expect(exec).toHaveBeenCalledTimes(3);
    for (const [, args, settings] of exec.mock.calls) {
      expect(args?.slice(-targetArgs.length)).toEqual(targetArgs);
      expect(settings?.cwd).toBe(workspace);
      expect(settings?.env?.PWD).toBe(workspace);
    }
  }),
);

it("removes ambient credentials, runtime injection and home overrides from the fixture", () => {
  const ambient = {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    HOME: "/real-home",
    XDG_CONFIG_HOME: "/real-config",
    CODEX_HOME: "/real-codex",
    OPENAI_API_KEY: "synthetic-openai",
    ANTHROPIC_API_KEY: "synthetic-anthropic",
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: "synthetic-pool",
    NODE_OPTIONS: "--import=/synthetic/preload",
    T3CODE_HOME: "/real-t3",
    T3CODE_DEV_URL: "http://ambient.invalid",
    GIT_CONFIG_COUNT: "1",
  };
  const env = Environment.fixtureEnvironment("/isolated/home", ambient);
  expect(env.PATH).toBe(ambient.PATH);
  expect(env.HOME).toBe("/isolated/home");
  for (const key of [
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AGENT_DEVICE_DAEMON_AUTH_TOKEN",
    "NODE_OPTIONS",
    "T3CODE_HOME",
    "T3CODE_DEV_URL",
    "GIT_CONFIG_COUNT",
  ]) {
    expect(env[key], key).toBeUndefined();
  }
  expect(env.XDG_CONFIG_HOME).toBe("/isolated/home/.config");
});

it.live("hydrates only the scripted fixture provider from its saved settings", () =>
  Effect.sync(() => {
    using scratch = temporaryDirectory();
    // Do not consult the machine's Git configuration while preparing the synthetic fixture.
    using git = vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation(() => "");
    Environment.writeScratch(scratch.path);
    git.mockRestore();
    const settings = NodePath.join(scratch.path, "userdata/settings.json");
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import fs from "node:fs";
      import { ServerSettings, resolveProviderInstanceEnabled } from "@t3tools/contracts";
      import * as Schema from "effect/Schema";
      import { deriveProviderInstanceConfigMap } from "./src/provider/ProviderInstanceRegistryHydration.ts";
      const settings = Schema.decodeSync(ServerSettings)(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
      const enabled = Object.entries(deriveProviderInstanceConfigMap(settings))
        .filter(([, entry]) => resolveProviderInstanceEnabled(entry)).map(([id]) => id);
      console.log(JSON.stringify(enabled));
    `,
        settings,
      ],
      {
        cwd: NodePath.resolve(import.meta.dirname, "../../apps/server"),
        env: { PATH: process.env.PATH, HOME: scratch.path },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output)).toEqual(["evalbot"]);
  }),
);

it.each(["complete", "partial", "nonzero", "spawn-error"] as const)(
  "reports the %s pool run through the wrapper's real exit path and releases every lease",
  async (mode) => {
    const released: string[] = [];
    const installed: string[] = [];
    let outputDirectory: string | undefined;
    let removedAfterRelease: ReadonlyArray<string> = [];
    const exitCode = process.exitCode;
    const targets = new Set<string>();
    const pendingChildren: Promise<void>[] = [];
    using _output = vi.spyOn(NodeProcess.stdout, "write").mockReturnValue(true);
    using _lease = vi.spyOn(PoolDevice, "lease").mockImplementation(async (pose, pool) =>
      Object.assign(Object.create(PoolDevice.prototype) as PoolDevice, {
        session: `synthetic-${pose.id}`,
        pool,
        install: async () => {
          installed.push(pose.id);
        },
        release: async () => {
          released.push(pose.id);
        },
      }),
    );
    const rm = NodeFSP.rm;
    using _remove = vi.spyOn(NodeFSP, "rm").mockImplementation(async (...args) => {
      removedAfterRelease = [...released];
      return rm(...args);
    });
    using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockImplementation((_exe, args) => {
      if (String(args?.[0]).endsWith("mobile-native-client.ts")) {
        expect(installed).toEqual([]);
        return childThatCloses(0);
      }
      const flag = (key: string) => String(args?.[args.indexOf(key) + 1]);
      const device = flag("--label");
      const out = flag("--out");
      targets.add(device);
      expect(installed).toContain(device);
      outputDirectory = NodePath.dirname(out);
      const rows = selectCases(flag("--pose") as "phone" | "ipad").map(({ id, kind }) => ({
        id,
        device,
        sample: 1,
        pass: kind !== "bad",
        failures: [],
        metrics: {},
      }));
      NodeFS.writeFileSync(
        NodePath.join(out, "results.jsonl"),
        (mode === "partial" ? rows.slice(0, 1) : rows).map((row) => JSON.stringify(row)).join("\n"),
      );
      const child = childThatCloses(
        mode === "nonzero" ? 1 : 0,
        mode === "spawn-error" && device === "iphone-18-pro"
          ? new Error("synthetic spawn failure")
          : undefined,
      );
      pendingChildren.push(new Promise((resolve) => child.once("close", () => resolve())));
      return child;
    });
    vi.stubEnv("SIMLOCK_AGENT_DEVICE_URL", "https://synthetic.invalid/v1/agent-device");
    vi.stubEnv("AGENT_DEVICE_DAEMON_AUTH_TOKEN", "synthetic-token");
    try {
      await main(["--samples", "1"]);
      expect(process.exitCode).toBe(mode === "complete" ? 0 : 1);
      expect([...targets].sort()).toEqual(["ipad-pro-13", "iphone-18-pro"]);
      expect(released.toSorted()).toEqual(["ipad-pro-13", "iphone-18-pro"]);
      expect(removedAfterRelease.toSorted()).toEqual(["ipad-pro-13", "iphone-18-pro"]);
    } finally {
      await Promise.all(pendingChildren);
      process.exitCode = exitCode;
      vi.unstubAllEnvs();
      if (outputDirectory) NodeFS.rmSync(outputDirectory, { recursive: true, force: true });
    }
  },
);

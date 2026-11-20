// @effect-diagnostics nodeBuiltinImport:off - Semantic ids are private to one controller observation.
import * as NodeCrypto from "node:crypto";
import {
  ComputerAutomationAccessibilitySnapshot,
  ComputerAutomationAccessibilityTarget,
  ComputerAutomationAccessibilityWindowTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { GuestTools } from "./GuestTools.ts";
import type { MachinePaths } from "./MachinePorts.ts";

const { id: _target, ...targetFields } = ComputerAutomationAccessibilityTarget.fields;
const { id: _window, ...windowFields } = ComputerAutomationAccessibilityWindowTarget.fields;
const GuestSnapshot = Schema.Struct({
  ...ComputerAutomationAccessibilitySnapshot.fields,
  targets: Schema.Array(
    Schema.Struct({ target: Schema.Struct(targetFields), locator: Schema.Unknown }),
  ).check(Schema.isMaxLength(256)),
  windows: Schema.Array(
    Schema.Struct({ window: Schema.Struct(windowFields), locator: Schema.Unknown }),
  ).check(Schema.isMaxLength(128)),
});
const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), detail: Schema.String, code: Schema.String }),
]);
const result = Schema.decodeSync(Schema.fromJsonString(Reply));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Inserted = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["unavailable", "replace-selection"]) }),
  Schema.Struct({
    status: Schema.Literal("inserted"),
    confirmedCodePoints: Schema.Int,
    injectedCodePoints: Schema.Int,
  }),
]);
const Ibus = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), acceptedCodePoints: Schema.Int }),
  Schema.Struct({ ok: Schema.Literal(false), detail: Schema.String }),
]);
const decodeSnapshot = Schema.decodeUnknownSync(GuestSnapshot);
const decodeActivation = Schema.decodeUnknownSync(Schema.Struct({ activated: Schema.Boolean }));
const decodeKeyboard = Schema.decodeUnknownSync(Schema.Struct({ keyboard: Schema.Boolean }));
const decodeInserted = Schema.decodeUnknownSync(Inserted);
const decodeIbus = Schema.decodeSync(Schema.fromJsonString(Ibus));
const encodeArgument = (data: unknown) => Buffer.from(encode(data)).toString("base64");

export function makeGuestAccessibility(tools: GuestTools, vm: MachinePaths) {
  let locators = new Map<string, { window: boolean; locator: unknown }>();
  const call = async (op: string, arg?: unknown, timeoutMs = 10_000) => {
    const dir = await tools.install(vm, ["atspi.js", "atspi-tree.js"]);
    const raw = await tools.session(vm, {
      executable: "/usr/bin/gjs",
      args: ["-m", dir + "/atspi.js", op, ...(arg === undefined ? [] : [encodeArgument(arg)])],
      maxOutputBytes: 2 * 1024 * 1024,
      timeoutMs,
    });
    const response = result(raw);
    if (!response.ok) throw new Error(response.detail.slice(0, 512));
    return response.result;
  };
  return {
    async snapshot(): Promise<ComputerAutomationAccessibilitySnapshot> {
      const generation = NodeCrypto.randomUUID();
      const fresh = new Map<string, { window: boolean; locator: unknown }>();
      locators = fresh;
      try {
        const snapshot = decodeSnapshot(await call("snapshot"));
        return {
          ...snapshot,
          targets: snapshot.targets.map(({ target, locator }, i) => {
            const id = `a-${generation}-${i}`;
            fresh.set(id, { window: false, locator });
            return { ...target, id };
          }),
          windows: snapshot.windows.map(({ window, locator }, i) => {
            const id = `w-${generation}-${i}`;
            fresh.set(id, { window: true, locator });
            return { ...window, id };
          }),
        };
      } catch (error) {
        return {
          available: false,
          coordinateSpace: "focused-window",
          window: null,
          windows: [],
          targets: [],
          truncated: false,
          detail: (error instanceof Error ? error.message : "Accessibility is unavailable.").slice(
            0,
            512,
          ),
        };
      }
    },
    consume() {
      const previous = locators;
      locators = new Map();
      return async (id: string, window: boolean) => {
        const target = previous.get(id);
        if (!target || target.window !== window)
          throw new Error("The semantic target belongs to an expired observation.");
        const response = await call(window ? "activate-window" : "activate", target.locator);
        if (window) {
          if (!decodeActivation(response).activated)
            throw new Error("The guest window could not be focused.");
          return false;
        }
        return decodeKeyboard(response).keyboard;
      };
    },
    async insert(text: string, intervalMs: number) {
      return decodeInserted(
        await call(
          "insert-text",
          { text, intervalMs },
          10_000 + Array.from(text).length * intervalMs,
        ),
      );
    },
    async ibus(text: string, intervalMs: number) {
      if (/[\n\r\t]/u.test(text))
        throw new Error("Control characters require an editable accessibility target.");
      const dir = await tools.install(vm, ["ibus-commit.py"]);
      const raw = await tools.session(vm, {
        executable: "/usr/bin/python",
        args: [dir + "/ibus-commit.py", encodeArgument({ text, intervalMs })],
        timeoutMs: 10_000 + Array.from(text).length * intervalMs,
      });
      const reply = decodeIbus(raw);
      if (!reply.ok) throw new Error(reply.detail.slice(0, 512));
      return reply.acceptedCodePoints;
    },
  };
}
export type GuestAccessibility = ReturnType<typeof makeGuestAccessibility>;

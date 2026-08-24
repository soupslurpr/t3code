import * as Schema from "effect/Schema";

import type { QemuInputEvent } from "./QemuAgentDesktop.ts";

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "meta_l"] as const;

/** Reports an input name that QEMU cannot inject deterministically. */
export class QemuInputValidationError extends Schema.TaggedErrorClass<QemuInputValidationError>()(
  "QemuInputValidationError",
  {
    code: Schema.Literals(["unsupported-key", "unsupported-text", "duplicate-hotkey-key"]),
    field: Schema.String,
    received: Schema.String,
    expected: Schema.Array(Schema.String),
    phase: Schema.Literal("validation"),
  },
) {
  override get message(): string {
    return `unsupported or duplicate key ${JSON.stringify(this.received)}`;
  }
}

export interface ResolvedQemuKey {
  readonly qcode: string;
  readonly implicitModifiers: ReadonlyArray<string>;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  alt: "alt",
  altleft: "alt",
  altright: "alt_r",
  backspace: "backspace",
  capslock: "caps_lock",
  control: "ctrl",
  controlleft: "ctrl",
  controlright: "ctrl_r",
  ctrl: "ctrl",
  ctrlleft: "ctrl",
  ctrlright: "ctrl_r",
  delete: "delete",
  end: "end",
  enter: "ret",
  escape: "esc",
  esc: "esc",
  home: "home",
  insert: "insert",
  left: "left",
  meta: "meta_l",
  metaleft: "meta_l",
  metaright: "meta_r",
  pagedown: "pgdn",
  pageup: "pgup",
  return: "ret",
  right: "right",
  shift: "shift",
  shiftleft: "shift",
  shiftright: "shift_r",
  space: "spc",
  super: "meta_l",
  tab: "tab",
  up: "up",
  down: "down",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
};

const PRINTABLE_KEYS: Readonly<Record<string, readonly [string, boolean]>> = {
  " ": ["spc", false],
  "!": ["1", true],
  '"': ["apostrophe", true],
  "#": ["3", true],
  $: ["4", true],
  "%": ["5", true],
  "&": ["7", true],
  "'": ["apostrophe", false],
  "(": ["9", true],
  ")": ["0", true],
  "*": ["8", true],
  "+": ["equal", true],
  ",": ["comma", false],
  "-": ["minus", false],
  ".": ["dot", false],
  "/": ["slash", false],
  ":": ["semicolon", true],
  ";": ["semicolon", false],
  "<": ["comma", true],
  "=": ["equal", false],
  ">": ["dot", true],
  "?": ["slash", true],
  "@": ["2", true],
  "[": ["bracket_left", false],
  "\\": ["backslash", false],
  "]": ["bracket_right", false],
  "^": ["6", true],
  _: ["minus", true],
  "`": ["grave_accent", false],
  "{": ["bracket_left", true],
  "|": ["backslash", true],
  "}": ["bracket_right", true],
  "~": ["grave_accent", true],
};

const normalizedKeyName = (key: string): string =>
  key.trim().toLowerCase().replaceAll(/[-_ ]/gu, "");

/** Returns the stable identity used to pair public key-down and key-up aliases. */
export function qemuLogicalKeyId(key: string): string {
  const resolved = resolveQemuKey(key);
  return [...resolved.implicitModifiers, resolved.qcode].join("+");
}

const keyEvent = (qcode: string, down: boolean): QemuInputEvent => ({
  type: "key",
  data: { down, key: { type: "qcode", data: qcode } },
});

/** Resolves public key names and US-layout printable characters to QEMU qcodes. */
export function resolveQemuKey(key: string, field = "key"): ResolvedQemuKey {
  if (key.length === 1) {
    if (/^[a-z]$/u.test(key)) return { qcode: key, implicitModifiers: [] };
    if (/^[A-Z]$/u.test(key)) return { qcode: key.toLowerCase(), implicitModifiers: ["shift"] };
    if (/^[0-9]$/u.test(key)) return { qcode: key, implicitModifiers: [] };
    const printable = PRINTABLE_KEYS[key];
    if (printable !== undefined) {
      return {
        qcode: printable[0],
        implicitModifiers: printable[1] ? ["shift"] : [],
      };
    }
  }
  const normalized = normalizedKeyName(key);
  const named = NAMED_KEYS[normalized];
  if (named !== undefined) return { qcode: named, implicitModifiers: [] };
  const functionMatch = /^f([1-9]|1[0-9]|2[0-4])$/u.exec(normalized);
  if (functionMatch !== null) return { qcode: normalized, implicitModifiers: [] };
  throw new QemuInputValidationError({
    code: "unsupported-key",
    field,
    received: key,
    expected: ["named key", "single printable ASCII character"],
    phase: "validation",
  });
}

/** Resolves a key chord in deterministic modifier order. */
function qemuChordQcodes(
  entries: ReadonlyArray<{ readonly key: string; readonly field: string }>,
): ReadonlyArray<string> {
  const resolved = entries.map(({ key, field }) => {
    const value = resolveQemuKey(key, field);
    return entries.length > 1 && /^[A-Z]$/u.test(key) ? { ...value, implicitModifiers: [] } : value;
  });
  const directQcodes = resolved.map((key) => key.qcode);
  const duplicateIndex = directQcodes.findIndex(
    (qcode, index) => directQcodes.indexOf(qcode) !== index,
  );
  if (duplicateIndex >= 0) {
    throw new QemuInputValidationError({
      code: "duplicate-hotkey-key",
      field: entries[duplicateIndex]!.field,
      received: entries[duplicateIndex]!.key,
      expected: ["key not already present in this chord"],
      phase: "validation",
    });
  }
  const implicitModifiers = resolved
    .flatMap((key) => key.implicitModifiers)
    .filter((modifier) => !directQcodes.includes(modifier));
  const qcodes = [...new Set([...implicitModifiers, ...directQcodes])];
  const ordered = [
    ...MODIFIER_ORDER.filter((modifier) => qcodes.includes(modifier)),
    ...qcodes.filter((qcode) => !MODIFIER_ORDER.includes(qcode as (typeof MODIFIER_ORDER)[number])),
  ];
  return ordered;
}

/** Resolves a hotkey chord in deterministic modifier order. */
export function qemuHotkeyQcodes(keys: ReadonlyArray<string>): ReadonlyArray<string> {
  return qemuChordQcodes(keys.map((key, index) => ({ key, field: `keys[${index}]` })));
}

/** Resolves one key press with compatibility modifiers. */
export function qemuPressQcodes(
  key: string,
  modifiers: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  return qemuChordQcodes([
    ...modifiers.map((modifier, index) => ({
      key: modifier,
      field: `modifiers[${index}]`,
    })),
    { key, field: "key" },
  ]);
}

/** Builds physical key chords only for text QEMU can inject exactly. */
export function qemuTextChords(text: string): ReadonlyArray<ReadonlyArray<string>> {
  const chords: string[][] = [];
  for (const character of text) {
    if (/^[\x20-\x7e]$/u.test(character)) {
      chords.push([...qemuPressQcodes(character)]);
      continue;
    }
    throw new QemuInputValidationError({
      code: "unsupported-text",
      field: "text",
      received: "text requiring semantic insertion",
      expected: ["printable ASCII without newline or tab", "focused accessible editable control"],
      phase: "validation",
    });
  }
  return chords;
}

/** Reports whether physical QEMU key events preserve every requested code point. */
export function canTypeExactlyWithQemu(text: string): boolean {
  return /^[\x20-\x7e]*$/u.test(text);
}

/** Builds a key transition and the qcodes that must be retained for release. */
export function qemuKeyDownEvents(key: string): {
  readonly events: ReadonlyArray<QemuInputEvent>;
  readonly heldQcodes: ReadonlyArray<string>;
} {
  const resolved = resolveQemuKey(key);
  const heldQcodes = [...resolved.implicitModifiers, resolved.qcode];
  return { events: heldQcodes.map((qcode) => keyEvent(qcode, true)), heldQcodes };
}

/** Releases one retained logical key in reverse press order. */
export function qemuKeyUpEvents(heldQcodes: ReadonlyArray<string>): ReadonlyArray<QemuInputEvent> {
  return heldQcodes.toReversed().map((qcode) => keyEvent(qcode, false));
}

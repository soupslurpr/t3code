/** Maps public key names to X11 symbols and physical keypad events. */

const MODIFIER_KEYSYMS = {
  Alt: 0xffe9,
  Control: 0xffe3,
  Meta: 0xffeb,
  Shift: 0xffe1,
};
const NAMED_KEYSYMS = {
  alt: MODIFIER_KEYSYMS.Alt,
  control: MODIFIER_KEYSYMS.Control,
  ctrl: MODIFIER_KEYSYMS.Control,
  meta: MODIFIER_KEYSYMS.Meta,
  super: MODIFIER_KEYSYMS.Meta,
  cmd: MODIFIER_KEYSYMS.Meta,
  command: MODIFIER_KEYSYMS.Meta,
  win: MODIFIER_KEYSYMS.Meta,
  windows: MODIFIER_KEYSYMS.Meta,
  shift: MODIFIER_KEYSYMS.Shift,
  option: MODIFIER_KEYSYMS.Alt,
  backspace: 0xff08,
  tab: 0xff09,
  enter: 0xff0d,
  return: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  home: 0xff50,
  arrowleft: 0xff51,
  left: 0xff51,
  arrowup: 0xff52,
  up: 0xff52,
  arrowright: 0xff53,
  right: 0xff53,
  arrowdown: 0xff54,
  down: 0xff54,
  pageup: 0xff55,
  pagedown: 0xff56,
  end: 0xff57,
  insert: 0xff63,
  delete: 0xffff,
  space: 0x20,
  numlock: 0xff7f,
  numpadenter: 0xff8d,
  numpadmultiply: 0xffaa,
  numpadadd: 0xffab,
  numpadsubtract: 0xffad,
  numpaddecimal: 0xffae,
  numpaddivide: 0xffaf,
  numpad0: 0xffb0,
  numpad1: 0xffb1,
  numpad2: 0xffb2,
  numpad3: 0xffb3,
  numpad4: 0xffb4,
  numpad5: 0xffb5,
  numpad6: 0xffb6,
  numpad7: 0xffb7,
  numpad8: 0xffb8,
  numpad9: 0xffb9,
  numpadequal: 0xffbd,
};

// Preserve keypad modifiers instead of letting keysym injection synthesize Shift.
const KEYPAD_EVDEV_CODES = {
  0xff7f: 69,
  0xff8d: 96,
  0xffaa: 55,
  0xffab: 78,
  0xffad: 74,
  0xffae: 83,
  0xffaf: 98,
  0xffb0: 82,
  0xffb1: 79,
  0xffb2: 80,
  0xffb3: 81,
  0xffb4: 75,
  0xffb5: 76,
  0xffb6: 77,
  0xffb7: 71,
  0xffb8: 72,
  0xffb9: 73,
  0xffbd: 117,
};

/** Resolves case-insensitive named keys without accepting inherited object properties. */
export function resolveNamedKeysym(key) {
  const normalized = key.toLowerCase();
  return Object.hasOwn(NAMED_KEYSYMS, normalized) ? NAMED_KEYSYMS[normalized] : undefined;
}

/** Returns a physical keypad code without deriving or changing modifier state. */
export function keypadEvdevCode(keysym) {
  return Object.hasOwn(KEYPAD_EVDEV_CODES, keysym) ? KEYPAD_EVDEV_CODES[keysym] : undefined;
}

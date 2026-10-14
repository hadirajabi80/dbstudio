// Shortcut strings: parsing, normalisation, platform-aware display and matching against KeyboardEvents.
//
// Write shortcuts as "Mod+Shift+P" (Mod = Ctrl on Windows/Linux, Cmd on macOS). "Ctrl+..." is accepted as a
// synonym of Mod so shortcuts written for Windows work on macOS too; "MacCtrl+..." is the physical Control key on
// macOS (Ctrl on Windows). Chords are separated by a space: "Mod+K Mod+S".
//
// Normalised form (map keys): "ctrl+shift+p" where `ctrl` means Mod; modifier order ctrl, macctrl, alt, shift.
// Display: Windows "Ctrl+Shift+P", macOS "⇧⌘P".

const MOD_ORDER = ['ctrl', 'macctrl', 'alt', 'shift'] as const;

const KEY_ALIASES: Record<string, string> = {
  mod: 'ctrl', cmdorctrl: 'ctrl', commandorcontrol: 'ctrl', control: 'ctrl', cmd: 'ctrl', meta: 'ctrl', command: 'ctrl',
  super: 'ctrl', option: 'alt', opt: 'alt',
  return: 'enter', esc: 'escape', del: 'delete', ins: 'insert', plus: '=', '+': '=', minus: '-', _: '-',
  up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', pgup: 'pageup', pgdn: 'pagedown',
  ' ': 'space', spacebar: 'space',
};

let macOverride: boolean | null = null;

/**
 * macOS detection: Electron's `window.dbstudioPlatform.platform` (preload), else html.platform-darwin, else
 * `navigator.userAgentData.platform || navigator.platform`.
 */
export function isMac(): boolean {
  if (macOverride !== null) return macOverride;
  if (typeof window !== 'undefined' && window.dbstudioPlatform?.platform) return window.dbstudioPlatform.platform === 'darwin';
  if (typeof document !== 'undefined' && document.documentElement?.classList.contains('platform-darwin')) return true;
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || nav.platform || '';
  return /mac|iphone|ipad|darwin/i.test(p);
}

/** Tests: force the platform (null = detect). */
export function setPlatformForTests(mac: boolean | null): void {
  macOverride = mac;
}

/** Normalises one stroke ("Shift+Mod+p" → "ctrl+shift+p"). */
export function normalizeStroke(stroke: string): string {
  // Split on "+" but keep a trailing "+" key ("Ctrl++" = Ctrl and "=").
  const raw = stroke.trim().replace(/\+\+$/, '+=').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set<string>();
  let key = '';
  for (const p of raw) {
    const a = p === 'macctrl' ? 'macctrl' : KEY_ALIASES[p] ?? p;
    if (a === 'ctrl' || a === 'macctrl' || a === 'alt' || a === 'shift') mods.add(a);
    else key = a;
  }
  // Off macOS the physical Control key is Mod.
  if (mods.has('macctrl') && !isMac()) {
    mods.delete('macctrl');
    mods.add('ctrl');
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** Normalises a shortcut that may be a chord ("Mod+K Mod+S"). */
export function normalizeShortcut(shortcut: string): string {
  return shortcut.trim().split(/\s+/).map(normalizeStroke).join(' ');
}

const WIN_NAMES: Record<string, string> = {
  ctrl: 'Ctrl', macctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', enter: 'Enter', escape: 'Esc', delete: 'Del', insert: 'Ins',
  tab: 'Tab', space: 'Space', backspace: 'Backspace', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left',
  arrowright: 'Right', pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End',
};
const MAC_NAMES: Record<string, string> = {
  ctrl: '⌘', macctrl: '⌃', alt: '⌥', shift: '⇧', enter: '↩', escape: '⎋', delete: '⌦', backspace: '⌫', tab: '⇥',
  space: 'Space', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', pageup: 'PgUp', pagedown: 'PgDn',
  home: 'Home', end: 'End', insert: 'Ins',
};
// macOS modifier order: ⌃ ⌥ ⇧ ⌘
const MAC_MOD_ORDER = ['macctrl', 'alt', 'shift', 'ctrl'];

function keyName(k: string, names: Record<string, string>): string {
  return names[k] ?? (k.length === 1 ? k.toUpperCase() : k.replace(/^f(\d+)$/, 'F$1').replace(/^./, (c) => c.toUpperCase()));
}

/** Platform display of one or more strokes: "Ctrl+Shift+P" / "⇧⌘P"; chords "Ctrl+K Ctrl+S" / "⌘K ⌘S". */
export function displayShortcut(shortcut: string, mac = isMac()): string {
  return normalizeShortcut(shortcut)
    .split(' ')
    .map((stroke) => {
      const parts = stroke.split('+');
      const key = parts.pop() ?? '';
      if (mac) {
        const mods = MAC_MOD_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_NAMES[m]);
        return mods.join('') + keyName(key, MAC_NAMES);
      }
      return [...parts.map((m) => WIN_NAMES[m] ?? m), keyName(key, WIN_NAMES)].join('+');
    })
    .join(' ');
}

/** Individual key caps for <kbd> rendering: ["Ctrl", "Shift", "P"] / ["⇧", "⌘", "P"]; chords separated by null. */
export function shortcutKeys(shortcut: string, mac = isMac()): (string | null)[] {
  const out: (string | null)[] = [];
  normalizeShortcut(shortcut).split(' ').forEach((stroke, i) => {
    if (i > 0) out.push(null);
    const parts = stroke.split('+');
    const key = parts.pop() ?? '';
    if (mac) out.push(...MAC_MOD_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_NAMES[m]), keyName(key, MAC_NAMES));
    else out.push(...parts.map((m) => WIN_NAMES[m] ?? m), keyName(key, WIN_NAMES));
  });
  return out;
}

/** Electron accelerator ("CmdOrCtrl+Shift+P"); chords have no accelerator (null). */
export function toAccelerator(shortcut: string): string | null {
  const n = normalizeShortcut(shortcut);
  if (n.includes(' ')) return null;
  const ACC: Record<string, string> = {
    ctrl: 'CmdOrCtrl', macctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', '=': '=', enter: 'Enter', escape: 'Escape',
    arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', pageup: 'PageUp', pagedown: 'PageDown',
    delete: 'Delete', space: 'Space', tab: 'Tab',
  };
  return n.split('+').map((p) => ACC[p] ?? (p.length === 1 ? p.toUpperCase() : p.toUpperCase())).join('+');
}

const CODE_KEYS: Record<string, string> = {
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`', BracketLeft: '[',
  BracketRight: ']', Semicolon: ';', Quote: "'", NumpadAdd: '=', NumpadSubtract: '-', Space: 'space',
};

/** Normalised stroke of a keyboard event; layout-independent for letters, digits and punctuation. */
export function eventStroke(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  let key: string;
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = code.slice(6);
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  else {
    const k = (e.key ?? '').toLowerCase();
    key = KEY_ALIASES[k] ?? k;
  }
  const parts: string[] = [];
  const mac = isMac();
  if (mac ? e.metaKey : e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (mac && e.ctrlKey) parts.push('macctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

/** True for strokes that are only a modifier press (no command can be bound to them). */
export function isModifierOnly(stroke: string): boolean {
  const k = stroke.split('+').pop();
  return k === 'ctrl' || k === 'macctrl' || k === 'alt' || k === 'shift' || k === 'control' || k === 'meta' || k === 'os' || k === '';
}

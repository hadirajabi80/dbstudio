// Key search for the shortcut sheet: which shortcuts a held modifier set uses, and which commands a pressed
// combination (or a two-step chord) runs. Framework-free so the rules are unit-tested on their own.
//
// Typing stays typing: in the search box only strokes that cannot edit text are searched (Ctrl/Alt combinations
// other than the clipboard / word-navigation keys, and F-keys), Shift alone never hints there (it types capitals),
// AltGr is a character modifier on Windows/Linux (never Ctrl+Alt), and macOS Option+key types characters. "Record
// keys" searches every stroke except Escape and Tab.
import { displayShortcut, eventStroke, isAltGraphCharacter, isMac, isModifierOnly } from '../../commands/keys';

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & { isComposing?: boolean };

/** Delay before hints follow a modifier press: AltGr arrives as Ctrl then AltGraph, and Shift+letter is quick. */
export const HINT_DELAY_MS = 120;

const MODS = ['ctrl', 'macctrl', 'alt', 'shift'] as const;

/** Normalised modifier set of an event ("ctrl+alt", "" for none): Mod is Cmd on macOS, Ctrl (or Win) elsewhere. */
export function eventModifiers(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, mac = isMac()): string {
  const on = {
    ctrl: mac ? e.metaKey : e.ctrlKey || e.metaKey,
    macctrl: mac && e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
  };
  return MODS.filter((m) => on[m]).join('+');
}

/** Modifier part of a normalised stroke: "ctrl+alt+l" → "ctrl+alt"; "f5" → "". */
export function strokeModifiers(stroke: string): string {
  const parts = stroke.split('+');
  parts.pop();
  return parts.join('+');
}

export interface KeyContext {
  /** The event target takes text (the search box). */
  textField: boolean;
  /** "Record keys" is on. */
  recording: boolean;
  /** A chord's first stroke was found: the next key (even a plain one) completes it. */
  chordPending: boolean;
  /** AltGr is held (Windows/Linux). */
  altGraph: boolean;
}

export type KeyIntent =
  /** A modifier went down: the held set the list should hint ("" = none). */
  | { kind: 'modifiers'; mods: string }
  /** A full combination to look up (normalised stroke). */
  | { kind: 'stroke'; stroke: string }
  /** Not ours: typing, editing, focus moves, Escape. */
  | { kind: 'pass' };

const EDIT_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'backspace', 'delete', 'pageup', 'pagedown']);
// Normalised strokes (not labels): built from the modifier name so they read as data, not hand-written shortcut text.
const MOD = 'ctrl';
const CLIPBOARD = new Set([...['a', 'c', 'v', 'x', 'z', 'y', 'shift+z', 'insert'].map((k) => `${MOD}+${k}`), 'shift+insert', 'shift+delete']);

/** Strokes a text field keeps for editing (clipboard, undo, word and line navigation, selection). */
export function isTextEditStroke(stroke: string, mac = isMac()): boolean {
  if (CLIPBOARD.has(stroke)) return true;
  const key = stroke.split('+').pop() ?? '';
  if (!EDIT_KEYS.has(key)) return false;
  const mods = strokeModifiers(stroke).split('+').filter(Boolean);
  // Windows/Linux: Ctrl(+Shift) moves by word; macOS: ⌘ by line, ⌥ by word, never both together.
  const allowed = mac ? ['ctrl', 'alt', 'shift'] : ['ctrl', 'shift'];
  if (mac && mods.includes('ctrl') && mods.includes('alt')) return false;
  return mods.every((m) => allowed.includes(m));
}

/** What a keydown means while the sheet is open (see the header comment for the rules). */
export function classifyKeyDown(e: KeyEventLike, ctx: KeyContext, mac = isMac()): KeyIntent {
  if (e.isComposing) return { kind: 'pass' };
  if (!mac && e.key === 'AltGraph') return { kind: 'modifiers', mods: '' };
  const stroke = eventStroke(e);
  if (isModifierOnly(stroke)) {
    if (ctx.altGraph) return { kind: 'modifiers', mods: '' };
    const mods = eventModifiers(e, mac);
    // Shift alone in the search box is typing capitals, not a question about Shift shortcuts.
    return { kind: 'modifiers', mods: mods === 'shift' && ctx.textField && !ctx.recording ? '' : mods };
  }
  // AltGr+L types "ł": a character, not Ctrl+Alt+L.
  if (ctx.altGraph || isAltGraphCharacter(e, mac)) return { kind: 'pass' };
  if (stroke === 'escape' || stroke === 'tab' || stroke === 'shift+tab') return { kind: 'pass' };
  if (ctx.recording || ctx.chordPending) return { kind: 'stroke', stroke };
  const key = stroke.split('+').pop() ?? '';
  const mods = strokeModifiers(stroke).split('+').filter(Boolean);
  const fKey = /^f\d+$/.test(key);
  const command = mods.some((m) => m !== 'shift');
  if (!command && !fKey) return { kind: 'pass' };
  if (ctx.textField) {
    if (isTextEditStroke(stroke, mac)) return { kind: 'pass' };
    // macOS: Option(+Shift)+key types a character (⌥L = "¬"); only ⌘ / ⌃ combinations are shortcuts there.
    if (mac && !mods.includes('ctrl') && !mods.includes('macctrl') && e.key.length === 1) return { kind: 'pass' };
  }
  return { kind: 'stroke', stroke };
}

export interface KeyBinding {
  key: string;
  commandId: string;
}

/** Bindings whose first stroke uses exactly the modifier set `mods` ("" never hints). */
export function bindingsWithModifiers<B extends KeyBinding>(bindings: readonly B[], mods: string): B[] {
  if (!mods) return [];
  return bindings.filter((b) => {
    const first = b.key.split(' ')[0];
    return !isModifierOnly(first) && strokeModifiers(first) === mods;
  });
}

export interface StrokeSearch<B extends KeyBinding> {
  /** The full key looked up: "ctrl+alt+l", or a chord "ctrl+k ctrl+s". */
  key: string;
  /** Bindings of exactly that key. */
  exact: B[];
  /** Chords that start with it (non-empty: the next stroke completes one of them). */
  chords: B[];
}

/**
 * Looks up one stroke. With a pending chord prefix the stroke first tries to complete a chord ("ctrl+k" then
 * "ctrl+s"); when it completes none it is looked up on its own.
 */
export function searchStroke<B extends KeyBinding>(bindings: readonly B[], stroke: string, pending: string | null): StrokeSearch<B> {
  if (pending) {
    const key = `${pending} ${stroke}`;
    const exact = bindings.filter((b) => b.key === key);
    if (exact.length) return { key, exact, chords: [] };
  }
  return {
    key: stroke,
    exact: bindings.filter((b) => b.key === stroke),
    chords: bindings.filter((b) => b.key.startsWith(`${stroke} `)),
  };
}

const MAC_WORDS: Record<string, string> = { ctrl: 'Command', macctrl: 'Control', alt: 'Option', shift: 'Shift' };
const MAC_ORDER = ['macctrl', 'alt', 'shift', 'ctrl'];
const WIN_ORDER = ['ctrl', 'macctrl', 'shift', 'alt'];

/** Words for a screen reader: "Ctrl + Alt + L", macOS "Option + Command + L"; chords "Ctrl + K, then Ctrl + S". */
export function spokenShortcut(shortcut: string, mac = isMac()): string {
  return shortcut
    .split(' ')
    .map((stroke) => {
      const parts = stroke.split('+');
      const key = isModifierOnly(stroke) ? '' : parts.pop() ?? '';
      const mods = (mac ? MAC_ORDER : WIN_ORDER).filter((m) => parts.includes(m)).map((m) => (mac ? MAC_WORDS[m] : displayShortcut(m, false)));
      return [...mods, ...(key ? [displayShortcut(key, false)] : [])].join(' + ');
    })
    .join(', then ');
}

/** "12 shortcuts use Ctrl + Alt" / "1 shortcut uses Ctrl + Alt" / "No shortcut uses Ctrl + Alt + Shift". */
export function hintAnnouncement(count: number, mods: string, mac = isMac()): string {
  const keys = spokenShortcut(mods, mac);
  if (count === 0) return `No shortcut uses ${keys}`;
  return `${count} shortcut${count === 1 ? ' uses' : 's use'} ${keys}`;
}

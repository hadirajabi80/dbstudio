// Global keyboard dispatcher: one capture-phase keydown listener maps strokes (and chords) to registered commands.
//
// Scope resolution: walking up from the focused element, every `data-command-scope` attribute adds a scope
// (innermost first); Monaco's element adds 'editor'; 'global' is always last. The first scope that has an enabled
// command for the stroke wins. Commands with keyHandler 'host' are listed but never dispatched here.
//
// Inside Monaco the editor keeps the keys it owns (run, find, undo, zoom, clipboard, ...), so a global command bound
// to one of those keys does not fire while the editor has focus; the editor binds the matching action itself.
import { commandsForKey, getCommand, isChordPrefix, isEnabled, runCommand, type CommandScope } from './registry';
import { eventStroke, isAltGraphCharacter, isModifierOnly, normalizeShortcut } from './keys';

/** Keys Monaco handles itself while it has focus (globally bound commands with these keys stay quiet there). */
export const EDITOR_OWNED_KEYS = new Set([
  'ctrl+enter', 'ctrl+shift+enter', 'f5', 'escape', 'shift+f5',
  'ctrl+f', 'ctrl+h', 'ctrl+z', 'ctrl+y', 'ctrl+shift+z', 'ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+d',
  'ctrl+=', 'ctrl+-', 'ctrl+0', 'ctrl+/', 'ctrl+space', 'ctrl+shift+space', 'tab', 'shift+tab', 'enter', 'delete',
  'backspace', 'alt+arrowup', 'alt+arrowdown', 'shift+alt+arrowup', 'shift+alt+arrowdown', 'ctrl+arrowleft',
  'ctrl+arrowright', 'f12', 'shift+f12', 'alt+f12', 'f2', 'ctrl+]', 'ctrl+[',
  // Deliberately NOT owned (the plan rebinds them app-wide): Ctrl+L / Ctrl+Shift+L explain, Ctrl+Shift+K change
  // connection, Ctrl+Shift+D change database, Ctrl+P go to object, Ctrl+J snippets.
]);

/** Keys a text field keeps (global commands bound to them do not fire while typing in an input). */
const TEXT_FIELD_KEYS = new Set([
  'ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+y', 'ctrl+shift+z', 'ctrl+arrowleft', 'ctrl+arrowright',
  'ctrl+backspace', 'ctrl+delete', 'home', 'end', 'enter', 'escape', 'delete', 'backspace', 'tab', 'shift+tab',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'space',
]);

const CHORD_TIMEOUT = 1500;
let pendingChord: { stroke: string; at: number; scopes: CommandScope[] } | null = null;

export function scopesFor(target: EventTarget | null): CommandScope[] {
  const out: CommandScope[] = [];
  let el = target instanceof Element ? target : null;
  while (el) {
    if (el.classList?.contains('monaco-editor') && !out.includes('editor')) out.push('editor');
    const s = el.getAttribute?.('data-command-scope');
    if (s) for (const part of s.split(/\s+/)) if (part && !out.includes(part)) out.push(part);
    el = el.parentElement;
  }
  out.push('global');
  return out;
}

function inMonaco(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.monaco-editor');
}

/** True for an element that takes typed text (input, textarea, select, contenteditable). */
export function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
}

/** Resolves the command id for a key in the scope chain (exported for tests). */
export function resolveKey(key: string, scopes: readonly CommandScope[], opts: { editor?: boolean; textField?: boolean } = {}): string | null {
  for (const scope of scopes) {
    if (scope === 'global') {
      if (opts.editor && EDITOR_OWNED_KEYS.has(key)) return null;
      if (opts.textField && TEXT_FIELD_KEYS.has(key)) return null;
    }
    for (const c of commandsForKey(key, scope)) {
      if (c.keyHandler === 'host') continue;
      if (isEnabled(c.id)) return c.id;
    }
  }
  return null;
}

/**
 * The command a native-menu item should run. In the desktop build a menu accelerator can fire before the page sees
 * the key (F4 on Windows), so the renderer's scope resolution never ran: when the item's shortcut is bound to a
 * scoped command that is enabled where focus is (F4 on an ER card → er.design, in a Data tab → dataTab.design,
 * Ctrl+S in the designer → designer.apply), that command runs instead, exactly as the key dispatcher would have
 * chosen. Global-only keys, dialogs and an unfocused page keep the menu's own command.
 */
export function routeMenuCommand(id: string, focused: Element | null = typeof document === 'undefined' ? null : document.activeElement): string {
  const c = getCommand(id);
  if (!c?.shortcut || !focused || focused === document.body) return id;
  if (focused.closest('[role=dialog][aria-modal=true], .palette')) return id;
  const scopes = scopesFor(focused).filter((s) => s !== 'global');
  if (!scopes.length) return id;
  for (const key of [c.shortcut, ...(c.altShortcuts ?? [])].map(normalizeShortcut)) {
    const routed = resolveKey(key, scopes);
    if (routed) return routed;
  }
  return id;
}

/** Returns true when it consumed the keydown (no command, chord or default handling follows). */
export type KeyCapture = (e: KeyboardEvent) => boolean;
const captures: KeyCapture[] = [];

/**
 * A surface that reads keys itself (the shortcut sheet's key search) sees every keydown before any command or chord,
 * whatever has focus. The latest capture wins; returns its remover.
 */
export function pushKeyCapture(fn: KeyCapture): () => void {
  captures.push(fn);
  return () => {
    const i = captures.lastIndexOf(fn);
    if (i >= 0) captures.splice(i, 1);
  };
}

export function onGlobalKeyDown(e: KeyboardEvent): void {
  const capture = captures[captures.length - 1];
  if (capture?.(e)) {
    pendingChord = null;
    return;
  }
  if (e.defaultPrevented || e.isComposing) return;
  // AltGr+L types "ł" on a Polish keyboard: text input, not Ctrl+Alt+L (Format SQL).
  if (isAltGraphCharacter(e)) return;
  const stroke = eventStroke(e);
  if (isModifierOnly(stroke)) return;
  const target = e.target;
  const editor = inMonaco(target);
  const textField = !editor && inTextField(target);
  // A dialog is modal: only its own scope and a few global keys (palette close etc. are handled by the dialog).
  const inDialog = target instanceof Element && !!target.closest('[role=dialog][aria-modal=true], .palette');
  const scopes = scopesFor(target);

  if (pendingChord && Date.now() - pendingChord.at < CHORD_TIMEOUT) {
    const key = `${pendingChord.stroke} ${stroke}`;
    const chordScopes = pendingChord.scopes;
    pendingChord = null;
    const id = resolveKey(key, chordScopes);
    if (id) {
      e.preventDefault();
      e.stopPropagation();
      runCommand(id);
      return;
    }
  }
  pendingChord = null;

  if (inDialog) return;

  if (isChordPrefix(stroke, scopes)) {
    pendingChord = { stroke, at: Date.now(), scopes };
    // Monaco has its own Ctrl+K chords: let it see the first stroke too.
    if (!editor) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }

  const id = resolveKey(stroke, scopes, { editor, textField });
  if (!id) {
    // Never let F5 / Ctrl+R reload the page in the browser build.
    if (!editor && (stroke === 'f5' || stroke === 'ctrl+r')) e.preventDefault();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  runCommand(id);
}

let installed = false;

/** Installs the dispatcher once; returns an uninstaller. */
export function installKeyDispatcher(): () => void {
  if (installed) return () => {};
  installed = true;
  window.addEventListener('keydown', onGlobalKeyDown, true);
  return () => {
    installed = false;
    window.removeEventListener('keydown', onGlobalKeyDown, true);
  };
}

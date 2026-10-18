// Command registry (docs/PLAN-M1.5.md section 3). Rule: every user action in a menu, toolbar, context menu or
// shortcut is a registered command, and UI elements dispatch by id. The palette (Ctrl+Shift+P) lists every
// command whose `when` is true; the shortcut sheet (Ctrl+K Ctrl+S) lists every shortcut; conflicts are detected
// at registration.
//
// This module is framework-free (no React, no stores) so packages can register from their own `commands.ts`:
//
//   import { registerCommand } from '../commands/registry';
//   registerCommand({ id: 'format.document', title: 'Format SQL', category: 'Edit', shortcut: 'Shift+Alt+F',
//                     scope: 'editor', when: () => hasEditor(), run: () => formatActive() });
//
// Context menus pass a target as `args` (see ObjectTarget in ./types); the palette and shortcuts call `run()`
// without args, so commands fall back to the current selection / active tab.
import { displayShortcut, normalizeShortcut } from './keys';

/**
 * Where a shortcut is active. `global` works everywhere (except keys the editor owns); the others only while focus
 * is inside an element carrying `data-command-scope="<scope>"` (the editor scope is Monaco's own element).
 * Two commands may share a shortcut only when their scopes differ.
 */
export type CommandScope =
  | 'global' | 'editor' | 'grid' | 'explorer' | 'history' | 'designer' | 'dataTab' | 'results' | 'palette'
  | (string & {});

export interface Command<A = unknown> {
  /** Namespaced id, e.g. "designer.newTable", "run.multi". */
  id: string;
  /** Title as shown in the palette, menus and tooltips ("New table…"). */
  title: string;
  /** Palette group ("File", "Query", "View", "Database", "Edit", "Data", "Help", ...). */
  category: string;
  /** Primary shortcut in display form ("Ctrl+Alt+T", chord "Ctrl+K Ctrl+S"). */
  shortcut?: string;
  /** Extra bindings that trigger the same command (not shown in menus unless `showAltShortcuts`; always in the sheet). */
  altShortcuts?: string[];
  /**
   * Also show `altShortcuts` next to the primary one in tooltips, menus and the palette (a second binding users of
   * other tools expect, e.g. Format SQL: Shift+Alt+F and the JetBrains Ctrl+Alt+L).
   */
  showAltShortcuts?: boolean;
  scope?: CommandScope;
  /** Enablement; evaluated for the palette, menus and before running. */
  when?(args?: A): boolean;
  run(args?: A): unknown;
  /**
   * 'registry' (default): the global key dispatcher runs the command. 'host': a component (Monaco action, grid
   * key handler) handles the key itself; the registry only lists the shortcut (palette, sheet, conflict check).
   */
  keyHandler?: 'registry' | 'host';
  /** false hides it from the palette (still runnable by id, still listed in the shortcut sheet). */
  palette?: boolean;
  /** Extra words the palette matches on. */
  keywords?: string;
  /** Optional lucide icon name for menus/toolbars that render it (e.g. "Play"). */
  icon?: string;
  /**
   * The command changes data or deletes something (Drop…, Truncate…, Delete connection…, Delete selected rows): menus
   * draw it in the danger colour. Commands that only insert text (Generate DELETE statement) or open a dialog that
   * confirms on its own terms are not dangerous by themselves.
   */
  danger?: boolean;
}

export interface ShortcutBinding {
  /** Normalised ("ctrl+k ctrl+s"). */
  key: string;
  display: string;
  commandId: string;
  scope: CommandScope;
  primary: boolean;
}

export interface ShortcutConflict {
  key: string;
  scope: CommandScope;
  commands: string[];
}

type AnyCommand = Command<never>;

const commands = new Map<string, AnyCommand>();
const aliases = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
let reportedConflicts = new Set<string>();

const isDev = (() => {
  try {
    return !!import.meta.env?.DEV;
  } catch {
    return false;
  }
})();

function notify() {
  version++;
  for (const l of listeners) l();
}

function bindingsOf(c: AnyCommand): ShortcutBinding[] {
  const out: ShortcutBinding[] = [];
  const scope = c.scope ?? 'global';
  if (c.shortcut) out.push({ key: normalizeShortcut(c.shortcut), display: displayShortcut(c.shortcut), commandId: c.id, scope, primary: true });
  for (const s of c.altShortcuts ?? []) out.push({ key: normalizeShortcut(s), display: displayShortcut(s), commandId: c.id, scope, primary: false });
  return out;
}

/** Shortcuts a command shows in tooltips, menus and the palette: the primary one (+ alternatives when advertised). */
export function advertisedShortcuts(c: Pick<Command<never>, 'shortcut' | 'altShortcuts' | 'showAltShortcuts'>): string[] {
  if (!c.shortcut) return [];
  return c.showAltShortcuts ? [c.shortcut, ...(c.altShortcuts ?? [])] : [c.shortcut];
}

/** Register (or replace, same id) a command. Returns a disposer. */
export function registerCommand<A = unknown>(cmd: Command<A>): () => void {
  if (!cmd.id || !cmd.title || typeof cmd.run !== 'function') throw new Error(`[commands] invalid command ${JSON.stringify(cmd.id)}`);
  const c = cmd as unknown as AnyCommand;
  commands.set(c.id, c);
  reportConflicts(c);
  notify();
  return () => {
    if (commands.get(c.id) === c) {
      commands.delete(c.id);
      notify();
    }
  };
}

export function registerCommands(list: readonly Command<never>[]): () => void {
  const disposers = list.map((c) => registerCommand(c));
  return () => disposers.forEach((d) => d());
}

/** Old id → new id (the M1 native menu sends camelCase ids such as "newQueryTab"). */
export function aliasCommand(alias: string, target: string): void {
  aliases.set(alias, target);
}

export function resolveId(id: string): string {
  return commands.has(id) ? id : aliases.get(id) ?? id;
}

export function getCommand(id: string): AnyCommand | undefined {
  return commands.get(resolveId(id));
}

export function hasCommand(id: string): boolean {
  return commands.has(resolveId(id));
}

/** All registered commands, sorted by category then title. */
export function listCommands(): AnyCommand[] {
  return [...commands.values()].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

export function isEnabled(id: string, args?: unknown): boolean {
  const c = getCommand(id);
  if (!c) return false;
  try {
    return c.when ? c.when(args as never) : true;
  } catch (e) {
    console.warn(`[commands] when() of ${c.id} threw`, e);
    return false;
  }
}

/** Run by id; returns false when the command is unknown or disabled. */
export function runCommand(id: string, args?: unknown): boolean {
  const c = getCommand(id);
  if (!c) {
    if (isDev) console.warn(`[commands] unknown command ${id}`);
    return false;
  }
  if (!isEnabled(c.id, args)) return false;
  try {
    const r = c.run(args as never);
    if (r && typeof (r as Promise<unknown>).catch === 'function') {
      (r as Promise<unknown>).catch((e) => console.error(`[commands] ${c.id} failed`, e));
    }
  } catch (e) {
    console.error(`[commands] ${c.id} failed`, e);
  }
  return true;
}

/** Every shortcut binding of every command (primary and alternatives). */
export function listBindings(): ShortcutBinding[] {
  return listCommands().flatMap(bindingsOf);
}

/** Same normalised key in the same scope bound to more than one command. */
export function findConflicts(): ShortcutConflict[] {
  const m = new Map<string, Set<string>>();
  for (const b of listBindings()) {
    const k = `${b.scope}\u0001${b.key}`;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(b.commandId);
  }
  const out: ShortcutConflict[] = [];
  for (const [k, ids] of m) {
    if (ids.size < 2) continue;
    const [scope, key] = k.split('\u0001');
    out.push({ key, scope, commands: [...ids].sort() });
  }
  return out;
}

function reportConflicts(c: AnyCommand) {
  for (const b of bindingsOf(c)) {
    for (const other of commands.values()) {
      if (other.id === c.id) continue;
      if (bindingsOf(other).some((o) => o.key === b.key && o.scope === b.scope)) {
        const tag = [b.key, b.scope, ...[c.id, other.id].sort()].join('|');
        if (reportedConflicts.has(tag)) continue;
        reportedConflicts.add(tag);
        console.error(`[commands] shortcut conflict: ${b.display} (${b.scope}) is bound to both ${other.id} and ${c.id}`);
      }
    }
  }
}

/** Commands bound to `key` (normalised) in `scope`. */
export function commandsForKey(key: string, scope: CommandScope): AnyCommand[] {
  const out: AnyCommand[] = [];
  for (const c of commands.values()) {
    if ((c.scope ?? 'global') !== scope) continue;
    if (bindingsOf(c).some((b) => b.key === key)) out.push(c);
  }
  return out;
}

/** True when some binding in one of `scopes` starts with `stroke` followed by another stroke. */
export function isChordPrefix(stroke: string, scopes: readonly CommandScope[]): boolean {
  const prefix = `${stroke} `;
  for (const c of commands.values()) {
    if (!scopes.includes(c.scope ?? 'global')) continue;
    if (bindingsOf(c).some((b) => b.key.startsWith(prefix))) return true;
  }
  return false;
}

export function subscribeCommands(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function commandsVersion(): number {
  return version;
}

/** Test helper: forget everything. */
export function resetCommandsForTests(): void {
  commands.clear();
  aliases.clear();
  reportedConflicts = new Set();
  notify();
}

/** The registry as one object (also exposed on window.__dbstudio.commands in dev). */
export const commandRegistry = {
  register: registerCommand,
  registerAll: registerCommands,
  alias: aliasCommand,
  get: getCommand,
  has: hasCommand,
  list: listCommands,
  run: runCommand,
  enabled: isEnabled,
  bindings: listBindings,
  conflicts: findConflicts,
  subscribe: subscribeCommands,
};

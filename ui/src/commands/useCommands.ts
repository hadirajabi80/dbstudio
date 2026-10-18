// React bindings for the registry: re-render when commands are (un)registered or app state changes.
import { useSyncExternalStore } from 'react';
import { editorsVersion, subscribeEditors } from '../app/editors';
import { useCatalog } from '../store/catalog';
import { useResults } from '../store/results';
import { useSessions } from '../store/sessions';
import { useTabs } from '../store/tabs';
import { advertisedShortcuts, commandsVersion, getCommand, isEnabled, runCommand, subscribeCommands, type Command } from './registry';
import { displayShortcut, tooltipWithShortcut } from './keys';

/** Registry version (changes on register/unregister). */
export function useCommandsVersion(): number {
  return useSyncExternalStore(subscribeCommands, commandsVersion, commandsVersion);
}

/**
 * Ticks whenever state that commonly drives `when()` changes (active tab, sessions, executions, catalog), so toolbar
 * buttons re-evaluate enablement. Cheap: the selectors return primitives/identities.
 */
export function useCommandContext(): unknown {
  useCommandsVersion();
  // editors mounting / unmounting (Format and Explain need the console's editor)
  useSyncExternalStore(subscribeEditors, editorsVersion, editorsVersion);
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.activeId);
  const sessions = useSessions((s) => s.sessions);
  const execs = useResults((s) => s.executions);
  const conns = useCatalog((s) => s.conns);
  return [tabs, active, sessions, execs, conns];
}

export interface CommandView {
  id: string;
  command: Command<never> | undefined;
  title: string;
  shortcut: string | undefined;
  /** Every shortcut shown to the user: the primary one, plus the alternatives of commands that advertise them. */
  shortcuts: string[];
  /** "Title (Ctrl+Shift+P)" ("Explain plan (estimated) · Ctrl+L" after a parenthetical); advertised alternatives too: "Format SQL (Shift+Alt+F or Ctrl+Alt+L)". */
  tooltip: string;
  enabled: boolean;
  run: () => void;
}

export function commandView(id: string, args?: unknown, titleOverride?: string): CommandView {
  const c = getCommand(id);
  const title = titleOverride ?? c?.title ?? id;
  const shortcuts = c ? advertisedShortcuts(c) : [];
  return {
    id,
    command: c,
    title,
    shortcut: c?.shortcut,
    shortcuts,
    tooltip: tooltipWithShortcut(title, shortcuts.map((k) => displayShortcut(k)).join(' or ')),
    enabled: !!c && isEnabled(id, args),
    run: () => void runCommand(id, args),
  };
}

/** A command's view, recomputed on every render (call `useCommandContext()` once in the parent component). */
export function useCommand(id: string, args?: unknown, titleOverride?: string): CommandView {
  useCommandsVersion();
  return commandView(id, args, titleOverride);
}

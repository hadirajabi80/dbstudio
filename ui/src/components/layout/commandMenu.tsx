// Builds menu items (context menus, dropdowns) from command ids, so every menu entry is a registered command.
import {
  Activity, ArrowRightLeft, Ban, Binary, Braces, Check, ChevronsDownUp, CircleStop, ClipboardCopy, CloudUpload, Code, Code2, CodeXml, Columns3, Command, Copy, Database, Download, Eraser, Eye, File, FileCode2, FileDiff, FileText, Filter, FolderOpen, Funnel, FunnelX, Gauge, GitCommitHorizontal, GitCompare, Hash, History, House, Info, KeyRound, Keyboard, Layers, LayoutList, Link, ListChecks, ListEnd, ListTree, Maximize2, Monitor, Moon, Network, Package, PanelLeft, Pencil, PencilRuler, Pin, Play, Plug, Plus, Redo2, RefreshCw, RotateCcw, Rows2, Rows3, Save, Scissors, ScrollText, Search, Settings, ShieldAlert, Sparkles, SquareChevronRight, SquareFunction, SquarePen, SquareTerminal, Sun, SunMoon, Table2, TableProperties, TextCursorInput, Timer, Trash, Trash2, Undo2, Unplug, Upload, Variable, Wand, WandSparkles, Workflow, X, Zap, ZoomIn, ZoomOut, type LucideIcon,
} from 'lucide-react';
import type { ContextEntry } from '../../commands/menuModel';
import { CONTEXT_MENUS } from '../../commands/menuModel';
import { isMac } from '../../commands/keys';
import { getCommand } from '../../commands/registry';
import { commandView } from '../../commands/useCommands';
import type { MenuItem } from '../common/Menu';

const ICONS: Record<string, LucideIcon> = {
  Activity, ArrowRightLeft, Ban, Binary, Braces, Check, ChevronsDownUp, CircleStop, ClipboardCopy, CloudUpload, Code, Code2, CodeXml, Columns3, Command, Copy, Database, Download, Eraser, Eye, File, FileCode2, FileDiff, FileText, Filter, FolderOpen, Funnel, FunnelX, Gauge, GitCommitHorizontal, GitCompare, Hash, History, House, Info, KeyRound, Keyboard, Layers, LayoutList, Link, ListChecks, ListEnd, ListTree, Maximize2, Monitor, Moon, Network, Package, PanelLeft, Pencil, PencilRuler, Pin, Play, Plug, Plus, Redo2, RefreshCw, RotateCcw, Rows2, Rows3, Save, Scissors, ScrollText, Search, Settings, ShieldAlert, Sparkles, SquareChevronRight, SquareFunction, SquarePen, SquareTerminal, Sun, SunMoon, Table2, TableProperties, TextCursorInput, Timer, Trash, Trash2, Undo2, Unplug, Upload, Variable, Wand, WandSparkles, Workflow, X, Zap, ZoomIn, ZoomOut,
};

/** True when `name` resolves to an icon (tests: every menu command has a drawable icon). */
export function hasCommandIcon(name: string | undefined): boolean {
  return !!name && !!ICONS[name];
}

/**
 * Icon of a command. "Command" (the palette) is the ⌘ glyph only on macOS; elsewhere a prompt glyph, since ⌘ means
 * nothing on Windows.
 */
export function commandIcon(name: string | undefined, size = 16) {
  const key = name === 'Command' && !isMac() ? 'SquareChevronRight' : name;
  const I = key ? ICONS[key] : undefined;
  return I ? <I size={size} strokeWidth={1.5} /> : undefined;
}

function isSubmenu(e: ContextEntry): e is Extract<ContextEntry, { submenu: string }> {
  return typeof e === 'object' && 'submenu' in e;
}

/**
 * Menu items for a list of command entries; unregistered optional commands are skipped, disabled ones greyed (or
 * hidden with `hideDisabled`). Submenus whose items are all hidden are dropped; separators never double up.
 * Shortcuts are platform labels (displayed by the menu through displayShortcut()).
 */
export function commandMenuItems(entries: readonly ContextEntry[], args?: unknown): MenuItem[] {
  const out: MenuItem[] = [];
  for (const e of entries) {
    if (e === 'separator') {
      if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
      continue;
    }
    if (isSubmenu(e)) {
      const items = commandMenuItems(e.entries, args);
      if (items.length) out.push({ id: e.submenu, label: e.label, icon: commandIcon(e.icon, 14), submenu: items, disabled: items.every((i) => i.separator || i.disabled) });
      continue;
    }
    const c = getCommand(e.command);
    if (!c) continue;
    const v = commandView(e.command, args, e.label);
    if (e.hideDisabled && !v.enabled) continue;
    out.push({
      id: e.command,
      label: v.title,
      icon: commandIcon(c.icon, 14),
      shortcut: c.shortcut,
      ...(v.shortcuts.length > 1 ? { extraShortcuts: v.shortcuts.slice(1) } : {}),
      disabled: !v.enabled,
      danger: /delete|remove|\.drop$|\.truncate$/i.test(e.command),
      onClick: v.run,
    });
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  while (out.length && out[0].separator) out.shift();
  return out;
}

/** Items of a named context menu from the model (CONTEXT_MENUS). */
export function contextMenu(id: keyof typeof CONTEXT_MENUS | string, args?: unknown): MenuItem[] {
  return commandMenuItems(CONTEXT_MENUS[id] ?? [], args);
}

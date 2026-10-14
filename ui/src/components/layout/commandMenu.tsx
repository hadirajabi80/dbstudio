// Builds menu items (context menus, dropdowns) from command ids, so every menu entry is a registered command.
import {
  Activity, ArrowRightLeft, Ban, Binary, Braces, Check, ChevronsDownUp, CircleStop, ClipboardCopy, CloudUpload, Code, Code2, CodeXml, Columns3, Command, Copy, Database, Download, Eye, File, FileCode2, FileDiff, FileText, Filter, FolderOpen, Funnel, FunnelX, Gauge, GitCommitHorizontal, GitCompare, Hash, History, House, Info, KeyRound, Keyboard, Layers, LayoutList, Link, ListChecks, ListEnd, ListTree, Network, Package, PanelLeft, Pencil, PencilRuler, Play, Plug, Plus, Redo2, RefreshCw, RotateCcw, Rows2, Rows3, Save, Scissors, ScrollText, Search, Settings, Sparkles, SquareFunction, SquarePen, SquareTerminal, Table2, TableProperties, TextCursorInput, Timer, Trash, Trash2, Undo2, Unplug, Upload, Variable, Wand, WandSparkles, Workflow, X, Zap, type LucideIcon,
} from 'lucide-react';
import type { ContextEntry } from '../../commands/menuModel';
import { CONTEXT_MENUS } from '../../commands/menuModel';
import { getCommand } from '../../commands/registry';
import { commandView } from '../../commands/useCommands';
import { displayShortcut } from '../../commands/keys';
import type { MenuItem } from '../common/Menu';

const ICONS: Record<string, LucideIcon> = {
  Activity, ArrowRightLeft, Ban, Binary, Braces, Check, ChevronsDownUp, CircleStop, ClipboardCopy, CloudUpload, Code, Code2, CodeXml, Columns3, Command, Copy, Database, Download, Eye, File, FileCode2, FileDiff, FileText, Filter, FolderOpen, Funnel, FunnelX, Gauge, GitCommitHorizontal, GitCompare, Hash, History, House, Info, KeyRound, Keyboard, Layers, LayoutList, Link, ListChecks, ListEnd, ListTree, Network, Package, PanelLeft, Pencil, PencilRuler, Play, Plug, Plus, Redo2, RefreshCw, RotateCcw, Rows2, Rows3, Save, Scissors, ScrollText, Search, Settings, Sparkles, SquareFunction, SquarePen, SquareTerminal, Table2, TableProperties, TextCursorInput, Timer, Trash, Trash2, Undo2, Unplug, Upload, Variable, Wand, WandSparkles, Workflow, X, Zap,
};

export function commandIcon(name: string | undefined, size = 16) {
  const I = name ? ICONS[name] : undefined;
  return I ? <I size={size} strokeWidth={1.5} /> : undefined;
}

/** Menu items for a list of command entries; unregistered optional commands are skipped, disabled ones greyed. */
export function commandMenuItems(entries: readonly ContextEntry[], args?: unknown): MenuItem[] {
  const out: MenuItem[] = [];
  for (const e of entries) {
    if (e === 'separator') {
      if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
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
      shortcut: c.shortcut ? displayShortcut(c.shortcut) : undefined,
      disabled: !v.enabled,
      danger: /delete|remove/i.test(e.command),
      onClick: v.run,
    });
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/** Items of a named context menu from the model (CONTEXT_MENUS). */
export function contextMenu(id: keyof typeof CONTEXT_MENUS | string, args?: unknown): MenuItem[] {
  return commandMenuItems(CONTEXT_MENUS[id] ?? [], args);
}

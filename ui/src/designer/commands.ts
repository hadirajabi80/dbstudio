// WP-I designer commands (auto-loaded by commands/index.ts) and the designer tab views.
// Explorer context menus pass a CommandTarget (ObjectTarget / ContainerTarget / ConnectionTarget) as args; the palette
// and shortcuts run without args and fall back to the explorer selection or the active tab.
import { targetOf } from '../commands/core';
import { registerCommands, type Command } from '../commands/registry';
import { isObjectTarget, isTabTarget } from '../commands/types';
import { registerTabView } from '../components/layout/tabViews';
import { useSessions } from '../store/sessions';
import { getActiveTab, useTabs } from '../store/tabs';
import { toast } from '../store/ui';
import { activeDesignerActions } from './actions';
import { activeEditSession, editSessionOf, restorePersistedEdits } from './editSession';
import {
  contextOf, editObject, objectOf, openEditScript, openProcedureWizard, openTableDesigner, openViewDesigner, TABLE_VIEW, VIEW_VIEW,
} from './open';
import { useDesignerUi } from './store';
import { TableDesignerTab, ViewDesignerTab } from './views';

const EDITABLE = new Set(['table', 'view', 'mview', 'proc', 'func', 'tablefunc', 'package', 'trigger', 'type']);

const noContext = () => toast('info', 'Pick a connection first', 'Select a database, schema or object in the explorer, or open a console on a connection.');

/**
 * Table a new trigger defaults to: only a table node of the explorer (the menu target or the selection). The active tab
 * is deliberately ignored, so a view or an unrelated designer tab never pre-fills the wizard.
 */
export function explorerTable(args?: unknown): string | null {
  if (isTabTarget(args)) return null;
  const t = targetOf(args);
  return isObjectTarget(t) && t.ref.type === 'table' ? t.ref.name : null;
}

/** Host-handled keys of the column grid, registered so they show in the shortcut sheet. */
const gridKey = (id: string, title: string, shortcut: string): Command<never> => ({
  id: `designer.grid.${id}`, title, category: 'Designer', shortcut, scope: 'designer', keyHandler: 'host', palette: false, run: () => undefined,
});

export const DESIGNER_COMMANDS: Command<never>[] = [
  {
    id: 'designer.newTable', title: 'New table…', category: 'Database', shortcut: 'Mod+Alt+T', icon: 'Table2', keywords: 'create table design',
    run: (args?: unknown) => {
      const c = contextOf(args);
      if (c) openTableDesigner(c, null);
      else noContext();
    },
  },
  {
    id: 'designer.newView', title: 'New view…', category: 'Database', icon: 'Eye', keywords: 'create view',
    run: (args?: unknown) => {
      const c = contextOf(args);
      if (c) openViewDesigner(c, null);
      else noContext();
    },
  },
  {
    id: 'designer.newProcedure', title: 'New procedure…', category: 'Database', icon: 'Workflow', keywords: 'create stored procedure function wizard',
    when: (args?: unknown) => contextOf(args)?.dialect !== 'sqlite',
    run: (args?: unknown) => {
      const c = contextOf(args);
      if (c) openProcedureWizard(c, { kind: 'procedure' });
      else noContext();
    },
  },
  {
    id: 'designer.newFunction', title: 'New function…', category: 'Database', icon: 'SquareFunction', keywords: 'create function wizard',
    when: (args?: unknown) => contextOf(args)?.dialect !== 'sqlite',
    run: (args?: unknown) => {
      const c = contextOf(args);
      if (c) openProcedureWizard(c, { kind: 'function' });
      else noContext();
    },
  },
  {
    id: 'designer.newPackage', title: 'New package…', category: 'Database', icon: 'Package', keywords: 'create package oracle',
    when: (args?: unknown) => contextOf(args)?.dialect === 'plsql',
    run: (args?: unknown) => {
      const c = contextOf(args);
      if (c) openProcedureWizard(c, { kind: 'package' });
    },
  },
  {
    id: 'designer.newTrigger', title: 'New trigger…', category: 'Database', icon: 'Zap', keywords: 'create trigger',
    run: (args?: unknown) => {
      const c = contextOf(args);
      if (c) openProcedureWizard(c, { kind: 'trigger', table: explorerTable(args) });
      else noContext();
    },
  },
  {
    id: 'designer.edit', title: 'Design / edit object', category: 'Database', shortcut: 'F4', icon: 'PencilRuler', keywords: 'alter modify design',
    when: (args?: unknown) => {
      const o = objectOf(args);
      return !!o && EDITABLE.has(o.ref.type);
    },
    run: (args?: unknown) => {
      const o = objectOf(args);
      if (o) void editObject(o);
    },
  },
  {
    id: 'designer.editAsScript', title: 'Edit object as SQL script', category: 'Database', icon: 'FileCode2', keywords: 'alter create or replace ddl',
    when: (args?: unknown) => {
      const o = objectOf(args);
      return !!o && o.ref.type !== 'table' && EDITABLE.has(o.ref.type);
    },
    run: (args?: unknown) => {
      const o = objectOf(args);
      if (o) void openEditScript(o.connectionId, o.database, o.ref);
    },
  },
  {
    id: 'designer.apply', title: 'Apply designer changes', category: 'Database', shortcut: 'Mod+S', scope: 'designer', icon: 'Play',
    when: () => !!activeDesignerActions(),
    run: () => activeDesignerActions()?.apply(),
  },
  {
    id: 'designer.compareWithServer', title: 'Compare with server', category: 'Database', icon: 'GitCompare', keywords: 'diff changes',
    when: () => !!activeEditSession(),
    run: () => {
      const t = getActiveTab();
      if (!t || !editSessionOf(t.id)) return;
      useDesignerUi.getState().openCompare(t.id);
    },
  },
  gridKey('addColumn', 'Add column at the end', 'Insert'),
  gridKey('insertColumn', 'Insert column below', 'Alt+Insert'),
  gridKey('removeColumn', 'Remove column', 'Delete'),
  gridKey('moveUp', 'Move column up', 'Alt+ArrowUp'),
  gridKey('moveDown', 'Move column down', 'Alt+ArrowDown'),
  gridKey('duplicate', 'Duplicate column', 'Mod+D'),
  gridKey('editCell', 'Edit cell', 'F2'),
];

let registered = false;

export function registerDesignerCommands(): void {
  if (registered) return;
  registered = true;
  registerTabView(TABLE_VIEW, { component: TableDesignerTab, icon: 'Table2' });
  registerTabView(VIEW_VIEW, {
    component: ViewDesignerTab,
    icon: 'Eye',
    onClosed: (tab) => void useSessions.getState().close(tab.id, true).catch(() => undefined),
  });
  registerCommands(DESIGNER_COMMANDS);
  // "Edit object" sessions follow the tabs: consoles restored with the workspace (or reopened) get theirs back from
  // the persisted `edit` field, so Compare and the atomic apply survive a restart; closed consoles forget theirs.
  const sync = (tabs: ReturnType<typeof useTabs.getState>['tabs']) => {
    const edits = useDesignerUi.getState().edits;
    for (const id of Object.keys(edits)) {
      const t = tabs.find((x) => x.id === id);
      if (!t || (t.kind === 'console' && t.edit === null)) useDesignerUi.getState().forgetEdit(id);
    }
    restorePersistedEdits(tabs);
  };
  sync(useTabs.getState().tabs);
  useTabs.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) sync(s.tabs);
  });
}

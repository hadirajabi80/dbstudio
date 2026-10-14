// WP-I designer commands (auto-loaded by commands/index.ts) and the designer tab views.
// Explorer context menus pass a CommandTarget (ObjectTarget / ContainerTarget / ConnectionTarget) as args; the palette
// and shortcuts run without args and fall back to the explorer selection or the active tab.
import { registerCommands, type Command } from '../commands/registry';
import { registerTabView } from '../components/layout/tabViews';
import { useSessions } from '../store/sessions';
import { getActiveTab, useTabs } from '../store/tabs';
import { toast } from '../store/ui';
import { activeDesignerActions } from './actions';
import {
  contextOf, editObject, objectOf, openEditScript, openProcedureWizard, openTableDesigner, openViewDesigner, TABLE_VIEW, VIEW_VIEW,
} from './open';
import { useDesignerUi } from './store';
import { TableDesignerTab, ViewDesignerTab } from './views';

const EDITABLE = new Set(['table', 'view', 'mview', 'proc', 'func', 'tablefunc', 'package', 'trigger', 'type']);

const noContext = () => toast('info', 'Pick a connection first', 'Select a database, schema or object in the explorer, or open a console on a connection.');

const activeEdit = () => {
  const t = getActiveTab();
  return t?.kind === 'console' ? useDesignerUi.getState().edits[t.id] : undefined;
};

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
      const o = objectOf(args);
      if (c) openProcedureWizard(c, { kind: 'trigger', table: o && (o.ref.type === 'table' || o.ref.type === 'view') ? o.ref.name : null });
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
    when: () => !!activeEdit(),
    run: () => {
      const t = getActiveTab();
      if (!t) return;
      useDesignerUi.getState().openCompare(t.id);
      void import('./host').then((m) => m.ensureDesignerHost());
    },
  },
  gridKey('addColumn', 'Add column', 'Insert'),
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
  // Forget "edit object" sessions of consoles that were closed.
  useTabs.subscribe((s) => {
    const edits = useDesignerUi.getState().edits;
    for (const id of Object.keys(edits)) if (!s.tabs.some((t) => t.id === id)) useDesignerUi.getState().forgetEdit(id);
  });
}

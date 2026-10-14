// WP-G commands (auto-loaded by commands/index.ts): the Data tab view and every grid action (filter, quick filter,
// server filter, editing, record view). Grid commands act on the grid that last had focus (Grid/controller.ts) and
// are scoped to `data-command-scope="grid"`, so their keys only apply while a grid has focus.
import { objectTargetOf } from '../../commands/core';
import { registerCommands, type Command } from '../../commands/registry';
import type { ObjectTarget } from '../../commands/types';
import { isTabular } from '../../lib/sql';
import { useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import type { ViewTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { activeGridController } from '../Grid/controller';
import { registerTabView } from '../layout/tabViews';
import { DataTabView } from './DataTabView';
import { countTabId, dataGridKey, DATA_VIEW, openDataTab } from './open';

const grid = () => activeGridController();
const editable = () => !!grid()?.editable;

export const GRID_COMMANDS: Command<never>[] = [
  {
    id: 'grid.filter', title: 'Filter rows…', category: 'Grid', shortcut: 'Mod+F', scope: 'grid', icon: 'Funnel',
    when: () => !!grid(), run: () => grid()?.openFilter(),
  },
  {
    id: 'grid.quickFilterCell', title: 'Quick filter by the focused cell…', category: 'Grid', shortcut: 'Mod+Shift+F', scope: 'grid',
    when: () => !!grid(), run: () => grid()?.quickFilterCell(),
  },
  { id: 'grid.clearFilter', title: 'Clear grid filter', category: 'Grid', scope: 'grid', when: () => !!grid(), run: () => grid()?.clearFilter() },
  {
    id: 'grid.applyServerFilter', title: 'Apply filter on server', category: 'Grid', shortcut: 'Mod+Shift+Enter', scope: 'grid', icon: 'CloudUpload',
    keywords: 'where push down', when: () => !!grid()?.applyServerFilter, run: () => grid()?.applyServerFilter?.(),
  },
  {
    id: 'grid.submitChanges', title: 'Submit pending changes…', category: 'Data', shortcut: 'Mod+S', scope: 'grid', icon: 'Save',
    keywords: 'save commit edits', when: () => editable() && !!grid()?.hasPending?.(), run: () => grid()?.submit?.(),
  },
  { id: 'grid.undo', title: 'Undo grid edit', category: 'Data', shortcut: 'Mod+Z', scope: 'grid', when: editable, run: () => grid()?.undo?.() },
  { id: 'grid.redo', title: 'Redo grid edit', category: 'Data', shortcut: 'Mod+Y', altShortcuts: ['Mod+Shift+Z'], scope: 'grid', when: editable, run: () => grid()?.redo?.() },
  { id: 'grid.setNull', title: 'Set selected cells to NULL', category: 'Data', shortcut: 'Mod+0', scope: 'grid', when: editable, run: () => grid()?.setNull?.() },
  { id: 'grid.insertRow', title: 'Insert row', category: 'Data', shortcut: 'Insert', scope: 'grid', icon: 'Plus', when: editable, run: () => grid()?.insertRow?.() },
  { id: 'grid.deleteRows', title: 'Delete selected rows', category: 'Data', shortcut: 'Delete', scope: 'grid', icon: 'Trash2', when: editable, run: () => grid()?.deleteRows?.() },
  { id: 'grid.revertAll', title: 'Revert all pending changes', category: 'Data', scope: 'grid', when: () => editable() && !!grid()?.hasPending?.(), run: () => grid()?.revertAll?.() },
  { id: 'grid.toggleRecordView', title: 'Toggle record view', category: 'Grid', shortcut: 'F7', scope: 'grid', icon: 'Rows3', when: () => !!grid(), run: () => grid()?.toggleRecordView?.() },
  {
    id: 'grid.loadMore', title: 'Load more rows', category: 'Data', shortcut: 'Mod+End', scope: 'grid', keyHandler: 'host',
    when: () => !!grid()?.loadMore, run: () => grid()?.loadMore?.(),
  },
  { id: 'dataTab.refresh', title: 'Reload table data', category: 'Data', shortcut: 'F5', scope: 'dataTab', icon: 'RefreshCw', when: () => !!grid()?.refresh, run: () => grid()?.refresh?.() },
];

export const DATA_COMMANDS: Command<never>[] = [
  {
    id: 'data.open', title: 'Open table data', category: 'Database', shortcut: 'Mod+Alt+D', icon: 'Table2', keywords: 'browse edit rows',
    when: (args?: never) => {
      const t = objectTargetOf(args);
      return !!t && isTabular(t.ref.type);
    },
    run: (args?: never) => {
      const t = objectTargetOf(args) as ObjectTarget | null;
      if (!t) return;
      openDataTab({ connectionId: t.connectionId, database: t.database, schema: t.ref.schema, name: t.ref.name, type: t.ref.type });
    },
  },
];

async function beforeClose(tab: ViewTab): Promise<boolean> {
  const b = useEdits.getState().get(dataGridKey(tab.id));
  const n = Object.keys(b.pending.updates).length + b.pending.inserts.length + Object.keys(b.pending.deletes).length;
  if (n === 0) return true;
  return useUi.getState().askConfirm({
    title: 'Discard pending changes?',
    message: `“${tab.title}” has ${n} change${n === 1 ? '' : 's'} that ${n === 1 ? 'is' : 'are'} not submitted.`,
    confirmLabel: 'Close and discard',
    danger: true,
  });
}

function onClosed(tab: ViewTab): void {
  useEdits.getState().reset(dataGridKey(tab.id));
  for (const id of [tab.id, countTabId(tab.id)]) void useSessions.getState().close(id, true).catch(() => undefined);
}

export function registerGridCommands(): void {
  registerTabView(DATA_VIEW, { component: DataTabView, icon: 'Table2', beforeClose, onClosed });
  registerCommands([...DATA_COMMANDS, ...GRID_COMMANDS]);
}

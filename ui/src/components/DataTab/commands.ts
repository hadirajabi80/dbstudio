// WP-G commands (auto-loaded by commands/index.ts): the Data tab view and every grid action (filter, quick filter,
// server filter, editing, copy/export, record view). Grid commands act on the grid named by `args.gridKey` (menus and
// toolbars pass it) or else on the grid that last had focus (Grid/controller.ts), and are scoped to
// `data-command-scope="grid"`, so their keys only apply while a grid has focus.
import { objectTargetOf } from '../../commands/core';
import { aliasCommand, isEnabled, registerCommands, runCommand, type Command } from '../../commands/registry';
import type { ObjectTarget } from '../../commands/types';
import type { CopyFormat } from '../../lib/serialize';
import { isTabular } from '../../lib/sql';
import { dialectOf } from '../../store/connections';
import { useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { useTabs, type ViewTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import type { FileFormat } from '../Grid/clientExport';
import { activeGridController, gridController, type GridController } from '../Grid/controller';
import { hasOpenEditor } from '../Grid/overlayEditor';
import { registerTabView } from '../layout/tabViews';
import { DataTabView } from './DataTabView';
import { dataGridKey, DATA_VIEW, focusDataTabPrimary, openDataTab, type DataTabState } from './open';

/** Menus/toolbars pass `{ gridKey }` (and `all: true` for "Copy all as …"). */
interface GridArgs {
  gridKey?: string;
  all?: boolean;
}

const gridArgs = (args: unknown): GridArgs => (args && typeof args === 'object' ? (args as GridArgs) : {});
const gridOf = (args?: unknown): GridController | undefined => {
  const k = gridArgs(args).gridKey;
  return k ? gridController(k) : activeGridController();
};
const has = (args?: unknown) => !!gridOf(args);
const editable = (args?: unknown) => !!gridOf(args)?.editable;
const pendingOrEditing = (args?: unknown) => editable(args) && (!!gridOf(args)?.hasPending?.() || hasOpenEditor());

const COPY_FORMATS: { id: string; format: CopyFormat; title: string; shortcut?: string }[] = [
  { id: 'grid.copyAs.csv', format: 'csv', title: 'Copy as CSV', shortcut: 'Mod+Shift+C' },
  { id: 'grid.copyAs.tsv', format: 'tsv', title: 'Copy as TSV' },
  { id: 'grid.copyAs.markdown', format: 'markdown', title: 'Copy as Markdown' },
  { id: 'grid.copyAs.json', format: 'json', title: 'Copy as JSON' },
  { id: 'grid.copyAs.insert', format: 'sql-insert', title: 'Copy as SQL INSERT' },
];

const EXPORTS: { id: string; format: FileFormat; title: string }[] = [
  { id: 'grid.export.csv', format: 'csv', title: 'Export CSV…' },
  { id: 'grid.export.xlsx', format: 'xlsx', title: 'Export Excel (.xlsx)…' },
  { id: 'grid.export.json', format: 'json', title: 'Export JSON…' },
  { id: 'grid.export.sqlInsert', format: 'sql-insert', title: 'Export SQL INSERT…' },
];

export const GRID_COMMANDS: Command<never>[] = [
  {
    id: 'grid.filter', title: 'Filter rows…', category: 'Grid', shortcut: 'Mod+F', scope: 'grid', icon: 'Funnel',
    when: has, run: (a?: unknown) => gridOf(a)?.openFilter(),
  },
  {
    // Mod+Alt+F, not Mod+Shift+F: that is Find in database everywhere, the grid included (components/Search).
    id: 'grid.quickFilterCell', title: 'Quick filter by the focused cell…', category: 'Grid', shortcut: 'Mod+Alt+F', scope: 'grid',
    when: has, run: (a?: unknown) => gridOf(a)?.quickFilterCell(),
  },
  { id: 'grid.clearFilter', title: 'Clear grid filter', category: 'Grid', scope: 'grid', icon: 'FunnelX', when: has, run: (a?: unknown) => gridOf(a)?.clearFilter() },
  {
    id: 'grid.applyServerFilter', title: 'Apply filter on server', category: 'Grid', shortcut: 'Mod+Shift+Enter', scope: 'grid', icon: 'CloudUpload',
    keywords: 'where push down', when: (a?: unknown) => !!gridOf(a)?.applyServerFilter, run: (a?: unknown) => gridOf(a)?.applyServerFilter?.(),
  },
  {
    // Commits an open cell editor first (the value being typed is part of the save), then writes every pending change
    // in one transaction, directly: no SQL dialog unless settings.grid.showSqlBeforeSave (user-02).
    id: 'grid.submitChanges', title: 'Save pending changes', category: 'Data', shortcut: 'Mod+S', scope: 'grid', icon: 'Save',
    keywords: 'save submit commit apply edits', when: pendingOrEditing, run: (a?: unknown) => gridOf(a)?.submit?.(),
  },
  {
    id: 'grid.previewChanges', title: 'Preview SQL of pending changes…', category: 'Data', scope: 'grid', icon: 'FileCode2',
    keywords: 'show sql statements review pending edits',
    when: (a?: unknown) => editable(a) && !!gridOf(a)?.previewChanges && !!gridOf(a)?.hasPending?.(),
    run: async (a?: unknown) => {
      const g = gridOf(a);
      await g?.commitEdit?.();
      g?.previewChanges?.();
    },
  },
  {
    id: 'grid.copyChangesSql', title: 'Copy SQL of pending changes', category: 'Data', scope: 'grid', icon: 'ClipboardCopy',
    keywords: 'copy sql statements pending edits clipboard',
    when: (a?: unknown) => editable(a) && !!gridOf(a)?.copyChangesSql && !!gridOf(a)?.hasPending?.(),
    run: async (a?: unknown) => {
      const g = gridOf(a);
      await g?.commitEdit?.();
      g?.copyChangesSql?.();
    },
  },
  {
    // Mod+S while typing in the in-place editor (rendered in #portal, outside the grid's DOM).
    id: 'grid.submitFromEditor', title: 'Save pending changes', category: 'Data', shortcut: 'Mod+S', scope: 'gridEditor', palette: false,
    when: () => hasOpenEditor() && editable(), run: () => gridOf()?.submit?.(),
  },
  { id: 'grid.undo', title: 'Undo grid edit', category: 'Data', shortcut: 'Mod+Z', scope: 'grid', icon: 'Undo2', when: editable, run: (a?: unknown) => gridOf(a)?.undo?.() },
  {
    id: 'grid.redo', title: 'Redo grid edit', category: 'Data', shortcut: 'Mod+Y', altShortcuts: ['Mod+Shift+Z'], scope: 'grid', icon: 'Redo2',
    when: editable, run: (a?: unknown) => gridOf(a)?.redo?.(),
  },
  {
    id: 'grid.editCell', title: 'Edit cell', category: 'Data', shortcut: 'F2', scope: 'grid', keyHandler: 'host', icon: 'Pencil',
    when: (a?: unknown) => editable(a) && !!gridOf(a)?.editCell, run: (a?: unknown) => gridOf(a)?.editCell?.(),
  },
  // Mod+Alt+N (as in DataGrip), not Mod+0: Ctrl+0 is Reset zoom everywhere, also inside a grid (design-13).
  { id: 'grid.setNull', title: 'Set selected cells to NULL', category: 'Data', shortcut: 'Mod+Alt+N', scope: 'grid', icon: 'Ban', when: editable, run: (a?: unknown) => gridOf(a)?.setNull?.() },
  { id: 'grid.insertRow', title: 'Insert row', category: 'Data', shortcut: 'Insert', scope: 'grid', icon: 'Plus', when: editable, run: (a?: unknown) => gridOf(a)?.insertRow?.() },
  { id: 'grid.deleteRows', title: 'Delete selected rows', category: 'Data', shortcut: 'Delete', scope: 'grid', icon: 'Trash2', when: editable, run: (a?: unknown) => gridOf(a)?.deleteRows?.() },
  {
    id: 'grid.revertAll', title: 'Discard all pending changes', category: 'Data', scope: 'grid', icon: 'Undo2', keywords: 'revert cancel undo edits',
    when: (a?: unknown) => editable(a) && !!gridOf(a)?.hasPending?.(), run: (a?: unknown) => gridOf(a)?.revertAll?.(),
  },
  { id: 'grid.toggleRecordView', title: 'Toggle record view', category: 'Grid', shortcut: 'F7', scope: 'grid', icon: 'Rows3', when: has, run: (a?: unknown) => gridOf(a)?.toggleRecordView?.() },
  {
    id: 'grid.toggleValueViewer', title: 'Toggle value viewer', category: 'Grid', scope: 'grid', icon: 'PanelRight', keywords: 'cell blob json xml text',
    when: (a?: unknown) => !!gridOf(a)?.toggleValueViewer, run: (a?: unknown) => gridOf(a)?.toggleValueViewer?.(),
  },
  {
    id: 'grid.clearSort', title: 'Clear sorting', category: 'Grid', scope: 'grid', keywords: 'order unsort',
    when: (a?: unknown) => !!gridOf(a)?.hasSort?.(), run: (a?: unknown) => gridOf(a)?.clearSort?.(),
  },
  {
    id: 'grid.copyColumnNames', title: 'Copy column names', category: 'Grid', scope: 'grid', icon: 'Columns3',
    when: (a?: unknown) => !!gridOf(a)?.copyColumnNames, run: (a?: unknown) => gridOf(a)?.copyColumnNames?.(),
  },
  ...COPY_FORMATS.map((f): Command<never> => ({
    id: f.id, title: f.title, category: 'Grid', scope: 'grid', icon: 'ClipboardCopy', keywords: 'copy selection clipboard',
    ...(f.shortcut ? { shortcut: f.shortcut } : {}),
    when: (a?: unknown) => !!gridOf(a)?.copyAs, run: (a?: unknown) => gridOf(a)?.copyAs?.(f.format, !!gridArgs(a).all),
  })),
  ...EXPORTS.map((e): Command<never> => ({
    id: e.id, title: e.title, category: 'Grid', scope: 'grid', icon: 'Download', keywords: `export save file download${e.format === 'xlsx' ? ' excel spreadsheet workbook' : ''}`,
    when: (a?: unknown) => !!gridOf(a)?.exportAs, run: (a?: unknown) => gridOf(a)?.exportAs?.(e.format),
  })),
  {
    id: 'grid.loadMore', title: 'Load more rows', category: 'Data', shortcut: 'Mod+End', scope: 'grid', keyHandler: 'host',
    when: (a?: unknown) => !!gridOf(a)?.loadMore, run: (a?: unknown) => gridOf(a)?.loadMore?.(),
  },
  {
    id: 'dataTab.reload', title: 'Reload table data', category: 'Data', shortcut: 'F5', scope: 'dataTab', icon: 'RefreshCw',
    when: (a?: unknown) => !!dataGrid(a)?.refresh, run: (a?: unknown) => dataGrid(a)?.refresh?.(),
  },
  {
    id: 'dataTab.design', title: 'Design table', category: 'Data', shortcut: 'F4', scope: 'dataTab', icon: 'PencilRuler', keywords: 'alter columns designer',
    when: (a?: unknown) => {
      const t = dataTabTarget(a);
      return !!t && isEnabled('designer.edit', t);
    },
    run: (a?: unknown) => {
      const t = dataTabTarget(a);
      if (t) runCommand('designer.edit', t);
    },
  },
  {
    id: 'dataTab.codegen', title: 'Generate code for table', category: 'Data', icon: 'Code2', keywords: 'c# typescript java python dto entity',
    when: (a?: unknown) => {
      const t = dataTabTarget(a);
      return !!t && isEnabled('codegen.open', t);
    },
    run: (a?: unknown) => {
      const t = dataTabTarget(a);
      if (t) runCommand('codegen.open', t);
    },
  },
];

/** The Data tab named by `args.tabId`, or the active tab when it is a Data tab. */
function dataTabOf(args?: unknown): ViewTab | undefined {
  const id = (args && typeof args === 'object' && (args as { tabId?: string }).tabId) || useTabs.getState().activeId;
  const t = useTabs.getState().tabs.find((x) => x.id === id);
  return t?.kind === 'view' && t.view === DATA_VIEW ? t : undefined;
}

function dataGrid(args?: unknown): GridController | undefined {
  const t = dataTabOf(args);
  return t ? gridController(dataGridKey(t.id)) : undefined;
}

/** Explorer-style object target of a Data tab (Design / Generate code dispatch to the owning packages). */
export function dataTabTarget(args?: unknown): ObjectTarget | null {
  const t = dataTabOf(args);
  if (!t?.connectionId) return null;
  const st = (t.state ?? {}) as DataTabState;
  return { kind: 'object', connectionId: t.connectionId, database: t.database, ref: { database: t.database, schema: st.schema, name: st.name, type: st.type ?? 'table' } };
}

export const DATA_COMMANDS: Command<never>[] = [
  {
    id: 'data.open', title: 'Open table data', category: 'Database', shortcut: 'Mod+Alt+D', icon: 'Table2', keywords: 'browse edit rows',
    when: (args?: never) => {
      const t = objectTargetOf(args);
      return !!t && isTabular(t.ref.type, dialectOf(t.connectionId));
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
  void useSessions.getState().close(tab.id, true).catch(() => undefined);
}

export function registerGridCommands(): void {
  // Opened from the explorer / a command: focus lands on the grid canvas (now, or once the first page has loaded),
  // never on the search box (design-15).
  registerTabView(DATA_VIEW, { component: DataTabView, icon: 'Table2', beforeClose, onClosed, focusPrimary: (tab) => focusDataTabPrimary(tab.id) });
  registerCommands([...DATA_COMMANDS, ...GRID_COMMANDS]);
  aliasCommand('dataTab.refresh', 'dataTab.reload');
}

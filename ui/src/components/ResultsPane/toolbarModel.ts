// Toolbar and menu models of the result grid and the Data tab (design-06, PLAN-M1.5 section 3): pure data, every
// entry is a registered command (registered in components/DataTab/commands.ts). The UI builds its Export menu,
// "Copy as" submenu and grid context menu from these lists with commandMenuItems(); commands.test.ts checks them.
import type { ContextEntry } from '../../commands/menuModel';

const c = (command: string, label?: string): ContextEntry => ({ command, ...(label ? { label } : {}) });

/** "Copy selection as" submenu of the grid context menu. */
export const GRID_COPY_AS_MENU: ContextEntry[] = [
  c('grid.copyAs.csv'), c('grid.copyAs.tsv'), c('grid.copyAs.markdown'), c('grid.copyAs.json'), c('grid.copyAs.insert'),
];

/** Toolbar "Export ▾" menu (results pane and Data tab); copy items act on all visible rows (args.all). */
export const GRID_EXPORT_MENU: ContextEntry[] = [
  c('grid.export.csv'), c('grid.export.json'), c('grid.export.sqlInsert'), 'separator',
  c('grid.copyAs.tsv', 'Copy all as TSV'), c('grid.copyAs.csv', 'Copy all as CSV'), c('grid.copyAs.json', 'Copy all as JSON'),
  c('grid.copyAs.markdown', 'Copy all as Markdown'), c('grid.copyAs.insert', 'Copy all as SQL INSERT'),
];

/** Editing group of the grid cell context menu. */
export const GRID_CELL_EDIT_MENU: ContextEntry[] = [c('grid.editCell'), c('grid.setNull'), c('grid.insertRow'), c('grid.deleteRows')];

/**
 * Pending-changes group of the grid cell context menu, shown only while there are pending changes (user-02: saving
 * is direct; the SQL is there when asked for).
 */
export const GRID_CELL_PENDING_MENU: ContextEntry[] = [
  { command: 'grid.submitChanges', hideDisabled: true }, { command: 'grid.previewChanges', hideDisabled: true },
  { command: 'grid.copyChangesSql', hideDisabled: true }, { command: 'grid.revertAll', hideDisabled: true },
];

/** Caret menu of the Save (n) button of the result-set and Data-tab toolbars. */
export const GRID_SAVE_MENU: ContextEntry[] = [c('grid.previewChanges'), c('grid.copyChangesSql'), 'separator', c('grid.revertAll')];

/**
 * "Code ▾" of the result-set toolbar (design-09): codegen.query with the result set's args (QueryCodegenArgs in
 * CodegenPanel/commands.ts: connectionId, database, sql of the originating SELECT, columns, name). Optional: owned by
 * the codegen package; shown only while the result came from a single SELECT.
 */
export const RESULTS_CODE_ENTRY: Extract<ContextEntry, { command: string }> = { command: 'codegen.query', optional: true, hideDisabled: true };

/** Result-set toolbar of a console (left to right). */
export const RESULTS_TOOLBAR: ContextEntry[] = [
  c('grid.filter'), c('grid.clearSort'), c('grid.applyServerFilter'), 'separator',
  c('grid.insertRow'), c('grid.undo'), c('grid.redo'), c('grid.revertAll'), c('grid.submitChanges'), c('grid.previewChanges'), 'separator',
  RESULTS_CODE_ENTRY, c('grid.export.csv'), c('grid.export.json'), c('grid.export.sqlInsert'), c('grid.toggleRecordView'), c('grid.toggleValueViewer'),
  c('grid.copyColumnNames'),
];

/** Data tab toolbar (left to right). */
export const DATATAB_TOOLBAR: ContextEntry[] = [
  c('dataTab.reload'), c('grid.filter'), c('grid.clearSort'), 'separator',
  c('grid.insertRow'), c('grid.undo'), c('grid.redo'), c('grid.revertAll'), c('grid.submitChanges'), c('grid.previewChanges'), 'separator',
  c('grid.export.csv'), c('grid.export.json'), c('grid.export.sqlInsert'), c('dataTab.codegen'), c('dataTab.design'),
  c('grid.toggleRecordView'),
];

// The results/data grid (glide-data-grid): client filter + sort view, in-place editing with a pending buffer,
// quick filters from cells, FK navigation markers. Used by console result sets and Data tabs.
import {
  CompactSelection, DataEditor, GridCellKind, GridColumnIcon, type DataEditorRef, type DrawCellCallback, type EditableGridCell,
  type GridCell, type GridColumn, type GridSelection, type Item, type Theme,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellValue, ColumnInfo, ColumnKind, Dialect } from '../../api/types';
import { copyText } from '../../app/actions';
import { compileFilter, computeView } from '../../filter/evaluate';
import { appendAnd, type FilterGroup, type GridViewModel, type SortKey } from '../../filter/model';
import { formatCell, isBinary, isNumericKind, isTruncated, rawText } from '../../lib/format';
import { COPY_FORMAT_LABELS, serializeRows, type CopyFormat } from '../../lib/serialize';
import { editedValue, sameValue, useEditBuffer, useEdits, type PendingInsert } from '../../store/edits';
import { useSettings } from '../../store/settings';
import { makeGridTheme } from '../../theme/gridTheme';
import type { EffectiveTheme } from '../../theme/useTheme';
import { showContextMenu, type MenuItem } from '../common/Menu';
import { cellColors } from './cellColors';
import { registerGridController, setActiveGridKey, type GridController } from './controller';
import type { Editability, FkLink } from './editability';
import { editText, isEditableKind, parseEdit } from './editValue';
import { hiddenPredicate, overlayRows, type OverlayRows } from './overlay';
import { cellEqualsCondition, quickFilterOptions } from './quickFilter';
import './grid.css';

/** A row of the grid: a source row (base or appended) or a pending insert. */
export type RowRef = { src: number; ins?: undefined } | { ins: PendingInsert; src?: undefined };

export interface GridSelectionInfo {
  /** Source row (null for a pending insert). */
  sourceRow: number | null;
  insertId: string | null;
  col: number;
  /** Visible row index. */
  row: number;
}

export interface DataGridProps {
  gridKey: string;
  columns: ColumnInfo[];
  rows: { length: number; get(i: number): CellValue[] | undefined };
  /** Bumped when rows change (streaming / paging). */
  rev: number;
  done: boolean;
  view: GridViewModel;
  onViewChange(v: Partial<GridViewModel>): void;
  /** Sorting happens on the server: header clicks only report the new sort. */
  serverSort?: { sort: SortKey[]; onSortChange(sort: SortKey[]): void };
  /** The view's filter/quick text is applied by the server (Data tab): the grid does not evaluate it again. */
  serverFiltered?: boolean;
  /** Extra client-side filter (regex remainder of a server filter). */
  extraFilter?: FilterGroup | null;
  editability?: Editability | null;
  fks?: FkLink[];
  onNavigateFk?(fk: FkLink, values: CellValue[]): void;
  dialect: Dialect;
  theme: EffectiveTheme;
  nullText: string;
  dateFormat: 'iso' | 'locale';
  onSelectCell?(sel: GridSelectionInfo | null): void;
  onOpenViewer?(sel: GridSelectionInfo): void;
  onRowCount?(n: number): void;
  onOpenFilter?(column?: string): void;
  onReachEnd?(): void;
  onSubmit?(): void;
  onToggleRecord?(): void;
  /** Header menu "Show only distinct values…". */
  onShowDistinct?(col: number, pos: { clientX: number; clientY: number }): void;
  /** Extra items for the cell context menu (export, …). */
  extraCellMenu?: MenuItem[];
  /** Extra controller methods (server filter, refresh). */
  controllerExtras?: Partial<GridController>;
}

function headerIcon(c: ColumnInfo, fk: boolean): GridColumnIcon {
  if (c.isKey) return GridColumnIcon.HeaderRowID;
  if (fk) return GridColumnIcon.HeaderReference;
  switch (c.kind) {
    case 'int': case 'float': case 'decimal': return GridColumnIcon.HeaderNumber;
    case 'bool': return GridColumnIcon.HeaderBoolean;
    case 'date': case 'datetime': case 'datetimeoffset': return GridColumnIcon.HeaderDate;
    case 'time': return GridColumnIcon.HeaderTime;
    case 'json': case 'xml': return GridColumnIcon.HeaderCode;
    case 'binary': return GridColumnIcon.HeaderArray;
    default: return GridColumnIcon.HeaderString;
  }
}

const KIND_MIN: Partial<Record<ColumnKind, number>> = { bool: 64, int: 70, date: 100, datetime: 170, datetimeoffset: 200, guid: 290 };

function estimateWidth(c: ColumnInfo, rows: OverlayRows, opts: { nullText: string; dateFormat: 'iso' | 'locale' }): number {
  let maxLen = c.name.length + 4;
  const n = Math.min(rows.length, 200);
  for (let i = 0; i < n; i++) {
    const t = formatCell(rows.get(i)?.[c.ordinal] ?? null, c, opts);
    if (t.length > maxLen) maxLen = t.length;
  }
  const px = Math.round(maxLen * 7.1 + 28);
  return Math.max(KIND_MIN[c.kind] ?? 60, Math.min(px, 420));
}

/** Recompute the sort/filter index at most every `ms` while rows are streaming in. */
function useThrottledRev(rev: number, done: boolean, ms = 400): number {
  const [v, setV] = useState(rev);
  const last = useRef(0);
  useEffect(() => {
    if (done) {
      setV(rev);
      return;
    }
    const wait = Math.max(0, ms - (Date.now() - last.current));
    const t = setTimeout(() => {
      last.current = Date.now();
      setV(rev);
    }, wait);
    return () => clearTimeout(t);
  }, [rev, done, ms]);
  return v;
}

const NO_SORT: SortKey[] = [];

export function DataGrid(p: DataGridProps) {
  const { gridKey, columns, rows, view, dialect, theme, nullText, dateFormat, editability, fks = [] } = p;
  const ref = useRef<DataEditorRef>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  /** glide's click args carry no altKey: remember it from the pointer event (Alt+click = filter by cell). */
  const altDown = useRef(false);
  const reachedFor = useRef(-1);
  const buffer = useEditBuffer(gridKey);
  const edits = useEdits;
  const fmt = useMemo(() => ({ nullText, dateFormat }), [nullText, dateFormat]);
  const gridTheme = useMemo<Partial<Theme>>(() => makeGridTheme(theme), [theme]);
  const colors = useMemo(() => cellColors(theme), [theme]);
  const nullColor = gridTheme.textLight ?? 'gray';
  const mutedColor = gridTheme.textMedium ?? 'gray';
  const editable = !!editability?.editable;
  const density = useSettings((st) => st.settings.grid?.density ?? 'comfortable');
  const pending = buffer.pending;

  const overlay = useMemo(() => overlayRows(rows, buffer.committed), [rows, p.rev, buffer.committed]); // eslint-disable-line react-hooks/exhaustive-deps
  const sort = p.serverSort ? NO_SORT : view.sort;
  const extraPred = useMemo(() => compileFilter(p.extraFilter ?? null, columns), [p.extraFilter, columns]);
  const hidden = hiddenPredicate(buffer.committed);
  const clientView = p.serverFiltered ? { quickFilter: '', filter: null } : view;
  const hasView = !!(clientView.quickFilter || clientView.filter || sort.length || extraPred || hidden);
  const throttledRev = useThrottledRev(p.rev, p.done);
  const index = useMemo(
    () => (hasView ? computeView(overlay, columns, { ...clientView, sort }, { hidden, extraPredicate: extraPred }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasView, clientView.quickFilter, clientView.filter, sort, overlay, columns, extraPred, buffer.committed, hasView ? throttledRev : 0],
  );
  const viewLen = index ? index.length : overlay.length;
  const inserts = pending.inserts;
  const rowCount = viewLen + inserts.length;
  const onRowCount = p.onRowCount;
  useEffect(() => onRowCount?.(viewLen), [viewLen, onRowCount]);

  const rowRef = useCallback(
    (row: number): RowRef | null => {
      if (row < viewLen) return { src: index ? index[row] : row };
      const ins = inserts[row - viewLen];
      return ins ? { ins } : null;
    },
    [index, viewLen, inserts],
  );

  const valueAt = useCallback(
    (r: RowRef, col: number): CellValue => {
      if (r.ins) return r.ins.values[col] ?? null;
      const e = editedValue(pending, r.src, col);
      if (e !== undefined) return e;
      return overlay.get(r.src)?.[col] ?? null;
    },
    [pending, overlay],
  );

  const fkByCol = useMemo(() => {
    const m = new Map<number, FkLink>();
    for (const fk of fks) for (const o of fk.ordinals) if (!m.has(o)) m.set(o, fk);
    return m;
  }, [fks]);

  // ---------------------------------------------------------------- columns
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [autoWidths, setAutoWidths] = useState<Record<number, number> | null>(null);
  useEffect(() => {
    if (autoWidths && Object.keys(autoWidths).length === columns.length) return;
    if (overlay.length === 0 && !p.done) return;
    const w: Record<number, number> = {};
    columns.forEach((c, i) => (w[i] = estimateWidth({ ...c, ordinal: i }, overlay, fmt)));
    setAutoWidths(w);
  }, [overlay, overlay.length, p.done, columns, autoWidths, fmt]);
  useEffect(() => setAutoWidths(null), [columns]);

  const shownSort = p.serverSort ? p.serverSort.sort : view.sort;
  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columns.map((c, i) => {
        const s = shownSort.find((k) => k.column === i);
        const arrow = s ? (s.dir === 'asc' ? ' ↑' : ' ↓') : '';
        const order = s && shownSort.length > 1 ? `${shownSort.indexOf(s) + 1}` : '';
        return {
          id: String(i),
          title: `${c.name || `column${i + 1}`}${arrow}${order}`,
          width: widths[i] ?? autoWidths?.[i] ?? 140,
          icon: headerIcon(c, fkByCol.has(i)),
          hasMenu: false,
        };
      }),
    [columns, shownSort, widths, autoWidths, fkByCol],
  );

  // ---------------------------------------------------------------- cells
  const canEditCell = useCallback(
    (r: RowRef, col: number) => {
      if (!editable || !editability) return false;
      const c = columns[col];
      if (!c || !isEditableKind(c)) return false;
      if (r.ins) return editability.editableColumns.has(col);
      if (pending.deletes[r.src]) return false;
      return editability.editableColumns.has(col);
    },
    [editable, editability, columns, pending.deletes],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const r = rowRef(row);
      const c = columns[col];
      const align = c && isNumericKind(c.kind) ? 'right' : 'left';
      if (!r || !c) return { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false, readonly: true };
      const v = valueAt(r, col);
      const canEdit = canEditCell(r, col);
      const isEdited = r.ins ? !!r.ins.touched[col] : editedValue(pending, r.src, col) !== undefined;
      const editedTheme = isEdited && !r.ins ? { bgCell: colors.edited } : undefined;
      if (r.ins && !r.ins.touched[col]) {
        const identity = editability?.target?.identityColumns?.some((x) => x.toLowerCase() === c.name.toLowerCase());
        return {
          kind: GridCellKind.Text, data: '', displayData: identity ? '(auto)' : 'DEFAULT', allowOverlay: canEdit, readonly: !canEdit,
          contentAlign: align, copyData: '', themeOverride: { textDark: nullColor, baseFontStyle: 'italic 12px' },
        };
      }
      if (c.kind === 'bool' && (v === null || typeof v === 'boolean' || typeof v === 'number') && (canEdit || v !== null)) {
        return {
          kind: GridCellKind.Boolean, data: v === null ? null : !!v, allowOverlay: false, readonly: !canEdit, copyData: v === null ? '' : String(!!v),
          contentAlign: 'center', themeOverride: editedTheme,
        };
      }
      if (v === null || v === undefined) {
        return {
          kind: GridCellKind.Text, data: '', displayData: nullText, allowOverlay: canEdit, readonly: !canEdit, contentAlign: align,
          copyData: '', themeOverride: { textDark: nullColor, baseFontStyle: 'italic 12px', ...editedTheme },
        };
      }
      if (typeof v === 'boolean') {
        return { kind: GridCellKind.Boolean, data: v, allowOverlay: false, readonly: true, copyData: String(v), contentAlign: 'center' };
      }
      const text = formatCell(v, c, fmt);
      const muted = isBinary(v) || isTruncated(v) || typeof v === 'object';
      return {
        kind: GridCellKind.Text, data: canEdit ? editText(v) : text, displayData: text, allowOverlay: canEdit, readonly: !canEdit, contentAlign: align,
        copyData: rawText(v) ?? '',
        // FK cells keep room on the right for the navigation chevron
        themeOverride: { ...(muted ? { textDark: mutedColor } : {}), ...editedTheme, ...(fkByCol.has(col) ? { cellHorizontalPadding: 16 } : {}) },
      };
    },
    [rowRef, columns, valueAt, canEditCell, pending, colors, editability, nullColor, nullText, fmt, mutedColor, fkByCol],
  );

  const getRowThemeOverride = useCallback(
    (row: number): Partial<Theme> | undefined => {
      const r = rowRef(row);
      if (!r) return undefined;
      if (r.ins) return { bgCell: colors.inserted };
      if (pending.deletes[r.src]) return { bgCell: colors.deleted, textDark: colors.deletedText };
      return undefined;
    },
    [rowRef, colors, pending.deletes],
  );

  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      drawContent();
      const { ctx, rect, col, row } = args;
      const r = rowRef(row);
      if (!r) return;
      // glide caches canvas state between cells: never leak our styles into the next cell
      ctx.save();
      try {
        decorate(r);
      } finally {
        ctx.restore();
      }
      function decorate(r: RowRef) {
      const edited = r.ins ? false : editedValue(pending, r.src, col) !== undefined;
      if (edited) {
        ctx.fillStyle = colors.editedBar;
        ctx.fillRect(rect.x, rect.y + 1, 3, rect.height - 2);
      }
      if (r.ins && col === 0) {
        ctx.fillStyle = colors.link;
        ctx.fillRect(rect.x, rect.y + 1, 3, rect.height - 2);
      }
      if (!r.ins && pending.deletes[r.src]) {
        ctx.strokeStyle = colors.deletedText;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const y = Math.round(rect.y + rect.height / 2) + 0.5;
        ctx.moveTo(rect.x + 4, y);
        ctx.lineTo(rect.x + rect.width - 4, y);
        ctx.stroke();
      }
      if (fkByCol.has(col) && valueAt(r, col) !== null) {
        // small "go to" chevron at the right edge of FK cells
        const x = rect.x + rect.width - 9;
        const y = rect.y + rect.height / 2;
        ctx.strokeStyle = colors.link;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 3, y - 3);
        ctx.lineTo(x + 1, y);
        ctx.lineTo(x - 3, y + 3);
        ctx.stroke();
      }
      }
    },
    [rowRef, pending, colors, fkByCol, valueAt],
  );

  // ---------------------------------------------------------------- selection
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  useEffect(() => {
    setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  }, [gridKey]);

  const selInfo = (col: number, row: number): GridSelectionInfo => {
    const r = rowRef(row);
    return { sourceRow: r?.src ?? null, insertId: r?.ins?.id ?? null, col, row };
  };

  /** Visible rows covered by the selection (row selection, column selection or cell range). */
  const selectedRows = (): number[] => {
    if (selection.rows.length) return selection.rows.toArray();
    const range = selection.current?.range;
    if (!range) return [];
    return Array.from({ length: range.height }, (_, i) => range.y + i);
  };

  const setView = p.onViewChange;

  const toggleSort = (col: number, additive: boolean) => {
    const cur = shownSort.find((s) => s.column === col);
    let next = additive ? shownSort.filter((s) => s.column !== col) : [];
    if (!cur) next = [...next, { column: col, dir: 'asc' }];
    else if (cur.dir === 'asc') next = [...next, { column: col, dir: 'desc' }];
    if (p.serverSort) p.serverSort.onSortChange(next);
    else setView({ sort: next });
  };
  const setSort = (next: SortKey[]) => (p.serverSort ? p.serverSort.onSortChange(next) : setView({ sort: next }));

  const block = (): { rows: CellValue[][]; columns: ColumnInfo[] } => {
    const all = columns.map((c, i) => ({ ...c, ordinal: i }));
    const rowsOf = (list: number[], cols: number[]) =>
      list.map((vr) => rowRef(vr)).filter((r): r is RowRef => !!r).map((r) => cols.map((c) => valueAt(r, c)));
    if (selection.rows.length > 0) return { rows: rowsOf(selection.rows.toArray(), all.map((_, i) => i)), columns: all };
    if (selection.columns.length > 0) {
      const cols = selection.columns.toArray();
      return { rows: rowsOf(Array.from({ length: rowCount }, (_, i) => i), cols), columns: cols.map((c) => all[c]) };
    }
    const range = selection.current?.range;
    if (!range) return { rows: [], columns: all };
    const cols = Array.from({ length: range.width }, (_, i) => range.x + i);
    return { rows: rowsOf(Array.from({ length: range.height }, (_, i) => range.y + i), cols), columns: cols.map((c) => all[c]) };
  };

  const copyAs = (format: CopyFormat) => {
    const b = block();
    if (b.rows.length === 0) return;
    void copyText(serializeRows(format, b.columns, b.rows, { dialect, header: format !== 'tsv' || b.rows.length > 1 || b.columns.length > 1 }),
      `Copied ${b.rows.length} row${b.rows.length === 1 ? '' : 's'} as ${COPY_FORMAT_LABELS[format]}`);
  };

  const addCondition = (cond: ReturnType<typeof cellEqualsCondition>) => {
    setView({ filter: appendAnd(view.filter, cond) });
    p.onOpenFilter?.();
  };

  // ---------------------------------------------------------------- editing
  const setValue = useCallback(
    (r: RowRef, col: number, value: CellValue) => {
      if (r.ins) edits.getState().setInsertCell(gridKey, r.ins.id, col, value);
      else edits.getState().setCell(gridKey, r.src, col, value, overlay.get(r.src)?.[col] ?? null);
    },
    [edits, gridKey, overlay],
  );

  const onCellEdited = ([col, row]: Item, nv: EditableGridCell) => {
    const r = rowRef(row);
    if (!r || !canEditCell(r, col)) return;
    if (nv.kind === GridCellKind.Boolean) {
      setValue(r, col, nv.data === undefined ? null : nv.data);
      return;
    }
    if (nv.kind !== GridCellKind.Text) return;
    const parsed = parseEdit(nv.data, columns[col], dialect);
    if (parsed.ok) setValue(r, col, parsed.value);
  };

  const validateCell = ([col]: Item, nv: EditableGridCell) => {
    if (nv.kind !== GridCellKind.Text) return true;
    return parseEdit(nv.data, columns[col], dialect).ok;
  };

  const setNullOnSelection = () => {
    if (!editable) return;
    const range = selection.current?.range;
    if (!range) return;
    for (let y = range.y; y < range.y + range.height; y++) {
      const r = rowRef(y);
      if (!r) continue;
      for (let x = range.x; x < range.x + range.width; x++) {
        if (!canEditCell(r, x)) continue;
        if (!columns[x].nullable && !r.ins) continue;
        setValue(r, x, null);
      }
    }
  };

  const insertRow = () => {
    if (!editable) return;
    edits.getState().addInsert(gridKey, columns.length);
    setTimeout(() => {
      const target = rowCount; // the new last row
      const firstEditable = columns.findIndex((_, i) => editability?.editableColumns.has(i) && !editability.target?.identityColumns?.includes(columns[i].name));
      const col = Math.max(0, firstEditable);
      ref.current?.scrollTo(col, target);
      setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: { cell: [col, target], range: { x: col, y: target, width: 1, height: 1 }, rangeStack: [] } });
    }, 0);
  };

  const deleteSelectedRows = (rowsToDelete = selectedRows()) => {
    if (!editable || rowsToDelete.length === 0) return;
    const src: number[] = [];
    for (const vr of rowsToDelete) {
      const r = rowRef(vr);
      if (!r) continue;
      if (r.ins) edits.getState().removeInsert(gridKey, r.ins.id);
      else src.push(r.src);
    }
    edits.getState().toggleDelete(gridKey, src);
  };

  // ---------------------------------------------------------------- menus
  const filterSubmenu = (col: number, v: CellValue): MenuItem[] => [
    ...quickFilterOptions(columns[col], col, v).map((o) => ({ label: o.label, onClick: () => addCondition(o.make()) })),
    { separator: true },
    { label: 'Clear filter', disabled: !view.filter && !view.quickFilter, onClick: () => setView({ filter: null, quickFilter: '' }) },
  ];

  const cellMenu = (col: number, row: number, pos: { clientX: number; clientY: number }) => {
    const r = rowRef(row);
    if (!r) return;
    const v = valueAt(r, col);
    const fk = fkByCol.get(col);
    const items: MenuItem[] = [
      { label: 'Copy value', shortcut: 'Ctrl+C', onClick: () => void copyText(rawText(v) ?? '') },
      { label: 'Copy selection as', submenu: (Object.keys(COPY_FORMAT_LABELS) as CopyFormat[]).map((f) => ({ label: COPY_FORMAT_LABELS[f], onClick: () => copyAs(f) })) },
      { label: 'View value', onClick: () => p.onOpenViewer?.(selInfo(col, row)) },
      { separator: true },
      { label: 'Filter', shortcut: 'Ctrl+Shift+F', submenu: filterSubmenu(col, v) },
    ];
    if (fk && v !== null && r.src !== undefined && p.onNavigateFk) {
      items.push({ label: `Go to referenced row (${fk.refTable})`, shortcut: 'Ctrl+Click', onClick: () => p.onNavigateFk!(fk, fk.ordinals.map((o) => valueAt(r, o))) });
    }
    if (editable) {
      const canEdit = canEditCell(r, col);
      items.push(
        { separator: true },
        { label: 'Edit cell', shortcut: 'F2', disabled: !canEdit, onClick: () => ref.current?.focus() },
        { label: 'Set to NULL', shortcut: 'Ctrl+0', disabled: !canEdit || (!columns[col].nullable && !r.ins), onClick: () => setValue(r, col, null) },
        { label: 'Insert row', shortcut: 'Insert', onClick: insertRow },
        { label: r.src !== undefined && pending.deletes[r.src] ? 'Restore row' : 'Delete row', shortcut: 'Delete', onClick: () => deleteSelectedRows() },
        {
          label: 'Revert row', disabled: r.ins !== undefined || !(r.src !== undefined && (pending.updates[r.src] || pending.deletes[r.src])),
          onClick: () => r.src !== undefined && edits.getState().revertRow(gridKey, r.src),
        },
      );
    }
    if (p.extraCellMenu?.length) items.push({ separator: true }, ...p.extraCellMenu);
    showContextMenu(pos, items);
  };

  const headerMenu = (col: number, pos: { clientX: number; clientY: number }) => {
    const c = columns[col];
    showContextMenu(pos, [
      { label: 'Sort ascending', onClick: () => setSort([{ column: col, dir: 'asc' }]) },
      { label: 'Sort descending', onClick: () => setSort([{ column: col, dir: 'desc' }]) },
      { label: 'Clear sort', disabled: shownSort.length === 0, onClick: () => setSort([]) },
      { separator: true },
      { label: 'Filter column…', onClick: () => p.onOpenFilter?.(c.name) },
      { label: 'Show only distinct values…', disabled: !p.onShowDistinct, onClick: () => p.onShowDistinct?.(col, pos) },
      { separator: true },
      { label: 'Copy column name', onClick: () => void copyText(c.name) },
      { label: 'Reset column widths', onClick: () => setWidths({}) },
      { separator: true },
      { label: `${c.dbType}${c.nullable ? '' : ' NOT NULL'}${c.table ? ` · ${c.schema ? `${c.schema}.` : ''}${c.table}` : ''}`, disabled: true },
    ]);
  };

  const quickFilterAtCell = () => {
    const cell = selection.current?.cell;
    if (!cell) return;
    const [col, row] = cell;
    const r = rowRef(row);
    if (!r) return;
    const b = ref.current?.getBounds(col, row);
    const pos = b ? { clientX: b.x + 8, clientY: b.y + b.height } : { clientX: 200, clientY: 200 };
    showContextMenu(pos, filterSubmenu(col, valueAt(r, col)));
  };

  // ---------------------------------------------------------------- controller (commands)
  const latest = useRef({ quickFilterAtCell, setNullOnSelection, insertRow, deleteSelectedRows, p, editable, buffer });
  latest.current = { quickFilterAtCell, setNullOnSelection, insertRow, deleteSelectedRows, p, editable, buffer };
  useEffect(() => {
    const L = () => latest.current;
    return registerGridController({
      key: gridKey,
      get editable() {
        return L().editable;
      },
      openFilter: (column) => L().p.onOpenFilter?.(column),
      quickFilterCell: () => L().quickFilterAtCell(),
      clearFilter: () => L().p.onViewChange({ filter: null, quickFilter: '' }),
      submit: () => L().p.onSubmit?.(),
      undo: () => useEdits.getState().undo(gridKey),
      redo: () => useEdits.getState().redo(gridKey),
      setNull: () => L().setNullOnSelection(),
      insertRow: () => L().insertRow(),
      deleteRows: () => L().deleteSelectedRows(),
      revertAll: () => useEdits.getState().revertAll(gridKey),
      toggleRecordView: () => L().p.onToggleRecord?.(),
      loadMore: () => L().p.onReachEnd?.(),
      hasPending: () => Object.keys(L().buffer.pending.updates).length + L().buffer.pending.inserts.length + Object.keys(L().buffer.pending.deletes).length > 0,
      ...L().p.controllerExtras,
    } as GridController);
  }, [gridKey]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.shiftKey && k === 'c') {
      e.preventDefault();
      copyAs('csv');
    } else if (ctrl && e.shiftKey && k === 'f') {
      e.preventDefault();
      quickFilterAtCell();
    } else if (ctrl && !e.shiftKey && k === 'f') {
      e.preventDefault();
      p.onOpenFilter?.();
    } else if (e.key === 'F7') {
      e.preventDefault();
      p.onToggleRecord?.();
    } else if (ctrl && k === 's' && p.onSubmit) {
      e.preventDefault();
      p.onSubmit();
    } else if (editable && ctrl && !e.shiftKey && k === 'z') {
      e.preventDefault();
      useEdits.getState().undo(gridKey);
    } else if (editable && ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) {
      e.preventDefault();
      useEdits.getState().redo(gridKey);
    } else if (editable && ctrl && k === '0') {
      e.preventDefault();
      setNullOnSelection();
    } else if (editable && e.key === 'Insert') {
      e.preventDefault();
      insertRow();
    } else if (ctrl && e.key === 'End') {
      p.onReachEnd?.();
    }
  };

  return (
    <div
      ref={hostRef}
      className="grid-host"
      data-command-scope="grid"
      data-editable={editable || undefined}
      onFocusCapture={() => setActiveGridKey(gridKey)}
      onPointerDownCapture={(e) => (altDown.current = e.altKey)}
      onKeyDown={onKeyDown}
    >
      <DataEditor
        ref={ref}
        columns={gridColumns}
        rows={rowCount}
        getCellContent={getCellContent}
        getRowThemeOverride={getRowThemeOverride}
        drawCell={drawCell}
        theme={gridTheme}
        width="100%"
        height="100%"
        rowMarkers={{ kind: 'clickable-number', width: Math.max(44, String(rowCount).length * 8 + 20) }}
        rowHeight={density === 'compact' ? 24 : 28}
        headerHeight={28}
        smoothScrollX
        smoothScrollY
        getCellsForSelection
        rangeSelect="rect"
        columnSelect="multi"
        rowSelect="multi"
        gridSelection={selection}
        onGridSelectionChange={(s) => {
          setSelection(s);
          const cell = s.current?.cell;
          p.onSelectCell?.(cell ? selInfo(cell[0], cell[1]) : null);
        }}
        onColumnResize={(_c, w, colIndex) => setWidths((prev) => ({ ...prev, [colIndex]: w }))}
        onHeaderClicked={(col, ev) => {
          ev.preventDefault();
          toggleSort(col, ev.shiftKey);
        }}
        onHeaderContextMenu={(col, ev) => {
          ev.preventDefault();
          headerMenu(col, { clientX: ev.bounds.x + ev.localEventX, clientY: ev.bounds.y + ev.localEventY });
        }}
        onCellContextMenu={([col, row], ev) => {
          ev.preventDefault();
          const inRange = selection.current?.range;
          const inside = inRange && col >= inRange.x && col < inRange.x + inRange.width && row >= inRange.y && row < inRange.y + inRange.height;
          if (!inside && !selection.rows.hasIndex(row)) {
            setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] } });
          }
          cellMenu(col, row, { clientX: ev.bounds.x + ev.localEventX, clientY: ev.bounds.y + ev.localEventY });
        }}
        onCellClicked={([col, row], ev) => {
          const r = rowRef(row);
          if (!r) return;
          if (altDown.current) {
            ev.preventDefault();
            addCondition(cellEqualsCondition(columns[col], col, valueAt(r, col)));
            return;
          }
          const fk = fkByCol.get(col);
          if ((ev.ctrlKey || ev.metaKey) && fk && p.onNavigateFk && valueAt(r, col) !== null) {
            ev.preventDefault();
            p.onNavigateFk(fk, fk.ordinals.map((o) => valueAt(r, o)));
          }
        }}
        onCellActivated={([col, row]) => {
          const r = rowRef(row);
          if (r && !canEditCell(r, col)) p.onOpenViewer?.(selInfo(col, row));
        }}
        onCellEdited={onCellEdited}
        validateCell={validateCell}
        onPaste={editable}
        onDelete={(sel) => {
          if (!editable) return false;
          const list = sel.rows.length ? sel.rows.toArray() : sel.current ? Array.from({ length: sel.current.range.height }, (_, i) => sel.current!.range.y + i) : [];
          deleteSelectedRows(list);
          return false;
        }}
        trailingRowOptions={editable ? { hint: 'New', sticky: false, tint: true } : undefined}
        onRowAppended={editable ? () => {
          edits.getState().addInsert(gridKey, columns.length);
          return undefined;
        } : undefined}
        onVisibleRegionChanged={(range) => {
          // Auto "load more" once per row count, and not while new rows sit at the bottom (they keep the view there).
          if (!p.onReachEnd || !p.done || inserts.length > 0 || viewLen === 0 || reachedFor.current === viewLen) return;
          if (range.y + range.height >= viewLen - 5) {
            reachedFor.current = viewLen;
            p.onReachEnd();
          }
        }}
        verticalBorder
        maxColumnAutoWidth={500}
        maxColumnWidth={2000}
        minColumnWidth={40}
        scaleToRem={false}
      />
    </div>
  );
}

/** Value of a row ref for consumers outside the grid (record view, viewer). */
export function rowValue(overlay: OverlayRows, pendingUpdates: Record<number, Record<number, CellValue>>, r: RowRef, col: number): CellValue {
  if (r.ins) return r.ins.values[col] ?? null;
  const e = pendingUpdates[r.src];
  if (e && col in e) return e[col];
  return overlay.get(r.src)?.[col] ?? null;
}

export { sameValue };

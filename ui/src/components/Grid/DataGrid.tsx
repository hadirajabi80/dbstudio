// The results/data grid (glide-data-grid): client filter + sort view, in-place editing with a pending buffer,
// quick filters from cells, FK navigation markers. Used by console result sets and Data tabs.
import {
  CompactSelection, DataEditor, GridCellKind, GridColumnIcon, drawTextCell, type DataEditorRef, type DrawCellCallback, type EditableGridCell,
  type GridCell, type GridColumn, type GridMouseEventArgs, type GridSelection, type Item, type Theme,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { CellValue, ColumnInfo, Dialect } from '../../api/types';
import { copyText } from '../../app/actions';
import { displayShortcut } from '../../commands/keys';
import { compileFilter, computeView } from '../../filter/evaluate';
import { appendAnd, type FilterGroup, type GridViewModel, type SortKey } from '../../filter/model';
import { base64ToHex, formatCell, isBinary, isNumericKind, isPartial, isTruncated, rawText } from '../../lib/format';
import { COPY_FORMAT_LABELS, serializeComplete, type CellFetcher, type CellLocator, type CopyFormat } from '../../lib/serialize';
import { editedValue, sameValue, useEditBuffer, useEdits, type CellEdit, type PendingInsert } from '../../store/edits';
import { useSettings } from '../../store/settings';
import { toast } from '../../store/ui';
import { makeGridTheme } from '../../theme/gridTheme';
import type { EffectiveTheme } from '../../theme/useTheme';
import { isHidden } from '../common/focus';
import { pluralize } from '../common/text';
import { showContextMenu, type MenuItem } from '../common/Menu';
import { commandMenuItems } from '../layout/commandMenu';
import { GRID_CELL_EDIT_MENU, GRID_CELL_PENDING_MENU, GRID_COPY_AS_MENU, GRID_EXPORT_MENU } from '../ResultsPane/toolbarModel';
import { aggregateCells, type SelectionAggregates } from './aggregate';
import { cellColors } from './cellColors';
import { exportRowsToFile, type FileFormat } from './clientExport';
import { canvasMeasure, distributeSpare, ellipsize, naturalWidths, type ColumnWidth } from './columnWidth';
import { registerGridController, setActiveGridKey, type GridController } from './controller';
import type { Editability, FkLink } from './editability';
import { editText, isEditableKind, parseEdit } from './editValue';
import { attachOverlayEditorSupport, commitOpenEditor, hasOpenEditor } from './overlayEditor';
import { hiddenPredicate, overlayRows } from './overlay';
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
  /** Extra controller methods (server filter, refresh, export). */
  controllerExtras?: Partial<GridController>;
  /**
   * Where a source row's cells live in the engine result store (full values of truncated cells for copy). null when
   * the row did not come from a stored result (submitted edits, appended rows).
   */
  cellSource?(sourceRow: number, col: number): CellLocator | null;
  /** Fetches a full cell value (default GET /executions/{xid}/resultsets/{rs}/cell). */
  fetchCell?: CellFetcher;
  /** Count / Sum / Avg / Min / Max of a multi-cell selection (null when fewer than 2 cells are selected). */
  onAggregates?(agg: SelectionAggregates | null): void;
  /** Hide the trailing "+ New" row (e.g. while a filter matches nothing and an empty-state message is shown). */
  hideTrailingRow?: boolean;
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

/**
 * Same column list (identity, or the same names and types: a Data tab's next page brings an equal but new array, and
 * the measured widths must not jump while scrolling).
 */
export function sameColumns(a: readonly ColumnInfo[], b: readonly ColumnInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((c, i) => c.name === b[i].name && c.kind === b[i].kind && c.dbType === b[i].dbType);
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

/** Size of an element, tracked with a ResizeObserver (null until measured). */
function useElementSize(ref: React.RefObject<HTMLElement>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setSize((s) => (s && Math.abs(s.width - r.width) < 1 && Math.abs(s.height - r.height) < 1 ? s : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const NO_SORT: SortKey[] = [];
const KEYBINDINGS = { activateCell: ' |Enter|shift+Enter|F2' };
/** Width of the FK chevron hit area at the right edge of a cell. */
const FK_HIT = 18;
const MAX_AGG_CELLS = 2_000_000;
const defaultFetch: CellFetcher = (l) => api.cell(l.executionId, l.resultSetId, l.row, l.col);

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
  const trailing = editable && !p.hideTrailingRow;
  const density = useSettings((st) => st.settings.grid?.density ?? 'comfortable');
  const rowHeight = density === 'compact' ? 24 : 28;
  const headerHeight = 28;
  const pending = buffer.pending;
  /** Rows a failed save reported (error or conflict), by source row index or insert id: outlined in red (user-02). */
  const issues = useMemo(() => new Map(buffer.issues.map((i) => [i.ref, i])), [buffer.issues]);
  const size = useElementSize(hostRef);
  const [hoverRow, setHoverRow] = useState(-1);

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

  // A failed save marks the row it stopped at: bring that row into view (the toast says what went wrong).
  useEffect(() => {
    const first = buffer.issues[0];
    if (!first) return;
    let row = -1;
    if (/^\d+$/.test(first.ref)) {
      const src = Number(first.ref);
      row = index ? index.indexOf(src) : src < viewLen ? src : -1;
    } else {
      const i = inserts.findIndex((x) => x.id === first.ref);
      if (i >= 0) row = viewLen + i;
    }
    if (row >= 0) ref.current?.scrollTo(0, row, 'vertical');
  }, [buffer.issues]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Overlay editor: Mod+S routing through the portal, commit before modals, commit on theme switch (styles-19).
  useEffect(() => attachOverlayEditorSupport(), []);
  const firstTheme = useRef(true);
  useEffect(() => {
    if (firstTheme.current) {
      firstTheme.current = false;
      return;
    }
    // The open editor captured the old theme's colours: commit it so it re-opens with the new ones.
    void commitOpenEditor();
  }, [theme]);

  // ---------------------------------------------------------------- columns
  const fontFamily = gridTheme.fontFamily ?? 'monospace';
  const cellFont = `${gridTheme.baseFontStyle ?? '13px'} ${fontFamily}`;
  const headerFont = `${gridTheme.headerFontStyle ?? '600 12px'} ${fontFamily}`;
  const [widths, setWidths] = useState<Record<number, number>>({});
  // Measured widths belong to the columns they were measured for (styles-r1-01): a different column list makes them
  // stale and they are measured again in the same effect, so columns and rows arriving in one update still get
  // measured widths (a separate "reset" effect used to run after the measurement and wipe it).
  const [natural, setNatural] = useState<{ columns: readonly ColumnInfo[]; widths: ColumnWidth[] } | null>(null);
  const naturalFresh = natural && sameColumns(natural.columns, columns) ? natural.widths : null;
  useEffect(() => {
    if (natural && sameColumns(natural.columns, columns)) return;
    if (overlay.length === 0 && !p.done) return;
    setNatural({
      columns,
      widths: naturalWidths(columns, overlay, (v, c) => formatCell(v, c, fmt), {
        font: cellFont, headerFont, padding: gridTheme.cellHorizontalPadding ?? 8, extraRight: (i) => (fkByCol.has(i) ? 12 : 0),
      }),
    });
  }, [overlay, overlay.length, p.done, columns, natural, fmt, cellFont, headerFont, gridTheme.cellHorizontalPadding, fkByCol]);
  const markerWidth = Math.max(44, String(rowCount).length * 8 + 20);
  // Hand unused width to truncated columns (recomputed in 40 px steps of the host width).
  const hostW = size ? Math.floor(size.width / 40) * 40 : 0;
  const autoWidths = useMemo(
    () => (naturalFresh ? (hostW ? distributeSpare(naturalFresh, hostW - markerWidth - 16) : naturalFresh.map((n) => n.width)) : null),
    [naturalFresh, hostW, markerWidth],
  );

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
      const isBool = c?.kind === 'bool';
      const align = c && isNumericKind(c.kind) ? 'right' : isBool ? 'center' : 'left';
      if (!r || !c) return { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false, readonly: true };
      const v = valueAt(r, col);
      const canEdit = canEditCell(r, col);
      const isEdited = r.ins ? !!r.ins.touched[col] : editedValue(pending, r.src, col) !== undefined;
      const editedTheme = isEdited && !r.ins ? { bgCell: colors.edited } : undefined;
      if (r.ins && !r.ins.touched[col]) {
        const identity = editability?.target?.identityColumns?.some((x) => x.toLowerCase() === c.name.toLowerCase());
        return {
          kind: GridCellKind.Text, data: '', displayData: identity ? '(auto)' : 'DEFAULT', allowOverlay: canEdit, readonly: !canEdit,
          contentAlign: align, copyData: '', themeOverride: { textDark: nullColor, baseFontStyle: 'italic 13px' },
        };
      }
      if (isBool && (v === null || typeof v === 'boolean' || typeof v === 'number') && (canEdit || v !== null)) {
        return {
          kind: GridCellKind.Boolean, data: v === null ? null : !!v, allowOverlay: false, readonly: !canEdit, copyData: v === null ? '' : String(!!v),
          contentAlign: 'center', themeOverride: editedTheme,
        };
      }
      if (v === null || v === undefined) {
        return {
          kind: GridCellKind.Text, data: '', displayData: nullText, allowOverlay: canEdit, readonly: !canEdit, contentAlign: align,
          // NULL typed into an edited cell reads in the normal text colour (the muted one is too faint on --cell-edited)
          copyData: '', themeOverride: { textDark: isEdited ? colors.fg : nullColor, baseFontStyle: 'italic 13px', ...editedTheme },
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
      if (issues.has(r.ins ? r.ins.id : String(r.src))) return { bgCell: colors.errorRow };
      if (r.ins) return { bgCell: colors.inserted };
      if (pending.deletes[r.src]) return { bgCell: colors.deleted, textDark: colors.deletedText };
      if (row === hoverRow) return { bgCell: colors.hover };
      if (row % 2 === 1) return { bgCell: colors.alt };
      return undefined;
    },
    [rowRef, colors, pending.deletes, hoverRow, issues],
  );

  /** Truncated display strings per (font, width, text): binary search once, not on every frame. */
  const ellipsisCache = useRef(new Map<string, string>());
  useEffect(() => ellipsisCache.current.clear(), [cellFont]);

  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      const { ctx, rect, col, row, cell } = args;
      // Overflowing text gets an ellipsis instead of being clipped mid-glyph (styles-15).
      if (cell.kind === GridCellKind.Text && cell.displayData.length > 3) {
        const th = args.theme;
        const font = `${th.baseFontStyle} ${th.fontFamily}`;
        const avail = rect.width - th.cellHorizontalPadding * 2 - 1;
        if (canvasMeasure(cell.displayData, font) > avail || cell.displayData.includes('\n')) {
          const key = `${font}\u0001${Math.round(avail)}\u0001${cell.displayData}`;
          const cache = ellipsisCache.current;
          let shown = cache.get(key);
          if (shown === undefined) {
            shown = ellipsize(cell.displayData, avail, font);
            if (cache.size > 5000) cache.clear();
            cache.set(key, shown);
          }
          ctx.save();
          ctx.font = font;
          drawTextCell({ ctx, rect, theme: th } as Parameters<typeof drawTextCell>[0], shown, cell.contentAlign);
          ctx.restore();
        } else drawContent();
      } else drawContent();
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
        if (issues.has(r.ins ? r.ins.id : String(r.src))) {
          // the row a failed save stopped at: red frame across the row, and a thick bar at its start
          ctx.fillStyle = colors.error;
          ctx.fillRect(rect.x, rect.y, rect.width, 1);
          ctx.fillRect(rect.x, rect.y + rect.height - 1, rect.width, 1);
          if (col === 0) ctx.fillRect(rect.x, rect.y, 3, rect.height);
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
          // small "go to" chevron at the right edge of FK cells (a click on it navigates)
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
    [rowRef, pending, colors, fkByCol, valueAt, issues],
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

  // Selection aggregates (prop-01), computed after the selection settles.
  const onAggregates = p.onAggregates;
  useEffect(() => {
    if (!onAggregates) return;
    const t = setTimeout(() => {
      let cells: { visRows: number[] | null; y0: number; h: number; cols: number[] } | null = null;
      const all = columns.map((_, i) => i);
      if (selection.rows.length) cells = { visRows: selection.rows.toArray(), y0: 0, h: 0, cols: all };
      else if (selection.columns.length) cells = { visRows: null, y0: 0, h: rowCount, cols: selection.columns.toArray() };
      else if (selection.current) {
        const r = selection.current.range;
        cells = { visRows: null, y0: r.y, h: r.height, cols: Array.from({ length: r.width }, (_, i) => r.x + i) };
      }
      const n = cells ? (cells.visRows ? cells.visRows.length : cells.h) * cells.cols.length : 0;
      if (!cells || n < 2) {
        onAggregates(null);
        return;
      }
      const c = cells;
      function* iterate() {
        let seen = 0;
        const rowsList = c.visRows ?? Array.from({ length: c.h }, (_, i) => c.y0 + i);
        for (const vr of rowsList) {
          const r = rowRef(vr);
          if (!r) continue;
          for (const col of c.cols) {
            if (++seen > MAX_AGG_CELLS) return;
            yield { value: valueAt(r, col), kind: columns[col]?.kind ?? 'other' };
          }
        }
      }
      onAggregates(aggregateCells(iterate()));
    }, 60);
    return () => clearTimeout(t);
  }, [selection, rowRef, valueAt, columns, rowCount, onAggregates]);

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

  /** The selected block: rows (with their refs, for full-value lookup) and columns. `all` = every visible row. */
  const block = (all = false): { refs: RowRef[]; rows: CellValue[][]; columns: ColumnInfo[]; colIdx: number[] } => {
    const allCols = columns.map((c, i) => ({ ...c, ordinal: i }));
    const take = (list: number[], cols: number[]) => {
      const refs = list.map((vr) => rowRef(vr)).filter((r): r is RowRef => !!r);
      return { refs, rows: refs.map((r) => cols.map((c) => valueAt(r, c))), columns: cols.map((c) => allCols[c]), colIdx: cols };
    };
    const everything = () => take(Array.from({ length: rowCount }, (_, i) => i), allCols.map((_, i) => i));
    if (all) return everything();
    if (selection.rows.length > 0) return take(selection.rows.toArray(), allCols.map((_, i) => i));
    if (selection.columns.length > 0) return take(Array.from({ length: rowCount }, (_, i) => i), selection.columns.toArray());
    const range = selection.current?.range;
    if (!range) return everything();
    return take(Array.from({ length: range.height }, (_, i) => range.y + i), Array.from({ length: range.width }, (_, i) => range.x + i));
  };

  const locateFor = (refs: RowRef[], colIdx: number[]) => (row: number, col: number): CellLocator | null => {
    const r = refs[row];
    if (!r || r.ins || !p.cellSource) return null;
    // Committed (refetched) rows are not the stored values any more.
    if (buffer.committed.patched[r.src]) return null;
    return p.cellSource(r.src, colIdx[col]);
  };

  /** Client-side export of every visible row (filtered / sorted / edited view) with full values of truncated cells. */
  const exportVisible = async (format: FileFormat, o: { baseName: string; note?: string | null }) => {
    const b = block(true);
    await exportRowsToFile(format, b.columns, b.rows, { baseName: o.baseName, dialect, locate: locateFor(b.refs, b.colIdx), note: o.note, fetch: p.fetchCell });
  };

  const copyAs = async (format: CopyFormat, all = false) => {
    const b = block(all);
    if (b.rows.length === 0) return;
    const header = format !== 'tsv' || b.rows.length > 1 || b.columns.length > 1;
    const out = await serializeComplete(format, b.columns, b.rows, {
      dialect, header, locate: locateFor(b.refs, b.colIdx), fetch: p.fetchCell ?? defaultFetch,
    });
    if (!out.ok) {
      toast('warning', `Cannot copy as ${COPY_FORMAT_LABELS[format]}`, out.message);
      return;
    }
    await copyText(out.text, `Copied ${b.rows.length} row${b.rows.length === 1 ? '' : 's'} as ${COPY_FORMAT_LABELS[format]}`);
    if (out.warning) toast('warning', 'Some values were copied truncated', out.warning);
  };

  /** Single value: the full text when the grid only has a prefix. */
  const copyValue = async (r: RowRef, col: number) => {
    const v = valueAt(r, col);
    if (isPartial(v) && r.src !== undefined && !buffer.committed.patched[r.src] && p.cellSource) {
      const loc = p.cellSource(r.src, col);
      if (loc) {
        try {
          const full = await (p.fetchCell ?? defaultFetch)(loc);
          await copyText(full.kind === 'binary' ? `0x${base64ToHex(full.value)}` : full.value, 'Copied value');
          return;
        } catch {
          /* fall back to the prefix with a warning */
        }
      }
    }
    await copyText(rawText(v) ?? '', 'Copied value');
    if (isPartial(v)) toast('warning', 'The value was copied truncated', 'Open it in the value viewer or use Export for the full value.');
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

  /**
   * What "Set selected cells to NULL" would do with a selection (design-r2-04): the editable cells that can take NULL
   * (a nullable column, or any column of a new row, whose INSERT may still get a default), how many editable cells a
   * NOT NULL column skips, and why nothing can be set (null when something can). Selected rows cover every column,
   * selected columns every row, as Copy does.
   */
  const nullTargets = (sel: GridSelection): { cells: CellEdit[]; skipped: number; skippedColumns: number; reason: string | null } => {
    let visRows: number[] = [];
    let cols: number[] = [];
    if (sel.rows.length > 0) {
      visRows = sel.rows.toArray();
      cols = columns.map((_, i) => i);
    } else if (sel.columns.length > 0) {
      visRows = Array.from({ length: rowCount }, (_, i) => i);
      cols = sel.columns.toArray();
    } else if (sel.current) {
      const r = sel.current.range;
      visRows = Array.from({ length: r.height }, (_, i) => r.y + i);
      cols = Array.from({ length: r.width }, (_, i) => r.x + i);
    }
    const cells: CellEdit[] = [];
    let skipped = 0;
    const notNull = new Set<number>();
    for (const y of visRows) {
      const r = rowRef(y);
      if (!r) continue;
      for (const x of cols) {
        if (!columns[x] || !canEditCell(r, x)) continue;
        if (r.ins) cells.push({ insertId: r.ins.id, col: x, value: null });
        else if (columns[x].nullable) cells.push({ row: r.src, col: x, value: null, original: overlay.get(r.src)?.[x] ?? null });
        else {
          skipped++;
          notNull.add(x);
        }
      }
    }
    let reason: string | null = null;
    if (!cells.length) {
      if (notNull.size === 1) reason = `${columns[[...notNull][0]].name} is NOT NULL`;
      else if (notNull.size > 1) reason = 'Selected columns are NOT NULL';
      else reason = visRows.length && cols.length ? 'The selected cells cannot be edited' : 'Select the cells to set to NULL';
    }
    return { cells, skipped, skippedColumns: notNull.size, reason };
  };

  const setNullOnSelection = () => {
    if (!editable) return;
    const t = nullTargets(selection);
    if (!t.cells.length) {
      // Ctrl+Alt+N on NOT NULL cells: say why nothing happened instead of silently ignoring the key.
      toast('info', 'Cannot set to NULL', t.reason ?? undefined);
      return;
    }
    // One undoable change for the whole selection.
    edits.getState().setCells(gridKey, t.cells);
    if (t.skipped) toast('info', `${pluralize(t.skipped, 'cell')} skipped: ${t.skippedColumns === 1 ? 'column is' : 'columns are'} NOT NULL`);
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

  /** Open the in-place editor on the focused cell, as F2 does (context menu "Edit cell"). */
  const editFocusedCell = () => {
    ref.current?.focus();
    setTimeout(() => {
      const canvas = hostRef.current?.querySelector<HTMLCanvasElement>('canvas[data-testid="data-grid-canvas"]');
      canvas?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', code: 'F2', bubbles: true, cancelable: true }));
    }, 0);
  };

  /** Commit the open editor, then run the parent's submit (Ctrl+S / Save while typing must not lose the value). */
  const submit = async () => {
    await commitOpenEditor();
    p.onSubmit?.();
  };

  // ---------------------------------------------------------------- menus
  const filterSubmenu = (col: number, v: CellValue): MenuItem[] => [
    ...quickFilterOptions(columns[col], col, v).map((o) => ({ label: o.label, onClick: () => addCondition(o.make()) })),
    { separator: true },
    { label: 'Clear filter', disabled: !view.filter && !view.quickFilter, onClick: () => setView({ filter: null, quickFilter: '' }) },
  ];

  /** `sel`: the selection the menu acts on (a right-click outside the selection selects that cell first). */
  const cellMenu = (col: number, row: number, pos: { clientX: number; clientY: number }, sel: GridSelection = selection) => {
    const r = rowRef(row);
    if (!r) return;
    const v = valueAt(r, col);
    const fk = fkByCol.get(col);
    const args = { gridKey };
    const items: MenuItem[] = [
      { label: 'Copy value', shortcut: displayShortcut('Mod+C'), onClick: () => void copyValue(r, col) },
      { label: 'Copy selection as', submenu: commandMenuItems(GRID_COPY_AS_MENU, args) },
      { label: 'View value', onClick: () => p.onOpenViewer?.(selInfo(col, row)) },
      { separator: true },
      { label: 'Filter', shortcut: displayShortcut('Mod+Shift+F'), submenu: filterSubmenu(col, v) },
    ];
    if (fk && v !== null && r.src !== undefined && p.onNavigateFk) {
      items.push({ label: `Go to referenced row (${fk.refTable})`, shortcut: displayShortcut('Mod+Click'), onClick: () => p.onNavigateFk!(fk, fk.ordinals.map((o) => valueAt(r, o))) });
    }
    if (editable) {
      // "Set selected cells to NULL" is disabled, with the reason, when no selected cell can take NULL (design-r2-04).
      const editItems = commandMenuItems(GRID_CELL_EDIT_MENU, args).map((it) => {
        if (it.id !== 'grid.setNull' || it.disabled) return it;
        const reason = nullTargets(sel).reason;
        return reason ? { ...it, label: `${it.label} (${reason})`, disabled: true } : it;
      });
      items.push({ separator: true }, ...editItems, {
        label: 'Revert row', disabled: r.ins !== undefined || !(r.src !== undefined && (pending.updates[r.src] || pending.deletes[r.src])),
        onClick: () => r.src !== undefined && edits.getState().revertRow(gridKey, r.src),
      });
      const pendingItems = commandMenuItems(GRID_CELL_PENDING_MENU, args);
      if (pendingItems.length) items.push({ separator: true }, ...pendingItems);
    }
    const exportItems = commandMenuItems(GRID_EXPORT_MENU, { gridKey, all: true });
    if (exportItems.length) items.push({ separator: true }, { label: 'Export', submenu: exportItems });
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

  /**
   * Shift+F10 / the ContextMenu key (design-04): the same menus as a right-click, anchored at the focused cell (the
   * header menu when a column, not a cell, is the target). Falls back to the centre of the canvas.
   */
  const openKeyboardMenu = () => {
    const canvas = hostRef.current?.querySelector<HTMLElement>('canvas[data-testid="data-grid-canvas"]') ?? hostRef.current;
    const centre = () => {
      const r = canvas?.getBoundingClientRect();
      return r ? { clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) } : { clientX: 200, clientY: 200 };
    };
    const at = (col: number, row: number) => {
      const b = ref.current?.getBounds(col, row);
      return b && b.width > 0 && b.height > 0 ? { clientX: Math.round(b.x + Math.min(b.width / 2, 24)), clientY: Math.round(b.y + b.height) } : centre();
    };
    const cur = selection.current?.cell;
    if (cur && rowRef(cur[1])) {
      cellMenu(cur[0], cur[1], at(cur[0], cur[1]));
      return;
    }
    const headerCol = selection.columns.first();
    if (headerCol !== undefined && columns[headerCol]) {
      headerMenu(headerCol, at(headerCol, -1));
      return;
    }
    const firstRow = selection.rows.first() ?? (rowCount > 0 ? 0 : undefined);
    if (firstRow !== undefined && rowRef(firstRow)) {
      // Nothing focused yet: the first cell of the (selected) row becomes the focused cell.
      const next: GridSelection = { ...selection, current: { cell: [0, firstRow], range: { x: 0, y: firstRow, width: 1, height: 1 }, rangeStack: [] } };
      setSelection(next);
      cellMenu(0, firstRow, at(0, firstRow), next);
    } else if (columns.length) headerMenu(0, at(0, -1));
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
  const latest = useRef({ quickFilterAtCell, setNullOnSelection, insertRow, deleteSelectedRows, p, editable, buffer, copyAs, submit, editFocusedCell, shownSort, setSort, columns, exportVisible });
  latest.current = { quickFilterAtCell, setNullOnSelection, insertRow, deleteSelectedRows, p, editable, buffer, copyAs, submit, editFocusedCell, shownSort, setSort, columns, exportVisible };
  useEffect(() => {
    const L = () => latest.current;
    const base: GridController = {
      key: gridKey,
      get editable() {
        return L().editable;
      },
      openFilter: (column) => L().p.onOpenFilter?.(column),
      quickFilterCell: () => L().quickFilterAtCell(),
      clearFilter: () => L().p.onViewChange({ filter: null, quickFilter: '' }),
      submit: () => void L().submit(),
      undo: () => useEdits.getState().undo(gridKey),
      redo: () => useEdits.getState().redo(gridKey),
      setNull: () => L().setNullOnSelection(),
      insertRow: () => L().insertRow(),
      deleteRows: () => L().deleteSelectedRows(),
      revertAll: () => useEdits.getState().revertAll(gridKey),
      toggleRecordView: () => L().p.onToggleRecord?.(),
      loadMore: () => L().p.onReachEnd?.(),
      hasPending: () => Object.keys(L().buffer.pending.updates).length + L().buffer.pending.inserts.length + Object.keys(L().buffer.pending.deletes).length > 0,
      commitEdit: async () => {
        await commitOpenEditor();
      },
      editCell: () => L().editFocusedCell(),
      copyAs: (format, all) => void L().copyAs(format, all),
      clearSort: () => L().setSort([]),
      hasSort: () => L().shownSort.length > 0,
      copyColumnNames: () => void copyText(L().columns.map((c) => c.name).join(', '), 'Copied column names'),
      exportVisible: (format, o) => L().exportVisible(format, o),
      focus: () => {
        const host = hostRef.current;
        const canvas = host?.querySelector<HTMLElement>('canvas[data-testid="data-grid-canvas"]');
        if (!host || !canvas || !host.isConnected || isHidden(host)) return false;
        ref.current?.focus();
        // glide focuses its accessible cell when it has one, else the canvas; make sure focus landed in the grid.
        if (!host.contains(document.activeElement)) canvas.focus({ preventScroll: true });
        return host.contains(document.activeElement);
      },
    };
    // Extras (server filter, refresh, export, …) are read on every access: they change with the parent's state
    // (e.g. applyServerFilter is only offered while available) and must never run a stale closure.
    const ctrl = new Proxy(base, {
      get(target, prop, receiver) {
        const extras = L().p.controllerExtras as Record<PropertyKey, unknown> | undefined;
        if (extras && prop in extras) return extras[prop];
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        const extras = L().p.controllerExtras as Record<PropertyKey, unknown> | undefined;
        return (!!extras && prop in extras && extras[prop] !== undefined) || prop in target;
      },
    });
    return registerGridController(ctrl);
  }, [gridKey]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.shiftKey && k === 'c') {
      e.preventDefault();
      void copyAs('csv');
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
      void submit();
    } else if (editable && ctrl && !e.shiftKey && k === 'z') {
      e.preventDefault();
      useEdits.getState().undo(gridKey);
    } else if (editable && ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) {
      e.preventDefault();
      useEdits.getState().redo(gridKey);
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !ctrl && !e.altKey)) {
      // Keyboard context menu (design-04): the menu of the focused cell, anchored at the cell.
      e.preventDefault();
      e.stopPropagation();
      openKeyboardMenu();
    } else if (editable && e.key === 'Insert') {
      e.preventDefault();
      insertRow();
    } else if (ctrl && e.key === 'End') {
      p.onReachEnd?.();
    }
  };

  const fkTip = `Open the referenced row (click the arrow, or ${displayShortcut('Mod+Click')} the cell)`;
  const onItemHovered = (args: GridMouseEventArgs) => {
    const row = args.kind === 'cell' ? args.location[1] : -1;
    setHoverRow((h) => (h === row ? h : row));
    const host = hostRef.current;
    if (!host) return;
    const overArrow = args.kind === 'cell' && fkByCol.has(args.location[0]) && args.localEventX >= args.bounds.width - FK_HIT;
    const hovered = args.kind === 'cell' ? rowRef(row) : null;
    const issue = hovered ? issues.get(hovered.ins ? hovered.ins.id : String(hovered.src)) : undefined;
    const tip = overArrow ? fkTip : issue ? `Not saved: ${issue.message}` : '';
    if (host.title !== tip) host.title = tip;
    host.classList.toggle('fk-hover', overArrow);
  };

  // Stop drawing column lines below the last row: the canvas is only as tall as its content (styles-20).
  const contentHeight = headerHeight + (rowCount + (trailing ? 1 : 0)) * rowHeight + 16;
  const height = size && size.height > contentHeight ? contentHeight : '100%';

  return (
    <div
      ref={hostRef}
      className="grid-host"
      data-command-scope="grid"
      data-editable={editable || undefined}
      onFocusCapture={() => setActiveGridKey(gridKey)}
      onPointerDownCapture={(e) => (altDown.current = e.altKey)}
      onPointerLeave={() => setHoverRow(-1)}
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
        height={height}
        keybindings={KEYBINDINGS}
        rowMarkers={{ kind: 'clickable-number', width: markerWidth }}
        rowHeight={rowHeight}
        headerHeight={headerHeight}
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
        onItemHovered={onItemHovered}
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
          let sel = selection;
          if (!inside && !selection.rows.hasIndex(row)) {
            sel = { columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] } };
            setSelection(sel);
          }
          cellMenu(col, row, { clientX: ev.bounds.x + ev.localEventX, clientY: ev.bounds.y + ev.localEventY }, sel);
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
          if (!fk || !p.onNavigateFk || valueAt(r, col) === null) return;
          // The chevron is a link: a plain click on it navigates; Ctrl/Cmd+click works anywhere in the cell.
          const onArrow = ev.localEventX >= ev.bounds.width - FK_HIT;
          if (onArrow || ev.ctrlKey || ev.metaKey) {
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
        trailingRowOptions={trailing ? { hint: 'New', sticky: false, tint: true } : undefined}
        onRowAppended={trailing ? () => {
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
export function rowValue(overlay: { get(i: number): readonly CellValue[] | undefined }, pendingUpdates: Record<number, Record<number, CellValue>>, r: RowRef, col: number): CellValue {
  if (r.ins) return r.ins.values[col] ?? null;
  const e = pendingUpdates[r.src];
  if (e && col in e) return e[col];
  return overlay.get(r.src)?.[col] ?? null;
}

export { hasOpenEditor, sameValue };

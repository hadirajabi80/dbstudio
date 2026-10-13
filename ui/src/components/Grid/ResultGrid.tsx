import {
  CompactSelection, DataEditor, GridCellKind, GridColumnIcon, type DataEditorRef, type GridCell, type GridColumn,
  type GridSelection, type Item, type Theme,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellValue, ColumnInfo, ColumnKind, Dialect } from '../../api/types';
import { copyText, exportResultSet } from '../../app/actions';
import { EMPTY_VIEW, computeView, newCondition, newGroup, type FilterOperator, type GridViewModel } from '../../lib/filter';
import { formatCell, isBinary, isNumericKind, isTruncated, rawText } from '../../lib/format';
import { COPY_FORMAT_LABELS, serializeRows, type CopyFormat } from '../../lib/serialize';
import { useResults, viewKey } from '../../store/results';
import type { ExecutionState, ResultSetState } from '../../store/resultsReducer';
import { makeGridTheme } from '../../theme/gridTheme';
import type { EffectiveTheme } from '../../theme/useTheme';
import { showContextMenu, type MenuItem } from '../common/Menu';

export interface GridSelectionInfo {
  /** Visible row index → source row index already resolved. */
  sourceRow: number;
  col: number;
}

interface Props {
  exec: ExecutionState;
  rs: ResultSetState;
  dialect: Dialect;
  theme: EffectiveTheme;
  nullText: string;
  dateFormat: 'iso' | 'locale';
  onSelectCell?: (sel: GridSelectionInfo | null) => void;
  onOpenViewer?: (sel: GridSelectionInfo) => void;
  /** Number of rows after filtering. */
  onRowCount?: (n: number) => void;
}

function headerIcon(c: ColumnInfo): GridColumnIcon {
  if (c.isKey) return GridColumnIcon.HeaderRowID;
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

function estimateWidth(c: ColumnInfo, rs: ResultSetState, opts: { nullText: string; dateFormat: 'iso' | 'locale' }): number {
  let maxLen = c.name.length + 4;
  const n = Math.min(rs.rows.length, 200);
  for (let i = 0; i < n; i++) {
    const t = formatCell(rs.rows.get(i)![c.ordinal] ?? null, c, opts);
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
    const now = Date.now();
    const wait = Math.max(0, ms - (now - last.current));
    const t = setTimeout(() => {
      last.current = Date.now();
      setV(rev);
    }, wait);
    return () => clearTimeout(t);
  }, [rev, done, ms]);
  return v;
}

export function ResultGrid({ exec, rs, dialect, theme, nullText, dateFormat, onSelectCell, onOpenViewer, onRowCount }: Props) {
  const key = viewKey(exec.localId, rs.id);
  const view = useResults((s) => s.views[key]) ?? EMPTY_VIEW;
  const setGridView = useResults((s) => s.setGridView);
  const ref = useRef<DataEditorRef>(null);
  const fmt = useMemo(() => ({ nullText, dateFormat }), [nullText, dateFormat]);
  const gridTheme = useMemo<Partial<Theme>>(() => makeGridTheme(theme), [theme]);
  const nullColor = gridTheme.textLight ?? '#999';
  const mutedColor = gridTheme.textMedium ?? '#888';

  const hasView = !!(view.quickFilter || view.filter || view.sort.length);
  const throttledRev = useThrottledRev(rs.rev, rs.done);
  const index = useMemo(
    () => (hasView ? computeView(rs.rows, rs.columns, view) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasView, view, rs.rows, rs.columns, hasView ? throttledRev : 0],
  );
  const rowCount = index ? index.length : rs.rows.length;
  useEffect(() => onRowCount?.(rowCount), [rowCount, onRowCount]);

  const [widths, setWidths] = useState<Record<number, number>>({});
  const [autoWidths, setAutoWidths] = useState<Record<number, number> | null>(null);
  // Size columns once the first rows are in (and again if the column set changes).
  useEffect(() => {
    if (autoWidths && Object.keys(autoWidths).length === rs.columns.length) return;
    if (rs.rows.length === 0 && !rs.done) return;
    const w: Record<number, number> = {};
    rs.columns.forEach((c, i) => (w[i] = estimateWidth({ ...c, ordinal: i }, rs, fmt)));
    setAutoWidths(w);
  }, [rs, rs.rows.length, rs.done, rs.columns, autoWidths, fmt]);

  const columns = useMemo<GridColumn[]>(
    () =>
      rs.columns.map((c, i) => {
        const s = view.sort.find((k) => k.column === i);
        const arrow = s ? (s.dir === 'asc' ? ' ↑' : ' ↓') : '';
        const order = s && view.sort.length > 1 ? `${view.sort.indexOf(s) + 1}` : '';
        return {
          id: String(i),
          title: `${c.name || `column${i + 1}`}${arrow}${order}`,
          width: widths[i] ?? autoWidths?.[i] ?? 140,
          icon: headerIcon(c),
          hasMenu: false,
        };
      }),
    [rs.columns, view.sort, widths, autoWidths],
  );

  const sourceRow = useCallback((row: number) => (index ? index[row] : row), [index]);

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const r = rs.rows.get(sourceRow(row));
      const v: CellValue = r ? r[col] ?? null : null;
      const c = rs.columns[col];
      const align = c && isNumericKind(c.kind) ? 'right' : 'left';
      if (v === null || v === undefined) {
        return {
          kind: GridCellKind.Text, data: '', displayData: nullText, allowOverlay: false, readonly: true, contentAlign: align,
          copyData: '', themeOverride: { textDark: nullColor, baseFontStyle: 'italic 12px' },
        };
      }
      if (typeof v === 'boolean' || (c?.kind === 'bool' && typeof v === 'number')) {
        return { kind: GridCellKind.Boolean, data: !!v, allowOverlay: false, readonly: true, copyData: String(v), contentAlign: 'center' };
      }
      const text = formatCell(v, c, fmt);
      const muted = isBinary(v) || isTruncated(v) || (typeof v === 'object' && v !== null);
      return {
        kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, contentAlign: align,
        copyData: rawText(v) ?? '', themeOverride: muted ? { textDark: mutedColor } : undefined,
      };
    },
    [rs.rows, rs.columns, sourceRow, nullText, nullColor, mutedColor, fmt],
  );

  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  // Reset selection when the result set changes.
  useEffect(() => {
    setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  }, [exec.localId, rs.id]);

  const setView = (v: Partial<GridViewModel>) => setGridView(key, v);

  const toggleSort = (col: number, additive: boolean) => {
    const cur = view.sort.find((s) => s.column === col);
    let next = additive ? view.sort.filter((s) => s.column !== col) : [];
    if (!cur) next = [...next, { column: col, dir: 'asc' }];
    else if (cur.dir === 'asc') next = [...next, { column: col, dir: 'desc' }];
    // third click clears that column's sort
    setView({ sort: next });
  };

  /** Rows/columns covered by the current selection, as source rows (for copy). */
  const selectedBlock = (): { rows: CellValue[][]; columns: ColumnInfo[] } => {
    const all = rs.columns.map((c, i) => ({ ...c, ordinal: i }));
    if (selection.rows.length > 0) {
      const rows = selection.rows.toArray().map((r) => rs.rows.get(sourceRow(r))!).filter(Boolean);
      return { rows, columns: all };
    }
    if (selection.columns.length > 0) {
      const cols = selection.columns.toArray();
      const rows: CellValue[][] = [];
      for (let r = 0; r < rowCount; r++) {
        const src = rs.rows.get(sourceRow(r))!;
        rows.push(cols.map((c) => src[c]));
      }
      return { rows, columns: cols.map((c) => all[c]) };
    }
    const range = selection.current?.range;
    if (!range) return { rows: [], columns: all };
    const cols = all.slice(range.x, range.x + range.width);
    const rows: CellValue[][] = [];
    for (let r = range.y; r < range.y + range.height; r++) {
      const src = rs.rows.get(sourceRow(r));
      if (src) rows.push(src.slice(range.x, range.x + range.width));
    }
    return { rows, columns: cols };
  };

  const copyAs = (format: CopyFormat) => {
    const b = selectedBlock();
    if (b.rows.length === 0) return;
    void copyText(serializeRows(format, b.columns, b.rows, { dialect, header: format !== 'tsv' || b.rows.length > 1 || b.columns.length > 1 }),
      `Copied ${b.rows.length} row${b.rows.length === 1 ? '' : 's'} as ${COPY_FORMAT_LABELS[format]}`);
  };

  const addFilter = (col: number, op: FilterOperator, value = '') => {
    const cond = newCondition(col, op, value);
    const root = view.filter ? { ...view.filter, items: [...view.filter.items, cond] } : newGroup('and', [cond]);
    setView({ filter: root });
  };

  const cellMenu = (col: number, row: number, e: { clientX: number; clientY: number; preventDefault: () => void }) => {
    const src = sourceRow(row);
    const v = rs.rows.get(src)?.[col] ?? null;
    const text = rawText(v);
    const isNull = v === null;
    const items: MenuItem[] = [
      { label: 'Copy value', shortcut: 'Ctrl+C', onClick: () => void copyText(text ?? '') },
      {
        label: 'Copy selection as',
        submenu: (Object.keys(COPY_FORMAT_LABELS) as CopyFormat[]).map((f) => ({ label: COPY_FORMAT_LABELS[f], onClick: () => copyAs(f) })),
      },
      { label: 'View value', shortcut: 'Enter', onClick: () => onOpenViewer?.({ sourceRow: src, col }) },
      { separator: true },
      isNull
        ? { label: `Filter: ${rs.columns[col].name} is NULL`, onClick: () => addFilter(col, 'isNull') }
        : { label: `Filter: ${rs.columns[col].name} = ${shorten(text ?? '')}`, onClick: () => addFilter(col, 'eq', text ?? '') },
      isNull
        ? { label: `Filter: ${rs.columns[col].name} is not NULL`, onClick: () => addFilter(col, 'isNotNull') }
        : { label: `Filter: ${rs.columns[col].name} ≠ ${shorten(text ?? '')}`, onClick: () => addFilter(col, 'neq', text ?? '') },
      { label: 'Clear filters', disabled: !view.filter && !view.quickFilter, onClick: () => setView({ filter: null, quickFilter: '' }) },
      { separator: true },
      {
        label: 'Export result set',
        submenu: [
          { label: 'CSV…', onClick: () => void exportResultSet(exec, rs, 'csv') },
          { label: 'JSON…', onClick: () => void exportResultSet(exec, rs, 'json') },
          { label: 'SQL INSERT…', onClick: () => void exportResultSet(exec, rs, 'sql-insert') },
        ],
      },
    ];
    showContextMenu(e, items);
  };

  const headerMenu = (col: number, e: { clientX: number; clientY: number; preventDefault: () => void }) => {
    const c = rs.columns[col];
    showContextMenu(e, [
      { label: 'Sort ascending', onClick: () => setView({ sort: [{ column: col, dir: 'asc' }] }) },
      { label: 'Sort descending', onClick: () => setView({ sort: [{ column: col, dir: 'desc' }] }) },
      { label: 'Clear sort', disabled: view.sort.length === 0, onClick: () => setView({ sort: [] }) },
      { separator: true },
      { label: `Filter ${c.name}…`, onClick: () => addFilter(col, isNumericKind(c.kind) ? 'eq' : 'contains') },
      { label: 'Copy column name', onClick: () => void copyText(c.name) },
      { label: 'Reset column widths', onClick: () => setWidths({}) },
      { separator: true },
      { label: `${c.dbType}${c.nullable ? '' : ' NOT NULL'}${c.table ? ` · ${c.schema ? `${c.schema}.` : ''}${c.table}` : ''}`, disabled: true },
    ]);
  };

  return (
    <div
      className="grid-host"
      onKeyDown={(e) => {
        // Ctrl+Shift+C: copy selection as CSV (Ctrl+C is the grid's built-in TSV copy).
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
          e.preventDefault();
          copyAs('csv');
        }
      }}
    >
      <DataEditor
        ref={ref}
        columns={columns}
        rows={rowCount}
        getCellContent={getCellContent}
        theme={gridTheme}
        width="100%"
        height="100%"
        rowMarkers={{ kind: 'clickable-number', width: Math.max(44, String(rowCount).length * 8 + 20) }}
        rowHeight={24}
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
          onSelectCell?.(cell ? { sourceRow: sourceRow(cell[1]), col: cell[0] } : null);
        }}
        onColumnResize={(_c, w, colIndex) => setWidths((p) => ({ ...p, [colIndex]: w }))}
        onHeaderClicked={(col, ev) => {
          ev.preventDefault();
          toggleSort(col, ev.shiftKey);
        }}
        onHeaderContextMenu={(col, ev) => {
          ev.preventDefault();
          headerMenu(col, { clientX: ev.bounds.x + ev.localEventX, clientY: ev.bounds.y + ev.localEventY, preventDefault: () => {} });
        }}
        onCellContextMenu={([col, row], ev) => {
          ev.preventDefault();
          const inRange = selection.current?.range;
          const inside = inRange && col >= inRange.x && col < inRange.x + inRange.width && row >= inRange.y && row < inRange.y + inRange.height;
          if (!inside && !selection.rows.hasIndex(row)) {
            setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] } });
          }
          cellMenu(col, row, { clientX: ev.bounds.x + ev.localEventX, clientY: ev.bounds.y + ev.localEventY, preventDefault: () => {} });
        }}
        onCellActivated={([col, row]) => onOpenViewer?.({ sourceRow: sourceRow(row), col })}
        verticalBorder
        maxColumnAutoWidth={500}
        maxColumnWidth={2000}
        minColumnWidth={40}
        scaleToRem={false}
      />
    </div>
  );
}

function shorten(s: string): string {
  return s.length > 30 ? `${s.slice(0, 30)}…` : s;
}

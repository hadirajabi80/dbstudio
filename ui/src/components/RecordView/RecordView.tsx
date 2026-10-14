// Record view (F7, PLAN-M1.5 A7): the selected row transposed (name · type · value), editable through the same
// pending buffer as the grid, with FK navigation and "Show referencing rows".
import { ArrowUpRight, ChevronLeft, ChevronRight, Key, Link2, Rows3, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CellValue, ColumnInfo, Dialect } from '../../api/types';
import { formatCell, isNumericKind } from '../../lib/format';
import type { FkLink, ReferencingTable } from '../Grid/editability';
import { editText, parseEdit } from '../Grid/editValue';
import './recordview.css';

export interface RecordViewProps {
  columns: ColumnInfo[];
  /** Values of the shown row (pending edits applied), or null when no row is selected. */
  values: CellValue[] | null;
  /** Columns with a pending edit in this row. */
  edited?: Set<number>;
  editableColumns?: Set<number> | null;
  rowLabel: string;
  nullText: string;
  dialect: Dialect;
  fks?: FkLink[];
  referencing?: ReferencingTable[];
  onSet?(col: number, value: CellValue): void;
  onNavigateFk?(fk: FkLink, values: CellValue[]): void;
  onOpenReferencing?(r: ReferencingTable, values: CellValue[]): void;
  onPrev?(): void;
  onNext?(): void;
  onClose(): void;
}

export function RecordView(p: RecordViewProps) {
  const { columns, values, nullText } = p;
  const [q, setQ] = useState('');
  const fmt = { nullText, dateFormat: 'iso' as const };
  const fkOf = (i: number) => p.fks?.find((f) => f.ordinals.includes(i));
  const needle = q.trim().toLowerCase();

  return (
    <div className="rv" role="region" aria-label="Record view">
      <div className="rv-head">
        <Rows3 size={14} />
        <span className="rv-title">{p.rowLabel}</span>
        <div className="flex-1" />
        <button className="icon-btn sm" title="Previous row" aria-label="Previous row" disabled={!p.onPrev} onClick={p.onPrev}>
          <ChevronLeft size={14} />
        </button>
        <button className="icon-btn sm" title="Next row" aria-label="Next row" disabled={!p.onNext} onClick={p.onNext}>
          <ChevronRight size={14} />
        </button>
        <button className="icon-btn sm" title="Close record view (F7)" aria-label="Close record view" onClick={p.onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="rv-search">
        <input className="input xs" placeholder="Find column" aria-label="Find column" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!values ? (
        <div className="rv-empty">Select a row to see it here.</div>
      ) : (
        <div className="rv-list" role="table" aria-label="Columns of the selected row">
          {columns.map((c, i) => {
            if (needle && !c.name.toLowerCase().includes(needle)) return null;
            const fk = fkOf(i);
            const v = values[i] ?? null;
            const canEdit = !!p.onSet && !!p.editableColumns?.has(i);
            return (
              <div key={i} className={`rv-row${p.edited?.has(i) ? ' edited' : ''}`} role="row">
                <div className="rv-name" role="rowheader" title={`${c.name} · ${c.dbType}${c.nullable ? '' : ' NOT NULL'}`}>
                  {c.isKey && <Key size={11} className="rv-key" aria-label="Key" />}
                  {fk && <Link2 size={11} className="rv-fk" aria-label="Foreign key" />}
                  <span className="n">{c.name}</span>
                  <span className="t">{c.dbType}</span>
                </div>
                <div className="rv-value" role="cell">
                  {canEdit ? (
                    <ValueEditor column={c} value={v} nullText={nullText} dialect={p.dialect} onSet={(nv) => p.onSet!(i, nv)} />
                  ) : (
                    <span className={`rv-ro${v === null ? ' null' : ''}${isNumericKind(c.kind) ? ' num' : ''}`}>{formatCell(v, c, fmt)}</span>
                  )}
                  {fk && v !== null && p.onNavigateFk && (
                    <button className="icon-btn xs" title={`Go to referenced row in ${fk.refTable}`} aria-label={`Go to ${fk.refTable}`}
                      onClick={() => p.onNavigateFk!(fk, fk.ordinals.map((o) => values[o] ?? null))}>
                      <ArrowUpRight size={12} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {values && p.referencing && p.referencing.length > 0 && p.onOpenReferencing && (
        <div className="rv-refs">
          <div className="rv-refs-title">Referencing rows</div>
          {p.referencing.map((r) => {
            const keyVals = r.refColumns.map((rc) => values[columns.findIndex((c) => c.name.toLowerCase() === rc.toLowerCase())] ?? null);
            return (
              <button key={`${r.schema}.${r.table}.${r.constraint}`} className="rv-ref" onClick={() => p.onOpenReferencing!(r, keyVals)} title={r.constraint}>
                <Link2 size={12} /> {r.table}
                <span className="muted">({r.columns.join(', ')})</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ValueEditor({ column, value, nullText, dialect, onSet }: { column: ColumnInfo; value: CellValue; nullText: string; dialect: Dialect; onSet(v: CellValue): void }) {
  const [text, setText] = useState(editText(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(editText(value));
    setError(null);
  }, [value]);
  if (column.kind === 'bool') {
    return (
      <span className="rv-bool">
        <input type="checkbox" aria-label={column.name} checked={value === true || value === 1} onChange={(e) => onSet(e.target.checked)} />
        {column.nullable && <button className="link-btn" onClick={() => onSet(null)} disabled={value === null}>NULL</button>}
      </span>
    );
  }
  const commit = () => {
    if (text === editText(value)) return;
    const r = parseEdit(text, column, dialect);
    if (r.ok) {
      setError(null);
      onSet(r.value);
    } else setError(r.error);
  };
  const multiline = column.kind === 'string' && (text.includes('\n') || text.length > 60);
  const props = {
    className: `input xs rv-input${error ? ' invalid' : ''}`,
    'aria-label': column.name,
    value: text,
    placeholder: value === null ? nullText : '',
    spellCheck: false,
    title: error ?? undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        setText(editText(value));
        setError(null);
      } else if (e.key === '0' && e.ctrlKey && column.nullable) {
        e.preventDefault();
        onSet(null);
      }
    },
  };
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} />;
}

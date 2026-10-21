// Table view (docs/PLAN-M2.md 6.3): columns = union of the page's top-level fields (in first-seen order, _id first);
// subdocuments show as {…} and arrays as [n] and drill in on click (breadcrumb back); cells are type-coloured.
import { ChevronRight, CopyPlus, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getPath, type BsonDoc, type BsonValue } from '../../mongo/bson';
import { ValueText, typeOf } from './BsonView';

export function tableColumns(rows: readonly BsonValue[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const entries = r.t === 'object' ? r.v.map(([k]) => k) : r.t === 'array' ? r.v.map((_, i) => String(i)) : [];
    for (const k of entries) if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  const i = out.indexOf('_id');
  if (i > 0) out.unshift(...out.splice(i, 1));
  return out;
}

function cellOf(row: BsonValue, col: string): BsonValue | undefined {
  if (row.t === 'object') return row.v.find(([k]) => k === col)?.[1];
  if (row.t === 'array') return row.v[Number(col)];
  return undefined;
}

export function DocumentTable({ docs, selected, onSelect, canWrite, onEdit, onClone, onDelete }: {
  docs: readonly BsonDoc[]; selected: number; onSelect: (i: number) => void; canWrite: boolean;
  onEdit: (i: number) => void; onClone: (i: number) => void; onDelete: (i: number) => void;
}) {
  const [path, setPath] = useState<string[]>([]);
  const rows = useMemo(() => docs.map((d) => (path.length ? getPath(d, path.join('.')) : d) ?? ({ t: 'undefined' } as BsonValue)), [docs, path]);
  const cols = useMemo(() => tableColumns(rows), [rows]);
  const scalarRows = path.length > 0 && cols.length === 0;

  return (
    <div className="mg-table-wrap">
      {path.length > 0 && (
        <nav className="mg-crumbs" aria-label="Drill-down path">
          <button className="link-btn" onClick={() => setPath([])}>Documents</button>
          {path.map((p, i) => (
            <span key={i}><ChevronRight size={12} aria-hidden /> <button className="link-btn" disabled={i === path.length - 1} onClick={() => setPath(path.slice(0, i + 1))}>{p}</button></span>
          ))}
        </nav>
      )}
      <div className="mg-table-scroll">
        <table className="mg-table" role="grid" aria-label="Documents table" aria-rowcount={rows.length}>
          <thead>
            <tr>
              <th className="mg-th-n">#</th>
              {scalarRows ? <th>{path[path.length - 1]}</th> : cols.map((c) => <th key={c} title={c}>{c}</th>)}
              <th className="mg-th-actions"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === selected ? 'selected' : undefined} data-doc-index={i} onClick={() => onSelect(i)} onDoubleClick={() => canWrite && onEdit(i)} aria-selected={i === selected}>
                <td className="mg-td-n">{i + 1}</td>
                {scalarRows ? <td><ValueText v={r} max={120} /></td> : cols.map((c) => {
                  const v = cellOf(r, c);
                  if (v === undefined) return <td key={c} className="mg-td-missing" title="No such field">—</td>;
                  if (v.t === 'object' || v.t === 'array') {
                    return (
                      <td key={c}>
                        <button className="link-btn mg-drill" title={`${typeOf(v)}: open ${c}`} onClick={(e) => { e.stopPropagation(); setPath([...path, c]); }}>
                          {v.t === 'object' ? `{ ${v.v.length} }` : `[ ${v.v.length} ]`}
                        </button>
                      </td>
                    );
                  }
                  return <td key={c} title={typeOf(v)}><ValueText v={v} max={80} /></td>;
                })}
                <td className="mg-td-actions">
                  <button className="icon-btn xs" aria-label="Edit document" disabled={!canWrite} onClick={(e) => { e.stopPropagation(); onEdit(i); }}><Pencil size={13} /></button>
                  <button className="icon-btn xs" aria-label="Clone document" disabled={!canWrite} onClick={(e) => { e.stopPropagation(); onClone(i); }}><CopyPlus size={13} /></button>
                  <button className="icon-btn xs danger" aria-label="Delete document" disabled={!canWrite} onClick={(e) => { e.stopPropagation(); onDelete(i); }}><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

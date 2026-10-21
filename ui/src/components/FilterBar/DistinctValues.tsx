// "Show only distinct values": top 500 distinct values with counts; checking N values builds an `in` condition.
import { LoaderCircle, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CellValue, ColumnInfo } from '../../api/types';
import { formatCell, rawText } from '../../lib/format';
import { newCondition, newGroup, type FilterNode } from '../../filter/model';

export interface DistinctItem {
  value: CellValue;
  count: number;
}

export const DISTINCT_LIMIT = 500;

/** Distinct values of a column over client rows, most frequent first. */
export function distinctValues(rows: { length: number; get(i: number): readonly CellValue[] | undefined }, col: number, limit = DISTINCT_LIMIT): { items: DistinctItem[]; more: boolean } {
  const counts = new Map<string, DistinctItem>();
  for (let i = 0; i < rows.length; i++) {
    const v = rows.get(i)?.[col] ?? null;
    const k = v === null ? '\u0000null' : typeof v === 'object' ? JSON.stringify(v) : `${typeof v}:${String(v)}`;
    const e = counts.get(k);
    if (e) e.count++;
    else counts.set(k, { value: v, count: 1 });
  }
  const items = [...counts.values()].sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  return { items: items.slice(0, limit), more: items.length > limit };
}

/** Condition for a checked set: `in (…)`, plus `is NULL` when (NULL) is checked. */
export function distinctCondition(column: ColumnInfo, ordinal: number, checked: CellValue[]): FilterNode | null {
  const nonNull = checked.filter((v) => v !== null).map((v) => (typeof v === 'object' ? rawText(v) : v)) as (string | number | boolean)[];
  const hasNull = checked.some((v) => v === null);
  const parts: FilterNode[] = [];
  if (nonNull.length) parts.push(newCondition(column.name, nonNull.length === 1 ? 'eq' : 'in', nonNull, ordinal));
  if (hasNull) parts.push(newCondition(column.name, 'isNull', [], ordinal));
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : newGroup('or', parts);
}

export function DistinctValuesPopover({ column, ordinal, at, load, nullText, onApply, onClose }: {
  column: ColumnInfo;
  ordinal: number;
  at: { x: number; y: number };
  load(): Promise<{ items: DistinctItem[]; more: boolean }>;
  nullText: string;
  onApply(node: FilterNode): void;
  onClose(): void;
}) {
  const [data, setData] = useState<{ items: DistinctItem[]; more: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  useEffect(() => {
    let alive = true;
    load().then((d) => alive && setData(d)).catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at, data]);

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [onClose]);

  const fmt = { nullText, dateFormat: 'iso' as const };
  const shown = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.items.map((it, i) => ({ ...it, i })).filter((it) => !needle || formatCell(it.value, column, fmt).toLowerCase().includes(needle));
  }, [data, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = () => {
    if (!data) return;
    const node = distinctCondition(column, ordinal, [...checked].map((i) => data.items[i].value));
    if (node) onApply(node);
    onClose();
  };

  return (
    <div
      ref={ref}
      className="fb-distinct"
      role="dialog"
      aria-label={`Distinct values of ${column.name}`}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.target instanceof HTMLInputElement && e.target.type === 'text')) {
          e.preventDefault();
          apply();
        }
      }}
    >
      <div className="fb-distinct-head">
        <strong>{column.name}</strong>
        <span className="muted">{data ? `${data.items.length}${data.more ? '+' : ''} values` : ''}</span>
      </div>
      <div className="fb-distinct-search">
        <Search size={13} />
        <input className="input xs borderless" autoFocus placeholder="Search values" aria-label="Search values" dir="auto" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="fb-distinct-list" role="listbox" aria-multiselectable="true">
        {!data && !error && (
          <div className="fb-distinct-msg">
            <LoaderCircle size={13} className="spin" /> Loading…
          </div>
        )}
        {error && <div className="fb-distinct-msg error">{error}</div>}
        {shown.map((it) => (
          <label key={it.i} className="fb-distinct-row">
            <input
              type="checkbox"
              checked={checked.has(it.i)}
              onChange={(e) => {
                const next = new Set(checked);
                if (e.target.checked) next.add(it.i);
                else next.delete(it.i);
                setChecked(next);
              }}
            />
            <span className={`v${it.value === null ? ' null' : ''}`} dir="auto">{formatCell(it.value, column, fmt) || '(empty)'}</span>
            <span className="c">{it.count.toLocaleString()}</span>
          </label>
        ))}
      </div>
      <div className="fb-distinct-foot">
        <button className="link-btn" onClick={() => setChecked(new Set(shown.map((s) => s.i)))} disabled={!shown.length}>
          Select all
        </button>
        <button className="link-btn" onClick={() => setChecked(new Set())} disabled={!checked.size}>
          None
        </button>
        <div className="flex-1" />
        <button className="btn btn-xs" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-xs btn-primary" disabled={!checked.size} onClick={apply}>
          Filter ({checked.size})
        </button>
      </div>
    </div>
  );
}

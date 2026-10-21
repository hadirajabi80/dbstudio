// Query bar (docs/PLAN-M2.md 6.3): Filter on top; Options expand Project, Sort, Collation, Skip, Limit and the time
// limit. Every field is a shell-JSON editor with completion (fields from `POST …/fields`, operators, sampled values).
// Enter runs the query, Reset clears it; the applied query is highlighted until the text differs again.
import { ChevronDown, ChevronRight, Gauge, History, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { MongoFieldPath } from '../../api/types';
import { checkShell } from '../../mongo/shellJson';
import type { EffectiveTheme } from '../../theme/useTheme';
import { MongoEditor } from './MongoEditor';
import { DEFAULT_QUERY, type QueryState } from './open';

export interface QueryBarProps {
  draft: QueryState;
  applied: QueryState;
  onDraft: (q: QueryState) => void;
  onFind: (q: QueryState) => void;
  onReset: () => void;
  onExplain?: () => void;
  fields: readonly MongoFieldPath[];
  theme: EffectiveTheme;
  busy?: boolean;
  history?: QueryState[];
}

const sameQuery = (a: QueryState, b: QueryState) =>
  a.filter.trim() === b.filter.trim() && a.projection.trim() === b.projection.trim() && a.sort.trim() === b.sort.trim()
  && a.collation.trim() === b.collation.trim() && a.skip === b.skip && a.limit === b.limit && a.maxTimeMs === b.maxTimeMs;

export function queryErrors(q: QueryState): Partial<Record<'filter' | 'projection' | 'sort' | 'collation', string>> {
  const out: Partial<Record<'filter' | 'projection' | 'sort' | 'collation', string>> = {};
  for (const k of ['filter', 'projection', 'sort', 'collation'] as const) {
    const e = q[k].trim() ? checkShell(q[k]) : null;
    if (e) out[k] = e.message;
  }
  return out;
}

export function QueryBar({ draft, applied, onDraft, onFind, onReset, onExplain, fields, theme, busy, history = [] }: QueryBarProps) {
  const hasOptions = !!(draft.projection.trim() || draft.sort.trim() || draft.collation.trim() || draft.skip || draft.limit !== DEFAULT_QUERY.limit);
  const [open, setOpen] = useState(hasOptions);
  const [showHistory, setShowHistory] = useState(false);
  const errors = queryErrors(draft);
  const invalid = Object.keys(errors).length > 0;
  const dirty = !sameQuery(draft, applied);
  const set = (p: Partial<QueryState>) => onDraft({ ...draft, ...p });
  const find = () => {
    if (!invalid) onFind(draft);
  };
  const firstError = Object.entries(errors)[0];

  return (
    <div className={`mg-qbar ${dirty ? 'dirty' : ''}`} role="search" aria-label="Query">
      <div className="mg-qrow">
        <span className="mg-qlabel" id="mg-q-filter">Filter</span>
        <div className="mg-qfield mg-qfield-filter" data-primary-focus>
          <MongoEditor singleLine mode="filter" fields={fields} theme={theme} value={draft.filter} onChange={(v) => set({ filter: v })}
            onSubmit={find} placeholder={'{ field: "value" }  ·  type to complete fields and $operators'} ariaLabel="Filter" invalid={!!errors.filter} />
        </div>
        <button className={`btn btn-ghost mg-qopts ${open ? 'on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} title="Project, sort, collation, skip, limit">
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />} Options
          {hasOptions && !open && <span className="mg-dot" aria-label="options set" />}
        </button>
        {history.length > 0 && (
          <div className="mg-qhist">
            <button className="icon-btn" aria-label="Recent queries" title="Recent queries" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}><History size={16} /></button>
            {showHistory && (
              <ul className="mg-qhist-list" role="listbox" aria-label="Recent queries">
                {history.map((h, i) => (
                  <li key={i} role="option" aria-selected={false} tabIndex={0}
                    onClick={() => { setShowHistory(false); onDraft(h); onFind(h); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { setShowHistory(false); onDraft(h); onFind(h); } }}>
                    <code>{h.filter.trim() || '{}'}</code>
                    {h.sort.trim() && <span className="muted"> sort {h.sort.trim()}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {onExplain && <button className="btn btn-ghost" onClick={onExplain} disabled={invalid} title="Explain this query"><Gauge size={14} aria-hidden /> Explain</button>}
        <button className="btn" onClick={onReset} title="Clear the query"><RotateCcw size={14} aria-hidden /> Reset</button>
        <button className="btn btn-primary mg-find" onClick={find} disabled={invalid || busy} title={invalid ? firstError?.[1] : 'Run the query (Enter)'}>
          <Play size={14} aria-hidden /> Find
        </button>
      </div>
      {open && (
        <div className="mg-qrow mg-qrow-opts">
          <span className="mg-qlabel">Project</span>
          <div className="mg-qfield"><MongoEditor singleLine mode="projection" fields={fields} theme={theme} value={draft.projection} onChange={(v) => set({ projection: v })} onSubmit={find} placeholder="{ field: 0 }" ariaLabel="Project" invalid={!!errors.projection} /></div>
          <span className="mg-qlabel">Sort</span>
          <div className="mg-qfield"><MongoEditor singleLine mode="sort" fields={fields} theme={theme} value={draft.sort} onChange={(v) => set({ sort: v })} onSubmit={find} placeholder="{ field: -1 }" ariaLabel="Sort" invalid={!!errors.sort} /></div>
          <span className="mg-qlabel">Collation</span>
          <div className="mg-qfield"><MongoEditor singleLine mode="collation" fields={fields} theme={theme} value={draft.collation} onChange={(v) => set({ collation: v })} onSubmit={find} placeholder={'{ locale: "en", strength: 2 }'} ariaLabel="Collation" invalid={!!errors.collation} /></div>
          <label className="mg-qlabel" htmlFor="mg-q-skip">Skip</label>
          <input id="mg-q-skip" className="input sm mg-qnum" inputMode="numeric" value={draft.skip} onChange={(e) => set({ skip: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })} onKeyDown={(e) => e.key === 'Enter' && find()} />
          <label className="mg-qlabel" htmlFor="mg-q-limit">Limit</label>
          <input id="mg-q-limit" className="input sm mg-qnum" inputMode="numeric" value={draft.limit} onChange={(e) => set({ limit: Math.min(1000, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)) })} onKeyDown={(e) => e.key === 'Enter' && find()} />
          <label className="mg-qlabel" htmlFor="mg-q-maxtime" title="maxTimeMS">Max time (ms)</label>
          <input id="mg-q-maxtime" className="input sm mg-qnum" inputMode="numeric" value={draft.maxTimeMs} onChange={(e) => set({ maxTimeMs: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })} onKeyDown={(e) => e.key === 'Enter' && find()} />
        </div>
      )}
      {firstError && <div className="mg-qerror" role="alert">{firstError[0]}: {firstError[1]}</div>}
    </div>
  );
}

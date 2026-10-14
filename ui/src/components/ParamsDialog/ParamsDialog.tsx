// Parameters dialog (PLAN-M1.5 A2): one row per bind (name · type · value) with MRU values per connection.
// Ctrl+Enter runs. `resolveParams()` is the entry point for the run pipeline.
import { Braces, History, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Dialect, ParamKind, QueryParam, SqlBatch } from '../../api/types';
import { paramHistory, recalled, rememberParams, useParams, type ParamRow } from '../../store/params';
import { Dialog } from '../common/Dialog';
import { detectParams } from './detect';
import './paramsdialog.css';

const KINDS: { kind: ParamKind; label: string; oracleOnly?: boolean }[] = [
  { kind: 'string', label: 'string' },
  { kind: 'int', label: 'int' },
  { kind: 'decimal', label: 'decimal' },
  { kind: 'datetime', label: 'datetime' },
  { kind: 'date', label: 'date' },
  { kind: 'bool', label: 'bool' },
  { kind: 'binary', label: 'binary (hex)' },
  { kind: 'null', label: 'NULL' },
  { kind: 'refcursor', label: 'refcursor (out)', oracleOnly: true },
];

function guessKind(name: string): ParamKind {
  if (/(^|_)(id|count|qty|num|n|no|year|top|limit)$/i.test(name) || /Id$/.test(name)) return 'int';
  if (/(date|_at|time|since|until|from|to)$/i.test(name)) return 'datetime';
  if (/^(is|has)[A-Z_]/.test(name)) return 'bool';
  return 'string';
}

export function convertValue(kind: ParamKind, text: string): { ok: true; value: QueryParam['value'] } | { ok: false; error: string } {
  const t = text.trim();
  switch (kind) {
    case 'null':
    case 'refcursor':
      return { ok: true, value: null };
    case 'string':
      return { ok: true, value: text };
    case 'int': {
      if (!/^[+-]?\d+$/.test(t)) return { ok: false, error: 'Whole number' };
      const n = Number(t);
      return { ok: true, value: Number.isSafeInteger(n) ? n : t };
    }
    case 'decimal':
    case 'float':
      return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) ? { ok: true, value: kind === 'float' ? Number(t) : t } : { ok: false, error: 'Number' };
    case 'bool': {
      const s = t.toLowerCase();
      if (['1', 'true', 'yes', 'y'].includes(s)) return { ok: true, value: true };
      if (['0', 'false', 'no', 'n'].includes(s)) return { ok: true, value: false };
      return { ok: false, error: 'true or false' };
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { ok: true, value: t } : { ok: false, error: 'YYYY-MM-DD' };
    case 'datetime':
    case 'datetimeoffset': {
      const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?([+-]\d{2}:\d{2}|Z)?$/.exec(t);
      if (!m) return { ok: false, error: 'YYYY-MM-DD HH:MM[:SS]' };
      const time = m[2] ? (m[2].length === 5 ? `${m[2]}:00` : m[2]) : '00:00:00';
      return { ok: true, value: `${m[1]}T${time}${m[3] ?? ''}` };
    }
    case 'time':
      return /^\d{2}:\d{2}(:\d{2})?$/.test(t) ? { ok: true, value: t.length === 5 ? `${t}:00` : t } : { ok: false, error: 'HH:MM[:SS]' };
    case 'binary': {
      const hex = t.replace(/^0x/i, '');
      if (!/^([0-9a-f]{2})*$/i.test(hex)) return { ok: false, error: 'Hex bytes (0x…)' };
      let bin = '';
      for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return { ok: true, value: btoa(bin) };
    }
    default:
      return { ok: true, value: text };
  }
}

export function toQueryParams(rows: ParamRow[]): QueryParam[] | null {
  const out: QueryParam[] = [];
  for (const r of rows) {
    const c = convertValue(r.kind, r.value);
    if (!c.ok) return null;
    out.push({ name: r.name, kind: r.kind, value: c.value, ...(r.kind === 'refcursor' ? { direction: 'out' as const } : {}) });
  }
  return out;
}

/**
 * Parameters for a run: `undefined` when the SQL has none, `null` when the user cancelled, else the binds.
 * Asks with the dialog unless every value is remembered and "Don't ask again" is on for the tab.
 */
export async function resolveParams(
  tabId: string, connectionId: string, dialect: Dialect, batches: readonly SqlBatch[], opts: { force?: boolean } = {},
): Promise<QueryParam[] | null | undefined> {
  const found = detectParams(batches, dialect);
  if (found.length === 0) return undefined;
  const rows: ParamRow[] = found.map((p) => {
    const mem = p.positional ? undefined : recalled(connectionId, p.name);
    return { name: p.name, display: p.display, positional: p.positional, kind: mem?.kind ?? (p.positional ? 'string' : guessKind(p.name)), value: mem?.values[0] ?? '' };
  });
  const st = useParams.getState();
  const allKnown = rows.every((r) => !r.positional && recalled(connectionId, r.name));
  if (st.skip[tabId] && allKnown && !opts.force) {
    const params = toQueryParams(rows);
    if (params) return params;
  }
  ensureHost();
  return new Promise((resolve) => st.open({ tabId, connectionId, dialect, rows, resolve }));
}

let hostsMounted = 0;

/** The dialog needs a mounted host; when the shell did not mount <ParamsDialogHost/>, mount one on demand. */
function ensureHost(): void {
  if (hostsMounted > 0 || typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.id = 'params-dialog-host';
  document.body.appendChild(el);
  createRoot(el).render(<ParamsDialogHost />);
}

export function ParamsDialogHost() {
  const req = useParams((s) => s.request);
  useEffect(() => {
    hostsMounted++;
    return () => {
      hostsMounted--;
    };
  }, []);
  if (!req) return null;
  return <ParamsDialog key={req.tabId + req.rows.map((r) => r.name).join()} />;
}

function ParamsDialog() {
  const req = useParams((s) => s.request)!;
  const skip = useParams((s) => s.skip[req.tabId] ?? false);
  const [rows, setRows] = useState<ParamRow[]>(req.rows);
  const [dontAsk, setDontAsk] = useState(skip);
  const history = useMemo(() => paramHistory()[req.connectionId] ?? {}, [req.connectionId]);
  const errors = rows.map((r) => {
    const c = convertValue(r.kind, r.value);
    return c.ok ? null : c.error;
  });
  const valid = errors.every((e) => e === null);

  const run = () => {
    const params = toQueryParams(rows);
    if (!params) return;
    rememberParams(req.connectionId, rows);
    useParams.getState().setSkip(req.tabId, dontAsk);
    useParams.getState().close(params);
  };

  useEffect(() => {
    // Initial focus on the first value (Dialog focuses the first input; make it the first *value* input).
    const el = document.querySelector<HTMLInputElement>('.pd-value input');
    el?.focus();
    el?.select();
  }, []);

  const set = (i: number, p: Partial<ParamRow>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));

  return (
    <Dialog
      title={<span className="pd-title"><Braces size={15} /> Parameters</span>}
      ariaLabel="Parameters"
      onClose={() => useParams.getState().close(null)}
      width={620}
      className="pd-dialog"
      footer={
        <>
          <label className="pd-skip" title="Run without asking while every value is remembered">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> Don't ask again for this tab
          </label>
          <div className="flex-1" />
          <button className="btn" onClick={() => useParams.getState().close(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!valid} onClick={run} title="Run (Ctrl+Enter)">
            <Play size={13} /> Run
          </button>
        </>
      }
    >
      <div
        className="pd-grid"
        role="table"
        aria-label="Parameter values"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            if (valid) run();
          }
        }}
      >
        <div className="pd-head" role="row">
          <span role="columnheader">Name</span>
          <span role="columnheader">Type</span>
          <span role="columnheader">Value</span>
        </div>
        {rows.map((r, i) => {
          const mru = history[r.name.toLowerCase()]?.values ?? [];
          const listId = `pd-mru-${i}`;
          const noValue = r.kind === 'null' || r.kind === 'refcursor';
          return (
            <div className="pd-row" role="row" key={`${r.name}-${i}`}>
              <span className="pd-name mono" role="cell" title={r.positional ? 'Positional parameter' : undefined}>
                {r.positional ? `? ${r.name}` : r.display}
              </span>
              <span role="cell">
                <select className="input sm" aria-label={`Type of ${r.display}`} value={r.kind} onChange={(e) => set(i, { kind: e.target.value as ParamKind })}>
                  {KINDS.filter((k) => !k.oracleOnly || req.dialect === 'plsql').map((k) => (
                    <option key={k.kind} value={k.kind}>{k.label}</option>
                  ))}
                </select>
              </span>
              <span className="pd-value" role="cell">
                <input
                  className={`input sm mono${errors[i] ? ' invalid' : ''}`}
                  aria-label={`Value of ${r.display}`}
                  value={noValue ? '' : r.value}
                  disabled={noValue}
                  placeholder={noValue ? (r.kind === 'null' ? 'NULL' : 'returned as a result set') : errors[i] ?? ''}
                  list={mru.length ? listId : undefined}
                  spellCheck={false}
                  onChange={(e) => set(i, { value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.ctrlKey && valid) {
                      e.preventDefault();
                      run();
                    }
                  }}
                />
                {mru.length > 0 && (
                  <datalist id={listId}>
                    {mru.map((v) => <option key={v} value={v} />)}
                  </datalist>
                )}
                {mru.length > 0 && <History size={12} className="pd-mru-icon" aria-label="Has recent values" />}
                {errors[i] && r.value.trim() !== '' && <span className="pd-error">{errors[i]}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

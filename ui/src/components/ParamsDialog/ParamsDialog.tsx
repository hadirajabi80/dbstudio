// Parameters dialog (PLAN-M1.5 A2): one row per bind (name · type · value) with MRU values per connection.
// Ctrl+Enter confirms (Run, or the caller's label: Explain). `resolveParams()` is the entry point for the run pipeline.
import { Braces, History, ListTree, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CatalogSnapshot, Dialect, ParamKind, QueryParam, SqlBatch } from '../../api/types';
import type { QueryParamType } from '../../codegen/model';
import { inferQueryParamTypes } from '../../codegen/paramTypes';
import { dbKey, useCatalog } from '../../store/catalog';
import { paramHistory, recalled, rememberParams, useParams, type ParamRow, type ParamsRequest } from '../../store/params';
import { useTabs } from '../../store/tabs';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { Kbd } from '../Shortcuts/Kbd';
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

/** Dialog kind for a type inferred from the compared column (codegen QueryParamType). */
export function kindOfParamType(t: QueryParamType): ParamKind {
  switch (t) {
    case 'int':
    case 'long':
      return 'int';
    case 'decimal':
    case 'float':
      return 'decimal';
    case 'date':
    case 'datetime':
      return 'datetime';
    case 'bool':
      return 'bool';
    default:
      return 'string';
  }
}

/** The loaded catalog of the tab's database (else the connection's current or default one), or null. */
function catalogSnapshot(tabId: string, connectionId: string): CatalogSnapshot | null {
  const { dbs, conns } = useCatalog.getState();
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  const current = conns[connectionId]?.databases?.current ?? null;
  for (const db of [tab?.connectionId === connectionId ? tab.database : undefined, current, null]) {
    if (db === undefined) continue;
    const snap = dbs[dbKey(connectionId, db)]?.snapshot;
    if (snap) return snap;
  }
  return Object.values(dbs).find((d) => d.connectionId === connectionId && d.snapshot)?.snapshot ?? null;
}

/**
 * Kinds inferred from the columns each parameter is compared with (`c.Id > ?` → int), keyed like `detectParams`
 * names them: named binds by name (case-insensitive), positional `?` by their running number across the batches.
 */
export function inferredKinds(batches: readonly SqlBatch[], dialect: Dialect, snapshot: CatalogSnapshot | null): Map<string, ParamKind> {
  const out = new Map<string, ParamKind>();
  if (!snapshot) return out;
  let offset = 0;
  for (const b of batches) {
    const types = inferQueryParamTypes(b.sql, dialect, snapshot);
    const local = detectParams([b], dialect);
    let q = 0;
    for (const p of local) {
      const anonymous = p.positional && p.display === '?';
      // inferQueryParamTypes names positional `?` p1, p2, … per statement, and numbered binds (?2, :1) pN
      const key = anonymous ? `p${++q}` : /^\d+$/.test(p.name) ? `p${p.name}` : p.name;
      const t = types[key] ?? Object.entries(types).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
      const name = anonymous ? String(offset + q) : p.name.toUpperCase();
      if (t && !out.has(name)) out.set(name, kindOfParamType(t));
    }
    offset += q;
  }
  return out;
}

/** The dialog's request; `confirmLabel` names the primary button ("Run", or "Explain" for an estimated plan). */
type DialogRequest = ParamsRequest & { confirmLabel?: string };

/**
 * Parameters for a run: `undefined` when the SQL has none, `null` when the user cancelled, else the binds.
 * Asks with the dialog unless every value is remembered and "Don't ask again" is on for the tab. Default kinds:
 * the remembered one, else the type of the compared catalog column (logic-r1-04), else a guess from the name.
 */
export async function resolveParams(
  tabId: string, connectionId: string, dialect: Dialect, batches: readonly SqlBatch[], opts: { force?: boolean; confirmLabel?: string } = {},
): Promise<QueryParam[] | null | undefined> {
  const found = detectParams(batches, dialect);
  if (found.length === 0) return undefined;
  const inferred = inferredKinds(batches, dialect, catalogSnapshot(tabId, connectionId));
  const rows: ParamRow[] = found.map((p) => {
    const mem = p.positional ? undefined : recalled(connectionId, p.name);
    const seeded = inferred.get(p.positional && p.display === '?' ? p.name : p.name.toUpperCase());
    return { name: p.name, display: p.display, positional: p.positional, kind: mem?.kind ?? seeded ?? (p.positional ? 'string' : guessKind(p.name)), value: mem?.values[0] ?? '' };
  });
  const st = useParams.getState();
  const allKnown = rows.every((r) => !r.positional && recalled(connectionId, r.name));
  if (st.skip[tabId] && allKnown && !opts.force) {
    const params = toQueryParams(rows);
    if (params) return params;
  }
  return new Promise((resolve) => {
    const req: DialogRequest = { tabId, connectionId, dialect, rows, resolve, confirmLabel: opts.confirmLabel };
    st.open(req);
  });
}

/** Rendered by the shell (App, inside #params-dialog-host); shows the pending request of `useParams`. */
export function ParamsDialogHost() {
  const req = useParams((s) => s.request);
  if (!req) return null;
  return <ParamsDialog key={req.tabId + req.rows.map((r) => r.name).join()} />;
}

function ParamsDialog() {
  const req = useParams((s) => s.request)! as DialogRequest;
  const confirmLabel = req.confirmLabel ?? 'Run';
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
          <button className="btn btn-primary" disabled={!valid} onClick={run} title={confirmLabel}>
            {confirmLabel === 'Run' ? <Play size={13} /> : <ListTree size={13} />} {confirmLabel} <Kbd shortcut="Mod+Enter" className="on-accent" />
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
                <Select
                  size="sm"
                  aria-label={`Type of ${r.display}`}
                  value={r.kind}
                  options={KINDS.filter((k) => !k.oracleOnly || req.dialect === 'plsql').map((k) => ({ value: k.kind, label: k.label }))}
                  onChange={(kind) => set(i, { kind })}
                  searchable={false}
                />
              </span>
              <span className="pd-value" role="cell">
                <input
                  className={`input sm mono${errors[i] ? ' invalid' : ''}`}
                  aria-label={`Value of ${r.display}`}
                  dir={r.kind === 'string' ? 'auto' : undefined}
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

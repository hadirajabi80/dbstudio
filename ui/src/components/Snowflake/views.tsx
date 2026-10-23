// Snowflake tab views (plan-batch3 WP-SF), one lazy chunk: session chips, warehouses, schema objects, query history.
import { Code2, Pause, Play, RefreshCw, TerminalSquare, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../api/client';
import type { LogEntry } from '../../api/types';
import type {
  SnowflakeDdlResponse, SnowflakeObject, SnowflakeObjectKind, SnowflakeObjectsResponse, SnowflakeRole, SnowflakeSessionContext, SnowflakeUseKind,
  SnowflakeWarehouse,
} from '../../api/types.snowflake';
import { newConsole } from '../../app/actions';
import { getConnection } from '../../store/connections';
import { useSessions } from '../../store/sessions';
import { useTabs } from '../../store/tabs';
import { toast, useUi } from '../../store/ui';
import type { TabViewProps } from '../layout/tabViews';
import { SF_VIEWS, type SfViewState } from './commands';
import { formatBytes, formatMs, OBJECT_ACTIONS, queryText } from './format';
import './snowflake.css';

const stateOf = (p: TabViewProps) => (p.tab.state ?? {}) as SfViewState;
const patch = (tabId: string, p: Partial<SfViewState>) => {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  if (t?.kind === 'view') useTabs.getState().updateView(tabId, { state: { ...(t.state as object), ...p } });
};

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load().then(
      (d) => { if (live) { setData(d); setError(null); setLoading(false); } },
      (e) => { if (live) { setError(errorMessage(e)); setLoading(false); } },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, seq]);
  return { data, error, loading, reload: useCallback(() => setSeq((s) => s + 1), []) };
}

function Header({ title, children, onRefresh, loading }: { title: string; children?: ReactNode; onRefresh: () => void; loading: boolean }) {
  return (
    <div className="sf-toolbar" role="toolbar" aria-label={title}>
      <span className="sf-title">{title}</span>
      {children}
      <span className="flex-1" />
      <button className="icon-btn" aria-label="Refresh" title="Refresh (F5)" disabled={loading} onClick={onRefresh}><RefreshCw size={15} className={loading ? 'spin' : undefined} /></button>
    </div>
  );
}

const readOnly = (cid: string) => !!getConnection(cid)?.readOnly;

// ---------------------------------------------------------------- session chips

export function SessionView(p: TabViewProps) {
  const cid = p.tab.connectionId ?? '';
  const consoleId = stateOf(p).consoleId ?? null;
  const consoleTab = useTabs((s) => s.tabs.find((t) => t.id === consoleId && t.kind === 'console'));
  const [ctx, setCtx] = useState<SnowflakeSessionContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const warehouses = useLoad(() => api.snowflake.warehouses(cid), [cid]);
  const roles = useLoad(() => api.snowflake.roles(cid), [cid]);
  const dbs = useLoad(() => api.databases(cid), [cid]);
  const schemas = useLoad(() => (ctx?.database ? api.schemas(cid, ctx.database) : Promise.resolve(null)), [cid, ctx?.database]);

  const session = useCallback(async () => {
    if (!consoleTab || consoleTab.kind !== 'console') throw new Error('Open a Snowflake console first (the chips act on its session).');
    return useSessions.getState().ensure(consoleTab.id, cid, consoleTab.database, consoleTab.txMode);
  }, [cid, consoleTab]);

  const refresh = useCallback(async () => {
    try {
      const s = await session();
      setCtx(await api.snowflake.sessionContext(s.sessionId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [session]);

  useEffect(() => { void refresh(); }, [refresh]);

  const use = async (kind: SnowflakeUseKind, name: string) => {
    if (!name) return;
    setBusy(true);
    try {
      const s = await session();
      setCtx(kind === 'database' ? (await useSessions.getState().changeDatabase(consoleTab!.id, name), await api.snowflake.sessionContext(s.sessionId))
        : await api.snowflake.use(s.sessionId, kind, kind === 'schema' && ctx?.database ? `${ctx.database}.${name}` : name));
      toast('success', `USE ${kind.toUpperCase()} ${name}`);
    } catch (e) {
      toast('error', `Could not use ${kind} ${name}`, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const chip = (kind: SnowflakeUseKind, label: string, value: string | null, options: string[]) => (
    <label className="sf-chip" key={kind}>
      <span className="sf-chip-label">{label}</span>
      <select className="input" aria-label={label} value={value ?? ''} disabled={busy || !ctx} onChange={(e) => void use(kind, e.target.value)}>
        {!value && <option value="">(none)</option>}
        {[...new Set([...(value ? [value] : []), ...options])].map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );

  return (
    <div className="sf-view" data-command-scope="snowflakeSession">
      <Header title={`Session · ${consoleTab?.title ?? 'no console'}`} onRefresh={() => void refresh()} loading={busy} />
      {error && <div className="message sev-error sf-banner" role="alert">{error}</div>}
      <div className="sf-chips" role="group" aria-label="Session context">
        {chip('warehouse', 'Warehouse', ctx?.warehouse ?? null, (warehouses.data ?? []).map((w) => w.name))}
        {chip('role', 'Role', ctx?.role ?? null, (roles.data ?? []).map((r: SnowflakeRole) => r.name))}
        {chip('database', 'Database', ctx?.database ?? null, dbs.data?.databases ?? [])}
        {chip('schema', 'Schema', ctx?.schema ?? null, (schemas.data?.schemas ?? []).map((s) => s.name))}
      </div>
      {ctx && (
        <dl className="sf-props">
          <dt>Session</dt><dd className="mono">{ctx.sessionId ?? '—'}</dd>
          <dt>Secondary roles</dt><dd className="mono">{ctx.secondaryRoles ?? '—'}</dd>
        </dl>
      )}
      <p className="muted sf-hint">The chips run USE WAREHOUSE / ROLE / DATABASE / SCHEMA on the console's own session; other tabs keep theirs.</p>
    </div>
  );
}

// ---------------------------------------------------------------- warehouses

export function WarehousesView(p: TabViewProps) {
  const cid = p.tab.connectionId ?? '';
  const { data, error, loading, reload } = useLoad(() => api.snowflake.warehouses(cid), [cid]);
  const act = async (w: SnowflakeWarehouse, action: 'resume' | 'suspend') => {
    if (action === 'suspend') {
      const ok = await useUi.getState().askConfirm({ title: `Suspend ${w.name}`, confirmLabel: 'Suspend', message: `Running queries on ${w.name} finish first; queued ones resume it again when auto-resume is on.` });
      if (!ok) return;
    }
    try {
      await api.snowflake.warehouseAction(cid, w.name, action);
      toast('success', `${action === 'resume' ? 'Resumed' : 'Suspended'} ${w.name}`);
      reload();
    } catch (e) {
      toast('error', `Could not ${action} ${w.name}`, errorMessage(e));
    }
  };
  return (
    <div className="sf-view" onKeyDown={(e) => { if (e.key === 'F5') { e.preventDefault(); reload(); } }}>
      <Header title="Warehouses" onRefresh={reload} loading={loading} />
      {error && <div className="message sev-error sf-banner" role="alert">{error}</div>}
      <div className="sf-table-wrap">
        <table className="sf-table" aria-label="Warehouses">
          <thead><tr><th>Name</th><th>State</th><th>Size</th><th>Clusters</th><th>Running</th><th>Queued</th><th>Auto-suspend</th><th>Owner</th><th>Comment</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {(data ?? []).map((w) => (
              <tr key={w.name} className={w.isCurrent ? 'sf-current' : undefined}>
                <td className="mono">{w.name}{w.isCurrent && <span className="pill pill-muted sf-pill">current</span>}</td>
                <td><span className={`sf-state sf-state-${w.state.toLowerCase()}`}>{w.state.toLowerCase()}</span></td>
                <td>{w.size ?? ''}</td>
                <td className="tabular">{w.minClusters === w.maxClusters ? w.maxClusters : `${w.minClusters}–${w.maxClusters}`}{w.scalingPolicy ? ` · ${w.scalingPolicy.toLowerCase()}` : ''}</td>
                <td className="tabular">{w.running ?? ''}</td>
                <td className={`tabular ${(w.queued ?? 0) > 0 ? 'text-warning' : ''}`}>{w.queued ?? ''}</td>
                <td className="tabular">{w.autoSuspendSeconds ? `${w.autoSuspendSeconds} s` : 'never'}{w.autoResume ? ' · auto-resume' : ''}</td>
                <td>{w.owner ?? ''}</td>
                <td className="muted">{w.comment ?? ''}</td>
                <td className="sf-actions">
                  {w.state === 'SUSPENDED'
                    ? <button className="btn btn-xs" disabled={readOnly(cid)} onClick={() => void act(w, 'resume')}><Play size={12} /> Resume</button>
                    : <button className="btn btn-xs" disabled={readOnly(cid)} onClick={() => void act(w, 'suspend')}><Pause size={12} /> Suspend</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <div className="muted sf-empty">No warehouse is visible to this role.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- schema objects

const KINDS: { kind: SnowflakeObjectKind; label: string }[] = [
  { kind: 'stages', label: 'Stages' }, { kind: 'streams', label: 'Streams' }, { kind: 'tasks', label: 'Tasks' }, { kind: 'pipes', label: 'Pipes' },
  { kind: 'fileformats', label: 'File formats' }, { kind: 'dynamictables', label: 'Dynamic tables' }, { kind: 'alerts', label: 'Alerts' },
];

export function ObjectsView(p: TabViewProps) {
  const cid = p.tab.connectionId ?? '';
  const st = stateOf(p);
  const kind = (st.kind as SnowflakeObjectKind | undefined) ?? 'stages';
  const conn = getConnection(cid);
  const database = st.database ?? (conn?.props.database as string | undefined)?.toUpperCase() ?? undefined;
  const schema = st.schema ?? (conn?.props.schema as string | undefined)?.toUpperCase() ?? undefined;
  const { data, error, loading, reload } = useLoad<SnowflakeObjectsResponse>(() => api.snowflake.objects(cid, kind, database, schema), [cid, kind, database, schema]);
  const [selected, setSelected] = useState<SnowflakeObject | null>(null);
  const [ddl, setDdl] = useState<SnowflakeDdlResponse | null>(null);
  useEffect(() => { setSelected(null); setDdl(null); }, [kind, database, schema]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    api.snowflake.objectDdl(cid, kind, selected.name, data?.database, data?.schema).then((d) => { if (live) setDdl(d); }, (e) => toast('error', 'Could not read the DDL', errorMessage(e)));
    return () => { live = false; };
  }, [cid, kind, selected, data?.database, data?.schema]);

  const act = async (o: SnowflakeObject, action: string) => {
    try {
      const r = await api.snowflake.objectAction(cid, { kind, name: o.name, action, database: data?.database, schema: data?.schema });
      toast('success', `${action} ${o.name}`, r.message ?? undefined);
      reload();
    } catch (e) {
      toast('error', `Could not ${action} ${o.name}`, errorMessage(e));
    }
  };
  const detailKeys = useMemo(() => [...new Set((data?.items ?? []).flatMap((o) => Object.keys(o.details)))].slice(0, 4), [data]);

  return (
    <div className="sf-view">
      <Header title={`Objects · ${data?.database ?? database ?? ''}.${data?.schema ?? schema ?? ''}`} onRefresh={reload} loading={loading}>
        <div className="sf-kinds" role="tablist" aria-label="Object kind">
          {KINDS.map((k) => (
            <button key={k.kind} role="tab" aria-selected={k.kind === kind} className={`sf-kind ${k.kind === kind ? 'active' : ''}`} onClick={() => patch(p.tab.id, { kind: k.kind })}>{k.label}</button>
          ))}
        </div>
        <input className="input sf-narrow mono" aria-label="Database" placeholder="Database" defaultValue={database ?? ''} onBlur={(e) => patch(p.tab.id, { database: e.target.value.trim() || null })} />
        <input className="input sf-narrow mono" aria-label="Schema" placeholder="Schema" defaultValue={schema ?? ''} onBlur={(e) => patch(p.tab.id, { schema: e.target.value.trim() || null })} />
      </Header>
      {error && <div className="message sev-error sf-banner" role="alert">{error}</div>}
      {data?.note && <div className="message sev-warning sf-banner">{data.note}</div>}
      <div className="sf-split">
        <div className="sf-table-wrap">
          <table className="sf-table" aria-label={kind}>
            <thead><tr><th>Name</th><th>State</th>{detailKeys.map((k) => <th key={k}>{k.replace(/_/g, ' ')}</th>)}<th>Owner</th><th>Comment</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {(data?.items ?? []).map((o) => (
                <tr key={o.name} aria-selected={selected?.name === o.name} className={selected?.name === o.name ? 'sf-selected' : undefined} onClick={() => setSelected(o)}>
                  <td className="mono">{o.name}</td>
                  <td>{o.state ?? ''}</td>
                  {detailKeys.map((k) => <td key={k} className="mono sf-clip" title={o.details[k]}>{o.details[k] ?? ''}</td>)}
                  <td>{o.owner ?? ''}</td>
                  <td className="muted">{o.comment ?? ''}</td>
                  <td className="sf-actions">
                    {(OBJECT_ACTIONS[kind] ?? []).map((a) => (
                      <button key={a} className="btn btn-xs" disabled={readOnly(cid)} onClick={(e) => { e.stopPropagation(); void act(o, a); }}>{a === 'execute' ? <Zap size={12} /> : null}{a}</button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.items.length && !data.note && <div className="muted sf-empty">No {KINDS.find((k) => k.kind === kind)?.label.toLowerCase()} in this schema.</div>}
        </div>
        {selected && (
          <div className="sf-ddl" aria-label={`DDL of ${selected.name}`}>
            <div className="sf-ddl-head">
              <Code2 size={14} /> <span className="mono">{selected.name}</span>
              <span className="flex-1" />
              {ddl && <button className="btn btn-xs" onClick={() => newConsole(cid, data?.database ?? null, ddl.ddl)}><TerminalSquare size={12} /> Open in console</button>}
            </div>
            <pre className="sf-ddl-text mono">{ddl?.ddl ?? '…'}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- query history

const LEVEL_CLASS: Record<string, string> = { error: 'text-danger', fatal: 'text-danger', warn: 'text-warning' };

export function HistoryView(p: TabViewProps) {
  const cid = p.tab.connectionId ?? '';
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useLoad(
    () => api.logs.query(cid, { sourceId: 'query_history', limit: 500, levels: onlyErrors ? ['error'] : undefined, q: q.trim() || undefined }),
    [cid, onlyErrors, q],
  );
  const rows: LogEntry[] = useMemo(() => [...(data?.entries ?? [])].reverse(), [data]);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="sf-view" onKeyDown={(e) => { if (e.key === 'F5') { e.preventDefault(); reload(); } }}>
      <Header title="Query history" onRefresh={reload} loading={loading}>
        <input className="input sf-search" type="search" aria-label="Filter" placeholder="Filter text, user, warehouse…" defaultValue={q} onKeyDown={(e) => { if (e.key === 'Enter') setQ((e.target as HTMLInputElement).value); }} />
        <label className="check"><input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Errors only</label>
      </Header>
      {error && <div className="message sev-error sf-banner" role="alert">{error}</div>}
      <div className="sf-table-wrap">
        <table className="sf-table compact" aria-label="Query history">
          <thead><tr><th>Start</th><th>Status</th><th>Duration</th><th>Scanned</th><th>Rows</th><th>Warehouse</th><th>User</th><th>Query</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {rows.map((e) => {
              const f = e.fields ?? {};
              return (
                <tr key={e.seq} onClick={() => setOpen(open === e.seq ? null : e.seq)} aria-expanded={open === e.seq}>
                  <td className="tabular">{e.ts ? new Date(e.ts).toLocaleString('en-GB', { hour12: false }) : ''}</td>
                  <td className={LEVEL_CLASS[e.level] ?? ''}>{(f.status ?? e.level).toLowerCase().replace(/_/g, ' ')}</td>
                  <td className="tabular">{formatMs(f.elapsedMs)}</td>
                  <td className="tabular">{formatBytes(f.bytesScanned)}</td>
                  <td className="tabular">{f.rows ?? ''}</td>
                  <td>{f.warehouse ?? ''}</td>
                  <td>{f.user ?? ''}</td>
                  <td className="mono sf-clip">
                    {e.message}
                    {open === e.seq && e.detail && <pre className="sf-detail">{e.detail}</pre>}
                  </td>
                  <td className="sf-actions">
                    <button className="icon-btn" aria-label="Open in console" title="Open in console" onClick={(ev) => { ev.stopPropagation(); newConsole(cid, f.database ?? null, queryText(e)); }}><TerminalSquare size={13} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && !rows.length && <div className="muted sf-empty">No queries in the window.</div>}
      </div>
    </div>
  );
}

export default function SnowflakeViews(p: TabViewProps) {
  switch (p.tab.view) {
    case SF_VIEWS.session: return <SessionView {...p} />;
    case SF_VIEWS.warehouses: return <WarehousesView {...p} />;
    case SF_VIEWS.objects: return <ObjectsView {...p} />;
    default: return <HistoryView {...p} />;
  }
}

import { ChevronDown, CircleStop, GitCommitHorizontal, ListEnd, LoaderCircle, Play, Plus, RotateCcw } from 'lucide-react';
import type { TxMode } from '../../api/types';
import {
  cancelTab, commitTab, effectiveDatabase, rollbackTab, runActive, setTxMode, switchConnection, switchDatabase,
} from '../../app/actions';
import { formatCount } from '../../lib/format';
import { useCatalog, dbKey } from '../../store/catalog';
import { useConnection, useConnections } from '../../store/connections';
import { useTabExecution } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { useTabSession } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs, type ConsoleTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { showMenuBelow, type MenuItem } from '../common/Menu';
import { ProviderIcon } from '../common/icons';

const MAX_ROWS_OPTIONS = [500, 1000, 10000, 100000, 0];

export function maxRowsLabel(n: number) {
  return n === 0 ? 'No limit' : formatCount(n);
}

/** Per-console toolbar: connection, database, transaction mode, run controls and row limit. */
export function Toolbar({ tab }: { tab: ConsoleTab }) {
  const conn = useConnection(tab.connectionId);
  const connections = useConnections((s) => s.connections);
  const session = useTabSession(tab.id);
  const exec = useTabExecution(tab.id);
  const running = isRunning(exec);
  const defaultMax = useSettings((s) => s.settings.results.maxRows);
  const setMaxRows = useTabs((s) => s.setMaxRows);
  const openDialog = useUi((s) => s.openConnectionDialog);
  const connCat = useCatalog((s) => (tab.connectionId ? s.conns[tab.connectionId] : undefined));
  const oracleSchemas = useCatalog((s) => (tab.connectionId && conn?.providerId === 'oracle' ? s.dbs[dbKey(tab.connectionId, null)]?.schemasResp : undefined));

  const txMode: TxMode = session?.txMode ?? tab.txMode;
  const txOpen = !!session?.txOpen;
  const maxRows = tab.maxRows ?? defaultMax;

  const pickConnection = (el: HTMLElement) => {
    const byFolder = new Map<string, typeof connections>();
    for (const c of connections) {
      const f = c.folder ?? '';
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f)!.push(c);
    }
    const items: MenuItem[] = [];
    for (const [folder, list] of [...byFolder.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))) {
      if (folder) items.push({ label: folder, disabled: true });
      for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
        items.push({
          label: c.name,
          icon: <ProviderIcon providerId={c.providerId} color={c.color} size={14} />,
          checked: c.id === tab.connectionId,
          onClick: () => void switchConnection(tab.id, c.id),
        });
      }
    }
    if (items.length) items.push({ separator: true });
    items.push({ label: 'New connection…', icon: <Plus size={14} />, onClick: () => openDialog({ mode: 'new' }) });
    showMenuBelow(el, items);
  };

  // Database selector: SQL Server databases, Oracle schemas (ALTER SESSION SET CURRENT_SCHEMA), hidden for SQLite.
  let dbOptions: string[] = [];
  let current: string | null = null;
  if (conn?.providerId === 'sqlserver') {
    dbOptions = connCat?.databases?.databases ?? [];
    current = effectiveDatabase(conn.id, tab.database) ?? session?.database ?? null;
  } else if (conn?.providerId === 'oracle') {
    dbOptions = (oracleSchemas?.schemas ?? []).map((s) => s.name);
    current = tab.database ?? session?.database ?? oracleSchemas?.defaultSchema ?? null;
  }
  if (current && !dbOptions.includes(current)) dbOptions = [current, ...dbOptions];
  const pickDatabase = (el: HTMLElement) => {
    if (conn?.providerId === 'oracle' && !oracleSchemas) void useCatalog.getState().loadSchemas(conn.id, null);
    showMenuBelow(el, dbOptions.map((d) => ({ label: d, checked: d === current, onClick: () => void switchDatabase(tab.id, d) })));
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Console toolbar">
      <button
        className="tb-select conn-select"
        onClick={(e) => pickConnection(e.currentTarget)}
        title="Connection of this console"
        aria-label="Connection"
        style={conn?.color ? { boxShadow: `inset 3px 0 0 ${conn.color}` } : undefined}
      >
        {conn ? <ProviderIcon providerId={conn.providerId} color={null} size={14} /> : null}
        <span className={conn ? '' : 'muted'}>{conn?.name ?? 'Select connection'}</span>
        {conn?.readOnly && <span className="pill pill-muted">RO</span>}
        <ChevronDown size={13} />
      </button>
      {conn && conn.providerId !== 'sqlite' && (
        <button className="tb-select" onClick={(e) => pickDatabase(e.currentTarget)} title={conn.providerId === 'oracle' ? 'Current schema' : 'Database'} aria-label="Database">
          <span>{current ?? (conn.providerId === 'oracle' ? 'schema' : 'database')}</span>
          <ChevronDown size={13} />
        </button>
      )}
      <div className="tb-sep" />
      <button className="btn btn-run" onClick={() => runActive('statement')} disabled={!conn || running} title="Run statement at cursor or selection (Ctrl+Enter)">
        <Play size={13} fill="currentColor" /> Run
      </button>
      <button className="icon-btn" onClick={() => runActive('script')} disabled={!conn || running} title="Run script (F5 / Ctrl+Shift+Enter)" aria-label="Run script">
        <ListEnd size={15} />
      </button>
      <button className={`icon-btn${running ? ' danger' : ''}`} onClick={() => void cancelTab(tab.id)} disabled={!running} title="Cancel (Esc)" aria-label="Cancel">
        <CircleStop size={15} />
      </button>
      {running && <LoaderCircle size={14} className="spin text-accent" aria-label="Running" />}
      <div className="tb-sep" />
      <div className="segmented" role="radiogroup" aria-label="Transaction mode">
        {(['auto', 'manual'] as TxMode[]).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={txMode === m}
            className={txMode === m ? 'on' : ''}
            disabled={!conn}
            onClick={() => txMode !== m && void setTxMode(tab.id, m)}
            title={m === 'auto' ? 'Auto-commit every statement' : 'Manual transaction: Commit / Rollback explicitly'}
          >
            {m === 'auto' ? 'Auto' : 'Tx'}
          </button>
        ))}
      </div>
      {txMode === 'manual' && (
        <>
          {txOpen && (
            <span className="pill pill-warning" title="This session has uncommitted changes">
              pending
            </span>
          )}
          <button className="btn btn-xs" onClick={() => void commitTab(tab.id)} disabled={!txOpen || running} title="Commit (Ctrl+Alt+C)">
            <GitCommitHorizontal size={13} /> Commit
          </button>
          <button className="btn btn-xs" onClick={() => void rollbackTab(tab.id)} disabled={!txOpen || running} title="Rollback (Ctrl+Alt+Z)">
            <RotateCcw size={12} /> Rollback
          </button>
        </>
      )}
      <div className="flex-1" />
      <label className="tb-label" htmlFor={`maxrows-${tab.id}`}>
        Max rows
      </label>
      <select
        id={`maxrows-${tab.id}`}
        className="input xs"
        value={String(maxRows)}
        onChange={(e) => setMaxRows(tab.id, Number(e.target.value))}
        title="Row limit per result set"
      >
        {[...new Set([...MAX_ROWS_OPTIONS, maxRows])].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b)).map((n) => (
          <option key={n} value={n}>
            {maxRowsLabel(n)}
          </option>
        ))}
      </select>
    </div>
  );
}

import {
  ChevronDown, CircleStop, Code, Database, GitCommitHorizontal, Layers, ListEnd, LoaderCircle, Lock, Play, RotateCcw, Sparkles,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TxMode } from '../../api/types';
import { effectiveDatabase, setTxMode } from '../../app/actions';
import { displayShortcut } from '../../commands/keys';
import { getCommand, hasCommand } from '../../commands/registry';
import { commandView, useCommandContext } from '../../commands/useCommands';
import { formatCount, formatDuration } from '../../lib/format';
import { dbKey, useCatalog } from '../../store/catalog';
import { useConnection } from '../../store/connections';
import { useTabExecution } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { useTabSession } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs, type ConsoleTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { connColorCss, connColorName, isProductionColor } from '../../theme/connColors';
import { showMenuBelow, type MenuItem } from '../common/Menu';
import { ProviderIcon } from '../common/icons';
import { CommandButton } from '../layout/CommandButton';
import { commandMenuItems } from '../layout/commandMenu';

const MAX_ROWS_OPTIONS = [500, 1000, 10000, 100000, 0];

export function maxRowsLabel(n: number) {
  return n === 0 ? 'No limit' : formatCount(n);
}

/**
 * Per-console toolbar (section 3): Run, Run script, Cancel, Run on…, connection pill, database, tx mode, Explain,
 * Format, Code ▾, row limit. Every button dispatches a registered command.
 */
export function Toolbar({ tab }: { tab: ConsoleTab }) {
  useCommandContext();
  const conn = useConnection(tab.connectionId);
  const session = useTabSession(tab.id);
  const exec = useTabExecution(tab.id);
  const running = isRunning(exec);
  const defaultMax = useSettings((s) => s.settings.results.maxRows);
  const setMaxRows = useTabs((s) => s.setMaxRows);
  const connCat = useCatalog((s) => (tab.connectionId ? s.conns[tab.connectionId] : undefined));
  const oracleSchemas = useCatalog((s) => (tab.connectionId && conn?.providerId === 'oracle' ? s.dbs[dbKey(tab.connectionId, null)]?.schemasResp : undefined));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  const txMode: TxMode = session?.txMode ?? tab.txMode;
  const txOpen = !!session?.txOpen;
  const maxRows = tab.maxRows ?? defaultMax;
  const prod = isProductionColor(conn?.color);

  let current: string | null = null;
  if (conn?.providerId === 'sqlserver') current = effectiveDatabase(conn.id, tab.database) ?? session?.database ?? connCat?.databases?.current ?? null;
  else if (conn?.providerId === 'oracle') current = tab.database ?? session?.database ?? oracleSchemas?.defaultSchema ?? null;

  const openSwitcher = (mode: 'connection' | 'database', el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    useUi.getState().openSwitcher({ tabId: tab.id, mode, anchor: { left: r.left, top: r.top, bottom: r.bottom } });
  };

  const run = commandView('run.statement');
  const explain = getCommand('explain.estimated');
  const codeItems: MenuItem[] = commandMenuItems([
    { command: 'codegen.query', optional: true }, { command: 'codegen.open', optional: true },
  ]);

  return (
    <div className="toolbar console-toolbar" role="toolbar" aria-label="Console toolbar" data-tab={tab.id}>
      <button
        className={`btn btn-run${prod ? ' prod' : ''}`}
        onClick={run.run}
        disabled={!conn || running}
        title={run.tooltip + (prod ? ' — production connection' : '')}
        data-command="run.statement"
      >
        <Play size={14} fill="currentColor" strokeWidth={1.5} /> <span className="btn-text">Run</span>
      </button>
      <CommandButton command="run.script" icon={<ListEnd size={16} strokeWidth={1.5} />} />
      <CommandButton command="run.cancel" icon={<CircleStop size={16} strokeWidth={1.5} />} className={running ? 'danger' : ''} />
      <CommandButton command="run.multi" icon={<Layers size={16} strokeWidth={1.5} />} label="Run on…" variant="ghost" className="tb-text-btn" />
      {running && exec && (
        <span className="tb-timer" aria-live="off">
          <LoaderCircle size={14} className="spin" aria-hidden="true" /> {formatDuration(now - exec.startedAt)}
        </span>
      )}
      <div className="tb-sep" />

      <button
        className="conn-pill"
        onClick={(e) => openSwitcher('connection', e.currentTarget)}
        title={`${conn ? `Connection: ${conn.name}${conn.color ? ` (${connColorName(conn.color)})` : ''}` : 'Choose a connection'} — change with ${displayShortcut('Mod+Shift+K')}`}
        aria-label={conn ? `Connection ${conn.name}, change` : 'Choose a connection'}
        aria-haspopup="dialog"
        style={conn?.color ? ({ ['--conn-color' as string]: connColorCss(conn.color) }) : undefined}
      >
        {conn ? <ProviderIcon providerId={conn.providerId} color={null} size={16} /> : <Sparkles size={16} strokeWidth={1.5} />}
        {conn?.color && <span className="conn-pill-dot" aria-hidden="true" />}
        <span className={`conn-pill-name${conn ? '' : ' muted'}`}>{conn?.name ?? 'Choose connection'}</span>
        {conn?.readOnly && <Lock size={12} aria-label="Read-only" />}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {conn && conn.providerId !== 'sqlite' && (
        <button
          className="db-pill"
          onClick={(e) => openSwitcher('database', e.currentTarget)}
          title={`${conn.providerId === 'oracle' ? 'Current schema' : 'Database'} — change with ${displayShortcut('Mod+Shift+D')}`}
          aria-label={`${conn.providerId === 'oracle' ? 'Schema' : 'Database'} ${current ?? ''}, change`}
          aria-haspopup="dialog"
        >
          <Database size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>{current ?? (conn.providerId === 'oracle' ? 'schema' : 'database')}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
      <div className="segmented" role="radiogroup" aria-label="Transaction mode">
        {(['auto', 'manual'] as TxMode[]).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={txMode === m}
            className={txMode === m ? 'on' : ''}
            disabled={!conn}
            onClick={() => txMode !== m && void setTxMode(tab.id, m)}
            title={m === 'auto' ? 'Auto-commit every statement' : 'Manual transaction: Commit / Roll back explicitly'}
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
          <CommandButton command="tx.commit" icon={<GitCommitHorizontal size={14} strokeWidth={1.5} />} label="Commit" variant="btn" className="btn-xs" />
          <CommandButton command="tx.rollback" icon={<RotateCcw size={14} strokeWidth={1.5} />} label="Rollback" variant="btn" className="btn-xs" />
        </>
      )}
      <div className="tb-sep" />
      {explain && (
        <span className="split-btn">
          <CommandButton command="explain.estimated" label="Explain" variant="ghost" className="tb-text-btn" />
          {hasCommand('explain.actual') && (
            <button
              className="icon-btn split-caret"
              aria-label="More explain options"
              title="Explain options"
              onClick={(e) => showMenuBelow(e.currentTarget, commandMenuItems([{ command: 'explain.estimated' }, { command: 'explain.actual' }]))}
            >
              <ChevronDown size={14} />
            </button>
          )}
        </span>
      )}
      <CommandButton command="format.document" optional icon={<WandSparkles size={16} strokeWidth={1.5} />} label="Format" variant="ghost" className="tb-text-btn" />
      {codeItems.length > 0 && (
        <button
          className="btn btn-ghost tb-text-btn"
          aria-haspopup="menu"
          title="Generate code"
          onClick={(e) => showMenuBelow(e.currentTarget, codeItems)}
        >
          <Code size={16} strokeWidth={1.5} /> <span className="btn-text">Code</span> <ChevronDown size={14} />
        </button>
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


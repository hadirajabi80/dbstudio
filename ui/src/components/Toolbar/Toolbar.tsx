import {
  ChevronDown, CircleStop, Code, Database, GitCommitHorizontal, GitCompare, Layers, ListEnd, LoaderCircle, Lock, Play, RotateCcw, Rows3,
  Sparkles, WandSparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TxMode } from '../../api/types';
import { cancelBlockedReason, effectiveDatabase, setTxMode } from '../../app/actions';
import { getEditor } from '../../app/editors';
import { useDesignerUi } from '../../designer/store';
import { ariaKeyShortcuts, displayShortcut } from '../../commands/keys';
import type { ContextEntry } from '../../commands/menuModel';
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
import { Select } from '../common/Select';
import { CommandButton } from '../layout/CommandButton';
import { commandMenuItems } from '../layout/commandMenu';
import { OverflowToolbar, type OverflowItem } from '../layout/OverflowToolbar';

const MAX_ROWS_OPTIONS = [500, 1000, 10000, 100000, 0];

const CODE_ENTRIES: ContextEntry[] = [{ command: 'codegen.query', optional: true }, { command: 'codegen.open', optional: true }];
/** Explain split-button menu: both modes, each with its shortcut (Ctrl+L / Ctrl+Shift+L). */
const EXPLAIN_ENTRIES: ContextEntry[] = [{ command: 'explain.estimated' }, { command: 'explain.actual', optional: true }];

export function maxRowsLabel(n: number) {
  return n === 0 ? 'No limit' : formatCount(n);
}

/**
 * Per-console toolbar (section 3): Run, Run script, Cancel, Run on…, connection pill, database, tx mode, Explain,
 * Format, Code ▾, Compare (object edits), row limit. Every button dispatches a registered command. On narrow windows
 * or at high zoom the low-priority items (row limit, Code, Explain, Format, Run on…, tx mode) collapse into a "…" menu
 * instead of scrolling.
 */
export function Toolbar({ tab }: { tab: ConsoleTab }) {
  useCommandContext();
  const conn = useConnection(tab.connectionId);
  const session = useTabSession(tab.id);
  const exec = useTabExecution(tab.id);
  const running = isRunning(exec);
  // An "Edit:" console's atomic apply cannot be stopped: Stop is dimmed and says why (features-r1-06).
  const editRunInFlight = useDesignerUi((s) => !!s.editRunInFlight[tab.id]);
  const cancelReason = editRunInFlight ? cancelBlockedReason(tab.id) : null;
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
  const codeItems: MenuItem[] = commandMenuItems(CODE_ENTRIES);
  const compare = commandView('designer.compareWithServer');
  // Commands that act on the editor give the focus back to it (the button would keep it, and typing or Ctrl+L would
  // then go nowhere). Format focuses the editor itself; Explain focuses the plan tab it opens.
  const refocus = () => getEditor(tab.id)?.focus();
  const maxRowsOptions = [...new Set([...MAX_ROWS_OPTIONS, maxRows])].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const dbLabel = conn?.providerId === 'oracle' ? 'schema' : 'database';
  // Explain and Format look like every other enabled toolbar button; they are dimmed only when they truly cannot
  // act, and then say why (user-01).
  const empty = !tab.text.trim();
  const explainReason = !conn ? `choose a connection first (${displayShortcut('Mod+Shift+K')})` : empty ? 'type a statement to explain' : null;
  const formatReason = empty ? 'the editor is empty' : null;

  const items: OverflowItem[] = [
    {
      id: 'run',
      node: (
        <button
          className={`btn btn-run${prod ? ' prod' : ''}`}
          onClick={() => {
            run.run();
            refocus();
          }}
          disabled={!conn || running}
          title={run.tooltip + (prod ? ' — production connection' : '')}
          aria-keyshortcuts={ariaKeyShortcuts(run.shortcut)}
          data-command="run.statement"
        >
          <Play size={14} fill="currentColor" strokeWidth={1.5} /> <span className="btn-text">Run</span>
        </button>
      ),
    },
    { id: 'script', node: <CommandButton command="run.script" icon={<ListEnd size={16} strokeWidth={1.5} />} onRan={refocus} /> },
    { id: 'cancel', node: <CommandButton command="run.cancel" icon={<CircleStop size={16} strokeWidth={1.5} />} className={running && !cancelReason ? 'danger' : ''} disabledReason={cancelReason} onRan={refocus} /> },
    {
      id: 'multi', priority: 3, menu: () => commandMenuItems([{ command: 'run.multi' }]),
      node: <CommandButton command="run.multi" icon={<Layers size={16} strokeWidth={1.5} />} label="Run on…" variant="ghost" className="tb-text-btn" />,
    },
  ];
  if (running && exec) {
    items.push({
      id: 'timer',
      node: (
        <span className="tb-timer" aria-live="off">
          <LoaderCircle size={14} className="spin" aria-hidden="true" /> {formatDuration(now - exec.startedAt)}
        </span>
      ),
    });
  }
  items.push({ id: 'sep1', separator: true }, {
    id: 'conn',
    node: (
      <button
        className="conn-pill"
        onClick={(e) => openSwitcher('connection', e.currentTarget)}
        title={`${conn ? `Connection: ${conn.name}${conn.color ? ` (${connColorName(conn.color)})` : ''}` : 'Choose a connection'} — change with ${displayShortcut('Mod+Shift+K')}`}
        aria-label={conn ? `Connection ${conn.name}, change` : 'Choose a connection'}
        aria-haspopup="dialog"
        aria-keyshortcuts={ariaKeyShortcuts('Mod+Shift+K')}
        style={conn?.color ? ({ ['--conn-color' as string]: connColorCss(conn.color) }) : undefined}
      >
        {conn ? <ProviderIcon providerId={conn.providerId} color={null} size={16} /> : <Sparkles size={16} strokeWidth={1.5} />}
        {conn?.color && <span className="conn-pill-dot" aria-hidden="true" />}
        <span className={`conn-pill-name${conn ? '' : ' muted'}`}>{conn?.name ?? 'Choose connection'}</span>
        {conn?.readOnly && <Lock size={12} aria-label="Read-only" />}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    ),
  });
  if (conn && conn.providerId !== 'sqlite') {
    items.push({
      id: 'db', priority: 6,
      menu: () => commandMenuItems([{ command: 'connections.changeDatabase', label: `Change ${dbLabel}${current ? ` (${current})` : ''}…` }]),
      node: (
        <button
          className="db-pill"
          onClick={(e) => openSwitcher('database', e.currentTarget)}
          title={`${conn.providerId === 'oracle' ? 'Current schema' : 'Database'} — change with ${displayShortcut('Mod+Shift+D')}`}
          aria-label={`${conn.providerId === 'oracle' ? 'Schema' : 'Database'} ${current ?? ''}, change`}
          aria-haspopup="dialog"
          aria-keyshortcuts={ariaKeyShortcuts('Mod+Shift+D')}
        >
          <Database size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>{current ?? dbLabel}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      ),
    });
  }
  items.push({
    id: 'tx', priority: 4,
    menu: () => (['auto', 'manual'] as TxMode[]).map((m): MenuItem => ({
      id: `tx.${m}`, label: m === 'auto' ? 'Auto-commit' : 'Manual transaction', checked: txMode === m, disabled: !conn,
      onClick: () => {
        if (txMode !== m) void setTxMode(tab.id, m);
      },
    })),
    node: (
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
    ),
  });
  if (txMode === 'manual') {
    items.push({
      id: 'txActions', priority: 9, menu: () => commandMenuItems([{ command: 'tx.commit' }, { command: 'tx.rollback' }]),
      node: (
        <>
          {txOpen && (
            <span className="pill pill-warning" title="This session has uncommitted changes">
              pending
            </span>
          )}
          <CommandButton command="tx.commit" icon={<GitCommitHorizontal size={14} strokeWidth={1.5} />} label="Commit" variant="btn" className="btn-xs" />
          <CommandButton command="tx.rollback" icon={<RotateCcw size={14} strokeWidth={1.5} />} label="Rollback" variant="btn" className="btn-xs" />
        </>
      ),
    });
  }
  items.push({ id: 'sep2', separator: true });
  if (explain) {
    items.push({
      id: 'explain', priority: 2, menu: () => commandMenuItems(EXPLAIN_ENTRIES),
      node: (
        <span className="split-btn">
          <CommandButton command="explain.estimated" label="Explain" variant="ghost" className="tb-text-btn" disabledReason={explainReason} />
          {hasCommand('explain.actual') && (
            <button
              className={`icon-btn split-caret${explainReason ? ' unavailable' : ''}`}
              aria-label="More explain options"
              aria-haspopup="menu"
              aria-disabled={explainReason ? true : undefined}
              title={explainReason ? `Explain options: ${explainReason}` : 'Explain options'}
              onClick={(e) => !explainReason && showMenuBelow(e.currentTarget, commandMenuItems(EXPLAIN_ENTRIES))}
            >
              <ChevronDown size={14} />
            </button>
          )}
        </span>
      ),
    });
  }
  if (hasCommand('format.document')) {
    items.push({
      id: 'format', priority: 2, menu: () => commandMenuItems([{ command: 'format.document' }]),
      node: <CommandButton command="format.document" icon={<WandSparkles size={16} strokeWidth={1.5} />} label="Format" variant="ghost" className="tb-text-btn" disabledReason={formatReason} />,
    });
  }
  if (codeItems.length > 0) {
    items.push({
      id: 'code', priority: 1,
      menu: () => [{ id: 'code', label: 'Generate code', icon: <Code size={14} strokeWidth={1.5} />, submenu: commandMenuItems(CODE_ENTRIES) }],
      node: (
        <button className="btn btn-ghost tb-text-btn" aria-haspopup="menu" title="Generate code" onClick={(e) => showMenuBelow(e.currentTarget, codeItems)}>
          <Code size={16} strokeWidth={1.5} /> <span className="btn-text">Code</span> <ChevronDown size={14} />
        </button>
      ),
    });
  }
  // Only while the console edits an object script (F4): compare the editor text with the server definition.
  if (compare.command && compare.enabled) {
    items.push({
      id: 'compare', priority: 5, menu: () => commandMenuItems([{ command: 'designer.compareWithServer' }]),
      node: <CommandButton command="designer.compareWithServer" icon={<GitCompare size={16} strokeWidth={1.5} />} label="Compare" variant="ghost" className="tb-text-btn" />,
    });
  }
  items.push({ id: 'spacer', spacer: true }, {
    id: 'maxRows', priority: 0,
    menu: () => [{
      id: 'maxRows', label: `Max rows: ${maxRowsLabel(maxRows)}`, icon: <Rows3 size={14} strokeWidth={1.5} />,
      submenu: maxRowsOptions.map((n): MenuItem => ({ id: `maxRows.${n}`, label: maxRowsLabel(n), checked: n === maxRows, onClick: () => setMaxRows(tab.id, n) })),
    }],
    node: (
      <>
        <label className="tb-label" htmlFor={`maxrows-${tab.id}`}>
          Max rows
        </label>
        {/* Toolbar height (--input-h, styles-r1-06). The Rows3 icon shows only when the container query hides the label. */}
        <Select
          id={`maxrows-${tab.id}`}
          className="tb-maxrows"
          value={maxRows}
          options={maxRowsOptions.map((n) => ({ value: n, label: maxRowsLabel(n) }))}
          onChange={(n) => setMaxRows(tab.id, n)}
          title="Max rows"
          aria-label="Max rows"
          leadingIcon={<Rows3 size={14} strokeWidth={1.5} className="tb-maxrows-icon" />}
          searchable={false}
        />
      </>
    ),
  });

  return <OverflowToolbar className="console-toolbar" ariaLabel="Console toolbar" data-tab={tab.id} items={items} />;
}

// The statement behind a result grid, in the grid's status row: one muted monospace line (ellipsis, full text on
// hover), Copy (values inlined) and Open in console; "…" / right-click adds "Copy with parameters" when it had binds.
import { Check, Copy, Ellipsis, SquareTerminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { runCommand } from '../../commands/registry';
import { showContextMenu, showMenuBelow } from '../common/Menu';
import { commandMenuItems } from '../layout/commandMenu';
import { RESULTS_QUERY_MENU } from './commands';
import { hasBinds, runnableSql, setExecutedQuery, type ExecutedQuery } from './executedQuery';
import './executedQuery.css';

const COPIED_MS = 1500;

export function ExecutedQueryLine({ gridKey, query }: { gridKey: string; query: ExecutedQuery | null }) {
  // The query the "Copied" confirmation belongs to (a new query clears it without an effect).
  const [copiedFor, setCopiedFor] = useState<ExecutedQuery | null>(null);
  const copied = !!query && copiedFor === query;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = useMemo(() => (query ? runnableSql(query) : null), [query]);

  // Publish the query for the results.* commands (palette, menus) under this grid's key.
  useEffect(() => {
    setExecutedQuery(gridKey, query);
    return () => setExecutedQuery(gridKey, null);
  }, [gridKey, query]);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!query || !shown || !query.sql.trim()) return null;
  const args = { gridKey };
  const full = shown.sql.trim();
  const oneLine = full.replace(/\s+/g, ' ');
  const copyTip = copied ? 'Copied' : shown.inlined ? 'Copy query (values inlined)' : 'Copy query';
  const menu = () => commandMenuItems(RESULTS_QUERY_MENU, args);
  const copy = () => {
    if (!runCommand('results.copyQuery', args)) return;
    setCopiedFor(query);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopiedFor(null), COPIED_MS);
  };

  return (
    <span className="rs-query" role="group" aria-label="Executed query" onContextMenu={(e) => showContextMenu(e, menu())}>
      <span className="rs-query-text muted mono" dir="auto" title={full}>
        {oneLine}
      </span>
      <button
        type="button"
        className={`icon-btn rs-query-btn rs-query-copy${copied ? ' copied' : ''}`}
        title={copyTip}
        aria-label={copied ? 'Copied' : 'Copy query'}
        onClick={copy}
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="icon-btn rs-query-btn rs-query-console"
        title="Open in console"
        aria-label="Open in console"
        onClick={() => runCommand('results.openQueryInConsole', args)}
      >
        <SquareTerminal size={12} aria-hidden="true" />
      </button>
      {hasBinds(query) && (
        <button
          type="button"
          className="icon-btn rs-query-btn rs-query-more"
          title="More query actions"
          aria-label="More query actions"
          aria-haspopup="menu"
          onClick={(e) => showMenuBelow(e.currentTarget, menu())}
        >
          <Ellipsis size={12} aria-hidden="true" />
        </button>
      )}
      <span className="sr-only" aria-live="polite">{copied ? 'Query copied' : ''}</span>
    </span>
  );
}

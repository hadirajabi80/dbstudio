// Workbench (`redis.workbench`, docs/PLAN-M2.md 5.4): a command editor (dbstudio-redis language: completion of
// commands, sub-commands, keywords and cached key names, hover docs, argument hints) with Ctrl+Enter (line or
// selection) and F5 (all lines); one result card per command: echo, elapsed, redis-cli text, a table for array /
// hash-like replies, pretty JSON for JSON bulk replies, Copy. SELECT is tracked (the database follows the batch).
import { displayShortcut } from '../../commands/keys';
import { Copy, Lock, Play, ListEnd, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../../api/client';
import type { RedisCommandResult } from '../../api/types';
import { copyText } from '../../app/actions';
import { commandLines, tryParseArgs } from '../../redis/args';
import { findCommand } from '../../redis/catalog';
import { prettyJson, replyTable, replyText, type ReplyTable } from '../../redis/format';
import { useTabs } from '../../store/tabs';
import { Select } from '../common/Select';
import type { TabViewProps } from '../layout/tabViews';
import { CodeEditor } from './CodeEditor';
import type { WorkbenchState } from './open';
import { cachedKeyNames, errorText, loadHistory, loadServer, pushHistory, useRedis } from './store';
import { useRedisViewEvents } from './viewEvents';

export interface RunCard {
  id: number;
  command: string;
  args: string[];
  db: number;
  result: RedisCommandResult;
  at: number;
}

const MAX_CARDS = 100;
let cardSeq = 0;

export const WORKBENCH_SAMPLE = [
  `# Redis Workbench: ${displayShortcut('Mod+Enter')} runs the line or selection, F5 runs every line.`,
  `# Completion: commands, arguments and key names (${displayShortcut('MacCtrl+Space')}). Hover a command for its docs.`,
  'PING',
  'INFO server',
  'SCAN 0 MATCH user:* COUNT 1000',
  'HGETALL user:1001:profile',
].join('\n');

/** Runs command lines; returns one card per line (blocked/read-only refusals become error cards). */
export async function runLines(cid: string, db: number, lines: string[]): Promise<{ cards: RunCard[]; db: number }> {
  try {
    const r = await api.redis.commands(cid, { db, raw: lines });
    let cur = db;
    const cards = r.results.map((result, i) => {
      const args = tryParseArgs(lines[i]) ?? [lines[i]];
      const card = { id: ++cardSeq, command: lines[i], args, db: cur, result, at: Date.now() };
      if (result.ok && args[0]?.toUpperCase() === 'SELECT') cur = Number(args[1]);
      return card;
    });
    return { cards, db: r.db ?? cur };
  } catch (e) {
    const message = e instanceof ApiError ? e.message : errorText(e);
    return { cards: [{ id: ++cardSeq, command: lines.join('\n'), args: [], db, result: { ok: false, type: 'error', value: message, elapsedMs: 0 }, at: Date.now() }], db };
  }
}

function TableView({ t }: { t: ReplyTable }) {
  return (
    <div className="redis-table-wrap redis-result-table">
      <table className="redis-table compact">
        <thead><tr>{t.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{t.rows.slice(0, 1000).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="mono redis-cell-clip" title={c}>{c}</td>)}</tr>)}</tbody>
      </table>
      {t.rows.length > 1000 && <div className="muted">Showing 1,000 of {t.rows.length.toLocaleString('en-US')} rows (Text shows everything).</div>}
    </div>
  );
}

export function ResultCard({ card }: { card: RunCard }) {
  const spec = findCommand(card.args);
  const table = useMemo(() => (card.result.ok ? replyTable(spec?.name ?? card.args[0]?.toUpperCase() ?? '', card.args, card.result.value) : null), [card, spec]);
  const json = useMemo(() => (card.result.ok && card.result.type === 'bulk' && typeof card.result.value === 'string' ? prettyJson(card.result.value) : null), [card]);
  const [mode, setMode] = useState<'text' | 'table' | 'json'>(json ? 'json' : table && table.rows.length > 1 ? 'table' : 'text');
  const text = replyText(card.result);
  return (
    <article className={`redis-card ${card.result.ok ? '' : 'error'}`} aria-label={`Result of ${card.command}`}>
      <header>
        <code className="redis-card-cmd" title={card.command}>{card.command}</code>
        <span className="muted tabular">db{card.db} · {card.result.elapsedMs} ms</span>
        <span className="flex-1" />
        {(table || json) && card.result.ok && (
          <div className="segmented" role="group" aria-label="Result view">
            <button className={mode === 'text' ? 'on' : ''} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Text</button>
            {table && <button className={mode === 'table' ? 'on' : ''} aria-pressed={mode === 'table'} onClick={() => setMode('table')}>Table</button>}
            {json && <button className={mode === 'json' ? 'on' : ''} aria-pressed={mode === 'json'} onClick={() => setMode('json')}>JSON</button>}
          </div>
        )}
        <button className="icon-btn" aria-label="Copy result" title="Copy" onClick={() => void copyText(mode === 'json' && json ? json : text, 'Result copied')}><Copy size={14} /></button>
      </header>
      {mode === 'table' && table ? <TableView t={table} /> : <pre className={`redis-card-body mono ${card.result.ok ? '' : 'redis-error-text'}`}>{mode === 'json' && json ? json : text}</pre>}
    </article>
  );
}

export function WorkbenchView({ tab, theme }: TabViewProps) {
  const cid = tab.connectionId ?? '';
  const st = tab.state as WorkbenchState;
  const server = useRedis((s) => s.conns[cid]?.server.data);
  useEffect(() => {
    void loadServer(cid);
  }, [cid]);
  const [text, setText] = useState(st.text || WORKBENCH_SAMPLE);
  const [cards, setCards] = useState<RunCard[]>([]);
  const [running, setRunning] = useState(false);
  const [db, setDb] = useState(st.db ?? 0);
  const [history, setHistory] = useState(() => loadHistory(cid));
  const dbRef = useRef(db);
  dbRef.current = db;
  const textRef = useRef(text);
  textRef.current = text;

  // persist the editor text (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      const cur = useTabs.getState().tabs.find((x) => x.id === tab.id);
      if (cur?.kind === 'view') useTabs.getState().updateView(tab.id, { state: { ...(cur.state as object), text, db } });
    }, 400);
    return () => clearTimeout(t);
  }, [text, db, tab.id]);

  const run = useCallback(async (source: string) => {
    const lines = commandLines(source).map((l) => l.line);
    if (!lines.length || running) return;
    setRunning(true);
    try {
      const r = await runLines(cid, dbRef.current, lines);
      setCards((c) => [...r.cards, ...c].slice(0, MAX_CARDS));
      setDb(r.db);
      setHistory(pushHistory(cid, lines));
    } finally {
      setRunning(false);
    }
  }, [cid, running]);

  const editorSel = useRef<{ text: string } | null>(null);
  useRedisViewEvents(tab.id, (a) => {
    if (a === 'runAll') void run(textRef.current);
    else if (a === 'runLine') void run(editorSel.current?.text ?? textRef.current.split('\n')[0] ?? '');
    else if (a === 'clear') setCards([]);
  });

  const keys = useCallback(() => cachedKeyNames(cid, dbRef.current), [cid]);
  const readOnly = server?.readOnly;
  return (
    <div className="redis-view redis-workbench" data-command-scope="redisWorkbench">
      <div className="redis-toolbar" role="toolbar" aria-label="Workbench">
        {server?.mode !== 'cluster' && (
          <Select size="sm" aria-label="Database" mono value={db} onChange={(v) => setDb(Number(v))}
            options={Array.from({ length: server?.databases ?? 16 }, (_, i) => ({ value: i, label: `db${i}` }))} />
        )}
        <button className="btn btn-xs btn-primary" disabled={running} onClick={() => void run(editorSel.current?.text ?? textRef.current)} title={`Run line or selection (${displayShortcut('Mod+Enter')})`}><Play size={13} /> Run</button>
        <button className="btn btn-xs" disabled={running} onClick={() => void run(textRef.current)} title="Run all lines (F5)"><ListEnd size={13} /> Run all</button>
        <Select size="sm" aria-label="History" value={null} placeholder={`History (${history.length})`} searchable menuMinWidth={360}
          options={[...history].reverse().map((h) => ({ value: h, label: h }))} mono
          onChange={(v) => setText((t) => `${t.replace(/\n*$/, '')}\n${v}`)} />
        <span className="flex-1" />
        {readOnly && <span className="pill pill-muted" title="Only read commands run on this connection"><Lock size={11} /> read-only</span>}
        <button className="btn btn-xs" disabled={!cards.length} onClick={() => setCards([])}><Trash2 size={13} /> Clear results</button>
      </div>
      <div className="redis-workbench-split">
        <div className="redis-workbench-editor">
          <CodeEditor value={text} onChange={setText} language="redis" theme={theme} ariaLabel="Redis commands" keys={keys} autoFocus
            onRunSelection={(t) => { editorSel.current = { text: t }; void run(t); }} onRunAll={() => void run(textRef.current)} />
        </div>
        <div className="redis-results" aria-label="Results" aria-live="polite">
          {running && <div className="muted redis-running" role="status">Running…</div>}
          {!cards.length && !running && <div className="redis-empty muted">Results appear here, newest first.</div>}
          {cards.map((c) => <ResultCard key={c.id} card={c} />)}
        </div>
      </div>
    </div>
  );
}

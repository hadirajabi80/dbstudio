import { CircleAlert, CircleCheck, CircleSlash, Copy, Info, Lightbulb, Terminal, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { copyText } from '../../app/actions';
import { getEditor } from '../../app/editors';
import { runCommand } from '../../commands/registry';
import { useCatalog } from '../../store/catalog';
import type { ExecMessage, ExecutionState } from '../../store/resultsReducer';
import { useTabs } from '../../store/tabs';
import { toast } from '../../store/ui';
import { pluralize } from '../common/text';
import { didYouMean, errorHelp, replaceIdentifier } from './errorHelp';

const ICON = { info: Info, warning: TriangleAlert, error: CircleAlert };

function time(ts: number) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const SUMMARY_RE = /^(Completed|Cancelled|Finished with errors) in /;

/** The run summary ("Finished with errors in 11 ms · …") that the reducer appends at exec.done. */
export function summaryMessage(exec: ExecutionState): ExecMessage | null {
  if (exec.status === 'starting' || exec.status === 'running') return null;
  for (let i = exec.messages.length - 1; i >= 0; i--) {
    const m = exec.messages[i];
    if (m.source === 'client' && m.batchIndex === null && SUMMARY_RE.test(m.text)) return m;
  }
  return null;
}

/** What a run executed, as the object of "Ran …" / "Running …" (the internal ExecLabel is not user text). */
const RUN_KIND: Record<string, string> = {
  statement: 'statement',
  selection: 'selection',
  script: 'script',
  explain: 'explain plan',
  data: 'data tab query',
  filter: 'filter',
  multi: 'on several connections',
  designer: 'designer change',
};

/**
 * The run details of the Messages header: "Ran script · 2 batches" ("Running …" while it runs). An unknown label is
 * left out rather than shown raw.
 */
export function runDetails(exec: Pick<ExecutionState, 'status' | 'label' | 'batches'>): string {
  const kind = RUN_KIND[exec.label];
  const verb = exec.status === 'starting' || exec.status === 'running' ? 'Running' : 'Ran';
  const batches = pluralize(exec.batches.length, 'batch', 'batches');
  return kind ? `${verb} ${kind} · ${batches}` : batches;
}

/**
 * PRINT/RAISERROR/DBMS_OUTPUT/engine messages; lines with a document position are clickable (revealLine). The run
 * summary is shown once, in the header. Errors get a plain sentence and an action, and an unknown table or column a
 * "Did you mean …? [Replace]" fix from the loaded catalog.
 */
export function MessagesPane({ exec }: { exec: ExecutionState }) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = exec.messages.length;
  // Suggestions use the catalog: recompute when it loads.
  const dbs = useCatalog((s) => s.dbs);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [count]);

  const summary = summaryMessage(exec);
  const list = useMemo(() => exec.messages.filter((m) => m !== summary), [exec.messages, summary]);
  const sql = useMemo(() => exec.batches.map((b) => b.sql).join('\n'), [exec.batches]);
  const fixes = useMemo(() => {
    const out = new Map<number, ReturnType<typeof didYouMean>>();
    for (const m of list) if (m.severity === 'error') out.set(m.seq, didYouMean(exec.connectionId, m.text, sql));
    return out;
  }, [list, exec.connectionId, sql, dbs]); // eslint-disable-line react-hooks/exhaustive-deps

  const reveal = (m: ExecMessage) => {
    if (m.line === null) return;
    getEditor(exec.tabId)?.revealLine(m.line, m.col ?? 1);
  };

  const replace = (m: ExecMessage, name: string, suggestion: string) => {
    const tab = useTabs.getState().tabs.find((t) => t.id === exec.tabId);
    const ed = getEditor(exec.tabId);
    const text = ed?.getValue() ?? (tab?.kind === 'console' ? tab.text : null);
    if (text === null) return;
    const next = replaceIdentifier(text, name, suggestion, m.line);
    if (next === null) {
      toast('info', `“${name}” is no longer in the editor`);
      return;
    }
    // Through the tab text: the editor applies it as one undoable edit (Ctrl+Z restores the old name).
    useTabs.getState().updateText(exec.tabId, next);
    if (m.line !== null) ed?.revealLine(m.line, 1);
    ed?.focus();
  };

  const SummaryIcon = exec.status === 'ok' ? CircleCheck : exec.status === 'cancelled' ? CircleSlash : CircleAlert;

  return (
    <div className="messages" role="log" aria-label="Messages">
      <div className="messages-toolbar">
        {summary ? (
          <>
            <span className={`messages-summary sev-${summary.severity}`} title={summary.text}>
              <SummaryIcon size={13} aria-hidden="true" /> {summary.text}
            </span>
            {/* Its own item with a margin: a leading space in a flex item collapses ("18 ms· 2 batches"). */}
            <span className="muted messages-sep" aria-hidden="true" style={{ marginInline: 'var(--space-1)' }}>·</span>
            <span className="sr-only">, </span>
          </>
        ) : null}
        <span className="muted">{runDetails(exec)}</span>
        <div className="flex-1" />
        <button
          className="icon-btn sm"
          title="Copy messages"
          aria-label="Copy messages"
          onClick={() => void copyText(exec.messages.map((m) => `[${time(m.ts)}] ${m.severity.toUpperCase()} ${m.line ? `(line ${m.line}) ` : ''}${m.text}`).join('\n'))}
        >
          <Copy size={13} />
        </button>
      </div>
      <div className="messages-list">
        {list.length === 0 && (
          <div className="messages-empty">{exec.status === 'starting' || exec.status === 'running' ? 'Running…' : summary ? 'No other messages' : 'No messages'}</div>
        )}
        {list.map((m) => {
          const I = m.source === 'dbmsOutput' ? Terminal : ICON[m.severity];
          const clickable = m.line !== null;
          const help = m.severity === 'error' ? errorHelp(m.code, m.text) : null;
          const fix = fixes.get(m.seq) ?? null;
          return (
            <div
              key={m.seq}
              className={`message sev-${m.severity} src-${m.source}${clickable ? ' clickable' : ''}`}
              onClick={() => reveal(m)}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onKeyDown={(e) => e.target === e.currentTarget && e.key === 'Enter' && reveal(m)}
              title={clickable ? `Go to line ${m.line}` : undefined}
            >
              <span className="message-time">{time(m.ts)}</span>
              <I size={13} className="message-icon" />
              <span className="message-text">
                {m.code && m.severity === 'error' && <span className="message-code">[{m.code}] </span>}
                {m.text}
                {(help || fix) && (
                  <span className="message-help" onClick={(e) => e.stopPropagation()}>
                    <Lightbulb size={13} aria-hidden="true" />
                    {fix ? <span>Did you mean <strong>{fix.suggestion}</strong>?</span> : help!.sentence && <span>{help!.sentence}</span>}
                    {fix && (
                      <button className="btn btn-xs" onClick={() => replace(m, fix.name, fix.suggestion)} title={`Replace “${fix.name}” with “${fix.suggestion}” in the editor`}>
                        Replace
                      </button>
                    )}
                    {!fix && help?.action && (
                      <button className="btn btn-xs" onClick={() => runCommand(help.action!.command, { kind: 'connection', connectionId: exec.connectionId })}>
                        {help.action.label}
                      </button>
                    )}
                  </span>
                )}
              </span>
              {clickable && <span className="message-line">line {m.line}</span>}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

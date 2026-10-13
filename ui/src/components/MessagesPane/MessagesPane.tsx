import { CircleAlert, Copy, Info, Terminal, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { copyText } from '../../app/actions';
import { getEditor } from '../../app/editors';
import type { ExecMessage, ExecutionState } from '../../store/resultsReducer';

const ICON = { info: Info, warning: TriangleAlert, error: CircleAlert };

function time(ts: number) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** PRINT/RAISERROR/DBMS_OUTPUT/engine messages; lines with a document position are clickable (revealLine). */
export function MessagesPane({ exec }: { exec: ExecutionState }) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = exec.messages.length;
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [count]);

  const reveal = (m: ExecMessage) => {
    if (m.line === null) return;
    getEditor(exec.tabId)?.revealLine(m.line, m.col ?? 1);
  };

  return (
    <div className="messages" role="log" aria-label="Messages">
      <div className="messages-toolbar">
        <span className="muted">{exec.batches.length} batch{exec.batches.length === 1 ? '' : 'es'} · {exec.label}</span>
        <div className="flex-1" />
        <button
          className="icon-btn sm"
          title="Copy messages"
          onClick={() => void copyText(exec.messages.map((m) => `[${time(m.ts)}] ${m.severity.toUpperCase()} ${m.line ? `(line ${m.line}) ` : ''}${m.text}`).join('\n'))}
        >
          <Copy size={13} />
        </button>
      </div>
      <div className="messages-list">
        {exec.messages.length === 0 && <div className="messages-empty">{exec.status === 'starting' || exec.status === 'running' ? 'Running…' : 'No messages'}</div>}
        {exec.messages.map((m) => {
          const I = m.source === 'dbmsOutput' ? Terminal : ICON[m.severity];
          const clickable = m.line !== null;
          return (
            <div
              key={m.seq}
              className={`message sev-${m.severity} src-${m.source}${clickable ? ' clickable' : ''}`}
              onClick={() => reveal(m)}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onKeyDown={(e) => e.key === 'Enter' && reveal(m)}
              title={clickable ? `Go to line ${m.line}` : undefined}
            >
              <span className="message-time">{time(m.ts)}</span>
              <I size={13} className="message-icon" />
              <span className="message-text">
                {m.code && m.severity === 'error' && <span className="message-code">[{m.code}] </span>}
                {m.text}
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

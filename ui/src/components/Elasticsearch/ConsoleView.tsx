// Dev Tools console (Kibana style, plan-batch3 WP-ES): `METHOD /path` + JSON body blocks; Ctrl+Enter runs the request
// at the cursor (or the selected ones), Ctrl+Shift+Enter all, ▶ in the gutter runs that request. Completion of
// methods, API paths, index names and DSL keys/fields in search bodies. Response pane (read-only, foldable) with
// status and time; history per connection; copy as cURL; auto-indent of the request at the cursor.
import { displayShortcut } from '../../commands/keys';
import { Braces, Clock, Copy, Play, PlayCircle, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { bodyForSend, formatRequest, parseConsole, requestAt, requestsIn, toCurl, type ConsoleRequest } from '../../es/console';
import { formatMs } from '../../es/format';
import { parseLenient, pretty, stripJsonExtras } from '../../es/json';
import { getConnection } from '../../store/connections';
import { toast } from '../../store/ui';
import type { TabViewProps } from '../layout/tabViews';
import { CodeEditor, type EditorHandle } from './CodeEditor';
import { DEFAULT_CONSOLE_TEXT, patchTab, type ConsoleTabState } from './open';
import { Banner, esErrorText, ViewHeader } from './parts';
import { isReadOnly, loadIndices } from './store';

interface HistoryEntry { method: string; path: string; body: string; at: number; status: number | null }
interface Response { text: string; json: boolean; status: number | null; statusText: string; elapsedMs: number; count: number; truncated: boolean }

const HISTORY_MAX = 50;
const historyKey = (cid: string) => `rowlit.es.console.history.${cid}`;

function readHistory(cid: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey(cid));
    const v = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeHistory(cid: string, list: HistoryEntry[]) {
  try {
    localStorage.setItem(historyKey(cid), JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {
    /* storage unavailable: history stays in memory */
  }
}

/** Compacts one NDJSON line (comments/trailing commas removed); invalid lines are sent as typed. */
function compactLine(line: string): string {
  const r = parseLenient(line);
  return r.ok && r.value !== undefined ? JSON.stringify(r.value) : line;
}

export function ConsoleView({ tab, theme, cid }: TabViewProps & { cid: string }) {
  const st = (tab.state ?? {}) as ConsoleTabState;
  const [text, setText] = useState(st.text ?? DEFAULT_CONSOLE_TEXT);
  const [response, setResponse] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => readHistory(cid));
  const [showHistory, setShowHistory] = useState(false);
  const editor = useRef<EditorHandle | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const ctl = useRef<AbortController | null>(null);

  // tab state → editor (openConsole(cid, insert) appends a request)
  useEffect(() => {
    if (st.text !== undefined && st.text !== textRef.current) setText(st.text);
  }, [st.text]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== st.text) patchTab(tab.id, { text });
    }, 400);
    return () => clearTimeout(t);
  }, [tab.id, text, st.text]);

  useEffect(() => () => ctl.current?.abort(), []);

  const send = useCallback(async (reqs: ConsoleRequest[]) => {
    if (!reqs.length) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setBusy(true);
    setError(null);
    const parts: string[] = [];
    let last: Response | null = null;
    let changed = false;
    try {
      for (const r of reqs) {
        const res = await api.es.console(cid, { method: r.method, path: r.path, body: bodyForSend(r.path, stripJsonExtras(r.body), compactLine) || null }, c.signal);
        const isJson = !!res.contentType?.includes('json');
        last = { text: res.body, json: isJson, status: res.status, statusText: res.statusText, elapsedMs: res.elapsedMs, count: reqs.length, truncated: res.truncated };
        if (reqs.length > 1) parts.push(`# ${r.method} ${r.path}  ${res.status} ${res.statusText} · ${formatMs(res.elapsedMs)}\n${res.body}`);
        if (r.method !== 'GET' && r.method !== 'HEAD' && res.status < 300) changed = true;
        const entry: HistoryEntry = { method: r.method, path: r.path, body: r.body, at: Date.now(), status: res.status };
        setHistory((h) => {
          const next = [entry, ...h.filter((x) => !(x.method === entry.method && x.path === entry.path && x.body === entry.body))].slice(0, HISTORY_MAX);
          writeHistory(cid, next);
          return next;
        });
      }
      if (last) setResponse(reqs.length > 1 ? { ...last, text: parts.join('\n\n'), json: false } : last);
      if (changed) void loadIndices(cid, true);
    } catch (e) {
      if (!c.signal.aborted) setError(esErrorText(e));
    } finally {
      if (ctl.current === c) setBusy(false);
    }
  }, [cid]);

  const runAtCursor = () => {
    const reqs = parseConsole(textRef.current);
    const sel = editor.current?.selectionLines();
    if (sel) return void send(requestsIn(reqs, sel.from, sel.to));
    const r = requestAt(reqs, editor.current?.cursorLine() ?? 1);
    if (r) void send([r]);
    else toast('info', 'No request at the cursor', 'Write a line like GET /_cat/indices');
  };
  const runAll = () => void send(parseConsole(textRef.current));
  const runLine = (line: number) => {
    const r = parseConsole(textRef.current).find((x) => x.startLine === line);
    if (r) void send([r]);
  };

  const current = () => requestAt(parseConsole(textRef.current), editor.current?.cursorLine() ?? 1);

  const copyCurl = () => {
    const r = current();
    if (!r) return;
    const url = String(getConnection(cid)?.props.url ?? 'http://localhost:9200').split(',')[0].trim();
    void navigator.clipboard?.writeText(toCurl(url, r)).then(() => toast('success', 'Copied as cURL'), () => undefined);
  };

  /** Pretty-prints the body of the request at the cursor (JSON) or compacts each line (NDJSON). */
  const autoIndent = () => {
    const r = current();
    if (!r || !r.body) return;
    const lines = textRef.current.split('\n');
    const head = lines.slice(0, r.startLine);
    const tail = lines.slice(r.endLine);
    const parsed = parseLenient(r.body);
    let body: string;
    if (parsed.ok && parsed.value !== undefined) body = pretty(parsed.value);
    else body = r.body.split('\n').map((l) => (l.trim() ? compactLine(l) : l)).join('\n');
    setText([...head, ...body.split('\n'), ...tail].join('\n'));
  };

  const insertHistory = (h: HistoryEntry) => {
    setShowHistory(false);
    setText((t) => `${t.trimEnd()}\n\n${formatRequest(h.method, h.path, h.body ? prettyBody(h.body) : undefined)}\n`);
  };

  const statusTone = response?.status == null ? '' : response.status < 300 ? 'ok' : response.status < 500 ? 'warn' : 'danger';
  return (
    <div className="es-view" data-testid="es-console">
      <ViewHeader title="Dev Tools" subtitle={getConnection(cid)?.name} readOnly={isReadOnly(cid)}>
        <button type="button" className="btn btn-xs" onClick={autoIndent} title="Auto-indent the request at the cursor"><Braces size={13} aria-hidden /> Auto-indent</button>
        <button type="button" className="btn btn-xs" onClick={copyCurl} title="Copy the request at the cursor as cURL"><Copy size={13} aria-hidden /> Copy as cURL</button>
        <div className="es-popover-anchor">
          <button type="button" className="btn btn-xs" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}><Clock size={13} aria-hidden /> History</button>
          {showHistory && (
            <div className="es-popover" role="menu" aria-label="Request history" onKeyDown={(e) => e.key === 'Escape' && setShowHistory(false)}>
              {history.length === 0 && <div className="es-empty">No requests yet.</div>}
              {history.map((h, i) => (
                <button key={i} type="button" role="menuitem" className="es-history-item" onClick={() => insertHistory(h)}>
                  <span className={`es-method es-method-${h.method.toLowerCase()}`}>{h.method}</span>
                  <span className="mono es-history-path">{h.path}</span>
                  <span className="muted">{h.status ?? ''}</span>
                </button>
              ))}
              {history.length > 0 && (
                <button type="button" role="menuitem" className="es-history-item es-history-clear" onClick={() => { setHistory([]); writeHistory(cid, []); setShowHistory(false); }}>
                  <Trash2 size={12} aria-hidden /> Clear history
                </button>
              )}
            </div>
          )}
        </div>
        <button type="button" className="btn btn-xs" onClick={runAll} disabled={busy} title={`Run every request (${displayShortcut('Mod+Shift+Enter')})`}><PlayCircle size={13} aria-hidden /> Run all</button>
        <button type="button" className="btn btn-xs btn-primary" onClick={runAtCursor} disabled={busy} title={`Run the request at the cursor (${displayShortcut('Mod+Enter')})`}><Play size={13} aria-hidden /> {busy ? 'Running…' : 'Run'}</button>
      </ViewHeader>
      <div className="es-split">
        <div className="es-split-left">
          <CodeEditor value={text} onChange={setText} language="console" ariaLabel="Console requests" theme={theme} onRun={runAtCursor} onRunAll={runAll}
            onRunLine={runLine} completion={{ cid }} handleRef={editor} className="es-fill-editor" primary />
        </div>
        <div className="es-split-right">
          <div className="es-response-head">
            {response ? (
              <>
                {response.status != null && <span className={`es-status es-status-${statusTone}`}>{response.status} {response.statusText}</span>}
                <span className="muted">{formatMs(response.elapsedMs)}{response.count > 1 ? ` · ${response.count} requests` : ''}{response.truncated ? ' · truncated at 5 MB' : ''}</span>
              </>
            ) : <span className="muted">Response</span>}
          </div>
          {error && <Banner>{error}</Banner>}
          <div className="es-response-body">
            {response ? (
              <CodeEditor value={response.text} language={response.json ? 'json' : response.count > 1 ? 'console' : 'text'} readOnly validate={false}
                ariaLabel="Response" theme={theme} className="es-fill-editor" />
            ) : <div className="es-empty">Run a request to see the response here.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function prettyBody(body: string): string {
  const r = parseLenient(body);
  return r.ok && r.value !== undefined && !body.includes('\n{') ? pretty(r.value) : stripJsonExtras(body);
}

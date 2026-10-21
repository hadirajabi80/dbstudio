// CLI (`redis.cli`, docs/PLAN-M2.md 5.4): redis-cli behaviour in a tab: prompt `host:port[db]>`, redis-cli quoting
// (`SET k "a b"`), replies rendered like redis-cli, history (Ctrl+Up / Ctrl+Down, or Up/Down on an empty
// suggestion list), Tab completion (commands, sub-commands, keywords, cached keys), `help <command>`, `clear`.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArgsError, parseArgs } from '../../redis/args';
import { helpText } from '../../redis/catalog';
import { signature, suggest, type Suggestion } from '../../redis/complete';
import { replyText } from '../../redis/format';
import type { TabViewProps } from '../layout/tabViews';
import type { CliState } from './open';
import { cachedKeyNames, loadHistory, loadServer, pushHistory, useRedis } from './store';
import { useRedisViewEvents } from './viewEvents';
import { runLines } from './WorkbenchView';

interface Line { id: number; kind: 'input' | 'output' | 'error' | 'info'; text: string }

const MAX_LINES = 5000;
let lineSeq = 0;

export function CliView({ tab, visible }: TabViewProps) {
  const cid = tab.connectionId ?? '';
  const st = tab.state as CliState;
  const server = useRedis((s) => s.conns[cid]?.server.data);
  useEffect(() => {
    void loadServer(cid);
  }, [cid]);
  const [db, setDb] = useState(st.db ?? 0);
  const [input, setInput] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [{ id: ++lineSeq, kind: 'info', text: 'Connected. Type a command, `help <command>` for docs, `clear` to clear. Tab completes.' }]);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState(() => loadHistory(cid));
  const [histPos, setHistPos] = useState<number | null>(null);
  const [sugg, setSugg] = useState<{ items: Suggestion[]; start: number; index: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const prompt = `${server?.server.serverName ?? 'redis'}${server?.mode === 'cluster' || db === 0 ? '' : `[${db}]`}>`;

  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const append = useCallback((add: Omit<Line, 'id'>[]) => setLines((l) => [...l, ...add.map((x) => ({ ...x, id: ++lineSeq }))].slice(-MAX_LINES)), []);

  const execute = async (raw: string) => {
    const line = raw.trim();
    setInput('');
    setSugg(null);
    setHistPos(null);
    if (!line) return;
    append([{ kind: 'input', text: `${prompt} ${line}` }]);
    setHist(pushHistory(cid, [line]));
    let args: string[];
    try {
      args = parseArgs(line);
    } catch (e) {
      append([{ kind: 'error', text: e instanceof ArgsError ? e.message : String(e) }]);
      return;
    }
    const cmd = args[0]?.toLowerCase();
    if (cmd === 'clear') {
      setLines([]);
      return;
    }
    if (cmd === 'help') {
      const name = args.slice(1).join(' ');
      append([{ kind: 'info', text: name ? helpText(name) ?? `No documentation for '${name}'.` : 'help <command> shows the syntax and summary, e.g. help ZADD, help CONFIG SET.' }]);
      return;
    }
    setBusy(true);
    try {
      const r = await runLines(cid, db, [line]);
      for (const c of r.cards) append([{ kind: c.result.ok ? 'output' : 'error', text: replyText(c.result) }]);
      setDb(r.db);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const refreshSuggestions = (value: string, caret: number, force = false) => {
    const before = value.slice(0, caret);
    if (!force && !before.trim()) return setSugg(null);
    const r = suggest(before, () => cachedKeyNames(cid, db));
    setSugg(r.items.length ? { items: r.items.slice(0, 12), start: r.start, index: 0 } : null);
  };

  const accept = (s: Suggestion) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    const start = sugg?.start ?? caret;
    const insert = s.kind === 'key' ? s.insert : `${s.insert} `;
    const next = input.slice(0, start) + insert + input.slice(caret);
    setInput(next);
    setSugg(null);
    requestAnimationFrame(() => {
      el?.setSelectionRange(start + insert.length, start + insert.length);
    });
  };

  const history = (dir: -1 | 1) => {
    if (!hist.length) return;
    const pos = histPos === null ? (dir < 0 ? hist.length - 1 : null) : histPos + dir;
    if (pos === null || pos >= hist.length) {
      setHistPos(null);
      setInput('');
      return;
    }
    const p = Math.max(0, pos);
    setHistPos(p);
    setInput(hist[p]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (sugg && !mod) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = sugg.items.length;
        setSugg({ ...sugg, index: (sugg.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        accept(sugg.items[sugg.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setSugg(null);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!busy) void execute(input);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      refreshSuggestions(input, e.currentTarget.selectionStart ?? input.length, true);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      history(e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  useRedisViewEvents(tab.id, (a) => {
    if (a === 'clear') setLines([]);
  });

  const hint = useMemo(() => {
    const sig = signature(input);
    return sig ? sig.spec.syntax : '';
  }, [input]);

  return (
    <div className="redis-view redis-cli" data-command-scope="redisCli" onMouseUp={() => { if (!window.getSelection()?.toString()) inputRef.current?.focus(); }}>
      <div className="redis-cli-log mono" ref={logRef} role="log" aria-label="CLI output" aria-live="polite">
        {lines.map((l) => <pre key={l.id} className={`redis-cli-line ${l.kind}`}>{l.text}</pre>)}
      </div>
      <div className="redis-cli-input">
        {sugg && (
          <ul className="redis-suggest" role="listbox" aria-label="Suggestions">
            {sugg.items.map((s, i) => (
              <li key={`${s.kind}:${s.label}`} role="option" aria-selected={i === sugg.index} className={i === sugg.index ? 'on' : ''}
                onMouseDown={(e) => { e.preventDefault(); accept(s); }}>
                <span className="mono">{s.label}</span>
                {(s.detail || s.spec?.summary) && <span className="muted">{s.spec?.summary ?? s.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        <label className="redis-cli-prompt mono" htmlFor={`redis-cli-${tab.id}`}>{prompt}</label>
        <input id={`redis-cli-${tab.id}`} ref={inputRef} className="mono" aria-label="Redis command" autoComplete="off" spellCheck={false} value={input} disabled={busy}
          onChange={(e) => { setInput(e.target.value); setHistPos(null); if (sugg) refreshSuggestions(e.target.value, e.target.selectionStart ?? e.target.value.length, true); }}
          onKeyDown={onKeyDown} onBlur={() => setTimeout(() => setSugg(null), 100)} />
      </div>
      {hint && <div className="redis-cli-hint mono muted" aria-live="polite">{hint}</div>}
    </div>
  );
}

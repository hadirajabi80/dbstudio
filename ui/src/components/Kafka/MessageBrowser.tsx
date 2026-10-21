// Message browser and live tail (docs/PLAN-M2.md 7.4).
//   Fetch: partitions (all / one), start (latest N · oldest · offset · timestamp), key/value decoders, limit, search in
//   value → a fetch job whose messages stream in; the list shows newest first.
//   Live tail: a kafka.tail stream; the list appends at the bottom and follows it (auto-scroll pauses when the user
//   scrolls up; "Jump to live" resumes), Pause/Resume pauses the consumer, a counter shows dropped messages.
//   Detail: value (pretty JSON), headers, key, schema; Copy, Load full (truncated values), Produce similar.
import { Pause, Play, Radio, Search, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../../api/client';
import type { KafkaFetchResult, KafkaMessage, KafkaValueFormat } from '../../api/types';
import type { ViewTab } from '../../store/tabs';
import { toast } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { Select } from '../common/Select';
import { decodedText, formatCount, formatTimestamp, fromLocalInput, isTruncated, messageKey, prettyText, preview, sortMessages, toLocalInput } from './format';
import { DEFAULT_BROWSE, openProduce, patchTab, topicTabState, type BrowseState } from './open';
import { Banner } from './parts';
import { hasRegistry, isReadOnly } from './store';
import { startFetch, startTail, type FetchHandle, type TailHandle } from './streams';

export const FORMATS: { value: KafkaValueFormat; label: string }[] = [
  { value: 'auto', label: 'Auto' }, { value: 'string', label: 'String' }, { value: 'json', label: 'JSON' }, { value: 'hex', label: 'Hex' },
  { value: 'int32', label: 'Int32' }, { value: 'int64', label: 'Int64' }, { value: 'avro', label: 'Avro (SR)' }, { value: 'protobuf', label: 'Protobuf (SR)' },
  { value: 'jsonschema', label: 'JSON Schema (SR)' },
];

/** Most messages kept in memory while tailing (oldest are dropped and counted). */
export const TAIL_CAP = 10_000;
const ROW_H = 26;

type Mode = 'idle' | 'fetching' | 'tail';

export function MessageBrowser({ tab, cid, topic, partitions, theme, visible }: {
  tab: ViewTab; cid: string; topic: string; partitions: number | null; theme: EffectiveTheme; visible: boolean;
}) {
  void theme;
  const st = topicTabState(tab);
  const browse: BrowseState = { ...DEFAULT_BROWSE, ...st.browse };
  const setBrowse = (p: Partial<BrowseState>) => patchTab(tab.id, { browse: { ...browse, ...p } });

  const [messages, setMessages] = useState<KafkaMessage[]>([]);
  const [mode, setMode] = useState<Mode>('idle');
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<KafkaFetchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [dropped, setDropped] = useState(0);
  const [follow, setFollow] = useState(true);
  const [pretty, setPretty] = useState(true);
  const [full, setFull] = useState<KafkaMessage | null>(null);
  const fetchRef = useRef<FetchHandle | null>(null);
  const tailRef = useRef<TailHandle | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);

  const stopAll = useCallback(() => {
    fetchRef.current?.cancel();
    fetchRef.current = null;
    tailRef.current?.close();
    tailRef.current = null;
  }, []);
  // "fetch once on open" bookkeeping; reset on unmount so a remount (StrictMode, tab re-mount) fetches again
  const seenSeq = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    stopAll();
    seenSeq.current = undefined;
  }, [stopAll]);

  const fetch = useCallback(() => {
    stopAll();
    setMessages([]);
    setSelected(null);
    setResult(null);
    setError(null);
    setDropped(0);
    setMode('fetching');
    setProgress('Starting…');
    const buffer: KafkaMessage[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      const batch = buffer.splice(0);
      if (batch.length) setMessages((m) => [...m, ...batch]);
    };
    fetchRef.current = startFetch(cid, topic, {
      partitions: browse.partitions, start: browse.start, limit: browse.limit, keyFormat: browse.keyFormat, valueFormat: browse.valueFormat,
      search: browse.search ? { text: browse.search, caseSensitive: browse.caseSensitive } : null,
    }, {
      onMessages: (items) => {
        buffer.push(...items);
        flushTimer ??= setTimeout(flush, 50);
      },
      onProgress: (_done, _total, message) => setProgress(message),
      onDone: (r, err) => {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
        fetchRef.current = null;
        setMode('idle');
        setProgress(null);
        setResult(r);
        if (err && err !== 'cancelled') setError(err);
      },
    });
    // browse settings change → refetch is explicit (Fetch button / Enter); a newer fetchSeq triggers one
  }, [cid, topic, stopAll, browse.partitions, browse.start, browse.limit, browse.keyFormat, browse.valueFormat, browse.search, browse.caseSensitive]);

  // fetch once when opened via "Browse messages" (fetchSeq) or the first time the sub-view shows
  useEffect(() => {
    if (!visible) return;
    if (seenSeq.current === undefined || (st.fetchSeq !== undefined && st.fetchSeq !== seenSeq.current)) {
      seenSeq.current = st.fetchSeq ?? 0;
      fetch();
    }
  }, [visible, st.fetchSeq, fetch]);

  const startLive = async () => {
    stopAll();
    setMessages([]);
    setSelected(null);
    setResult(null);
    setError(null);
    setDropped(0);
    setPaused(false);
    setFollow(true);
    setMode('tail');
    try {
      tailRef.current = await startTail(cid, {
        topic, partitions: browse.partitions, from: 'latest', keyFormat: browse.keyFormat, valueFormat: browse.valueFormat, filter: browse.search || null,
      }, {
        onMessages: (items) => setMessages((m) => {
          const next = m.concat(items);
          if (next.length <= TAIL_CAP) return next;
          setDropped((d) => d + next.length - TAIL_CAP);
          return next.slice(next.length - TAIL_CAP);
        }),
        onState: (state, reason, engineDropped) => {
          if (engineDropped) setDropped((d) => Math.max(d, engineDropped));
          if (state === 'paused') setPaused(true);
          else if (state === 'open') setPaused(false);
          else {
            tailRef.current = null;
            setMode('idle');
            if (state === 'error' || (reason && reason !== 'closed')) setError(`Live tail ended: ${reason ?? state}`);
          }
        },
      });
    } catch (e) {
      setMode('idle');
      setError(errorMessage(e));
    }
  };

  const stopLive = () => {
    tailRef.current?.close();
    tailRef.current = null;
    setMode('idle');
  };

  const togglePause = async () => {
    const t = tailRef.current;
    if (!t) return;
    try {
      if (paused) await t.resume();
      else await t.pause();
      setPaused(!paused);
    } catch (e) {
      toast('error', 'Could not change the tail state', errorMessage(e));
    }
  };

  // ordering: fetch → newest first (oldest/offset: ascending); tail → arrival order (append at the bottom)
  const rows = useMemo(() => {
    if (mode === 'tail') return messages;
    return sortMessages(messages, browse.start.kind === 'latest' ? 'newest' : 'oldest');
  }, [messages, mode, browse.start.kind]);

  // follow the tail
  useEffect(() => {
    if (mode !== 'tail' || !follow || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [rows, mode, follow]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 400));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (mode === 'tail') {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2;
      if (follow !== atBottom) setFollow(atBottom);
    }
  };

  const jumpToLive = () => {
    setFollow(true);
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  };

  const sel = useMemo(() => rows.find((m) => messageKey(m) === selected) ?? null, [rows, selected]);
  useEffect(() => setFull(null), [selected]);

  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = sel ? rows.indexOf(sel) : -1;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    const m = rows[next];
    if (!m) return;
    setSelected(messageKey(m));
    const el = listRef.current;
    if (el) {
      const top = next * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    }
    if (mode === 'tail') setFollow(next === rows.length - 1);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 10);
  const registry = hasRegistry(cid);
  const startKind = browse.start.kind;
  const partitionOptions = [{ value: -1, label: 'All partitions' }, ...Array.from({ length: partitions ?? 0 }, (_, i) => ({ value: i, label: `Partition ${i}` }))];

  return (
    <div className="kafka-pane kafka-browser">
      <div className="kafka-toolbar kafka-browser-bar">
        <Select aria-label="Partition" value={browse.partitions?.[0] ?? -1} options={partitionOptions} onChange={(v) => setBrowse({ partitions: v < 0 ? null : [v] })} />
        <div className="segmented" role="group" aria-label="Start">
          {(['latest', 'oldest', 'offset', 'timestamp'] as const).map((k) => (
            <button key={k} type="button" className={startKind === k ? 'on' : undefined} aria-pressed={startKind === k}
              onClick={() => setBrowse({
                start: k === 'latest' ? { kind: 'latest', count: browse.limit } : k === 'oldest' ? { kind: 'oldest' }
                  : k === 'offset' ? { kind: 'offset', offset: 0 } : { kind: 'timestamp', iso: new Date(Date.now() - 3600_000).toISOString() },
              })}>
              {k === 'latest' ? 'Latest' : k === 'oldest' ? 'Oldest' : k === 'offset' ? 'Offset' : 'Timestamp'}
            </button>
          ))}
        </div>
        {browse.start.kind === 'latest' && (
          <input className="input kafka-num" aria-label="Latest count" inputMode="numeric" value={browse.start.count}
            onChange={(e) => setBrowse({ start: { kind: 'latest', count: Number(e.target.value.replace(/\D/g, '')) || 1 } })} />
        )}
        {browse.start.kind === 'offset' && (
          <input className="input kafka-num" aria-label="Start offset" inputMode="numeric" value={browse.start.offset}
            onChange={(e) => setBrowse({ start: { kind: 'offset', offset: Number(e.target.value.replace(/\D/g, '')) || 0 } })} />
        )}
        {browse.start.kind === 'timestamp' && (
          <input className="input" type="datetime-local" aria-label="Start timestamp" value={toLocalInput(browse.start.iso)}
            onChange={(e) => setBrowse({ start: { kind: 'timestamp', iso: fromLocalInput(e.target.value) ?? new Date().toISOString() } })} />
        )}
      </div>
      <div className="kafka-toolbar kafka-browser-bar">
        <span className="tb-label">Key</span>
        <Select aria-label="Key format" value={browse.keyFormat} options={FORMATS} onChange={(v) => setBrowse({ keyFormat: v })} />
        <span className="tb-label">Value</span>
        <Select aria-label="Value format" value={browse.valueFormat} options={FORMATS.map((f) => ({ ...f, disabled: !registry && f.label.includes('(SR)') }))}
          onChange={(v) => setBrowse({ valueFormat: v })} />
        <span className="tb-label">Limit</span>
        <input className="input kafka-num" aria-label="Limit" inputMode="numeric" value={browse.limit}
          onChange={(e) => setBrowse({ limit: Math.min(5000, Number(e.target.value.replace(/\D/g, '')) || 1) })} />
        <div className="kafka-search-box">
          <Search size={13} aria-hidden />
          <input className="input" type="search" placeholder="Search in value" aria-label="Search in value" value={browse.search} data-primary-focus
            onChange={(e) => setBrowse({ search: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && mode !== 'tail' && fetch()} />
          <button type="button" className={`btn btn-xs btn-ghost${browse.caseSensitive ? ' on' : ''}`} aria-pressed={browse.caseSensitive} title="Match case"
            onClick={() => setBrowse({ caseSensitive: !browse.caseSensitive })}>Aa</button>
        </div>
        {mode === 'fetching'
          ? <button type="button" className="btn btn-xs" onClick={() => { fetchRef.current?.cancel(); }}><Square size={12} aria-hidden /> Cancel</button>
          : <button type="button" className="btn btn-xs btn-primary" disabled={mode === 'tail'} onClick={fetch}>Fetch</button>}
        {mode === 'tail'
          ? <button type="button" className="btn btn-xs kafka-live on" aria-pressed onClick={stopLive}><Radio size={13} aria-hidden /> Live tail</button>
          : <button type="button" className="btn btn-xs kafka-live" aria-pressed={false} disabled={mode === 'fetching'} onClick={() => void startLive()}><Radio size={13} aria-hidden /> Live tail</button>}
      </div>
      <div className="kafka-status" role="status" aria-live="polite">
        {mode === 'fetching' && <span>Fetching… {progress}</span>}
        {mode === 'idle' && result && (
          <span>
            {formatCount(result.fetched)} message{result.fetched === 1 ? '' : 's'}{browse.search ? ` matching “${browse.search}”` : ''} · {formatCount(result.scanned)} scanned
            {result.timedOut ? ' · stopped at the timeout' : ''}{result.truncated ? ' · more available (raise the limit or narrow the start)' : ''}
          </span>
        )}
        {mode === 'tail' && (
          <>
            <span className={`kafka-live-dot${paused ? ' paused' : ''}`} aria-hidden />
            <span>{paused ? 'Paused' : 'Live'} · {formatCount(rows.length)} message{rows.length === 1 ? '' : 's'}</span>
            {dropped > 0 && <span className="kafka-dropped">dropped {formatCount(dropped)}</span>}
            <button type="button" className="btn btn-xs" onClick={() => void togglePause()}>{paused ? <><Play size={12} aria-hidden /> Resume</> : <><Pause size={12} aria-hidden /> Pause</>}</button>
            {!follow && <button type="button" className="btn btn-xs btn-primary" onClick={jumpToLive}>Jump to live</button>}
          </>
        )}
      </div>
      {error && <Banner>{error}</Banner>}
      <div className="kafka-msg-head" aria-hidden>
        <span className="c-offset">Offset</span><span className="c-part">Part</span><span className="c-ts">Timestamp</span><span className="c-key">Key</span>
        <span className="c-value">Value</span><span className="c-hdr">Headers</span>
      </div>
      <div ref={listRef} className="kafka-msg-list" role="listbox" aria-label="Messages" tabIndex={0} onScroll={onScroll} onKeyDown={onListKey}
        aria-activedescendant={sel ? `kmsg-${tab.id}-${messageKey(sel)}` : undefined}>
        {rows.length === 0 && mode !== 'fetching' && <div className="kafka-empty">{mode === 'tail' ? 'Waiting for new messages…' : 'No messages.'}</div>}
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {rows.slice(first, last).map((m, i) => {
            const k = messageKey(m);
            return (
              <div key={k} id={`kmsg-${tab.id}-${k}`} role="option" aria-selected={k === selected} className={`kafka-msg-row${k === selected ? ' selected' : ''}`}
                style={{ top: (first + i) * ROW_H, height: ROW_H }} onClick={() => setSelected(k)}>
                <span className="c-offset num">{m.offset}</span>
                <span className="c-part num">{m.partition}</span>
                <span className="c-ts">{formatTimestamp(m.timestamp)}</span>
                <span className={`c-key mono${m.key.text === null ? ' muted' : ''}`}>{preview(m.key, 40)}</span>
                <span className={`c-value mono${m.value.error ? ' kafka-decode-error' : ''}${m.value.text === null ? ' muted' : ''}`} title={m.value.error}>{preview(m.value)}</span>
                <span className="c-hdr num">{m.headers.length || ''}</span>
              </div>
            );
          })}
        </div>
      </div>
      {sel && (
        <MessageDetail cid={cid} topic={topic} message={full ?? sel} pretty={pretty} setPretty={setPretty} readOnly={isReadOnly(cid)} browse={browse}
          onLoadFull={async () => {
            try {
              setFull(await api.kafka.message(cid, topic, sel.partition, sel.offset, { keyFormat: browse.keyFormat, valueFormat: browse.valueFormat }));
            } catch (e) {
              toast('error', 'Could not load the full message', errorMessage(e));
            }
          }} />
      )}
    </div>
  );
}

function MessageDetail({ cid, topic, message: m, pretty, setPretty, readOnly, browse, onLoadFull }: {
  cid: string; topic: string; message: KafkaMessage; pretty: boolean; setPretty(v: boolean): void; readOnly: boolean; browse: BrowseState; onLoadFull(): void;
}) {
  const text = prettyText(m.value, pretty);
  const copy = (t: string, what: string) => {
    void navigator.clipboard?.writeText(t).then(() => toast('success', `Copied ${what}`), () => toast('error', 'Copy failed'));
  };
  const produceSimilar = () => {
    const fmt = (f: string) => (f === 'json' || f === 'hex' || f === 'avro' || f === 'protobuf' || f === 'jsonschema' ? f : 'string') as 'string';
    openProduce(cid, topic, {
      key: m.key.text === null ? '' : decodedText(m.key),
      value: m.value.json !== undefined ? JSON.stringify(m.value.json, null, 2) : decodedText(m.value),
      headers: m.headers.map((h) => ({ key: h.key, value: decodedText(h.value) })),
      keyFormat: fmt(m.key.format),
      valueFormat: m.value.json !== undefined && !m.value.schemaSubject ? 'json' : fmt(m.value.format),
      subject: m.value.schemaSubject ?? '',
    });
  };
  void browse;
  return (
    <div className="kafka-detail" aria-label="Message detail">
      <div className="kafka-detail-main">
        <div className="kafka-detail-bar">
          <strong>Value</strong>
          <span className="muted">{m.value.format}{m.value.schemaId ? ` · schema ${m.value.schemaId}${m.value.schemaSubject ? ` (${m.value.schemaSubject})` : ''}` : ''} · {m.size.toLocaleString('en-US')} B</span>
          <span className="flex-1" />
          <label className="check"><input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> Pretty</label>
          {isTruncated(m.value) && <button type="button" className="btn btn-xs" onClick={onLoadFull}>Load full</button>}
          <button type="button" className="btn btn-xs" onClick={() => copy(text, 'value')}>Copy</button>
          <button type="button" className="btn btn-xs" disabled={readOnly} onClick={produceSimilar}>Produce similar</button>
        </div>
        {m.value.error && <div className="kafka-decode-error-line" role="note">{m.value.error}</div>}
        <pre className="kafka-pre" tabIndex={0}>{text}</pre>
      </div>
      <div className="kafka-detail-side">
        <div><span className="muted">Key</span> <span className="mono">{decodedText(m.key)}</span>{m.key.error && <span className="kafka-decode-error"> ({m.key.error})</span>}</div>
        <div><span className="muted">Partition / offset</span> {m.partition} / {m.offset}</div>
        <div><span className="muted">Timestamp</span> {formatTimestamp(m.timestamp)} <span className="muted">({m.timestampType})</span></div>
        <div className="kafka-headers">
          <span className="muted">Headers</span>
          {m.headers.length === 0 ? <span className="muted"> none</span> : (
            <ul>{m.headers.map((h, i) => <li key={i}><span className="mono">{h.key}</span>=<span className="mono">{decodedText(h.value)}</span></li>)}</ul>
          )}
        </div>
      </div>
    </div>
  );
}

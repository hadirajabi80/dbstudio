// Pub/Sub (`redis.pubsub`, docs/PLAN-M2.md 5.5): channels and patterns to subscribe to, a live message list
// (redis.subscribe stream; pause, clear, filter, JSON pretty on expand, drop counter), a publish form and the
// server's active channels (PUBSUB CHANNELS / NUMSUB).
import { Pause, Play, RefreshCw, Send, Square, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { RedisMessageItem, RedisPubSubChannels } from '../../api/types';
import { formatCount, prettyJson } from '../../redis/format';
import { hasGlob } from '../../redis/glob';
import { toast } from '../../store/ui';
import { useTabs } from '../../store/tabs';
import type { TabViewProps } from '../layout/tabViews';
import type { PubSubState } from './open';
import { errorText, loadServer, useRedis } from './store';
import { useRedisStream } from './useRedisStream';
import { useRedisViewEvents } from './viewEvents';

const ROW = 24;

function MessageList({ items, filter }: { items: RedisMessageItem[]; filter: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    const list = f ? items.filter((m) => m.channel.toLowerCase().includes(f) || m.payload.toLowerCase().includes(f)) : items;
    return list.slice().reverse();
  }, [items, filter]);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = 0;
  }, [shown.length, follow]);
  const height = ref.current?.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / ROW) - 10);
  const last = Math.min(shown.length, Math.ceil((top + height) / ROW) + 10);
  return (
    <div className="redis-msglist" ref={ref} role="log" aria-label="Messages" tabIndex={0}
      onScroll={(e) => { setTop(e.currentTarget.scrollTop); setFollow(e.currentTarget.scrollTop < 4); }}>
      {!shown.length && <div className="redis-empty muted">{items.length ? 'No message matches the filter.' : 'Messages appear here (newest first).'}</div>}
      <div style={{ position: 'relative', height: shown.length * ROW + (open !== null ? 240 : 0) }}>
        {shown.slice(first, last).map((m, j) => {
          const i = first + j;
          const isOpen = open === i;
          const pretty = isOpen ? prettyJson(m.payload) : null;
          return (
            <div key={`${m.ts}-${i}`} className={`redis-msg ${isOpen ? 'open' : ''}`} style={{ top: i * ROW + (open !== null && i > open ? 240 : 0) }}>
              <button className="redis-msg-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i)}>
                <span className="muted tabular">{new Date(m.ts).toLocaleTimeString('en-GB', { hour12: false })}</span>
                <span className="mono redis-msg-channel">{m.channel}</span>
                {m.pattern && <span className="pill pill-muted mono">{m.pattern}</span>}
                <span className="mono redis-msg-payload">{m.binary ? `0x${m.payload}` : m.payload}</span>
              </button>
              {isOpen && <pre className="redis-msg-detail mono">{pretty ?? m.payload}</pre>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PubSubView({ tab }: TabViewProps) {
  const cid = tab.connectionId ?? '';
  const st = tab.state as PubSubState;
  const server = useRedis((s) => s.conns[cid]?.server.data);
  useEffect(() => {
    void loadServer(cid);
  }, [cid]);
  const [channels, setChannels] = useState<string[]>(st.channels ?? []);
  const [patterns, setPatterns] = useState<string[]>(st.patterns ?? []);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [pubChannel, setPubChannel] = useState(st.channels?.[0] ?? '');
  const [pubMessage, setPubMessage] = useState('');
  const [active, setActive] = useState<RedisPubSubChannels | null>(null);
  const stream = useRedisStream<RedisMessageItem>('redis.subscribe', cid);
  const running = stream.status === 'open' || stream.status === 'paused' || stream.status === 'starting';

  useEffect(() => {
    const cur = useTabs.getState().tabs.find((x) => x.id === tab.id);
    if (cur?.kind === 'view') useTabs.getState().updateView(tab.id, { state: { ...(cur.state as object), channels, patterns } });
  }, [channels, patterns, tab.id]);

  const loadChannels = () => api.redis.pubsubChannels(cid).then(setActive, (e: unknown) => toast('error', 'Could not list channels', errorText(e)));
  useEffect(() => {
    void loadChannels();
    // once per connection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (hasGlob(v)) setPatterns((p) => (p.includes(v) ? p : [...p, v]));
    else setChannels((c) => (c.includes(v) ? c : [...c, v]));
    setDraft('');
  };
  const subscribe = async () => {
    if (!channels.length && !patterns.length) return toast('info', 'Add a channel or pattern first');
    await stream.start({ channels, patterns });
    setTimeout(() => void loadChannels(), 300);
  };
  const restart = async () => {
    await stream.stop();
    await stream.start({ channels, patterns });
  };
  const publish = async () => {
    if (!pubChannel) return;
    try {
      const r = await api.redis.publish(cid, { channel: pubChannel, message: pubMessage });
      toast('success', `Published to ${pubChannel}`, `${r.receivers} receiver${r.receivers === 1 ? '' : 's'}`);
      setPubMessage('');
    } catch (e) {
      toast('error', 'Publish failed', errorText(e));
    }
  };
  useRedisViewEvents(tab.id, (a) => {
    if (a === 'clear') stream.clear();
    else if (a === 'pause') void (stream.status === 'paused' ? stream.resume() : stream.pause());
  });

  const chip = (v: string, pattern: boolean) => (
    <span key={`${pattern ? 'p' : 'c'}:${v}`} className="chip mono">
      {pattern && <span className="muted">pattern</span>} {v}
      <button className="chip-clear" aria-label={`Remove ${v}`} disabled={running} onClick={() => (pattern ? setPatterns(patterns.filter((x) => x !== v)) : setChannels(channels.filter((x) => x !== v)))}><X size={12} /></button>
    </span>
  );

  return (
    <div className="redis-view redis-pubsub" data-command-scope="redisPubSub">
      <div className="redis-pubsub-side">
        <section>
          <h3>Subscriptions</h3>
          <div className="redis-add-row">
            <input className="input mono" aria-label="Channel or pattern" placeholder="channel, or pattern like orders.*" value={draft} disabled={running}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
            <button className="btn btn-xs" disabled={running || !draft.trim()} onClick={add}>Add</button>
          </div>
          <div className="chip-row">{channels.map((c) => chip(c, false))}{patterns.map((p) => chip(p, true))}</div>
          <div className="redis-row">
            {!running
              ? <button className="btn btn-primary btn-xs" onClick={() => void subscribe()}><Play size={13} /> Subscribe</button>
              : <button className="btn btn-xs" onClick={() => void stream.stop()}><Square size={13} /> Unsubscribe</button>}
            {running && (stream.status === 'paused'
              ? <button className="btn btn-xs" onClick={() => void stream.resume()}><Play size={13} /> Resume</button>
              : <button className="btn btn-xs" onClick={() => void stream.pause()}><Pause size={13} /> Pause</button>)}
            {running && <button className="link-btn" onClick={() => void restart()}>Restart</button>}
          </div>
          {stream.error && <div className="form-error" role="alert">{stream.error}</div>}
        </section>
        <section>
          <h3>Publish</h3>
          <input className="input mono" aria-label="Publish channel" placeholder="channel" value={pubChannel} onChange={(e) => setPubChannel(e.target.value)} />
          <textarea className="input mono redis-textarea" aria-label="Message" rows={4} placeholder="message" value={pubMessage} onChange={(e) => setPubMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void publish(); } }} />
          <button className="btn btn-xs" disabled={!pubChannel || server?.readOnly} onClick={() => void publish()} title={server?.readOnly ? 'Read-only connection' : 'Publish (Ctrl+Enter)'}><Send size={13} /> Publish</button>
        </section>
        <section>
          <h3>Active channels <button className="icon-btn" aria-label="Refresh channels" onClick={() => void loadChannels()}><RefreshCw size={13} /></button></h3>
          {active && (
            <>
              <ul className="redis-channel-list">
                {active.channels.map((c) => (
                  <li key={c.channel}><button className="link-btn mono" disabled={running} onClick={() => setChannels((x) => (x.includes(c.channel) ? x : [...x, c.channel]))} title="Add to the subscriptions">{c.channel}</button>
                    <span className="muted tabular">{c.subscribers}</span></li>
                ))}
              </ul>
              {!active.channels.length && <p className="muted">No active channels.</p>}
              <p className="muted">{active.patterns} pattern subscription{active.patterns === 1 ? '' : 's'}</p>
            </>
          )}
        </section>
      </div>
      <div className="redis-pubsub-main">
        <div className="redis-toolbar">
          <span className={`redis-live ${stream.status}`} role="status">{stream.status === 'open' ? 'Live' : stream.status === 'paused' ? 'Paused' : stream.status === 'starting' ? 'Subscribing…' : stream.status === 'ended' ? 'Stopped' : 'Not subscribed'}</span>
          <span className="muted tabular">{formatCount(stream.items.length)} messages</span>
          {stream.dropped > 0 && <span className="pill pill-warning" role="status">dropped {formatCount(stream.dropped)}</span>}
          <span className="flex-1" />
          <input className="input redis-filter" type="search" aria-label="Filter messages" placeholder="Filter channel or payload" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn btn-xs" disabled={!stream.items.length} onClick={stream.clear}><Trash2 size={13} /> Clear</button>
        </div>
        <MessageList items={stream.items} filter={filter} />
      </div>
    </div>
  );
}

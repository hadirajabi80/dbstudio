// Info dashboard (`redis.info`, docs/PLAN-M2.md 5.5): tiles (memory / peak / fragmentation, ops/sec, clients, hit
// ratio, uptime, role + replicas, keys) with 60-sample sparklines from a 2 s poll, the raw INFO sections (searchable
// key/value lists), the CLIENT LIST grid with Kill, cluster nodes, and MONITOR as a stream (warning first, auto-stop).
import { ChevronDown, ChevronRight, Pause, Play, Skull, Square, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { RedisClientInfo, RedisInfoResponse, RedisMonitorItem } from '../../api/types';
import { joinArgs } from '../../redis/args';
import { formatBytes, formatCount } from '../../redis/format';
import { toast, useUi } from '../../store/ui';
import { Select } from '../common/Select';
import type { TabViewProps } from '../layout/tabViews';
import type { InfoState } from './open';
import { errorText, loadServer, useRedis } from './store';
import { useRedisStream } from './useRedisStream';
import { useRedisViewEvents } from './viewEvents';

export const SAMPLES = 60;
export const POLL_MS = 2000;

export interface InfoSample { at: number; ops: number; memory: number; clients: number; hits: number; misses: number }

export function sampleOf(info: RedisInfoResponse, at = Date.now()): InfoSample {
  const n = (s: string, k: string) => Number(info.sections[s]?.[k] ?? 0) || 0;
  return {
    at, ops: n('stats', 'instantaneous_ops_per_sec'), memory: n('memory', 'used_memory'), clients: n('clients', 'connected_clients') || info.clients,
    hits: n('stats', 'keyspace_hits'), misses: n('stats', 'keyspace_misses'),
  };
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return <svg className="redis-spark" aria-hidden viewBox="0 0 120 28" />;
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (SAMPLES - 1)) * 120).toFixed(1)},${(26 - ((v - min) / span) * 24).toFixed(1)}`).join(' ');
  return (
    <svg className="redis-spark" viewBox="0 0 120 28" preserveAspectRatio="none" role="img" aria-label={`${label} trend`}>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Tile({ title, value, sub, spark, label }: { title: string; value: string; sub?: string; spark?: number[]; label?: string }) {
  return (
    <div className="redis-tile" role="group" aria-label={title}>
      <div className="redis-tile-title">{title}</div>
      <div className="redis-tile-value tabular">{value}</div>
      {sub && <div className="redis-tile-sub muted">{sub}</div>}
      {spark && <Sparkline values={spark} label={label ?? title} />}
    </div>
  );
}

function Section({ name, values, filter }: { name: string; values: Record<string, string>; filter: string }) {
  const [open, setOpen] = useState(name === 'server' || name === 'memory');
  const entries = Object.entries(values).filter(([k, v]) => !filter || k.toLowerCase().includes(filter) || v.toLowerCase().includes(filter));
  if (filter && !entries.length) return null;
  const isOpen = open || !!filter;
  return (
    <section className="redis-info-section">
      <button className="redis-info-head" aria-expanded={isOpen} onClick={() => setOpen(!open)}>
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} <span>{name}</span> <span className="muted">{entries.length}</span>
      </button>
      {isOpen && (
        <dl className="redis-kv">
          {entries.map(([k, v]) => <div key={k}><dt className="mono">{k}</dt><dd className="mono">{v}</dd></div>)}
        </dl>
      )}
    </section>
  );
}

function Monitor({ cid, autoOpen }: { cid: string; autoOpen: boolean }) {
  const stream = useRedisStream<RedisMonitorItem>('redis.monitor', cid, 5000);
  const [minutes, setMinutes] = useState(10);
  const [filter, setFilter] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const running = stream.status === 'open' || stream.status === 'paused' || stream.status === 'starting';
  const start = async () => {
    const ok = await useUi.getState().askConfirm({
      title: 'Start MONITOR', confirmLabel: 'Start MONITOR', danger: true,
      message: `MONITOR streams every command the server receives. It can cut the server's throughput in half on busy servers: use it briefly. It stops by itself after ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    });
    if (ok) await stream.start({ maxMinutes: minutes });
  };
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [stream.items.length]);
  const f = filter.toLowerCase();
  const shown = (f ? stream.items.filter((m) => m.args.join(' ').toLowerCase().includes(f) || m.client.includes(f)) : stream.items).slice(-1500);
  return (
    <section className={`redis-monitor ${autoOpen ? 'focus' : ''}`} aria-label="Monitor">
      <div className="redis-toolbar">
        <h3>Monitor</h3>
        {!running ? (
          <>
            <Select size="xs" aria-label="Stop after" value={minutes} onChange={(v) => setMinutes(Number(v))}
              options={[1, 5, 10, 30, 60].map((m) => ({ value: m, label: `stop after ${m} min` }))} />
            <button className="btn btn-xs btn-danger-outline" onClick={() => void start()}><Play size={13} /> Start MONITOR</button>
          </>
        ) : (
          <>
            <span className="redis-live open" role="status"><TriangleAlert size={12} /> MONITOR running · stops after {minutes} min</span>
            {stream.status === 'paused'
              ? <button className="btn btn-xs" onClick={() => void stream.resume()}><Play size={13} /> Resume</button>
              : <button className="btn btn-xs" onClick={() => void stream.pause()}><Pause size={13} /> Pause</button>}
            <button className="btn btn-xs" onClick={() => void stream.stop()}><Square size={13} /> Stop</button>
          </>
        )}
        {stream.dropped > 0 && <span className="pill pill-warning">dropped {formatCount(stream.dropped)}</span>}
        <span className="flex-1" />
        <input className="input redis-filter" type="search" aria-label="Filter monitor" placeholder="Filter commands" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted tabular">{formatCount(stream.items.length)} lines</span>
      </div>
      {stream.status === 'ended' && stream.reason === 'completed' && <div className="message sev-warning" role="status">MONITOR stopped automatically after {minutes} minutes.</div>}
      {stream.error && <div className="message sev-error" role="alert">{stream.error}</div>}
      <div className="redis-monitor-log mono" ref={logRef} role="log" aria-label="Monitor output">
        {shown.map((m, i) => (
          <div key={i} className="redis-monitor-line">
            <span className="muted tabular">{new Date(m.ts).toLocaleTimeString('en-GB', { hour12: false })}</span>
            <span className="muted">[{m.db} {m.client}]</span>
            <span>{joinArgs(m.args)}</span>
          </div>
        ))}
        {!shown.length && <div className="muted">{running ? 'Waiting for commands…' : 'Start MONITOR to see every command the server receives.'}</div>}
      </div>
    </section>
  );
}

export function InfoView({ tab, visible }: TabViewProps) {
  const cid = tab.connectionId ?? '';
  const st = tab.state as InfoState;
  const server = useRedis((s) => s.conns[cid]?.server.data);
  const [info, setInfo] = useState<RedisInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [samples, setSamples] = useState<InfoSample[]>([]);
  const [clients, setClients] = useState<RedisClientInfo[] | null>(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'overview' | 'clients' | 'monitor'>(st.monitor ? 'monitor' : 'overview');
  useEffect(() => {
    if (st.monitor) setView('monitor');
  }, [st.monitor]);

  useEffect(() => {
    void loadServer(cid);
  }, [cid]);
  useEffect(() => {
    if (!visible) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.redis.info(cid);
        if (stop) return;
        setInfo(r);
        setError(null);
        setSamples((s) => [...s, sampleOf(r)].slice(-SAMPLES));
      } catch (e) {
        if (!stop) setError(errorText(e));
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [cid, visible]);

  const loadClients = () => api.redis.clients(cid).then(setClients, (e: unknown) => toast('error', 'CLIENT LIST failed', errorText(e)));
  useEffect(() => {
    if (view === 'clients') void loadClients();
    // reload when the tab switches to clients
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, cid]);
  useRedisViewEvents(tab.id, (a) => {
    if (a === 'refresh' && view === 'clients') void loadClients();
  });

  const kill = async (c: RedisClientInfo) => {
    const ok = await useUi.getState().askConfirm({
      title: 'Kill client', danger: true, confirmLabel: 'Kill client', items: [`CLIENT KILL ID ${c.id}`],
      message: `Disconnect ${c.name ?? c.addr} (${c.addr}, user ${c.user ?? 'default'})? Its in-flight command is aborted.`,
    });
    if (!ok) return;
    try {
      await api.redis.killClient(cid, { id: c.id });
      toast('success', `Killed client ${c.id}`);
      void loadClients();
    } catch (e) {
      toast('error', 'CLIENT KILL failed', errorText(e));
    }
  };

  const s = (sec: string, k: string) => info?.sections[sec]?.[k];
  const last = samples.at(-1);
  const prev = samples.at(-2);
  const hitRatio = useMemo(() => {
    if (!last) return null;
    const dh = prev ? last.hits - prev.hits : last.hits;
    const dm = prev ? last.misses - prev.misses : last.misses;
    const total = last.hits + last.misses;
    if (prev && dh + dm > 0) return dh / (dh + dm);
    return total ? last.hits / total : null;
  }, [last, prev]);
  const replicas = Number(s('replication', 'connected_slaves') ?? 0);

  return (
    <div className="redis-view redis-info" data-command-scope="redisInfo">
      <div className="redis-toolbar" role="toolbar" aria-label="Info">
        <div className="segmented" role="tablist" aria-label="Info view">
          {(['overview', 'clients', 'monitor'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'overview' ? 'Overview' : v === 'clients' ? `Clients${info ? ` (${info.clients})` : ''}` : 'Monitor'}</button>
          ))}
        </div>
        <span className="flex-1" />
        <span className="muted">{server?.server.version} · {server?.mode} · polling every {POLL_MS / 1000} s</span>
      </div>
      {error && <div className="message sev-error redis-banner" role="alert">{error}</div>}
      {view === 'overview' && (
        <div className="redis-info-body">
          {info && (
            <div className="redis-tiles">
              <Tile title="Used memory" value={formatBytes(last?.memory ?? 0)} sub={`peak ${formatBytes(Number(s('memory', 'used_memory_peak') ?? 0))} · frag ${s('memory', 'mem_fragmentation_ratio') ?? '–'}`} spark={samples.map((x) => x.memory)} />
              <Tile title="Ops/sec" value={formatCount(last?.ops ?? 0)} sub={`${formatCount(Number(s('stats', 'total_commands_processed') ?? 0))} commands total`} spark={samples.map((x) => x.ops)} />
              <Tile title="Clients" value={formatCount(last?.clients ?? info.clients)} sub={`${s('clients', 'blocked_clients') ?? 0} blocked`} spark={samples.map((x) => x.clients)} />
              <Tile title="Hit ratio" value={hitRatio === null ? '–' : `${(hitRatio * 100).toFixed(1)} %`} sub={`${formatCount(last?.hits ?? 0)} hits · ${formatCount(last?.misses ?? 0)} misses`} />
              <Tile title="Keys" value={formatCount(info.dbSize)} sub={Object.entries(info.sections.keyspace ?? {}).map(([k]) => k).join(' · ') || 'empty'} />
              <Tile title="Uptime" value={formatUptime(Number(s('server', 'uptime_in_seconds') ?? 0))} sub={`Redis ${s('server', 'redis_version') ?? ''}`} />
              <Tile title="Role" value={s('replication', 'role') ?? '–'} sub={`${replicas} replica${replicas === 1 ? '' : 's'}`} />
            </div>
          )}
          {info?.clusterNodes && (
            <section className="redis-info-section">
              <h3>Cluster nodes</h3>
              <table className="redis-table compact">
                <thead><tr><th>Node</th><th>Address</th><th>Flags</th><th>Slots</th><th>Link</th></tr></thead>
                <tbody>{info.clusterNodes.map((n) => <tr key={n.id}><td className="mono">{n.id.slice(0, 10)}</td><td className="mono">{n.address}</td><td>{n.flags.join(', ')}</td><td className="mono">{n.slots.join(' ')}</td><td>{n.linkState}</td></tr>)}</tbody>
              </table>
            </section>
          )}
          <div className="redis-info-sections">
            <input className="input redis-filter" type="search" aria-label="Search INFO" placeholder="Search INFO fields" value={filter} onChange={(e) => setFilter(e.target.value.toLowerCase())} />
            {info && Object.entries(info.sections).map(([name, values]) => <Section key={name} name={name} values={values} filter={filter} />)}
          </div>
        </div>
      )}
      {view === 'clients' && (
        <div className="redis-table-wrap">
          <table className="redis-table" aria-label="Clients">
            <thead><tr><th>ID</th><th>Address</th><th>Name</th><th>User</th><th>DB</th><th>Age</th><th>Idle</th><th>Last command</th><th>Flags</th>{!server?.readOnly && <th />}</tr></thead>
            <tbody>
              {(clients ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="tabular">{c.id}</td><td className="mono">{c.addr}</td><td>{c.name ?? <span className="muted">–</span>}</td><td>{c.user ?? ''}</td>
                  <td className="tabular">{c.db}</td><td className="tabular">{formatUptime(c.ageSeconds)}</td><td className="tabular">{c.idleSeconds}s</td>
                  <td className="mono">{c.cmd ?? ''}</td><td className="mono">{c.flags}</td>
                  {!server?.readOnly && <td><button className="btn btn-xs btn-danger-outline" onClick={() => void kill(c)} aria-label={`Kill client ${c.id}`}><Skull size={12} /> Kill</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="redis-monitor-host" hidden={view !== 'monitor'}><Monitor cid={cid} autoOpen={!!st.monitor} /></div>
    </div>
  );
}

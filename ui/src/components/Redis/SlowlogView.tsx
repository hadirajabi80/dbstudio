// Slowlog (`redis.slowlog`, docs/PLAN-M2.md 5.5): SLOWLOG GET grid (newest first, sortable by duration), 5 s
// auto-refresh, the threshold (CONFIG GET / SET slowlog-log-slower-than, guarded) and SLOWLOG RESET (danger).
import { Lock, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { RedisSlowlogEntry } from '../../api/types';
import { joinArgs } from '../../redis/args';
import { formatCount } from '../../redis/format';
import { toast, useUi } from '../../store/ui';
import type { TabViewProps } from '../layout/tabViews';
import { errorText, loadServer, useRedis } from './store';
import { useRedisViewEvents } from './viewEvents';

export function formatDuration(us: number): string {
  if (us < 1000) return `${us} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

export function SlowlogView({ tab, visible }: TabViewProps) {
  const cid = tab.connectionId ?? '';
  const server = useRedis((s) => s.conns[cid]?.server.data);
  const [rows, setRows] = useState<RedisSlowlogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [sort, setSort] = useState<'time' | 'duration'>('time');
  const [threshold, setThreshold] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [count, setCount] = useState(128);
  const readOnly = !!server?.readOnly;

  const load = useCallback(async () => {
    try {
      setRows(await api.redis.slowlog(cid, count));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [cid, count]);

  useEffect(() => {
    void loadServer(cid);
    void load();
    api.redis.config(cid, 'slowlog-log-slower-than').then((r) => {
      const v = r.values['slowlog-log-slower-than'] ?? null;
      setThreshold(v);
      setDraft(v ?? '');
    }, () => setThreshold(null));
  }, [cid, load]);

  useEffect(() => {
    if (!auto || !visible) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [auto, visible, load]);

  useRedisViewEvents(tab.id, (a) => {
    if (a === 'refresh') void load();
  });

  const sorted = useMemo(() => {
    const r = [...(rows ?? [])];
    if (sort === 'duration') r.sort((a, b) => b.durationUs - a.durationUs);
    return r;
  }, [rows, sort]);

  const reset = async () => {
    const ok = await useUi.getState().askConfirm({ title: 'Reset slowlog', danger: true, confirmLabel: 'Reset', message: `SLOWLOG RESET clears all ${rows?.length ?? ''} entries on the server.` });
    if (!ok) return;
    try {
      await api.redis.resetSlowlog(cid);
      toast('success', 'Slowlog cleared');
      void load();
    } catch (e) {
      toast('error', 'Could not reset the slowlog', errorText(e));
    }
  };

  const saveThreshold = async () => {
    if (!/^-?\d+$/.test(draft.trim())) return toast('error', 'The threshold is a number of microseconds (-1 disables, 0 logs everything).');
    const ok = await useUi.getState().askConfirm({ title: 'Change slowlog threshold', confirmLabel: 'CONFIG SET', message: `Log commands slower than ${formatDuration(Number(draft))} (CONFIG SET slowlog-log-slower-than ${draft.trim()})?` });
    if (!ok) return;
    try {
      await api.redis.setConfig(cid, { name: 'slowlog-log-slower-than', value: draft.trim() });
      setThreshold(draft.trim());
      toast('success', 'Threshold updated');
    } catch (e) {
      toast('error', 'CONFIG SET failed', errorText(e));
    }
  };

  return (
    <div className="redis-view redis-slowlog" data-command-scope="redisSlowlog" onKeyDown={(e) => { if (e.key === 'F5' && !e.ctrlKey) { e.preventDefault(); void load(); } }}>
      <div className="redis-toolbar" role="toolbar" aria-label="Slowlog">
        <button className="icon-btn" aria-label="Refresh slowlog" title="Refresh" onClick={() => void load()}><RefreshCw size={15} /></button>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh 5 s</label>
        <label className="tb-label" htmlFor={`sl-count-${tab.id}`}>Entries</label>
        <input id={`sl-count-${tab.id}`} className="input redis-narrow" type="number" min={1} max={10000} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 128))} />
        <span className="tb-sep" />
        <label className="tb-label" htmlFor={`sl-th-${tab.id}`}>Slower than (µs)</label>
        <input id={`sl-th-${tab.id}`} className="input redis-narrow mono" value={draft} disabled={threshold === null || readOnly} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void saveThreshold(); }} />
        {threshold !== null && draft !== threshold && !readOnly && <button className="btn btn-xs" onClick={() => void saveThreshold()}>Apply</button>}
        {threshold !== null && <span className="muted">{formatDuration(Number(threshold))}</span>}
        <span className="flex-1" />
        {readOnly && <span className="pill pill-muted"><Lock size={11} /> read-only</span>}
        <button className="btn btn-xs btn-danger-outline" disabled={readOnly || !rows?.length} onClick={() => void reset()}><Trash2 size={13} /> Reset</button>
      </div>
      {error && <div className="message sev-error redis-banner" role="alert">{error}</div>}
      <div className="redis-table-wrap">
        <table className="redis-table" aria-label="Slow commands">
          <thead>
            <tr>
              <th style={{ width: 70 }}>ID</th>
              <th style={{ width: 170 }}><button className="link-btn" aria-pressed={sort === 'time'} onClick={() => setSort('time')}>Time {sort === 'time' ? '↓' : ''}</button></th>
              <th style={{ width: 110 }}><button className="link-btn" aria-pressed={sort === 'duration'} onClick={() => setSort('duration')}>Duration {sort === 'duration' ? '↓' : ''}</button></th>
              <th>Command</th>
              <th style={{ width: 170 }}>Client</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.id}-${r.ts}`}>
                <td className="tabular muted">{r.id}</td>
                <td className="tabular">{new Date(r.ts).toLocaleString('en-GB', { hour12: false })}</td>
                <td className={`tabular ${r.durationUs >= 100_000 ? 'text-warning' : ''}`}>{formatDuration(r.durationUs)}</td>
                <td className="mono redis-cell-clip" title={joinArgs(r.args)}>{joinArgs(r.args)}</td>
                <td className="mono muted">{r.client ?? ''}{r.name ? ` (${r.name})` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows && !rows.length && <div className="redis-empty muted">The slowlog is empty.</div>}
        {rows && <div className="muted redis-foot">{formatCount(rows.length)} entries</div>}
      </div>
    </div>
  );
}

// Running tasks (plan-batch3 WP-ES): `_tasks?detailed`, live through the `es.tasks` engine stream while the tab is
// visible (pause = a snapshot); progress of reindex / update-by-query / delete-by-query; cancel cancellable tasks.
import { Pause, Play, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { StreamKind } from '../../api/types';
import type { EsTask, EsTasksStreamItem } from '../../api/types.es';
import { engineSocket } from '../../api/ws';
import { formatMs } from '../../es/format';
import { isPlainObject } from '../../es/json';
import { getConnection } from '../../store/connections';
import { toast } from '../../store/ui';
import { Banner, esErrorText, RefreshButton, ViewHeader } from './parts';
import { isReadOnly } from './store';

const TASKS_STREAM: StreamKind = 'es.tasks';

/** Progress 0..1 of a task with a bulk-by-scroll status (reindex, update/delete by query), else null. */
export function taskProgress(t: EsTask): { done: number; total: number } | null {
  const s = t.status;
  if (!isPlainObject(s) || typeof s.total !== 'number' || s.total <= 0) return null;
  const done = ['created', 'updated', 'deleted', 'noops', 'version_conflicts'].reduce((n, k) => n + (typeof s[k] === 'number' ? (s[k] as number) : 0), 0);
  return { done: Math.min(done, s.total), total: s.total };
}

export function TasksView({ cid, visible }: { cid: string; visible: boolean }) {
  const [tasks, setTasks] = useState<EsTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState('');
  const [all, setAll] = useState(false);
  const [at, setAt] = useState<string | null>(null);
  const ro = isReadOnly(cid);
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      setTasks(await api.es.tasks(cid));
      setAt(new Date().toISOString());
      setError(null);
    } catch (e) {
      setError(esErrorText(e));
    } finally {
      loadingRef.current = false;
    }
  }, [cid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // live stream while visible
  useEffect(() => {
    if (!live || !visible) return;
    let off: (() => void) | null = null;
    let streamId: string | null = null;
    let cancelled = false;
    api.openStream({ kind: TASKS_STREAM, connectionId: cid, params: { intervalMs: 2000, detailed: true } }).then(
      (r) => {
        if (cancelled) {
          void api.closeStream(r.streamId).catch(() => undefined);
          return;
        }
        streamId = r.streamId;
        off = engineSocket.onStream(r.streamId, (ev) => {
          if (ev.type === 'stream.data') {
            const last = ev.items[ev.items.length - 1] as EsTasksStreamItem | undefined;
            if (last) {
              setTasks(last.tasks);
              setAt(last.at);
              setError(null);
            }
          } else if (ev.state === 'error') {
            setError(ev.reason ?? 'The task stream failed.');
            setLive(false);
          }
        });
      },
      (e: unknown) => {
        setError(esErrorText(e));
        setLive(false);
      },
    );
    return () => {
      cancelled = true;
      off?.();
      if (streamId) void api.closeStream(streamId).catch(() => undefined);
    };
  }, [cid, live, visible]);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (tasks ?? [])
      .filter((t) => all || !t.parentTaskId)
      .filter((t) => all || !/^(cluster:monitor\/tasks\/lists|indices:data\/read\/search\[phase)/.test(t.action))
      .filter((t) => !f || t.action.toLowerCase().includes(f) || (t.description ?? '').toLowerCase().includes(f))
      .sort((a, b) => b.runningTimeMs - a.runningTimeMs);
  }, [tasks, filter, all]);

  const cancel = async (t: EsTask) => {
    try {
      await api.es.cancelTask(cid, t.id);
      toast('success', `Cancel requested for ${t.action}`, t.id);
      void refresh();
    } catch (e) {
      toast('error', 'Could not cancel the task', esErrorText(e));
    }
  };

  return (
    <div className="es-view" data-testid="es-tasks">
      <ViewHeader title="Tasks" subtitle={getConnection(cid)?.name} readOnly={ro}>
        <button type="button" className={`btn btn-xs${live ? ' on' : ''}`} onClick={() => setLive((v) => !v)} aria-pressed={live} title={live ? 'Pause live updates' : 'Update every 2 s'}>
          {live ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />} {live ? 'Live' : 'Paused'}
        </button>
        <RefreshButton onClick={() => void refresh()} />
      </ViewHeader>
      <div className="es-toolbar">
        <input className="input es-filter" placeholder="Filter by action or description" aria-label="Filter tasks" value={filter} onChange={(e) => setFilter(e.target.value)} data-primary-focus />
        <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Child and monitoring tasks</label>
        <span className="es-count muted">{rows.length} task{rows.length === 1 ? '' : 's'}{at ? ` · ${new Date(at).toLocaleTimeString()}` : ''}</span>
      </div>
      {error && <Banner>{error}</Banner>}
      <div className="es-scroll">
        <table className="es-table" aria-label="Tasks">
          <thead><tr><th>Action</th><th>Description</th><th>Node</th><th className="num">Running</th><th>Progress</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rows.map((t) => {
              const p = taskProgress(t);
              return (
                <tr key={t.id}>
                  <td className="mono" title={t.id}>{t.action}{t.cancelled && <span className="es-chip es-chip-muted">cancelling</span>}</td>
                  <td className="es-task-desc" title={t.description ?? undefined}>{t.description ?? <span className="muted">—</span>}</td>
                  <td className="mono">{t.node}</td>
                  <td className="num">{formatMs(t.runningTimeMs)}</td>
                  <td>
                    {p ? (
                      <span className="es-progress" title={`${p.done.toLocaleString('en-US')} / ${p.total.toLocaleString('en-US')}`}>
                        <span className="es-progress-bar"><span style={{ width: `${(p.done / p.total) * 100}%` }} /></span>
                        {Math.round((p.done / p.total) * 100)}%
                      </span>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td className="es-cell-actions">
                    {t.cancellable && !t.cancelled && (
                      <button type="button" className="btn btn-xs" disabled={ro} title={ro ? 'Read-only connection' : 'Cancel the task'} onClick={() => void cancel(t)}><X size={12} aria-hidden /> Cancel</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {tasks && rows.length === 0 && <tr><td colSpan={6} className="es-empty-cell">No running tasks{filter ? ' match the filter' : ''}. Reindex, update-by-query and snapshots show up here.</td></tr>}
            {!tasks && !error && <tr><td colSpan={6} className="es-empty-cell">Loading tasks…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

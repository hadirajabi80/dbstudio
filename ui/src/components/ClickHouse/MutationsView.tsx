// Mutations (system.mutations): ALTER … UPDATE / DELETE and their progress, filter running / done, KILL MUTATION.
import { useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { ChMutation } from '../../api/types.clickhouse';
import { getConnection } from '../../store/connections';
import { toast, useUi } from '../../store/ui';
import { formatCount, formatTime, mutationState } from './format';
import { AutoRefresh, Banner, Empty, RefreshButton, ViewHeader } from './parts';
import { useLoad } from './useLoad';

type Filter = 'all' | 'running' | 'done';

const STATE_LABEL = { killed: 'Killed', failing: 'Failing', running: 'Running', done: 'Done' } as const;

export function MutationsView({ cid, database, table, visible }: { cid: string; database: string | null; table: string | null; visible: boolean }) {
  const conn = getConnection(cid);
  const readOnly = !!conn?.readOnly;
  const [auto, setAuto] = useState(true);
  const [filter, setFilter] = useState<Filter>('running');
  const res = useLoad((signal) => api.clickhouse.mutations(cid, database, table, signal), `${cid}:${database}.${table}`, 5000, auto && visible);
  const rows = useMemo(() => (res.data ?? []).filter((m) => filter === 'all' || (filter === 'done' ? m.isDone : !m.isDone)), [res.data, filter]);

  const kill = async (m: ChMutation) => {
    const ok = await useUi.getState().askConfirm({
      title: 'Kill mutation',
      message: `Stop mutation ${m.mutationId} of ${m.database}.${m.table}?\n${m.command}\nParts already mutated keep the change; the rest stay as they are.`,
      confirmLabel: 'Kill mutation',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.clickhouse.killMutation(cid, { database: m.database, table: m.table, mutationId: m.mutationId });
      toast(r.ok ? 'success' : 'warning', r.message);
      res.reload();
    } catch (e) {
      toast('error', 'KILL MUTATION failed', errorMessage(e));
    }
  };

  const counts = { all: res.data?.length ?? 0, running: res.data?.filter((m) => !m.isDone).length ?? 0, done: res.data?.filter((m) => m.isDone).length ?? 0 };

  return (
    <div className="ch-view" data-testid="ch-mutations">
      <ViewHeader title="Mutations" subtitle={table ? `${database ?? ''}.${table} · ${conn?.name ?? ''}` : conn?.name} readOnly={readOnly}>
        <AutoRefresh on={auto} onChange={setAuto} seconds={5} />
        <RefreshButton onClick={res.reload} busy={res.loading} />
      </ViewHeader>
      <div className="ch-toolbar" role="radiogroup" aria-label="Show mutations">
        {(['running', 'done', 'all'] as Filter[]).map((f) => (
          <button key={f} type="button" role="radio" aria-checked={filter === f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'running' ? 'Running' : 'Done'} ({counts[f]})
          </button>
        ))}
      </div>
      {res.error && <Banner>{res.error}</Banner>}
      {!res.data && !res.error && <Empty>Loading mutations…</Empty>}
      {res.data && !rows.length && <Empty>{filter === 'running' ? 'No mutation is running.' : 'No mutations.'}</Empty>}
      {rows.length > 0 && (
        <div className="ch-table-wrap ch-scroll-table">
          <table className="ch-table" aria-label="Mutations">
            <thead>
              <tr>
                <th>Table</th><th>Mutation</th><th>Command</th><th>Created</th><th>State</th><th className="num">Parts to do</th><th>Last failure</th>
                {!readOnly && <th className="ch-cell-actions"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const st = mutationState(m);
                return (
                  <tr key={`${m.database}.${m.table}:${m.mutationId}`}>
                    <td className="mono">{m.database}.{m.table}</td>
                    <td className="mono">{m.mutationId}</td>
                    <td className="mono ch-wrap">{m.command}</td>
                    <td className="mono muted">{formatTime(m.createTime)}</td>
                    <td><span className={`pill ch-state ch-state-${st}`}>{STATE_LABEL[st]}</span></td>
                    <td className="num">{formatCount(m.partsToDo)}</td>
                    <td className="ch-wrap ch-fail" title={m.latestFailTime ? `at ${formatTime(m.latestFailTime)}` : undefined}>{m.latestFailReason ?? <span className="muted">—</span>}</td>
                    {!readOnly && (
                      <td className="ch-cell-actions">
                        {!m.isDone && <button type="button" className="btn btn-xs btn-danger" onClick={() => void kill(m)} aria-label={`Kill mutation ${m.mutationId}`}>Kill</button>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Running merges and part mutations (system.merges) with progress bars, refreshed every 2 s while visible.
import { useState } from 'react';
import { api } from '../../api/client';
import { getConnection } from '../../store/connections';
import { formatBytes, formatCount, formatSeconds } from './format';
import { AutoRefresh, Banner, Empty, RefreshButton, ViewHeader } from './parts';
import { useLoad } from './useLoad';

export function MergesView({ cid, database, table, visible }: { cid: string; database: string | null; table: string | null; visible: boolean }) {
  const conn = getConnection(cid);
  const [auto, setAuto] = useState(true);
  const res = useLoad((signal) => api.clickhouse.merges(cid, database, table, signal), `${cid}:${database}.${table}`, 2000, auto && visible);
  const rows = res.data ?? [];
  return (
    <div className="ch-view" data-testid="ch-merges">
      <ViewHeader title="Running merges" subtitle={table ? `${database ?? ''}.${table} · ${conn?.name ?? ''}` : conn?.name}>
        <AutoRefresh on={auto} onChange={setAuto} seconds={2} />
        <RefreshButton onClick={res.reload} busy={res.loading} />
      </ViewHeader>
      {res.error && <Banner>{res.error}</Banner>}
      {!res.data && !res.error && <Empty>Loading merges…</Empty>}
      {res.data && !rows.length && <Empty>No merge is running.</Empty>}
      {rows.length > 0 && (
        <div className="ch-table-wrap ch-scroll-table">
          <table className="ch-table" aria-label="Merges">
            <thead>
              <tr>
                <th>Table</th><th>Result part</th><th>Kind</th><th>Progress</th><th className="num">Elapsed</th><th className="num">Parts</th>
                <th className="num">Size</th><th className="num">Rows read</th><th className="num">Rows written</th><th className="num">Memory</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const pct = Math.round(Math.max(0, Math.min(1, m.progress)) * 100);
                return (
                  <tr key={`${m.database}.${m.table}:${m.resultPartName}`}>
                    <td className="mono">{m.database}.{m.table}</td>
                    <td className="mono">{m.resultPartName}</td>
                    <td>{m.isMutation ? 'Mutation' : m.mergeType ? `${m.mergeType} merge` : 'Merge'}</td>
                    <td>
                      <div className="ch-progress-wrap">
                        <div className="ch-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Progress of ${m.resultPartName}`}>
                          <div className="ch-progress-bar" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="ch-progress-text">{pct}%</span>
                      </div>
                    </td>
                    <td className="num">{formatSeconds(m.elapsedSec)}</td>
                    <td className="num">{m.numParts}</td>
                    <td className="num">{formatBytes(m.totalSizeBytesCompressed)}</td>
                    <td className="num">{formatCount(m.rowsRead)}</td>
                    <td className="num">{formatCount(m.rowsWritten)}</td>
                    <td className="num">{formatBytes(m.memoryUsage)}</td>
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

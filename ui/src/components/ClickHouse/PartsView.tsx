// Parts & partitions of a MergeTree table (system.parts): engine keys, size and compression tiles, the active
// partitions with Optimize / Detach / Drop, and every part (inactive ones on request).
import { useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { ChPartition } from '../../api/types.clickhouse';
import { getConnection } from '../../store/connections';
import { toast, useUi } from '../../store/ui';
import { optimizeTable } from './actions';
import { formatBytes, formatCount, formatRatio, formatTime } from './format';
import { Banner, Empty, RefreshButton, Tile, ViewHeader } from './parts';
import { useLoad } from './useLoad';

export function PartsView({ cid, database, table }: { cid: string; database: string; table: string }) {
  const conn = getConnection(cid);
  const readOnly = !!conn?.readOnly;
  const res = useLoad((signal) => api.clickhouse.parts(cid, database, table, signal), `${cid}:${database}.${table}`);
  const [showInactive, setShowInactive] = useState(false);
  const d = res.data;
  const parts = useMemo(() => (d?.parts ?? []).filter((p) => showInactive || p.active), [d, showInactive]);
  const active = d?.parts.filter((p) => p.active) ?? [];
  const compressed = active.reduce((a, p) => a + p.dataCompressedBytes, 0);
  const uncompressed = active.reduce((a, p) => a + p.dataUncompressedBytes, 0);

  const partitionAction = async (p: ChPartition, op: 'drop' | 'detach') => {
    const ok = await useUi.getState().askConfirm({
      title: op === 'drop' ? 'Drop partition' : 'Detach partition',
      message: op === 'drop'
        ? `Drop partition ${p.partition} of ${database}.${table}? Its ${formatCount(p.rows)} rows are deleted. This cannot be undone.`
        : `Detach partition ${p.partition} of ${database}.${table}? Its parts move to the detached folder (ATTACH PARTITION brings them back).`,
      confirmLabel: op === 'drop' ? 'Drop partition' : 'Detach partition',
      danger: true,
    });
    if (!ok) return;
    try {
      const body = { database, table, partitionId: p.partitionId };
      const r = op === 'drop' ? await api.clickhouse.dropPartition(cid, body) : await api.clickhouse.detachPartition(cid, body);
      toast(r.ok ? 'success' : 'warning', r.message);
      res.reload();
    } catch (e) {
      toast('error', `${op === 'drop' ? 'Drop' : 'Detach'} partition failed`, errorMessage(e));
    }
  };

  const optimize = async (partition: string | null) => {
    if (await optimizeTable(cid, database, table, partition)) res.reload();
  };

  return (
    <div className="ch-view" data-testid="ch-parts">
      <ViewHeader title={`${database}.${table}`} subtitle={`Parts & partitions · ${conn?.name ?? ''}`} readOnly={readOnly}>
        <RefreshButton onClick={res.reload} busy={res.loading} />
        {!readOnly && <button type="button" className="btn btn-xs" onClick={() => void optimize(null)}>Optimize table…</button>}
      </ViewHeader>
      {res.error && <Banner>{res.error}</Banner>}
      {!d && !res.error && <Empty>Loading parts…</Empty>}
      {d && (
        <div className="ch-scroll">
          <div className="ch-tiles">
            <Tile label="Engine" value={d.engine ?? '—'} />
            <Tile label="Rows" value={formatCount(d.totalRows)} />
            <Tile label="On disk" value={formatBytes(d.totalBytes)} />
            <Tile label="Compression" value={formatRatio(uncompressed, compressed)} title={`${formatBytes(uncompressed)} uncompressed → ${formatBytes(compressed)} compressed`} />
            <Tile label="Partitions" value={formatCount(d.partitions.length)} />
            <Tile label="Active parts" value={formatCount(active.length)} />
          </div>
          <dl className="ch-keys">
            <dt>Partition key</dt><dd className="mono">{d.partitionKey || '—'}</dd>
            <dt>Sorting key</dt><dd className="mono">{d.sortingKey || '—'}</dd>
            <dt>Primary key</dt><dd className="mono">{d.primaryKey || '—'}</dd>
            <dt>Sampling key</dt><dd className="mono">{d.samplingKey || '—'}</dd>
            <dt>TTL</dt><dd className="mono">{d.ttl || '—'}</dd>
          </dl>
          {d.parts.length === 0 && <Empty>{d.engine && /MergeTree/.test(d.engine) ? 'The table has no data parts yet.' : `${d.engine ?? 'This engine'} does not store data in parts.`}</Empty>}
          {d.partitions.length > 0 && (
            <>
              <h3 className="ch-section">Partitions</h3>
              <div className="ch-table-wrap">
                <table className="ch-table" aria-label="Partitions">
                  <thead>
                    <tr>
                      <th>Partition</th><th className="num">Parts</th><th className="num">Rows</th><th className="num">On disk</th>
                      <th className="num">Compressed</th><th className="num">Uncompressed</th><th className="num">Ratio</th><th>Last modified</th>
                      {!readOnly && <th className="ch-cell-actions"><span className="sr-only">Actions</span></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {d.partitions.map((p) => (
                      <tr key={p.partitionId}>
                        <td className="mono">{p.partition}</td>
                        <td className="num">{p.parts}</td>
                        <td className="num">{formatCount(p.rows)}</td>
                        <td className="num">{formatBytes(p.bytesOnDisk)}</td>
                        <td className="num">{formatBytes(p.dataCompressedBytes)}</td>
                        <td className="num">{formatBytes(p.dataUncompressedBytes)}</td>
                        <td className="num">{formatRatio(p.dataUncompressedBytes, p.dataCompressedBytes)}</td>
                        <td className="mono muted">{formatTime(p.lastModified)}</td>
                        {!readOnly && (
                          <td className="ch-cell-actions">
                            <button type="button" className="btn btn-xs" onClick={() => void optimize(p.partitionId)} aria-label={`Optimize partition ${p.partition}`}>Optimize</button>
                            <button type="button" className="btn btn-xs" onClick={() => void partitionAction(p, 'detach')} aria-label={`Detach partition ${p.partition}`}>Detach</button>
                            <button type="button" className="btn btn-xs btn-danger" onClick={() => void partitionAction(p, 'drop')} aria-label={`Drop partition ${p.partition}`}>Drop</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {d.parts.length > 0 && (
            <>
              <div className="ch-section-row">
                <h3 className="ch-section">Parts</h3>
                <label className="ch-check">
                  <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive parts
                </label>
              </div>
              <div className="ch-table-wrap">
                <table className="ch-table" aria-label="Parts">
                  <thead>
                    <tr>
                      <th>Part</th><th>Partition</th><th>Type</th><th className="num">Rows</th><th className="num">Marks</th><th className="num">On disk</th>
                      <th className="num">Ratio</th><th className="num">Level</th><th className="num">Blocks</th><th>Modified</th><th>Disk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parts.map((p) => (
                      <tr key={p.name} className={p.active ? undefined : 'ch-inactive'} title={p.active ? undefined : 'Inactive (merged away, removed after old_parts_lifetime)'}>
                        <td className="mono">{p.name}</td>
                        <td className="mono">{p.partition}</td>
                        <td>{p.partType}</td>
                        <td className="num">{formatCount(p.rows)}</td>
                        <td className="num">{formatCount(p.marks)}</td>
                        <td className="num">{formatBytes(p.bytesOnDisk)}</td>
                        <td className="num">{formatRatio(p.dataUncompressedBytes, p.dataCompressedBytes)}</td>
                        <td className="num">{p.level}</td>
                        <td className="num mono">{p.minBlock}–{p.maxBlock}</td>
                        <td className="mono muted">{formatTime(p.modificationTime)}</td>
                        <td className="muted">{p.disk ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

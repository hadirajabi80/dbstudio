// "Table info" (cassandra.table): partition key, clustering columns with their order, static columns, options,
// indexes, materialized views, size estimate and DDL of a table or materialized view
// (GET /cassandra/{cid}/keyspaces/{ks}/tables/{name}).
import { Copy, SquareTerminal } from 'lucide-react';
import { api } from '../../api/client';
import type { CqlColumnDef, CqlTableInfo } from '../../api/types.cassandra';
import { copyText } from '../../app/actions';
import { getConnection } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import type { TabViewProps } from '../layout/tabViews';
import { formatBytes, formatCount, formatSeconds, optionClass, shortClass } from './format';
import { openTableInfo, type TableViewState } from './open';
import { Banner, Dash, Empty, RefreshButton, Tile, ViewHeader } from './parts';
import { useLoad } from './useLoad';

const SAI = 'StorageAttachedIndex';
/** Options shown as seconds. */
const SECONDS_OPTIONS = new Set(['default_time_to_live', 'gc_grace_seconds']);

function kindLabel(c: CqlColumnDef, t: CqlTableInfo): string {
  if (c.kind === 'partition_key') return t.partitionKey.length > 1 ? `partition key (${c.position + 1} of ${t.partitionKey.length})` : 'partition key';
  if (c.kind === 'clustering') return `clustering ${c.position + 1} ${(c.order ?? 'asc').toUpperCase()}`;
  if (c.kind === 'static') return 'static';
  return '';
}

export function TableInfoView({ tab }: TabViewProps) {
  const cid = tab.connectionId;
  const st = (tab.state ?? {}) as Partial<TableViewState>;
  const key = cid && st.keyspace && st.name ? `${cid}:${st.keyspace}.${st.name}` : null;
  const info = useLoad(key, () => api.cassandra.tableInfo(cid!, st.keyspace!, st.name!));
  if (!key) return <div className="cs-view"><Empty>This tab names no table.</Empty></div>;
  const t = info.data;
  return (
    <div className="cs-view" data-testid="cassandra-table">
      <ViewHeader
        title={<>{t?.type === 'mview' ? 'Materialized view' : 'Table'} <span className="mono">{st.keyspace}.{st.name}</span></>}
        subtitle={getConnection(cid)?.name}
      >
        <RefreshButton onClick={info.reload} busy={info.loading} />
      </ViewHeader>
      {info.error && <Banner actions={<button type="button" className="btn btn-xs" onClick={info.reload}>Retry</button>}>{info.error}</Banner>}
      {!t && !info.error && <Empty>Loading table…</Empty>}
      {t && cid && <TableInfoBody cid={cid} t={t} />}
    </div>
  );
}

function TableInfoBody({ cid, t }: { cid: string; t: CqlTableInfo }) {
  const keyCols = t.columns.filter((c) => c.kind === 'partition_key' || c.kind === 'clustering')
    .sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind === 'partition_key' ? -1 : 1));
  const statics = t.columns.filter((c) => c.kind === 'static');
  const regular = t.columns.filter((c) => c.kind === 'regular');
  const total = t.estimatedPartitions !== null && t.meanPartitionSizeBytes !== null ? t.estimatedPartitions * t.meanPartitionSizeBytes : null;
  const ttl = Number(t.options.default_time_to_live ?? '0');
  const openInConsole = () => useTabs.getState().newConsole({ connectionId: cid, database: t.keyspace, text: `${t.ddl}\n` });
  return (
    <div className="cs-scroll">
      <div className="cs-tiles" role="list" aria-label="Table summary">
        <Tile label="Partition key" value={t.partitionKey.length === 1 ? t.partitionKey[0] : `${t.partitionKey.length} columns`} title={t.partitionKey.join(', ')} />
        <Tile label="Clustering columns" value={t.clustering.length} />
        <Tile label="Est. partitions" value={formatCount(t.estimatedPartitions)} title="system.size_estimates of the local node" />
        <Tile label="Mean partition" value={formatBytes(t.meanPartitionSizeBytes)} />
        <Tile label="Est. size (local)" value={formatBytes(total)} title="Estimated partitions × mean partition size on the local node" />
        <Tile label="Default TTL" value={formatSeconds(ttl)} />
        <Tile label="Compaction" value={optionClass(t.options.compaction)?.replace(/CompactionStrategy$/, '') ?? '—'} title={t.options.compaction} />
      </div>
      <div className="cs-pk">
        <code className="mono">{t.primaryKey}</code>
        {t.isCounter && <span className="pill cs-inline-pill" title="Counter columns: rows are only changed with UPDATE … SET c = c + n">counter table</span>}
      </div>
      {t.type === 'mview' && (
        <dl className="cs-dl cs-dl-rows">
          <div><dt>Base table</dt><dd>{t.baseTable ? <button type="button" className="btn btn-xs" onClick={() => openTableInfo(cid, t.keyspace, t.baseTable!)}>{t.baseTable}</button> : <Dash />}</dd></div>
          <div><dt>Where</dt><dd><code className="mono">{t.whereClause ?? ''}</code></dd></div>
        </dl>
      )}

      <h3 className="cs-section-title">Primary key</h3>
      <div className="cs-table-wrap">
        <table className="cs-table" aria-label="Primary key columns">
          <thead><tr><th>Column</th><th>Type</th><th>Role</th><th>Order</th></tr></thead>
          <tbody>
            {keyCols.map((c) => (
              <tr key={c.name} className={c.kind === 'partition_key' ? 'cs-pk-row' : undefined}>
                <td className="mono">{c.name}</td>
                <td className="mono cs-type">{c.type}</td>
                <td>{kindLabel(c, t)}</td>
                <td>{c.kind === 'clustering' ? (c.order ?? 'asc').toUpperCase() : <Dash />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cs-note">
        Queries must restrict every partition key column (= or IN); clustering columns can be restricted in order, the last one by a range.
      </p>

      {statics.length > 0 && (
        <>
          <h3 className="cs-section-title">Static columns</h3>
          <p className="cs-note">One value per partition, shared by every row of it.</p>
          <ColumnTable label="Static columns" cols={statics} />
        </>
      )}
      <h3 className="cs-section-title">Columns ({regular.length})</h3>
      <ColumnTable label="Regular columns" cols={regular} />

      <h3 className="cs-section-title">Indexes</h3>
      {t.indexes.length === 0 ? <Empty>No secondary indexes.</Empty> : (
        <div className="cs-table-wrap">
          <table className="cs-table" aria-label="Indexes">
            <thead><tr><th>Name</th><th>Target</th><th>Kind</th><th>Class</th></tr></thead>
            <tbody>
              {t.indexes.map((ix) => (
                <tr key={ix.name}>
                  <td className="mono">{ix.name}</td>
                  <td className="mono">{ix.target ?? <Dash />}</td>
                  <td>{ix.kind}</td>
                  <td title={ix.className ?? undefined}>{ix.className ? (shortClass(ix.className) === SAI ? 'SAI (StorageAttachedIndex)' : shortClass(ix.className)) : <Dash />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {t.type === 'table' && (
        <>
          <h3 className="cs-section-title">Materialized views</h3>
          {t.views.length === 0 ? <Empty>No materialized views.</Empty> : (
            <ul className="cs-chips" aria-label="Materialized views">
              {t.views.map((v) => (
                <li key={v}><button type="button" className="btn btn-xs" onClick={() => openTableInfo(cid, t.keyspace, v)}>{v}</button></li>
              ))}
            </ul>
          )}
        </>
      )}

      <h3 className="cs-section-title">Options</h3>
      <div className="cs-table-wrap">
        <table className="cs-table" aria-label="Table options">
          <thead><tr><th>Option</th><th>Value</th></tr></thead>
          <tbody>
            {Object.entries(t.options).map(([k, v]) => (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td className="mono cs-option-value">
                  {v}
                  {SECONDS_OPTIONS.has(k) && Number(v) > 0 && <span className="muted"> ({formatSeconds(Number(v))})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="cs-section-head">
        <h3 className="cs-section-title">DDL</h3>
        <span className="cs-inline-actions">
          <button type="button" className="btn btn-xs" onClick={() => void copyText(t.ddl, 'DDL copied')}><Copy size={13} aria-hidden /> Copy</button>
          <button type="button" className="btn btn-xs" onClick={openInConsole}><SquareTerminal size={13} aria-hidden /> Open in console</button>
        </span>
      </div>
      <pre className="cs-code" aria-label="DDL">{t.ddl}</pre>
    </div>
  );
}

function ColumnTable({ label, cols }: { label: string; cols: CqlColumnDef[] }) {
  if (cols.length === 0) return <Empty>None.</Empty>;
  return (
    <div className="cs-table-wrap">
      <table className="cs-table" aria-label={label}>
        <thead><tr><th>Column</th><th>Type</th></tr></thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.name}><td className="mono">{c.name}</td><td className="mono cs-type">{c.type}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

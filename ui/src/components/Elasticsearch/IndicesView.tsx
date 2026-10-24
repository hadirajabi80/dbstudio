// Index list (Elasticvue / `_cat/indices` style): filter, hidden toggle, sortable columns, health, aliases; a row opens
// the index, its buttons search or delete it.
import { ArrowDown, ArrowUp, Plus, TextSearch, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EsIndexSummary } from '../../api/types.es';
import { runCommand } from '../../commands/registry';
import { formatBytes, formatCount } from '../../es/format';
import { getConnection } from '../../store/connections';
import { openIndex, openSearch } from './open';
import { Banner, HealthDot, RefreshButton, ViewHeader } from './parts';
import { isReadOnly, loadAliases, loadIndices, setShowHidden, useEs } from './store';

type SortKey = 'name' | 'health' | 'docs' | 'size' | 'shards';

const HEALTH_RANK: Record<string, number> = { red: 0, yellow: 1, green: 2 };

function sortIndices(list: EsIndexSummary[], key: SortKey, dir: 1 | -1): EsIndexSummary[] {
  const v = (i: EsIndexSummary): number | string => {
    switch (key) {
      case 'name': return i.name;
      case 'health': return HEALTH_RANK[i.health ?? ''] ?? -1;
      case 'docs': return i.docsCount ?? -1;
      case 'size': return i.storeBytes ?? -1;
      case 'shards': return i.primaries * (1 + i.replicas);
    }
  };
  return [...list].sort((a, b) => {
    const x = v(a);
    const y = v(b);
    return (typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number)) * dir;
  });
}

export function IndicesView({ cid }: { cid: string }) {
  const conn = useEs((s) => s.conns[cid]);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  useEffect(() => {
    void loadIndices(cid);
    void loadAliases(cid);
  }, [cid]);
  const indices = conn?.indices;
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return sortIndices((indices?.data ?? []).filter((i) => !f || i.name.includes(f) || i.aliases.some((a) => a.includes(f))), sort.key, sort.dir);
  }, [indices?.data, filter, sort]);
  const ro = isReadOnly(cid);
  const totalDocs = rows.reduce((s, i) => s + (i.docsCount ?? 0), 0);
  const totalBytes = rows.reduce((s, i) => s + (i.storeBytes ?? 0), 0);
  const th = (key: SortKey, label: string, num = false) => (
    <th className={num ? 'num' : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="es-th-btn" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 }))}>
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden />)}
      </button>
    </th>
  );

  return (
    <div className="es-view" data-testid="es-indices">
      <ViewHeader title="Indices" subtitle={getConnection(cid)?.name} readOnly={ro}>
        {!ro && <button type="button" className="btn btn-xs" onClick={() => runCommand('es.createIndex', { kind: 'connection', connectionId: cid })}><Plus size={13} aria-hidden /> Create index</button>}
        <RefreshButton onClick={() => void loadIndices(cid, true)} busy={indices?.loading} />
      </ViewHeader>
      <div className="es-toolbar">
        <input className="input es-filter" placeholder="Filter indices and aliases" aria-label="Filter indices" value={filter} onChange={(e) => setFilter(e.target.value)} data-primary-focus />
        <label className="check"><input type="checkbox" checked={!!conn?.showHidden} onChange={(e) => setShowHidden(cid, e.target.checked)} /> Hidden and system indices</label>
        <span className="es-count muted">{rows.length} indices · {formatCount(totalDocs)} docs · {formatBytes(totalBytes)}</span>
      </div>
      {indices?.error && <Banner>{indices.error}</Banner>}
      <div className="es-scroll">
        <table className="es-table es-table-hover" aria-label="Indices">
          <thead>
            <tr>
              {th('health', 'Health')}
              {th('name', 'Index')}
              <th>Status</th>
              {th('shards', 'Shards', true)}
              {th('docs', 'Documents', true)}
              <th className="num">Deleted</th>
              {th('size', 'Size', true)}
              <th>Aliases</th>
              <th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.name} onClick={() => openIndex(cid, i.name)} className={i.status === 'close' ? 'es-row-closed' : undefined}>
                <td><HealthDot health={i.health} label /></td>
                <td className="mono">
                  {i.name}
                  {i.dataStream && <span className="es-chip es-chip-muted" title={`Backing index of ${i.dataStream}`}>{i.dataStream}</span>}
                  {i.system && <span className="es-chip es-chip-muted">system</span>}
                </td>
                <td>{i.status === 'close' ? <span className="pill pill-muted">closed</span> : 'open'}</td>
                <td className="num">{i.primaries} × {1 + i.replicas}</td>
                <td className="num">{formatCount(i.docsCount)}</td>
                <td className="num muted">{formatCount(i.docsDeleted)}</td>
                <td className="num">{formatBytes(i.storeBytes)}</td>
                <td>{i.aliases.map((a) => <span key={a} className="es-chip">{a}</span>)}</td>
                <td className="es-cell-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="icon-btn xs" aria-label={`Search ${i.name}`} title="Search" onClick={() => openSearch(cid, i.name)}><TextSearch size={13} /></button>
                  {!ro && (
                    <button type="button" className="icon-btn xs danger" aria-label={`Delete ${i.name}`} title="Delete index…"
                      onClick={() => runCommand('es.deleteIndex', { kind: 'source', connectionId: cid, providerId: 'elasticsearch', nodeType: 'index', path: ['indices', i.name] })}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {indices?.data && rows.length === 0 && <tr><td colSpan={9} className="es-empty-cell">{filter ? 'No index matches the filter.' : 'No indices.'}</td></tr>}
            {!indices?.data && !indices?.error && <tr><td colSpan={9} className="es-empty-cell">Loading indices…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

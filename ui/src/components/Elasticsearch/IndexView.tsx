// One index / alias / data stream (plan-batch3 WP-ES): Documents (grid + JSON record view + editor) · Mappings ·
// Settings · Aliases · Shards · Stats. The detail (`GET /es/{cid}/indices/{index}`) is read once per tab and shared by
// the sub-views; Refresh re-reads it.
import { Link2, Pencil, Plus, SquareTerminal, TextSearch, Trash2 } from 'lucide-react';
import { createElement, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { EsField, EsIndexDetail } from '../../api/types.es';
import { runCommand } from '../../commands/registry';
import { formatBytes, formatCount, formatMs } from '../../es/format';
import { getPath, isPlainObject, pretty } from '../../es/json';
import { toast } from '../../store/ui';
import type { TabViewProps } from '../layout/tabViews';
import { showEsDialog } from './dialogHost';
import { DocumentsPanel } from './DocumentsPanel';
import { JsonTree } from './JsonTree';
import { INDEX_SUBS, indexTabState, openConsole, openSearch, patchTab, type IndexSub } from './open';
import { Banner, Empty, esErrorText, HealthDot, RefreshButton, Tile, ViewHeader } from './parts';
import { indicesChanged, isReadOnly, loadAliases, loadFields, useEs } from './store';

const SUB_LABEL: Record<IndexSub, string> = { documents: 'Documents', mappings: 'Mappings', settings: 'Settings', aliases: 'Aliases', shards: 'Shards', stats: 'Stats' };

export function IndexView({ tab, theme, visible, cid }: TabViewProps & { cid: string }) {
  const st = indexTabState(tab);
  const index = st.index;
  const [detail, setDetail] = useState<EsIndexDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const summary = useEs((s) => s.conns[cid]?.indices.data?.find((i) => i.name === index));
  const isAliasLike = !summary;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await api.es.index(cid, index));
      setError(null);
    } catch (e) {
      setError(esErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [cid, index]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ cid: string; index: string }>).detail;
      if (d.cid === cid && d.index === index) void load();
    };
    window.addEventListener('dbstudio:es-index-changed', on);
    return () => window.removeEventListener('dbstudio:es-index-changed', on);
  }, [cid, index, load]);

  const setSub = (sub: IndexSub) => patchTab(tab.id, { sub });
  const s = detail?.summary ?? summary ?? null;
  const subtitle = s ? `${formatCount(s.docsCount)} docs · ${formatBytes(s.storeBytes)} · ${s.primaries} × ${1 + s.replicas} shards${s.status === 'close' ? ' · closed' : ''}`
    : isAliasLike && detail ? `alias / data stream → ${detail.name}` : undefined;

  return (
    <div className="es-view" data-testid="es-index">
      <ViewHeader title={<><HealthDot health={s?.health} /> <span className="mono">{index}</span></>} subtitle={subtitle} readOnly={isReadOnly(cid)}>
        <button type="button" className="btn btn-xs" onClick={() => openSearch(cid, index)}><TextSearch size={13} aria-hidden /> Search</button>
        <button type="button" className="btn btn-xs" onClick={() => openConsole(cid, `GET /${index}/_search\n{\n  "query": { "match_all": {} }\n}`)}><SquareTerminal size={13} aria-hidden /> Dev Tools</button>
        <RefreshButton onClick={() => void load()} busy={loading} />
      </ViewHeader>
      <div className="es-subtabs" role="tablist" aria-label="Index views">
        {INDEX_SUBS.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={st.sub === x} className={`es-subtab${st.sub === x ? ' on' : ''}`} onClick={() => setSub(x)}>
            {SUB_LABEL[x]}
          </button>
        ))}
      </div>
      {error && st.sub !== 'documents' && <Banner actions={<button type="button" className="btn btn-xs" onClick={() => void load()}>Retry</button>}>{error}</Banner>}
      {st.sub === 'documents' && <DocumentsPanel cid={cid} index={index} theme={theme} visible={visible} tabId={tab.id} initialQ={st.q ?? ''} initialSize={st.size ?? 50} />}
      {st.sub === 'mappings' && <MappingsPanel cid={cid} index={index} detail={detail} theme={theme} onChanged={load} />}
      {st.sub === 'settings' && <SettingsPanel cid={cid} index={detail?.name ?? index} detail={detail} theme={theme} onChanged={load} />}
      {st.sub === 'aliases' && <AliasesPanel cid={cid} index={detail?.name ?? index} detail={detail} onChanged={load} />}
      {st.sub === 'shards' && <ShardsPanel detail={detail} />}
      {st.sub === 'stats' && <StatsPanel detail={detail} />}
    </div>
  );
}

// ---------------------------------------------------------------- mappings

function MappingsPanel({ cid, index, detail, theme, onChanged }: { cid: string; index: string; detail: EsIndexDetail | null; theme: TabViewProps['theme']; onChanged(): void }) {
  const [fields, setFields] = useState<EsField[] | null>(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'fields' | 'json'>('fields');
  useEffect(() => {
    void loadFields(cid, index, true).then(setFields);
  }, [cid, index, detail]);
  const rows = useMemo(() => (fields ?? []).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase())), [fields, filter]);
  const ro = isReadOnly(cid);
  const addField = async () => {
    const { JsonEditDialog } = await import('./dialogs');
    showEsDialog((close) => createElement(JsonEditDialog, {
      title: `Add fields to ${index}`, theme, onClose: close, action: 'Update mapping',
      help: 'New fields only: existing field types cannot change (reindex into a new index for that). Multi-fields and new sub-properties are allowed.',
      initial: pretty({ properties: { new_field: { type: 'keyword' } } }),
      onSave: async (value: unknown) => {
        await api.es.putMappings(cid, detail?.name ?? index, value);
        toast('success', `Mapping of ${index} updated`);
        onChanged();
      },
    }));
  };
  return (
    <>
      <div className="es-toolbar">
        <div className="es-seg" role="group" aria-label="Mapping view">
          <button type="button" className={view === 'fields' ? 'on' : undefined} onClick={() => setView('fields')}>Fields</button>
          <button type="button" className={view === 'json' ? 'on' : undefined} onClick={() => setView('json')}>JSON</button>
        </div>
        {view === 'fields' && <input className="input es-filter" placeholder="Filter fields" aria-label="Filter fields" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <span className="es-count muted">{fields ? `${fields.filter((f) => f.type !== 'object').length} fields` : ''}</span>
        {!ro && <button type="button" className="btn btn-xs" onClick={() => void addField()}><Plus size={13} aria-hidden /> Add fields…</button>}
      </div>
      <div className="es-scroll es-pad">
        {view === 'json' ? (detail ? <JsonTree value={detail.mappings} openDepth={4} label="Mappings" /> : <Empty>Loading…</Empty>) : (
          <table className="es-table" aria-label="Fields">
            <thead><tr><th>Field</th><th>Type</th><th>Searchable</th><th>Aggregatable</th></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.path}>
                  <td className="mono" style={{ paddingLeft: 8 + (f.path.split('.').length - 1) * 14 }}>
                    {f.parent ? <span className="muted">{f.parent}.</span> : null}{f.parent ? f.path.slice(f.parent.length + 1) : f.path}
                  </td>
                  <td><span className={`es-type es-type-${f.type.replace(/_/g, '-')}`}>{f.type}</span></td>
                  <td>{f.searchable ? '✓' : <span className="muted">—</span>}</td>
                  <td>{f.aggregatable ? '✓' : <span className="muted">—</span>}</td>
                </tr>
              ))}
              {fields && !rows.length && <tr><td colSpan={4} className="es-empty-cell">No fields{filter ? ' match the filter' : ' (the index has no mapping yet)'}.</td></tr>}
              {!fields && <tr><td colSpan={4} className="es-empty-cell">Loading fields…</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- settings

/** `{ index: { … } }` of the settings object (first index when an alias/pattern returned several). */
function indexSettings(detail: EsIndexDetail | null): Record<string, unknown> {
  const s = detail?.settings;
  if (!isPlainObject(s)) return {};
  if (isPlainObject(s.index)) return s.index;
  return s;
}

function SettingsPanel({ cid, index, detail, theme, onChanged }: { cid: string; index: string; detail: EsIndexDetail | null; theme: TabViewProps['theme']; onChanged(): void }) {
  const ro = isReadOnly(cid);
  const idx = indexSettings(detail);
  const edit = async () => {
    const { JsonEditDialog } = await import('./dialogs');
    showEsDialog((close) => createElement(JsonEditDialog, {
      title: `Settings of ${index}`, theme, onClose: close, action: 'Update settings',
      help: 'Dynamic settings only (replicas, refresh interval, max_result_window, blocks…). Static settings such as number_of_shards need a closed index or a new one.',
      initial: pretty({ index: { number_of_replicas: Number(idx.number_of_replicas ?? 1), refresh_interval: idx.refresh_interval ?? '1s' } }),
      onSave: async (value: unknown) => {
        await api.es.putSettings(cid, index, value);
        toast('success', `Settings of ${index} updated`);
        onChanged();
        indicesChanged(cid);
      },
    }));
  };
  const key = (k: string) => idx[k] as string | number | undefined;
  return (
    <>
      <div className="es-toolbar">
        <span className="muted">Shards <strong>{key('number_of_shards') ?? '—'}</strong> · replicas <strong>{key('number_of_replicas') ?? '—'}</strong> · refresh <strong>{key('refresh_interval') ?? '1s (default)'}</strong>
          {key('creation_date') && <> · created <strong>{new Date(Number(key('creation_date'))).toLocaleString()}</strong></>}
          {getPath(idx, 'version.created') !== undefined && <> · version <strong className="mono">{String(getPath(idx, 'version.created'))}</strong></>}
        </span>
        <span className="flex-1" />
        {!ro && <button type="button" className="btn btn-xs" onClick={() => void edit()}><Pencil size={13} aria-hidden /> Edit settings…</button>}
      </div>
      <div className="es-scroll es-pad">{detail ? <JsonTree value={detail.settings} openDepth={3} label="Settings" /> : <Empty>Loading…</Empty>}</div>
    </>
  );
}

// ---------------------------------------------------------------- aliases

function AliasesPanel({ cid, index, detail, onChanged }: { cid: string; index: string; detail: EsIndexDetail | null; onChanged(): void }) {
  const ro = isReadOnly(cid);
  const aliases = isPlainObject(detail?.aliases) ? Object.entries(detail.aliases as Record<string, Record<string, unknown>>) : [];
  const remove = async (alias: string) => {
    try {
      await api.es.updateAliases(cid, { actions: [{ remove: { index, alias } }] });
      toast('success', `Removed alias ${alias} from ${index}`);
      void loadAliases(cid, true);
      indicesChanged(cid);
      onChanged();
    } catch (e) {
      toast('error', `Could not remove ${alias}`, esErrorText(e));
    }
  };
  return (
    <>
      <div className="es-toolbar">
        <span className="muted">{aliases.length ? `${aliases.length} alias${aliases.length === 1 ? '' : 'es'} on ${index}` : `No aliases on ${index}`}</span>
        <span className="flex-1" />
        {!ro && (
          <button type="button" className="btn btn-xs" onClick={() => runCommand('es.addAlias', { kind: 'source', connectionId: cid, providerId: 'elasticsearch', nodeType: 'index', path: ['indices', index] })}>
            <Link2 size={13} aria-hidden /> Add alias…
          </button>
        )}
      </div>
      <div className="es-scroll">
        <table className="es-table" aria-label="Aliases">
          <thead><tr><th>Alias</th><th>Write index</th><th>Filter</th><th>Routing</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {aliases.map(([alias, a]) => (
              <tr key={alias}>
                <td className="mono">{alias}</td>
                <td>{a.is_write_index === true ? 'yes' : a.is_write_index === false ? 'no' : <span className="muted">—</span>}</td>
                <td className="mono es-cell-json">{a.filter ? JSON.stringify(a.filter) : <span className="muted">—</span>}</td>
                <td className="mono">{[a.index_routing, a.search_routing].filter(Boolean).join(' / ') || <span className="muted">—</span>}</td>
                <td className="es-cell-actions">
                  {!ro && <button type="button" className="icon-btn xs danger" aria-label={`Remove alias ${alias}`} onClick={() => void remove(alias)}><Trash2 size={13} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- shards

function ShardsPanel({ detail }: { detail: EsIndexDetail | null }) {
  if (!detail) return <Empty>Loading…</Empty>;
  const shards = [...detail.shards].sort((a, b) => a.shard - b.shard || a.prirep.localeCompare(b.prirep));
  const unassigned = shards.filter((s) => s.state === 'UNASSIGNED').length;
  return (
    <div className="es-scroll">
      {unassigned > 0 && <Banner tone="warn">{unassigned} shard{unassigned === 1 ? ' is' : 's are'} unassigned (on a single-node cluster, replicas cannot be assigned: set number_of_replicas to 0).</Banner>}
      <div className="es-shard-map" aria-label="Shard map">
        {shards.map((s, i) => (
          <span key={i} className={`es-shard es-shard-${s.prirep} es-shard-${s.state.toLowerCase()}`} title={`${s.prirep === 'p' ? 'Primary' : 'Replica'} ${s.shard} · ${s.state}${s.node ? ` · ${s.node}` : ''}`}>
            {s.shard}{s.prirep === 'p' ? 'P' : 'R'}
          </span>
        ))}
      </div>
      <table className="es-table" aria-label="Shards">
        <thead><tr><th className="num">Shard</th><th>Type</th><th>State</th><th className="num">Docs</th><th className="num">Size</th><th>Node</th><th>Address</th><th>Unassigned reason</th></tr></thead>
        <tbody>
          {shards.map((s, i) => (
            <tr key={i}>
              <td className="num">{s.shard}</td>
              <td>{s.prirep === 'p' ? 'primary' : 'replica'}</td>
              <td><span className={`es-state es-state-${s.state.toLowerCase()}`}>{s.state.toLowerCase()}</span></td>
              <td className="num">{formatCount(s.docs)}</td>
              <td className="num">{formatBytes(s.storeBytes)}</td>
              <td>{s.node ?? <span className="muted">—</span>}</td>
              <td className="mono">{s.ip ?? '—'}</td>
              <td className="muted">{s.unassignedReason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- stats

function StatsPanel({ detail }: { detail: EsIndexDetail | null }) {
  if (!detail) return <Empty>Loading…</Empty>;
  const p = detail.stats?.primaries;
  const t = detail.stats?.total;
  const n = (obj: unknown, path: string) => {
    const v = getPath(obj, path);
    return typeof v === 'number' ? v : null;
  };
  const avg = (time: number | null, count: number | null) => (time != null && count ? formatMs(time / count) : '—');
  return (
    <div className="es-scroll es-pad">
      <div className="es-tiles" role="list" aria-label="Index statistics">
        <Tile label="Documents (primaries)" value={formatCount(n(p, 'docs.count'))} sub={`${formatCount(n(p, 'docs.deleted'))} deleted`} />
        <Tile label="Store (primaries)" value={formatBytes(n(p, 'store.size_in_bytes'))} sub={`${formatBytes(n(t, 'store.size_in_bytes'))} with replicas`} />
        <Tile label="Indexing ops" value={formatCount(n(t, 'indexing.index_total'))} sub={`avg ${avg(n(t, 'indexing.index_time_in_millis'), n(t, 'indexing.index_total'))}`} />
        <Tile label="Queries" value={formatCount(n(t, 'search.query_total'))} sub={`avg ${avg(n(t, 'search.query_time_in_millis'), n(t, 'search.query_total'))}`} />
        <Tile label="Fetches" value={formatCount(n(t, 'search.fetch_total'))} />
        <Tile label="Get by id" value={formatCount(n(t, 'get.total'))} />
        <Tile label="Segments" value={formatCount(n(t, 'segments.count'))} />
        <Tile label="Refreshes" value={formatCount(n(t, 'refresh.total'))} />
        <Tile label="Merges" value={formatCount(n(t, 'merges.total'))} />
        <Tile label="Query cache" value={formatBytes(n(t, 'query_cache.memory_size_in_bytes'))} />
        <Tile label="Field data" value={formatBytes(n(t, 'fielddata.memory_size_in_bytes'))} />
      </div>
      <h3 className="es-section-title">Raw statistics</h3>
      {detail.stats ? <JsonTree value={detail.stats} openDepth={1} label="Statistics" /> : <Empty>No statistics.</Empty>}
    </div>
  );
}


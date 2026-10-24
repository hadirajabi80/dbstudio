// Explorer subtree of an Elasticsearch / OpenSearch connection (plan-batch3 WP-ES):
//   connection → Overview, Dev Tools, SQL, Indices (count) → indices, Aliases → aliases, Data streams → streams,
//   Templates → templates, Nodes → nodes, Tasks
// Paths below the connection: ['overview'], ['console'], ['sql'], ['tasks'], ['indices'], ['indices', i], ['aliases'],
// ['aliases', a], ['datastreams'], ['datastreams', d], ['templates'], ['templates', `${kind}:${name}`], ['nodes'], ['nodes', id].
import type { ConnectionProfile } from '../../api/types';
import type { EsHealth } from '../../api/types.es';
import { formatBytes, formatCount } from '../../es/format';
import { fuzzyMatchLower } from '../../lib/fuzzy';
import { sourceNodeId, sourceRow, type SourceTreeInput } from '../../lib/sources';
import type { TreeRow } from '../Explorer/tree';
import { esConn, loadAliases, loadDataStreams, loadIndices, loadNodes, loadTemplates, type Loadable } from './store';

export type EsNodeType = 'overview' | 'console' | 'sql' | 'tasks' | 'indices' | 'index' | 'aliases' | 'alias' | 'datastreams' | 'datastream'
  | 'templates' | 'template' | 'nodes' | 'node';

export interface IndexMeta { health: EsHealth | null; status: 'open' | 'close'; hidden: boolean }
export interface AliasMeta { indices: string[] }
export interface NodeMeta { master: boolean; roles: string[] }

function statusRow(parent: string, depth: number, status: 'loading' | 'error' | 'empty', label: string): TreeRow {
  return { id: `${parent}#${status}`, kind: 'status', depth, label, expandable: false, expanded: false, status };
}

export function esTree({ connection, depth, expanded, filter }: SourceTreeInput): TreeRow[] {
  const cid = connection.id;
  const c = esConn(cid);
  const base = { connectionId: cid, providerId: 'elasticsearch' as const, expanded };
  const f = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];
  const match = (s: string) => (f ? fuzzyMatchLower(f, s, s.toLowerCase())?.positions : undefined);

  if (!f) {
    rows.push(sourceRow({ ...base, nodeType: 'overview', path: ['overview'], depth, label: 'Overview' }));
    rows.push(sourceRow({ ...base, nodeType: 'console', path: ['console'], depth, label: 'Dev Tools' }));
    rows.push(sourceRow({ ...base, nodeType: 'sql', path: ['sql'], depth, label: 'SQL' }));
  }

  function folder<T>(nodeType: EsNodeType, key: string, label: string, list: Loadable<T[]>, items: { name: string; row: (m?: number[]) => TreeRow }[],
    noun: string, detail?: string) {
    const hits = items.map((x) => ({ x, m: match(x.name) })).filter((h) => !f || h.m);
    if (f && !hits.length) return;
    const row = sourceRow({ ...base, nodeType, path: [key], depth, label, expandable: true, count: list.data?.length, forceOpen: !!f, detail });
    rows.push(row);
    if (!row.expanded) return;
    if (!list.data) rows.push(statusRow(row.id, depth + 1, list.error ? 'error' : 'loading', list.error ?? `Loading ${noun}…`));
    else if (!list.data.length) rows.push(statusRow(row.id, depth + 1, 'empty', `No ${noun}`));
    for (const { x, m } of hits) rows.push(x.row(m));
  }

  folder('indices', 'indices', 'Indices', c.indices, (c.indices.data ?? []).map((i) => ({
    name: i.name,
    row: (m) => sourceRow({
      ...base, nodeType: 'index', path: ['indices', i.name], depth: depth + 1, label: i.name, match: m,
      detail: i.status === 'close' ? 'closed' : `${formatCount(i.docsCount)} docs · ${formatBytes(i.storeBytes)}`,
      meta: { health: i.health, status: i.status, hidden: i.hidden } satisfies IndexMeta,
    }),
  })), 'indices', c.showHidden ? 'incl. hidden' : undefined);

  const byAlias = new Map<string, string[]>();
  for (const a of c.aliases.data ?? []) byAlias.set(a.alias, [...(byAlias.get(a.alias) ?? []), a.index]);
  const aliasList: Loadable<string[]> = { ...c.aliases, data: c.aliases.data ? [...byAlias.keys()] : undefined };
  folder('aliases', 'aliases', 'Aliases', aliasList, [...byAlias.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([alias, indices]) => ({
    name: alias,
    row: (m) => sourceRow({
      ...base, nodeType: 'alias', path: ['aliases', alias], depth: depth + 1, label: alias, match: m,
      detail: `→ ${indices.length === 1 ? indices[0] : `${indices.length} indices`}`, meta: { indices } satisfies AliasMeta,
    }),
  })), 'aliases');

  folder('datastreams', 'datastreams', 'Data streams', c.dataStreams, (c.dataStreams.data ?? []).map((d) => ({
    name: d.name,
    row: (m) => sourceRow({
      ...base, nodeType: 'datastream', path: ['datastreams', d.name], depth: depth + 1, label: d.name, match: m,
      detail: `${d.indices.length} backing · gen ${d.generation}`, meta: { health: d.status, status: 'open', hidden: false } satisfies IndexMeta,
    }),
  })), 'data streams');

  folder('templates', 'templates', 'Templates', c.templates, (c.templates.data ?? []).map((t) => ({
    name: t.name,
    row: (m) => sourceRow({
      ...base, nodeType: 'template', path: ['templates', `${t.kind}:${t.name}`], depth: depth + 1, label: t.name, match: m,
      detail: `${t.kind === 'index' ? 'index' : t.kind === 'component' ? 'component' : 'legacy'}${t.patterns.length ? ` · ${t.patterns.join(', ')}` : ''}`,
    }),
  })), 'templates');

  folder('nodes', 'nodes', 'Nodes', c.nodes, (c.nodes.data ?? []).map((n) => ({
    name: n.name,
    row: (m) => sourceRow({
      ...base, nodeType: 'node', path: ['nodes', n.id], depth: depth + 1, label: n.name, match: m,
      detail: `${n.master ? 'master · ' : ''}${n.ip ?? ''}${n.heapPercent != null ? ` · heap ${n.heapPercent}%` : ''}`,
      meta: { master: n.master, roles: n.roles } satisfies NodeMeta,
    }),
  })), 'nodes');

  if (!f) rows.push(sourceRow({ ...base, nodeType: 'tasks', path: ['tasks'], depth, label: 'Tasks' }));
  return rows;
}

/** Lazy loads: indices and aliases when the connection opens (folder counts), the other folders when expanded. */
export function ensureEsLoaded(connection: ConnectionProfile, expanded: ReadonlySet<string>): void {
  const cid = connection.id;
  if (!expanded.has(`c:${cid}`)) return;
  const c = esConn(cid);
  const idle = (l: Loadable<unknown>) => !l.data && !l.loading && !l.error;
  if (idle(c.indices)) void loadIndices(cid);
  if (idle(c.aliases)) void loadAliases(cid);
  if (expanded.has(sourceNodeId(cid, ['datastreams'])) && idle(c.dataStreams)) void loadDataStreams(cid);
  if (expanded.has(sourceNodeId(cid, ['templates'])) && idle(c.templates)) void loadTemplates(cid);
  if (expanded.has(sourceNodeId(cid, ['nodes'])) && idle(c.nodes)) void loadNodes(cid);
}

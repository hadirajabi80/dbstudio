// Elasticsearch explorer/workspace data per connection (plan-batch3 WP-ES): cluster, indices, aliases, data streams,
// templates, nodes and the flattened mapping (fields) per index pattern, loaded lazily as the explorer expands or a
// view mounts. Mutations force a reload of the affected list.
import { create } from 'zustand';
import { api, errorMessage } from '../../api/client';
import type { EsAlias, EsCluster, EsDataStream, EsField, EsIndexSummary, EsNode, EsTemplate } from '../../api/types.es';
import { notifySourceTreeChanged } from '../../lib/sources';
import { getConnection } from '../../store/connections';

export interface Loadable<T> {
  data?: T;
  loading?: boolean;
  error?: string;
  at?: number;
}

export interface EsConnData {
  cluster: Loadable<EsCluster>;
  indices: Loadable<EsIndexSummary[]>;
  aliases: Loadable<EsAlias[]>;
  dataStreams: Loadable<EsDataStream[]>;
  templates: Loadable<EsTemplate[]>;
  nodes: Loadable<EsNode[]>;
  /** Hidden and system indices (dot-prefixed, `index.hidden`) are not listed by default. */
  showHidden: boolean;
}

type ListKey = 'cluster' | 'indices' | 'aliases' | 'dataStreams' | 'templates' | 'nodes';

interface EsState {
  conns: Record<string, EsConnData>;
  /** `${cid}\n${indexPattern}` → fields. */
  fields: Record<string, Loadable<EsField[]>>;
}

export const useEs = create<EsState>(() => ({ conns: {}, fields: {} }));

const empty = (): EsConnData => ({ cluster: {}, indices: {}, aliases: {}, dataStreams: {}, templates: {}, nodes: {}, showHidden: false });

export function esConn(cid: string): EsConnData {
  return useEs.getState().conns[cid] ?? empty();
}

function patch(cid: string, fn: (c: EsConnData) => Partial<EsConnData>) {
  useEs.setState((s) => {
    const cur = s.conns[cid] ?? empty();
    return { conns: { ...s.conns, [cid]: { ...cur, ...fn(cur) } } };
  });
  notifySourceTreeChanged();
}

const inflight = new Map<string, Promise<unknown>>();

function load<T>(cid: string, key: ListKey, force: boolean, fetch: () => Promise<T>): Promise<T | undefined> {
  const cur = esConn(cid)[key] as Loadable<T>;
  if (!force && (cur.data !== undefined || cur.loading)) return Promise.resolve(cur.data);
  const id = `${key}:${cid}`;
  const running = inflight.get(id) as Promise<T | undefined> | undefined;
  if (running && !force) return running;
  patch(cid, (c) => ({ [key]: { ...c[key], loading: true, error: undefined } }) as Partial<EsConnData>);
  const p = fetch()
    .then((data) => {
      patch(cid, () => ({ [key]: { data, at: Date.now() } }) as Partial<EsConnData>);
      return data;
    })
    .catch((e: unknown) => {
      patch(cid, (c) => ({ [key]: { data: force ? (c[key] as Loadable<T>).data : undefined, error: errorMessage(e) } }) as Partial<EsConnData>);
      return undefined;
    })
    .finally(() => {
      if (inflight.get(id) === p) inflight.delete(id);
    });
  inflight.set(id, p);
  return p;
}

export const loadCluster = (cid: string, force = false) => load(cid, 'cluster', force, () => api.es.cluster(cid));
export const loadIndices = (cid: string, force = false) => load(cid, 'indices', force, () => api.es.indices(cid, esConn(cid).showHidden));
export const loadAliases = (cid: string, force = false) => load(cid, 'aliases', force, () => api.es.aliases(cid));
export const loadDataStreams = (cid: string, force = false) => load(cid, 'dataStreams', force, () => api.es.dataStreams(cid));
export const loadTemplates = (cid: string, force = false) => load(cid, 'templates', force, () => api.es.templates(cid));
export const loadNodes = (cid: string, force = false) => load(cid, 'nodes', force, () => api.es.nodes(cid));

export function setShowHidden(cid: string, show: boolean): void {
  patch(cid, () => ({ showHidden: show }));
  void loadIndices(cid, true);
}

/** Reloads what is loaded (and the index list). */
export async function refreshEs(cid: string): Promise<void> {
  const c = esConn(cid);
  const again = (l: Loadable<unknown>) => l.data !== undefined || !!l.error;
  await Promise.all([
    loadIndices(cid, true),
    again(c.cluster) ? loadCluster(cid, true) : null,
    again(c.aliases) ? loadAliases(cid, true) : null,
    again(c.dataStreams) ? loadDataStreams(cid, true) : null,
    again(c.templates) ? loadTemplates(cid, true) : null,
    again(c.nodes) ? loadNodes(cid, true) : null,
  ]);
  dropFields(cid);
}

/** After an index changed (created, deleted, documents written): the lists that show it. */
export function indicesChanged(cid: string): void {
  void loadIndices(cid, true);
  if (esConn(cid).aliases.data) void loadAliases(cid, true);
  if (esConn(cid).cluster.data) void loadCluster(cid, true);
}

// ---- fields (completion, grid sort, mappings)

const fieldsKey = (cid: string, index: string) => `${cid}\n${index}`;

export function fieldsOf(cid: string, index: string): EsField[] {
  return useEs.getState().fields[fieldsKey(cid, index)]?.data ?? [];
}

export function loadFields(cid: string, index: string, force = false): Promise<EsField[]> {
  const key = fieldsKey(cid, index);
  const cur = useEs.getState().fields[key];
  if (!index.trim()) return Promise.resolve([]);
  if (!force && cur?.data) return Promise.resolve(cur.data);
  const running = inflight.get(`f:${key}`) as Promise<EsField[]> | undefined;
  if (running) return running;
  useEs.setState((s) => ({ fields: { ...s.fields, [key]: { ...cur, loading: true } } }));
  const p = api.es.fields(cid, index)
    .then((data) => {
      useEs.setState((s) => ({ fields: { ...s.fields, [key]: { data, at: Date.now() } } }));
      return data;
    })
    .catch((e: unknown) => {
      useEs.setState((s) => ({ fields: { ...s.fields, [key]: { error: errorMessage(e), data: [] } } }));
      return [] as EsField[];
    })
    .finally(() => inflight.delete(`f:${key}`));
  inflight.set(`f:${key}`, p);
  return p;
}

function dropFields(cid: string) {
  useEs.setState((s) => ({ fields: Object.fromEntries(Object.entries(s.fields).filter(([k]) => !k.startsWith(`${cid}\n`))) }));
}

export function forgetConnection(cid: string): void {
  useEs.setState((s) => {
    const conns = { ...s.conns };
    delete conns[cid];
    return { conns, fields: Object.fromEntries(Object.entries(s.fields).filter(([k]) => !k.startsWith(`${cid}\n`))) };
  });
  notifySourceTreeChanged();
}

export function isReadOnly(cid: string | null | undefined): boolean {
  return !cid || !!getConnection(cid)?.readOnly;
}

/** Flavor of the connection once the cluster was read (else the profile's setting). */
export function flavorOf(cid: string): 'elasticsearch' | 'opensearch' {
  const f = esConn(cid).cluster.data?.flavor ?? getConnection(cid)?.props.flavor;
  return f === 'opensearch' ? 'opensearch' : 'elasticsearch';
}

/** Index names known for completion (indices + aliases + data streams). */
export function knownTargets(cid: string): string[] {
  const c = esConn(cid);
  const names = new Set<string>();
  for (const i of c.indices.data ?? []) names.add(i.name);
  for (const a of c.aliases.data ?? []) names.add(a.alias);
  for (const d of c.dataStreams.data ?? []) names.add(d.name);
  return [...names].sort();
}

// Kafka explorer/workspace data per connection (docs/PLAN-M2.md 7.2): cluster, topics, consumer groups and Schema
// Registry subjects, loaded lazily as the explorer expands or a view mounts. Views re-read from here; mutations force
// a reload of the affected list.
import { create } from 'zustand';
import { api, errorMessage } from '../../api/client';
import type { KafkaCluster, KafkaGroupSummary, KafkaSchemaSubject, KafkaTopicSummary } from '../../api/types';
import { notifySourceTreeChanged } from '../../lib/sources';
import { getConnection } from '../../store/connections';

export interface Loadable<T> {
  data?: T;
  loading?: boolean;
  error?: string;
  /** ms epoch of the last successful load. */
  at?: number;
}

export interface KafkaConnData {
  cluster: Loadable<KafkaCluster>;
  topics: Loadable<KafkaTopicSummary[]>;
  groups: Loadable<KafkaGroupSummary[]>;
  subjects: Loadable<KafkaSchemaSubject[]>;
  /** Internal topics (`__consumer_offsets`, `_schemas`…) are hidden by default. */
  showInternal: boolean;
}

interface KafkaState {
  conns: Record<string, KafkaConnData>;
}

export const useKafka = create<KafkaState>(() => ({ conns: {} }));

const empty = (): KafkaConnData => ({ cluster: {}, topics: {}, groups: {}, subjects: {}, showInternal: false });

export function kafkaConn(cid: string): KafkaConnData {
  return useKafka.getState().conns[cid] ?? empty();
}

function patch(cid: string, fn: (c: KafkaConnData) => Partial<KafkaConnData>) {
  useKafka.setState((s) => {
    const cur = s.conns[cid] ?? empty();
    return { conns: { ...s.conns, [cid]: { ...cur, ...fn(cur) } } };
  });
  notifySourceTreeChanged();
}

const inflight = new Map<string, Promise<unknown>>();

function load<K extends 'cluster' | 'topics' | 'groups' | 'subjects', T>(cid: string, key: K, force: boolean, fetch: () => Promise<T>): Promise<T | undefined> {
  const cur = kafkaConn(cid)[key] as Loadable<T>;
  if (!force && (cur.data !== undefined || cur.loading)) return Promise.resolve(cur.data);
  const id = `${key}:${cid}`;
  const running = inflight.get(id) as Promise<T | undefined> | undefined;
  if (running) return running;
  patch(cid, (c) => ({ [key]: { ...c[key], loading: true, error: undefined } }) as Partial<KafkaConnData>);
  const p = fetch()
    .then((data) => {
      patch(cid, () => ({ [key]: { data, at: Date.now() } }) as Partial<KafkaConnData>);
      return data;
    })
    .catch((e: unknown) => {
      patch(cid, () => ({ [key]: { error: errorMessage(e) } }) as Partial<KafkaConnData>);
      return undefined;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

export const loadCluster = (cid: string, force = false) => load(cid, 'cluster', force, () => api.kafka.cluster(cid));
export const loadTopics = (cid: string, force = false) => load(cid, 'topics', force, () => api.kafka.topics(cid, kafkaConn(cid).showInternal));
export const loadGroups = (cid: string, force = false) => load(cid, 'groups', force, () => api.kafka.groups(cid));
export const loadSubjects = (cid: string, force = false) => load(cid, 'subjects', force, () => api.kafka.schemaSubjects(cid));

export function setShowInternal(cid: string, show: boolean): void {
  patch(cid, () => ({ showInternal: show }));
  void loadTopics(cid, true);
}

export async function refreshKafka(cid: string): Promise<void> {
  const c = kafkaConn(cid);
  await Promise.all([
    c.cluster.data || c.cluster.error ? loadCluster(cid, true) : null,
    loadTopics(cid, true),
    c.groups.data || c.groups.error ? loadGroups(cid, true) : null,
    hasRegistry(cid) && (c.subjects.data || c.subjects.error) ? loadSubjects(cid, true) : null,
  ]);
}

export function forgetConnection(cid: string): void {
  useKafka.setState((s) => {
    if (!s.conns[cid]) return s;
    const next = { ...s.conns };
    delete next[cid];
    return { conns: next };
  });
  notifySourceTreeChanged();
}

/** The profile configures a Schema Registry URL. */
export function hasRegistry(cid: string): boolean {
  const url = getConnection(cid)?.props.schemaRegistryUrl;
  return typeof url === 'string' && url.trim().length > 0;
}

export function isReadOnly(cid: string | null | undefined): boolean {
  return !cid || !!getConnection(cid)?.readOnly;
}

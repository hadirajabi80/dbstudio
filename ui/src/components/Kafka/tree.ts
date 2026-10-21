// Explorer subtree of a Kafka connection (docs/PLAN-M2.md 7.2):
//   connection → Overview, Topics (count) → topics, Consumer groups (count) → groups, Schema Registry → subjects
// Paths below the connection: ['overview'], ['topics'], ['topics', t], ['groups'], ['groups', g], ['schemas'], ['schemas', s].
import type { ConnectionProfile } from '../../api/types';
import { fuzzyMatchLower } from '../../lib/fuzzy';
import { sourceNodeId, sourceRow, type SourceTreeInput } from '../../lib/sources';
import type { TreeRow } from '../Explorer/tree';
import { formatCount } from './format';
import { hasRegistry, kafkaConn, loadGroups, loadSubjects, loadTopics } from './store';

export type KafkaNodeType = 'overview' | 'topics' | 'topic' | 'groups' | 'group' | 'schemas' | 'subject';

export interface TopicMeta { partitions: number; internal: boolean; underReplicated: number }
export interface GroupMeta { state: string; lag: number | null }

function statusRow(parent: string, depth: number, status: 'loading' | 'error' | 'empty', label: string): TreeRow {
  return { id: `${parent}#${status}`, kind: 'status', depth, label, expandable: false, expanded: false, status };
}

export function kafkaTree({ connection, depth, expanded, filter }: SourceTreeInput): TreeRow[] {
  const cid = connection.id;
  const c = kafkaConn(cid);
  const base = { connectionId: cid, providerId: 'kafka' as const, expanded };
  const f = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];
  const match = (s: string) => (f ? fuzzyMatchLower(f, s, s.toLowerCase())?.positions : undefined);

  if (!f) rows.push(sourceRow({ ...base, nodeType: 'overview', path: ['overview'], depth, label: 'Overview' }));

  // Topics
  const topics = c.topics.data;
  const topicHits = (topics ?? []).map((t) => ({ t, m: match(t.name) })).filter((x) => !f || x.m);
  if (!f || topicHits.length) {
    const folder = sourceRow({ ...base, nodeType: 'topics', path: ['topics'], depth, label: 'Topics', expandable: true, count: topics?.length, forceOpen: !!f,
      detail: c.showInternal ? 'incl. internal' : undefined });
    rows.push(folder);
    if (folder.expanded) {
      if (!topics) rows.push(statusRow(folder.id, depth + 1, c.topics.error ? 'error' : 'loading', c.topics.error ?? 'Loading topics…'));
      else if (!topics.length) rows.push(statusRow(folder.id, depth + 1, 'empty', 'No topics'));
      for (const { t, m } of topicHits) {
        rows.push(sourceRow({
          ...base, nodeType: 'topic', path: ['topics', t.name], depth: depth + 1, label: t.name, match: m,
          detail: `${t.partitions}p${t.messages != null ? ` · ${formatCount(t.messages)}` : ''}${t.underReplicated ? ' · under-replicated' : ''}`,
          meta: { partitions: t.partitions, internal: t.internal, underReplicated: t.underReplicated } satisfies TopicMeta,
        }));
      }
    }
  }

  // Consumer groups
  const groups = c.groups.data;
  const groupHits = (groups ?? []).map((g) => ({ g, m: match(g.groupId) })).filter((x) => !f || x.m);
  if (!f || groupHits.length) {
    const folder = sourceRow({ ...base, nodeType: 'groups', path: ['groups'], depth, label: 'Consumer groups', expandable: true, count: groups?.length, forceOpen: !!f });
    rows.push(folder);
    if (folder.expanded) {
      if (!groups) rows.push(statusRow(folder.id, depth + 1, c.groups.error ? 'error' : 'loading', c.groups.error ?? 'Loading groups…'));
      else if (!groups.length) rows.push(statusRow(folder.id, depth + 1, 'empty', 'No consumer groups'));
      for (const { g, m } of groupHits) {
        rows.push(sourceRow({
          ...base, nodeType: 'group', path: ['groups', g.groupId], depth: depth + 1, label: g.groupId, match: m,
          detail: `${g.state}${g.lagTotal != null ? ` · lag ${formatCount(g.lagTotal)}` : ''}`,
          meta: { state: g.state, lag: g.lagTotal } satisfies GroupMeta,
        }));
      }
    }
  }

  // Schema Registry
  if (hasRegistry(cid)) {
    const subjects = c.subjects.data;
    const hits = (subjects ?? []).map((s) => ({ s, m: match(s.subject) })).filter((x) => !f || x.m);
    if (!f || hits.length) {
      const folder = sourceRow({ ...base, nodeType: 'schemas', path: ['schemas'], depth, label: 'Schema Registry', expandable: true, count: subjects?.length, forceOpen: !!f });
      rows.push(folder);
      if (folder.expanded) {
        if (!subjects) rows.push(statusRow(folder.id, depth + 1, c.subjects.error ? 'error' : 'loading', c.subjects.error ?? 'Loading subjects…'));
        else if (!subjects.length) rows.push(statusRow(folder.id, depth + 1, 'empty', 'No subjects'));
        for (const { s, m } of hits) {
          rows.push(sourceRow({
            ...base, nodeType: 'subject', path: ['schemas', s.subject], depth: depth + 1, label: s.subject, match: m,
            detail: [s.schemaType, s.latestVersion ? `v${s.latestVersion}` : null].filter(Boolean).join(' · '),
          }));
        }
      }
    }
  }
  return rows;
}

/** Lazy loads: topics and groups when the connection opens (counts on the folders), subjects when their folder opens. */
export function ensureKafkaLoaded(connection: ConnectionProfile, expanded: ReadonlySet<string>): void {
  const cid = connection.id;
  if (!expanded.has(`c:${cid}`)) return;
  const c = kafkaConn(cid);
  if (!c.topics.data && !c.topics.loading && !c.topics.error) void loadTopics(cid);
  if (!c.groups.data && !c.groups.loading && !c.groups.error) void loadGroups(cid);
  if (hasRegistry(cid) && expanded.has(sourceNodeId(cid, ['schemas'])) && !c.subjects.data && !c.subjects.loading && !c.subjects.error) void loadSubjects(cid);
}

// Opening Kafka tabs (docs/PLAN-M2.md 2.5, 7). View ids: `kafka.overview`, `kafka.topics`, `kafka.topic` (one tab per
// topic with the sub-views Overview · Messages · Configs · Consumers; `kafka.messages` is an alias that opens the
// Messages sub-view), `kafka.groups`, `kafka.group` (one tab per group) and `kafka.produce`. Keys are
// `${cid}:${view}:${path}`, so re-opening activates the existing tab. Tab state is plain JSON (stream ids are
// re-created on mount).
import type { KafkaFetchStart, KafkaProduceFormat, KafkaValueFormat } from '../../api/types';
import { getConnection } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';

export const KAFKA_VIEWS = {
  overview: 'kafka.overview',
  topics: 'kafka.topics',
  topic: 'kafka.topic',
  messages: 'kafka.messages',
  groups: 'kafka.groups',
  group: 'kafka.group',
  produce: 'kafka.produce',
} as const;

export type TopicSub = 'overview' | 'messages' | 'configs' | 'consumers';
export const TOPIC_SUBS: readonly TopicSub[] = ['overview', 'messages', 'configs', 'consumers'];

/** Message browser settings kept in the topic tab. */
export interface BrowseState {
  partitions: number[] | null;
  start: KafkaFetchStart;
  limit: number;
  keyFormat: KafkaValueFormat;
  valueFormat: KafkaValueFormat;
  search: string;
  caseSensitive: boolean;
}

export const DEFAULT_BROWSE: BrowseState = {
  partitions: null, start: { kind: 'latest', count: 100 }, limit: 200, keyFormat: 'string', valueFormat: 'auto', search: '', caseSensitive: false,
};

export interface TopicTabState {
  topic: string;
  sub: TopicSub;
  browse?: BrowseState;
  /** Bumped to make the Messages sub-view fetch once on mount/activation. */
  fetchSeq?: number;
}

export interface ProduceDraft {
  key: string;
  value: string;
  headers: { key: string; value: string }[];
  partition: number | null;
  keyFormat: KafkaProduceFormat;
  valueFormat: KafkaProduceFormat;
  subject: string;
  version: string;
  keySubject: string;
  compression: 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
  repeat: number;
}

export const DEFAULT_DRAFT: ProduceDraft = {
  key: '', value: '{\n  \n}', headers: [], partition: null, keyFormat: 'string', valueFormat: 'json', subject: '', version: 'latest', keySubject: '',
  compression: 'none', repeat: 1,
};

export interface ProduceTabState {
  topic: string;
  draft?: ProduceDraft;
}

export interface GroupTabState {
  groupId: string;
}

const connName = (cid: string) => getConnection(cid)?.name ?? 'Kafka';

function open(cid: string, view: string, path: string, title: string, state: unknown): string {
  const key = `${cid}:${view}:${path}`;
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === view && t.key === key);
  const merged = existing ? { ...(existing.state as object), ...(state as object) } : state;
  return tabs.openView({ view, title, connectionId: cid, database: null, state: merged, key });
}

export const openOverview = (cid: string) => open(cid, KAFKA_VIEWS.overview, '', `${connName(cid)} · Overview`, {});
export const openTopics = (cid: string) => open(cid, KAFKA_VIEWS.topics, '', `${connName(cid)} · Topics`, {});
export const openGroups = (cid: string) => open(cid, KAFKA_VIEWS.groups, '', `${connName(cid)} · Consumer groups`, {});

export function openTopic(cid: string, topic: string, sub: TopicSub = 'overview', patch: Partial<TopicTabState> = {}): string {
  return open(cid, KAFKA_VIEWS.topic, topic, topic, { topic, sub, ...patch } satisfies TopicTabState);
}

export function openGroup(cid: string, groupId: string): string {
  return open(cid, KAFKA_VIEWS.group, groupId, `Group ${groupId}`, { groupId } satisfies GroupTabState);
}

export function openProduce(cid: string, topic: string, draft?: Partial<ProduceDraft>): string {
  const state: ProduceTabState = { topic, ...(draft ? { draft: { ...DEFAULT_DRAFT, ...draft } } : {}) };
  return open(cid, KAFKA_VIEWS.produce, topic, `Produce · ${topic}`, state);
}

export function topicTabState(tab: ViewTab): TopicTabState {
  const s = (tab.state ?? {}) as Partial<TopicTabState>;
  const sub = s.sub && TOPIC_SUBS.includes(s.sub) ? s.sub : tab.view === KAFKA_VIEWS.messages ? 'messages' : 'overview';
  return { ...s, topic: s.topic ?? tab.key?.split(':').slice(2).join(':') ?? '', sub };
}

export function patchTab(tabId: string, p: object): void {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  if (!t || t.kind !== 'view') return;
  useTabs.getState().updateView(tabId, { state: { ...(t.state as object), ...p } });
}

/** The active Kafka tab, if any. */
export function activeKafkaTab(): ViewTab | null {
  const s = useTabs.getState();
  const t = s.tabs.find((x) => x.id === s.activeId);
  return t && t.kind === 'view' && t.view.startsWith('kafka.') ? t : null;
}

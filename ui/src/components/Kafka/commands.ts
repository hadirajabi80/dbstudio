// M2-K commands (docs/PLAN-M2.md 2.5, 7): the Kafka source module (explorer subtree, context menus, Ctrl+P `t:` topic
// entries, default workspace = cluster overview), the Kafka tab views (one lazy chunk) and every Kafka action as a
// registered command. Context-menu commands receive a SourceTarget (path ['topics', t] / ['groups', g] / …); from the
// palette they act on the active Kafka tab.
import { createElement } from 'react';
import { api } from '../../api/client';
import { registerCommands, type Command } from '../../commands/registry';
import { isConnectionTarget, isSourceTarget } from '../../commands/types';
import { registerSourceModule, sourceNodeId, type PaletteSourceEntry } from '../../lib/sources';
import { getConnection, useConnections } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { toast } from '../../store/ui';
import { useExplorer } from '../Explorer/explorerStore';
import { registerTabView } from '../layout/tabViews';
import { showKafkaDialog } from './dialogHost';
import {
  activeKafkaTab, KAFKA_VIEWS, openGroup, openGroups, openOverview, openProduce, openTopic, openTopics, topicTabState, type GroupTabState,
  type ProduceTabState,
} from './open';
import { forgetConnection, isReadOnly, kafkaConn, loadCluster, loadGroups, loadTopics, refreshKafka, setShowInternal, useKafka } from './store';
import { ensureKafkaLoaded, kafkaTree, type TopicMeta } from './tree';

import { KafkaTab } from './views';

// ---- targets

function connOf(args?: unknown): string | null {
  if (isSourceTarget(args) && args.providerId === 'kafka') return args.connectionId;
  if (isConnectionTarget(args) && getConnection(args.connectionId)?.providerId === 'kafka') return args.connectionId;
  return activeKafkaTab()?.connectionId ?? null;
}

export function topicOf(args?: unknown): { cid: string; topic: string } | null {
  if (isSourceTarget(args) && args.providerId === 'kafka') {
    return args.path[0] === 'topics' && args.path[1] ? { cid: args.connectionId, topic: args.path[1] } : null;
  }
  const t = activeKafkaTab();
  if (!t?.connectionId) return null;
  if (t.view === KAFKA_VIEWS.topic || t.view === KAFKA_VIEWS.messages) return { cid: t.connectionId, topic: topicTabState(t).topic };
  if (t.view === KAFKA_VIEWS.produce) return { cid: t.connectionId, topic: (t.state as ProduceTabState).topic };
  return null;
}

export function groupOf(args?: unknown): { cid: string; groupId: string } | null {
  if (isSourceTarget(args) && args.providerId === 'kafka') {
    return args.path[0] === 'groups' && args.path[1] ? { cid: args.connectionId, groupId: args.path[1] } : null;
  }
  const t = activeKafkaTab();
  return t?.connectionId && t.view === KAFKA_VIEWS.group ? { cid: t.connectionId, groupId: (t.state as GroupTabState).groupId } : null;
}

const writable = (cid: string | null | undefined) => !!cid && !isReadOnly(cid);

function closeTabs(pred: (view: string, key: string | null | undefined) => boolean) {
  for (const tab of useTabs.getState().tabs) if (tab.kind === 'view' && pred(tab.view, tab.key)) useTabs.getState().close(tab.id);
}

const topicChanged = (cid: string, topic: string) => window.dispatchEvent(new CustomEvent('dbstudio:kafka-topic-changed', { detail: { cid, topic } }));
const groupChanged = (cid: string, groupId: string) => window.dispatchEvent(new CustomEvent('dbstudio:kafka-group-changed', { detail: { cid, groupId } }));

// ---- dialogs (lazy chunk)

async function createTopic(args?: unknown) {
  const cid = connOf(args);
  if (!cid) return;
  const { CreateTopicDialog } = await import('./dialogs');
  const cluster = kafkaConn(cid).cluster.data ?? (await loadCluster(cid));
  showKafkaDialog((close) => createElement(CreateTopicDialog, {
    cid, brokers: cluster?.brokers.length ?? 1, onClose: close,
    onCreated: (name: string) => {
      toast('success', `Created topic ${name}`);
      void loadTopics(cid, true);
      useExplorer.getState().toggle(sourceNodeId(cid, ['topics']), true);
    },
  }));
}

async function addPartitions(args?: unknown) {
  const t = topicOf(args);
  if (!t) return;
  const { AddPartitionsDialog } = await import('./dialogs');
  const meta = isSourceTarget(args) ? (args.meta as TopicMeta | undefined) : undefined;
  const current = meta?.partitions ?? (await api.kafka.topic(t.cid, t.topic)).partitions.length;
  showKafkaDialog((close) => createElement(AddPartitionsDialog, {
    cid: t.cid, topic: t.topic, current, onClose: close,
    onDone: () => {
      toast('success', `Partitions added to ${t.topic}`);
      void loadTopics(t.cid, true);
      topicChanged(t.cid, t.topic);
    },
  }));
}

async function deleteTopic(args?: unknown) {
  const t = topicOf(args);
  if (!t) return;
  const { TypedConfirmDialog } = await import('./dialogs');
  showKafkaDialog((close) => createElement(TypedConfirmDialog, {
    title: 'Delete topic', name: t.topic, action: 'Delete topic', onClose: close,
    message: `Delete the topic ${t.topic} and every message in it? Consumers of this topic will fail. This cannot be undone.`,
    onConfirm: async () => {
      await api.kafka.deleteTopic(t.cid, t.topic);
      toast('success', `Deleted topic ${t.topic}`);
      closeTabs((view, key) => (view === KAFKA_VIEWS.topic || view === KAFKA_VIEWS.produce) && key === `${t.cid}:${view}:${t.topic}`);
      await loadTopics(t.cid, true);
    },
  }));
}

async function purgeTopic(args?: unknown) {
  const t = topicOf(args);
  if (!t) return;
  const { TypedConfirmDialog } = await import('./dialogs');
  showKafkaDialog((close) => createElement(TypedConfirmDialog, {
    title: 'Purge topic', name: t.topic, action: 'Purge messages', onClose: close,
    message: `Delete every message currently in ${t.topic} (DeleteRecords up to the high watermark, all partitions)? The topic and its configs stay.`,
    onConfirm: async () => {
      const r = await api.kafka.purgeTopic(t.cid, t.topic);
      toast('success', `Purged ${t.topic}`, `${r.partitions.length} partition${r.partitions.length === 1 ? '' : 's'} emptied`);
      void loadTopics(t.cid, true);
      topicChanged(t.cid, t.topic);
    },
  }));
}

async function resetOffsets(args?: unknown) {
  const g = groupOf(args);
  if (!g) return;
  const { ResetOffsetsDialog } = await import('./dialogs');
  let topics: string[] = [];
  try {
    const d = await api.kafka.group(g.cid, g.groupId);
    topics = [...new Set(d.partitions.map((p) => p.topic))].sort();
  } catch {
    topics = (kafkaConn(g.cid).topics.data ?? []).map((t) => t.name);
  }
  showKafkaDialog((close) => createElement(ResetOffsetsDialog, {
    cid: g.cid, groupId: g.groupId, topics, readOnly: isReadOnly(g.cid), onClose: close,
    onApplied: () => {
      toast('success', `Offsets of ${g.groupId} reset`);
      groupChanged(g.cid, g.groupId);
      void loadGroups(g.cid, true);
    },
  }));
}

async function deleteGroup(args?: unknown) {
  const g = groupOf(args);
  if (!g) return;
  const { TypedConfirmDialog } = await import('./dialogs');
  showKafkaDialog((close) => createElement(TypedConfirmDialog, {
    title: 'Delete consumer group', name: g.groupId, action: 'Delete group', onClose: close,
    message: `Delete the consumer group ${g.groupId} and its committed offsets? Only groups without active members can be deleted.`,
    onConfirm: async () => {
      await api.kafka.deleteGroup(g.cid, g.groupId);
      toast('success', `Deleted group ${g.groupId}`);
      closeTabs((view, key) => view === KAFKA_VIEWS.group && key === `${g.cid}:${view}:${g.groupId}`);
      await loadGroups(g.cid, true);
    },
  }));
}

async function showSchema(cid: string, subject: string) {
  const { SchemaDialog } = await import('./dialogs');
  showKafkaDialog((close) => createElement(SchemaDialog, { cid, subject, onClose: close }));
}

// ---- default workspace

function defaultWorkspace(cid: string) {
  useExplorer.getState().toggle(`c:${cid}`, true);
  openOverview(cid);
  void loadTopics(cid).then((t) => {
    if (!t) {
      const err = kafkaConn(cid).topics.error;
      if (err) toast('error', 'Could not connect to Kafka', err);
    }
  });
}

function paletteEntries(): PaletteSourceEntry[] {
  const out: PaletteSourceEntry[] = [];
  for (const [cid, c] of Object.entries(useKafka.getState().conns)) {
    const name = getConnection(cid)?.name ?? cid;
    for (const t of c.topics.data ?? []) {
      out.push({ name: t.name, type: 'kafka.topic', connectionId: cid, detail: `${name} · ${t.partitions}p`, open: () => void openTopic(cid, t.name) });
    }
  }
  return out;
}

// ---- commands

const hasTopic = (a?: unknown) => !!topicOf(a);
const hasGroup = (a?: unknown) => !!groupOf(a);
const hasConn = (a?: unknown) => !!connOf(a);

export const KAFKA_COMMANDS: Command<never>[] = [
  { id: 'kafka.overview', title: 'Cluster overview', category: 'Kafka', icon: 'Gauge', keywords: 'brokers controller cluster', when: hasConn, run: (a?: unknown) => { const c = connOf(a); if (c) openOverview(c); } },
  { id: 'kafka.topics', title: 'Topics', category: 'Kafka', icon: 'ListTree', keywords: 'topic list', when: hasConn, run: (a?: unknown) => { const c = connOf(a); if (c) openTopics(c); } },
  { id: 'kafka.groups', title: 'Consumer groups', category: 'Kafka', icon: 'Users', keywords: 'lag consumers', when: hasConn, run: (a?: unknown) => { const c = connOf(a); if (c) openGroups(c); } },
  { id: 'kafka.createTopic', title: 'Create topic…', category: 'Kafka', icon: 'Plus', keywords: 'new topic', when: (a?: unknown) => writable(connOf(a)), run: (a?: unknown) => void createTopic(a) },
  { id: 'kafka.openTopic', title: 'Open topic', category: 'Kafka', icon: 'Info', when: hasTopic, run: (a?: unknown) => { const t = topicOf(a); if (t) openTopic(t.cid, t.topic); } },
  {
    id: 'kafka.browseMessages', title: 'Browse messages', category: 'Kafka', icon: 'MessageSquare', keywords: 'consume messages fetch read tail', when: hasTopic,
    run: (a?: unknown) => { const t = topicOf(a); if (t) openTopic(t.cid, t.topic, 'messages', { fetchSeq: Date.now() }); },
  },
  { id: 'kafka.produce', title: 'Produce…', category: 'Kafka', icon: 'Send', keywords: 'publish send message', when: (a?: unknown) => hasTopic(a) && writable(topicOf(a)?.cid), run: (a?: unknown) => { const t = topicOf(a); if (t) openProduce(t.cid, t.topic); } },
  { id: 'kafka.topicConfigs', title: 'Topic configs', category: 'Kafka', icon: 'Settings', keywords: 'retention cleanup config', when: hasTopic, run: (a?: unknown) => { const t = topicOf(a); if (t) openTopic(t.cid, t.topic, 'configs'); } },
  { id: 'kafka.topicGroups', title: 'Consumer groups of this topic', category: 'Kafka', icon: 'Users', keywords: 'consumers lag', when: hasTopic, run: (a?: unknown) => { const t = topicOf(a); if (t) openTopic(t.cid, t.topic, 'consumers'); } },
  { id: 'kafka.addPartitions', title: 'Add partitions…', category: 'Kafka', icon: 'Layers', when: (a?: unknown) => hasTopic(a) && writable(topicOf(a)?.cid), run: (a?: unknown) => void addPartitions(a) },
  { id: 'kafka.purgeTopic', title: 'Purge topic…', category: 'Kafka', icon: 'Eraser', danger: true, keywords: 'truncate delete records empty', when: (a?: unknown) => hasTopic(a) && writable(topicOf(a)?.cid), run: (a?: unknown) => void purgeTopic(a) },
  { id: 'kafka.deleteTopic', title: 'Delete topic…', category: 'Kafka', icon: 'Trash2', danger: true, when: (a?: unknown) => hasTopic(a) && writable(topicOf(a)?.cid), run: (a?: unknown) => void deleteTopic(a) },
  { id: 'kafka.openGroup', title: 'Open consumer group', category: 'Kafka', icon: 'Users', when: hasGroup, run: (a?: unknown) => { const g = groupOf(a); if (g) openGroup(g.cid, g.groupId); } },
  { id: 'kafka.resetOffsets', title: 'Reset offsets…', category: 'Kafka', icon: 'RotateCcw', keywords: 'rewind seek earliest latest dry run', when: hasGroup, run: (a?: unknown) => void resetOffsets(a) },
  { id: 'kafka.deleteGroup', title: 'Delete consumer group…', category: 'Kafka', icon: 'Trash2', danger: true, when: (a?: unknown) => hasGroup(a) && writable(groupOf(a)?.cid), run: (a?: unknown) => void deleteGroup(a) },
  {
    id: 'kafka.toggleInternal', title: 'Show internal topics', category: 'Kafka', icon: 'Eye', keywords: '__consumer_offsets hidden', when: hasConn,
    run: (a?: unknown) => { const c = connOf(a); if (c) setShowInternal(c, !kafkaConn(c).showInternal); },
  },
  {
    id: 'kafka.refresh', title: 'Refresh topics and groups', category: 'Kafka', icon: 'RefreshCw', when: hasConn,
    run: (a?: unknown) => { const c = connOf(a); if (c) void refreshKafka(c); },
  },
];

function registerModule() {
  registerSourceModule({
    providerId: 'kafka',
    kind: 'stream',
    tree: kafkaTree,
    contextMenuId: (row) => {
      const t = row.source?.nodeType;
      if (t === 'topic') return 'explorer.kafka.topic';
      if (t === 'group') return 'explorer.kafka.group';
      if (t === 'overview' || t === 'topics' || t === 'groups') return 'explorer.kafka.cluster';
      return null;
    },
    activate: (row) => {
      const s = row.source;
      const cid = row.connectionId;
      if (!s || !cid) return;
      if (s.nodeType === 'overview') openOverview(cid);
      else if (s.nodeType === 'topic') openTopic(cid, s.path[1]);
      else if (s.nodeType === 'group') openGroup(cid, s.path[1]);
      else if (s.nodeType === 'subject') void showSchema(cid, s.path[1]);
      else if (s.nodeType === 'topics') openTopics(cid);
      else if (s.nodeType === 'groups') openGroups(cid);
    },
    defaultWorkspace,
    paletteEntries,
    ensureLoaded: ensureKafkaLoaded,
    onDisconnect: forgetConnection,
  });
}

export function registerKafkaCommands(): void {
  registerModule();
  registerCommands(KAFKA_COMMANDS);
  const def = {
    component: KafkaTab,
    icon: 'Waypoints',
    focusPrimary: (_tab: unknown, el: HTMLElement) => {
      const target = el.querySelector<HTMLElement>('[data-primary-focus]');
      target?.focus();
      return !!target;
    },
  };
  for (const v of Object.values(KAFKA_VIEWS)) registerTabView(v, def);
  // a connection edited or deleted: forget its cached tree
  useConnections.subscribe((s, prev) => {
    if (s.connections === prev.connections) return;
    for (const cid of Object.keys(useKafka.getState().conns)) {
      const before = prev.connections.find((c) => c.id === cid);
      const now = s.connections.find((c) => c.id === cid);
      if (!now || (before && JSON.stringify(before.props) !== JSON.stringify(now.props))) forgetConnection(cid);
    }
  });
}

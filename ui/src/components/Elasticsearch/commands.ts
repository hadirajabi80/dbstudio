// WP-ES commands (plan-batch3): the Elasticsearch / OpenSearch source module (explorer subtree, context menus, Ctrl+P
// `t:` index entries, default workspace = cluster overview), the tab views (one lazy chunk) and every action as a
// registered command. Context-menu commands receive a SourceTarget (path ['indices', i] / ['aliases', a] / …); from the
// palette they act on the active Elasticsearch tab.
import { createElement } from 'react';
import { api } from '../../api/client';
import { registerCommands, type Command } from '../../commands/registry';
import { registerContextMenu, type ContextEntry } from '../../commands/menuModel';
import { isConnectionTarget, isSourceTarget } from '../../commands/types';
import { registerSourceModule, sourceNodeId, type PaletteSourceEntry } from '../../lib/sources';
import { getConnection, useConnections } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { toast } from '../../store/ui';
import { useExplorer } from '../Explorer/explorerStore';
import { registerTabView } from '../layout/tabViews';
import { showEsDialog } from './dialogHost';
import {
  activeEsTab, activeTarget, ES_VIEWS, openConsole, openIndex, openIndices, openOverview, openSearch, openSql, openTasks, type IndexSub,
} from './open';
import { esConn, forgetConnection, indicesChanged, isReadOnly, loadAliases, loadIndices, refreshEs, setShowHidden, useEs } from './store';
import { ensureEsLoaded, esTree, type AliasMeta } from './tree';
import { esTreeIcon } from './treeIcons';
import { EsTab } from './views';

// ---- targets

function connOf(args?: unknown): string | null {
  if (isSourceTarget(args) && args.providerId === 'elasticsearch') return args.connectionId;
  if (isConnectionTarget(args) && getConnection(args.connectionId)?.providerId === 'elasticsearch') return args.connectionId;
  return activeEsTab()?.connectionId ?? null;
}

type TargetKind = 'index' | 'alias' | 'datastream';

/** The index / alias / data stream a command acts on. */
export function targetOf(args?: unknown): { cid: string; index: string; kind: TargetKind } | null {
  if (isSourceTarget(args) && args.providerId === 'elasticsearch') {
    const [folder, name] = args.path;
    if (!name) return null;
    if (folder === 'indices') return { cid: args.connectionId, index: name, kind: 'index' };
    if (folder === 'aliases') return { cid: args.connectionId, index: name, kind: 'alias' };
    if (folder === 'datastreams') return { cid: args.connectionId, index: name, kind: 'datastream' };
    return null;
  }
  const t = activeTarget();
  if (!t?.index) return null;
  const isIndex = (esConn(t.cid).indices.data ?? []).some((i) => i.name === t.index);
  return { ...t, kind: isIndex ? 'index' : 'alias' };
}

const indexOf = (args?: unknown) => {
  const t = targetOf(args);
  return t?.kind === 'index' ? t : null;
};

const writable = (cid: string | null | undefined) => !!cid && !isReadOnly(cid);

function closeTabsOf(cid: string, index: string) {
  for (const tab of useTabs.getState().tabs) {
    if (tab.kind === 'view' && (tab.key === `${cid}:${ES_VIEWS.index}:${index}` || tab.key === `${cid}:${ES_VIEWS.search}:${index}`)) useTabs.getState().close(tab.id);
  }
}

export const indexChangedEvent = (cid: string, index: string) =>
  window.dispatchEvent(new CustomEvent('dbstudio:es-index-changed', { detail: { cid, index } }));

// ---- dialogs (lazy chunk)

async function createIndex(args?: unknown) {
  const cid = connOf(args);
  if (!cid) return;
  const { CreateIndexDialog } = await import('./dialogs');
  showEsDialog((close) => createElement(CreateIndexDialog, {
    cid, onClose: close,
    onCreated: (name: string) => {
      toast('success', `Created index ${name}`);
      indicesChanged(cid);
      useExplorer.getState().toggle(sourceNodeId(cid, ['indices']), true);
      openIndex(cid, name, 'mappings');
    },
  }));
}

async function deleteIndex(args?: unknown) {
  const t = indexOf(args);
  if (!t) return;
  const { TypedConfirmDialog } = await import('./dialogs');
  const docs = esConn(t.cid).indices.data?.find((i) => i.name === t.index)?.docsCount;
  showEsDialog((close) => createElement(TypedConfirmDialog, {
    title: 'Delete index', name: t.index, action: 'Delete index', onClose: close,
    message: `Delete the index ${t.index}${docs != null ? ` and its ${docs.toLocaleString('en-US')} documents` : ''}? Aliases on it are removed too. This cannot be undone.`,
    onConfirm: async () => {
      await api.es.deleteIndex(t.cid, t.index);
      toast('success', `Deleted index ${t.index}`);
      closeTabsOf(t.cid, t.index);
      indicesChanged(t.cid);
      void loadAliases(t.cid, true);
    },
  }));
}

async function indexAction(args: unknown, action: 'refresh' | 'flush' | 'forcemerge' | 'close' | 'open' | 'clearcache') {
  const t = indexOf(args);
  if (!t) return;
  const run = async () => {
    try {
      await api.es.indexAction(t.cid, t.index, action);
      const done = { refresh: 'Refreshed', flush: 'Flushed', forcemerge: 'Force-merged', close: 'Closed', open: 'Opened', clearcache: 'Cleared the caches of' }[action];
      toast('success', `${done} ${t.index}`);
      if (action === 'close' || action === 'open') void loadIndices(t.cid, true);
      indexChangedEvent(t.cid, t.index);
    } catch (e) {
      toast('error', `Could not ${action} ${t.index}`, e instanceof Error ? e.message : String(e));
    }
  };
  if (action !== 'close' && action !== 'forcemerge') return run();
  const { ConfirmDialog } = await import('./dialogs');
  showEsDialog((close) => createElement(ConfirmDialog, {
    title: action === 'close' ? 'Close index' : 'Force merge', action: action === 'close' ? 'Close index' : 'Force merge', onClose: close, onConfirm: run,
    message: action === 'close'
      ? `Close ${t.index}? A closed index keeps its data but cannot be searched or written until it is opened again.`
      : `Merge the segments of ${t.index} down to one? This is I/O heavy; run it on indices that no longer receive writes.`,
  }));
}

async function reindex(args?: unknown) {
  const t = targetOf(args);
  const cid = t?.cid ?? connOf(args);
  if (!cid) return;
  const { ReindexDialog } = await import('./dialogs');
  showEsDialog((close) => createElement(ReindexDialog, { cid, source: t?.index ?? '', onClose: close, onDone: () => indicesChanged(cid) }));
}

async function exportDocs(args?: unknown) {
  const t = targetOf(args);
  if (!t) return;
  const { ExportDialog } = await import('./dialogs');
  showEsDialog((close) => createElement(ExportDialog, { cid: t.cid, index: t.index, onClose: close }));
}

async function importDocs(args?: unknown) {
  const t = targetOf(args);
  const cid = t?.cid ?? connOf(args);
  if (!cid) return;
  const { ImportDialog } = await import('./dialogs');
  showEsDialog((close) => createElement(ImportDialog, {
    cid, index: t?.index ?? '', onClose: close,
    onDone: (index: string) => {
      indicesChanged(cid);
      indexChangedEvent(cid, index);
    },
  }));
}

async function addAlias(args?: unknown) {
  const t = targetOf(args);
  const cid = t?.cid ?? connOf(args);
  if (!cid) return;
  const { AliasDialog } = await import('./dialogs');
  showEsDialog((close) => createElement(AliasDialog, {
    cid, index: t?.kind === 'index' ? t.index : '', onClose: close,
    onDone: () => {
      void loadAliases(cid, true);
      void loadIndices(cid, true);
    },
  }));
}

async function removeAlias(args?: unknown) {
  const t = targetOf(args);
  if (!t || t.kind !== 'alias') return;
  const indices = isSourceTarget(args) ? (args.meta as AliasMeta | undefined)?.indices : undefined;
  const list = indices ?? (esConn(t.cid).aliases.data ?? []).filter((a) => a.alias === t.index).map((a) => a.index);
  const { ConfirmDialog } = await import('./dialogs');
  showEsDialog((close) => createElement(ConfirmDialog, {
    title: 'Remove alias', action: 'Remove alias', danger: true, onClose: close,
    message: `Remove the alias ${t.index} from ${list.join(', ')}? The indices and their documents stay; clients that use the alias will fail.`,
    onConfirm: async () => {
      await api.es.updateAliases(t.cid, { actions: list.map((index) => ({ remove: { index, alias: t.index } })) });
      toast('success', `Removed alias ${t.index}`);
      void loadAliases(t.cid, true);
      void loadIndices(t.cid, true);
    },
  }));
}

async function showTemplate(cid: string, key: string) {
  const [kind, ...rest] = key.split(':');
  const name = rest.join(':');
  const tpl = (esConn(cid).templates.data ?? []).find((t) => t.kind === kind && t.name === name);
  if (!tpl) return;
  const { JsonDialog } = await import('./dialogs');
  showEsDialog((close) => createElement(JsonDialog, { title: `Template ${name}`, subtitle: `${kind} template${tpl.patterns.length ? ` · ${tpl.patterns.join(', ')}` : ''}`, value: tpl.body, onClose: close }));
}

// ---- default workspace, palette

function defaultWorkspace(cid: string) {
  useExplorer.getState().toggle(`c:${cid}`, true);
  openOverview(cid);
  void loadIndices(cid).then((r) => {
    if (!r) {
      const err = esConn(cid).indices.error;
      if (err) toast('error', 'Could not connect to Elasticsearch', err);
    }
  });
}

function paletteEntries(): PaletteSourceEntry[] {
  const out: PaletteSourceEntry[] = [];
  for (const [cid, c] of Object.entries(useEs.getState().conns)) {
    const name = getConnection(cid)?.name ?? cid;
    for (const i of c.indices.data ?? []) {
      out.push({ name: i.name, type: 'es.index', connectionId: cid, detail: `${name} · ${i.docsCount?.toLocaleString('en-US') ?? '?'} docs`, open: () => void openIndex(cid, i.name) });
    }
    const aliases = new Set((c.aliases.data ?? []).map((a) => a.alias));
    for (const a of aliases) out.push({ name: a, type: 'es.index', connectionId: cid, detail: `${name} · alias`, open: () => void openIndex(cid, a) });
  }
  return out;
}

// ---- commands

const hasConn = (a?: unknown) => !!connOf(a);
const hasTarget = (a?: unknown) => !!targetOf(a);
const hasIndex = (a?: unknown) => !!indexOf(a);
const writableIndex = (a?: unknown) => hasIndex(a) && writable(indexOf(a)?.cid);
const indexStatus = (a?: unknown) => {
  const t = indexOf(a);
  return t ? esConn(t.cid).indices.data?.find((i) => i.name === t.index)?.status : undefined;
};
const sub = (s: IndexSub) => (a?: unknown) => {
  const t = targetOf(a);
  if (t) openIndex(t.cid, t.index, s);
};

export const ES_COMMANDS: Command<never>[] = [
  { id: 'es.overview', title: 'Cluster overview', category: 'Elasticsearch', icon: 'Gauge', keywords: 'health nodes shards opensearch', when: hasConn, run: (a?: unknown) => { const c = connOf(a); if (c) openOverview(c); } },
  { id: 'es.indices', title: 'Indices', category: 'Elasticsearch', icon: 'ListTree', keywords: 'index list _cat', when: hasConn, run: (a?: unknown) => { const c = connOf(a); if (c) openIndices(c); } },
  { id: 'es.console', title: 'Dev Tools console', category: 'Elasticsearch', icon: 'SquareTerminal', keywords: 'kibana console rest request curl', when: hasConn, run: (a?: unknown) => { const c = connOf(a); if (c) openConsole(c); } },
  { id: 'es.sql', title: 'SQL query', category: 'Elasticsearch', icon: 'TableProperties', keywords: 'sql select _sql', when: hasConn, run: (a?: unknown) => { const c = connOf(a); if (c) openSql(c); } },
  { id: 'es.tasks', title: 'Tasks', category: 'Elasticsearch', icon: 'ListChecks', keywords: 'running reindex cancel _tasks', when: hasConn, run: (a?: unknown) => { const c = connOf(a); if (c) openTasks(c); } },
  { id: 'es.createIndex', title: 'Create index…', category: 'Elasticsearch', icon: 'Plus', keywords: 'new index mapping', when: (a?: unknown) => writable(connOf(a)), run: (a?: unknown) => void createIndex(a) },
  {
    id: 'es.toggleHidden', title: 'Show hidden and system indices', category: 'Elasticsearch', icon: 'Eye', keywords: 'dot indices .kibana .ds', when: hasConn,
    run: (a?: unknown) => { const c = connOf(a); if (c) setShowHidden(c, !esConn(c).showHidden); },
  },
  { id: 'es.refresh', title: 'Refresh indices and aliases', category: 'Elasticsearch', icon: 'RefreshCw', when: hasConn, run: (a?: unknown) => { const c = connOf(a); if (c) void refreshEs(c); } },
  { id: 'es.openIndex', title: 'Browse documents', category: 'Elasticsearch', icon: 'Table2', keywords: 'documents grid open index', when: hasTarget, run: sub('documents') },
  {
    id: 'es.search', title: 'Search (query DSL)', category: 'Elasticsearch', icon: 'Search', keywords: 'query dsl aggregations _search', when: hasTarget,
    run: (a?: unknown) => { const t = targetOf(a); if (t) openSearch(t.cid, t.index); },
  },
  { id: 'es.mappings', title: 'Mappings', category: 'Elasticsearch', icon: 'Braces', keywords: 'fields types mapping', when: hasTarget, run: sub('mappings') },
  { id: 'es.settings', title: 'Index settings', category: 'Elasticsearch', icon: 'Settings', keywords: 'replicas shards refresh_interval', when: hasTarget, run: sub('settings') },
  { id: 'es.indexAliases', title: 'Aliases of this index', category: 'Elasticsearch', icon: 'Link', when: hasTarget, run: sub('aliases') },
  { id: 'es.shards', title: 'Shards', category: 'Elasticsearch', icon: 'Boxes', keywords: 'primary replica unassigned', when: hasTarget, run: sub('shards') },
  { id: 'es.stats', title: 'Index statistics', category: 'Elasticsearch', icon: 'Activity', keywords: 'stats indexing search', when: hasTarget, run: sub('stats') },
  {
    id: 'es.consoleHere', title: 'Open in Dev Tools', category: 'Elasticsearch', icon: 'SquareTerminal', when: hasTarget,
    run: (a?: unknown) => { const t = targetOf(a); if (t) openConsole(t.cid, `GET /${t.index}/_search\n{\n  "query": { "match_all": {} }\n}`); },
  },
  { id: 'es.reindex', title: 'Reindex…', category: 'Elasticsearch', icon: 'ArrowRightLeft', keywords: 'copy index _reindex', when: (a?: unknown) => writable(connOf(a)), run: (a?: unknown) => void reindex(a) },
  { id: 'es.export', title: 'Export documents…', category: 'Elasticsearch', icon: 'FileOutput', keywords: 'ndjson csv json download dump', when: hasTarget, run: (a?: unknown) => void exportDocs(a) },
  { id: 'es.import', title: 'Import documents…', category: 'Elasticsearch', icon: 'FileInput', keywords: 'ndjson csv json bulk load', when: (a?: unknown) => writable(connOf(a)), run: (a?: unknown) => void importDocs(a) },
  { id: 'es.addAlias', title: 'Add alias…', category: 'Elasticsearch', icon: 'Link', keywords: 'alias write index', when: (a?: unknown) => writable(connOf(a)), run: (a?: unknown) => void addAlias(a) },
  {
    id: 'es.removeAlias', title: 'Remove alias…', category: 'Elasticsearch', icon: 'Trash2', danger: true,
    when: (a?: unknown) => targetOf(a)?.kind === 'alias' && writable(targetOf(a)?.cid), run: (a?: unknown) => void removeAlias(a),
  },
  { id: 'es.refreshIndex', title: 'Refresh index', category: 'Elasticsearch', icon: 'RefreshCw', keywords: '_refresh searchable', when: hasIndex, run: (a?: unknown) => void indexAction(a, 'refresh') },
  { id: 'es.flushIndex', title: 'Flush index', category: 'Elasticsearch', icon: 'Zap', keywords: '_flush translog', when: writableIndex, run: (a?: unknown) => void indexAction(a, 'flush') },
  { id: 'es.forcemerge', title: 'Force merge…', category: 'Elasticsearch', icon: 'Layers', keywords: '_forcemerge segments', when: writableIndex, run: (a?: unknown) => void indexAction(a, 'forcemerge') },
  { id: 'es.closeIndex', title: 'Close index…', category: 'Elasticsearch', icon: 'Ban', when: (a?: unknown) => writableIndex(a) && indexStatus(a) !== 'close', run: (a?: unknown) => void indexAction(a, 'close') },
  { id: 'es.reopenIndex', title: 'Open index', category: 'Elasticsearch', icon: 'Play', when: (a?: unknown) => writableIndex(a) && indexStatus(a) === 'close', run: (a?: unknown) => void indexAction(a, 'open') },
  { id: 'es.deleteIndex', title: 'Delete index…', category: 'Elasticsearch', icon: 'Trash2', danger: true, when: writableIndex, run: (a?: unknown) => void deleteIndex(a) },
];

const c = (command: string): ContextEntry => ({ command, optional: true });

function registerMenus() {
  registerContextMenu('explorer.es.cluster', [c('es.overview'), c('es.indices'), c('es.console'), c('es.sql'), c('es.tasks'), 'separator', c('es.createIndex'), c('es.import'), c('es.reindex'), 'separator', c('es.toggleHidden'), c('es.refresh')]);
  registerContextMenu('explorer.es.index', [
    c('es.openIndex'), c('es.search'), c('es.consoleHere'), 'separator', c('es.mappings'), c('es.settings'), c('es.indexAliases'), c('es.shards'), c('es.stats'), 'separator',
    c('es.export'), c('es.import'), c('es.reindex'), c('es.addAlias'), 'separator', c('es.refreshIndex'), c('es.flushIndex'), c('es.forcemerge'), c('es.closeIndex'), c('es.reopenIndex'), 'separator', c('es.deleteIndex'),
  ]);
  registerContextMenu('explorer.es.alias', [c('es.openIndex'), c('es.search'), c('es.consoleHere'), c('es.export'), 'separator', c('es.removeAlias')]);
  registerContextMenu('explorer.es.datastream', [c('es.openIndex'), c('es.search'), c('es.consoleHere'), c('es.export')]);
}

function registerModule() {
  registerSourceModule({
    providerId: 'elasticsearch',
    kind: 'search',
    tree: esTree,
    contextMenuId: (row) => {
      const t = row.source?.nodeType;
      if (t === 'index') return 'explorer.es.index';
      if (t === 'alias') return 'explorer.es.alias';
      if (t === 'datastream') return 'explorer.es.datastream';
      if (t === 'overview' || t === 'indices' || t === 'console' || t === 'sql' || t === 'tasks' || t === 'aliases' || t === 'nodes') return 'explorer.es.cluster';
      return null;
    },
    activate: (row) => {
      const s = row.source;
      const cid = row.connectionId;
      if (!s || !cid) return;
      switch (s.nodeType) {
        case 'overview': case 'nodes': case 'node': openOverview(cid); break;
        case 'console': openConsole(cid); break;
        case 'sql': openSql(cid); break;
        case 'tasks': openTasks(cid); break;
        case 'indices': openIndices(cid); break;
        case 'index': case 'alias': case 'datastream': openIndex(cid, s.path[1]); break;
        case 'template': void showTemplate(cid, s.path[1]); break;
        default: break;
      }
    },
    defaultWorkspace,
    paletteEntries,
    ensureLoaded: ensureEsLoaded,
    icon: esTreeIcon,
    onDisconnect: forgetConnection,
  });
}

export function registerEsCommands(): void {
  registerModule();
  registerMenus();
  registerCommands(ES_COMMANDS);
  const icons: Record<string, string> = {
    [ES_VIEWS.overview]: 'Gauge', [ES_VIEWS.indices]: 'ListTree', [ES_VIEWS.index]: 'Table2', [ES_VIEWS.search]: 'Search',
    [ES_VIEWS.console]: 'SquareTerminal', [ES_VIEWS.sql]: 'TableProperties', [ES_VIEWS.tasks]: 'ListChecks',
  };
  const focusPrimary = (_tab: unknown, el: HTMLElement) => {
    const target = el.querySelector<HTMLElement>('[data-primary-focus]');
    target?.focus();
    return !!target;
  };
  for (const v of Object.values(ES_VIEWS)) registerTabView(v, { component: EsTab, icon: icons[v], focusPrimary });
  // a connection edited or deleted: forget its cached tree
  useConnections.subscribe((s, prev) => {
    if (s.connections === prev.connections) return;
    for (const cid of Object.keys(useEs.getState().conns)) {
      const before = prev.connections.find((x) => x.id === cid);
      const now = s.connections.find((x) => x.id === cid);
      if (!now || (before && JSON.stringify(before.props) !== JSON.stringify(now.props))) forgetConnection(cid);
    }
  });
}

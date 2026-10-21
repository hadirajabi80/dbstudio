// M2-M commands (docs/PLAN-M2.md 2.5, 6): the MongoDB source module (explorer subtree, context menus, Ctrl+P `coll:`
// entries, default workspace), the collection workspace tab view (lazy) and every Mongo action as a registered command.
// Context-menu commands receive a SourceTarget (path [db] or [db, coll, …]); from the palette they act on the active
// Mongo tab's collection.
import { createElement, lazy } from 'react';
import { api } from '../../api/client';
import { registerCommands, type Command } from '../../commands/registry';
import { isSourceTarget, type SourceTarget } from '../../commands/types';
import { registerSourceModule, sourceNodeId, type PaletteSourceEntry } from '../../lib/sources';
import { getConnection, useConnections } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';
import { toast } from '../../store/ui';
import { useExplorer } from '../Explorer/explorerStore';
import { registerTabView, type TabViewProps } from '../layout/tabViews';
import { showMongoDialog } from './dialogHost';
import { MONGO_VIEW, MONGO_VIEW_ALIASES, openCollection, tabState, type MongoSub } from './open';
import { forgetConnection, loadCollections, loadDatabases, refreshConnection, useMongo } from './store';
import { ensureMongoLoaded, mongoTree, type CollectionMeta } from './tree';
import { mongoTreeIcon } from './treeIcons';
import { errorText } from './util';

const LazyCollectionView = lazy(() => import('./CollectionView'));

/** Lazy chunk; the tab host's Suspense boundary shows the loading skeleton. */
function CollectionView(props: TabViewProps) {
  return createElement(LazyCollectionView, props);
}

// ---- targets

interface CollTarget { cid: string; db: string; coll: string }

function activeMongoTab(): ViewTab | null {
  const s = useTabs.getState();
  const t = s.tabs.find((x) => x.id === s.activeId);
  return t && t.kind === 'view' && (t.view === MONGO_VIEW || t.view.startsWith('mongo.')) ? t : null;
}

function collTarget(args?: unknown): CollTarget | null {
  if (isSourceTarget(args) && args.providerId === 'mongodb' && args.path.length >= 2) return { cid: args.connectionId, db: args.path[0], coll: args.path[1] };
  const t = activeMongoTab();
  if (!t?.connectionId) return null;
  const st = tabState(t);
  return st.db && st.coll ? { cid: t.connectionId, db: st.db, coll: st.coll } : null;
}

function dbTarget(args?: unknown): { cid: string; db: string } | null {
  if (isSourceTarget(args) && args.providerId === 'mongodb' && args.path.length >= 1) return { cid: args.connectionId, db: args.path[0] };
  const c = collTarget(args);
  return c ? { cid: c.cid, db: c.db } : null;
}

const isView = (args?: unknown) => {
  if (isSourceTarget(args)) return (args.meta as CollectionMeta | undefined)?.type === 'view';
  const t = collTarget(args);
  return !!t && useMongo.getState().conns[t.cid]?.collections[t.db]?.data?.find((c) => c.name === t.coll)?.type === 'view';
};

const writable = (cid: string | undefined) => !!cid && !getConnection(cid)?.readOnly;

function openSub(sub: MongoSub, patch = {}) {
  return (args?: unknown) => {
    const t = collTarget(args);
    if (t) openCollection(t.cid, t.db, t.coll, sub, patch);
  };
}

// ---- dialogs (lazy chunk)

async function newCollection(args?: unknown) {
  const t = dbTarget(args);
  if (!t) return;
  const { NewCollectionDialog } = await import('./CollectionDialogs');
  const list = (await loadCollections(t.cid, t.db)) ?? [];
  showMongoDialog((close) => createElement(NewCollectionDialog, {
    cid: t.cid, db: t.db, collections: list.filter((c) => c.type !== 'view').map((c) => c.name), onClose: close,
    onCreated: (name: string) => {
      toast('success', `Created ${t.db}.${name}`);
      void loadCollections(t.cid, t.db, true);
      useExplorer.getState().toggle(sourceNodeId(t.cid, [t.db]), true);
    },
  }));
}

async function renameCollection(args?: unknown) {
  const t = collTarget(args);
  if (!t) return;
  const { RenameCollectionDialog } = await import('./CollectionDialogs');
  showMongoDialog((close) => createElement(RenameCollectionDialog, {
    cid: t.cid, db: t.db, coll: t.coll, onClose: close,
    onRenamed: (name: string) => {
      toast('success', `Renamed to ${t.db}.${name}`);
      void loadCollections(t.cid, t.db, true);
    },
  }));
}

async function dropCollection(args?: unknown) {
  const t = collTarget(args);
  if (!t) return;
  const { TypedDropDialog } = await import('./CollectionDialogs');
  showMongoDialog((close) => createElement(TypedDropDialog, {
    what: 'collection', name: t.coll, detail: `from ${t.db} with all its documents and indexes`, onClose: close,
    onConfirm: async () => {
      await api.mongo.dropCollection(t.cid, t.db, t.coll);
      toast('success', `Dropped ${t.db}.${t.coll}`);
      const tab = useTabs.getState().tabs.find((x) => x.kind === 'view' && x.view === MONGO_VIEW && x.key === `${t.cid}:${MONGO_VIEW}:${t.db}.${t.coll}`);
      if (tab) useTabs.getState().close(tab.id);
      await loadCollections(t.cid, t.db, true);
    },
  }));
}

async function dropDatabase(args?: unknown) {
  const t = dbTarget(args);
  if (!t) return;
  const { TypedDropDialog } = await import('./CollectionDialogs');
  const colls = useMongo.getState().conns[t.cid]?.collections[t.db]?.data?.length;
  showMongoDialog((close) => createElement(TypedDropDialog, {
    what: 'database', name: t.db, detail: colls !== undefined ? `and its ${colls} collection${colls === 1 ? '' : 's'}` : 'and every collection in it', onClose: close,
    onConfirm: async () => {
      await api.mongo.dropDatabase(t.cid, t.db);
      toast('success', `Dropped database ${t.db}`);
      for (const tab of useTabs.getState().tabs) {
        if (tab.kind === 'view' && tab.view === MONGO_VIEW && tab.connectionId === t.cid && tabState(tab).db === t.db) useTabs.getState().close(tab.id);
      }
      await loadDatabases(t.cid, true);
    },
  }));
}

async function importInto(args?: unknown, pickCollection = false) {
  const t: { cid: string; db: string; coll?: string } | null = pickCollection ? dbTarget(args) : collTarget(args);
  if (!t) return;
  const { ImportDialog } = await import('./ImportDialog');
  const colls = (await loadCollections(t.cid, t.db)) ?? [];
  showMongoDialog((close) => createElement(ImportDialog, {
    cid: t.cid, db: t.db, coll: t.coll ?? null, collections: colls.filter((c) => c.type === 'collection').map((c) => c.name), onClose: close,
  }));
}

async function exportDocs(args?: unknown) {
  const t = collTarget(args);
  if (!t) return;
  const { ExportDialog } = await import('./ExportDialog');
  const tab = activeMongoTab();
  const q = tab && tabState(tab).coll === t.coll ? tabState(tab).query : undefined;
  showMongoDialog((close) => createElement(ExportDialog, { cid: t.cid, db: t.db, coll: t.coll, query: q, onClose: close }));
}

// ---- default workspace: open the first collection of the configured (or first user) database

async function defaultWorkspace(cid: string) {
  const ex = useExplorer.getState();
  ex.toggle(`c:${cid}`, true);
  const dbs = await loadDatabases(cid);
  if (!dbs) {
    const err = useMongo.getState().conns[cid]?.databases.error;
    if (err) toast('error', 'Could not connect to MongoDB', err);
    return;
  }
  const conf = getConnection(cid)?.props.database;
  const db = (typeof conf === 'string' && conf) || dbs.find((d) => !['admin', 'local', 'config'].includes(d.name))?.name || dbs[0]?.name;
  if (!db) return;
  ex.toggle(sourceNodeId(cid, [db]), true);
  const colls = await loadCollections(cid, db);
  const first = colls?.find((c) => c.type === 'collection') ?? colls?.[0];
  if (first) openCollection(cid, db, first.name);
  else toast('info', `Connected to ${getConnection(cid)?.name ?? 'MongoDB'}`, `Database ${db} has no collections yet.`);
}

function paletteEntries(): PaletteSourceEntry[] {
  const out: PaletteSourceEntry[] = [];
  const conns = useMongo.getState().conns;
  for (const [cid, c] of Object.entries(conns)) {
    const name = getConnection(cid)?.name ?? cid;
    for (const [db, l] of Object.entries(c.collections)) {
      for (const coll of l.data ?? []) {
        out.push({ name: `${db}.${coll.name}`, type: 'mongo.collection', connectionId: cid, detail: name, open: () => void openCollection(cid, db, coll.name) });
      }
    }
  }
  return out;
}

// ---- commands

const hasColl = (a?: unknown) => !!collTarget(a);
const collWritable = (a?: unknown) => {
  const t = collTarget(a);
  return !!t && writable(t.cid) && !isView(a);
};
const dbWritable = (a?: unknown) => {
  const t = dbTarget(a);
  return !!t && writable(t.cid);
};

/** Commands that act on the open collection workspace (scope `mongo`). */
function runInView(action: string) {
  return () => {
    const t = activeMongoTab();
    if (!t) return;
    window.dispatchEvent(new CustomEvent('dbstudio:mongo', { detail: { tabId: t.id, action } }));
  };
}
const inView = () => !!activeMongoTab();

export const MONGO_COMMANDS: Command<never>[] = [
  { id: 'mongo.openDocuments', title: 'Open documents', category: 'MongoDB', icon: 'Table2', keywords: 'find browse collection', when: hasColl, run: openSub('documents') },
  { id: 'mongo.aggregate', title: 'Aggregation pipeline', category: 'MongoDB', icon: 'Workflow', keywords: 'pipeline aggregate stages', when: hasColl, run: openSub('aggregate') },
  { id: 'mongo.schema', title: 'Analyze schema', category: 'MongoDB', icon: 'ChartBar', keywords: 'schema fields types', when: hasColl, run: openSub('schema') },
  { id: 'mongo.indexes', title: 'Indexes', category: 'MongoDB', icon: 'KeyRound', when: (a?: unknown) => hasColl(a) && !isView(a), run: openSub('indexes') },
  { id: 'mongo.explain', title: 'Explain plan…', category: 'MongoDB', icon: 'Gauge', keywords: 'explain query plan collscan', when: hasColl, run: openSub('explain', { explainOf: 'find' }) },
  { id: 'mongo.validation', title: 'Validation rules', category: 'MongoDB', icon: 'ListChecks', keywords: 'jsonSchema validator', when: (a?: unknown) => hasColl(a) && !isView(a), run: openSub('validation') },
  { id: 'mongo.import', title: 'Import documents…', category: 'MongoDB', icon: 'Import', keywords: 'csv json load', when: collWritable, run: (a?: unknown) => void importInto(a) },
  { id: 'mongo.export', title: 'Export documents…', category: 'MongoDB', icon: 'Download', keywords: 'csv json save dump', when: hasColl, run: (a?: unknown) => void exportDocs(a) },
  { id: 'mongo.renameCollection', title: 'Rename collection…', category: 'MongoDB', icon: 'Pencil', when: collWritable, run: (a?: unknown) => void renameCollection(a) },
  { id: 'mongo.dropCollection', title: 'Drop collection…', category: 'MongoDB', icon: 'Trash2', danger: true, when: (a?: unknown) => hasColl(a) && writable(collTarget(a)?.cid), run: (a?: unknown) => void dropCollection(a) },
  { id: 'mongo.newCollection', title: 'New collection…', category: 'MongoDB', icon: 'Plus', when: dbWritable, run: (a?: unknown) => void newCollection(a) },
  { id: 'mongo.importInto', title: 'Import into collection…', category: 'MongoDB', icon: 'FileInput', when: dbWritable, run: (a?: unknown) => void importInto(a, true) },
  { id: 'mongo.dropDatabase', title: 'Drop database…', category: 'MongoDB', icon: 'Trash2', danger: true, when: dbWritable, run: (a?: unknown) => void dropDatabase(a) },
  {
    id: 'mongo.refreshExplorer', title: 'Refresh databases and collections', category: 'MongoDB', icon: 'RefreshCw',
    when: (a?: unknown) => !!(isSourceTarget(a) ? (a as SourceTarget).providerId === 'mongodb' : activeMongoTab()),
    run: (a?: unknown) => {
      const cid = isSourceTarget(a) ? a.connectionId : activeMongoTab()?.connectionId;
      if (cid) void refreshConnection(cid).catch((e) => toast('error', 'Refresh failed', errorText(e)));
    },
  },
  // workspace actions (the view listens for `dbstudio:mongo` events)
  { id: 'mongo.find', title: 'Find (run query)', category: 'MongoDB', icon: 'Play', scope: 'mongo', when: inView, run: runInView('find') },
  { id: 'mongo.refresh', title: 'Refresh documents', category: 'MongoDB', icon: 'RefreshCw', scope: 'mongo', when: inView, run: runInView('refresh') },
  { id: 'mongo.insertDocument', title: 'Insert document…', category: 'MongoDB', icon: 'Plus', scope: 'mongo', shortcut: 'Mod+Shift+I', when: () => inView() && collWritable(), run: runInView('insert') },
  { id: 'mongo.toggleWatch', title: 'Watch changes (change stream)', category: 'MongoDB', icon: 'Radio', when: inView, run: runInView('watch') },
  { id: 'mongo.viewList', title: 'Documents as list', category: 'MongoDB', icon: 'LayoutList', when: inView, run: runInView('view:list') },
  { id: 'mongo.viewJson', title: 'Documents as JSON', category: 'MongoDB', icon: 'Braces', when: inView, run: runInView('view:json') },
  { id: 'mongo.viewTable', title: 'Documents as table', category: 'MongoDB', icon: 'Table2', when: inView, run: runInView('view:table') },
  { id: 'mongo.addStage', title: 'Add pipeline stage', category: 'MongoDB', icon: 'Plus', scope: 'mongoAggregate', shortcut: 'Mod+Shift+A', when: inView, run: runInView('addStage') },
  { id: 'mongo.moveStageUp', title: 'Move stage up', category: 'MongoDB', scope: 'mongoAggregate', shortcut: 'Alt+Up', keyHandler: 'host', palette: false, when: inView, run: runInView('stageUp') },
  { id: 'mongo.moveStageDown', title: 'Move stage down', category: 'MongoDB', scope: 'mongoAggregate', shortcut: 'Alt+Down', keyHandler: 'host', palette: false, when: inView, run: runInView('stageDown') },
  { id: 'mongo.toggleStage', title: 'Enable/disable stage', category: 'MongoDB', scope: 'mongoAggregate', shortcut: 'Mod+/', keyHandler: 'host', palette: false, when: inView, run: runInView('stageToggle') },
  { id: 'mongo.runPipeline', title: 'Run pipeline', category: 'MongoDB', icon: 'Play', when: inView, run: runInView('runPipeline') },
  { id: 'mongo.exportCode', title: 'Export pipeline or query to code…', category: 'MongoDB', icon: 'Code', keywords: 'node python java csharp c# mongosh', when: inView, run: runInView('exportCode') },
];

function registerModule() {
  registerSourceModule({
    providerId: 'mongodb',
    kind: 'document',
    tree: mongoTree,
    contextMenuId: (row) => {
      const t = row.source?.nodeType;
      if (t === 'database') return 'explorer.mongo.db';
      if (t === 'collection' || t === 'indexes' || t === 'validation') return 'explorer.mongo.collection';
      return null;
    },
    activate: (row) => {
      const s = row.source;
      if (!s || !row.connectionId) return;
      const [db, coll] = s.path;
      if (s.nodeType === 'collection') openCollection(row.connectionId, db, coll);
      else if (s.nodeType === 'indexes') openCollection(row.connectionId, db, coll, 'indexes');
      else if (s.nodeType === 'validation') openCollection(row.connectionId, db, coll, 'validation');
    },
    defaultWorkspace: (cid) => void defaultWorkspace(cid),
    paletteEntries,
    ensureLoaded: ensureMongoLoaded,
    icon: mongoTreeIcon,
    onDisconnect: forgetConnection,
  });
}

export function registerMongoCommands(): void {
  registerModule();
  registerCommands(MONGO_COMMANDS);
  const def = {
    component: CollectionView,
    icon: 'Leaf',
    focusPrimary: (_tab: ViewTab, el: HTMLElement) => {
      const target = el.querySelector<HTMLElement>('[data-primary-focus] textarea, [data-primary-focus] .monaco-editor textarea, [data-primary-focus]');
      target?.focus();
      return !!target;
    },
  };
  registerTabView(MONGO_VIEW, def);
  for (const v of MONGO_VIEW_ALIASES) registerTabView(v, def);
  // a connection edited or deleted: forget its cached tree
  useConnections.subscribe((s, prev) => {
    if (s.connections === prev.connections) return;
    for (const cid of Object.keys(useMongo.getState().conns)) {
      const before = prev.connections.find((c) => c.id === cid);
      const now = s.connections.find((c) => c.id === cid);
      if (!now || (before && JSON.stringify(before.props) !== JSON.stringify(now.props))) forgetConnection(cid);
    }
  });
}

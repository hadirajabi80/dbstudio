// M2-R commands (docs/PLAN-M2.md 2.5, 5): the Redis source module (explorer subtree, context menus, Ctrl+P `k:`
// entries, default workspace), the redis.* tab views (one lazy chunk) and every Redis action as a registered command.
// Context-menu commands receive a SourceTarget (path [db], [db, prefix] or [db, key]); from the palette and shortcuts
// they act on the active Redis tab (its database and selected key).
import { createElement, lazy } from 'react';
import { registerCommands, type Command } from '../../commands/registry';
import { isSourceTarget } from '../../commands/types';
import { registerSourceModule, sourceNodeId, type PaletteSourceEntry } from '../../lib/sources';
import { folderPattern } from '../../redis/keyTree';
import { getConnection, useConnections } from '../../store/connections';
import type { ViewTab } from '../../store/tabs';
import { toast } from '../../store/ui';
import { useExplorer } from '../Explorer/explorerStore';
import { registerTabView, type TabViewProps } from '../layout/tabViews';
import { activeRedisTab, openBrowser, openKey, openRedisView, profileDb, REDIS_VIEWS, VIEW_ICON, type BrowserState, type RedisView } from './open';
import { forgetConnection, loadServer, resetKeys, useRedis } from './store';
import { ensureRedisLoaded, redisTree, redisTreeIcon, type FolderMeta, type KeyMeta } from './tree';
import { sendRedisViewAction, type RedisViewAction } from './viewEvents';

const RedisViews = lazy(() => import('./RedisViews'));
const actions = () => import('./actions');

/** Lazy chunk; the tab host's Suspense boundary shows the loading skeleton. */
function RedisTab(p: TabViewProps) {
  return createElement(RedisViews, p);
}

// ---- targets

interface KeyTarget { cid: string; db: number; key: string }

const isRedisTarget = (a: unknown) => isSourceTarget(a) && a.providerId === 'redis';

function keyTarget(args?: unknown): KeyTarget | null {
  if (isRedisTarget(args) && isSourceTarget(args) && args.nodeType === 'key') return { cid: args.connectionId, db: Number(args.path[0]), key: args.path[1] };
  const t = activeRedisTab();
  if (t?.view !== 'redis.browser' || !t.connectionId) return null;
  const st = t.state as BrowserState;
  return st.selected ? { cid: t.connectionId, db: st.db, key: st.selected } : null;
}

function dbTarget(args?: unknown): { cid: string; db: number } | null {
  if (isRedisTarget(args) && isSourceTarget(args)) {
    if (args.nodeType === 'db' || args.nodeType === 'folder' || args.nodeType === 'key') return { cid: args.connectionId, db: Number(args.path[0]) };
    return { cid: args.connectionId, db: profileDb(args.connectionId) };
  }
  if (args && typeof args === 'object' && (args as { kind?: string }).kind === 'connection') {
    const cid = (args as { connectionId?: string }).connectionId;
    if (cid && getConnection(cid)?.providerId === 'redis') return { cid, db: profileDb(cid) };
  }
  const t = activeRedisTab();
  if (!t?.connectionId) return null;
  const db = (t.state as { db?: number } | undefined)?.db;
  return { cid: t.connectionId, db: typeof db === 'number' ? db : profileDb(t.connectionId) };
}

function folderTarget(args?: unknown): { cid: string; db: number; pattern: string } | null {
  if (isRedisTarget(args) && isSourceTarget(args) && args.nodeType === 'folder') {
    const m = args.meta as FolderMeta | undefined;
    return { cid: args.connectionId, db: Number(args.path[0]), pattern: folderPattern(m?.prefix ?? args.path[1]) };
  }
  const t = activeRedisTab();
  if (t?.view !== 'redis.browser' || !t.connectionId) return null;
  const st = t.state as BrowserState;
  const text = st.pattern?.trim();
  return text ? { cid: t.connectionId, db: st.db, pattern: /[*?[]/.test(text) ? text : `*${text}*` } : null;
}

/** A connection id for tool commands: the target's, the active Redis tab's, or the only Redis connection. */
function connTarget(args?: unknown): string | null {
  const d = dbTarget(args);
  if (d) return d.cid;
  const redis = useConnections.getState().connections.filter((c) => c.providerId === 'redis');
  return redis.length === 1 ? redis[0].id : null;
}

const writable = (cid: string | undefined | null) => !!cid && !getConnection(cid)?.readOnly;

function inView(view?: RedisView) {
  return () => {
    const t = activeRedisTab();
    return !!t && (!view || t.view === view);
  };
}

function viewAction(action: RedisViewAction) {
  return () => {
    const t = activeRedisTab();
    if (t) sendRedisViewAction(t.id, action);
  };
}

function tool(view: RedisView, title: string, icon: string, keywords: string, state: Record<string, unknown> = {}): Command<never> {
  return {
    id: `redis.${view.split('.')[1]}`, title, category: 'Redis', icon, keywords,
    when: (a?: unknown) => !!connTarget(a),
    run: (a?: unknown) => {
      const cid = connTarget(a);
      if (cid) openRedisView(cid, view, { ...(view === 'redis.workbench' || view === 'redis.cli' || view === 'redis.analysis' ? { db: dbTarget(a)?.db ?? profileDb(cid) } : {}), ...state });
    },
  };
}

export const REDIS_COMMANDS: Command<never>[] = [
  // ---- explorer context menus (explorer.redis.db / folder / key) and the palette
  {
    id: 'redis.openBrowser', title: 'Open key browser', category: 'Redis', icon: 'Boxes', keywords: 'keys scan redisinsight',
    when: (a?: unknown) => !!dbTarget(a) || !!connTarget(a),
    run: (a?: unknown) => {
      const d = dbTarget(a);
      const cid = d?.cid ?? connTarget(a);
      if (cid) openBrowser(cid, { db: d?.db ?? profileDb(cid) });
    },
  },
  {
    id: 'redis.newKey', title: 'New key…', category: 'Redis', icon: 'Plus', shortcut: 'Insert', scope: 'redisKeys', keywords: 'add create set hset',
    when: (a?: unknown) => writable(dbTarget(a)?.cid),
    run: (a?: unknown) => {
      const d = dbTarget(a);
      if (d) void actions().then((m) => m.newKey(d.cid, d.db));
    },
  },
  {
    id: 'redis.flushDb', title: 'Flush database…', category: 'Redis', icon: 'Eraser', danger: true, keywords: 'flushdb clear empty',
    when: (a?: unknown) => writable(dbTarget(a)?.cid),
    run: (a?: unknown) => {
      const d = dbTarget(a);
      if (d) void actions().then((m) => m.flushDb(d.cid, d.db));
    },
  },
  {
    id: 'redis.openPattern', title: 'Open in browser with this pattern', category: 'Redis', icon: 'Search',
    when: (a?: unknown) => isRedisTarget(a) && isSourceTarget(a) && a.nodeType === 'folder',
    run: (a?: unknown) => {
      const f = folderTarget(a);
      if (f) openBrowser(f.cid, { db: f.db, pattern: f.pattern, selected: null });
    },
  },
  {
    id: 'redis.deletePattern', title: 'Delete keys matching…', category: 'Redis', icon: 'Trash2', danger: true, keywords: 'unlink pattern bulk',
    when: (a?: unknown) => {
      const f = folderTarget(a);
      return !!f && writable(f.cid);
    },
    run: (a?: unknown) => {
      const f = folderTarget(a);
      if (f) void actions().then((m) => m.deletePattern(f.cid, f.db, f.pattern));
    },
  },
  {
    id: 'redis.openKey', title: 'Open key', category: 'Redis', icon: 'Key',
    when: (a?: unknown) => !!keyTarget(a),
    run: (a?: unknown) => {
      const k = keyTarget(a);
      if (k) openKey(k.cid, k.db, k.key);
    },
  },
  {
    id: 'redis.renameKey', title: 'Rename key…', category: 'Redis', icon: 'Pencil', shortcut: 'F2', scope: 'redisKeys',
    when: (a?: unknown) => writable(keyTarget(a)?.cid),
    run: (a?: unknown) => {
      const k = keyTarget(a);
      if (k) void actions().then((m) => m.renameKey(k.cid, k.db, k.key));
    },
  },
  {
    id: 'redis.setTtl', title: 'Set TTL…', category: 'Redis', icon: 'Timer', keywords: 'expire persist ttl',
    when: (a?: unknown) => writable(keyTarget(a)?.cid),
    run: (a?: unknown) => {
      const k = keyTarget(a);
      const ttl = isSourceTarget(a) ? (a.meta as KeyMeta | undefined)?.ttl : undefined;
      if (k) void actions().then((m) => m.setTtl(k.cid, k.db, k.key, ttl));
    },
  },
  {
    id: 'redis.copyKey', title: 'Copy key name', category: 'Redis', icon: 'Copy',
    when: (a?: unknown) => !!keyTarget(a),
    run: (a?: unknown) => {
      const k = keyTarget(a);
      if (k) void actions().then((m) => m.copyKeyName(k.key));
    },
  },
  {
    id: 'redis.copyValueJson', title: 'Copy value as JSON', category: 'Redis', icon: 'Braces',
    when: (a?: unknown) => !!keyTarget(a),
    run: (a?: unknown) => {
      const k = keyTarget(a);
      if (k) void actions().then((m) => m.copyValueJson(k.cid, k.db, k.key));
    },
  },
  {
    id: 'redis.deleteKey', title: 'Delete key…', category: 'Redis', icon: 'Trash2', danger: true, shortcut: 'Delete', scope: 'redisKeys', keywords: 'del unlink remove',
    when: (a?: unknown) => writable(keyTarget(a)?.cid),
    run: (a?: unknown) => {
      const k = keyTarget(a);
      if (k) void actions().then((m) => m.deleteKey(k.cid, k.db, k.key));
    },
  },
  {
    id: 'redis.refreshExplorer', title: 'Refresh Redis keys', category: 'Redis', icon: 'RefreshCw',
    when: (a?: unknown) => !!connTarget(a),
    run: (a?: unknown) => {
      const cid = connTarget(a);
      if (!cid) return;
      resetKeys(cid);
      void loadServer(cid, true);
    },
  },
  // ---- tools
  tool('redis.workbench', 'Redis Workbench', 'SquareTerminal', 'commands editor run'),
  tool('redis.cli', 'Redis CLI', 'SquareChevronRight', 'redis-cli console terminal'),
  tool('redis.pubsub', 'Redis Pub/Sub', 'Radio', 'publish subscribe channels messages'),
  tool('redis.slowlog', 'Redis slowlog', 'Clock', 'slow commands latency'),
  tool('redis.info', 'Redis info dashboard', 'Gauge', 'info memory ops clients stats'),
  tool('redis.analysis', 'Redis database analysis', 'ChartBar', 'memory namespaces top keys analyze'),
  { ...tool('redis.info', 'Redis MONITOR…', 'Activity', 'monitor stream commands live', { monitor: true }), id: 'redis.monitor' },
  // ---- in-view actions (shortcuts work inside the Redis views)
  { id: 'redis.focusPattern', title: 'Focus key pattern', category: 'Redis', icon: 'Search', shortcut: 'Mod+F', scope: 'redis', when: inView('redis.browser'), run: viewAction('focusPattern') },
  { id: 'redis.rescan', title: 'Rescan keys', category: 'Redis', icon: 'RefreshCw', when: inView('redis.browser'), run: viewAction('refresh') },
  { id: 'redis.scanMore', title: 'Scan more keys', category: 'Redis', icon: 'ListEnd', when: inView('redis.browser'), run: viewAction('scanMore') },
  { id: 'redis.focusKeys', title: 'Focus key list', category: 'Redis', icon: 'LayoutList', shortcut: 'Alt+Left', scope: 'redis', when: inView('redis.browser'), run: viewAction('focusKeys') },
  { id: 'redis.focusValue', title: 'Focus value editor', category: 'Redis', icon: 'Pencil', shortcut: 'Alt+Right', scope: 'redis', when: inView('redis.browser'), run: viewAction('focusValue') },
  { id: 'redis.saveValue', title: 'Save value changes', category: 'Redis', icon: 'Save', when: inView('redis.browser'), run: viewAction('save') },
  { id: 'redis.runLine', title: 'Run line or selection', category: 'Redis', icon: 'Play', when: inView('redis.workbench'), run: viewAction('runLine') },
  { id: 'redis.runAll', title: 'Run all commands', category: 'Redis', icon: 'ListEnd', when: inView('redis.workbench'), run: viewAction('runAll') },
  { id: 'redis.clearOutput', title: 'Clear results', category: 'Redis', icon: 'Eraser', when: () => !!activeRedisTab() && ['redis.workbench', 'redis.cli', 'redis.pubsub'].includes(activeRedisTab()!.view), run: viewAction('clear') },
  { id: 'redis.pauseMessages', title: 'Pause or resume messages', category: 'Redis', icon: 'Timer', when: inView('redis.pubsub'), run: viewAction('pause') },
];

// ---- source module

function paletteEntries(): PaletteSourceEntry[] {
  const out: PaletteSourceEntry[] = [];
  for (const [cid, c] of Object.entries(useRedis.getState().conns)) {
    const name = getConnection(cid)?.name ?? cid;
    for (const [db, cache] of Object.entries(c.dbs)) {
      let n = 0;
      for (const k of cache.keys.keys()) {
        out.push({ name: k, type: 'redis.key', connectionId: cid, detail: `${name} · db${db}`, open: () => void openKey(cid, Number(db), k) });
        if (++n >= 5000) break;
      }
    }
  }
  return out;
}

async function defaultWorkspace(cid: string) {
  useExplorer.getState().toggle(`c:${cid}`, true);
  const server = await loadServer(cid);
  if (!server) {
    const err = useRedis.getState().conns[cid]?.server.error;
    if (err) toast('error', 'Could not connect to Redis', err);
    return;
  }
  const db = profileDb(cid);
  useExplorer.getState().toggle(sourceNodeId(cid, [String(db)]), true);
  openBrowser(cid, { db });
}

function registerModule() {
  registerSourceModule({
    providerId: 'redis',
    kind: 'keyvalue',
    tree: redisTree,
    contextMenuId: (row) => {
      const t = row.source?.nodeType;
      if (t === 'db') return 'explorer.redis.db';
      if (t === 'folder') return 'explorer.redis.folder';
      if (t === 'key') return 'explorer.redis.key';
      return null;
    },
    activate: (row) => {
      const s = row.source;
      if (!s || !row.connectionId) return;
      if (s.nodeType === 'key') openKey(row.connectionId, Number(s.path[0]), s.path[1]);
      else if (s.nodeType === 'tool') openRedisView(row.connectionId, s.path[1] as RedisView, { db: profileDb(row.connectionId) });
      else if (s.nodeType === 'db') openBrowser(row.connectionId, { db: Number(s.path[0]) });
    },
    defaultWorkspace: (cid) => void defaultWorkspace(cid),
    paletteEntries,
    ensureLoaded: ensureRedisLoaded,
    icon: redisTreeIcon,
    onDisconnect: forgetConnection,
  });
}

export function registerRedisCommands(): void {
  registerModule();
  registerCommands(REDIS_COMMANDS);
  for (const view of REDIS_VIEWS) {
    registerTabView(view, {
      component: RedisTab,
      icon: VIEW_ICON[view],
      focusPrimary: (_tab: ViewTab, el: HTMLElement) => {
        const target = el.querySelector<HTMLElement>(view === 'redis.browser' ? '.redis-keylist' : view === 'redis.cli' ? '.redis-cli-input input' : '[data-primary-focus], textarea, input');
        target?.focus();
        return !!target;
      },
    });
  }
  // a connection edited or deleted: forget its cached keys and server facts
  useConnections.subscribe((s, prev) => {
    if (s.connections === prev.connections) return;
    for (const cid of Object.keys(useRedis.getState().conns)) {
      const before = prev.connections.find((c) => c.id === cid);
      const now = s.connections.find((c) => c.id === cid);
      if (!now || (before && (JSON.stringify(before.props) !== JSON.stringify(now.props) || before.readOnly !== now.readOnly))) forgetConnection(cid);
    }
  });
}

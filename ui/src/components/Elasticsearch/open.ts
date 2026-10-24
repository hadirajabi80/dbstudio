// Opening Elasticsearch tabs (plan-batch3 WP-ES). View ids: `es.overview`, `es.indices` (index list), `es.index` (one tab
// per index/alias/data stream with the sub-views Documents · Mappings · Settings · Aliases · Shards · Stats),
// `es.search` (one per target), `es.console` (Dev Tools, one per connection), `es.sql`, `es.tasks`. Keys are
// `${cid}:${view}:${path}`, so re-opening activates the existing tab. Tab state is plain JSON.
import { displayShortcut } from '../../commands/keys';
import { getConnection } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';

export const ES_VIEWS = {
  overview: 'es.overview',
  indices: 'es.indices',
  index: 'es.index',
  search: 'es.search',
  console: 'es.console',
  sql: 'es.sql',
  tasks: 'es.tasks',
} as const;

export type IndexSub = 'documents' | 'mappings' | 'settings' | 'aliases' | 'shards' | 'stats';
export const INDEX_SUBS: readonly IndexSub[] = ['documents', 'mappings', 'settings', 'aliases', 'shards', 'stats'];

export interface IndexTabState {
  index: string;
  sub: IndexSub;
  /** Grid toolbar (kept with the tab). */
  q?: string;
  size?: number;
}

export interface SearchTabState {
  index: string;
  /** DSL editor text. */
  body: string;
  /** Bumped to run once on mount/activation (opened from a command with a body). */
  runSeq?: number;
}

export interface ConsoleTabState {
  text?: string;
}

export interface SqlTabState {
  query?: string;
}

const connName = (cid: string) => getConnection(cid)?.name ?? 'Elasticsearch';

function open(cid: string, view: string, path: string, title: string, state: unknown): string {
  const key = `${cid}:${view}:${path}`;
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === view && t.key === key);
  const merged = existing ? { ...(existing.state as object), ...(state as object) } : state;
  return tabs.openView({ view, title, connectionId: cid, database: null, state: merged, key });
}

export const openOverview = (cid: string) => open(cid, ES_VIEWS.overview, '', `${connName(cid)} · Overview`, {});
export const openIndices = (cid: string) => open(cid, ES_VIEWS.indices, '', `${connName(cid)} · Indices`, {});
export const openTasks = (cid: string) => open(cid, ES_VIEWS.tasks, '', `${connName(cid)} · Tasks`, {});

export function openIndex(cid: string, index: string, sub: IndexSub = 'documents'): string {
  return open(cid, ES_VIEWS.index, index, index, { index, sub } satisfies Partial<IndexTabState>);
}

export const DEFAULT_SEARCH_BODY = '{\n  "query": {\n    "match_all": {}\n  },\n  "size": 20\n}';

export function openSearch(cid: string, index: string, body?: string, run = false): string {
  const patch: Partial<SearchTabState> = { index };
  if (body !== undefined) patch.body = body;
  if (run) patch.runSeq = Date.now();
  const key = `${cid}:${ES_VIEWS.search}:${index}`;
  const exists = useTabs.getState().tabs.some((t) => t.kind === 'view' && t.key === key);
  if (!exists && patch.body === undefined) patch.body = DEFAULT_SEARCH_BODY;
  return open(cid, ES_VIEWS.search, index, `Search · ${index}`, patch);
}

export function openConsole(cid: string, insert?: string): string {
  const id = open(cid, ES_VIEWS.console, '', `${connName(cid)} · Dev Tools`, {});
  if (insert) {
    const t = useTabs.getState().tabs.find((x): x is ViewTab => x.id === id && x.kind === 'view');
    const text = ((t?.state as ConsoleTabState | null)?.text ?? DEFAULT_CONSOLE_TEXT).trimEnd();
    patchTab(id, { text: `${text}\n\n${insert}\n` });
  }
  return id;
}

export const DEFAULT_CONSOLE_TEXT = [
  `# Dev Tools: one request per block. ${displayShortcut('Mod+Enter')} runs the request at the cursor,`,
  `# the ▶ in the gutter runs that request, ${displayShortcut('Mod+Shift+Enter')} runs every request.`,
  'GET /_cluster/health',
  '',
  'GET /_cat/indices?v&s=index',
  '',
  'GET /shop-orders/_search',
  '{',
  '  "query": { "term": { "status": "paid" } },',
  '  "aggs": { "revenue": { "sum": { "field": "total" } } },',
  '  "size": 5',
  '}',
  '',
].join('\n');

export function openSql(cid: string, query?: string): string {
  return open(cid, ES_VIEWS.sql, '', `${connName(cid)} · SQL`, query !== undefined ? { query } : {});
}

export function patchTab(tabId: string, p: object): void {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  if (!t || t.kind !== 'view') return;
  useTabs.getState().updateView(tabId, { state: { ...(t.state as object), ...p } });
}

export function indexTabState(tab: ViewTab): IndexTabState {
  const s = (tab.state ?? {}) as Partial<IndexTabState>;
  const sub = s.sub && INDEX_SUBS.includes(s.sub) ? s.sub : 'documents';
  return { ...s, index: s.index ?? tab.key?.split(':').slice(2).join(':') ?? '', sub };
}

/** The active Elasticsearch tab, if any. */
export function activeEsTab(): ViewTab | null {
  const s = useTabs.getState();
  const t = s.tabs.find((x) => x.id === s.activeId);
  return t && t.kind === 'view' && t.view.startsWith('es.') ? t : null;
}

/** Index/target of the active tab (index, search). */
export function activeTarget(): { cid: string; index: string } | null {
  const t = activeEsTab();
  if (!t?.connectionId) return null;
  if (t.view === ES_VIEWS.index) return { cid: t.connectionId, index: indexTabState(t).index };
  if (t.view === ES_VIEWS.search) return { cid: t.connectionId, index: (t.state as SearchTabState | null)?.index ?? '' };
  return null;
}

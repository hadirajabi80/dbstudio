// Opening Mongo tabs (docs/PLAN-M2.md 2.5, 6.3–6.5). Compass-style: one tab per collection with sub-views
// (Documents · Aggregations · Schema · Indexes · Explain · Validation). The tab's view id is `mongo.documents` and its
// key `${cid}:mongo.documents:${db}.${coll}`, so re-opening a collection (any sub-view) activates the same tab.
import { useTabs, type ViewTab } from '../../store/tabs';

export const MONGO_VIEW = 'mongo.documents';
/** Other view ids of the plan; registered as aliases of the collection workspace (persisted tabs keep working). */
export const MONGO_VIEW_ALIASES = ['mongo.aggregate', 'mongo.schema', 'mongo.indexes', 'mongo.explain', 'mongo.validation', 'mongo.import'] as const;

export type MongoSub = 'documents' | 'aggregate' | 'schema' | 'indexes' | 'explain' | 'validation';
export const SUBS: readonly MongoSub[] = ['documents', 'aggregate', 'schema', 'indexes', 'explain', 'validation'];
export type DocView = 'list' | 'json' | 'table';

export interface QueryState {
  filter: string;
  projection: string;
  sort: string;
  collation: string;
  skip: number;
  limit: number;
  maxTimeMs: number;
}

export interface StageState {
  id: string;
  op: string;
  body: string;
  enabled: boolean;
  collapsed?: boolean;
}

export interface CollectionTabState {
  db: string;
  coll: string;
  sub: MongoSub;
  query?: QueryState;
  view?: DocView;
  pipeline?: StageState[];
  /** Explain sub-view: what to explain. */
  explainOf?: 'find' | 'aggregate';
  /** A request counter: bumping it makes the open sub-view run its action once (e.g. Explain from the query bar). */
  runSeq?: number;
}

export const DEFAULT_QUERY: QueryState = { filter: '', projection: '', sort: '', collation: '', skip: 0, limit: 20, maxTimeMs: 30000 };

export function collectionKey(cid: string, db: string, coll: string): string {
  return `${cid}:${MONGO_VIEW}:${db}.${coll}`;
}

export function openCollection(cid: string, db: string, coll: string, sub: MongoSub = 'documents', patch: Partial<CollectionTabState> = {}): string {
  const key = collectionKey(cid, db, coll);
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === MONGO_VIEW && t.key === key);
  const prev = (existing?.state ?? {}) as Partial<CollectionTabState>;
  const state: CollectionTabState = { ...prev, db, coll, sub, ...patch };
  return tabs.openView({ view: MONGO_VIEW, title: `${db}.${coll}`, connectionId: cid, database: db, state, key });
}

export function tabState(tab: ViewTab): CollectionTabState {
  const s = (tab.state ?? {}) as Partial<CollectionTabState>;
  const fromView = tab.view !== MONGO_VIEW ? tab.view.slice('mongo.'.length) : null;
  const raw = s.sub ?? fromView ?? 'documents';
  const sub: MongoSub = SUBS.includes(raw as MongoSub) ? (raw as MongoSub) : 'documents';
  return { ...s, db: s.db ?? tab.database ?? '', coll: s.coll ?? '', sub };
}

export function patchTab(tabId: string, patch: Partial<CollectionTabState>): void {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  if (!t || t.kind !== 'view') return;
  useTabs.getState().updateView(tabId, { state: { ...(t.state as object), ...patch } });
}

let stageSeq = 0;
export function newStage(op = '$match', body = '{\n  \n}'): StageState {
  return { id: `s${Date.now().toString(36)}${(++stageSeq).toString(36)}`, op, body, enabled: true };
}

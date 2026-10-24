// Opening ClickHouse tabs (plan-batch3 WP-CH). Views: `clickhouse.parts` (one tab per table), `clickhouse.mutations`
// and `clickhouse.merges` (one per connection, optionally filtered to a table). Keys are `${cid}:${view}:${path}` so
// re-opening activates the existing tab. Tab state is plain JSON.
import { getConnection } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';

export const CH_VIEWS = { parts: 'clickhouse.parts', mutations: 'clickhouse.mutations', merges: 'clickhouse.merges' } as const;

export interface ChTableState { database: string; table: string }
export interface ChFilterState { database: string | null; table: string | null }

const connName = (cid: string) => getConnection(cid)?.name ?? 'ClickHouse';

function open(cid: string, view: string, path: string, title: string, state: unknown): string {
  return useTabs.getState().openView({ view, title, connectionId: cid, database: null, state, key: `${cid}:${view}:${path}` });
}

export const openParts = (cid: string, database: string, table: string) =>
  open(cid, CH_VIEWS.parts, `${database}.${table}`, `Parts · ${table}`, { database, table } satisfies ChTableState);

export const openMutations = (cid: string, database: string | null = null, table: string | null = null) =>
  open(cid, CH_VIEWS.mutations, table ? `${database ?? ''}.${table}` : '', table ? `Mutations · ${table}` : `${connName(cid)} · Mutations`, { database, table } satisfies ChFilterState);

export const openMerges = (cid: string, database: string | null = null, table: string | null = null) =>
  open(cid, CH_VIEWS.merges, table ? `${database ?? ''}.${table}` : '', table ? `Merges · ${table}` : `${connName(cid)} · Merges`, { database, table } satisfies ChFilterState);

/** The active ClickHouse tab, if any. */
export function activeChTab(): ViewTab | null {
  const s = useTabs.getState();
  const t = s.tabs.find((x) => x.id === s.activeId);
  return t && t.kind === 'view' && t.view.startsWith('clickhouse.') ? t : null;
}

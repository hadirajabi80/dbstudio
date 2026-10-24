// ClickHouse commands (plan-batch3 WP-CH): the three lazy tab views (parts & partitions, mutations, merges) and the
// palette / context-menu commands that open them, plus "Optimize table…". Commands accept an ObjectTarget (explorer
// table), a ConnectionTarget, or fall back to the explorer selection, the active ClickHouse tab and the active console.
//
// TODO(WPCH-shared): the shell's `explorer.table` menu cannot be extended from here (commands/menuModel.ts is frozen); R3
// request in docs/wp-notes/WP-CH.md adds these ids as optional, hide-when-disabled entries. Meanwhile they run from the
// command palette (with a ClickHouse table selected in the explorer, or from a ClickHouse tab).
import { objectTargetOf, targetOf } from '../../commands/core';
import { registerCommands, type Command } from '../../commands/registry';
import { isConnectionTarget } from '../../commands/types';
import { getConnection } from '../../store/connections';
import { getActiveConsole } from '../../store/tabs';
import { registerTabView } from '../layout/tabViews';
import { activeChTab, CH_VIEWS, openMerges, openMutations, openParts, type ChFilterState, type ChTableState } from './open';
import { optimizeTable } from './actions';
import { ClickHouseTab } from './views';

const isCh = (cid: string | null | undefined): cid is string => !!cid && getConnection(cid)?.providerId === 'clickhouse';

/** The ClickHouse table a command acts on. */
export function chTableOf(args?: unknown): { cid: string; database: string; table: string } | null {
  const o = objectTargetOf(args);
  if (o) {
    if (!isCh(o.connectionId) || o.ref.type !== 'table') return null;
    return { cid: o.connectionId, database: o.ref.schema ?? o.database ?? 'default', table: o.ref.name };
  }
  const t = activeChTab();
  if (t && isCh(t.connectionId)) {
    const s = (t.state ?? {}) as Partial<ChTableState & ChFilterState>;
    if (s.table) return { cid: t.connectionId, database: s.database ?? 'default', table: s.table };
  }
  return null;
}

/** The ClickHouse connection a command acts on. */
export function chConnOf(args?: unknown): string | null {
  const target = targetOf(args);
  if (isConnectionTarget(target) && isCh(target.connectionId)) return target.connectionId;
  const o = objectTargetOf(args);
  if (o && isCh(o.connectionId)) return o.connectionId;
  const t = activeChTab();
  if (t && isCh(t.connectionId)) return t.connectionId;
  const c = getActiveConsole();
  if (c && isCh(c.connectionId)) return c.connectionId;
  // a container node (database / folder) of a ClickHouse connection selected in the explorer
  if (target && 'connectionId' in target && isCh(target.connectionId)) return target.connectionId;
  return null;
}

const writable = (cid: string | null | undefined) => !!cid && !getConnection(cid)?.readOnly;

const COMMANDS: Command[] = [
  {
    id: 'clickhouse.parts', title: 'Parts & partitions…', category: 'ClickHouse', icon: 'Layers',
    keywords: 'clickhouse parts partitions mergetree system.parts size compression',
    when: (a) => !!chTableOf(a),
    run: (a) => {
      const t = chTableOf(a);
      if (t) openParts(t.cid, t.database, t.table);
    },
  },
  {
    id: 'clickhouse.mutations', title: 'Mutations', category: 'ClickHouse', icon: 'ListChecks',
    keywords: 'clickhouse mutations alter update delete kill mutation system.mutations',
    when: (a) => !!chConnOf(a),
    run: (a) => {
      const cid = chConnOf(a);
      if (!cid) return;
      const o = objectTargetOf(a);
      const t = o && o.ref.type === 'table' ? chTableOf(a) : null;
      openMutations(cid, t?.database ?? null, t?.table ?? null);
    },
  },
  {
    id: 'clickhouse.merges', title: 'Running merges', category: 'ClickHouse', icon: 'Workflow',
    keywords: 'clickhouse merges background system.merges',
    when: (a) => !!chConnOf(a),
    run: (a) => {
      const cid = chConnOf(a);
      if (cid) openMerges(cid);
    },
  },
  {
    id: 'clickhouse.optimize', title: 'Optimize table…', category: 'ClickHouse', icon: 'Zap',
    keywords: 'clickhouse optimize final merge deduplicate',
    when: (a) => {
      const t = chTableOf(a);
      return !!t && writable(t.cid);
    },
    run: async (a) => {
      const t = chTableOf(a);
      if (t) await optimizeTable(t.cid, t.database, t.table);
    },
  },
];

let registered = false;

export function registerClickHouseCommands(): void {
  if (registered) return;
  registered = true;
  for (const view of Object.values(CH_VIEWS)) registerTabView(view, { component: ClickHouseTab, icon: view === CH_VIEWS.merges ? 'Workflow' : view === CH_VIEWS.mutations ? 'ListChecks' : 'Layers' });
  registerCommands(COMMANDS);
}

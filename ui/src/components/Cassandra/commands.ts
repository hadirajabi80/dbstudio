// Cassandra / ScyllaDB commands and tab views (plan-batch3 WP-CS). Auto-loaded by commands/index.ts as its own lazy
// chunk; the four views (console settings, trace, cluster, table info) are one more lazy chunk (./CassandraView).
//
// Console commands act on the active console when it is on a Cassandra connection (or on the console of an active
// "Console settings" / "Trace" tab). "Show cluster" and "Table keys & storage…" take a ConnectionTarget / ObjectTarget
// and fall back to the active tab and the explorer selection.
// TODO(WPCS-shared): add "Show cluster" to `explorer.connection` and "Table keys & storage…" to `explorer.table` /
// `explorer.view` once the shell can extend its own context menus (docs/wp-notes/WP-CS-ui.md, R3-1); palette only meanwhile.
import { lazy } from 'react';
import { api, errorMessage } from '../../api/client';
import { registerCommands, type Command } from '../../commands/registry';
import { toast } from '../../store/ui';
import { registerTabView, type TabViewDef } from '../layout/tabViews';
import {
  CASSANDRA_VIEWS, cassandraConnectionOf, cassandraConsole, cassandraTableOf, consoleSessionId, openCluster, openSessionSettings, openTableInfo,
  openTrace, settingsChanged,
} from './open';

const hasConsole = () => !!cassandraConsole();

async function toggleTracing() {
  const t = cassandraConsole();
  if (!t) return;
  try {
    const sid = await consoleSessionId(t);
    const cur = await api.cassandra.sessionSettings(sid);
    const next = await api.cassandra.setSessionSettings(sid, { tracing: !cur.tracing });
    settingsChanged(sid);
    toast('info', next.tracing ? 'Tracing on' : 'Tracing off',
      next.tracing ? 'Every statement of this console is traced (Cassandra: Show last trace).' : undefined);
  } catch (e) {
    toast('error', 'Could not change tracing', errorMessage(e));
  }
}

async function showLastTrace() {
  const t = cassandraConsole();
  if (!t?.connectionId) return;
  try {
    const sid = await consoleSessionId(t);
    const s = await api.cassandra.sessionSettings(sid);
    // without a traced statement the tab lists the session's traces (none yet) and offers to turn tracing on
    openTrace(t.connectionId, s.lastTraceId, { consoleTabId: t.id, sessionId: sid });
  } catch (e) {
    toast('error', 'Could not read the last trace', errorMessage(e));
  }
}

export const CASSANDRA_COMMANDS: Command<never>[] = [
  {
    id: 'cassandra.consoleSettings', title: 'Console settings…', category: 'Cassandra', icon: 'Settings',
    keywords: 'consistency serial tracing paging page size ttl session cql', when: hasConsole,
    run: () => { const t = cassandraConsole(); if (t) openSessionSettings(t); },
  },
  {
    id: 'cassandra.toggleTracing', title: 'Toggle tracing', category: 'Cassandra', icon: 'Activity',
    keywords: 'tracing on off trace query', when: hasConsole, run: () => void toggleTracing(),
  },
  {
    id: 'cassandra.setConsistency', title: 'Set consistency level…', category: 'Cassandra', icon: 'Gauge',
    keywords: 'consistency quorum local_quorum one all', when: hasConsole,
    run: () => { const t = cassandraConsole(); if (t) openSessionSettings(t, 'consistency'); },
  },
  {
    id: 'cassandra.showLastTrace', title: 'Show last trace', category: 'Cassandra', icon: 'Timer',
    keywords: 'tracing trace timeline latency', when: hasConsole, run: () => void showLastTrace(),
  },
  {
    id: 'cassandra.cluster', title: 'Show cluster', category: 'Cassandra', icon: 'Network',
    keywords: 'nodes datacenter ring peers clients topology', when: (a?: unknown) => !!cassandraConnectionOf(a),
    run: (a?: unknown) => { const c = cassandraConnectionOf(a); if (c) openCluster(c); },
  },
  {
    id: 'cassandra.tableInfo', title: 'Table keys & storage…', category: 'Cassandra', icon: 'KeyRound',
    keywords: 'partition key clustering columns static compaction options size estimate indexes materialized views',
    when: (a?: unknown) => !!cassandraTableOf(a),
    run: (a?: unknown) => { const t = cassandraTableOf(a); if (t) openTableInfo(t.cid, t.keyspace, t.name); },
  },
];

let registered = false;

export function registerCassandraCommands(): void {
  if (registered) return;
  registered = true;
  const view: TabViewDef = {
    component: lazy(() => import('./CassandraView')),
    icon: 'Database',
    focusPrimary: (_tab, el) => {
      const target = el.querySelector<HTMLElement>('[data-primary-focus], .cs-primary');
      target?.focus();
      return !!target;
    },
  };
  const icons: Record<string, string> = {
    [CASSANDRA_VIEWS.session]: 'Settings', [CASSANDRA_VIEWS.trace]: 'Timer', [CASSANDRA_VIEWS.cluster]: 'Network',
    [CASSANDRA_VIEWS.table]: 'KeyRound',
  };
  for (const v of Object.values(CASSANDRA_VIEWS)) registerTabView(v, { ...view, icon: icons[v] });
  registerCommands(CASSANDRA_COMMANDS);
}

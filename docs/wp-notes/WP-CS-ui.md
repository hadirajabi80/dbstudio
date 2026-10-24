# WP-CS (Cassandra / ScyllaDB) — UI views, commands and mock pack

Part of WP-CS: `ui/src/components/Cassandra/**` and `ui/src/mocks/packs/cassandra.ts`. The engine (lead) and the CQL
intel dialect (`WP-CS-intel.md`) have their own notes. File:line references are to the WP0 commit `686056e`.

## What is in

| File | What |
|---|---|
| `components/Cassandra/commands.ts` | `registerCassandraCommands()` (auto-loaded lazy chunk): the four tab views (one lazy chunk, `./CassandraView`) and six commands, category "Cassandra". No shortcuts. |
| `components/Cassandra/open.ts` | View ids, tab states, openers, and the targets: `cassandraConsole()` (active console on a `cassandra` connection, or the console of an active settings/trace tab), `cassandraConnectionOf(args)`, `cassandraTableOf(args)`, `consoleSessionId()` (the console's session, created with `useSessions.ensure` like its first run when it has none). |
| `SessionView.tsx` (`cassandra.session`) | Console settings: consistency + serial consistency (Select with hints), tracing, page size, insert TTL (validated like the engine: 1..10000, 0..630720000 s); PUT on change, optimistic. Shows the cqlsh equivalent of each value, the keyspace, the session id and the last trace (Open trace / All traces). Reloads on `exec.done` of the session, so `CONSISTENCY ONE` / `TRACING ON` typed in the console show up. |
| `TraceView.tsx` (`cassandra.trace`) | Recent traces of the session (listbox, ↑/↓), header tiles (duration, coordinator, client, start, events, nodes), parameters, query, a CSS waterfall grouped by node (coordinator first; node span + per-event step bars), the event table. An incomplete trace (`durationMicros: null`) is fetched again 5× with back-off. Replica events are put on the coordinator's clock from the event timeuuids (`format.ts buildTimeline`); without time-based ids each node uses its own `source_elapsed` (note shown). |
| `ClusterView.tsx` (`cassandra.cluster`) | Tiles (product + version, nodes up, DCs, schema agreement, partitioner, CQL, protocol), datacenter table, node table (local pill, up/down, tokens, host id, schema version flagged when they differ), "Clients" sub-tab; `400 NOT_SUPPORTED` shows the engine's message as an info banner. |
| `TableInfoView.tsx` (`cassandra.table`) | Tiles (partition key, clustering count, size estimate, mean partition size, local size, default TTL, compaction), `PRIMARY KEY (…)`, key columns with role/order, static and regular columns, indexes (SAI named), materialized views (links), base table + WHERE of an MV, options (TTL/gc_grace humanised), DDL (Copy, Open in console). |
| `format.ts`, `useLoad.ts`, `parts.tsx`, `cassandra.css` | Formatters/timeline (pure), a stale-safe request hook, header/banner/tile/sub-tab parts, styles (theme tokens only; node colours `--conn-*`). |
| `mocks/packs/cassandra.ts` | Was already active (provider, connection "Cassandra Shop" in "Batch 3", extras, all `/cassandra/...` routes). Changed: executions now go through a hook on `engine.interpret` (see Deviations) instead of the `exec.done` observer. |
| tests | `components/Cassandra/__tests__/format.test.ts` (6), `cassandra.views.test.tsx` (18): commands' `when`, settings via REST and via shell commands, Set consistency opens the list, closed console, trace (incomplete → complete, nodes, events, list keyboard switch, unknown id), cluster (+ NOT_SUPPORTED), table info (keys/order, static, SAI, MV link, 404). |
| labelled blocks | `designer/table/TableDesigner.tsx` FALLBACK_TYPES: added `tinyint`, `duration`. The other WP-CS blocks are unchanged (reviewed, see Known gaps for codegen C#). |

Commands (`when`):

| Id | Title | Enabled |
|---|---|---|
| `cassandra.consoleSettings` | Console settings… | `cassandraConsole()` |
| `cassandra.toggleTracing` | Toggle tracing | 〃 (GET + PUT `tracing`, toast) |
| `cassandra.setConsistency` | Set consistency level… | 〃 (opens the settings tab with the level list open — there is no shell quick-pick helper) |
| `cassandra.showLastTrace` | Show last trace | 〃 (trace tab of the console; without a trace it lists none and explains TRACING ON) |
| `cassandra.cluster` | Show cluster | Connection/object/container target on a Cassandra connection, else the active tab's, else the explorer selection's |
| `cassandra.tableInfo` | Table keys & storage… | ObjectTarget `table`/`mview` on a Cassandra connection, else the active object tab, else the explorer selection |

Bundle: nothing of `components/Cassandra` is imported by the initial bundle (commands chunk via `commands/index.ts`,
views via `lazy()`); no new npm dependency. `api/m3/cassandra.ts` and `api/types.cassandra.ts` unchanged.

## Deviations

1. **Mock execution hook.** The pack observed `exec.done` + `engine.history[0]` to apply shell commands, so a console
   showed `near "TRACING": syntax error` for every cqlsh command and no trace output. It now wraps
   `engine.interpret` for Cassandra sessions (the extension point `mocks/m15/grid.ts` overrides): `CONSISTENCY`,
   `SERIAL CONSISTENCY`, `TRACING`, `PAGING` (with and without argument), `SHOW VERSION|HOST|SESSION <id>`, `DESCRIBE
   KEYSPACES|TABLES|CLUSTER|[TABLE] x` answer with cqlsh-like info messages / result sets; `USE ks` updates the keyspace;
   with tracing on every other successful statement gets the trace result set (activity, timestamp, source,
   source_elapsed, client) plus `Tracing session: <id>`. Pack file only.
2. Cluster mock stays 5 nodes in 2 DCs (3 + 1 up/1 down), traces span the coordinator + 1–3 replicas (LOCAL_QUORUM:
   3 nodes, ~13–16 events), as the lead wrote it.

## Requests

### R3-1 ui/src/commands/menuModel.ts:297, ui/src/components/layout/commandMenu.tsx:80 — add entries to shell context menus
Reason: "Show cluster" belongs on the Cassandra connection row (`explorer.connection`) and "Table keys & storage…" on
tables / MVs (`explorer.table`, `explorer.view`). `registerContextMenu` cannot touch shell ids, and relational rows
always pick `explorer.<type>` (Explorer.tsx:125). An append-only extension with `hideDisabled` entries keeps every
other provider's menu unchanged (the commands are disabled there).
Proposed diff:
```diff
// commands/menuModel.ts (after registerContextMenu)
+const EXTENSIONS: Record<string, ContextEntry[][]> = {};
+/** Batch 3: append entries (use `hideDisabled`) to any menu, the shell's included. Returns an unregister function. */
+export function extendContextMenu(id: string, entries: ContextEntry[]): () => void {
+  (EXTENSIONS[id] ??= []).push(entries);
+  return () => { EXTENSIONS[id] = (EXTENSIONS[id] ?? []).filter((e) => e !== entries); };
+}
+export function contextMenuEntries(id: string): ContextEntry[] {
+  const extra = (EXTENSIONS[id] ?? []).flat();
+  return extra.length ? [...(CONTEXT_MENUS[id] ?? []), 'separator', ...extra] : CONTEXT_MENUS[id] ?? [];
+}
// components/layout/commandMenu.tsx:80
 export function contextMenu(id: keyof typeof CONTEXT_MENUS | string, args?: unknown): MenuItem[] {
-  return commandMenuItems(CONTEXT_MENUS[id] ?? [], args);
+  return commandMenuItems(contextMenuEntries(id), args);
 }
```
Then in `components/Cassandra/commands.ts` (stub `TODO(WPCS-shared)`):
```ts
extendContextMenu('explorer.connection', [{ command: 'cassandra.cluster', hideDisabled: true }]);
for (const id of ['explorer.table', 'explorer.view']) extendContextMenu(id, [{ command: 'cassandra.tableInfo', hideDisabled: true }]);
```
(`commandMenuItems` already drops a trailing/duplicate separator when the extension is hidden.)
Local stub: palette only.

### R3-2 ui/src/mocks/engine.ts:146-161 + ui/src/mocks/packs/types.ts — keyspace named `shop` in the mock
Reason: the mock gives every pack provider the SQLite schema `main` (and `databases: ['main']`), so the Cassandra
connection shows keyspace `main` and the explorer offers a database level the real provider does not have
(`schemaIsDatabase('cassandra')`). The seed's keyspace is `shop`.
Proposed diff:
```diff
// packs/types.ts (MockProviderPack)
+  /** Name of the shop schema per provider id (default "main"), e.g. { cassandra: 'shop' }. */
+  schemaNames?: Record<string, string>;
// engine.ts
+const packSchema = (pid: string) => MOCK_PACKS.map((p) => p.schemaNames?.[pid]).find((x) => x) ?? 'main';
 …
-      make('main', SHOP_TABLES, packExtra ?? EXTRA_OBJECTS.sqlite);
+      make(packSchema(pid), SHOP_TABLES, packExtra ?? EXTRA_OBJECTS.sqlite);
 …defaultSchema(cid)
-    return pid === 'sqlserver' ? 'dbo' : pid === 'oracle' ? 'SHOP' : pid === 'postgresql' ? 'public' : 'main';
+    return pid === 'sqlserver' ? 'dbo' : pid === 'oracle' ? 'SHOP' : pid === 'postgresql' ? 'public' : packSchema(pid ?? 'sqlite');
 …databases(cid)
+    if (schemaIsDatabase(pid)) return { databases: [], current: this.defaultSchema(cid) };
     return { databases: ['main'], current: 'main' };
```
and `schemaNames: { cassandra: 'shop' }` in `packs/cassandra.ts` (the table routes ignore the keyspace already). The
SQLite shop tables keep their SQLite column types next to the CQL extras; replacing them would also need the mock
interpreter's row tables, so that stays.

### R3-3 ui/src/mocks/engine.ts:25 — session dialect of pack providers
Reason: `DIALECT` only maps the M1/M2 providers, so a mock session on `cassandra` (or any Batch 3 provider) reports
`dialect: undefined` and the interpreter answers with SQLite error texts.
Proposed diff:
```diff
-const DIALECT: Record<string, Dialect> = { sqlserver: 'tsql', oracle: 'plsql', sqlite: 'sqlite', postgresql: 'pgsql' };
+const DIALECT: Record<string, Dialect> = {
+  sqlserver: 'tsql', oracle: 'plsql', sqlite: 'sqlite', postgresql: 'pgsql',
+  ...Object.fromEntries(MOCK_PACKS.flatMap((p) => p.providers.map((x) => [x.id, x.dialect]))),
+};
```

### R3-4 (for the lead / integration) console toolbar and status bar of a Cassandra console
Not blocking. Manual transactions and explain plans answer 400 NOT_SUPPORTED for `cassandra`, but the console toolbar
still offers `tx.toggleMode`, `tx.commit`, `tx.rollback`, `explain.*` (commands/core.ts, PlanView `hasConsoleEditor`).
Suggest a provider feature check in their `when` (hide via `hideDisabled` in `CONSOLE_TOOLBAR`), and optionally a
status-bar item "LOCAL_QUORUM · tracing" for Cassandra consoles that runs `cassandra.consoleSettings` (StatusBar is
frozen; the settings are `api.cassandra.sessionSettings(sid)`).

## Known gaps

- Context menu entries: palette only until R3-1.
- Codegen C# block (`codegen/lang/csharp.ts` WP-CS): the generator emits ADO.NET (`CreateCommand`,
  `Parameters.AddWithValue`, `new <param>(…)`); the DataStax C# driver has no ADO.NET provider, so generated CQL
  repository code does not compile whatever the block says (`ISession` / `object` kept). A CQL emitter
  (`session.ExecuteAsync(new SimpleStatement(cql, values))`) would be a codegen change outside the block. TypeScript
  (`cassandra-driver` `Client`) is right.
- The trace waterfall is not virtualised (traces have tens of events; Cassandra keeps at most a few hundred).
- The settings tab opens the console's session when it has none (same as a first run); a console on a connection
  that cannot connect shows the connection error there.
- No browser walkthrough (`docs/qa/…`) from this part; the views were checked with testing-library only.

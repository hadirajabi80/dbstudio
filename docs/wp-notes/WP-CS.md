# WP-CS — Cassandra / ScyllaDB (relational provider, dialect `cql`)

## Integration status (Batch 3 integration pass)

| Request | Status | Where / notes |
|---|---|---|
| R3-E1 grid submit without transactions | DONE | `PendingChanges/submit.ts` (`cql`, `clickhouse`: no manual mode / savepoint / commit; a failure names the statements that stayed applied); `submitNoTx.test.tsx` |
| R3-E2 compose cassandra | DONE | `engine/tests/docker/compose.yml` entrypoint enables materialized views and UDFs |
| R3-E3 `$$` and `//` | DONE | `DialectInfo.DollarQuotedStrings` (+ Cql), `SlashLineComments`, `SqlTokenizer`; `CqlCoreTests.cs` |
| R3-E4 CQL literals in INSERT export | DONE | `Core/Export/CqlLiterals.cs` (typed by the column's CQL type), `SqlInsertResultWriter.Literal`; `CqlCoreTests.cs` |
| R3-E5 / ui R3-4 console chrome | DONE | `lib/providerLevels.ts` `hasTransactions` / `hasExplain`: no Auto/Tx toggle, Commit / Rollback or tx label for Cassandra and ClickHouse consoles, no Explain for Cassandra (toolbar, commands, shortcuts); status bar item "LOCAL_QUORUM · tracing" (`components/Cassandra/StatusItem.tsx`, lazy) |
| intel R3-1 layout | DONE | `format/layout.ts` (batches, type arguments, literals, CQL clauses); the `(R3-1)` goldens run |
| intel R3-2 parser / diagnostics | DONE | `partial-parser.ts`, `soft-diagnostics.ts` |
| intel R3-3 keyword followers | DONE | `DialectSpec.keywordFollowers` + completer `followerItems` |
| intel R3-4 collection types | DONE | `codegen/types/index.ts` `cqlCollection` |
| intel R3-5 snippets | DONE | `snippets/builtins.ts` `NOT_CQL` for cte / join / case |
| ui R3-1 menu entries | DONE | `extendContextMenu` (connection: cluster; table / view: keys & storage) |
| ui R3-2 / R3-3 mock keyspace and dialect | DONE | `MockProviderPack.shop` (`shop` keyspace, no databases), `DIALECT` from the packs |

Base: WP0 `686056e`. Line numbers below refer to that commit. The UI parts have their own detailed notes, written by the
two sub-tasks of this WP and kept next to this file:

- `WP-CS-intel.md` — CQL dialect (completion, lexer, splitter, formatter, codegen types): its requests are numbered
  **intel R3-1 … R3-5** (layout.ts, partial-parser + soft-diagnostics, keywordFollowers, codegen collections, snippets),
  each with a full diff that was checked against patched copies (tests titled "(R3-n)" skip until the change lands).
- `WP-CS-ui.md` — the Cassandra views/commands and the mock pack: **ui R3-1 … R3-4** (append-only shell context
  menus, mock keyspace name, mock session dialect, toolbar/status bar for Cassandra consoles).

This file: what the engine does, deviations, and the engine-side / cross-cutting requests **R3-E1 … R3-E5**.

## What is in

Engine (`engine/src/DbStudio.Providers.Cassandra`, CassandraCSharpDriver 3.22.1):

- `CassandraProvider` (`cassandra`, `Dialect.Cql`, identifiers `"…"` folded to lower case) implements `IDbProvider`,
  `IObjectBrowserProvider`, `IDatabaseSearchProvider` directly on the driver (no ADO.NET). `CqlClusterPool` shares one
  driver `Cluster` per profile (fingerprint of connection settings + password; idle clusters shut down after 5 min);
  every console gets its own driver `ISession` (so `USE` stays with the tab), catalog/designer/search share one.
- `CqlSession : IDbSession`: CQL statement splitting (`BEGIN … BATCH … APPLY BATCH` and `$$` bodies whole, `--`/`//`/`/* */`
  comments), driver paging with the console's page size, rows to the sink in 200-row frames, row cap/truncation, cancel
  stops the paging (< 2 s), server warnings as messages, schema-agreement warning, LWT `[applied]` + warning, errors
  as native protocol names (`SyntaxError` 0x2000, `Invalid` 0x2200, `Unavailable` with consistency/replica counts,
  `ReadTimeout`, `WriteTimeout`, …) with document line/column. cqlsh shell commands: `CONSISTENCY`, `SERIAL CONSISTENCY`,
  `TRACING ON|OFF`, `PAGING`, `SHOW VERSION|HOST|SESSION <id>`; `COPY` → NOT_SUPPORTED; `DESCRIBE` on the server with a
  generated fallback for Cassandra 3.x. Tracing adds the trace as a result set + message and keeps the last 50 traces.
- Manual transactions: `SetTransactionModeAsync(Manual)` and `BEGIN/COMMIT/ROLLBACK/SAVEPOINT` → 400 NOT_SUPPORTED with an
  explanation (batches, LWT); a session requested in manual mode opens in auto. Explain: a keyed `IPlanReader` whose
  resolution throws NOT_SUPPORTED "Cassandra has no EXPLAIN. Turn on tracing …" (so the shared endpoint answers with
  this provider's message without a Core change).
- Data grid (labels `data`/`filter`), adapted in the session so `data/sqlgen.ts` needs no change: `LIMIT n OFFSET m` →
  page size n resumed from the cached paging state of offset m (sequential pages are one round trip; jumps skip rows);
  ORDER BY dropped (info message when it was a user sort); `ALLOW FILTERING` added to filters; `WHERE 1 = 0` probe →
  columns only; `(k = … AND …) OR (…)` refetch split into one query per alternative merged into one result set; distinct
  values (`GROUP BY c ORDER BY COUNT(*) DESC`) counted in the engine over up to 100 000 rows; UPDATE/DELETE "verify
  unchanged" conditions on non-key columns → LWT `IF …` (not applied → 0 rows = conflict), plain UPDATE → `IF EXISTS`
  (no resurrection), INSERT → `IF NOT EXISTS` (duplicate key → error 409 AlreadyExists) and `USING TTL` from the console's
  insert TTL. Bind markers `@p1`/`:name`/`?` → prepared statements; values converted to the marker's CQL type;
  collections/tuples/UDTs/vectors are inlined as CQL literals from the grid's JSON text.
- Values: uuid/timeuuid → guid, timestamp → UTC datetimeoffset, date/time/duration/inet as text, varint/decimal exact,
  blob → binary, collections/tuples/UDTs/vectors → JSON (UDTs decoded from the native protocol bytes, the driver has no
  CLR mapping for them).
- Catalog (`system_schema`): keyspaces = schemas (system keyspaces only with the profile option *Show system keyspaces*),
  tables, materialized views (`mview`), UDTs (`type`), functions + aggregates (`func`), columns with key roles in the
  comment ("partition key", "partition key (1 of 2)", "clustering key ASC|DESC", "static"), primary key = partition +
  clustering; details with PRIMARY KEY pseudo-index, secondary/SAI indexes, triggers, estimated partitions
  (`system.size_estimates`); DDL via server DESCRIBE (4.0+), generated otherwise (`CqlDdl`, golden-tested).
- Objects tab (size estimates), dependencies (MV ↔ base table, indexes, triggers, UDT usage by tables/views/UDTs/functions,
  aggregate ↔ state/final functions), find in database (names, columns incl. UDT fields, UDF bodies / MV definitions;
  no data search).
- Designer (`CqlDdlScripter`, `CqlDesignerDatabase`), mapped onto the generic table model until the designer has CQL
  panels: PK columns in order; unique constraint `partition_key` = partition key (default: first key column); index
  `clustering_order` = clustering order (DESC flags); column comment `static` = STATIC; check constraints = table options
  (name = option, expression = CQL value); the table comment = `comment`. CREATE with `PRIMARY KEY ((pk…), ck…)` and
  `WITH CLUSTERING ORDER BY … AND options`, indexes `USING 'sai'` on 5.0+; ALTER ADD/DROP/RENAME (key columns)/WITH
  options/indexes; key, clustering-order, type or table-name changes are refused with an explanation; apply is not
  transactional (DDL_FAILED says how many statements stayed applied). Materialized views: drop + create.
- Module endpoints (`/api/v1/cassandra/...`, `Endpoints/CassandraEndpoints.cs`): console settings GET/PUT, console traces,
  trace by id (`system_traces`), cluster (system.local + peers_v2/peers + driver up/down, DCs, schema agreement), clients
  (`system_views.clients`, NOT_SUPPORTED before 4.0), table keys & storage info.
- `StatementClassifier` WP-CS block: BATCH = DML, DESCRIBE/LIST/SHOW = query, CONSISTENCY/TRACING/PAGING/SERIAL
  CONSISTENCY = session, CREATE/ALTER/DROP KEYSPACE → schema-level DDL, CUSTOM INDEX / COLUMNFAMILY / AGGREGATE / ROLE
  normalised to the shared DDL shapes.
- Seed `engine/tests/docker/seed-cassandra.cql` and its README section.

UI: `api/m3/cassandra.ts` + `api/types.cassandra.ts` (thin wrappers), `intel/dialect/cql.ts` (+ data, split, format,
fixture, tests), `components/Cassandra/**` (Console settings, Trace timeline, Cluster, Table info views; six commands),
the mock pack (active: provider entry, "Cassandra Shop" connection in "Batch 3", module routes, cqlsh commands and
tracing in the mock console), WP-CS blocks (TableDesigner fallback types + tinyint/duration).

## Deviations from the plan

1. **Conformance**: the Cassandra tests do not derive from `ProviderConformanceTests<T>` (its FK, view, multi-transaction
   and savepoint tests cannot apply and the base class has no per-test opt-out besides the three WP0 flags). The fixture
   derives from `ProviderFixture` (`SupportsTransactions = false`, CQL overrides) and `CassandraIntegrationTests`
   re-implements the applicable subset (test connection ok/fail, idle session, streaming, multiple statements, row cap,
   errors with document lines, stop-on-error, cancel, catalog, DDL) plus the WP-CS specifics (5k-row paging, tracing,
   shell commands, keyspace switch, data-grid paging/edit/LWT, all scalar and collection binds, MV/UDT/function/index
   catalog, dependencies, object list, search, designer round trip, cluster, explain refusal). The `ShopSchema.Seed` and
   `DesignerCases` WP-CS blocks were left at their WP0 placeholders (the fixture seeds through the docker script with
   `SeedOnInitialize = false`).
2. **Manual mode** answers NOT_SUPPORTED (plan D3). The data grid's submit switches the session to manual mode first, so
   grid edits need R3-E1 in the real app (the mock engine accepts the switch). The engine side of editing (LWT checks,
   conflicts, IF NOT EXISTS, TTL) is done and tested.
3. **Explain** is refused through a throwing keyed `IPlanReader` registration instead of a Core change.
4. **Data-grid adaptations live in the session** (label `data`/`filter`) instead of `data/sqlgen.ts` (not owned).
5. Default page size 1000 is per round trip; frames to the UI stay 200 rows (plan: "200-row chunks").
6. Protocol: the driver negotiates native protocol v4 with Cassandra 5 (the 3.22 driver's maximum for OSS Cassandra).

## Measurements

- Tests: `DbStudio.Providers.Cassandra.Tests` 75 (48 unit + 27 integration), all green against cassandra:5.0.x (dev
  container and Testcontainers); with `DBSTUDIO_IT=0` the 27 integration tests skip.
- Initial bundle: see the final report (intel +0.2 KB from the codegen type map; the views, commands and dialect are lazy).

## Requests

### R3-E1 ui/src/components/PendingChanges/submit.ts:122–176 — grid submit for dialects without transactions

Reason: `submitNow` switches the session to manual mode, which Cassandra (and ClickHouse, WP-CH) answer with
NOT_SUPPORTED, so grid edits never run. Statements must run one by one, and a failure must say what stayed applied.
Proposed diff:
```diff
@@ ui/src/components/PendingChanges/submit.ts
+/** Dialects without multi-statement transactions (plan-batch3 D3): edits run statement by statement, nothing to undo. */
+const NO_TRANSACTIONS: ReadonlySet<Dialect> = new Set<Dialect>(['cql', 'clickhouse']);
@@ async function submitNow(ctx: EditContext, opts: { verifyUnchanged: boolean }): Promise<SubmitResult> {
+  const noTx = NO_TRANSACTIONS.has(ctx.dialect);
   const undo = async (): Promise<string> => {
+    if (noTx) return executed > 0
+      ? `The ${executed} statement(s) before it were applied (no transactions on this database); the grid was refreshed.`
+      : 'Nothing was saved.';
     if (ownsTx) {
@@
-    if (wasAuto) await sessions.setTxMode(ctx.tabId, 'manual');
+    if (noTx) { /* every statement is applied on its own */ }
+    else if (wasAuto) await sessions.setTxMode(ctx.tabId, 'manual');
     else if (!ownsTx) {
@@
-    if (wasAuto) {
+    if (noTx) { /* nothing to commit */ }
+    else if (wasAuto) {
       await sessions.commit(ctx.tabId);
       await restoreAuto(ctx.tabId);
```
(`leftOpen` stays false for `noTx`.) Local stub: none needed in WP-CS files; the walkthrough marks the step.

### R3-E2 engine/tests/docker/compose.yml:308–321 — enable materialized views and UDFs on the cassandra service

Reason: `cassandra:5` disables both by default; the seed creates `orders_by_status` and `line_total` (the explorer's
Materialized Views / Functions folders and the dependency examples). The test fixture does the same edit.
```diff
   cassandra:
     image: cassandra:5
     profiles: ["cassandra"]
+    entrypoint: ["/bin/sh", "-c", "sed -i -e 's/^materialized_views_enabled: false/materialized_views_enabled: true/' -e 's/^user_defined_functions_enabled: false/user_defined_functions_enabled: true/' /etc/cassandra/cassandra.yaml && exec docker-entrypoint.sh cassandra -f"]
     environment:
```
The `integration` CI job uses the same service, so it gets the full seed too.

### R3-E3 engine/src/DbStudio.Core/Models/DialectInfo.cs:43 + Sql/SqlTokenizer.cs — `$$` bodies and `//` comments for CQL

Reason: Core's tokenizer (statement classifier, read-only guard, history labels, catalog invalidation) splits a CQL
`CREATE FUNCTION … AS $$ … ; … $$` at the inner semicolons and reads `// …` comments as code. The session itself uses its
own lexer (`CqlText`), so execution is right; only classification is affected (e.g. a `// DROP …` comment triggers the
destructive guard).
```diff
-    public static bool DollarQuotedStrings(Dialect d) => d is Dialect.PgSql or Dialect.Snowflake;
+    public static bool DollarQuotedStrings(Dialect d) => d is Dialect.PgSql or Dialect.Snowflake or Dialect.Cql;
+
+    /// <summary><c>// …</c> is a line comment (CQL).</summary>
+    public static bool SlashLineComments(Dialect d) => d is Dialect.Cql;
```
and in `SqlTokenizer.Tokenize`, next to the `--` branch: `if (c == '/' && i + 1 < n && sql[i + 1] == '/' && DialectInfo.SlashLineComments(dialect))`
skip to the end of the line (same code as `--`).

### R3-E4 engine/src/DbStudio.Core/Export/ResultWriters.cs:239 — CQL literals in "Copy as / Export SQL INSERT"

Reason: for `Dialect.Cql` uuids/timeuuids must be unquoted and collection/UDT values (kind `json`) need CQL literal
syntax (`['a', 'b']`, `{'k': 1}`, `{field: 'x'}`), not a quoted JSON string; today an exported INSERT fails on such
columns. Minimal fix:
```diff
         var text = ExportFormats.FullText(v) ?? "";
         var kind = column?.Kind;
+        if (_dialect == Dialect.Cql && kind == ColumnKinds.Guid && Guid.TryParse(text, out _)) return text;
+        if (_dialect == Dialect.Cql && kind == ColumnKinds.Json) return CqlJsonLiteral(text, column!.DbType);
```
with a small `CqlJsonLiteral` (JSON array → `[…]` or `{…}` when the type starts with `set<`, object → `{'k': v}` for
`map<` else `{k: v}`, strings single-quoted, numbers/booleans/null as is). `DbStudio.Providers.Cassandra.CqlValues.Literal`
implements the typed version and can be lifted into Core if preferred.

### R3-E5 ui/src/components/Toolbar/Toolbar.tsx, StatusBar.tsx — Cassandra console chrome

Same as ui R3-4: hide (or disable with the NOT_SUPPORTED message as tooltip) the transaction-mode toggle, Commit/Rollback
and Explain buttons for `cql`; optionally a status-bar item "LOCAL_QUORUM · tracing" bound to
`api.cassandra.sessionSettings` that opens `cassandra.consoleSettings`.

## Notes for others

- `CqlClusterPool` implements `IDisposable` too (the DI container disposes it synchronously in some hosts/tests).
- ScyllaDB is detected through `system.versions`, DSE through `system.local.dse_version`; the cluster view reports the
  product as `scylla`/`dse`. Not tested against a live ScyllaDB.
- No publish-size change beyond WP0's (CassandraCSharpDriver was already referenced by the stub project).

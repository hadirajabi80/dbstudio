# WP-CH — ClickHouse (notes for the orchestrator)

## Integration status (Batch 3 integration pass)

| Request | Status | Where / notes |
|---|---|---|
| R3-1 `TableOptions.Extra` | DONE | Core `TableOptions.Extra` + `TableDiff.SameExtra`, `ui/src/api/types.ts`, designer hook `designer/table/optionsPanels.ts` (`registerDesignerOptionsPanel`, rendered by `TableDesigner.tsx`), ClickHouse panel `components/ClickHouse/EngineOptions.tsx`, `ChEngineOptions.From`, `ChDesignerDatabase.EngineExtra` (reads `system.tables`); tests `ChEngineExtraTests.cs`, `engineOptions.test.tsx`. Snowflake uses the same slot (WP-SF R3-9) |
| R3-2 conformance switches | DONE | `ProviderFixture.SupportsForeignKeys / SupportsIdentity / ReportsDmlRowCounts` + guards in the four tests; `ChFixture` (and the Cassandra fixture) set them false |
| R3-UI-1 dialect completion hook | DONE | `DialectSpec.complete`, run first by `intel/index.ts` |
| R3-UI-2 case-sensitive names | DONE | `DialectSpec.preserveNameCase` (completer function / table-function / type labels, formatter function and type names); the ClickHouse spec sets it; keyword-like functions (`IF`, `ANY`) still follow the keyword case |
| R3-UI-3 clauses | DONE | `FormatRules.extraClauses` (`PREWHERE` -> where, `SETTINGS`, `FORMAT`) and `joinWords` (`ARRAY GLOBAL ANY ALL ASOF PASTE`); `LIMIT n BY` already worked |
| R3-UI-4 dictionaries | DONE | `isTabular(type, dialect)`, `objectTypeLabel` ("Dictionaries"); explorer double-click, Select top, Generate SQL, Open data |
| R3-UI-5 menu entries | DONE | generic `extendContextMenu(menuId, entries)` / `contextMenuEntries` in `commands/menuModel.ts` (entries land before the menu's last, destructive group); used by ClickHouse, Snowflake and Cassandra. `chConnOf` no longer falls back to the active tab for an explicit target of another provider |
| R3-UI-6 wrapper types | DONE | `codegen/types/index.ts` (Nullable, LowCardinality, SimpleAggregateFunction, Array) |
| R3-UI-7 mock schema / banner | DONE | `MockProviderPack.shop` |

Branch on top of WP0 (`686056e`). Every file:line below refers to `686056e`. Local stubs are marked `TODO(WPCH-shared)`.

## Requests

### R3-1 engine/src/DbStudio.Core/Designer/TableModel.cs:23 (+ TableDiff.cs:114, ui/src/api/types.ts:601) — provider table options
Reason: the MergeTree-aware designer needs ENGINE / ORDER BY / PARTITION BY / PRIMARY KEY / SAMPLE BY / TTL / SETTINGS
(WP-MY will want ENGINE/charset/collation, WP-SF CLUSTER BY/TRANSIENT/retention). `TableOptions` has only SQLite/Oracle
fields, so the scripter cannot receive them and `ReadTableAsync` cannot return them.
Proposed diff:
```diff
 public sealed record TableOptions
 {
     public bool WithoutRowid { get; init; }
     public bool Strict { get; init; }
     public string? Tablespace { get; init; }
+    /// <summary>Batch 3: provider options (ClickHouse "engine", "orderBy", "partitionBy", "primaryKey", "sampleBy", "ttl", "settings").</summary>
+    public Dictionary<string, string>? Extra { get; init; }
 }
// TableDiff.cs:114
-        var optionsChanged = … || !SameText(original.Options.Tablespace, desired.Options.Tablespace) && desired.Options.Tablespace is not null;
+        var optionsChanged = … || !SameText(original.Options.Tablespace, desired.Options.Tablespace) && desired.Options.Tablespace is not null
+                             || !SameExtra(original.Options.Extra, desired.Options.Extra);
// ui/src/api/types.ts:601
-export interface TableOptions { withoutRowid: boolean; strict: boolean; tablespace: string | null }
+export interface TableOptions { withoutRowid: boolean; strict: boolean; tablespace: string | null; extra?: Record<string, string> | null }
```
plus a per-provider options panel hook in `ui/src/designer/table/TableDesigner.tsx` (e.g. a `registerDesignerOptionsPanel(providerId, lazy(...))`
next to the FALLBACK_TYPES block, line 63) so WP-CH can contribute an "Engine" tab from `components/ClickHouse/`.
Local stub: `ChEngineOptions.From(TableModel)` returns null (engine/src/DbStudio.Providers.ClickHouse/Designer/ChDdlScripter.cs);
new tables get `ENGINE = MergeTree ORDER BY <primary key>`; the explicit overload
`ChDdlScripter.ScriptTable(original, desired, ctx, originalEngine, desiredEngine)` already scripts every clause and
`MODIFY TTL` / `REMOVE TTL` / `MODIFY SETTING` / `MODIFY ORDER BY` (unit-tested, goldens `clickhouse_create_engine.sql`).
Once Extra exists: fill it in `ChDesignerDatabase.ReadTableAsync` from `system.tables` and read it in `ChEngineOptions.From`.

### R3-2 engine/tests/DbStudio.Providers.Conformance/ProviderFixture.cs:50 + ProviderConformanceTests.cs:206/542/567/595 — fixture switches
Reason: ClickHouse has no foreign keys, no auto-increment, and `UPDATE`/`DELETE` are mutations (`ALTER TABLE … UPDATE`) without a
row count; four shared tests assert those and fail for ClickHouse (WP-CS will hit the same for Cassandra):
`Catalog_LoadSchema_TablesColumnsKeys` (identity flag l.556, FK count l.563), `Catalog_LoadSchema_ForeignKeys`,
`Catalog_ObjectDetails_ColumnsAndReferencedBy` (identity l.604, FKs l.607ff), `Execute_Dml_ReportsRowsAffected`
(standard `UPDATE … SET` is not ClickHouse 24.8 SQL). Everything else of the suite passes (145/149 + 5 transaction skips).
Proposed diff:
```diff
// ProviderFixture.cs after line 50
+    /// <summary>Batch 3: false when the engine has no foreign keys (ClickHouse, Cassandra): FK assertions are skipped.</summary>
+    public virtual bool SupportsForeignKeys => true;
+    /// <summary>Batch 3: false when there is no identity/auto-increment column (ClickHouse, Cassandra).</summary>
+    public virtual bool SupportsIdentity => true;
+    /// <summary>Batch 3: false when UPDATE/DELETE report no row counts (ClickHouse mutations): only the INSERT count is checked.</summary>
+    public virtual bool ReportsDmlRowCounts => true;
// ProviderConformanceTests.cs
 Catalog_LoadSchema_TablesColumnsKeys:
-        Assert.True((id.Flags & 1) == 1, "Customers.Id must be flagged identity/autoincrement.");
+        if (Fixture.SupportsIdentity) Assert.True((id.Flags & 1) == 1, "Customers.Id must be flagged identity/autoincrement.");
-        Assert.Equal(2, lines.ForeignKeys.Count);
+        if (Fixture.SupportsForeignKeys) Assert.Equal(2, lines.ForeignKeys.Count);
 Catalog_LoadSchema_ForeignKeys:
+        Skip.IfNot(Fixture.SupportsForeignKeys, $"{Fixture.Provider.Id} has no foreign keys.");
 Catalog_ObjectDetails_ColumnsAndReferencedBy:
-        Assert.True(details.Columns[0].IsIdentity);
-        Assert.Single(details.ForeignKeys);
-        // Incoming FKs …
-        var incoming = …; Assert.Equal(…); Assert.False(…);
+        if (Fixture.SupportsIdentity) Assert.True(details.Columns[0].IsIdentity);
+        if (Fixture.SupportsForeignKeys)
+        {
+            Assert.Single(details.ForeignKeys);
+            var incoming = …; Assert.Equal(…); Assert.False(…);
+        }
 Execute_Dml_ReportsRowsAffected:
+        Skip.IfNot(Fixture.ReportsDmlRowCounts, $"{Fixture.Provider.Id} reports no UPDATE/DELETE row counts.");
```
and in `engine/tests/DbStudio.Providers.ClickHouse.Tests/ChFixture.cs` (WP-CH) the three overrides `=> false`.
Local stub: none possible (the tests are not virtual); the four tests fail in the ClickHouse integration run until this lands.

## Driver notes (ClickHouse.Driver 1.5.0)

- `JsonReadMode`/`JsonWriteMode` must be `None` for servers before 24.10: the default modes send
  `output_format_binary_write_json_as_string`, which 24.8 rejects with UNKNOWN_SETTING on **every** query. JSON columns are read as text.
- `ClickHouseConnection.ServerVersion` throws in 1.5.0; the provider reads `version()` instead. `QueryStats` stays null over HTTP:
  rows written come from the `X-ClickHouse-Summary` response header (the engine passes its own `HttpClient` with an observer —
  also the test seam, `ClickHouseProvider.Handler`).
- One statement per HTTP request ("Multi-statements are not allowed"): `ChSession` splits batches. `USE db` alone does not
  change the database (the driver sends `database=` with every request): the session calls `ChangeDatabase` after it.
- `Cancel()` only aborts the HTTP request; the server keeps running the query (and keeps the HTTP session locked). The
  session runs `KILL QUERY WHERE query_id = '…' SYNC` on a side connection outside the session; read-only queries are also
  cancelled by `cancel_http_readonly_queries_on_client_close = 1`. Measured cancel < 2 s.
- Dictionaries with a local `SOURCE(CLICKHOUSE(TABLE …))` log in as `default`, which the docker image removes when
  `CLICKHOUSE_USER` is set: the seed gives `USER 'shop' PASSWORD 'shop'` (README section).
- A parametrised view inside a scalar subquery fails with ACCESS_DENIED on 24.8 (server bug); a plain `FROM view(p = …)` works.

## Other notes

- Catalog: dictionaries are `type` objects with comment "Dictionary…" (plan), SQL UDFs are `func` objects listed in the
  connection's default database (they are global in ClickHouse), `.inner*` MV tables are hidden, `system`/`INFORMATION_SCHEMA`
  are not listed as schemas (the dialect's `systemCatalog` completes them). See also the UI requests R3-UI-4 (label
  "Dictionaries", tabular) below.
- No change needed in `DialectInfo` / `ResultWriters` (`unhex('…')` binary literal is right for ClickHouse).
- Core blocks edited: `StatementClassifier.ClassifyClickHouse` (SHOW/DESCRIBE/EXISTS/WATCH = query; OPTIMIZE/SYSTEM/KILL/CHECK =
  other; `ALTER TABLE … UPDATE/DELETE` = DML mutations (destructive with `WHERE 1`/`true`); `ALTER … DROP/DETACH PARTITION|PART`
  = "DROP PARTITION" (destructive); DICTIONARY DDL → type `type`; ATTACH/DETACH/UNDROP TABLE, RENAME/EXCHANGE TABLES),
  `SearchSql.TextExpression` (Nullable/LowCardinality unwrapped, arrays/maps of strings via `toString`), `DesignerCases.N`
  (lower snake). `ShopSchema.Seed` block left as is: the fixture seeds from `seed-clickhouse.sql` (`SeedOnInitialize => false`).
- Designer apply appends `ENGINE = MergeTree ORDER BY tuple()` to a bare `CREATE TABLE t (…)` (what
  `create_table_empty_primary_key_by_default` does on newer servers; 24.8 ignores that setting for this case).
- Engine publish: no new package beyond WP0's ClickHouse.Driver (+NodaTime, RecyclableMemoryStream) — no delta from WP-CH.
- Docker: Docker Desktop was not running after the session's outage; it was started again from the session (no settings
  changed). The integration tests use Testcontainers (random port, label `rowlit.wp=wp-ch`, Ryuk cleanup).

## Requests (UI side)

(From the UI half; file:line at 686056e.)

### R3-UI-1 ui/src/intel/dialect/spec.ts:162 + ui/src/intel/index.ts:359 — dialect completion source (engines / settings / formats)
The completer has no dialect hook; `chComplete` (engines after `ENGINE =`, settings after `SETTINGS`, formats after `FORMAT`,
codecs/layouts/sources) is implemented and tested in the lazy chunk. Proposed: `DialectSpec.complete?: ExtraCompletionSource`
(type-only import) and in `intel/index.ts:359`
`const extra = this.spec.complete ? [this.spec.complete, ...this.extraSources] : this.extraSources;` passed as `extraSources`.
Local stub: `TODO(WPCH-shared)` in intel/dialect/clickhouse.ts.

### R3-UI-2 (important) ui/src/intel/complete/completer.ts:1030,1097 + ui/src/format/layout.ts:404-411 — case-sensitive names
ClickHouse function and type names are case-sensitive (`toYYYYMM`, `arrayJoin`, `UInt32`); with the default keyword/function
case "upper", completion inserts `TOYYYYMM(` and **Format SQL turns `arrayJoin(tags)` into `ARRAYJOIN(tags)`, which the server
rejects**. Proposed: `DialectSpec.preserveNameCase?: boolean`, honoured at completer.ts:1030 (function names), :1097 (types) and
in `caseText` of format/layout.ts (function/datatype branches); the ClickHouse spec sets it. Workaround meanwhile: Settings →
Format → Function case "As is". Test pinned in intel/__tests__/clickhouse.test.ts.

### R3-UI-3 ui/src/format/layout.ts:1151-1210 + ui/src/format/rules/common.ts:7-19 — ClickHouse clauses
PREWHERE, ARRAY JOIN / LEFT ARRAY JOIN, LIMIT n BY, SETTINGS and FORMAT stay on the previous line. Proposed
`FormatRules.extraClauses?: Record<string, string>` consulted in clauseAt's default branch and `FormatRules.joinWords?: Set<string>`
merged into JOIN_WORDS in joinAt (`ARRAY GLOBAL ANY ALL ASOF SEMI ANTI PASTE`).

### R3-UI-4 ui/src/lib/sql.ts:71-87 — dictionaries
Folder label "Dictionaries" for `type` objects of clickhouse connections and `isTabular` true for them (they are queryable:
`SELECT * FROM dict`). Proposed `objectTypeLabel(t, providerId)` / `isTabular(t, dialect)` and callers in the explorer/ObjectList.

### R3-UI-5 ui/src/commands/menuModel.ts:212-219 — ClickHouse entries in `explorer.table`
`{ command: 'clickhouse.parts' | 'clickhouse.mutations' | 'clickhouse.optimize', optional: true, hideDisabled: true }` (hidden for
other providers through `when`); `explorer.connection` could get `clickhouse.mutations` / `clickhouse.merges`. Meanwhile the
commands run from the palette on the explorer selection (`TODO(WPCH-shared)` in components/ClickHouse/commands.ts).

### R3-UI-6 ui/src/codegen/types/index.ts:181 (resolveType) — wrapper types
Unwrap `Nullable(…)`, `LowCardinality(…)`, `SimpleAggregateFunction(f, T)` and map `Array(T)` to an array of T for clickhouse.

### R3-UI-7 (optional, mock only) ui/src/mocks/engine.ts:112-148 — pack schema name / server info
Let a pack set its schema name and server info (the mock shows schema `main` and a SQLite version for ClickHouse Shop).

## Measurements

- Initial bundle: 1566.4 → 1567.0 KB gzipped (+0.6 KB; budget 1.1 KB). Lazy: dialect chunk 27.4 KB, ClickHouse views 4.2 KB
  (+1.2 KB CSS), commands 3.0 KB.
- Tests: see the final report (engine unit, fake-server and integration counts; UI suites).

# WP0 — Batch 3 foundation (notes for the work packages)

## Integration status (Batch 3 integration pass)

- The per-provider override for relational explorer menus (section 2, "Views, commands, menus") is now
  `extendContextMenu(menuId, entries)` in `commands/menuModel.ts`: a provider's lazy `commands.ts` appends
  `hideDisabled` entries to a shell menu; they appear only where the command's `when` holds.
- Provider table options in the designer: `TableOptions.extra` + `registerDesignerOptionsPanel` (`designer/table/optionsPanels.ts`).
- Mock packs may carry `shop` (schema, native types, banner, databases) per provider id (`mocks/packs/types.ts`).
- **Initial bundle**: the tree at `df72a7e` measured +122.9 KB (budget +120) before this pass. The provider logo artwork
  (`theme/brand/logos.tsx`, ~38 KB raw) is now its own lazy chunk (`ProviderLogo` shows a generic glyph until it loads;
  tests preload it in `src/test/setup.ts`), which brings the initial load to +112.9 KB with this whole pass included (budget +120).
- Still open: `codegen/__tests__/shop.ts` `ShopDialect` has no entries for the Batch 3 dialects (no codegen snapshots for
  them yet, nothing requested); a shared `ProviderConformanceTests` opt-out per test (Cassandra re-implements its subset).

Base: `main` @ `675ba34` (Rowlit 1.3.0). Plan: `plan-batch3.md` section 1. WP0 changed no behaviour of the existing
providers: the five new engine modules register nothing (so `GET /providers` still lists the M2 seven), the new
dialects only exist as lazy stubs, and every Batch 3 UI entry point (Welcome cards, mock connections) stays hidden until
its WP registers the provider. Read `README.md` in this folder for the ownership rules (R1–R4) and the R3 request format.

## 1. What each WP finds

### Engine stubs (all WPs)

| WP | Project (stub module) | Tests (stub `SmokeTests.cs`) | Packages |
|---|---|---|---|
| WP-MY | `engine/src/DbStudio.Providers.MySql/` (`MySqlModule.cs`) | `engine/tests/DbStudio.Providers.MySql.Tests/` | MySqlConnector 2.4.0; tests Testcontainers.MySql + .MariaDb 4.16.0 |
| WP-CH | `engine/src/DbStudio.Providers.ClickHouse/` (`ClickHouseModule.cs`) | `engine/tests/DbStudio.Providers.ClickHouse.Tests/` | ClickHouse.Driver 1.5.0; Testcontainers.ClickHouse 4.16.0 |
| WP-SF | `engine/src/DbStudio.Providers.Snowflake/` (`SnowflakeModule.cs`) | `engine/tests/DbStudio.Providers.Snowflake.Tests/` (no Testcontainers) | Snowflake.Data 4.8.0 (+ log4net 3.3.2 pin) |
| WP-CS | `engine/src/DbStudio.Providers.Cassandra/` (`CassandraModule.cs`) | `engine/tests/DbStudio.Providers.Cassandra.Tests/` | CassandraCSharpDriver 3.22.1 (+ Newtonsoft.Json 13.0.3 pin); Testcontainers.Cassandra 4.16.0 |
| WP-ES | `engine/src/DbStudio.Sources.Elasticsearch/` (`ElasticsearchModule.cs`) | `engine/tests/DbStudio.Sources.Elasticsearch.Tests/` | none (HttpClient, D4); Testcontainers.Elasticsearch 4.16.0 |

Every project: net10.0, `FrameworkReference Microsoft.AspNetCore.App`, references `DbStudio.Core` and `DbStudio.Logs`,
`InternalsVisibleTo` its test project. The relational test projects also reference the conformance library
(`DbStudio.Providers.Conformance.Tests.csproj`); the test csprojs link their docker seed files into `docker/` of the
output (`seed-mysql.sql` + `seed-mariadb.sql`, `seed-clickhouse.sql`, `seed-cassandra.cql`, `seed-elasticsearch.*`).
Host anchors (`ModuleAssemblies.cs`), Host `ProjectReference`s and the `.slnx` entries are in place: **no WP edits
Program.cs, the Host csproj, ModuleAssemblies.cs or the slnx.**

Logs/activity sources (plan "Owns" `engine/src/DbStudio.Logs/Providers/<X>/**`): put them in that folder as **public**
classes (they are registered from your module, another assembly) and register them keyed, e.g.

```csharp
public void ConfigureServices(IServiceCollection services)
{
    services.AddSingleton<IDbProvider, MySqlProvider>();
    services.AddSingleton<IDbProvider, MariaDbProvider>();
    foreach (var id in new[] { "mysql", "mariadb" })
    {
        services.AddKeyedSingleton<IDdlScripter, MySqlDdlScripter>(id);
        services.AddKeyedSingleton<IDesignerDatabase, MySqlDesignerDatabase>(id);
        services.AddKeyedSingleton<IPlanReader, MySqlPlanReader>(id);
        services.AddKeyedSingleton<IParamBinder>(id, MySqlParamBinder.Instance);
        services.AddKeyedSingleton<ILogSource>(id, (sp, _) => sp.GetRequiredService<MySqlLogSource>());
        services.AddKeyedSingleton<IActivitySource>(id, (sp, _) => sp.GetRequiredService<MySqlLogSource>());
    }
    services.AddSingleton<MySqlLogSource>();          // DbStudio.Logs.Providers.MySql (needs ISqlRunnerFactory from LogsModule)
    services.AddKeyedSingleton<IStreamFactory>("…", (sp, _) => …);
}
public void MapEndpoints(RouteGroupBuilder api) => api.MapGroup("/mysql")…;
```

`ProviderRegistry`/`SourceRegistry` resolve `IEnumerable<IDbProvider>`/`IEnumerable<IDataSourceProvider>` after all modules
ran, `ProviderFeatures` and `LogService` look keyed services up at call time, so registration order does not matter
(modules run in full-type-name order: `DbStudio.Logs.LogsModule` before `DbStudio.Providers.*`). `IObjectBrowserProvider`
and `IDatabaseSearchProvider` are implemented by the provider class itself (as PostgreSQL does). WP-ES registers an
`IDataSourceProvider` with `Kind => SourceKind.Search` (wire `"search"`).

### Labelled blocks in shared files

Edit only inside your own `// WP-XX begin … // WP-XX end` blocks (several per file: one per switch). Values WP0 seeded
are a starting point; change them freely inside the block.

| File | Blocks | What goes there |
|---|---|---|
| `engine/src/DbStudio.Core/Search/SearchSql.cs` | WP-MY ×6, WP-CH ×8, WP-SF ×6, WP-CS ×6 | `EscapeOf` (CH), `Param`, `LikePredicate`, `RegexPredicate`, `RegexParameter` (CH), `Quote`, `TextExpression`, `BuildDataQuery` top-n |
| `engine/src/DbStudio.Core/Sql/StatementClassifier.cs` | WP-MY, WP-CH, WP-SF, WP-CS | `ClassifyMySql/ClickHouse/Snowflake/Cql(t, i, u, hasWhere, start)`: return a classification for dialect-specific heads (SHOW, DESCRIBE, CALL, START TRANSACTION, OPTIMIZE, SYSTEM, LIST, PUT/GET, BEGIN BATCH…) or null for the shared switch |
| `engine/src/DbStudio.Core/Sql/SqlTokenizer.cs` | WP-MY, WP-SF (`StartsBlock`), WP-CS (`SplitStatements`) | block statements kept whole (MySQL BEGIN…END / CREATE PROCEDURE with DEFINER, Snowflake Scripting outside `$$`); CQL batch depth (seeded: `BEGIN [UNLOGGED|COUNTER] BATCH … APPLY BATCH` is one statement) |
| `engine/tests/DbStudio.Providers.Conformance/ShopSchema.cs` | WP-MY, WP-CH, WP-SF, WP-CS (`Seed`) | your seed batches (placeholder: `SqliteSeed`), or seed via docker and override `SeedOnInitialize => false` in your fixture |
| `engine/tests/DbStudio.Providers.Conformance/M15/DesignerCases.cs` | ×2 each (`For` types, `N` names) | designer case types and physical names |
| `ui/src/codegen/lang/csharp.ts` (`PROVIDER`), `codegen/lang/typescript.ts` (`DRIVER`) | WP-MY, WP-CH, WP-SF, WP-CS | ADO.NET / Node driver of the generated code |
| `ui/src/components/ErDiagram/fkDialog.tsx` (`ACTIONS`) | 〃 | FK actions offered |
| `ui/src/designer/proc/templates.ts` (`DEFAULT_PARAM_TYPE`, `DEFAULT_RETURN_TYPE`) | ×2 each | routine wizard defaults |
| `ui/src/designer/table/model.ts` (`DEFAULT_COLUMN_TYPE`, `DEFAULT_KEY_TYPE`) | ×2 each | table designer defaults |
| `ui/src/designer/table/TableDesigner.tsx` (`FALLBACK_TYPES`) | 〃 | type list while `GET /designer/types` is unavailable |
| `ui/src/editor/dev/EditorPlayground.tsx` (`SAMPLES`) | 〃 | dev playground sample |

Not labelled (WP0 values, change through R3): `DialectInfo` traits, `ResultWriters` literals, `ProviderFixture` defaults
(override them in your fixture instead), `designer/table/model.ts caseFor` (Snowflake upper, others lower).

### UI stub files (owned per WP)

| WP | Files |
|---|---|
| WP-MY | `ui/src/intel/dialect/mysql.ts`, `intel/dialect/data/mysql-functions.json`, `intel/split/mysql.ts`, `format/rules/mysql.ts`, `codegen/types/mysql.json`, `intel/__tests__/fixtures/shop-mysql.json`, `mocks/packs/mysql.ts`, `api/m3/mysql.ts` |
| WP-CH | `intel/dialect/clickhouse.ts`, `data/clickhouse-functions.json`, `format/rules/clickhouse.ts`, `codegen/types/clickhouse.json`, `fixtures/shop-clickhouse.json`, `mocks/packs/clickhouse.ts`, `api/m3/clickhouse.ts` |
| WP-SF | `intel/dialect/snowflake.ts`, `data/snowflake-functions.json`, `format/rules/snowflake.ts`, `codegen/types/snowflake.json`, `fixtures/shop-snowflake.json`, `mocks/packs/snowflake.ts`, `api/m3/snowflake.ts` |
| WP-CS | `intel/dialect/cql.ts`, `data/cql-functions.json`, `intel/split/cql.ts`, `format/rules/cql.ts`, `codegen/types/cql.json`, `fixtures/shop-cql.json`, `mocks/packs/cassandra.ts`, `api/m3/cassandra.ts` |
| WP-ES | `mocks/packs/elasticsearch.ts`, `api/m3/es.ts` |

Create freely (R1): `api/types.<mysql|clickhouse|snowflake|cassandra|es>.ts`, `components/<MySql|ClickHouse|Snowflake|Cassandra|Elasticsearch>/**`,
`ui/src/es/**`, your `__tests__/<dialect>*.test.ts`, `docs/qa/<name>-walkthrough.md`, `docs/wp-notes/<WP>.md`. A WP
without a `split/<id>.ts` (CH, SF) may add one and reference it from its dialect file. Lazy-only shared helpers you may
import from a dialect chunk: `intel/dialect/ansi.ts` and `intel/lexer/traits.ts` (both WP0, do not edit; R3 for changes).

Docker: `engine/tests/docker/seed-mysql.sql`, `seed-mariadb.sql`, `seed-clickhouse.sql`, `seed-cassandra.cql`,
`seed-elasticsearch.sh` + `.ndjson`, `seed-snowflake.sql` are placeholders owned by their WP; the service blocks in
`compose.yml` are WP0's (R3 to change them). Append your own section to `engine/tests/docker/README.md` below the
"Batch 3 services" table.

## 2. How the UI pieces plug in

### Lazy dialects (D7) — read this before writing `intel/dialect/<id>.ts`

- `intel/dialect/registry.ts` maps `mysql | clickhouse | snowflake | cql` to `import('./<id>')` and calls the module's
  **`define(kit)`** export (`DialectDefine` in `spec.ts`). `getSpec(d)` answers with the loaded spec, else with
  `genericSpec(d)` (the SQLite tables under the real id). `ensureDialect(d)` loads (shared promise; resolves to the
  generic spec if the chunk fails), `isDialectReady(d)`, `isLazyDialect(d)`.
- `SqlEditor` does not create its model/intel until `isDialectReady(dialect)` (it calls `ensureDialect` itself);
  `connectAndOpen` starts the load while the console opens. Synchronous consumers (formatter, codegen, designer DDL,
  explain) use whatever `getSpec` answers.
- **The no-import rule.** A lazy dialect chunk (your `dialect/<id>.ts` and every file only it imports) must not import
  *runtime* code from the shell/intel/format modules — `import type` is fine. One runtime import (even `buildSpec`) makes
  the bundler re-partition the shared intel/splitter chunks: measured +3 KB gzipped on the initial load for nothing.
  Get helpers from the arguments instead:
  - `define(kit: DialectKit)`: `kit.buildSpec`, `kit.words`, `kit.phrases`, `kit.wordSet`;
  - `DialectSpec.split: DialectSplitter = (b, sig, opts, kit: SplitKit)`: `kit.splitSemicolon`, `kit.isWordTok`,
    `kit.hasBlankLine`; `b` is the splitter's builder (`b.tokens`, `b.text`, `b.add(first, last, extra?)`);
  - `DialectSpec.formatRules: FormatRulesFactory = (kit: FormatKit) => FormatRules`: `kit.sqliteRules`, `kit.set`,
    `kit.CONDITION_CLAUSES`, `kit.OPERAND_KEYWORDS_COMMON` (format/layout.ts `rulesFor` builds and caches it per spec).
  Check with `node .github/scripts/bundle-size.mjs …`: your initial delta must stay ≤ +1.5 KB.
- Other `DialectSpec` hooks (all optional, `spec.ts`): `ops2`/`ops3` (operators), `lex` (LexTraits, the declaration) +
  `lexHook` (the implementation: `traitLexer(LEX)` from `lexer/traits.ts`), `systemCatalog` (built-in schemas for
  completion, `{ schemas: CatalogSchema[] }` like `data/pgsql-system.json`; keep it a JSON in your chunk), `classify`
  (statement kinds for the destructive-run guard: `(toks, head) => StatementKind | undefined`), `split`, `formatRules`.
- LexTraits (all default off): `backtickIdent`, `hashComment`, `backslashEscapes`, `dollarQuotes`, `paramPrefixes`
  (e.g. `'@:?'`: `@name`, `@@sysvar`, `:name` but never the `::` cast, lone `?`/`?1`), `dollarParams` (`$1`),
  `braceParams` (`{name:Type}`), `hexNumbers` (`0x1F`), `stringPrefixes` (e.g. `'NXB'`). The hook runs after the comment
  checks and before everything else; a new trait is an R3 request against `lexer/traits.ts`, or write your own
  `LexHook` in your chunk (it gets a `LexKit`: `text`, `pos`, `endState`, `make`, `multi`, `scanString`, `scanEString`,
  `scanDollar`, `scanQuotedIdent`, `isIdentStart`, `isIdentPart`; resume states `s`, `e`, `d<tag>`, `c<depth>` are
  handled by the lexer).
- Intel tests: `intelFor(d)` / `createIntel(d)` use the generic spec unless you `await ensureDialect(d)` first (e.g. in
  `beforeAll`). Fixtures: `intel/__tests__/fixtures/shop-<id>.json` (WP0 copies of the SQLite shop with the dialect
  changed; `helpers.ts` already lists them in `fixtures`).
- Language ids `dbstudio-mysql|clickhouse|snowflake|cql` are registered up front (monaco-setup.ts); the Monaco tokenizer
  calls `getSpec` per line. Backticks auto-close for mysql/clickhouse. `blankLineSplitsStatements` is forced off for the
  four new dialects (editor/settings.ts), like SQLite/PostgreSQL.

### Views, commands, menus, palette, source modules

- Put `components/<Feature>/commands.ts` with a `register…Commands()` export: `commands/index.ts` auto-loads it at startup
  as its own lazy chunk (not part of the initial-load figure). Register there:
  - commands: `registerCommands([...])` (commands/registry.ts), like `components/Kafka/commands.ts`;
  - tab views: `registerTabView('clickhouse.parts', { component: lazy(() => import('./PartsView')), icon: '…' })`
    (components/layout/tabViews.ts); keep views behind `lazy()`/`import()`;
  - context menus: `registerContextMenu('explorer.es.index', entries)` (commands/menuModel.ts, new; returns an
    unregister function; shell ids cannot be replaced). Relational explorer rows still pick `explorer.<type>` menus:
    a per-provider override for relational rows is an R3 request (`components/Explorer/*` is frozen);
  - WP-ES source module: `registerSourceModule({ providerId: 'elasticsearch', kind: 'search', … })` (lib/sources.ts);
    palette entries may use `type: 'es.index'` (CommandPalette label "Index", found with the `t:` prefix).
- REST namespaces: fill `api/m3/<x>.ts` (`create<X>Api(http)` returns the namespace object; `api.mysql`, `api.clickhouse`,
  `api.snowflake`, `api.cassandra`, `api.es` are spread into `api` by `api/client.m3.ts`). These files are in the
  initial bundle: thin request wrappers only; wire types in `api/types.<x>.ts`.
- Mocks: `mocks/packs/<x>.ts` exports a `MockProviderPack` (`providers`, `connections`, `extraObjects`, `handlers(ctx)`;
  `ctx` is the M2 mock context). WP0 kept the packs **inert** (`providers: []`, `connections: []`); the sample
  connection (folder "Batch 3") is exported as `<x>Connections` — list it in `connections` together with your
  `ProviderInfo` when you add one (mocks/fixtures.ts spreads both, mocks/handlers.ts the handlers; mocks/engine.ts gives
  a pack provider the SQLite shop tables plus `extraObjects[providerId]`).
- Labels/colours/logos exist for the six ids: `PROVIDER_LABEL`, StatusBar dialect names, `--provider-<id>` tokens (light
  per plan; dark `#5fb0dc #6cc3d6 #f2c94c #63bdf0 #3fcfac #67c1e6`, all ≥ 3:1), placeholder logos (a cylinder in the token
  colour; WP-UI vendors the artwork). Welcome cards for the six appear only when `GET /providers` lists the id.
- Schema level: `schemaIsDatabase(p)` (oracle, mysql, mariadb, clickhouse, cassandra) and `schemaLevelLabel(p)`
  (`schema` / `keyspace` / `database`) in `lib/providerLevels.ts` (re-exported by store/connections); `hasDatabaseLevel`
  now includes snowflake. Toolbar, console switcher, saved queries and `catalogDatabase`/`effectiveDatabase` use them.
- `suggestName`: snowflake `user@account/database`, elasticsearch the host of the first `url`, cassandra
  `contactPoints[0]/keyspace` (form keys must be exactly these names).

## 3. Engine foundation details

- `Dialect { …, MySql, ClickHouse, Snowflake, Cql }` (wire `mysql clickhouse snowflake cql`), `SourceKind.Search`
  (`search`); settings validation knows the eight dialects; `SourceRegistry.DisplayOrder` per plan.
- `DialectInfo`: `HasDatabases` += Snowflake; `SchemaIsDatabase`; `DefaultSchemaFallback` (MySql "", ClickHouse
  "default", Snowflake "PUBLIC", Cql ""); `BacktickIdentifiers`, `HashLineComments`, `BackslashStringEscapes`,
  `DollarQuotedStrings`, `IdentifierQuote`, plus `QuoteIdentifier(d, name)`.
- `SqlTokenizer` reads those traits (no WP edits it): `#` comments, backslash escapes in `'…'` (also `''`), backticks,
  `$$` bodies for PgSql + Snowflake (`E''`/`U&''` stay PgSql-only). Parameters: `@x` and `:x` are parameter tokens for every
  non-T-SQL dialect already; `?` too (except PgSql).
- `StatementClassifier`: 3-part names use `DialectInfo.HasDatabases` (T-SQL, PgSql, Snowflake); per-dialect head hooks
  (blocks above).
- `SqlInsertResultWriter`: identifiers through `DialectInfo.QuoteIdentifier`; binary literals per plan; backslashes are
  doubled in strings for the backslash-escape dialects; CQL booleans are `true/false`.
- `CatalogService`: the Oracle-only "session schema" fallback now applies to every `SchemaIsDatabase` dialect.
- Conformance fixture virtuals (new): `SupportsTransactions` (CH, CS: false), `SupportsSavepoints` (SF: false),
  `SupportsCancel`; the transaction/savepoint/cancel tests skip through `RequireTransactions/RequireSavepoints/
  RequireCancel`. Existing virtuals to override in your fixture: `LongRunningQuery`, `MultiResultSetBatch`,
  `CreateScratchTableSql` (CH: `ENGINE = MergeTree ORDER BY id`), `InsertScratchRowsSql`, `ShopSchemaQualifier`,
  `Database`, `ShopSchema`, `SeedBatches`, `SeedOnInitialize`, `CreateFailingProfile`, `InvalidQuery`.
  `ShopSchema.Name`: MySql/ClickHouse/Cql lower_snake, Snowflake UPPER_SNAKE; `DefaultSchema`: `shop` / `PUBLIC`.
- Unit tests of the foundation: `engine/tests/DbStudio.Core.Tests/Batch3/Batch3FoundationTests.cs`,
  `ui/src/intel/__tests__/batch3-foundation.test.ts`.

## 4. Deviations from the plan (and why)

1. **Drivers / versions.** MySqlConnector **2.4.0** (the only 2.4.x; 2.6.2 is current). **ClickHouse.Driver 1.5.0**
   (official ClickHouse Inc. client, ≥ 1.0, `DbConnection`/`DbDataReader` streaming; its nuspec says **MIT**, not
   Apache-2.0; it also ships `ClickHouse.Driver.Tcp/Common`). **Snowflake.Data 4.8.0** (latest 4.x) needs
   **log4net 3.3.2** pinned: 4.x depends on log4net 2.0.12 (GHSA-4f7c-pmjv-c25w, NuGetAudit fails the restore). That
   is a major log4net bump under the driver: WP-SF must verify the driver logs/initialises with it, or move to
   Snowflake.Data 6.x (no log4net, newer AWS/Azure/Google SDKs) and note it. Snowflake.Data also pulls **Mono.Unix**
   (native `libMono.Unix` for linux/osx, none for win-x64): D5 says "no native libraries" — WP-SF checks the
   osx-arm64 publish. **CassandraCSharpDriver 3.22.1** needs **Newtonsoft.Json 13.0.3** pinned (it depends on 9.0.1,
   GHSA-5crp-9r3c-p9vr; the same pin as Kafka).
2. **SearchSql LIKE escape**: kept the existing `!` escape (`ESCAPE '!'`) for MySQL/Snowflake instead of the plan's
   `ESCAPE '\\'` (a backslash would need doubling inside MySQL/Snowflake string literals). ClickHouse has no ESCAPE
   clause: new `SearchSql.EscapeOf(dialect)` returns `\` for it and `LikePattern` uses it. MySQL `REGEXP_LIKE` is MySQL
   8.0+ only (MariaDB: `REGEXP`) — flagged in the WP-MY block.
3. **Lazy dialect contract**: the plan's "`LOADERS` per dialect via `import()`" exports a ready spec; measured, a lazy
   chunk that imports `buildSpec`/`splitSemicolon`/format rules at run time re-partitions the initial chunks (+3 KB). So
   dialect modules export `define(kit)` and get split/format helpers through `SplitKit`/`FormatKit` (section 2). The
   generic spec before loading is the SQLite spec under the dialect id (an ANSI keyword table cost 1.4 KB initial); the
   ANSI base moved to the lazy-only `dialect/ansi.ts`.
4. **Lexer traits**: implemented as a lazy lexer hook (`lexer/traits.ts`, `DialectSpec.lexHook`) instead of inline in
   lexer.ts (another ~0.5 KB off the initial load); lexer.ts only gained `ops2/ops3` from the spec and the hook call.
   More traits than the plan's four: `paramPrefixes`, `dollarParams`, `braceParams`, `hexNumbers`, `stringPrefixes`.
5. **Splitter/formatter registration**: no `case 'mysql'` in split/splitter.ts and no entries in the format `RULES`
   maps; the dialect spec carries `split` / `formatRules` (default: the SQLite rules = semicolons, CASE…END and
   CREATE TRIGGER…BEGIN…END kept whole). `format/rules/<id>.ts` are factories.
6. **Extra hooks** not in the plan: `DialectSpec.classify` (UI destructive guard), `StatementClassifier.Classify<X>`
   blocks, `SqlTokenizer` split blocks, `DesignerCases` blocks, `SupportsSavepoints`.
7. **Mock packs inert** (plan: "one connection each in folder Batch 3" active): an active connection for a provider the
   mock `/providers` does not list breaks the connection dialog and shifts existing UI tests; each pack exports its
   connection for the WP to activate.
8. **Welcome cards** for the six providers render only when the engine lists the provider (no dead cards meanwhile).
9. Also switched the Oracle-only checks of `ConnectionSwitcher`, `SavedQueries` (actions, model, dialog) to
   `schemaIsDatabase`/`schemaLevelLabel` (the plan named actions.ts and Toolbar; these files are frozen for WPs too).
10. `--provider-*` dark variants chosen by WP0 (≥ 3:1 on the dark panels); placeholder logos use the token colour.
11. `M15ServiceTests.Update_MergesAndValidates` used `mysql` as its "unknown dialect": now `db2`.
12. Extra UI stubs: `codegen/__tests__/shop.ts` `ShopDialect` narrowed to the four original dialects (add yours when you
    add codegen snapshots — R3, the file is shared); `PendingChanges` dialect names.
13. CI: `integration` job starts the new services/profiles; new optional `integration-snowflake` job (dispatch input
    `integration-snowflake` + `DBSTUDIO_SF_*` secrets, `continue-on-error`). `kafka-native-smoke.mjs` checks a subset.
14. Engine publish was verified into a scratch folder with the exact `scripts/build.ps1 -EngineOnly` arguments
    (`engine/publish` was left alone).

## 5. Measurements (WP0)

- **Initial load** (bundle-size.mjs): 1564.4 → **1566.4 KB** gzipped, **+2.0 KB** (2,073 bytes; baseline delta +112.2 →
  +114.2 KB of the +120 KB budget, so **5.8 KB** remain for the five WPs ≈ 1.1 KB each). Breakdown: intel/splitter chunks
  +0.5 KB (registry, spec/split/format hooks, lexer hook call), index +0.65 KB (Welcome blurbs, labels, schema-level
  plumbing, SqlEditor wait, monaco ids), actions +0.26 KB, logos +0.19 KB, provider tokens +0.29 KB (CSS + theme JS),
  client +0.08 KB, connections +0.08 KB. Lazy chunks: mysql 0.41, clickhouse 0.35, snowflake 0.34, cql 0.32 and the shared
  traits + ansi chunk 1.50 KB gzipped. Total bundle 2124.5 → 2130.0 KB.
- **Engine publish** (single-file, self-contained, win-x64, compressed): 68,693,758 → **77,430,368 bytes** (65.5 →
  73.8 MiB, **+8.3 MiB**), all from the driver packages (Snowflake.Data's AWS/Azure/Google/Arrow/BouncyCastle graph,
  Cassandra, ClickHouse, MySqlConnector, NodaTime, log4net). Shared assemblies are unchanged (no version bumps). The
  published engine starts, discovers the five new modules and still lists the seven M2 providers.
- Tests: `dotnet test` (DBSTUDIO_IT=0) green; UI `npm test` 164 files / 1982 tests green; `npm run test:intel` 832/833:
  the timing test "5,000-line T-SQL script formats in < 150 ms" fails only when the whole suite runs on 16 workers on this
  machine (154 ms; the same happens on the base tree); alone it passes, an A/B benchmark gives identical medians
  (82.6/84.9 ms vs base 83.0/82.3 ms), and with `CI=1` (600 ms budget) the file passes. Desktop `npm test` green.

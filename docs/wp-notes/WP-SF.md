# WP-SF — Snowflake (notes for the orchestrator)

## Integration status (Batch 3 integration pass)

| Request | Status | Where / notes |
|---|---|---|
| R3-1 secrets for sessions / catalog / designer / search / logs | DONE | `ConnectionStore.WithSecrets` at `SessionManager` (open + both reopen paths), `CatalogService.Resolve`, `DesignerService.Resolve`, `ObjectsEndpoints.Resolve`, `DatabaseSearchService`, `SqlRunner`. `SnowflakeSecrets` stays for the module endpoints (no-op when the props are present) |
| R3-2 Snowflake Scripting depth | DONE | `SqlTokenizer.ScriptBlockStep` (DECLARE ... BEGIN as one level, IF / FOR / WHILE / REPEAT / LOOP / CASE, `FOR ... CURSOR`, `IF [NOT] EXISTS`); `ScriptBlockSplitTests.cs` |
| R3-3 `$1` is no bind | DONE | the Snowflake lex hook reads `$digits` as an identifier; `batch3-foundation.test.ts` pins `ident:$1`; `dollarParams` removed |
| R3-4 QUALIFY / path colon | DONE | `extraClauses: { QUALIFY: 'where' }`, `spaceBefore` for `snowflake`; `snowflake.test.ts` |
| R3-5 connection menu entries | DONE | `extendContextMenu('explorer.connection', ...)` in `components/Snowflake/commands.ts` |
| R3-6 NUMBER(p,0) | DONE | `codegen/types/index.ts` (NUMBER / DECIMAL / NUMERIC without a scale -> `int`) |
| R3-7 mock dialect / schemas / pack handlers first | DONE | `MockProviderPack.shop` (SHOP, PUBLIC, ANALYTICS), `DIALECT` from the packs, pack handlers before the logs handlers |
| R3-8 CI macOS natives | DONE (not run on macOS here) | `scripts/ci/kafka-native-smoke.mjs`: `checkDylibs` over librdkafka, libMono.Unix, libsf_mini_core (arch, system deps only, codesign) + the Snowflake bogus-account REST check on every platform; provider list now includes all Batch 3 ids |
| R3-9 table options | DONE | via `TableOptions.Extra` (`kind` = transient, `retentionDays`, `changeTracking`): `SfTableOptions`, scripter (CREATE TRANSIENT, SET / UNSET), `SnowflakeDesignerDatabase` (SHOW TABLES), UI panel `components/Snowflake/TableOptions.tsx`; `TableOptionsTests.cs` |

Branch `worktree-agent-ae7598b9067abf11d`, on top of WP0 (`686056e`). file:line references below are to `686056e`.

## What landed

- **Engine** `engine/src/DbStudio.Providers.Snowflake/**`: `SnowflakeProvider` (`"snowflake"`, `Dialect.Snowflake`,
  `IObjectBrowserProvider`, `IDatabaseSearchProvider`, identifiers `"…"`, folding `upper`), `SnowflakeSession :
  AdoSessionBase`, connection strings/form spec (password, `snowflake_jwt` + passphrase, `externalbrowser`, `oauth`),
  the `ISnowflakeGateway` seam (`Gateway/`) used by every metadata path, catalog reader (SHOW / DESCRIBE / GET_DDL, no
  warehouse needed), DDL generator fallback, dependencies + object list, find in database, designer scripter + database,
  plan reader (`EXPLAIN USING JSON`, `GET_QUERY_OPERATOR_STATS`), parameter binder, module endpoints (`Module/`,
  `SnowflakeModule.cs`). Logs/activity: `engine/src/DbStudio.Logs/Providers/Snowflake/SnowflakeLogSource.cs`.
- **Labelled blocks**: `SearchSql.cs` (Param `:1`), `StatementClassifier.cs` (`ClassifySnowflake`), `SqlTokenizer.cs`
  (`StartsBlock`: DECLARE / scripting BEGIN), `ShopSchema.cs` (seed), `DesignerCases.cs` (`N`), UI `fkDialog.tsx`,
  `TableDesigner.tsx`, `EditorPlayground.tsx` (the other UI blocks keep WP0's values).
- **Tests** `engine/tests/DbStudio.Providers.Snowflake.Tests/**`: 108 unit tests over recorded JSON fixtures
  (`Fixtures/*.json`, replayed by `SnowflakeGatewayFake` / `FixtureSqlRunner`), designer goldens (`golden/`), and an opt-in
  live suite (`LiveTests.cs`: the shared conformance suite + session/catalog checks) gated by `DBSTUDIO_SF_ACCOUNT`,
  `DBSTUDIO_SF_DATABASE` (+ user/password or key, warehouse, role); `DBSTUDIO_SF_SEED=1` seeds the shop,
  `DBSTUDIO_UPDATE_GOLDEN=1` records live answers to `Fixtures/recorded/live.json.txt` for refreshing the fixtures.
- **UI**: `intel/dialect/snowflake.ts` (+ `data/snowflake-functions.json` 229 functions, new `data/snowflake-system.json`
  INFORMATION_SCHEMA + ACCOUNT_USAGE, imported only by the lazy chunk), new `intel/split/snowflake.ts`,
  `format/rules/snowflake.ts`, `codegen/types/snowflake.json`, `api/m3/snowflake.ts` + `api/types.snowflake.ts`,
  `components/Snowflake/**` (commands + lazy views `snowflake.session`, `snowflake.warehouses`, `snowflake.objects`,
  `snowflake.history`), `mocks/packs/snowflake.ts` (**active**: provider + connection "Snowflake Shop" in "Batch 3" + module
  routes), tests `intel/__tests__/snowflake.test.ts`, `components/Snowflake/__tests__/snowflake.views.test.tsx`.

## Deviations from the plan (and why)

1. **Snowflake.Data 6.4.0** instead of 4.8.0 (the WP0 pin `log4net 3.3.2` is gone): 5.0 dropped log4net (logging is
   delegated to Microsoft.Extensions.Logging, i.e. silent unless configured), 6.x targets net10.0, upgrades AWS SDK 4,
   Apache.Arrow 23, Azure.Storage.Blobs 12.29, BouncyCastle 2.7.0 (clears scanner findings) and fixes JWT retries and
   cancel/timeout behaviour. NuGetAudit is clean. 6.4.0 is from 2026-10-16 (6.0.0 from 2026-08-10). It is also ~0.7 MB
   smaller in the publish than 4.8.0. Driver-wide settings (`Gateway/SnowflakeGateway.cs SnowflakeDriver`): **in-memory
   credential manager** (SSO/MFA tokens never touch the user's credential store or home folder), client telemetry off
   (`CLIENT_TELEMETRY_ENABLED=false`), `application=Rowlit`, `query_tag` from the profile (default `Rowlit`).
2. **NUMBER(p, 0) → `int` kind for every p** (plan: p ≤ 18). `NUMBER(38,0)` is Snowflake's default integer type (every
   `INT` column); values beyond ±2^53 travel as exact strings (the shared ValueConverter rule), so nothing is lost.
3. **Search binds `:1`** (WP-SF block of `SearchSql.Param`): the term is referenced once per text column; numeric binds may
   repeat, `:name` binds are not reliable on the server.
4. **Designer**: the clustering key is modelled as the table's *clustered index* (at most one; expression keys such as
   `TO_DATE(ts)` stay out of the model, so saving never touches them). TRANSIENT / retention cannot be modelled (see R3-9).
   DDL is not transactional (`TransactionalDdl: false`, apply stops at the first error).
5. **Session**: DML bookkeeping result sets ("number of rows inserted") become rows affected and DDL/USE "status"
   results become info messages (`SnowflakeResultReader`). DDL in manual mode commits the open transaction (Snowflake
   semantics): the engine forgets its transaction and warns. `USE WAREHOUSE / ROLE / SCHEMA` through
   `POST /snowflake/sessions/{sid}/use`, `USE DATABASE` through the existing `ChangeDatabaseAsync`.
6. **`$1` stays a parameter token** in the UI lexer (WP0's `batch3-foundation.test.ts` pins it); `$1:path` (a staged-file
   column with a path) lexes as an identifier, and the engine binder never treats `$1` / `@stage` / `v:path` as binds. See R3-3.
7. **Plans**: actual mode runs the statement once (its rows stream normally), then reads
   `GET_QUERY_OPERATOR_STATS(<query id>)` on the same session; CostPct = each operator's share of the execution time.

## Measurements

- **Initial load**: 1566.4 KB (WP0) → **1567.4 KB** gzipped, **+1.0 KB** (budget 1.1 KB): the `api/m3/snowflake.ts` request
  wrappers and the lazy-chunk entries (commands auto-load, views) are the only initial-bundle additions (`bundle-size.mjs`: change +115.2 KB of +120 KB). Lazy chunks:
  `snowflake` dialect 13.2 KB gz (functions JSON), views 4.4 KB + 0.9 KB CSS, commands 0.7 KB.
- **Engine publish** (win-x64, self-contained single file, compressed, exact `build.ps1` flags): **76,704,718 bytes**
  with Snowflake vs **70,538,502** with the Snowflake project removed from the Host → **+6.17 MB (5.9 MiB)** for the driver
  and WP-SF (budget 30 MB). WP0 measured 77,430,368 bytes with Snowflake.Data 4.8.0, so 6.4.0 is −0.73 MB.
  osx-arm64 (`build.sh` flags, cross-published): apphost 69.6 MB plus `libMono.Unix.dylib` (166 KB) and
  `libsf_mini_core.dylib` (17 KB) next to it.
- No trimming via `ExcludeAssets`: the AWS / Azure / Google SDKs are only loaded by PUT/GET stage transfers, but removing
  them turns those statements into FileNotFound crashes; at 5.9 MiB there is no need.

## macOS native libraries (Mono.Unix, sf_mini_core)

- Snowflake.Data 6.x ships two natives: **Mono.Unix** (`runtimes/osx-*/native/libMono.Unix.dylib`, used by
  `UnixOperations` to check/set permissions of the driver's config file `sf_client_config.json`, the TOML connections file
  and the file token cache) and **sf_mini_core** (`runtimes/<rid>/native/libsf_mini_core.dylib`, 5.3+ telemetry probe; the
  driver loads it through `SfMiniCore.LoadResult` and carries on when it fails).
- With the macOS publish flags (`IncludeNativeLibrariesForSelfExtract=false`) both land **next to the apphost**, exactly
  like `librdkafka.dylib` and `libe_sqlite3.dylib`; electron-builder copies everything in `engine/publish/osx-${arch}` and
  signs it with the app (hardened runtime). The .NET host probes the app directory, so the DllImports resolve.
- Checked from Windows with a small Mach-O reader (no `otool` here): `libMono.Unix.dylib` arm64 / x86_64, id
  `@rpath/libMono.Unix.dylib`, deps `/usr/lib/libc++.1.dylib`, `/usr/lib/libSystem.B.dylib`; `libsf_mini_core.dylib`
  arm64 / x86_64, deps `/usr/lib/libSystem.B.dylib` only (its install name is a Jenkins build path: harmless, it is loaded
  by file name). No Homebrew/non-system dependencies.
- In normal use Mono.Unix is not even called: the engine uses the in-memory credential manager and passes the connection
  in the connection string (no TOML lookup). The library must still be present (EasyLogging probes a client config file
  if one exists in the home/driver folder). See R3-8 for the CI check.
- win-x64: `sf_mini_core.dll` is bundled into the single file (`IncludeNativeLibrariesForSelfExtract=true`) and extracted
  like SNI; the published engine starts, lists `snowflake` and answers `POST /connections/test` for a bogus account with
  `270001 Snowflake Internal Error: Unable to connect. Check the account identifier…` after the 20 s connect timeout.

## Requests

### R3-1 Core: extra password-typed fields for relational providers
`engine/src/DbStudio.Core/Services/SessionManager.cs:172,379,410`, `Catalog/CatalogService.cs:71,237…258`,
`Designer/DesignerService.cs:39`, `Host/Endpoints/ObjectsEndpoints.cs:39`, `Search/DatabaseSearchService.cs:39`,
`Logs/Sql/SqlRunner.cs:226`.
Reason: only `POST /connections/test` restores `privateKeyPassphrase` / `token` (`ConnectionStore.WithSecrets`); sessions,
catalog, designer, search and logs get the stripped profile, so an encrypted key or an OAuth token fails after saving.
Proposed diff (each call site): `provider.OpenSessionAsync(profile, …)` → `provider.OpenSessionAsync(_connections.WithSecrets(profile), …)`.
Local stub: `SnowflakeSecrets` (`TODO(WPSF-shared)`) looks the secrets up from `ConnectionStore.GetSecret` at call time.

### R3-2 `engine/src/DbStudio.Core/Sql/SqlTokenizer.cs:326-333` — Snowflake Scripting depth in SplitStatements
Reason: inside a scripting block `IF … END IF`, `FOR … END FOR`, `WHILE`, `REPEAT`, `LOOP` and the `DECLARE … BEGIN` pair
must not close the block early (the classifier / read-only guard split `DECLARE … BEGIN … IF … END IF; … END;` wrongly).
The provider's own splitter (`SnowflakeSql.SplitStatements`) already does it; the UI splitter too.
Proposed diff:
```diff
-                if (u is "BEGIN" || (u is "CASE" && !PrevIsEnd(tokens, k)) || (u is "IF" or "LOOP" && dialect == Dialect.PlSql && !PrevIsEnd(tokens, k)))
+                if (u is "BEGIN" || (u is "CASE" && !PrevIsEnd(tokens, k)) || (u is "IF" or "LOOP" && dialect == Dialect.PlSql && !PrevIsEnd(tokens, k))
+                    || (dialect == Dialect.Snowflake && !PrevIsEnd(tokens, k) && (u is "FOR" or "WHILE" or "REPEAT" or "LOOP"
+                        || (u is "IF" && !(k + 1 < tokens.Count && tokens[k + 1].Upper is "EXISTS" or "NOT")))))
                     blockDepth++;
@@
-                    if (k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "IF" or "LOOP" or "CASE")
+                    if (k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "IF" or "LOOP" or "CASE" or "FOR" or "WHILE" or "REPEAT")
```
plus, for `DECLARE … BEGIN`, treat the first BEGIN after a leading DECLARE as the same level (as `SnowflakeSql.SplitStatements` does with its `declares` counter).

### R3-3 `ui/src/intel/__tests__/batch3-foundation.test.ts:51-55` — `$1` is not a Snowflake bind
Reason: `$1` is a staged-file column (`SELECT $1, $2 FROM @stage`); as a `param` token the Parameters dialog asks for a
value. Proposed: expect `'ident:$1'` there, then WP-SF removes `dollarParams: true` from `intel/dialect/snowflake.ts`
(marked `TODO(WPSF-shared)`).

### R3-4 `ui/src/format/layout.ts` — QUALIFY clause and the VARIANT path colon
Reason: `QUALIFY` is a clause like WHERE (own line, conditions broken at AND/OR); `v:a.b` and `v[0]` are written without
spaces. Proposed diff:
```diff
@@ clauseAt (≈ line 1159)
       case 'WHERE': return ['where', 1];
+      case 'QUALIFY': return this.d === 'snowflake' ? ['where', 1] : null;
@@ spaceBefore (≈ line 346)
-    if (this.d === 'pgsql') {
+    if (this.d === 'pgsql' || this.d === 'snowflake') {
       if (b.kind === 'op' && (bt === '[' || bt === ']')) return false;
       if (a.kind === 'op' && (at === '[' || at === ':')) return false;
     }
```
(Snowflake binds `:x` are `param` tokens, so the `:` op rule only hits paths.) Local: `snowflake.test.ts` asserts the tokens
survive formatting and carries a `TODO(WPSF-shared)`.

### R3-5 `ui/src/components/Explorer/*` — provider entries on the relational connection menu
Reason: Warehouses / Objects / Query history / Session belong on the Snowflake connection's context menu. Proposed: a
per-provider extension (`registerContextMenu('explorer.connection.snowflake', …)` merged after the shell entries), as
WP-CH asks for tables. Local: palette commands (`snowflake.*`, enabled when the active tab or target is Snowflake).

### R3-6 `ui/src/codegen/types/index.ts:180` — Snowflake NUMBER(p, 0) as an integer
Proposed: `if (dialect === 'snowflake' && rawBase === 'number' && (scale ?? 0) === 0) base = 'int';` (the `int` row maps
to int64). Today NUMBER(38,0) generates `decimal`.

### R3-7 mocks: Batch 3 dialects and schema names
`ui/src/mocks/engine.ts:25` `DIALECT` lacks the Batch 3 ids (mock sessions of pack connections get `dialect: undefined`):
build it from the providers list (`MOCK_PACKS.flatMap((p) => p.providers)`). `engine.ts:146-165` gives every pack provider
one schema `main` and database `main`: let `MockProviderPack` carry `databases` / `defaultSchema` (Snowflake: `SHOP`,
`PUBLIC`, `ANALYTICS`). `ui/src/mocks/handlers.ts:251`: spread the pack handlers **before** `createLogsHandlers` so a pack
can answer `/logs/{cid}/sources|query` for its provider (Snowflake query_history in dev:mock).

### R3-8 `scripts/ci/kafka-native-smoke.mjs` + `.github/workflows/release.yml` — macOS checks for the Snowflake natives
Reason: like librdkafka, `libMono.Unix.dylib` and `libsf_mini_core.dylib` must sit next to the macOS apphost, match the
arch, link only system libraries and be signed inside Rowlit.app. Proposed: generalise `checkDylib(engineDir, arch)` to
a list `['librdkafka.dylib', 'libMono.Unix.dylib', 'libsf_mini_core.dylib']` (the `otool` foreign-deps filter already
accepts `/usr/lib` and `/System`; add `@rpath/libMono.Unix` to the own-id skip), and run `codesign --verify --strict` on
all three. Add a REST check `POST /connections/test` with `providerId: 'snowflake', props: { account: 'rowlit-smoke-invalid', user: 'X' }, password: 'x', connectTimeout: 10`
expecting `ok:false` with an error code (not `ENGINE_ERROR`), which loads the driver on every platform.

### R3-9 `engine/src/DbStudio.Core/Designer/TableModel.cs` `TableOptions` — Snowflake table options
Proposed additive fields `string? Kind` ("transient"), `int? RetentionDays`, `bool? ChangeTracking` (UI designer: a
Snowflake options strip). Until then the designer cannot create TRANSIENT tables (the console can).

## Known gaps

- No live account was available: every server answer is a recorded/handwritten fixture; the live suite and the
  conformance suite are written but have not run. Refresh the fixtures with `DBSTUDIO_UPDATE_GOLDEN=1` once a trial account
  exists (see `docs/qa/snowflake-walkthrough.md`).
- SHOW COLUMNS IN SCHEMA returns at most 10,000 rows: very wide schemas load partially (no per-table fallback yet).
- Routine overloads collapse to one catalog entry (ObjectRef has no signature); details/DDL show every overload.
- Query history, warehouse load and login history need a warehouse and a current database (INFORMATION_SCHEMA table
  functions); without them the sources are listed unavailable with the fix.
- `externalbrowser` is implemented through the driver (it opens the default browser from the engine process); not
  exercised without an IdP.

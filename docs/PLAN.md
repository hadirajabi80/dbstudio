# DbStudio — Architecture and M1 Implementation Plan

Repo state confirmed: `E:\DbStudio` contains only `.git`. .NET SDK 10.0.303, Node v24.15.0 present.

> **Contract amendments (hour 0, by the integrator).** The code is now the source of truth for the shared contracts:
> `engine/src/DbStudio.Core/Providers/IDbProvider.cs`, `engine/src/DbStudio.Core/Models/*.cs` and `ui/src/api/types.ts`.
> Differences from the text below:
> - `IDbProvider.CreateCatalogReader(session)` → `OpenCatalogReaderAsync(profile, password, ct)`; the reader owns its own
>   short-lived catalog connection and is `IAsyncDisposable` (matches D-1). It also gained `GetCurrentDatabaseAsync`,
>   `GetDefaultSchemaAsync`, `GetObjectDetailsAsync`, `ResolvePublicSynonymAsync`; `GetDdlAsync` returns `DdlResult`.
> - `IDbSession.ExecuteAsync` returns `ExecutionSummary`; `IExecutionSink.BatchEnded` carries a `BatchStatus`.
> - `ISqlDiagnostics.AnalyzeAsync(sql, profile?, password?, ct)` returns 1-based absolute `SqlDiagnostic`s.
> - Solution file is `engine/DbStudio.slnx` (new XML format). `TreatWarningsAsErrors` is off.
> - UI pins **React 18.3.1** (glide-data-grid 6.0.3 peers `react <= 18`).
> - WS adds `exec.diagnostics` (Oracle `ALL_ERRORS` after CREATE, mapped to document lines); `exec.done` carries `sessionId`.
> - `ExecuteRequest.confirmedDestructive` (engine rejects non-queries on read-only connections with `READ_ONLY`).
> - `Settings.editor` adds `qualifyObjects`, `qualifyColumns`; `Settings.ui` is a free-form bag (MRU usage etc.).
> - `HistoryEntry.pinned`; `PUT /history/{id}` with `{ "pinned": bool }`.

Stack validation (brief): no blockers. Two things to verify in the first hour of WP-A/WP-B and treat as risks (section 7): (a) `Oracle.ManagedDataAccess.Core` 23.x targets net8.0; it runs on .NET 10 via roll-forward but confirm with a smoke connect; (b) `Microsoft.Data.SqlClient` needs the native SNI dll on Windows, so single-file publish must set `IncludeNativeLibrariesForSelfExtract=true`. `@glideapps/glide-data-grid` is the right grid choice (canvas, 1M+ rows, column resize/reorder, MIT); its alternatives (AG Grid Community lacks row grouping/clipboard ranges; TanStack is DOM-virtualized and stalls on 100+ columns) are worse for this use.

---

## 1. Architecture overview

Three processes. The UI never touches a database driver; the engine never touches the DOM. The UI is identical in Electron and in a plain browser; only the `platform` adapter differs.

```
+-----------------------------------------------------------------------------------+
| Electron main (desktop/)                                                          |
|  - spawns engine sidecar: DbStudio.Engine.exe --parent-pid <pid>                  |
|  - reads one stdout line:  DBSTUDIO_READY {"port":51234,"token":"<32B base64url>"}|
|  - registers dbstudio:// scheme -> serves ui/dist (origin dbstudio://app)         |
|  - preload exposes window.dbstudio { getEngineInfo(), showSaveDialog(), ... }     |
+------------------+--------------------------------------------------+-------------+
                   | IPC (contextBridge)                              | stdin/stdout, kill on exit
                   v                                                  v
+-----------------------------------+        +-------------------------------------------------+
| Renderer: React + TS + Vite (ui/) |  HTTP  | .NET 10 engine (engine/)                        |
|  Zustand stores                   |<------>| ASP.NET Core minimal API on 127.0.0.1:<random>  |
|  Monaco editor                    |  REST  |  Authorization: Bearer <token> on every request |
|  sql-intel (TS completion engine, |        |                                                 |
|    runs in renderer over cached   |  WS    |  SessionManager  -> one DbConnection per tab    |
|    CatalogSnapshot)               |<------>|  CatalogService  -> per-connection cache        |
|  glide-data-grid results          | events |  ExecutionService-> streams rows over WS        |
|  platform/ adapter:               |        |  Providers: Sqlite | SqlServer | Oracle         |
|    electron | browser             |        |  TSql diagnostics (ScriptDom)                   |
+-----------------------------------+        |  SecretStore (DPAPI), History (SQLite), Settings|
                                             +----------------+--------------------------------+
                                                              | ADO.NET drivers
                                                              v
                                              SQL Server      Oracle          SQLite file
```

Data flow for "Ctrl+Enter":
1. Renderer: `intel.statementAt(doc, cursor)` returns the statement text + range (UI-side splitting; the UI is the single source of truth for statement/batch boundaries).
2. `POST /api/v1/sessions/{sid}/execute { batches:[{sql,line,col}] }` → `202 {executionId}`.
3. Engine runs on the tab's dedicated connection; `IExecutionSink` pushes `exec.*` events over the single WS connection (batched rows, 200 rows or 256 KB per frame, flush ≥ every 50 ms).
4. Renderer `results` store appends rows per result set; grid renders incrementally. Messages pane receives `exec.message`.
5. If a batch was DDL, engine invalidates the catalog schema and pushes `catalog.changed`; UI refetches that schema and hands it to sql-intel.

Dev mode (no Electron): `dotnet run --project engine/src/DbStudio.Host -- --dev --port 5121 --token dev-token` and `vite` on 5173. `--dev` enables CORS for `http://localhost:5173` and accepts the fixed token; UI reads `VITE_ENGINE_URL`/`VITE_ENGINE_TOKEN`. Without `--dev` the engine only allows origin `dbstudio://app` and the random token. The token is sent as `Authorization` header for REST and as the first WS message (`{"type":"auth","token":...}`), never in a URL.

---

## 2. Engine design

### 2.1 Solution layout
```
engine/
  DbStudio.sln
  Directory.Build.props            (net10.0, nullable, implicit usings, TreatWarningsAsErrors)
  src/DbStudio.Core/               WP-A  abstractions, models, services (no ASP.NET refs)
    Providers/  IDbProvider.cs IDbSession.cs IExecutionSink.cs ICatalogReader.cs IDdlGenerator.cs
    Models/     ConnectionProfile.cs CatalogModels.cs ExecutionModels.cs
    Services/   SessionManager.cs ExecutionService.cs CatalogService.cs HistoryService.cs
                SettingsService.cs ISecretStore.cs DpapiSecretStore.cs StatementClassifier.cs
  src/DbStudio.Providers.Sqlite/   WP-A
  src/DbStudio.Providers.SqlServer/WP-B  (+ TSql/ScriptDomDiagnostics.cs, TSql/BatchSplitter.cs)
  src/DbStudio.Providers.Oracle/   WP-B
  src/DbStudio.Host/               WP-A  Program.cs, Endpoints/*.cs, Ws/WsHub.cs, Contracts/*.cs (DTOs = section 3)
  tests/DbStudio.Core.Tests/
  tests/DbStudio.Providers.Conformance/   abstract ProviderConformanceTests<T> reused by all three
  tests/DbStudio.Providers.Sqlite.Tests/
  tests/DbStudio.Providers.SqlServer.Tests/ (Testcontainers.MsSql, skipped if Docker absent)
  tests/DbStudio.Providers.Oracle.Tests/    (Testcontainers.Oracle, gvenzl/oracle-free:23-slim)
```
Providers are registered via DI (`services.AddDbProvider<SqliteProvider>()`); `DbStudio.Host` references all three. No plugin loading in M1.

### 2.2 Provider abstraction (WP-A writes these verbatim first; WP-B codes against them)

```csharp
public enum Dialect { TSql, PlSql, Sqlite }

public interface IDbProvider
{
    string Id { get; }                       // "sqlserver" | "oracle" | "sqlite"
    string DisplayName { get; }
    Dialect Dialect { get; }
    ConnectionFormSpec FormSpec { get; }     // drives the generic connection dialog
    string BuildConnectionString(ConnectionProfile profile, string? password);
    Task<TestConnectionResult> TestAsync(ConnectionProfile p, string? password, CancellationToken ct);
    Task<IDbSession> OpenSessionAsync(ConnectionProfile p, string? password, SessionOptions o, CancellationToken ct);
    ICatalogReader CreateCatalogReader(IDbSession session);
    IDdlGenerator DdlGenerator { get; }
    ISqlDiagnostics? Diagnostics { get; }    // ScriptDom for SqlServer; null for Oracle; SqlitePrepareDiagnostics for SQLite
    IdentifierRules Identifiers { get; }     // quote chars, case folding (Oracle upper, others preserve), reserved words
}

public interface IDbSession : IAsyncDisposable
{
    string SessionId { get; }
    string ConnectionId { get; }
    SessionState State { get; }              // Idle | Executing | Broken | Closed
    TransactionMode TxMode { get; }          // Auto | Manual
    bool TxOpen { get; }
    string? CurrentDatabase { get; }         // SQL Server: DB_NAME(); Oracle: current schema; SQLite: "main"
    ServerInfo Server { get; }               // version string, edition, serverName, user
    Task SetTransactionModeAsync(TransactionMode m, CancellationToken ct);  // Auto->Manual: no-op until first stmt; Manual->Auto: requires TxOpen==false (409 otherwise)
    Task CommitAsync(CancellationToken ct);
    Task RollbackAsync(CancellationToken ct);
    Task ChangeDatabaseAsync(string db, CancellationToken ct);  // SQL Server: USE; Oracle: ALTER SESSION SET CURRENT_SCHEMA; SQLite: NotSupported
    Task ExecuteAsync(ExecuteRequest req, IExecutionSink sink, CancellationToken ct);  // throws InvalidOperationException if State != Idle
    void Cancel();                           // DbCommand.Cancel() on the in-flight command, thread-safe
    Task<bool> PingAsync(CancellationToken ct);
}

public sealed record ExecuteRequest(IReadOnlyList<SqlBatch> Batches, int MaxRows, bool StopOnError, bool CaptureServerOutput, string Label);
public sealed record SqlBatch(string Sql, int Line, int Col);

public interface IExecutionSink   // all methods return ValueTask; implementation forwards to WS
{
    ValueTask BatchStarted(int batchIndex);
    ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns);
    ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows);   // already converted to wire values
    ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs);
    ValueTask RowsAffected(int batchIndex, long count, string? statementKind);
    ValueTask Message(int batchIndex, MessageSeverity sev, string text, int? line, int? code, MessageSource src);
    ValueTask Error(int batchIndex, ErrorInfo error);                 // code, message, line, col, state, detail
    ValueTask BatchEnded(int batchIndex, long elapsedMs);
}

public interface ICatalogReader
{
    Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct);
    Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct);
    Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct); // all objects+columns+keys+params in one go
    Task<string> GetDdlAsync(ObjectRef obj, CancellationToken ct);
    Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct); // Oracle only; others empty
    IReadOnlyList<string> DefaultSchemas(ConnectionProfile p, ServerInfo s);   // what to load eagerly
}
```

`IDdlGenerator.GenerateTableDdl(TableInfo)` builds CREATE TABLE from the catalog model (used for SQL Server tables, which have no stored definition); Oracle uses `DBMS_METADATA.GET_DDL`; SQLite returns `sqlite_master.sql`.

### 2.3 Sessions, transactions, cancellation
- `SessionManager` holds `ConcurrentDictionary<string, IDbSession>`. One session == one physical `DbConnection`, opened with pooling disabled (`Pooling=false` for SqlClient/ODP) so that session state (`SET` options, temp tables, `ALTER SESSION`, DBMS_OUTPUT buffer) is owned by the tab. Each editor tab creates a session on first run (lazy) and closes it on tab close. Idle sessions are pinged every 60 s; a broken session is reported via `session.changed{state:"broken"}` and reopened transparently on the next execute if no transaction was open (otherwise the user is told the transaction was lost).
- Object explorer / catalog loading uses a separate, short-lived "catalog" connection per connection profile (pooled), never the tab session, so catalog refreshes never block or get blocked by a running query.
- Transactions: `TxMode.Auto` = driver autocommit. `TxMode.Manual` = engine calls `BeginTransaction()` before the first statement after mode switch or after the last commit/rollback; every command gets `cmd.Transaction = tx`. Commit/Rollback endpoints; `session.changed{txOpen}` after every execute so the toolbar shows the pending-transaction badge. Oracle is always in an implicit transaction; in Auto mode the Oracle session executes DML then calls `COMMIT` after each successful batch (DDL autocommits anyway). SQLite Manual mode uses `BEGIN`/`COMMIT` via `SqliteTransaction`. Closing a session with `TxOpen` rolls back (and the UI warns before closing the tab).
- Execution runs on a dedicated `Task.Run` per session (Microsoft.Data.Sqlite is synchronous under the hood). `Cancel()` calls `DbCommand.Cancel()` on the in-flight command: SqlClient sends Attention; ODP.NET `OracleCommand.Cancel()` works for the managed driver; Microsoft.Data.Sqlite `SqliteCommand.Cancel()` maps to `sqlite3_interrupt`. The `CancellationToken` is also passed to `ExecuteReaderAsync`/`ReadAsync`. After cancel, engine emits `exec.done{status:"cancelled"}` and, in Manual mode, leaves the transaction as-is (user decides). In Auto mode on SQL Server a cancelled batch is rolled back by the server.
- Statement timeout: `CommandTimeout = 0` (infinite) by default; configurable per connection.

### 2.4 Result sets and streaming
- For each batch: `ExecuteReader(CommandBehavior.SequentialAccess)` is NOT used (random column access needed); default behavior. Loop `do { ResultSetStarted; while Read && count < MaxRows → buffer rows; if count == MaxRows → truncated = true; ResultSetEnded } while NextResult()`. When truncated, the engine drains remaining rows via `NextResult()` (SQL Server must read them off the wire); if the truncated set is the last one in the batch, the engine calls `Cancel()` instead to stop the server quickly, then swallows the resulting cancellation error. MaxRows default 10,000; UI exposes 500/1k/10k/100k/unlimited.
- Row wire values (`ValueConverter`): `null`→null; bool→bool; int8..int32→number; int64→number if |v| ≤ 2^53 else string; float/double→number (NaN/Inf→string); decimal/numeric/Oracle NUMBER→string (precision preserved); DateTime→`"2026-10-14T10:00:00.1234567"` (no zone), DateOnly→`"2026-10-14"`, TimeOnly/TimeSpan→`"10:00:00.1234567"`, DateTimeOffset→ISO with offset; Guid→string; byte[]→`{"$bin":"<base64 first 8KB>","len":N}`; strings > 32 KB→`{"$trunc":"<first 32KB>","len":N}`; XML/JSON/CLOB→string (same truncation); Oracle REF CURSOR column→`{"$cursor":true}` (M1: not expanded); SQL Server `sql_variant`, `hierarchyid`, geography→`.ToString()`. `ColumnInfo.kind` tells the grid how to format/align.
- Engine keeps the full (capped) rows of the **latest** execution per session in a `ResultStore` for `GET .../cell` (full value fetch) and for re-export without re-running; replaced on next execute, freed on session close. Memory cap 256 MB total, LRU evicts oldest stores. Unlimited export runs a fresh streaming execution straight to file (`POST /export`).
- `SqlBatch` for T-SQL = everything between `GO` separators, executed as one `SqlCommand` so variables/temp tables scope correctly; per-statement rows-affected come from `SqlCommand.StatementCompleted` (`RecordCount`). For Oracle/SQLite each batch is one statement.

### 2.5 Provider specifics
**SQL Server** (`Microsoft.Data.SqlClient`): `conn.InfoMessage` → `Message(info)` for PRINT/RAISERROR(sev<11), with `e.Errors[i].LineNumber`; `conn.FireInfoMessageEventOnUserErrors = true` so severity ≥ 11 errors inside a batch arrive as messages and the batch continues like SSMS; `SqlException.Number/LineNumber/State/Class` → `ErrorInfo`; `Line` is relative to the batch, engine adds `batch.Line - 1`. `SET NOCOUNT` honored naturally. `StatementCompleted` → `RowsAffected`. `ChangeDatabase` via `USE [db]` then `DB_NAME()` verify. Connection form: server (`host\instance` or `host,port`), auth = `sql` | `windows` (Integrated Security) | `entra-interactive` (M2), database, `Encrypt` = Mandatory/Optional/Strict, `TrustServerCertificate`, `ApplicationName="DbStudio"`, connect timeout, `MultipleActiveResultSets=false`, `Pooling=false`. ScriptDom: `TSql160Parser(initialQuotedIdentifiers:true)` (try `TSql170Parser` via reflection first).

**Oracle** (`Oracle.ManagedDataAccess.Core`): on open, if `CaptureServerOutput`: `BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`. After every batch: fetch output with one call to `DBMS_OUTPUT.GET_LINES(:lines, :numlines)` using `OracleCollectionType.PLSQLAssociativeArray` (Varchar2, size 1000, element size 32767) in a loop until `numlines < 1000`; each line → `Message(info, src: DbmsOutput)`. Implicit result sets (`DBMS_SQL.RETURN_RESULT`, 12c+) and `SELECT` both surface through `ExecuteReader`/`NextResult` natively. REF CURSOR from a function call: M1 does not prompt for binds; if a statement contains `:name` binds, engine returns error code `BIND_VARS_UNSUPPORTED` with the list of names (M2 adds a bind dialog with REF CURSOR output → extra result set). `OracleException.Number` 24344 ("success with compilation error") after `CREATE ... PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE/VIEW` → engine queries `ALL_ERRORS WHERE OWNER=:o AND NAME=:n AND TYPE=:t ORDER BY SEQUENCE` and emits each as `Message(error, line, col)` plus a diagnostic set that the UI maps into Monaco markers (offset by the CREATE statement's position). `conn.InfoMessage` also forwarded. Errors: ODP.NET does not give an offset; for `ORA-00904/00942` style errors the engine runs a cheap regex to extract the quoted identifier and the UI highlights its first occurrence in the statement. Connection form: connection type = `basic` (host, port 1521, service name | SID) | `tns alias` | `descriptor`; user, password, role Normal/SYSDBA/SYSOPER; `extraSchemas[]` to load eagerly; `Pooling=false`; `StatementCacheSize=0`. Set `OracleConfiguration.FetchSize` to 1 MB for throughput. `ALTER SESSION SET NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'` on open (configurable). `BindByName = true` always.

**SQLite** (`Microsoft.Data.Sqlite`): file path + `Mode=ReadOnly` flag + `Foreign Keys=true` default; `PRAGMA journal_mode` untouched. No messages exist, so engine emits `RowsAffected` from `ExecuteNonQuery`/`reader.RecordsAffected` and `changes()`. `SqliteException.SqliteErrorCode/SqliteExtendedErrorCode`. Diagnostics: `SqlitePrepareDiagnostics` uses a separate read-only connection and `cmd.Prepare()`; `Prepare` compiles without executing and reports `near "X": syntax error` and `no such table: Y` → markers (no line info from SQLite; the engine binary-searches by preparing prefixes of each statement to find the failing statement, then the UI places the marker on that statement; the TS soft parser gives finer positions).

### 2.6 Catalog queries (exact system views)

**SQL Server** (all run in the target database; `schemas` filter `s.name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND s.principal_id NOT IN (SELECT principal_id FROM sys.database_principals WHERE type='R')` to hide `db_owner` etc.):
- databases: `SELECT name FROM sys.databases WHERE state_desc='ONLINE' AND HAS_DBACCESS(name)=1 ORDER BY name`
- schemas: `SELECT s.schema_id, s.name FROM sys.schemas s` (+ filter above)
- objects: `SELECT o.object_id, o.name, o.type, o.modify_date, ep.value AS comment FROM sys.objects o LEFT JOIN sys.extended_properties ep ON ep.major_id=o.object_id AND ep.minor_id=0 AND ep.name='MS_Description' WHERE o.schema_id=@sid AND o.type IN ('U','V','P','PC','FN','IF','TF','FS','FT','SN','SO','TT','TR') AND o.is_ms_shipped=0`
- columns: `SELECT c.object_id, c.column_id, c.name, t.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed, dc.definition AS default_def, ep.value AS comment FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id LEFT JOIN sys.extended_properties ep ON ep.major_id=c.object_id AND ep.minor_id=c.column_id AND ep.name='MS_Description' WHERE c.object_id IN (SELECT object_id FROM sys.objects WHERE schema_id=@sid)` (type text rendered engine-side: `nvarchar(50)`, `decimal(18,2)`, `varchar(max)`)
- PK/unique: `SELECT kc.parent_object_id, kc.name, kc.type, ic.column_id, ic.key_ordinal FROM sys.key_constraints kc JOIN sys.index_columns ic ON ic.object_id=kc.parent_object_id AND ic.index_id=kc.unique_index_id WHERE kc.schema_id=@sid`
- indexes (explorer only): `sys.indexes` + `sys.index_columns` where `index_id>0`
- FKs: `SELECT fk.object_id, fk.name, fk.parent_object_id, fk.referenced_object_id, fkc.constraint_column_id, fkc.parent_column_id, fkc.referenced_column_id FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id WHERE fk.schema_id=@sid OR fk.referenced_object_id IN (SELECT object_id FROM sys.objects WHERE schema_id=@sid)` (both directions so the JOIN completer sees incoming FKs; referenced object names resolved via `sys.objects`+`sys.schemas`)
- parameters: `SELECT p.object_id, p.parameter_id, p.name, t.name AS type_name, p.max_length, p.precision, p.scale, p.is_output, p.has_default_value, p.default_value FROM sys.parameters p JOIN sys.types t ON t.user_type_id=p.user_type_id WHERE p.object_id IN (...)` (parameter_id 0 = return value of scalar functions); table-valued function result columns come from `sys.columns` on the function's object_id.
- synonyms: `SELECT name, base_object_name FROM sys.synonyms WHERE schema_id=@sid` (parsed into db/schema/name engine-side)
- sequences: `sys.sequences`; user types: `sys.types WHERE is_user_defined=1`; table types columns via `sys.table_types`.
- DDL: `SELECT definition FROM sys.sql_modules WHERE object_id=@id` (views/procs/functions/triggers); tables generated by `IDdlGenerator` from columns + keys + FKs + indexes + defaults + identity.
- Cross-database: snapshots are per database; the UI asks for `database=X` and the engine runs the queries with `USE [X]` on the catalog connection.

**Oracle** (always bind `:owner`; never query `ALL_CONS_COLUMNS`/`ALL_TAB_COLUMNS` without an OWNER predicate):
- schemas: `SELECT username FROM all_users WHERE oracle_maintained='N' ORDER BY username` (fallback when `ORACLE_MAINTAINED` is missing, 11g: exclude a hard-coded list `SYS, SYSTEM, XDB, OUTLN, DBSNMP, APPQOSSYS, ... `). Default schema = `SYS_CONTEXT('USERENV','CURRENT_SCHEMA')`; plus `extraSchemas` from the profile.
- objects: `SELECT object_name, object_type, object_id, status, last_ddl_time FROM all_objects WHERE owner=:owner AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','PROCEDURE','FUNCTION','PACKAGE','SEQUENCE','SYNONYM','TYPE','TRIGGER') AND object_name NOT LIKE 'BIN$%' AND (object_type<>'TABLE' OR object_name NOT IN (SELECT mview_name FROM all_mviews WHERE owner=:owner))` (secondary objects/`IOT_OVERFLOW` excluded via `generated='N'` where available)
- table comments: `all_tab_comments WHERE owner=:owner`; column comments: `all_col_comments WHERE owner=:owner`
- columns: `SELECT table_name, column_id, column_name, data_type, data_type_owner, data_length, char_length, char_used, data_precision, data_scale, nullable, virtual_column, identity_column, hidden_column FROM all_tab_cols WHERE owner=:owner AND hidden_column='NO' ORDER BY table_name, column_id` (`all_tab_cols` instead of `all_tab_columns` to get `virtual_column`/`identity_column`; `DATA_DEFAULT` is a LONG — fetched lazily per table in the details endpoint using `all_tab_columns` with `LONG` read via `OracleDataReader.GetString`, not in the bulk query)
- constraints: `SELECT c.constraint_name, c.constraint_type, c.table_name, c.r_owner, c.r_constraint_name, c.status, cc.column_name, cc.position FROM all_constraints c JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=cc.constraint_name AND cc.table_name=c.table_name WHERE c.owner=:owner AND c.constraint_type IN ('P','U','R')` ; referenced PK columns: second query `all_cons_columns WHERE owner=r_owner AND constraint_name IN (...)` batched with `IN` lists of 1000.
- indexes (explorer): `all_indexes` + `all_ind_columns WHERE index_owner=:owner`
- routines and package members: `SELECT object_name, procedure_name, subprogram_id, overload, object_type FROM all_procedures WHERE owner=:owner AND object_type IN ('PROCEDURE','FUNCTION','PACKAGE') AND (object_type<>'PACKAGE' OR procedure_name IS NOT NULL)`
- arguments: `SELECT package_name, object_name, subprogram_id, overload, argument_name, position, sequence, data_type, type_owner, type_name, in_out, defaulted, data_level FROM all_arguments WHERE owner=:owner AND data_level=0 ORDER BY package_name, subprogram_id, overload, sequence` (position 0 = return value)
- synonyms: private: `SELECT synonym_name, table_owner, table_name, db_link FROM all_synonyms WHERE owner=:owner`; PUBLIC: loaded lazily and filtered to resolvable targets: `SELECT s.synonym_name, s.table_owner, s.table_name FROM all_synonyms s WHERE s.owner='PUBLIC' AND s.table_owner IN (<loaded schemas>)` plus, on demand when the completer sees an unknown identifier `X`, `... AND s.synonym_name=:x`. The ~30 well-known `DBMS_*`/`UTL_*` packages come from `all_arguments WHERE owner='SYS' AND package_name IN (...)` as a separate lazily loaded pseudo-schema `SYS(packages)`.
- sequences: `all_sequences WHERE sequence_owner=:owner`
- DDL: `SELECT DBMS_METADATA.GET_DDL(:type,:name,:owner) FROM dual` after `DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'SQLTERMINATOR',TRUE)`, `'PRETTY',TRUE`, `'SEGMENT_ATTRIBUTES',FALSE`, `'STORAGE',FALSE`; package/procedure source alternative via `all_source WHERE owner=:o AND name=:n AND type=:t ORDER BY line` (used when GET_DDL lacks privilege, ORA-31603).
- compile errors: `all_errors WHERE owner=:o AND name=:n AND type=:t ORDER BY sequence`.

**SQLite**:
- databases (attached): `PRAGMA database_list` → `main`, `temp`, attached names.
- objects: `SELECT type, name, tbl_name, sql FROM "<db>".sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name` (types: table, view, index, trigger); `WITHOUT ROWID`/`STRICT` parsed from `sql`.
- columns for all tables in one query: `SELECT m.name AS table_name, p.cid, p.name, p.type, p."notnull", p.dflt_value, p.pk, p.hidden FROM "<db>".sqlite_master m JOIN pragma_table_xinfo(m.name, '<db>') p WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'` (`hidden`: 1 = hidden virtual-table column, 2/3 = generated column)
- FKs: `SELECT m.name AS table_name, f.id, f.seq, f."table" AS ref_table, f."from", f."to", f.on_update, f.on_delete FROM "<db>".sqlite_master m JOIN pragma_foreign_key_list(m.name, '<db>') f WHERE m.type='table'`
- indexes: `pragma_index_list(m.name)` + `pragma_index_xinfo(idx)`
- functions (for completion, merged with the static list): `SELECT DISTINCT name, narg, type FROM pragma_function_list` (3.30+; ignore failure); collations `pragma_collation_list`; modules `pragma_module_list`.
- DDL: `sqlite_master.sql`.

### 2.7 Metadata cache and invalidation
- `CatalogService` keeps `CatalogCache[connectionId][database]` = `{ version:int, schemas: Dictionary<string, SchemaCatalog?> }` (null = known but not loaded). Loading a schema is one `LoadSchemaAsync` call (the 4–8 queries above run sequentially on the catalog connection; Oracle ones in parallel over 2 connections is M2).
- Eager load on first `GET /catalog`: default schema(s) only; other schemas on demand (`?schemas=`), triggered by the UI when the user expands an explorer node or types `schema.` in the editor.
- Invalidation: `StatementClassifier` (regex over the first tokens, dialect aware) tags each batch `DDL(objectType, schema?, name?)`. After a batch tagged DDL completes successfully, engine marks the affected schema (or default schema when unqualified; whole database for `CREATE SCHEMA`/`DROP SCHEMA`/`USE` rename cases) stale, reloads it in the background, bumps `version`, and pushes `catalog.changed{schemas:[...]}`. Manual `POST .../catalog/refresh` reloads everything loaded. No TTL in M1; a 15-minute background revalidation using `sys.objects.modify_date` / `all_objects.last_ddl_time` max per schema is M2.
- Snapshot JSON is cached as a pre-serialized `byte[]` per schema and ETag'd (`version`); the UI sends `If-None-Match` to skip unchanged schemas.

### 2.8 Secure storage of saved connections (Windows)
- Files in `%APPDATA%\DbStudio\`: `connections.json` (profiles without secrets), `secrets.dat` (JSON map `profileId → base64(DPAPI blob)`), `settings.json`, `history.db` (SQLite with FTS5), `logs\engine-*.log` (Serilog rolling).
- `DpapiSecretStore` uses `System.Security.Cryptography.ProtectedData.Protect(plaintext, entropy, DataProtectionScope.CurrentUser)` (NuGet `System.Security.Cryptography.ProtectedData`) with a fixed 16-byte app entropy constant plus the profile id bytes; this ties secrets to the Windows user account and prevents copying `secrets.dat` to another profile. `ISecretStore` abstraction keeps the door open for Credential Manager / cross-platform. Secrets never leave the engine: `GET /connections` returns `hasPassword:true`, never the value; `PUT` with `password:null` keeps the stored one, `""` clears it, `"savePassword":false` keeps it only in memory for the engine's lifetime.
- File writes are atomic (write temp + `File.Move(overwrite:true)`).

---

## 3. HTTP/WebSocket API contract (`/api/v1`, JSON, camelCase, `Authorization: Bearer <token>`)

> **M1.5 additions** (filters, history filters, query parameters, describe, explain plan with `exec.plan`, sample
> database, designer endpoints, `SESSION_LIMIT` / `DDL_FAILED`, new settings keys) are specified in
> `docs/PLAN-M1.5.md` sections 3.7–3.9; the wire types are the `// ---------- M1.5 ----------` block of
> `ui/src/api/types.ts`. Everything there is additive to this section.

Errors: non-2xx → `{ "error": { "code": "SESSION_BUSY", "message": "...", "detail": {...} } }`. Codes: `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION`, `SESSION_BUSY`, `SESSION_BROKEN`, `TX_OPEN`, `PROVIDER_ERROR`, `BIND_VARS_UNSUPPORTED`, `NOT_SUPPORTED`.

### 3.1 Meta
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | – | `{ "status":"ok", "version":"0.1.0", "pid":1234, "dev":false }` |
| GET | `/providers` | – | `[ { "id":"sqlserver", "displayName":"Microsoft SQL Server", "dialect":"tsql", "formSpec": { "fields":[ {"key":"server","label":"Server","type":"text","required":true,"placeholder":"localhost\\SQLEXPRESS or host,1433"}, {"key":"auth","type":"select","options":[{"value":"sql","label":"SQL Login"},{"value":"windows","label":"Windows Authentication"}],"default":"sql"}, {"key":"user","type":"text","visibleWhen":{"auth":"sql"}}, {"key":"password","type":"password","visibleWhen":{"auth":"sql"}}, {"key":"database","type":"text"}, {"key":"encrypt","type":"select","options":[...],"default":"optional"}, {"key":"trustServerCertificate","type":"bool","default":true}, {"key":"connectTimeout","type":"number","default":15} ] } }, ... ]` (Oracle keys: `connectionType` basic/tns/descriptor, `host`, `port`, `serviceName`, `sid`, `tnsAlias`, `descriptor`, `user`, `password`, `role`, `extraSchemas` (type `list`); SQLite keys: `path` (type `file`, filter `*.db;*.sqlite;*.sqlite3`), `readOnly`, `createIfMissing`) |
| GET | `/settings` | – | `{ "theme":"dark", "editor":{"fontSize":14,"keywordCase":"upper","identifierCase":"asIs","tabSize":4,"blankLineSplitsStatements":true}, "results":{"maxRows":10000,"nullText":"NULL","dateFormat":"iso"}, "confirmDestructive":true }` |
| PUT | `/settings` | same object (partial merge) | updated object |

### 3.2 Connections
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/connections` | – | `[ ConnectionProfile ]` where `ConnectionProfile = { "id":"c_01J...", "name":"Prod SQL", "providerId":"sqlserver", "color":"#d33"|null, "folder":"Work"|null, "readOnly":false, "props":{ "server":"...", "auth":"sql", "user":"sa", "database":"AdventureWorks", ... }, "hasPassword":true, "savePassword":true, "createdAt":"...", "lastUsedAt":"..." }` |
| POST | `/connections` | `ConnectionProfile` without id/hasPassword + `"password":"..."` | `ConnectionProfile` |
| PUT | `/connections/{id}` | same; `password` null = keep | `ConnectionProfile` |
| DELETE | `/connections/{id}` | – | 204 |
| POST | `/connections/test` | `{ "profile": ConnectionProfile(no id ok), "password":"..."|null, "useStoredPassword":true }` | `{ "ok":true, "serverInfo":{ "version":"Microsoft SQL Server 2022 (RTM) ...", "productVersion":"16.0.1000", "serverName":"HOST", "user":"sa", "database":"master" }, "elapsedMs":120 }` or `{ "ok":false, "error":{ "code":"PROVIDER_ERROR", "message":"Login failed for user 'sa'.", "providerCode":18456 } }` |

### 3.3 Catalog
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/connections/{id}/catalog/databases` | – | `{ "databases":["master","AdventureWorks"], "current":"AdventureWorks" }` (SQLite: attached dbs; Oracle: `[]` with `current` = current schema) |
| GET | `/connections/{id}/catalog/schemas?database=` | – | `{ "database":"AdventureWorks", "defaultSchema":"dbo", "schemas":[ {"name":"dbo","loaded":true,"objectCount":120}, {"name":"Sales","loaded":false} ] }` |
| GET | `/connections/{id}/catalog?database=&schemas=dbo,Sales` | header `If-None-Match` | `CatalogSnapshot` (304 if unchanged): `{ "connectionId":"c_..", "dialect":"tsql", "database":"AdventureWorks", "defaultSchema":"dbo", "version":12, "databases":["master",...], "schemas":[ { "name":"dbo", "version":12, "objects":[ CatalogObject ] } ] }` `CatalogObject = { "t":"table"|"view"|"mview"|"proc"|"func"|"tablefunc"|"synonym"|"sequence"|"package"|"type"|"trigger", "n":"Customers", "cm":"comment"|null, "c":[ ["Id","int",0,1,1,null], ["Name","nvarchar(100)",1,0,0,"Display name"] ],  /* [name, typeText, nullable, isPk, flags(1=identity/autoinc,2=computed/virtual,4=hidden), comment] */ "pk":["Id"], "fk":[ {"n":"FK_Orders_Customers","cols":["CustomerId"],"rs":"dbo","rt":"Customers","rcols":["Id"]} ], "p":[ ["@CustomerId","int","in",0], ["","int","return",0] ],  /* params: [name,type,in|out|inout|return,hasDefault] */ "target":{"s":"dbo","n":"Customers","t":"table"} /* synonyms */, "members":[ {"n":"GET_CUSTOMER","k":"func","ov":1,"p":[...]} ] /* packages */ }` |
| GET | `/connections/{id}/catalog/object?database=&schema=&name=&type=` | – | `{ "ref":{...}, "columns":[ {"name","type","nullable","default","isPk","isIdentity","isComputed","comment","ordinal"} ], "indexes":[ {"name","unique","columns":[...],"type"} ], "foreignKeys":[...], "referencedBy":[ {"schema","table","constraint","columns"} ], "triggers":[...], "parameters":[...], "rowCountEstimate":12345|null, "created":"...","modified":"..." }` |
| GET | `/connections/{id}/catalog/ddl?database=&schema=&name=&type=` | – | `{ "ddl":"CREATE TABLE ...", "source":"generated"|"stored" }` |
| GET | `/connections/{id}/catalog/errors?schema=&name=&type=` | – | `[ {"line":3,"col":5,"message":"PLS-00201: ...","severity":"error"} ]` |
| POST | `/connections/{id}/catalog/refresh` | `{ "database":"...", "schemas":["dbo"]|null }` | `{ "version":13 }` (also pushes `catalog.changed`) |

### 3.4 Sessions and execution
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/sessions` | `{ "connectionId":"c_..", "database":"AdventureWorks"|null, "txMode":"auto", "captureServerOutput":true }` | `{ "sessionId":"s_01J..", "connectionId":"c_..", "serverInfo":{...}, "database":"AdventureWorks", "txMode":"auto", "txOpen":false, "state":"idle", "dialect":"tsql" }` |
| GET | `/sessions` | – | `[ SessionInfo ]` |
| DELETE | `/sessions/{sid}?force=true` | – | 204 (409 `TX_OPEN` unless force; force rolls back) |
| POST | `/sessions/{sid}/database` | `{ "database":"master" }` | `SessionInfo` |
| POST | `/sessions/{sid}/tx-mode` | `{ "txMode":"manual" }` | `SessionInfo` (409 `TX_OPEN` when switching to auto with open tx) |
| POST | `/sessions/{sid}/commit` | – | `SessionInfo` |
| POST | `/sessions/{sid}/rollback` | – | `SessionInfo` |
| POST | `/sessions/{sid}/execute` | `{ "batches":[ {"sql":"SELECT 1","line":1,"col":1} ], "maxRows":10000, "stopOnError":true, "label":"statement"|"selection"|"script", "source":{"tabId":"t1","title":"query1.sql"} }` | `202 { "executionId":"x_01J..", "startedAt":"..." }` (409 `SESSION_BUSY`) |
| POST | `/sessions/{sid}/cancel` | – | `{ "cancelled":true }` |
| GET | `/executions/{xid}/resultsets/{rs}/rows?offset=0&limit=1000` | – | `{ "columns":[ColumnInfo], "rows":[[...]], "total":5000, "truncated":false }` (replay after UI reload) |
| GET | `/executions/{xid}/resultsets/{rs}/cell?row=12&col=3` | – | `{ "kind":"string"|"binary", "value":"<full text or base64>", "len":N }` |
| POST | `/executions/{xid}/resultsets/{rs}/export` | `{ "format":"csv"|"json"|"sql-insert", "path":"C:\\x.csv"|null, "options":{ "delimiter":",", "header":true, "nullAs":"", "tableName":"dbo.X" } }` | `{ "path":"...", "rows":5000 }` (path null in browser mode → response is the file: `Content-Disposition: attachment`) |
| POST | `/export` | `{ "sessionId":"s_..", "sql":"SELECT ...", "format":"csv", "path":"...", "options":{...} }` | `202 { "exportId":"e_.." }` → progress via `export.progress`/`export.done` events (unlimited rows, streamed) |
| GET | `/history?connectionId=&q=&limit=200&before=` | – | `[ { "id":1, "connectionId":"c_..", "database":"x", "sql":"...", "startedAt":"...", "durationMs":12, "status":"ok"|"error"|"cancelled", "rowsAffected":3, "resultRows":100, "error":"..."|null, "label":"statement" } ]` |
| DELETE | `/history/{id}` / `DELETE /history?connectionId=` | – | 204 |

`ColumnInfo = { "name":"Id", "ordinal":0, "dbType":"int", "kind":"int"|"float"|"decimal"|"string"|"bool"|"date"|"time"|"datetime"|"datetimeoffset"|"guid"|"binary"|"json"|"xml"|"cursor"|"other", "nullable":true, "size":50|null, "precision":null, "scale":null, "table":"Customers"|null, "schema":"dbo"|null, "isKey":false }`.

### 3.5 SQL services
| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/sql/diagnostics` | `{ "dialect":"tsql"|"sqlite", "sql":"...", "connectionId":"c_.."|null }` | `{ "diagnostics":[ {"line":3,"col":10,"endLine":3,"endCol":15,"severity":"error"|"warning","code":"SQL46010","message":"Incorrect syntax near FORM."} ], "engine":"scriptdom"|"sqlite-prepare" }` (Oracle → `NOT_SUPPORTED` in M1) |
| POST | `/sql/format` | `{ "dialect":"tsql", "sql":"...", "options":{...} }` | `{ "sql":"..." }` (M2; T-SQL via ScriptDom `Sql160ScriptGenerator`) |

### 3.6 WebSocket `/ws`
Client → server: `{"type":"auth","token":"..."}` (must be first; otherwise closed with 4401 after 2 s), `{"type":"ping"}`. Server → client (all carry `"ts"` ISO):
```
{"type":"auth.ok"} | {"type":"pong"}
{"type":"exec.started","executionId","sessionId","batchCount"}
{"type":"exec.batch.started","executionId","batchIndex"}
{"type":"exec.resultset","executionId","resultSetId":0,"batchIndex":0,"columns":[ColumnInfo]}
{"type":"exec.rows","executionId","resultSetId":0,"rows":[[1,"a",null],[2,"b","2026-01-01T00:00:00"]]}
{"type":"exec.resultset.end","executionId","resultSetId":0,"rowCount":2,"truncated":false,"elapsedMs":12}
{"type":"exec.affected","executionId","batchIndex":0,"count":3,"statementKind":"UPDATE"|null}
{"type":"exec.message","executionId","batchIndex":0,"severity":"info"|"warning"|"error","text":"(3 rows affected)","line":4|null,"code":0|null,"source":"server"|"dbmsOutput"|"engine"}
{"type":"exec.error","executionId","batchIndex":0,"code":"207","message":"Invalid column name 'x'.","line":2,"col":null,"detail":"..."}
{"type":"exec.batch.ended","executionId","batchIndex":0,"elapsedMs":15,"status":"ok"|"error"|"cancelled"}
{"type":"exec.done","executionId","status":"ok"|"error"|"cancelled","elapsedMs":30,"resultSets":2,"rowsAffected":3,"txOpen":false}
{"type":"session.changed","sessionId","state":"idle"|"executing"|"broken"|"closed","txOpen":true,"database":"x","txMode":"manual"}
{"type":"catalog.changed","connectionId","database","schemas":["dbo"],"version":13}
{"type":"export.progress","exportId","rows":120000} | {"type":"export.done","exportId","path","rows","status","error"}
{"type":"engine.log","level":"warn","message":"..."}
```
`line` in `exec.error`/`exec.message` is already absolute to the editor document (engine adds the batch's `line - 1`).

---

## 4. IntelliSense design

### 4.1 Where it runs (confirming and refining the lean)
- Completion, hover, signature help, go-to-definition, statement splitting, and "soft" semantic diagnostics run in the renderer as a pure TypeScript library `ui/src/intel` (no DOM, no Monaco imports) over an in-memory `CatalogIndex` built from `CatalogSnapshot`. Rationale: keystroke latency must be < 5 ms; a round trip to the engine (even localhost) adds 2–10 ms plus JSON cost and makes typing feel like Navicat. DataGrip does it in-process too.
- It runs on the main thread in M1 as a synchronous API. The library has no shared mutable state with React so moving it to a Web Worker later is a transport change only. Budget: completion ≤ 5 ms on a 300-line script with a 5k-table catalog; index build ≤ 150 ms for 100k columns (build incrementally per schema). If measured above budget, move to a worker (decision D-11).
- Hard syntax diagnostics come from the engine (`POST /sql/diagnostics`): ScriptDom for T-SQL, `Prepare()` for SQLite, nothing server-side for Oracle in M1. Debounced 400 ms after the last edit, cancelled/superseded by newer requests, results merged with the soft diagnostics into Monaco markers (owner `dbstudio-syntax` vs `dbstudio-semantic`).
- Catalog loading is lazy and event driven: the editor tab subscribes to the catalog store; `intel.setCatalog(snapshot)` replaces the index per schema (diffing by `schema.version`).

### 4.2 Module layout (`ui/src/intel`)
```
intel/
  index.ts                 createIntel(dialect): Intel   (public API, see 4.12)
  dialect/                 tsql.ts plsql.ts sqlite.ts  → DialectSpec { keywords, contextualKeywords, functions(json), quoting, caseFolding, batchSeparator, paramPrefixes, stringPrefixes, operators, clauseKeywords }
  dialect/data/            tsql-functions.json plsql-functions.json sqlite-functions.json (name, signatures[], returns, doc, category, since)
  lexer/lexer.ts           tokenize(text, spec): Token[]     (incremental per statement; see 4.3)
  split/splitter.ts        splitStatements(tokens, spec): Statement[]  (4.4)
  parse/statement-model.ts StatementModel, Scope, TableRef, CteDef, ClauseKind
  parse/partial-parser.ts  buildModel(statementTokens, spec): StatementModel   (error tolerant; 4.6)
  catalog/index.ts         CatalogIndex: schema/object/column maps, FK graph, synonym resolution, case-insensitive tries
  context/context.ts       detectContext(model, tokens, offset): CursorContext (4.5)
  complete/completer.ts    complete(ctx): Suggestion[]   (4.7–4.10)
  complete/ranker.ts       score/fuzzy (4.13)
  hover/hover.ts  signature/signature.ts  definition/definition.ts  diagnostics/soft-diagnostics.ts
  __tests__/*.test.ts      vitest; fixture catalogs under __tests__/fixtures/*.json
```

### 4.3 Lexer (shared engine, dialect tables)
Token kinds: `ident`, `quotedIdent`, `keyword` (only reserved/clause words; contextual words stay `ident` and are reinterpreted by the parser), `string`, `number`, `param` (`@x`, `:x`, `?`, `$1`, Oracle `&x`), `op`, `punct` (`( ) , . ;`), `comment`, `batchSep` (`GO [n]` on its own line, T-SQL; `/` alone on a line, Oracle), `ws`, `eof`. Each token: `{kind, text, start, end, line, col, upper}`; `upper` precomputed for keyword matching.
Dialect rules: T-SQL `[x]`, `"x"` (QUOTED_IDENTIFIER ON assumed), `N'...'`, `'...'` with `''`, `--`, `/* */` (nested comments are allowed in T-SQL — handle nesting), `@var`, `@@fn`, `#temp`/`##temp` identifiers, `$ACTION`, bracket-closing `]]`. Oracle: `"x"`, `'...'`, `q'[...]'`/`q'{...}'`/`q'<...>'`/`q'(...)'`/`q'X...X'`, `--`, `/* */`, `:bind`, `&subst`, `%TYPE`/`%ROWTYPE` as `op`, `=>`, `||`, `(+)`. SQLite: `"x"`, `` `x` ``, `[x]`, `'...'`, `?`, `?NNN`, `:x`, `@x`, `$x`, `X'..'` blob literals, `->`/`->>`.
The lexer tokenizes the whole document on each change (a 1 MB script tokenizes in ~15 ms; typical files in < 1 ms). The `Statement` cache keyed by `(start,end,textHash)` avoids re-parsing untouched statements; only the statement containing the edit is re-modeled.

### 4.4 Statement splitting
`splitStatements` yields `[{index, start, end, text, line, col, kind, isPlsqlBlock}]`. Rules by dialect:
- **T-SQL**: primary separator is a `GO` line (case-insensitive, optional count, optional trailing comment) → these are *batches* (what "run script" sends). Inside a batch, *statements* (for Ctrl+Enter) are delimited by (a) `;` at depth 0 (not inside parentheses, strings, `BEGIN...END`, `CASE...END`, `BEGIN TRY/CATCH`), (b) a blank line at depth 0 when the setting `blankLineSplitsStatements` is on (default on; SSMS users expect this), (c) a top-level statement-start keyword at line start (`SELECT, INSERT, UPDATE, DELETE, MERGE, WITH, CREATE, ALTER, DROP, TRUNCATE, EXEC, EXECUTE, DECLARE, SET, IF, WHILE, BEGIN, PRINT, USE, GRANT, REVOKE, DENY, BACKUP, RESTORE, BULK, WAITFOR, THROW, RAISERROR, RETURN, GOTO, OPEN, FETCH, CLOSE, DEALLOCATE, CHECKPOINT, DBCC, KILL`) that follows a complete previous statement — except when the previous token is a comma/open paren/operator or we are inside `BEGIN...END`. `CREATE PROCEDURE/FUNCTION/TRIGGER/VIEW` extends to the end of the batch (`GO`), since the body is one statement. Ctrl+Enter inside a `BEGIN...END` block or procedure body runs the enclosing top-level statement.
- **Oracle**: a PL/SQL block starts with `DECLARE`, `BEGIN`, or `CREATE [OR REPLACE] [EDITIONABLE|NONEDITIONABLE] (PROCEDURE|FUNCTION|PACKAGE [BODY]|TYPE [BODY]|TRIGGER|LIBRARY)` and ends at a line containing only `/` (fallback: `END;` at depth 0 followed by a blank line or EOF, with a soft warning "missing /"). Everything else ends at `;` at depth 0 (or `/` line, which Oracle also accepts for SQL). `CREATE VIEW` ends at `;`. SQL*Plus commands (`SET SERVEROUTPUT ON`, `SHOW`, `SPOOL`, `EXEC x` — note `EXEC` becomes `BEGIN x; END;`) are recognised: `EXEC`/`EXECUTE` is rewritten by the UI before sending; the others produce a warning diagnostic "SQL*Plus command not supported" and are skipped on run.
- **SQLite**: `;` at depth 0; `CREATE TRIGGER ... BEGIN ... END;` handled by tracking `BEGIN...END` depth. Blank-line splitting is off by default (there is no SSMS culture here) but obeys the setting.
- `statementAt(offset)`: the statement whose `[start,end]` contains the offset, else the nearest preceding statement when the cursor is on trailing whitespace of it, else the next one if the cursor is on blank lines before it and the setting `runNextStatementOnBlank` (default false). Selection run: if a selection exists, send the selection text verbatim as one batch (T-SQL: split by `GO` within the selection).

### 4.5 Cursor context detection
`detectContext` returns:
```ts
type CursorContext = {
  statement: StatementModel; scope: Scope;         // innermost scope (subquery/CTE body) containing offset
  clause: 'select'|'from'|'join'|'on'|'where'|'groupBy'|'having'|'orderBy'|'into'|'insertColumns'|'values'|'set'|'update'|'delete'|'with'|'cteColumns'|'using'|'returning'|'limit'|'exec'|'execArgs'|'declare'|'ddl'|'unknown';
  qualifier: string[] | null;    // identifier chain before the '.' at cursor, e.g. ['c'] or ['dbo','Customers'] or ['Sales','dbo']
  prefix: string;                // partial word being typed (raw, may start with quote)
  prefixQuoted: '"'|'['|'`'|null;
  prevToken: Token | null; prevKeyword: string | null;   // last keyword at depth 0 before cursor within clause
  inFunctionCall: { name: string; argIndex: number } | null;   // for signature help
  afterJoinTable: TableRef | null;       // we are in ON of this join
  expectsExpression: boolean;            // after '=', ',', '(', AND/OR, SELECT, etc.
  statementHasFrom: boolean; statementEndsAtCursor: boolean;
}
```
Algorithm: (1) locate statement and tokens; (2) build `StatementModel` (4.6) for the whole statement (text after the cursor included; this is how "SELECT | FROM t" works); (3) find the innermost scope by paren ranges containing the offset; (4) walk tokens backward from the cursor at the scope's depth to the nearest clause keyword → `clause`; (5) collect the dotted chain immediately before the cursor (`ident ( '.' ident )* '.'`) → `qualifier`; (6) if the token under cursor is an identifier/keyword being typed, it is `prefix`.

### 4.6 Partial parser and scope model (error tolerant)
Not a full grammar per dialect. A hand-written recursive-descent "structure parser" that understands only what completion needs and skips anything else token by token:
```ts
type Scope = { kind:'select'|'insert'|'update'|'delete'|'merge'|'cte'|'subquery'|'exists'|'values'|'plsqlBlock'|'other';
  range:[number,number]; parent: Scope|null; children: Scope[];
  sources: TableRef[];                     // FROM/JOIN/UPDATE/INTO/USING targets, in order
  ctes: Map<string, CteDef>;               // visible CTEs (own WITH + ancestors')
  projections: Projection[];               // SELECT list items: {expr, alias, columnRef?} for CTE/subquery output columns
  joins: JoinInfo[];                       // {left: TableRef[], right: TableRef, onRange}
  targetTable?: TableRef;                  // INSERT INTO / UPDATE / DELETE / MERGE INTO
  insertColumns?: string[];
  localVars: Map<string, {type:string}>;   // T-SQL DECLARE, PL/SQL DECLARE section, table variables
};
type TableRef = { kind:'table'|'subquery'|'cte'|'function'|'synonym'|'tempTable'|'tableVar'|'unresolved';
  parts: string[]; alias: string|null; aliasRange?; nameRange; resolved?: ResolvedObject; subScope?: Scope; columns(): ColumnDef[] };
```
Key behaviors:
- A table source is parsed after `FROM`, `JOIN`, `UPDATE`, `INTO`, `DELETE [FROM]`, `MERGE INTO`, `USING`, and T-SQL `APPLY`. Grammar: `qualifiedName [AS] [alias] [WITH (hints)] | '(' subquery ')' [AS] alias [ '(' colAliases ')' ] | fn '(' ... ')' [AS] alias | '(' VALUES ... ')' AS alias(cols)`. An alias is accepted only if the next identifier is not a keyword (`WHERE`, `ON`, `JOIN`, `LEFT`, `INNER`, `GROUP`, `ORDER`, `SET`, `WITH`, ...) and not a comma. Oracle: `AS` is not allowed before a table alias — accept both anyway.
- CTE: `WITH [RECURSIVE] name [(cols)] AS ( ... ) [, ...]`: each CTE body is a child scope; its output columns = explicit col list or the body's projections (`*` expands against the body's sources). CTEs are visible to later CTEs and the main statement; recursive CTE sees itself.
- Subquery in FROM: output columns from projections; `SELECT *`/`t.*` expand. Scalar subquery/EXISTS in WHERE: child scope that **inherits** outer sources (correlated references) — outer aliases are suggested but ranked after inner ones.
- Projections capture `expr AS alias`, `alias = expr` (T-SQL), bare `t.col` and `col`; these feed ORDER BY alias suggestions and CTE output columns.
- T-SQL `#temp`/`@tablevar` and `DECLARE @t TABLE (...)` / `SELECT ... INTO #t` earlier in the *document* (same batch) register columns in `localVars`/a document-level `tempTables` map so later statements get completion for them (SSMS doesn't; DataGrip does). PL/SQL: `DECLARE` section variables, `%ROWTYPE` vars expand to table columns (`r.|` → columns of the table), cursor declarations (`CURSOR c IS SELECT ...` → `FOR r IN c LOOP r.|`), package-level types via `ALL_ARGUMENTS` not attempted in M1.
- Name resolution (`CatalogIndex.resolve(parts, scope)`), dialect specific:
  - T-SQL: 1 part → CTE > temp/table var > local alias > default schema object > any loaded schema with unique match > synonym; 2 parts → `schema.obj` else `db..obj`? (no: `db.obj` is invalid) ; 3 parts → `db.schema.obj`; 4 parts → linked server (unresolved).
  - Oracle: 1 part → CTE > alias > current-schema object > private synonym > PUBLIC synonym (lazy fetch) > other loaded schema; 2 parts → `schema.obj` or `package.member`; 3 parts → `schema.package.member`; `@dblink` suffix → unresolved. Unquoted names fold to upper for lookup; quoted names exact.
  - SQLite: 1 part → CTE/alias/temp/main/attached dbs; 2 parts → `db.table`.
  - Synonyms resolve to their target transparently (columns, hover shows "synonym → target").

### 4.7 Completion by context (what is suggested, in rank groups)
Groups are ordered; within a group fuzzy score + usage decides (4.13). Items carry `kind` (table, view, column, alias, schema, database, cte, function, procedure, package, keyword, snippet, variable, parameter), `label`, `detail` (type / schema.table), `documentation`, `insertText` (quoted if needed; snippet syntax when `isSnippet`), `sortText`, `filterText`, optional `additionalTextEdits`, `commitCharacters`.

| Context | Suggestions |
|---|---|
| `select` list, no qualifier | 1. columns of all in-scope sources (label `Name`, detail `c · Customers`; **inserted as `c.Name` when the column name is ambiguous across sources or when setting `qualifyColumns=always`**, as bare name otherwise); 2. aliases/tables (`c`, `Customers`) so the user can type `c.`; 3. `*` and `c.*` items; 4. functions (dialect + user scalar functions + Oracle packages); 5. keywords valid here (`DISTINCT`, `TOP` (T-SQL), `CASE`, `CAST`, `NULL`); 6. local variables/params; 7. **"all columns of X" snippet** expanding to the full comma-separated list (DataGrip feature). If `!statementHasFrom`: show columns from all tables of the default schema (cap 3000) with detail = table; accepting one appends `FROM <table>` via `additionalTextEdits` when `statementEndsAtCursor`; plus tables group so `SELECT Customers` → can be followed by `.` |
| `from`/`join`/`update`/`into`/`delete`/`using` | 1. CTEs in scope; 2. tables+views (+mviews, synonyms, table functions) of default schema; 3. temp tables/table vars; 4. other loaded schemas (as `schema` items; accepting inserts `schema.` and re-triggers); 5. databases (T-SQL) ; in `join`: tables with FK relations to any in-scope source are hoisted to the top, each with a **second item** labelled `Orders o ON o.CustomerId = c.Id` (kind `snippet`, detail "FK_Orders_Customers") that inserts the full join tail; alias auto-generation (setting: initials/first letter, uniqueness enforced) |
| after `JOIN x [alias] ON ` (`on` clause, no qualifier) | 1. full FK conditions between `afterJoinTable` and each earlier source: `o.CustomerId = c.Id` (both directions, composite FKs joined with AND); 2. columns of `afterJoinTable` first, then other sources; 3. functions/keywords |
| `where`/`having`/`groupBy`/`orderBy`/`set`(rhs) | columns of in-scope sources (correlated outer scopes after inner), `orderBy` also projection aliases and ordinal hints, then functions, keywords (`AND OR NOT IN EXISTS LIKE BETWEEN IS NULL ASC DESC NULLS FIRST`) |
| `set` (lhs, UPDATE) | columns of `targetTable` only (excluding identity/computed) |
| `insertColumns` (`INSERT INTO t (`) | columns of `targetTable` in ordinal order, excluding identity/computed/hidden unless `prefix` matches them; a top item **"all insertable columns"** inserting `Col1, Col2, ...`; after `)`+`VALUES (` the `values` context yields a snippet `${1:Col1}, ${2:Col2}` with the column list as placeholders and NULL defaults for nullable columns, plus functions/`DEFAULT`/`NULL` |
| `values` | functions, `NULL`, `DEFAULT`, variables, snippet above |
| qualifier chain `a.` | resolve `a`: alias/table/CTE/temp → its columns (+ `*`); schema → objects of that schema (tables/views/procs/functions/synonyms/packages, by clause: in FROM only tabular things, in expressions only functions/sequences); database (T-SQL) → schemas (and `..` shortcut); Oracle package → members (procs/funcs with overloads as separate items), `seq.` → `NEXTVAL`/`CURRVAL`; `%ROWTYPE` var → columns; T-SQL `@@` → global vars |
| `exec`/`execArgs` | procedures (default schema first, then others as `schema.proc`); after proc name: parameter names `@p = ` as snippet, signature help shows declared params |
| `with`/`cteColumns` | keyword `AS`, nothing else noisy |
| `ddl` (`CREATE/ALTER/DROP`) | object names of matching type after `TABLE`/`VIEW`/`PROCEDURE`/...; column names after `ALTER TABLE t ADD/ALTER/DROP COLUMN`; data types after a column name in a column definition (dialect list) |
| `declare` (T-SQL/PLSQL) | data types; PL/SQL `table.col%TYPE` / `table%ROWTYPE` |
| start of statement / unknown | statement keywords + snippets (`sel`, `selw`, `ins`, `upd`, `del`, `cte`, `ifx` ...) + tables (accepting a table at statement start inserts `SELECT * FROM table` — DataGrip style) |

Keyword flow suggestions ("what comes next") are table-driven per dialect: after a complete table source → `WHERE JOIN INNER LEFT RIGHT FULL CROSS GROUP ORDER UNION ...`; after `ORDER BY expr` → `ASC DESC`; after `GROUP BY ...` → `HAVING ORDER`; T-SQL adds `OPTION`, `FOR JSON`; Oracle `FETCH FIRST`, `CONNECT BY`; SQLite `LIMIT`, `RETURNING`.

### 4.8 Quoted identifiers, case, schema qualification
- `needsQuoting(name)` per dialect: not matching `^[A-Za-z_][A-Za-z0-9_$#]*$` (Oracle: must be upper-case to be unquoted; mixed-case Oracle names always quoted), or reserved word → `insertText` quoted with the dialect's preferred quote (`[ ]` T-SQL, `" "` Oracle/SQLite). If the user already typed an opening quote, `prefix` is matched without it and the closing quote is inserted; if a closing quote exists after cursor, do not double it.
- Identifier case setting: `asIs` (default; catalog case), `lower`, `upper`, `matchPrefix` (copy the case of the typed prefix, DataGrip-like). Keyword case: `upper` default. Oracle unquoted identifiers display in catalog case (`CUSTOMERS`) unless `identifierCase=lower`.
- Qualification setting `qualifyObjects`: `never` | `nonDefaultSchema` (default) | `always`. Within an explicit `schema.` qualifier never re-qualify.

### 4.9 Functions, signature help, hover
- Static per-dialect function catalogs (JSON) with multiple signatures: T-SQL (~260: string/date/math/aggregate/window/JSON/conversion/system `@@` vars, `OPENJSON`, `STRING_AGG ... WITHIN GROUP`), Oracle (~320 SQL functions + analytic syntax + key `DBMS_OUTPUT`, `DBMS_LOB`, `DBMS_RANDOM`, `DBMS_SQL`, `DBMS_METADATA`, `UTL_RAW`, `DBMS_LOCK`, `DBMS_SCHEDULER`, `DBMS_STATS`, `DBMS_UTILITY`, `DBMS_APPLICATION_INFO`, `DBMS_SESSION` as packages with members — merged with live `ALL_ARGUMENTS` when loaded), SQLite (~110: core, math, date/time with modifier docs, json1 incl. `->`/`->>`, window, FTS5 helpers, `pragma_*` table-valued functions). User-defined scalar/table functions and procedures come from the catalog with parameters.
- Signature help on `(` and `,` (and re-opened on Ctrl+Shift+Space): shows all overloads, highlights `argIndex` (counting depth-0 commas inside the call; Oracle named notation `name => v` highlights by name). Works for user procs in `EXEC p a, b` (T-SQL comma-separated without parens) and PL/SQL `pkg.proc(...)`.
- Hover: table/view → `schema.name (table)`, comment, column list (first 25 with types, PK/FK badges) and `rowCountEstimate` when the details endpoint has been fetched; column → `schema.table.column type NULL/NOT NULL [PK] [FK → schema.table.col] [identity] default`, comment; alias → "alias for schema.table"; CTE → its output columns; function → signatures + doc; parameter/variable → declared type; synonym → target. Markdown rendered by Monaco.

### 4.10 Go-to-definition (F12 / Ctrl+click)
- Alias → alias definition range in the same editor; CTE name → `WITH` entry; local var → DECLARE; temp table → `CREATE TABLE #t`/`INTO #t`.
- Table/view/proc/function/package/trigger → the UI opens an "Object" tab (read-only Monaco with the DDL from `GET /catalog/ddl`, plus a Columns/Indexes/FKs panel from `/catalog/object`) and selects the object in the explorer. Columns → their table's object tab with the column highlighted. Implemented by returning a `monaco.languages.Location` with a synthetic URI `dbstudio-object://connectionId/db/schema/type/name` that the app's `openerService`-style handler intercepts.

### 4.11 Diagnostics
- Engine (hard): T-SQL via ScriptDom `Parse` → `ParseError{Line, Column, Number, Message}`; batch-aware (the UI sends the whole document; ScriptDom handles `GO`). SQLite via `Prepare()` (statement-level location). Oracle: none in M1; M2 opt-in "validate on server" using `DBMS_SQL.PARSE` only for `SELECT/INSERT/UPDATE/DELETE/MERGE/WITH` statements (DDL executes on parse, so it is never sent) with `DBMS_SQL.LAST_ERROR_POSITION` for the offset, on a dedicated diagnostics connection.
- UI (soft, all dialects, instant): unterminated string/comment/quoted identifier; unbalanced parentheses; unknown table/view in FROM (warning "Unknown table X" — suppressed when catalog for that schema is not loaded or the object is a temp/unresolved dblink); unknown column for a resolved qualifier (`c.Nmae` → "Column Nmae not found in Customers"); ambiguous unqualified column across sources (info); alias used but not defined; duplicate alias; `DELETE`/`UPDATE` without `WHERE` (warning, also used by the run-confirmation guard); Oracle PL/SQL block without terminating `/` (info); SQL*Plus command (warning); T-SQL `SELECT *` into INSERT column count mismatch (count insert columns vs VALUES items) (warning). Oracle compile errors from `ALL_ERRORS` after a `CREATE` run are mapped to markers offset by the statement's start line.
- Markers: severity mapping error/warning/info; `code` string; quick-fix code actions in M2 (add alias, qualify column, add missing `/`).

### 4.12 Public API consumed by WP-C/Monaco glue
```ts
export interface Intel {
  dialect: Dialect;
  setCatalog(snapshot: CatalogSnapshot | null): void;         // incremental per schema version
  setDocument(uri: string, text: string): void;                // full text; internally diffed/cached per statement
  applyEdit(uri: string, change: {rangeOffset:number; rangeLength:number; text:string}): void;
  statements(uri: string): StatementInfo[];
  statementAt(uri: string, offset: number): StatementInfo | null;
  batchesFor(uri: string, range?: [number,number]): SqlBatch[];     // what to send to /execute (GO-aware)
  complete(uri: string, offset: number, trigger?: string): CompletionResult;   // {items, isIncomplete, replaceRange}
  resolveItem(item: CompletionItem): CompletionItem;            // lazy documentation
  hover(uri: string, offset: number): HoverInfo | null;
  signatureHelp(uri: string, offset: number): SignatureHelpInfo | null;
  definition(uri: string, offset: number): DefinitionResult | null;  // {kind:'local', range} | {kind:'object', ref}
  softDiagnostics(uri: string): Diagnostic[];
  classify(sql: string): StatementKind;                         // for destructive-run guard and history labels
  recordAccepted(item: CompletionItem): void;                   // usage ranking (MRU persisted by WP-C in settings)
}
```
WP-D also owns `ui/src/editor/`: `monaco-setup.ts` (workers via Vite `?worker`, languages `dbstudio-tsql|plsql|sqlite`, `EncodedTokensProvider` driven by the intel lexer so highlighting and parsing agree, themes `dbstudio-light`/`dbstudio-dark`), `providers/*.ts` (completion with `triggerCharacters: ['.', '(', ',', '@', ':', '#', '[', '"']`, `quickSuggestions:{other:true,comments:false,strings:false}`, `quickSuggestionsDelay:0`, `suggestOnTriggerCharacters:true`, `wordBasedSuggestions:'off'`; signature; hover; definition; `setModelMarkers` merge), `SqlEditor.tsx` React component with props `{ dialect, catalog, value, onChange, onRun(kind:'statement'|'selection'|'script', batches), onOpenObject(ref), readOnly, theme, settings }` and imperative handle `{ focus, getStatementAtCursor, insertText }`. Keybindings: `Ctrl+Enter` run statement at cursor (or selection if any), `F5` run script (or selection), `Ctrl+Shift+Enter` run script, `Ctrl+Alt+K`? no — `Esc` while running = cancel, `Ctrl+/` toggle comment, `Ctrl+Shift+Space` signature help, `Ctrl+Space` completion, `F12` definition, `Ctrl+D` duplicate line, `Alt+Up/Down` move line, `Ctrl+Shift+U/L` upper/lower (Monaco built-ins).

### 4.13 Ranking and fuzzy matching
Score = `groupWeight(kind, context) * 1000 + matchScore(prefix, label) + usageBoost + relevanceBoost`, emitted as `sortText = (99999 - score).toString().padStart(5,'0')` so Monaco keeps our order; `filterText` = unquoted name so typing `cust` matches `[Customer Orders]`. Monaco still applies its own fuzzy filter on subsequent keystrokes with no re-query (that is what makes it feel instant); we return `isIncomplete:false` unless we capped a huge list (then `true` so Monaco re-queries with the longer prefix).
`matchScore`: exact 100 > case-insensitive prefix 90 > word-start match on `_`/camel boundaries (`cid` → `CustomerId`, `o_d` → `order_date`) 70 > contiguous substring 50 > subsequence (VS Code-style fuzzyScore, gaps penalised) 30; shorter labels break ties; prefix length ≥ 3 required for subsequence matches to avoid noise. `usageBoost`: +0..15 from per-connection MRU/frequency of accepted items (decay by age). `relevanceBoost`: +20 FK-related join target; +15 column belongs to the most recently referenced alias; +10 columns of `targetTable` in INSERT/UPDATE; +10 tables in default schema; +8 projection alias in ORDER BY; −10 objects from schemas not yet referenced in the document; −20 for deprecated functions; PK columns +3 in ON/WHERE.
Group weights by context (higher first): e.g. in `where`: column 9, alias 7, function 5, keyword 4, table 2; in `from`: cte 9, table/view 8, synonym 6, schema 5, function 3, keyword 2; in `join`: fk-join-snippet 10, fk-related table 9, other tables 7 ...

### 4.14 Test cases (vitest; fixture catalog "shop": `dbo.Customers(Id PK identity, Name, Email, CountryId FK→dbo.Countries.Id)`, `dbo.Orders(Id PK, CustomerId FK→Customers.Id, OrderDate, Total decimal)`, `dbo.OrderLines(OrderId FK→Orders.Id, ProductId FK→Products.Id, Qty)`, `dbo.Products(Id, Name, Price)`, `dbo.Countries(Id, Name)`, `Sales.Invoices(...)`, proc `dbo.GetCustomer(@Id int)`, scalar fn `dbo.fnTax(@amount decimal)`, synonym `dbo.Cust → dbo.Customers`; Oracle variant upper-case under schema `SHOP`, package `SHOP.ORDER_API` with `CREATE_ORDER(p_cust IN NUMBER, p_total IN NUMBER)` and `GET_TOTAL(p_id NUMBER) RETURN NUMBER`, sequence `SHOP.ORDERS_SEQ`, synonym `CUST`, public synonym `DUAL`; SQLite variant with `main` + attached `archive`). `|` is the cursor; "top" means first items in rank order.

| # | Dialect | Input | Expected |
|---|---|---|---|
| 1 | tsql | `SELECT | FROM Customers c` | top: `Id, Name, Email, CountryId` (detail `c · Customers`), then `c`, `*`, functions; no tables |
| 2 | tsql | `SELECT c.| FROM Customers c` | exactly columns of Customers + `*`; no keywords |
| 3 | tsql | `SELECT c.na| FROM Customers c JOIN Orders o ON o.CustomerId = c.Id` | `Name` first; `CountryId` not before `Name` |
| 4 | tsql | `SELECT | FROM Customers c JOIN Orders o ON ...` | columns of both; `Id` appears twice with details `c` and `o` and inserts `c.Id`/`o.Id` (ambiguous → qualified) |
| 5 | tsql | `SELECT * FROM |` | top: tables/views of dbo (`Customers, Orders, ...`), `Sales` schema item, no columns, no functions |
| 6 | tsql | `SELECT * FROM Sales.|` | `Invoices` only (objects in Sales); nothing from dbo |
| 7 | tsql | `SELECT * FROM Customers c JOIN |` | top: `Orders` (FK), snippet item `Orders o ON o.CustomerId = c.Id`, `Countries co ON co.Id = c.CountryId`; then other tables |
| 8 | tsql | `SELECT * FROM Customers c JOIN Orders o ON |` | top: `o.CustomerId = c.Id`; then columns of `o`, then columns of `c` |
| 9 | tsql | `SELECT * FROM Orders o JOIN OrderLines ol ON ol.OrderId = o.Id JOIN |` | `Products` (via ol FK) and `Customers` (via o FK) both hoisted, snippets reference the right alias (`p.Id = ol.ProductId`, `c.Id = o.CustomerId`) |
| 10 | tsql | `INSERT INTO Orders (|` | `CustomerId, OrderDate, Total` ordered by ordinal; `Id` (identity) absent from top group but present when prefix `I` typed; "all insertable columns" item inserts `CustomerId, OrderDate, Total` |
| 11 | tsql | `INSERT INTO Orders (CustomerId, Total) VALUES (|` | snippet `${1:CustomerId}, ${2:Total}`; `NULL`, `DEFAULT`, functions |
| 12 | tsql | `UPDATE Orders SET |` | columns of Orders only (no `Id` identity); no other tables' columns |
| 13 | tsql | `UPDATE o SET o.Total = 1 FROM Orders o JOIN Customers c ON c.Id = o.CustomerId WHERE c.|` | columns of Customers |
| 14 | tsql | `WITH big AS (SELECT Id, Total AS Amt FROM Orders) SELECT b.| FROM big b` | `Id`, `Amt` only |
| 15 | tsql | `WITH a AS (SELECT * FROM Customers), b AS (SELECT a.| FROM a)` | columns of Customers (CTE `*` expansion) |
| 16 | tsql | `SELECT * FROM (SELECT Id, Name FROM Products) p WHERE p.|` | `Id`, `Name` |
| 17 | tsql | `SELECT * FROM Customers c WHERE EXISTS (SELECT 1 FROM Orders o WHERE o.CustomerId = |)` | top: `c.Id` style columns of `c` and `o` both available; `o` columns ranked before `c` |
| 18 | tsql | `SELECT Name FROM |` | tables having a `Name` column (`Customers, Products, Countries`) ranked first (backward inference) |
| 19 | tsql | `SELECT * FROM [Order |` | prefixQuoted `[`; `[Order Lines]`-style matching if such table existed; for fixture: `OrderLines` matches `Order` prefix ignoring the bracket and inserts `OrderLines]`-free text `OrderLines` (closing bracket not inserted because name doesn't need quoting... expected: insertText `OrderLines` and the typed `[` is replaced via `replaceRange`) |
| 20 | tsql | `SELECT * FROM Cust|` | `Cust` synonym (detail `→ dbo.Customers`) and `Customers`; `Customers` ranked first (exact-type table) |
| 21 | tsql | `SELECT * FROM Cust s WHERE s.|` | columns of Customers through synonym |
| 22 | tsql | `EXEC |` | `GetCustomer` (and schema items) |
| 23 | tsql | `EXEC GetCustomer |` | `@Id = ` snippet; signature help shows `@Id int` |
| 24 | tsql | `DECLARE @t TABLE (X int, Y nvarchar(10)); SELECT | FROM @t` | `X`, `Y` |
| 25 | tsql | `SELECT Id INTO #tmp FROM Orders;\nGO\nSELECT | FROM #tmp` | `Id` (temp table remembered across batches in the document) |
| 26 | tsql | `SELECT dbo.fn|` | `fnTax` with signature `(@amount decimal)`; after `(` signature help active |
| 27 | tsql | `SELECT * FROM Orders ORDER BY |` | columns of Orders; if `SELECT Total AS T ...` then alias `T` listed too |
| 28 | tsql | `SELECT * FROM Orders WHERE Total > 10 |` | keywords `AND OR ORDER GROUP` ranked above columns |
| 29 | tsql | `SELECT 1\nGO\nSEL|` | statement start: keywords + snippets; `statementAt` returns the third statement, batch split by GO |
| 30 | tsql | splitting: `SELECT 1;\n\nSELECT 2\nSELECT 3\nGO\nCREATE PROC p AS\nBEGIN\n SELECT 4\n SELECT 5\nEND\nGO` | statements: `SELECT 1`, `SELECT 2`, `SELECT 3`, whole `CREATE PROC ... END`; batches: 2 |
| 31 | plsql | `SELECT | FROM customers c` | columns `ID, NAME, EMAIL, COUNTRY_ID` resolved case-insensitively from upper-case catalog |
| 32 | plsql | `SELECT * FROM shop.|` | tables/views/packages/sequences/synonyms of SHOP |
| 33 | plsql | `BEGIN order_api.|` | `CREATE_ORDER`, `GET_TOTAL` with detail showing params |
| 34 | plsql | `SELECT orders_seq.|` | `NEXTVAL`, `CURRVAL` |
| 35 | plsql | `SELECT * FROM cust WHERE |` | columns of CUSTOMERS via private synonym `CUST` |
| 36 | plsql | `SELECT * FROM dual|` | `DUAL` via PUBLIC synonym (lazy-resolution hook invoked with `DUAL`) |
| 37 | plsql | `DECLARE r customers%ROWTYPE; BEGIN SELECT * INTO r FROM customers WHERE id=1; dbms_output.put_line(r.|); END;` | columns of CUSTOMERS |
| 38 | plsql | `SELECT * FROM "MixedCase"|` and catalog has `"MixedCase"` | quoted item preserved; unquoted `mixedcase` does not match it unless fuzzy |
| 39 | plsql | splitting: `SELECT 1 FROM dual;\nBEGIN\n NULL;\nEND;\n/\nCREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;\n/\nSELECT 2 FROM dual;` | 4 statements: SQL, block (isPlsqlBlock), procedure, SQL; `/` lines not included in text |
| 40 | plsql | `BEGIN order_api.create_order(1, |` | signature help: `CREATE_ORDER(p_cust IN NUMBER, p_total IN NUMBER)` with arg 2 active; `p_total =>` named-notation suggestion |
| 41 | sqlite | `SELECT * FROM archive.|` | tables of attached `archive` |
| 42 | sqlite | `SELECT json_extract(|` | signature help from static catalog; `->` operator doc on hover |
| 43 | sqlite | `INSERT INTO orders (|` | columns excluding `INTEGER PRIMARY KEY` rowid alias from the top group |
| 44 | sqlite | `SELECT * FROM orders o WHERE o.| LIMIT 1` | columns (clause detection with LIMIT after cursor) |
| 45 | all | `SELECT c.Nmae FROM Customers c` | soft diagnostic: warning "Column 'Nmae' not found in dbo.Customers" at `Nmae` |
| 46 | all | `DELETE FROM Orders` | soft diagnostic warning "DELETE without WHERE"; `classify` = `delete:destructive` |
| 47 | all | hover on `c` in `FROM Customers c` | "alias c → dbo.Customers (table), 4 columns ..." |
| 48 | all | F12 on `Customers` | `{kind:'object', ref:{schema:'dbo', name:'Customers', type:'table'}}`; F12 on `c` → range of alias definition |
| 49 | perf | 300-line script, catalog with 5,000 tables × 20 columns, `complete` at a `WHERE c.|` | p95 < 5 ms after warm-up; index build < 150 ms |
| 50 | tsql | `SELECT * FROM Customers c WHERE c.Name LIKE 'a|` | no suggestions inside string literal |
| 51 | tsql | `-- SELECT * FROM |` | no suggestions inside comment |
| 52 | tsql | `SELECT * FROM Customers WHERE Id IN (SELECT CustomerId FROM Orders WHERE |)` | `Orders` columns first, then outer `Customers` columns |
| 53 | tsql | `MERGE INTO Customers t USING Staging s ON |` | `t.Id = s.Id`-style FK snippets if FK exists, else columns of `t` and `s` |
| 54 | tsql | `SELECT c.Id, (SELECT COUNT(*) FROM Orders o WHERE o.CustomerId = c.|) FROM Customers c` | columns of Customers (correlated subquery sees outer alias) |

---

## 5. Features by milestone and the "best features" borrowed

**M1 (MVP, build now)**
1. Connection manager: dialog driven by `formSpec`, Test Connection with server info (Navicat/DBeaver), folders + colour tag (DBeaver; production = red bar on tabs), read-only flag (DBeaver), DPAPI secret storage.
2. Object explorer: connection → database (SQL Server) / schema → Tables, Views, Procedures, Functions, Packages (Oracle), Sequences, Synonyms, Triggers; lazy per schema; node context menu: "Open console", "Select top 1000 rows" (SSMS), "Open DDL" (DataGrip), "Copy name", "Refresh"; filter box with fuzzy search (DataGrip "speed search"); drag a table into the editor inserts qualified name.
3. Multi-tab SQL editor with the full IntelliSense of section 4; per-tab connection + database selector + transaction mode toggle (Auto/Manual with pending-badge, Commit/Rollback buttons — DataGrip); run statement-at-cursor, selection, script (DataGrip Ctrl+Enter + SSMS F5); destructive-statement confirmation (TablePlus safe mode) for `DELETE/UPDATE` without WHERE, `DROP`, `TRUNCATE` on non-read-only connections; read-only connections reject non-SELECT (engine enforced via classifier + for SQL Server `ApplicationIntent=ReadOnly` where possible).
4. Results: one tab per result set + Messages tab (SSMS), rows streaming into glide-data-grid, column type-aware formatting, NULL styling, sort/filter client-side on fetched rows (DataGrip), cell value viewer panel for long text/JSON/XML/binary with pretty print (DBeaver), copy cell/rows as TSV/CSV/JSON/Markdown/SQL INSERT (DataGrip), row count/elapsed/truncated status, "re-run without limit", max-rows selector, Ctrl+R toggles results pane (SSMS).
5. Cancel running query; progress indicator; execution timer.
6. DBMS_OUTPUT panel (SQL Developer/Toad) and PRINT/RAISERROR messages with click-to-line.
7. Query history (SQLite FTS) with search, re-open, pin (DataGrip/DBeaver).
8. Export result set to CSV/JSON (and SQL INSERT) plus unlimited "export query to file" (DBeaver export wizard, simplified).
9. Light/dark themes (Monaco + app, follows OS by default), command palette (Ctrl+Shift+P, VS Code/Azure Data Studio), keyboard-first.
10. Object DDL viewer tab (read-only) + object details (columns/indexes/FKs) from F12 and explorer.
11. Oracle: compile errors shown inline after CREATE; SQL*Plus `EXEC` rewrite.
12. Session restore: open tabs + unsaved editor text persisted in `%APPDATA%\DbStudio\workspace.json` (Electron) / localStorage (browser).

**M2**
- In-grid data editing with pending-changes buffer, Submit/Revert, generated UPDATE/INSERT/DELETE preview (DataGrip), requires PK detection.
- DataGrip-style "fetch next page" (keep reader open for single SELECT), result set filtering/WHERE builder in the grid header (Navicat filter), FK navigation "go to referenced row" (DataGrip).
- Formatter: T-SQL via ScriptDom `Sql160ScriptGenerator`; Oracle/SQLite via a TS formatter over our tokens (or `sql-formatter` npm with dialect tuning).
- Snippets/live templates and postfix completion (`orders.sel` → `SELECT * FROM orders`) (DataGrip).
- Oracle bind variable dialog + REF CURSOR output as result set; `DBMS_OUTPUT` toggle; Oracle server-side validation.
- Explain plan: SQL Server `SET SHOWPLAN_XML ON` / actual plan `SET STATISTICS XML ON` → tree + per-operator cost (SSMS); Oracle `EXPLAIN PLAN FOR` + `DBMS_XPLAN.DISPLAY` tree (SQL Developer); SQLite `EXPLAIN QUERY PLAN` tree.
- DDL generator "Script as CREATE/DROP/INSERT" (SSMS), table designer (basic), "Describe" F4 panel (Toad).
- Import CSV/JSON into table with mapping (Navicat import wizard).
- Semantic token coloring (aliases, columns, unresolved names) and quick fixes.
- Windows Entra/Azure AD auth for SQL Server; Kerberos for Oracle (as supported by managed driver).

**M3**
- ER diagram (DBeaver/Navicat) from FK graph with React Flow, per schema or per selected tables.
- Schema compare and sync script (SSDT/Redgate-lite; same-dialect only).
- AI assist: NL → SQL with catalog context, explain query, fix error (Claude API; opt-in, schema-only context).
- Session/activity monitor (SQL Server `sys.dm_exec_requests`, Oracle `V$SESSION`) with kill (Toad session browser).
- Data transfer between connections, notebook-style query cells, plugin API for more providers (PostgreSQL/MySQL next).

---

## 6. M1 work breakdown (5 parallel packages)

Shared ground rules: the contract in section 3 is frozen; any change requires editing this plan's section 3 first. Root files (WP-E owns): `E:\DbStudio\README.md`, `.gitignore`, `.editorconfig`, `scripts/dev.ps1` (starts engine `--dev`, Vite, Electron dev), `scripts/build.ps1`, `.github/workflows/ci.yml`.

### WP-A — Engine core, host, SQLite provider
Owns: `engine/DbStudio.sln`, `engine/Directory.Build.props`, `engine/src/DbStudio.Core/**`, `engine/src/DbStudio.Host/**`, `engine/src/DbStudio.Providers.Sqlite/**`, `engine/tests/DbStudio.Core.Tests/**`, `engine/tests/DbStudio.Providers.Conformance/**`, `engine/tests/DbStudio.Providers.Sqlite.Tests/**`.
First deliverable (within the first session, committed before anything else): `DbStudio.Core` interfaces and models from 2.2 verbatim, `Host/Contracts` DTOs from section 3, and `ProviderConformanceTests<TFixture>` abstract class so WP-B can compile and test against them immediately.
Scope: `Program.cs` (Kestrel on `127.0.0.1:0` unless `--port`, token middleware, CORS for `dbstudio://app` and `--dev` origin, `DBSTUDIO_READY` stdout line, `--parent-pid` watchdog, Serilog), endpoints for all of section 3, `WsHub` (single-socket fan-out, JSON via `System.Text.Json` source-gen), `SessionManager`, `ExecutionService` (+`ValueConverter`, `ResultStore`, row batching), `CatalogService` + cache + ETag + invalidation via `StatementClassifier`, `HistoryService` (SQLite FTS5 at `%APPDATA%\DbStudio\history.db`), `SettingsService`, `DpapiSecretStore`, `ConnectionStore`, export writers (CSV RFC 4180, JSON array, SQL INSERT), `SqliteProvider` with catalog reader (2.6), `SqlitePrepareDiagnostics`, `SqliteDdlGenerator`, `GET /sql/diagnostics` dispatch to provider.
Acceptance: `dotnet test engine` green; conformance suite passes on SQLite (open/test/execute multi-statement/rows-affected/cancel long `WITH RECURSIVE` loop/manual tx commit+rollback/catalog load for a fixture db with tables, views, FKs, triggers, attached db/ddl/diagnostics); `curl` session: create connection → session → execute `SELECT * FROM t; UPDATE t SET x=1;` → WS shows `exec.resultset`, `exec.rows`, `exec.affected`, `exec.done`; catalog ETag 304; secrets file unreadable from another Windows account (manual check); history searchable.
Local test: no server needed; fixture `engine/tests/fixtures/shop.sqlite` created by a script in tests. Run `dotnet run --project engine/src/DbStudio.Host -- --dev --port 5121 --token dev-token` and hit with `curl -H "Authorization: Bearer dev-token"`. WS smoke via `wscat` or a tiny Node script.

### WP-B — SQL Server and Oracle providers
Owns: `engine/src/DbStudio.Providers.SqlServer/**` (incl. `TSql/ScriptDomDiagnostics.cs`, `TSql/TSqlDdlGenerator.cs`), `engine/src/DbStudio.Providers.Oracle/**`, `engine/tests/DbStudio.Providers.SqlServer.Tests/**`, `engine/tests/DbStudio.Providers.Oracle.Tests/**`, `engine/tests/docker/` (compose + seed scripts `seed-mssql.sql`, `seed-oracle.sql` creating the "shop" fixture schema incl. a package, a synonym, a sequence, a procedure with DBMS_OUTPUT, a proc with two result sets and PRINT).
Scope: everything in 2.5 and 2.6 for both providers; `ConnectionFormSpec`s; `ServerInfo` queries (`SELECT @@VERSION, SERVERPROPERTY('ProductVersion'), @@SERVERNAME, SUSER_SNAME(), DB_NAME()`; Oracle `v$version`/`SELECT banner FROM v$version` with fallback to `product_component_version`, `SYS_CONTEXT('USERENV','SESSION_USER'/'CURRENT_SCHEMA')`); Oracle DBMS_OUTPUT pump; ALL_ERRORS mapping; T-SQL ScriptDom diagnostics with `GO` awareness; `TSqlDdlGenerator` for tables; `OracleDdl` via DBMS_METADATA with `ALL_SOURCE` fallback.
Acceptance: conformance suite passes against both containers; specific tests: SQL Server PRINT + two result sets + `RAISERROR(...,16,1)` continues the batch and surfaces as error message with line; `GO` batches with temp table across statements; cancel of `WAITFOR DELAY '00:01:00'` returns within 1 s; Oracle `DBMS_OUTPUT.PUT_LINE` lines captured; `CREATE PROCEDURE` with a typo yields `ALL_ERRORS` diagnostics; implicit result set via `DBMS_SQL.RETURN_RESULT`; catalog load for the fixture schema has correct FK direction and package members with overloads; PUBLIC synonym on-demand resolve; `ALTER SESSION SET CURRENT_SCHEMA` via `/sessions/{id}/database`.
Local test when no server: `docker compose -f engine/tests/docker/compose.yml up` with `mcr.microsoft.com/mssql/server:2022-latest` (`ACCEPT_EULA=Y`, `MSSQL_SA_PASSWORD`) and `gvenzl/oracle-free:23-slim` (`ORACLE_PASSWORD`, `APP_USER=shop`, `APP_USER_PASSWORD`); tests use Testcontainers and are `[SkippableFact]`-skipped when Docker is unavailable (`DBSTUDIO_IT=0`), so the suite is still green on a machine without Docker. Without Docker at all: the catalog SQL strings are unit-tested for syntax with ScriptDom (T-SQL) and the Oracle ones are smoke-checked by a regex that every query with `ALL_` has an `owner` bind; the row conversion and message mapping logic is unit-tested with fake `DbDataReader`s. The code must compile and the conformance tests must pass when a developer later runs them with Docker; a short `engine/tests/docker/README.md` explains the commands.

### WP-C — UI shell, connections, explorer, results grid, API client
Owns: `ui/**` except `ui/src/intel/**` and `ui/src/editor/**`. Key files: `ui/package.json`, `vite.config.ts`, `src/api/{client.ts,ws.ts,types.ts}` (types = section 3 verbatim, including `CatalogSnapshot`/`CatalogObject` that WP-D imports), `src/platform/{index.ts,electron.ts,browser.ts}` (`getEngineInfo`, `saveFileDialog`, `openExternal`, `pickFile`; browser fallbacks: env vars, `<a download>`, `<input type=file>` → path unavailable so SQLite in browser mode uses a typed path), `src/store/{connections,catalog,sessions,tabs,results,history,settings,ui}.ts` (Zustand), `src/components/{layout,ConnectionDialog,Explorer,ResultsPane,Grid,MessagesPane,HistoryPanel,ObjectTab,CommandPalette,StatusBar,Toolbar}/**`, `src/theme/*`, `src/App.tsx`, `src/main.tsx`, `src/mocks/` (MSW handlers + a fake WS emitting fixture events, used by Storybook-free dev and Vitest component tests).
Uses from WP-D: `<SqlEditor>` and `createIntel` (until WP-D lands, a stub `SqlEditor` with a plain Monaco instance and `batchesFor` splitting by `;` lives in `ui/src/editor/__stub__` and is deleted on integration).
Acceptance: in browser against the dev engine with SQLite: create/test/save connection; explorer shows schema tree lazily; open console tab per connection; run statement/selection/script (keybindings routed through editor handle); results stream (verify 100k rows render smoothly and sorting works); multiple result sets as tabs; Messages tab with click-to-line; cancel; tx mode toggle with commit/rollback and pending badge; history panel with search and re-open; export CSV/JSON via platform adapter; theme toggle and OS-follow; object DDL tab; session restore; Vitest component tests with MSW for ConnectionDialog, ResultsPane streaming reducer, Explorer lazy loading.
Local test: `npm run dev` + engine `--dev`; `npm run dev:mock` with MSW only (no engine).

### WP-D — IntelliSense engine and Monaco integration
Owns: `ui/src/intel/**`, `ui/src/editor/**`, `ui/src/intel/dialect/data/*.json`. Depends only on `ui/src/api/types.ts` (`CatalogSnapshot` types; WP-D may create a local copy `intel/catalog/types.ts` re-exporting from api/types once WP-C commits it, to avoid blocking).
Scope: sections 4.2–4.13 for all three dialects; `SqlEditor.tsx`; Monaco language registration/themes/workers; diagnostics merge (hard markers from `POST /sql/diagnostics` called via a prop callback `requestServerDiagnostics(sql) => Promise<Diagnostic[]>` provided by WP-C so intel stays network-free); function catalogs; usage ranking persistence hook.
Acceptance: all 54 test cases in 4.14 as vitest tests plus ≥ 150 additional unit tests for lexer/splitter/parser edge cases (nested comments, `q'[]'` strings, `GO 5`, `/` inside a string, `BEGIN...END` nesting, `CASE...END`, `(+)`, `%ROWTYPE`); perf test #49; manual check in the browser with the SQLite fixture: completion popup appears on the first keystroke with no visible delay, `.` completion correct after alias, join snippet works, hover and F12 work; no console errors; `npm run test:intel` < 10 s.
Local test: pure vitest, no engine. A dev page `ui/src/editor/dev/EditorPlayground.tsx` (route `/#/playground`) loads the fixture catalog JSON and the editor stand-alone.

### WP-E — Electron shell, packaging, dev scripts, CI
Owns: `desktop/**` (`package.json`, `electron-builder.yml`, `tsconfig.json`, `src/main/{main.ts,engine-process.ts,protocol.ts,window.ts,menu.ts,ipc.ts,updater-stub.ts}`, `src/preload/preload.ts` + `preload.d.ts` exported for WP-C as the `window.dbstudio` type), root `scripts/*.ps1`, `README.md`, `.github/workflows/ci.yml`, `.gitignore`, `.editorconfig`.
Scope: spawn engine from `process.resourcesPath/engine/DbStudio.Engine.exe` (dev: `dotnet run` or a prebuilt `engine/publish`), parse `DBSTUDIO_READY`, retry/timeout 15 s with an error page, kill tree on `before-quit` and when engine dies show a restart dialog; `dbstudio://app` scheme via `protocol.handle` serving `ui/dist` with correct MIME + SPA fallback; `BrowserWindow` with `contextIsolation`, `sandbox:true`, `nodeIntegration:false`, CSP header `default-src 'self' dbstudio: http://127.0.0.1:* ws://127.0.0.1:*; style-src 'unsafe-inline'`; IPC for save/open dialogs, `shell.openExternal`, window state persistence, native menu (File/Edit/View/Query/Help with accelerators that forward to the renderer as commands); single-instance lock; `electron-builder` NSIS x64 installer with `extraResources` = published engine (`dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true`); app icon; version stamping from root `version.json` into all three packages; CI: `dotnet test`, `npm test` (ui), `npm run build` (ui+desktop), artifact upload of the installer.
Acceptance: `scripts/dev.ps1` brings up engine + Vite + Electron with hot reload; `scripts/build.ps1` produces `desktop/dist/DbStudio-Setup-<ver>.exe` that installs and runs on a clean Windows 11 VM without .NET installed; closing the app leaves no `DbStudio.Engine.exe` process; killing the engine shows the restart dialog; engine port/token never appear in the renderer URL; CI green.
Local test: no DB needed (SQLite); verify token flow with the health endpoint from the renderer devtools.

Integration order: WP-A interfaces (hour 0) → WP-A/B/C/D in parallel → WP-C+D integrate `SqlEditor` (replace stub) → WP-E packages everything → end-to-end checklist from the M1 feature list, run on SQLite, then on the Docker SQL Server/Oracle.

---

## 7. Risks and decisions log

Risks
- R1 ODP.NET Core on .NET 10: official support may lag; mitigation: smoke test day 1; fallback `<RollForward>Major</RollForward>` already applies since it is a library; worst case multi-target the engine to `net9.0` (stack remains .NET 10 SDK).
- R2 SqlClient native SNI in single-file publish: use `IncludeNativeLibrariesForSelfExtract`; verify on a clean VM; fallback to framework-dependent folder publish (not single-file) still shipped inside `resources/engine`.
- R3 Catalog size (Oracle instances with 50k objects, SQL Server with thousands of tables): lazy per-schema loading, compact JSON, ETag; PUBLIC synonyms are never bulk-loaded; measure index build time (test #49).
- R4 Oracle `ALL_CONS_COLUMNS`/`ALL_ARGUMENTS` slowness: always OWNER-filtered; `all_arguments` restricted to `data_level=0`; consider `DBA_*` views when the user has privileges (M2 toggle).
- R5 Statement splitting heuristics (blank-line rule, Oracle `/`): user-visible setting, statement range highlighted in the gutter before running (the user sees exactly what will execute), and "run selection" always available as the escape hatch.
- R6 Monaco + Vite worker bundling: use `monaco-editor` ESM with explicit `?worker` imports for `editor.worker` only (no language workers needed), tested in both Vite dev and the `dbstudio://` build.
- R7 glide-data-grid peer deps (`lodash`, `marked`, `react-responsive-carousel`) and canvas font loading in Electron: pin versions; theme object regenerated on theme switch.
- R8 Microsoft.Data.Sqlite cancel semantics: `Cancel()` interrupts, but `ExecuteReader` is synchronous → run on a dedicated thread (done) and never await driver "async" methods expecting true async.
- R9 Secrets: DPAPI is user-scoped and non-portable; document in README; export/import of connections ships without passwords.
- R10 Unsigned installer triggers SmartScreen; code signing is a later purchase; CI builds remain unsigned.
- R11 Main-thread intel on huge documents (10k-line scripts): per-statement caching bounds re-parse cost; worker migration path kept open (D-11).
- R12 ScriptDom parser version vs newer T-SQL syntax: pick highest `TSqlNNNParser` available by reflection; parse errors downgraded to warnings for batches that the server nevertheless executes fine (user setting).

Decisions
- D-1 One physical connection per editor tab, pooling disabled; separate pooled catalog connections per profile.
- D-2 UI owns statement/batch splitting; engine executes the batches it is given. T-SQL batches = `GO`-delimited; Oracle/SQLite batches = single statements.
- D-3 Rows are capped (default 10k) and fully streamed; no server-side paging in M1 (keep-reader-open paging is M2). Unlimited export re-executes to file.
- D-4 Decimal/NUMBER and big int64 travel as strings; dates as ISO strings without zone conversion; binary/long text truncated with on-demand cell fetch.
- D-5 Completion/hover/signature/definition in the renderer (TypeScript), hard syntax diagnostics in the engine (ScriptDom, SQLite Prepare), Oracle server-side validation deferred to M2 (DBMS_SQL.PARSE only for DML/queries).
- D-6 Single WebSocket per UI instance, multiplexed by `executionId`/`sessionId`; REST for all commands; token via header / first WS frame, never in URLs.
- D-7 Electron loads the UI from a custom `dbstudio://app` origin (not `file://`), sandboxed renderer, engine CORS restricted to that origin (+ localhost:5173 only with `--dev`).
- D-8 Secrets via DPAPI `CurrentUser` behind `ISecretStore`; profiles in plain JSON without secrets.
- D-9 Query history and settings owned by the engine (shared between Electron and browser modes), stored under `%APPDATA%\DbStudio`.
- D-10 Compact array-based catalog JSON (`c: [[name,type,nullable,isPk,flags,comment]]`) to keep 100k-column snapshots under ~10 MB and fast to index.
- D-11 Intel runs on the main thread in M1; measured budgets (≤ 5 ms completion, ≤ 150 ms index) decide whether it moves to a Web Worker; the library is written DOM-free to make that a transport-only change.
- D-12 Oracle unquoted identifiers fold to upper for resolution; displayed in catalog case; identifier-case setting controls insertion.
- D-13 Destructive-statement guard (classifier-based) is on by default and bypassable per connection; read-only connections are enforced in the engine, not just the UI.
- D-14 glide-data-grid for results; Zustand stores split by domain; MSW mocks for UI tests so WP-C does not block on the engine.
- D-15 Oracle bind variables are rejected with a clear error in M1 (`BIND_VARS_UNSUPPORTED`) rather than silently mis-executed; bind dialog + REF CURSOR in M2.

### Critical Files for Implementation
- E:\DbStudio\engine\src\DbStudio.Core\Providers\IDbProvider.cs (plus IDbSession.cs, IExecutionSink.cs, ICatalogReader.cs in the same folder) — the contract every provider and the host build on
- E:\DbStudio\engine\src\DbStudio.Host\Contracts\Api.cs (DTOs for section 3) and E:\DbStudio\engine\src\DbStudio.Host\Ws\WsHub.cs — the wire contract
- E:\DbStudio\ui\src\api\types.ts — the TypeScript mirror of section 3, imported by both WP-C and WP-D
- E:\DbStudio\ui\src\intel\index.ts (with parse\partial-parser.ts and complete\completer.ts) — the IntelliSense engine
- E:\DbStudio\desktop\src\main\engine-process.ts — sidecar spawn, token handoff, lifecycle
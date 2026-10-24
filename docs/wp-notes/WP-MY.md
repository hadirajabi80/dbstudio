# WP-MY — MySQL + MariaDB (notes for the orchestrator)

## Integration status (Batch 3 integration pass)

Every R3 request below is **DONE**, with tests (the `TODO(WPMY-shared)` stub is gone):

| Request | Status | Where / notes |
|---|---|---|
| R3-Q1 backtick quoting | DONE | `ui/src/lib/sql.ts` (`MYSQL_RESERVED`, backticks for `mysql` and `clickhouse`); tests `filter/__tests__/batch3.test.ts` |
| R3-F4 contains/starts/ends filters | DONE | `ui/src/filter/sql.ts`: `CONCAT()`, `ESCAPE '\\'`; beyond the request: `LIKE BINARY` / `= BINARY` for case-sensitive MySQL, `lower()` instead of SQLite's `COLLATE NOCASE` for the non-SQLite dialects, ILIKE for Snowflake / ClickHouse, no ESCAPE clause for ClickHouse, `= TRUE` for Snowflake |
| R3-D1 inserts / savepoint | DONE | `ui/src/data/sqlgen.ts`: `INSERT INTO t () VALUES ()`, `SELECT LAST_INSERT_ID()` (only for an identity key), `RELEASE SAVEPOINT`; `sqlgen.mysql.test.ts` |
| R3-T1 routine templates | DONE | `designer/proc/templates.ts` `mysqlSnippet`, one trigger event in `ProcWizard.tsx`; `templates.mysql.test.ts` |
| R3-P1 `@var` is no bind | DONE | `ParamsDialog/detect.ts` (+ DEFINER / AGGREGATE / EVENT definitions), `editor/param-hint.ts`; `detect.mysql.test.ts` |
| R3-E1 splitter nesting | DONE | `SqlTokenizer.ScriptBlockStep` (MySQL IF/LOOP/WHILE/REPEAT/CASE/labels in statement position, `IF(` functions excluded; also serves Snowflake Scripting, see WP-SF R3-2); `ScriptBlockSplitTests.cs` |
| R3-F1 / F2 / F3 formatter | DONE | `format/index.ts`, `format/layout.ts` (`mysqlStatement`, ODKU, INSERT SET, REPLACE, IGNORE, DDL words); the three `it.todo` are real tests; also `VALUES(col)` stays a call in ODKU and `, MODIFY COLUMN` in ALTER |
| R3-C1 codegen spellings | DONE | `codegen/types/index.ts`; `codegen/__tests__/batch3-types.test.ts` |
| R3-I1 `@@` completion / R3-I2 `IF(` signature help | DONE | `completer.ts`, `context.ts`; `intel/__tests__/mysql.test.ts` |
| R3-S1 snippets | DONE | `snippets/builtins.ts` |
| R3-M1 mock shop | DONE | `MockProviderPack.shop` (schema, native types, banner, databases) in `mocks/packs/types.ts` + `mocks/engine.ts`; the MySQL, MariaDB, ClickHouse, Snowflake and Cassandra packs use it |

Branch `worktree-agent-af932997ab1e37392`, based on WP0 (`686056e`). All file:line references below are at `686056e`.
Local stubs are findable with `TODO(WPMY-shared)` (one: `ui/src/mocks/packs/mysql.ts`).

## What landed

**Engine** (`engine/src/DbStudio.Providers.MySql`, registered from `MySqlModule`, no Program.cs edit):

- `MySqlProvider` ("mysql") and `MariaDbProvider` ("mariadb"), both `Dialect.MySql`, single-level (databases are the
  schemas, `ChangeDatabase` = `USE`), `IObjectBrowserProvider`, `IDatabaseSearchProvider`. The server flavor is detected
  per connection (`VERSION()`, `@@version_comment`), so a "mysql" profile pointing at MariaDB works.
  `ServerInfo.ProductVersion` is `8.4.3` / `11.4.2-MariaDB` (the suffix tells version-dependent readers the flavor).
- Connection strings (MySqlConnector 2.4.0): sessions unpooled, `AllowUserVariables`, `AllowLoadLocalInfile=false`,
  `UseAffectedRows`, `TreatTinyAsBoolean=false`, `ConvertZeroDateTime`, KILL-QUERY cancel with a 5 s cancellation
  timeout; form fields exactly as the UI mock pack (host, port 3306, database, user, password, sslMode, sslCa,
  allowPublicKeyRetrieval, charset utf8mb4, connectTimeout, compress, serverVariables). `serverVariables` are validated
  (`name=value`, no `;`) and applied with `SET SESSION`; a read-only profile adds `SET SESSION TRANSACTION READ ONLY`.
- `MySqlSession : AdoSessionBase`: each batch is split with `MySqlSqlText.Split` (DELIMITER lines, stored-program
  bodies whole, `\G`) and run statement by statement through `MySqlStatementReader` (one command per statement on the
  session connection, result sets in order, rows affected per statement, the failing statement known exactly for error
  positions). Warnings/notes: `SHOW WARNINGS` after every statement (see deviations). Errors: server number as code,
  SQLSTATE in the detail, line/column from "near '…' at line N" or the offending table/column name. Manual mode: DDL
  never begins the engine transaction; an open one that a DDL statement commits implicitly is reported. Transaction
  state: MariaDB `@@in_transaction`, MySQL from the batch's transaction statements. `USE`/`CALL` refresh
  `CurrentDatabase`. Out/inout binds are user variables (set before, read after the statement).
  `SELECT SLEEP(60)` cancelled with KILL QUERY returns 1 instead of failing: a read-only batch that "completed" after
  the cancel is reported Cancelled.
- Types: BIGINT UNSIGNED > 2^53 as text, DECIMAL at full precision (`MySqlDecimal`, also DECIMAL(65,30)), BIT(n) as a
  bit string, YEAR int, ENUM/SET text, JSON json (MariaDB JSON is LONGTEXT → string), spatial → WKB binary, DATE →
  `yyyy-MM-dd`, zero dates → NULL + warning. GuidFormat None (CHAR(36) stays text).
- Catalog (`information_schema`, system databases hidden): tables, views, MariaDB sequences, columns (auto-increment
  flag 1, generated 2+8, invisible 4, comments), PK/FK, routines with parameters (function return), triggers, events as
  `proc` with comment "event …"; details (STATISTICS incl. FULLTEXT/SPATIAL and prefix lengths, referencing FKs,
  triggers, TABLE_ROWS, create/update time); DDL via `SHOW CREATE TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT|SEQUENCE`.
- Object browser: FKs, triggers, and names referenced by view/routine/trigger/event bodies; object list with rows,
  data+index size, create/update times, routines, events, triggers.
- Find in database: names/columns/code from information_schema, data in a read-only transaction (`SearchSql` WP-MY
  blocks: `@p`, `UPPER() LIKE UPPER() ESCAPE '!'`, regex `CONVERT(x USING utf8mb4) COLLATE … REGEXP` on both servers).
- Designer (`MySqlDdlScripter` / `MySqlDesignerDatabase`, keyed per id): CREATE TABLE with inline keys, indexes (DESC,
  prefix `col(10)`), CHECK, FKs, AUTO_INCREMENT (identity → AUTO_INCREMENT), VIRTUAL/STORED generated columns,
  comments, `ON UPDATE CURRENT_TIMESTAMP` (carried in the default text); ALTER = RENAME TABLE → DROP FOREIGN KEY → one
  ALTER (drops, CHANGE/MODIFY COLUMN, FIRST/AFTER positions, adds, keys, checks, comment) → ADD FOREIGN KEY;
  non-transactional (warned). FULLTEXT/SPATIAL/functional indexes and the FK's own index are not part of the model.
  RESTRICT = NO ACTION. Views: CREATE / CREATE OR REPLACE / RENAME TABLE.
- Plans (`MySqlPlanReader`): estimated `EXPLAIN FORMAT=JSON`; actual MySQL 8.0.18+ `EXPLAIN ANALYZE` (TREE parser),
  MariaDB `ANALYZE FORMAT=JSON`, older MySQL estimates only. Queries run twice in actual mode (rows + plan).
- Logs (`engine/src/DbStudio.Logs/Providers/MySql/MySqlLogSource.cs`, keyed under both ids from `MySqlModule`):
  `error_log` (performance_schema.error_log, MySQL 8.0.22+), `general_log` / `slow_log` (tables when log_output has
  TABLE), `innodb_status` (one entry per section), activity (PROCESSLIST + lock waits from data_lock_waits /
  INNODB_LOCK_WAITS) with KILL / KILL QUERY; privilege probing returns the exact GRANT in `needs`.
- Core labelled blocks: `StatementClassifier.ClassifyMySql` (SHOW/DESC/HELP, EXPLAIN [ANALYZE], START TRANSACTION /
  BEGIN / BEGIN NOT ATOMIC, ROLLBACK TO SAVEPOINT, XA, CALL, LOCK/UNLOCK TABLES, LOAD DATA, RENAME TABLE, DEFINER /
  ALGORITHM / SQL SECURITY / AGGREGATE modifiers, events as procs), `SqlTokenizer.StartsBlock` (routine bodies),
  `SearchSql` (regex predicate for MariaDB too; json/uuid/inet text expressions).
- Seeds: `engine/tests/docker/seed-mysql.sql` (+ `seed-mariadb.sql`), README section "MySQL / MariaDB (WP-MY)".

**UI**: lazy `mysql` dialect chunk (keywords, functions JSON with MariaDB/MySQL tags, system catalog, lexer hook,
DELIMITER-aware splitter, formatter rules), codegen type map, designer/ER/codegen WP-MY blocks, mock pack with a MySQL
and a MariaDB connection (folder "Batch 3"), fixture `shop-mysql.json`, tests. Details in the UI section below.

## Deviations from the plan

1. **GuidFormat None** instead of Char36: with Char36 every CHAR(36) column is read as a Guid and a non-GUID value in
   one fails the whole result set.
2. **No MySqlBatch**: MySqlConnector 2.4.0 does not set `DbException.BatchCommand` and `MySqlBatchCommand.RecordsAffected`
   stays 0, so a batch's statements run one by one (`MySqlStatementReader`).
3. **Warnings via SHOW WARNINGS after each statement**: `MySqlConnection.InfoMessage` never fires in 2.4.0 and the
   driver does not expose warning counts. Like MySQL Workbench, every statement is followed by `SHOW WARNINGS` (one
   extra round trip). Side effect: `ROW_COUNT()` / `FOUND_ROWS()` in a *later* batch describe SHOW WARNINGS.
4. **Identifiers** `IdentifierRules(…, "preserve", …)` (the plan said "insensitive", which is not a value any reader
   knows); the UI spec uses its own `caseFolding: 'insensitive'`.
5. **Estimated plans without values** bind NULL like the old PostgreSQL path; for `col = :p` on a key MySQL then answers
   "Impossible WHERE" (no generic plans exist). With values the plan is real.
6. No MySQL module endpoints (nothing MySQL-specific needs its own route); `api/m3/mysql.ts` stays empty.
7. `ShopSchema.Seed` keeps the WP0 placeholder in the WP-MY block: the fixtures seed from the docker scripts
   (`SeedOnInitialize => false`). `DesignerCases` keeps PascalCase names for MySQL (case is preserved on Linux).

## Requests (R3)

### R3-E1 engine/src/DbStudio.Core/Sql/SqlTokenizer.cs:330-338 — MySQL compound statements in the shared splitter
Reason: for MySQL routine bodies (`StartsBlock` returns true for them since WP-MY), `IF`/`LOOP`/`WHILE`/`REPEAT` only
open a level for PL/SQL, but `END IF` / `END LOOP` / `END WHILE` / `END REPEAT` always close one, so
`BEGIN IF a THEN …; END IF; … END` splits after `END IF;`. Execution is not affected (the session splits with
`MySqlSqlText`), but `StatementClassifier.Classify(…, Dialect.MySql)` (read-only guard, history labels, catalog
invalidation) sees extra statements.
```diff
-                if (u is "BEGIN" || (u is "CASE" && !PrevIsEnd(tokens, k)) || (u is "IF" or "LOOP" && dialect == Dialect.PlSql && !PrevIsEnd(tokens, k)))
+                if (u is "BEGIN" || (u is "CASE" && !PrevIsEnd(tokens, k)) || (u is "IF" or "LOOP" && dialect == Dialect.PlSql && !PrevIsEnd(tokens, k))
+                    || (dialect == Dialect.MySql && u is "IF" or "LOOP" or "WHILE" or "REPEAT" && !PrevIsEnd(tokens, k)
+                        && !(k + 1 < tokens.Count && tokens[k + 1].IsPunct('(')) && (k == 0 || tokens[k - 1].IsPunct(';') || tokens[k - 1].Kind == SqlTokenKind.Word && tokens[k - 1].Upper is "BEGIN" or "THEN" or "ELSE" or "DO" or "LOOP" or "REPEAT" || tokens[k - 1].Value == ":")))
                     blockDepth++;
@@
-                    if (k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "IF" or "LOOP" or "CASE")
+                    if (k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "IF" or "LOOP" or "CASE" or "WHILE" or "REPEAT")
                         k++;
```

### R3-Q1 ui/src/lib/sql.ts:24-43 — backtick quoting for MySQL (high priority)
Reason: `quoteIdent` falls back to `"…"` for every dialect but T-SQL; in MySQL's default sql_mode `"order"` is a string,
so generated SQL for reserved or unusual names (`SELECT * FROM "order"`, data edits, filters, copy-as-INSERT, Select
top) fails or compares to a literal. ClickHouse needs the same.
```diff
+const MYSQL_RESERVED = new Set('ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY CALL CASCADE CASE CHANGE CHAR CHARACTER CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS CUBE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DATABASES DEC DECIMAL DECLARE DEFAULT DELAYED DELETE DESC DESCRIBE DETERMINISTIC DISTINCT DIV DOUBLE DROP DUAL EACH ELSE ELSEIF ENCLOSED ESCAPED EXCEPT EXISTS EXIT EXPLAIN FALSE FETCH FLOAT FOR FORCE FOREIGN FROM FULLTEXT FUNCTION GENERATED GET GRANT GROUP GROUPS HAVING IF IGNORE IN INDEX INNER INOUT INSERT INT INTEGER INTERSECT INTERVAL INTO IS ITERATE JOIN KEY KEYS KILL LATERAL LEADING LEAVE LEFT LIKE LIMIT LINEAR LINES LOAD LOCK LONG LOOP MATCH MOD NATURAL NOT NULL NUMERIC OF ON OPTIMIZE OPTION OR ORDER OUT OUTER OVER PARTITION PRECISION PRIMARY PROCEDURE PURGE RANGE RANK READ READS REAL RECURSIVE REFERENCES REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN REVOKE RIGHT RLIKE ROW ROWS SCHEMA SELECT SET SHOW SIGNAL SMALLINT SPATIAL SQL STARTING STORED STRAIGHT_JOIN SYSTEM TABLE TERMINATED THEN TO TRAILING TRIGGER TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING VALUES VARBINARY VARCHAR VIRTUAL WHEN WHERE WHILE WINDOW WITH WRITE XOR'.split(' '));
 export function needsQuoting(name: string, dialect: Dialect): boolean {
@@
   const up = name.toUpperCase();
-  return dialect === 'tsql' ? TSQL_RESERVED.has(up) : COMMON_RESERVED.has(up);
+  return dialect === 'tsql' ? TSQL_RESERVED.has(up) : dialect === 'mysql' ? MYSQL_RESERVED.has(up) || COMMON_RESERVED.has(up) : COMMON_RESERVED.has(up);
 }
 export function quoteIdent(name: string, dialect: Dialect, force = false): string {
   if (!force && !needsQuoting(name, dialect)) return name;
   if (dialect === 'tsql') return `[${name.replace(/]/g, ']]')}]`;
+  if (dialect === 'mysql' || dialect === 'clickhouse') return '`' + name.replace(/`/g, '``') + '`';
   return `"${name.replace(/"/g, '""')}"`;
 }
```
(`designer/rewrite.ts:202 quote()` and `intel/complete/format.ts quoteIdent(name, open)` already take the spec's quote.)

### R3-F4 ui/src/filter/sql.ts:71 and :78 — server-side filters on MySQL (high priority)
Reason: `'%' || @p || '%'` is a logical OR in MySQL (unless PIPES_AS_CONCAT), and `ESCAPE '\'` is an unterminated
string literal there (backslash escapes): every *contains / starts with / ends with* filter fails.
```diff
 const LIKE_ESCAPE = "ESCAPE '\\'";
+/** MySQL reads '\' as an escape inside string literals: the escape character is written '\\'. */
+const likeEscape = (d: Dialect) => (d === 'mysql' ? "ESCAPE '\\\\'" : LIKE_ESCAPE);
 function concat(dialect: Dialect, parts: string[]): string {
-  return dialect === 'tsql' ? parts.join(' + ') : parts.join(' || ');
+  if (dialect === 'mysql') return `CONCAT(${parts.join(', ')})`;
+  return dialect === 'tsql' ? parts.join(' + ') : parts.join(' || ');
 }
```
and use `likeEscape(d)` instead of `LIKE_ESCAPE` at the two LIKE sites (lines ~191 and ~197). Case-insensitive
comparisons can keep `lower()`; booleans `= 1` / `= 0` are right for MySQL.

### R3-D1 ui/src/data/sqlgen.ts:327-333 and :360 — inserts and the edit savepoint on MySQL
Reason: the default (SQLite) branch emits `INSERT INTO t DEFAULT VALUES` (MySQL: `INSERT INTO t () VALUES ()`) and the
follow-up `SELECT last_insert_rowid()` (MySQL: `LAST_INSERT_ID()`); a new row's generated key never comes back.
MySQL also has `RELEASE SAVEPOINT`.
```diff
+  } else if (dialect === 'mysql') {
+    sql = values.length ? `INSERT INTO ${table} (${cols}) VALUES (${vals})` : `INSERT INTO ${table} () VALUES ()`;
+    if (ret.length === 1) followUp = `SELECT LAST_INSERT_ID() AS ${q(ret[0])}`;
   } else {
@@
 export function releaseSavepointSql(dialect: Dialect, name = EDIT_SAVEPOINT): string | null {
-  return dialect === 'sqlite' || dialect === 'pgsql' ? `RELEASE SAVEPOINT ${name}` : null;
+  return dialect === 'sqlite' || dialect === 'pgsql' || dialect === 'mysql' ? `RELEASE SAVEPOINT ${name}` : null;
 }
```

### R3-T1 ui/src/designer/proc/templates.ts:232 — MySQL routine templates
Reason: "New procedure / function / trigger" on MySQL falls through to the SQLite trigger template.
```diff
   if (dialect === 'pgsql') return pgSnippet(spec, name, s);
+  if (dialect === 'mysql') return mysqlSnippet(spec, name, s);
@@
+/** MySQL / MariaDB: BEGIN … END bodies (the console keeps them whole without DELIMITER); one event per trigger. */
+function mysqlSnippet(spec: WizardSpec, name: string, s: Stops): string {
+  const q = (n: string) => lit(quoteIdent(n, 'mysql'));
+  const full = spec.schema ? `${q(spec.schema)}.${s.stop(name)}` : s.stop(name);
+  const params = spec.params.map((p) => `${spec.kind === 'procedure' ? `${p.direction.toUpperCase()} ` : ''}${lit(p.name.replace(/^[@:]/, ''))} ${s.stop(p.type)}`).join(', ');
+  if (spec.kind === 'procedure')
+    return [`CREATE PROCEDURE ${full}(${params})`, 'BEGIN', '    ${0:SELECT 1;}', 'END;', ''].join('\n');
+  if (spec.kind === 'function') {
+    const ret = spec.returns || DEFAULT_RETURN_TYPE.mysql;
+    return [`CREATE FUNCTION ${full}(${params})`, `RETURNS ${s.stop(ret)}`, 'DETERMINISTIC', 'BEGIN', `    DECLARE v_result ${lit(ret)};`,
+      '    ${0:SET v_result = NULL;}', '    RETURN v_result;', 'END;', ''].join('\n');
+  }
+  const t = spec.trigger ?? { table: 'table_name', timing: 'BEFORE', events: ['INSERT'], forEachRow: true };
+  const table = spec.schema ? `${q(spec.schema)}.${s.stop(t.table)}` : s.stop(t.table);
+  return [`CREATE TRIGGER ${full}`, `${t.timing} ${t.events[0] ?? 'INSERT'} ON ${table}`, 'FOR EACH ROW', 'BEGIN',
+    '    ${0:-- NEW / OLD hold the row values}', 'END;', ''].join('\n');
+}
```
plus `kindsFor('mysql')` unchanged (procedure, function, trigger), `triggerTimings('mysql')` = BEFORE/AFTER (already),
and the trigger events picker limited to one event for MySQL (it has no `INSERT OR UPDATE`).

### UI requests from the UI half (details, diffs and tests: below)
R3-F1 (format/index.ts: DELIMITER lines as chunks), R3-F2 (format/layout.ts: routine bodies verbatim), R3-F3
(layout.ts: ON DUPLICATE KEY UPDATE, INSERT … SET, REPLACE, INSERT IGNORE), R3-C1 (codegen/types/index.ts:
unsigned / tinyint(1) / char(36)), **R3-P1 (ParamsDialog/detect.ts, editor/param-hint.ts: `@user` / `@@sys`
variables are not binds — today F5 on `SET @n := 0` opens the Parameters dialog)**, R3-I1 (`@@` completion), R3-I2
(`IF(` signature help), R3-S1 (snippet picker), R3-M1 (mocks/engine.ts: MySQL-flavoured mock shop; stub
`TODO(WPMY-shared)`).

---

## UI half (from the UI work, verbatim)

All file:line references are at the WP0 commit `686056e`. Every local stub is findable with `TODO(WPMY-shared)` (only one:
`ui/src/mocks/packs/mysql.ts`); the other requests have no stub because nothing in WP-MY's files can work around them —
the behaviour without them is described under "Until then".

### What the UI half delivers

- `intel/dialect/mysql.ts` (lazy chunk, `define(kit)`, runtime imports only `lexer/traits` + own files + JSON):
  MySQL 8 / MariaDB reserved words (type names and the MySQL-8-only window/function words such as RANK, ROW_NUMBER,
  LAG, CUBE, GROUPING, ROWS, SYSTEM stay identifiers: common column names on MariaDB/5.7 schemas; END, DUPLICATE,
  ROLLUP are keywords), contextual words, statement starts (SHOW, DESCRIBE/DESC, EXPLAIN, USE, CALL, START, BEGIN,
  HANDLER, LOCK/UNLOCK, REPLACE, LOAD, OPTIMIZE/ANALYZE/CHECK/REPAIR, KILL, FLUSH, XA, PREPARE/EXECUTE/DEALLOCATE …),
  data types incl. unsigned/bit/enum/json/spatial and MariaDB INET4/INET6/UUID/VECTOR, `quote` backticks,
  `caseFolding: 'insensitive'`, ops2/ops3 (`<=> := -> ->> << >> && ||`), snippets (incl. proc/fn/trg/evt/delim/tx),
  `systemCatalog` (`data/mysql-system.json`: 24 information_schema, 13 performance_schema, 7 mysql, 5 sys tables,
  4 KB gz), `classify` hook, `split`, `formatRules`.
  Lexer hook = `traitLexer({ backtickIdent, hashComment, backslashEscapes, paramPrefixes '@:?', hexNumbers,
  stringPrefixes 'NXB' })` plus MySQL tokens: `DELIMITER xx` at a line start → one `meta` token; `$$` and `//` → one
  `op` token (identifiers stop before `$$`, so `END$$` = END + `$$`); `\G`/`\g` → one `op` token; `"…"` → string
  (default sql_mode; backslash escapes, `""`; no line-mode resume state, an unterminated multi-line `"…"` colours only
  its first line); `_utf8mb4'…'` → one string; `lbl:BEGIN` → label colon, not a `:BEGIN` parameter.
- `data/mysql-functions.json`: 303 built-ins (string, math, datetime, json, aggregate, window, control, conversion,
  system, encryption, spatial, misc) + 40 `@@system variables` (kind `global`) + operator docs. MySQL-only functions
  carry `since: "MySQL 8.0"` / `"MySQL 5.7"`, MariaDB-only ones `since: "MariaDB 10.x / 11.x"` (shown as "Since …" in
  completion docs). Only CURRENT_DATE/TIME/TIMESTAMP, LOCALTIME[STAMP], UTC_*, CURRENT_USER are `niladic` (inserted
  without parens); DATABASE(), USER(), VERSION(), UUID(), PI() … insert `()`.
- `split/mysql.ts`: DELIMITER (any non-space delimiter: `$$`, `//`, `;;`, `|`, words), raw-text match outside
  strings/comments/backticks like the mysql client, DELIMITER lines produce **no statement**; `DELIMITER ;` restores;
  without DELIMITER compound statements stay whole (CREATE [DEFINER=…] [AGGREGATE] PROCEDURE/FUNCTION/TRIGGER/EVENT,
  ALTER EVENT … DO, MariaDB BEGIN NOT ATOMIC / IF / CASE / LOOP / REPEAT / WHILE / `lbl:` at top level; nesting of
  BEGIN/IF/CASE/LOOP/WHILE/REPEAT with END [IF|CASE|LOOP|WHILE|REPEAT] [label]; IF/REPEAT/WHILE/LOOP open a block only in
  statement position so `IF(` / `REPEAT(` functions and `IF [NOT] EXISTS` clauses don't); top-level `BEGIN;` /
  `BEGIN WORK` = transaction; `\G`/`\g` and a stray `$$`/`//` terminate like `;`. A non-`;` terminator is excluded from
  `text` but included in `[start, end]`/`endLine`/`endCol`, so Ctrl+Enter right after `END$$` runs the routine
  (`gapIsTrailing` only accepts `;`). One statement = one batch.
- `format/rules/mysql.ts`: statement starts / incomplete / function keywords (IF, REPLACE, LEFT, RIGHT, INSERT, MOD,
  REPEAT, MATCH … glued to `(`) / operand keywords. Works today: backticks, `LIMIT m, n`, `LIMIT n OFFSET m`,
  STRAIGHT_JOIN as a join, index hints, FOR UPDATE, WITH ROLLUP, `->`/`->>` unspaced, `:= <=> DIV MOD XOR`, `#`
  comments, `"…"` strings. Everything else (ODKU, INSERT … SET, REPLACE, routines, DELIMITER) stays token-identical but
  needs R3-F1..F3 to look right.
- `codegen/types/mysql.json` (types → C#/Go/TS/Java/Python, MySqlConnector semantics: tinyint → sbyte, TIME →
  TimeSpan, YEAR → int, BIT(n) → ulong, ENUM/SET → string, JSON → json, spatial → byte[], MariaDB UUID → Guid,
  `tinyint(1)`/`bit(1)` → bool, `char(36)` → Guid, `<int> unsigned` → uint/ulong (these last keys need R3-C1)).
- WP-MY blocks: model.ts DEFAULT_COLUMN_TYPE `varchar(255)` (key `int`), TableDesigner FALLBACK_TYPES (30 MySQL
  types), templates `int`/`int`, fkDialog (NO ACTION, RESTRICT, CASCADE, SET NULL; no SET DEFAULT), csharp
  `MySqlConnector` (`@` prefix), typescript `mysql2/promise` — the last four kept as WP0 seeded them (already right).
  EditorPlayground: MySQL sample with backticks, `#`, `@vars`, `->>`, `\G`, ODKU and a DELIMITER-wrapped procedure
  (dev-only: not in the production bundle).
- `mocks/packs/mysql.ts`: providers `mysql` "MySQL" and `mariadb` "MariaDB" (dialect `mysql`, kind `relational`, the
  engine's form spec field for field), connections `c_mysql` + `c_mariadb` (folder "Batch 3", host `mariadb-dev`),
  extraObjects for both ids (view `customer_totals`, `fn_tax`, `get_customer`, `get_customer_report`,
  `add_order_line`, event `ev_purge_notes` as `proc` with comment "event", trigger `trg_orders_check`; MariaDB also
  sequence `order_numbers`). ProviderInfo has no capability flags (only id/displayName/dialect/kind/formSpec), so
  "hasDatabases: false" is the engine's business (`schemaIsDatabase('mysql'|'mariadb')` already true in the UI).
  `npm test` with the pack active: green (2 suites timed out under full parallel load — see Tests — and pass alone);
  no existing test depends on the connection list.
- `intel/__tests__/fixtures/shop-mysql.json`: the shop as the engine will return it (database null, defaultSchema
  `shop`, schemas `shop` + `archive` (one table, to test cross-database refs), COLUMN_TYPE spellings, AUTO_INCREMENT
  as identity, comments, FKs, views, routines, event, trigger).
- `api/m3/mysql.ts` unchanged (no module endpoints).

### Requests

#### R3-F1 ui/src/format/index.ts:76 and :92 and :323 — DELIMITER lines and custom delimiters as chunks
Reason: chunks are cut at statement ends; a DELIMITER line (a `meta` token that is no statement) becomes the head of
the next statement's chunk and the layout indents that whole statement (`DELIMITER $$⏎    CREATE PROCEDURE …`), and the
`$$` / `\G` after a statement lands at the head of the next chunk (`END⏎⏎$$`; with `DELIMITER ;` on the next line the
layout check fails and that piece stays verbatim with a warning). Semantics are preserved today (the safety check
compares tokens and the `meta` token needs a line start), only the layout is wrong.
Proposed diff:
```diff
@@ function chunksOf(tokens: Token[], text: string, dialect: Dialect): Chunk[] {
   const ends: number[] = []; // exclusive token index where a chunk ends (statements)
   for (const st of split.statements) ends.push(st.tokEnd);
+  const starts = split.statements.map((st) => st.tokStart);
@@
-    if (t.kind === 'batchSep') {
+    // GO / `/` lines, and MySQL `DELIMITER xx` lines (meta tokens that are no statement): separator chunks
+    if (t.kind === 'batchSep' || (t.kind === 'meta' && dialect === 'mysql')) {
@@
       for (;;) {
         while (b < n && tokens[b].kind === 'punct' && tokens[b].text === ';') b++;
+        // MySQL: a custom delimiter (`$$`, `//` …) or `\G` right after the statement, before the next one, stays with it
+        while (dialect === 'mysql' && b < n && tokens[b].kind !== 'comment' && tokens[b].kind !== 'meta' && (si + 1 >= starts.length || b < starts[si + 1]) && countNewlines(text, tokens[b - 1].end, tokens[b].start) === 0) b++;
         if (b < n && tokens[b].kind === 'comment' && countNewlines(text, tokens[b - 1].end, tokens[b].start) === 0) { b++; continue; }
@@ formatSql
     if (c.sep) {
-      emit(c, tokens.slice(c.a, c.b).map((t, i) => (i === 0 ? applyCase(t.text, opts.keywordCase) : ' ' + t.text)).join(''));
+      emit(c, tokens[c.a].kind === 'meta'
+        ? text.slice(tokens[c.a].start, tokens[c.b - 1].end) // DELIMITER lines verbatim (the delimiter is case-sensitive)
+        : tokens.slice(c.a, c.b).map((t, i) => (i === 0 ? applyCase(t.text, opts.keywordCase) : ' ' + t.text)).join(''));
       continue;
     }
```
Test to enable: `it.todo` "DELIMITER lines are chunks of their own …" in `ui/src/format/__tests__/mysql.test.ts`.

#### R3-F2 ui/src/format/layout.ts:497-502 (+ a method next to sqliteStatement :963) — MySQL routine bodies verbatim
Reason: the layout has no MySQL block grammar; the SQLite path reflows `CREATE PROCEDURE … BEGIN … END` into
`CREATE PROCEDURE p () BEGIN DECLARE x INT DEFAULT 0;⏎IF a > 0 THEN SELECT 1;⏎END IF;⏎END;` (token-identical, ugly).
Keep compound statements verbatim like PostgreSQL dollar bodies until a real MySQL block layout exists.
Proposed diff:
```diff
   private statement(indent: number, outer: Stop): void {
     if (this.d === 'tsql') this.tsqlStatement(indent, outer);
     else if (this.d === 'plsql') this.plStatement(indent, outer);
     else if (this.d === 'pgsql') this.pgStatement(indent, outer);
+    else if (this.d === 'mysql') this.mysqlStatement(indent, outer);
     else this.sqliteStatement(indent, outer);
   }
+
+  /**
+   * MySQL / MariaDB: DELIMITER lines as they are; routines (CREATE [DEFINER = …] … PROCEDURE | FUNCTION | TRIGGER |
+   * EVENT, ALTER EVENT) and top-level compound statements (BEGIN NOT ATOMIC, IF, CASE, LOOP, REPEAT, WHILE, `lbl:`)
+   * verbatim, like PostgreSQL dollar bodies; everything else takes the SQLite path.
+   */
+  private mysqlStatement(indent: number, outer: Stop): void {
+    const k = this.p;
+    if (this.S(k)!.kind === 'meta') { this.take(); return; }
+    const u = this.U(k);
+    let compound = ['IF', 'CASE', 'LOOP', 'REPEAT', 'WHILE'].includes(u) || (u === 'BEGIN' && this.W(k + 1, 'NOT'))
+      || (this.S(k)!.kind === 'ident' && this.U(k + 1) === ':');
+    if (u === 'CREATE' || u === 'ALTER') {
+      for (let j = k + 1; j < this.sig.length && j <= k + 24 && !this.P(j, ';'); j++) {
+        const w = this.U(j);
+        if (w === 'PROCEDURE' || w === 'FUNCTION' || w === 'TRIGGER' || w === 'EVENT') { compound = u === 'CREATE' || w === 'EVENT'; break; }
+        if (w === 'TABLE' || w === 'VIEW' || w === 'INDEX' || w === 'DATABASE' || w === 'SCHEMA' || w === 'USER') break;
+      }
+    }
+    if (!compound) return this.sqliteStatement(indent, outer);
+    let e = this.sig.length; // a MySQL chunk is one statement (plus its terminator)
+    while (e > k + 1 && this.P(e - 1, ';')) e--;
+    this.takeRaw(e, this.srcText);
+    while (this.P(this.p, ';')) this.take({ space: false });
+  }
```
(`srcText` is set through `setSource`, as `plStatement` uses it.) Test to enable: the second `it.todo`.

#### R3-F3 ui/src/format/layout.ts:1173, :1175, :1191, :1272, :54 — MySQL clauses and DDL words
Reason: `ON DUPLICATE KEY UPDATE` stays on the VALUES line and the `VALUES(b)` inside it starts a new VALUES clause
(`… UPDATE b =⏎VALUES⏎    (b)`); `INSERT … SET` and `REPLACE INTO` are not laid out as INSERTs; `INSERT IGNORE INTO` takes
IGNORE as the target; `auto_increment`, `engine`, `charset`, `comment` table/column options keep the typed case.
Proposed diff:
```diff
-      case 'VALUES': return v.has('INSERT') && !this.W(k - 1, 'DEFAULT') ? ['values', 1] : null;
+      case 'VALUES': return v.has('INSERT') && !this.W(k - 1, 'DEFAULT') && !(this.d === 'mysql' && (this.S(k - 1)?.kind === 'op' || this.P(k - 1, '(') || this.P(k - 1, ','))) ? ['values', 1] : null;
-      case 'SET': return v.has('UPDATE') && st.clause !== 'set' ? ['set', 1] : null;
+      case 'SET': return (v.has('UPDATE') || (this.d === 'mysql' && v.has('INSERT') && st.clause === 'insert')) && st.clause !== 'set' ? ['set', 1] : null;
-      case 'ON': return (this.d === 'sqlite' || this.d === 'pgsql') && this.W(k + 1, 'CONFLICT') && v.has('INSERT') ? ['conflict', 2] : null;
+      case 'ON':
+        if (this.d === 'mysql' && v.has('INSERT') && this.W(k + 1, 'DUPLICATE') && this.W(k + 2, 'KEY') && this.W(k + 3, 'UPDATE')) return ['set', 4];
+        return (this.d === 'sqlite' || this.d === 'pgsql') && this.W(k + 1, 'CONFLICT') && v.has('INSERT') ? ['conflict', 2] : null;
@@ statementHead
-        if (u === 'REPLACE' && this.d !== 'sqlite') { this.takeKw(); return; }
+        if (u === 'REPLACE' && this.d !== 'sqlite' && this.d !== 'mysql') { this.takeKw(); return; }
         this.enterDml(st, 'INSERT');
         this.takeKw();
+        while (this.d === 'mysql' && ['IGNORE', 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY'].includes(this.U(this.p))) this.takeKw();
@@ contextualKw (DDL words), after the DDL_WORDS test
+    if (this.d === 'mysql' && (this.verbCtx === 'CREATE' || this.verbCtx === 'ALTER') && MYSQL_DDL_WORDS.has(t.u)) {
+      const pt = this.S(k - 1);
+      return !!pt && !(pt.kind === 'punct' && (pt.text === '(' || pt.text === ',')) && !(pt.word && NAME_PAREN_KEYWORDS.has(pt.u));
+    }
+const MYSQL_DDL_WORDS = set('AUTO_INCREMENT ENGINE CHARSET CHARACTER COMMENT ROW_FORMAT ALGORITHM INVISIBLE VISIBLE FIRST AFTER MODIFY CHANGE');
```
Test to enable: the third `it.todo`.

#### R3-C1 ui/src/codegen/types/index.ts:190 (after the T-SQL decimal block) — MySQL type spellings
Reason: `parseTypeText` strips `unsigned` and the size, so `bigint unsigned` reads as signed `long`, `tinyint(1)` /
`bit(1)` (MySqlConnector: bool) as `sbyte`/`ulong`, `char(36)` (MySqlConnector GuidFormat=Char36: Guid) as string.
mysql.json already carries the keys.
Proposed diff:
```diff
   if (dialect === 'tsql' && (rawBase === 'decimal' || rawBase === 'numeric') && precision === null) {
     precision = 18;
     scale = 0;
   }
+  // MySQL: UNSIGNED integers, TINYINT(1) / BIT(1) as bool and CHAR(36) as Guid (MySqlConnector defaults)
+  if (dialect === 'mysql') {
+    const unsigned = /\bunsigned\b/i.test(typeText) ? `${rawBase} unsigned` : '';
+    if (unsigned && tbl[unsigned]) base = unsigned;
+    else if ((rawBase === 'tinyint' && args[0] === '1') || (rawBase === 'bit' && (args.length === 0 || args[0] === '1'))) base = `${rawBase}(1)`;
+    else if (rawBase === 'char' && args[0] === '36') base = 'char(36)';
+  }
```

#### R3-P1 ui/src/components/ParamsDialog/detect.ts:18-27 and :73-78 — MySQL user / system variables are not binds
Reason: `@x` (user variables) and `@@x` (system variables) are lexed as `param` (paramPrefixes `@`, as WP0 specified),
so F5 on `SET @n := 0; SELECT @n := @n + 1 …` opens the Parameters dialog for `@n` (seen in dev:mock). The engine binds
`@name` only when a value is supplied, but the dialog should not ask; `:name` and `?` stay binds. Routine definitions
with a DEFINER clause are not recognised as definitions either.
Proposed diff:
```diff
 function isDefinition(toks: Token[]): boolean {
   const i = toks[0]?.upper === 'CREATE' ? 1 : -1;
   if (i < 0) return false;
   let j = i;
   if (toks[j]?.upper === 'OR') j += 2; // OR REPLACE / OR ALTER
+  // MySQL: CREATE DEFINER = user@host | CURRENT_USER[()] [AGGREGATE] …
+  if (toks[j]?.upper === 'DEFINER') { while (j < toks.length && !/^(PROCEDURE|FUNCTION|TRIGGER|EVENT|VIEW|AGGREGATE)$/.test(toks[j].upper)) j++; }
+  if (toks[j]?.upper === 'AGGREGATE') j++;
   const what = toks[j]?.upper;
-  return what === 'PROCEDURE' || what === 'PROC' || what === 'FUNCTION' || what === 'TRIGGER' || what === 'PACKAGE' || what === 'TYPE';
+  return what === 'PROCEDURE' || what === 'PROC' || what === 'FUNCTION' || what === 'TRIGGER' || what === 'PACKAGE' || what === 'TYPE' || what === 'EVENT';
 }
@@
+        } else if (dialect === 'mysql') {
+          if (text.startsWith('@')) continue; // @user_var / @@sysvar: variables, not binds
+          if (text === '?') add(String(++positional), '?', true, true);
+          else add(text.slice(1), text);
         } else {
```
Same in `ui/src/editor/param-hint.ts:53` (the "n parameters · Ctrl+Alt+P" hint):
```diff
     if (dialect === 'tsql' && (text.startsWith('@@') || declared.has(text.toUpperCase()))) continue;
+    if (dialect === 'mysql' && text.startsWith('@')) continue;
```

#### R3-I1 ui/src/intel/complete/completer.ts:306 — `@@` completion for MySQL
Reason: mysql-functions.json lists 40 `@@system_variables` (kind `global`), offered only after `@` for T-SQL.
```diff
-  } else if (c.prefix.startsWith('@') && env.spec.id === 'tsql') {
-    variableItems(items, c, env, 9);
+  } else if (c.prefix.startsWith('@') && (env.spec.id === 'tsql' || env.spec.id === 'mysql')) {
+    if (env.spec.id === 'tsql') variableItems(items, c, env, 9);
     globalVarItems(items, c, env);
```

#### R3-I2 ui/src/intel/context/context.ts:62 — signature help for MySQL `IF(`
Reason: `IF` is in `NOT_FUNCTION_BEFORE_PAREN`, so `SELECT IF(a, |` gets no signature help (hover works).
```diff
-        if (nameTok.kind === 'keyword' && NOT_FUNCTION_BEFORE_PAREN.has(nameTok.upper)) return null;
+        // MySQL IF(cond, a, b) is a function unless it starts a statement (IF (x) THEN … in routine bodies)
+        const prevTok = toks[b - 2];
+        const mysqlIfCall = spec.id === 'mysql' && nameTok.upper === 'IF' && !!prevTok && prevTok.text !== ';' && !['BEGIN', 'THEN', 'ELSE', 'DO'].includes(prevTok.upper);
+        if (nameTok.kind === 'keyword' && NOT_FUNCTION_BEFORE_PAREN.has(nameTok.upper) && !mysqlIfCall) return null;
```

#### R3-S1 ui/src/snippets/builtins.ts:20 and :60-86 — MySQL snippets
Reason: `DialectSpec.snippets` is not read by anything; the snippet picker uses `BUILTIN_SNIPPETS`. Add a group
(mirrors `SNIPPETS` in intel/dialect/mysql.ts):
```diff
 const P: Dialect[] = ['pgsql'];
+const M: Dialect[] = ['mysql'];
@@ before `];`
+  // MySQL / MariaDB (plan-batch3 WP-MY; mirrored in intel/dialect/mysql.ts)
+  def('tbl', 'CREATE TABLE (InnoDB)', M, 'CREATE TABLE ${1:name} (\n\t${2:id} INT NOT NULL AUTO_INCREMENT,\n\t${3:name} VARCHAR(100) NOT NULL,\n\tPRIMARY KEY (${2:id})\n) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;$0'),
+  def('upsert', 'INSERT … ON DUPLICATE KEY UPDATE', M, 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})\nON DUPLICATE KEY UPDATE ${4:column} = VALUES(${4:column})$0'),
+  def('proc', 'CREATE PROCEDURE', M, 'CREATE PROCEDURE ${1:name}(IN ${2:p_id} INT)\nBEGIN\n\t$0\nEND;'),
+  def('fn', 'CREATE FUNCTION', M, 'CREATE FUNCTION ${1:name}(${2:p_id} INT)\nRETURNS ${3:INT}\nDETERMINISTIC\nBEGIN\n\tDECLARE v_result ${3:INT};\n\t$0\n\tRETURN v_result;\nEND;'),
+  def('trg', 'CREATE TRIGGER', M, 'CREATE TRIGGER ${1:trg_name}\n${2:BEFORE} ${3:INSERT} ON ${4:table}\nFOR EACH ROW\nBEGIN\n\t$0\nEND;'),
+  def('evt', 'CREATE EVENT', M, 'CREATE EVENT ${1:ev_name}\nON SCHEDULE EVERY ${2:1} ${3:DAY}\nDO\nBEGIN\n\t$0\nEND;'),
+  def('delim', 'DELIMITER $$ … DELIMITER ;', M, 'DELIMITER \\$\\$\n\n$0\n\nDELIMITER ;'),
+  def('tx', 'Transaction', M, 'START TRANSACTION;\n$0\nCOMMIT;'),
```

#### R3-M1 ui/src/mocks/engine.ts:25, :112-121, :145-148, :153-162 (+ ui/src/mocks/packs/types.ts:16) — MySQL-flavoured mock shop
Reason: pack providers get the SQLite shop in a schema named `main` with SQLite types, a "SQLite 3.46.1" banner and no
`DIALECT` entry (session and catalog `dialect` undefined; the console still works because the UI takes the dialect
from ProviderInfo). Local stub: `TODO(WPMY-shared)` in mocks/packs/mysql.ts.
Proposed change (generic, every pack can use it):
```diff
 // mocks/packs/types.ts
 export interface MockProviderPack {
   …
   handlers(ctx: M2MockContext): RequestHandler[];
+  /** Optional per provider id: shop schema name (default `main`), SQLite type → native type, server banner. */
+  shop?: Record<string, { schema: string; type?: (sqliteType: string) => string; serverInfo?: { version: string; productVersion: string } }>;
 }
 // mocks/engine.ts
-const DIALECT: Record<string, Dialect> = { sqlserver: 'tsql', oracle: 'plsql', sqlite: 'sqlite', postgresql: 'pgsql' };
+const DIALECT: Record<string, Dialect> = {
+  sqlserver: 'tsql', oracle: 'plsql', sqlite: 'sqlite', postgresql: 'pgsql',
+  ...Object.fromEntries(MOCK_PACKS.flatMap((p) => p.providers).filter((p) => p.dialect).map((p) => [p.id, p.dialect!])),
+};
+const packShop = (pid: string) => MOCK_PACKS.map((p) => p.shop?.[pid]).find((x) => x);
@@ serverInfo
+    const ps = packShop(providerId);
+    if (ps?.serverInfo) return { ...ps.serverInfo, serverName: String(props.host ?? 'localhost'), user: String(props.user ?? ''), database: String(props.database || ps.schema) };
@@ schemasFor
-      make('main', SHOP_TABLES, packExtra ?? EXTRA_OBJECTS.sqlite);
+      const ps = packShop(pid);
+      const tables = ps?.type ? SHOP_TABLES.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c, type: ps.type!(c.type) })) })) : SHOP_TABLES;
+      make(ps?.schema ?? 'main', tables, packExtra ?? EXTRA_OBJECTS.sqlite);
@@ defaultSchema / databases
-    return pid === 'sqlserver' ? 'dbo' : pid === 'oracle' ? 'SHOP' : pid === 'postgresql' ? 'public' : 'main';
+    return pid === 'sqlserver' ? 'dbo' : pid === 'oracle' ? 'SHOP' : pid === 'postgresql' ? 'public' : packShop(pid ?? '')?.schema ?? 'main';
-    return { databases: ['main'], current: 'main' };
+    const s = packShop(pid ?? '')?.schema ?? 'main';
+    return { databases: [s], current: s };
```
WP-MY then adds to its pack: `shop: { mysql: { schema: 'shop', type: mysqlType, serverInfo: { version: '8.4.3', productVersion: '8.4.3' } }, mariadb: { schema: 'shop', type: mysqlType, serverInfo: { version: '11.4.4-MariaDB', productVersion: '11.4.4' } } }`
with `mysqlType` = INTEGER→int, TEXT→varchar(255), REAL→double, DECIMAL(p,s)→decimal(p,s), BOOLEAN→tinyint(1),
DATETIME→datetime, BLOB→blob, JSON→json (the fields would be inert until R3-M1 is merged, so they are not in the pack yet).

### Known gaps / notes for the orchestrator

- Selection runs (`Intel.batchesFor(uri, range)`, intel/index.ts:233) re-split only the selected text, so a selection
  that starts after a `DELIMITER ;;` / `DELIMITER |` line splits the routine at its inner `;`. `$$` and `//` work (the
  splitter treats a stray `$$`/`//` as a terminator). Fix would be to seed the splitter with the delimiter in effect at
  the range start (frozen intel/index.ts); not requested as R3 because the common delimiters already work.
- `SELECT * FROM json_table(…)` completion: table functions are offered in FROM only for PostgreSQL (completer).
- `"…"` is a string (default sql_mode); a server with `sql_mode=ANSI_QUOTES` (the `serverVariables` placeholder)
  reads it as an identifier — the UI cannot know the session sql_mode.
- `--` starts a comment even without the following space MySQL requires (`SELECT 1--1`); shared lexer behaviour.
- Function catalogue: 303 functions (23 tagged MariaDB, 26 tagged MySQL) + 40 variables; the mysql lazy chunk is 103 KB raw / 20.9 KB gzipped (functions
  ~11 KB, system catalog ~4 KB gz). Nothing of it is in the initial bundle.
- Initial bundle: the codegen type maps are in the initial `actions` chunk (codegen/types/index.ts imports every JSON),
  so `codegen/types/mysql.json` costs **+0.47 KB gzipped** of initial load (measured by swapping the table for the WP0
  stub in the built chunk). Total initial load after WP-MY UI: 1566.9 KB (WP0: 1566.4 KB) → **+0.5 KB**.
- Mock observation: the MySQL console in dev:mock showed negative run timers (`-58747 ms`) in the browser pane; not investigated (mock engine timing, not WP-MY code).

## Measurements and test results (WP-MY, final)

- **Initial load**: 1566.9 KB gzipped (WP0: 1566.4 KB) → **+0.5 KB** (all of it `codegen/types/mysql.json`, imported
  statically by `codegen/types/index.ts`); initial +114.7 KB of the +120 KB budget, total +758.0 KB of +1400 KB. The
  lazy `mysql` dialect chunk is 103 KB raw / 20.9 KB gzipped.
- **Engine**: one package (MySqlConnector 2.4.0, already in WP0's publish measurement); no native libraries.
- `dotnet test engine/DbStudio.slnx -c Release` with `DBSTUDIO_IT=0`: green (MySql.Tests 61 passed, 108 skipped).
- `DbStudio.Providers.MySql.Tests` against **mysql:8.4 and mariadb:11** (Testcontainers): **169 / 169 passed** —
  conformance ×2, M15 conformance ×2, provider integration ×2 (warnings, USE, cancel < 2 s, multi-result, CALL with
  OUT, DELIMITER scripts, error positions, types, transactions, read-only, catalog, DDL, dependencies, object list,
  search, plans, logs/activity/kill), unit tests and DDL goldens.
- End-to-end through the engine host (HTTP): providers listed, test connection, catalog, DDL, object list,
  dependencies, designer types/table, session execute incl. a DELIMITER script, `USE` via `/sessions/{sid}/database`,
  log sources and activity.
- UI: lint 0 errors; typecheck clean; `npm test` 165 files / 1992 passed (2 skipped, 3 todo); `npm run test:intel`
  19 files / 907 passed (3 todo); desktop `npm test` 119 passed.

## Known gaps

- The pending R3 items above (most visible: Q1 backtick quoting of reserved/odd names, F4 server-side contains
  filters, D1 insert key read-back, T1 routine templates, P1 `@var` in the Parameters dialog).
- Warnings cost one `SHOW WARNINGS` round trip per statement and reset `ROW_COUNT()` for a following batch.
- Estimated plans for `col = :p` without values plan for NULL ("Impossible WHERE").
- Index model: FULLTEXT / SPATIAL / functional indexes are shown but not editable in the designer; table options
  (ENGINE, CHARSET, ROW_FORMAT, partitions) are preserved by ALTERs but not editable (no fields in the shared model).
- MySQL transaction state is tracked from the statements typed (`START TRANSACTION`, `COMMIT`, DDL …); a procedure
  that starts a transaction internally is not detected (MariaDB uses `@@in_transaction` and is exact).
- BIT(n) values are shown as bit strings; editing them in the grid writes a string literal (use `b'…'` in SQL).
- MariaDB's error log is file-only: the Error log source is unavailable there.

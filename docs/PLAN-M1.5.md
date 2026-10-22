# Rowlit — M1.5 Feature Phase Specification

Builds directly on `docs/PLAN.md` (M1). Everything here is **additive**: no existing endpoint, DTO, WS event, `IDbProvider` member or `SqlEditorProps` member changes meaning. New engine capabilities are registered as **keyed DI services by provider id** (`DdlScripter`, `PlanReader`, `ParamBinder`) so `IDbProvider.cs` and the three provider classes are not edited while M1 is in flux. Section numbers continue PLAN.md: new endpoints are "section 3.7+", new settings are additive keys on `Settings`.

Naming observed in the repo and reused: `ui/src/store/ui.ts` already has `paletteMode: 'commands' | 'objects'` (quick object search plugs into it); `ui/src/lib/sql.ts` has `quoteIdent/qualifiedName/selectTopSql`; `ui/src/intel/types.ts` `Token` is the formatter's input; `engine/src/DbStudio.Core/Sql/SqlTokenizer.cs` exists for engine-side classification; `desktop/src/main/menu.ts` already binds **Ctrl+N = New Query Tab** and **Ctrl+Shift+N = New Connection** — M1.5 keeps those and uses **Ctrl+P** for quick object search (VS Code/DataGrip "Go to" muscle memory, no conflict).

---

## 0. Scope summary and priorities

| # | Requirement | Where it lives | Engine | UI |
|---|---|---|---|---|
| R1 | Simple, attractive UI; important things effortless | Section 3 design system + command registry | – | WP-J |
| R2 | Professional filtering (grid, explorer, history) | Section 1.1 | `/filters` store, `/sessions/{sid}/describe` | WP-G, WP-J |
| R3 | Formatter for all three dialects | Section 1.2 | none (renderer-side) | WP-H |
| R4 | Table/view/procedure designers + edit existing | Section 1.3 | designer endpoints + DDL scripters | WP-F, WP-I |
| R5 | Code generation for many languages | Section 1.4 | `/describe` | WP-I |
| R6 | Multiple connections used simultaneously | Section 1.5 | session limits, parallel catalog | WP-J |
| A1–A6 | Own additions (Section 2) | data editing, go-to-object, snippets, query parameters, explain plan, multi-connection run | WP-F | WP-G/H/J |

---

## 1. Requirements

### 1.1 Professional filtering

#### 1.1.1 Results grid filter

**Where/invoked.** A filter bar docked above the grid of every result set, hidden by default. Open with **Ctrl+F while the grid has focus**, the funnel toolbar button, or any "Quick filter" context-menu action on a cell. Closing (Esc or the ✕) **keeps** the filter active, shown as a chip in the status row ("Filtered 312 of 10,000 · Clear") until cleared.

```
┌ Results 1 ───────────────────────────────────────────────────────────────┐
│ [Filter ▾] Name  contains  ▾ [ acme        ]  AND ▾  Total  >  ▾ [100 ] ✕│
│ + Add condition   ( ) Group    [Apply on server ⟳]   [Save ▾]   Clear    │
├──────────┬──────────────┬──────────┬──────────────┬───────────────────────┤
│ Id       │ Name         │ Total    │ OrderDate    │ Status                │
│ 12       │ Acme Ltd     │ 1,250.00 │ 2026-01-03   │ paid                  │
└──────────┴──────────────┴──────────┴──────────────┴───────────────────────┘
 Filtered 312 of 10,000 rows (client) · 12 ms · Clear filter
```

**Model** (`ui/src/filter/model.ts`, pure TS, used by grid, explorer and history):
```ts
type FilterOp = 'eq'|'neq'|'lt'|'lte'|'gt'|'gte'|'between'|'contains'|'notContains'|'startsWith'|'endsWith'
  |'in'|'notIn'|'isNull'|'isNotNull'|'isTrue'|'isFalse'|'isEmpty'|'regex'|'before'|'after'|'onDate'|'last'|'next';
interface FilterCondition { id: string; column: string; op: FilterOp; values: (string|number|boolean|null)[]; caseSensitive?: boolean }
interface FilterGroup { id: string; logic: 'and'|'or'; items: (FilterCondition|FilterGroup)[] }
interface FilterModel { root: FilterGroup; quick?: string }     // quick = free text across all string columns
```
Type-aware operator lists keyed by `ColumnInfo.kind`:
- `int|float|decimal`: eq neq lt lte gt gte between in notIn isNull isNotNull
- `string|json|xml|guid`: contains notContains startsWith endsWith eq neq in isEmpty isNull isNotNull regex (regex client-only; disabled for server push)
- `date|datetime|datetimeoffset`: onDate before after between last/next (N days/weeks/months) isNull isNotNull
- `time`: before after between
- `bool`: isTrue isFalse isNull
- `binary|cursor|other`: isNull isNotNull only
Values are parsed per kind (decimal strings compared numerically via `Number` when safe, else lexicographic on normalized strings; dates compared as ISO strings, which sort correctly since the wire format is ISO). Evaluation is a compiled predicate `(row) => boolean` built once per model change; 1M rows × 3 conditions must evaluate < 300 ms (measured in a vitest perf test).

**Quick filter from a cell** (right-click a cell → "Filter" submenu, also keyboard **Ctrl+Shift+F** on the focused cell):
- `Name = 'Acme'` (eq), `≠`, `> value`, `< value`, `contains 'Acme'`, `is NULL`/`is not NULL` (shown based on kind and whether the cell is null); choosing one appends an AND condition and opens the bar. "Filter by this cell" with **Alt+click** = eq shortcut.
- Column header right-click → "Filter column…" focuses a new condition on that column; "Show only distinct values" opens a checklist (top 500 distinct values with counts; checking N values builds an `in` condition).

**Push filter to server** ("Apply on server" button, **Ctrl+Shift+Enter in the bar**). Rewrites and re-runs the originating statement on the tab's session:
- Precondition: the result set came from a single statement whose intel `kind` is `select` (CTEs allowed), not from a procedure, not from a multi-result batch. Otherwise the button is disabled with tooltip "Server filtering needs a single SELECT".
- Rewrite: `SELECT * FROM (<original without trailing ORDER BY>) q WHERE <predicate> [ORDER BY <original order with q. prefix>]`. T-SQL and SQLite use `AS q`; Oracle uses `q` (no AS). A top-level `ORDER BY` is detected with the intel statement model and hoisted outside (T-SQL forbids ORDER BY in a derived table without TOP). `TOP n` / `FETCH FIRST` / `LIMIT` in the original are left inside (filtering happens after the limit, so the status bar shows "Filtered within the first N rows — remove the limit to filter everything" when a limit is detected).
- Predicate SQL per dialect: identifiers quoted via `quoteIdent`; `contains` → `LIKE '%' || ? || '%'` (Oracle/SQLite) / `LIKE '%' + @p + '%'` (T-SQL), `regex` unsupported on server (condition greyed out, filter still applied client-side on top); dates → `CAST(? AS DATE)`-free comparisons using parameters typed as `datetime`; `caseSensitive` → `COLLATE Latin1_General_CS_AS` (T-SQL), `BINARY` not needed for Oracle (case-sensitive by default; insensitive uses `UPPER()` both sides), SQLite `LIKE` is case-insensitive for ASCII (insensitive default; sensitive uses `GLOB`-free `instr()`).
- Values are sent as **parameters** (see 2.4 `ExecuteRequest.params`) never inlined, so server filtering is injection-safe. The UI shows the generated SQL in a tooltip and the Messages tab logs it. The rewrite is a new execution (history entry labelled `filter`), result replaces the current set, the bar shows "Server · 312 rows".

**Saved filters.** "Save ▾" → name it; saved per connection and per **column signature** (sorted list of `name:kind`) so a filter saved on `SELECT * FROM Orders` reappears for any result with the same columns. Stored engine-side (shared Electron/browser): see 3.7 `/filters`. The "Filter ▾" dropdown lists matching saved filters, "Recent (5)" and "Manage…".

#### 1.1.2 Explorer filter
The M1 fuzzy search box gains: type chips (`Tables Views Procs Funcs Other`, multi-select, persisted per connection), a "Search columns too" toggle (matches `c[].name`, result rows show `Customers · Email` and expand the table), and **Ctrl+F while the explorer has focus** focuses the box. Matching is `ui/src/lib/fuzzy.ts` over the loaded `CatalogSnapshot`; schemas not loaded are listed as "Load schema X to search it". Typing ≥ 2 chars filters in < 50 ms on 20k objects (test).

#### 1.1.3 History filter
History panel header: text search (FTS, existing) + chips `Connection ▾` (multi), `Status ▾` (ok/error/cancelled), `When ▾` (today, 7d, 30d, custom range), `Only pinned`. Engine `GET /history` gains optional query params `status=ok,error&from=&to=&pinned=true` (additive). Empty-result state: "No queries match. Clear filters".

#### Engine/UI split
UI: all evaluation, SQL rewrite, bar UI. Engine: parameter binding (2.4), `/filters` store, history query params.

---

### 1.2 Code formatting

**Decision: one token-based TypeScript formatter in the renderer (`ui/src/format/`) over the intel lexer, for all three dialects. ScriptDom is not used for formatting** — `Sql160ScriptGenerator` discards comments and cannot handle PL/SQL or SQLite, and a server round trip is unnecessary. `/sql/format` stays reserved and returns `NOT_SUPPORTED` in M1.5 (documented in section 3.5). ScriptDom is used only in tests to assert that formatting T-SQL does not change the parse tree.

**Invocation.** `Shift+Alt+F` format document (Monaco's default "Format Document"), `Ctrl+K Ctrl+F` format selection, editor context menu "Format", command palette "Format SQL", toolbar button in the Object DDL tab ("Formatted" toggle, non-destructive view), explorer context "Open DDL" honours setting `format.formatDdlOnOpen` (default true). Formatting applies only to the statements intersecting the selection; cursor position is preserved by mapping the token index under the cursor.

**Architecture** (`ui/src/format/`):
```
format/index.ts        formatSql(text, dialect, options): { text, mapping }   // public API
format/options.ts      FormatOptions + defaults
format/layout.ts       token stream → Line[] (indent level, segments)        // dialect-independent core
format/rules/tsql.ts   plsql.ts  sqlite.ts                                    // clause/block tables
format/comments.ts     comment attachment
format/__tests__/      fixtures/*.sql + *.expected.sql, idempotency + token-equality tests
```
Options (persisted under `Settings.format`, additive): `keywordCase: 'upper'|'lower'|'asIs'` (default upper), `identifierCase` (asIs), `indent: 4`, `useTabs: false`, `commaStyle: 'trailing'|'leading'` (trailing), `lineWidth: 120`, `clauseKeywordsOnOwnLine: true`, `andOrOnNewLine: true`, `alignAliases: false`, `blankLineBetweenStatements: 1`, `maxConsecutiveBlankLines: 1`, `functionCase: 'upper'`, `datatypeCase: 'upper'`.

**Algorithm.**
1. `tokenize(text, dialect)` (intel lexer, includes `comment`, `ws`, `batchSep`). Statements split with `splitStatements` so that unparseable regions are isolated: a statement the layout engine cannot handle (unbalanced parens/blocks, `unterminated` tokens) is emitted **verbatim** and a `warning` is returned; the rest of the document is still formatted.
2. Layout is a single pass with an indent stack. Elements: *clause keywords* start a new line at the statement's indent (`SELECT FROM WHERE GROUP BY HAVING ORDER BY UNION [ALL] EXCEPT INTERSECT INSERT INTO VALUES UPDATE SET DELETE MERGE USING WHEN [NOT] MATCHED RETURNING LIMIT OFFSET FETCH FIRST CONNECT BY START WITH`); *list items* after SELECT/SET/GROUP BY/ORDER BY/VALUES go one per line indented by `indent` when the list has > 1 item or exceeds `lineWidth`, else stay inline; `JOIN` variants start a new line at statement indent with `ON` on the same line, additional `AND` in ON on a new line indented; `AND`/`OR` at depth 0 of a WHERE/HAVING/ON start new lines (`andOrOnNewLine`); `CASE` → `WHEN/ELSE` lines indented, `END` back; parentheses: subqueries (`(` followed by `SELECT/WITH`) open a block (newline, indent, close paren on its own line), function-call and IN-list parens stay inline unless the content exceeds `lineWidth`, then one item per line; CTE: `WITH a AS (`, body block, `), b AS (` …; `GO`/`/` batch separators on their own line, preceded by a blank line, never removed; `;` stays attached to the last token.
3. Block constructs by dialect (indent body by one level, closing keyword at opener's indent):
   - **T-SQL**: `BEGIN…END`, `BEGIN TRY/CATCH…END TRY/CATCH`, `IF…[ELSE]` (single statement bodies indented, no auto-BEGIN), `WHILE`, `CREATE [OR ALTER] PROC|FUNCTION|TRIGGER … AS` (body at indent 0 after AS, `BEGIN` optional), `DECLARE @a int,\n    @b int`, `EXEC proc @p = 1,\n    @q = 2` (one param per line when > 2 params), `OPTION (...)` inline, `OUTPUT` clause as clause keyword, `WITH (NOLOCK)` inline.
   - **PL/SQL**: `DECLARE`/`IS`/`AS` section (declarations one per line, aligned types off), `BEGIN…EXCEPTION…END [name];`, `IF…ELSIF…ELSE…END IF;`, `LOOP/WHILE/FOR…LOOP…END LOOP;`, `CASE…END CASE;`, `CREATE [OR REPLACE] PACKAGE [BODY] x IS … END x;` (members at one indent), nested procedures/functions, `PRAGMA`, `CURSOR c IS` + SELECT indented, `%TYPE/%ROWTYPE` untouched, `=>` named args aligned off, `q'[...]'` verbatim, labels `<<x>>` at indent, the terminating `/` line kept. SQL inside PL/SQL formatted with the same clause rules at the current indent.
   - **SQLite**: `CREATE TRIGGER … BEGIN … END;` block, `CREATE TABLE (` one column per line `)`, `WITHOUT ROWID/STRICT` after `)`, `->`/`->>` spacing none, `PRAGMA` one line.
4. Keyword case: only tokens of kind `keyword` plus names in the dialect function list (`functionCase`) and datatype list (`datatypeCase`). Identifiers (`ident`, `quotedIdent`), strings, numbers, comments are byte-for-byte preserved. Contextual words that lex as `ident` but appear in the clause table (e.g. `OUTPUT`, `MATCHED`) are case-changed only when they are in a clause position.
5. **Comments**: every comment token is attached to a neighbour: a `--` comment on the same line as a preceding token → *trailing* (re-emitted after that token's line, one space); a comment on its own line → *leading* of the next token (emitted on its own line at the indent of the next emitted line; blank-line separation before it preserved up to `maxConsecutiveBlankLines`); a block comment between tokens on one line → inline verbatim; a comment at EOF → trailing of the statement. Multi-line block comments are re-indented only on their first line; inner lines are untouched. Test: every fixture's comment count and text are identical before/after.
6. **Idempotency and safety guarantees** (tests): `format(format(x)) === format(x)` for every fixture; `tokens(format(x))` without `ws` equals `tokens(x)` without `ws`/`comment` modulo keyword case (nothing added, dropped or reordered); T-SQL fixtures additionally parse to the same ScriptDom tree (`dotnet test` fixture harness in `engine/tests/DbStudio.Core.Tests/FormatterParity`, reading the same fixture folder); each dialect ≥ 40 fixtures incl. the M1 §4.14 inputs, a 600-line Oracle package body, SSMS-generated procedures, `GO 5`, nested comments, `q'[` strings, `(+)` joins, MERGE, window functions, `FOR JSON`, CTE recursive, `INSERT … SELECT`, `CREATE TABLE` with constraints. Performance: 5,000-line file < 150 ms.

   > **Open (M1.5 QA, features-26):** the 600-line Oracle package-body fixture is still outstanding. `ui/src/format/__tests__/fixtures/plsql/33-package-body.sql` has 26 lines; a large real-world package body still has to be added to the formatter suite (and used by checklist 5.4 "Format … the package body fixture").

---

### 1.3 Designers: tables, views, procedures (create and edit)

**Principle:** tables are *designed* (structured UI), views and procedures are *code* with a wizard that writes the skeleton and an "Edit" mode that rewrites `CREATE` to the right alter form. Every designer ends with a **DDL preview** that is editable and is what actually runs.

#### 1.3.1 Table designer (`ui/src/designer/table/`)
Invoked by: explorer context "New table…" on a schema/database node (also command `designer.newTable`, **Ctrl+Alt+T**), "Design table" on a table node (also from the Object tab's "Design" button and **F4** on a selected explorer node). Opens as a tab titled `Design: dbo.Customers`.

```
┌ Design: dbo.Customers (SQL Server · Prod) ────────────────────────────── [Preview DDL] [Apply] ┐
│ Name [Customers      ]  Schema [dbo ▾]   Comment [                    ]  ☐ WITHOUT ROWID (sqlite)│
│ Columns | Keys & Indexes | Foreign Keys | Checks                                                │
│ ┌─┬──────────────┬───────────────┬──────┬───┬─────┬──────────────┬───────────────┐             │
│ │#│ Name         │ Type          │ Null │ PK │ Id  │ Default      │ Comment       │ ⋮           │
│ │1│ Id           │ int        ▾  │ ☐    │ ●  │ ☑   │              │               │             │
│ │2│ Name         │ nvarchar(100) │ ☐    │    │     │              │ Display name  │             │
│ │3│ CreatedAt    │ datetime2(3)  │ ☐    │    │     │ SYSUTCDATETIME()             │             │
│ │+│ (new column) │               │      │    │     │              │               │             │
│ └─┴──────────────┴───────────────┴──────┴───┴─────┴──────────────┴───────────────┘             │
│ Alt+Up/Down reorder · Del remove · Ctrl+D duplicate · Enter edit · Tab next cell                 │
├ DDL preview (editable) ─────────────────────────────────────────────────────────────────────────┤
│ ALTER TABLE [dbo].[Customers] ADD [CreatedAt] datetime2(3) NOT NULL                              │
│     CONSTRAINT [DF_Customers_CreatedAt] DEFAULT (SYSUTCDATETIME());                              │
│ ⚠ 2 statements · runs in one transaction                                                         │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- Column grid is a keyboard-first editable table (not glide; a plain accessible `<table>` with roving tabindex). Type cell: combobox with the dialect's type list (from `GET /designer/types`), free text allowed; size/precision parsed from the text (`nvarchar(100)`, `NUMBER(10,2)`).
- Tabs: Keys & Indexes (PK with column order, unique constraints, indexes with columns + ASC/DESC, unique, clustered/nonclustered (T-SQL), included columns (T-SQL), filter (T-SQL), tablespace off), Foreign Keys (columns → referenced table picker using the catalog, referenced columns default to its PK, ON DELETE/UPDATE actions per dialect), Checks (name + expression).
- Dirty tracking; closing a dirty designer asks to discard.
- "Preview DDL" is always live (debounced 250 ms, `POST .../designer/table/script`); the user can edit the preview (then the designer is locked read-only with a banner "Preview edited by hand — Apply runs your text") or regenerate.
- "Apply" (**Ctrl+S** in the designer) → `POST .../designer/apply`; success toast, explorer refresh via the existing `catalog.changed` push; on failure the error is shown inline with the failing statement highlighted and, for non-transactional dialects, the list of statements that already ran.

**TableModel** (wire, `3.8`):
```json
{ "schema":"dbo", "name":"Customers", "comment":null, "options":{ "withoutRowid":false, "strict":false, "tablespace":null },
  "columns":[ { "name":"Id", "type":"int", "nullable":false, "default":null, "defaultName":null, "identity":{ "seed":1, "increment":1 }|null,
                "computed":{ "expression":"...", "persisted":false }|null, "collation":null, "comment":null, "autoincrement":false /* sqlite */ } ],
  "primaryKey":{ "name":"PK_Customers", "columns":["Id"], "clustered":true }|null,
  "uniques":[ { "name":"UQ_Customers_Email", "columns":["Email"] } ],
  "indexes":[ { "name":"IX_Customers_Name", "columns":[{ "name":"Name", "desc":false }], "unique":false, "clustered":false, "include":[], "filter":null } ],
  "foreignKeys":[ { "name":"FK_Orders_Customers", "columns":["CustomerId"], "refSchema":"dbo", "refTable":"Customers", "refColumns":["Id"], "onDelete":"NO ACTION", "onUpdate":"NO ACTION" } ],
  "checks":[ { "name":"CK_Customers_Age", "expression":"Age >= 0" } ] }
```

**Engine DDL scripters** (`IDdlScripter`, keyed by provider id, in each provider project under `Designer/`). Input: `(TableModel? original, TableModel desired)`; output: ordered statements, each `{ sql, kind: "create"|"alter"|"drop"|"rename"|"rebuild"|"comment"|"index", warning }`, plus `rebuildRequired` and `transactional`.
- Diff algorithm (shared in `DbStudio.Core/Designer/TableDiff.cs`): columns matched by `id` (the UI assigns a stable id per column = original name; a rename is `originalName != name`), then by name. Produces `ColumnAdded/Dropped/Renamed/TypeChanged/NullabilityChanged/DefaultChanged/IdentityChanged`, constraint/index added/dropped (a changed constraint = drop + add), table rename, comment changes.
- **SQL Server** (`transactional: true`, all statements in one `BEGIN TRAN`): `CREATE TABLE` with inline PK/identity/defaults as named constraints; alters: `ALTER TABLE ADD`, `ALTER COLUMN` (nullability/type; emits warning when narrowing), `sp_rename 'schema.table.col', 'new', 'COLUMN'`, drop default constraint before `ALTER COLUMN`/`DROP COLUMN` (uses `defaultName` from the model or a `DECLARE @n sysname … EXEC` lookup when unknown), identity changes → rebuild warning (identity cannot be altered: scripted as rebuild via new table + `SET IDENTITY_INSERT`, flagged `rebuildRequired`), `CREATE [UNIQUE] [CLUSTERED] INDEX … INCLUDE (...) WHERE ...`, comments via `sp_addextendedproperty`/`sp_updateextendedproperty` `MS_Description`.
- **Oracle** (`transactional: false`, each DDL autocommits — apply runs statements sequentially and stops at the first error; preview banner says so): `CREATE TABLE` with `GENERATED [ALWAYS|BY DEFAULT] AS IDENTITY`, `ALTER TABLE ADD/MODIFY/DROP COLUMN`, `RENAME COLUMN`, `ALTER TABLE RENAME TO`, `COMMENT ON TABLE/COLUMN`, constraints `ADD CONSTRAINT … PRIMARY KEY/UNIQUE/FOREIGN KEY … ON DELETE CASCADE|SET NULL` (no ON UPDATE — model value ignored with a warning), `CREATE [UNIQUE] INDEX`. Identifiers upper-cased unless quoted/mixed (uses `IdentifierRules`).
- **SQLite** (`transactional: true`): native `ALTER TABLE` only for `ADD COLUMN` (no PK/UNIQUE, default must be constant), `RENAME COLUMN` (3.25+), `RENAME TO`, `DROP COLUMN` (3.35+, not PK/unique/indexed/FK-referenced columns). Anything else → **rebuild script** (`rebuildRequired: true`), the documented 12-step procedure:
  ```sql
  PRAGMA foreign_keys=OFF;            -- outside the transaction (no-op inside one)
  BEGIN;
  CREATE TABLE "Customers__new" (...desired...);
  INSERT INTO "Customers__new" (c1,c2,...) SELECT c1,c2,... FROM "Customers";  -- renamed columns mapped, new columns get DEFAULT/NULL
  DROP TABLE "Customers";
  ALTER TABLE "Customers__new" RENAME TO "Customers";
  CREATE INDEX ...; CREATE TRIGGER ...; CREATE VIEW ...;   -- recreated from sqlite_master (indexes, triggers of the table; views that reference it)
  PRAGMA foreign_key_check;            -- apply fails if it returns rows
  COMMIT;
  PRAGMA foreign_keys=ON;
  ```
  The apply endpoint runs the PRAGMAs outside the transaction and checks `foreign_key_check` results itself. Server version is read once (`sqlite_version()`) to pick native vs rebuild for RENAME/DROP COLUMN.

#### 1.3.2 View designer
Explorer "New view…" / "Edit view" (F4). A tab with a header strip (schema, name, Oracle `OR REPLACE`/T-SQL `CREATE OR ALTER` auto, `WITH SCHEMABINDING` checkbox T-SQL, `WITH CHECK OPTION`) over a full `SqlEditor` holding only the `SELECT`. The editor has IntelliSense bound to the tab's catalog. Right side: live column preview via `POST /sessions/{sid}/describe` (debounced 600 ms; shows resulting columns/types or the error). "Preview DDL"/"Apply" generate: T-SQL `CREATE OR ALTER VIEW` (fallback `ALTER VIEW` when server < 13.0.4001, detected from `productVersion`); Oracle `CREATE OR REPLACE [FORCE] VIEW`; SQLite `DROP VIEW IF EXISTS; CREATE VIEW` in one transaction. Rename = T-SQL `sp_rename`, Oracle `RENAME`, SQLite drop+create.

#### 1.3.3 Procedure / function / package wizard and edit
"New procedure…" opens a small dialog: schema, name, parameters grid (name, type, direction, default), return type (functions), Oracle "package member" option (adds to an existing package: spec+body edits appended). "Create" inserts a dialect template into a **new editor tab** (not a designer) with `${placeholders}` as a Monaco snippet (Tab through name/params/body):
- T-SQL `CREATE OR ALTER PROCEDURE [dbo].[Name]\n    @Id int\nAS\nBEGIN\n    SET NOCOUNT ON;\n    ${0}\nEND\nGO`
- PL/SQL `CREATE OR REPLACE PROCEDURE schema.name (p_id IN NUMBER) AS\nBEGIN\n    ${0}\nEND name;\n/`; functions with `RETURN type`; packages produce spec + body in two statements.
- SQLite has no procedures: the item is hidden; "New trigger…" exists instead (`CREATE TRIGGER … BEGIN … END;`).
"Edit" (F4 on a proc/func/package/trigger node, or "Edit" in the Object tab) opens the stored DDL in an **editable** tab whose header is rewritten: T-SQL `CREATE PROCEDURE` → `CREATE OR ALTER PROCEDURE` (or `ALTER` on old servers), Oracle `CREATE` → `CREATE OR REPLACE`, SQLite triggers/views → `DROP … IF EXISTS;` prepended. Running the tab (F5) is the apply; the tab shows a "Compare with server" action (diff view in Monaco `DiffEditor`) before running. Oracle compile errors land inline (M1 `exec.diagnostics`).

#### Engine/UI split and endpoints
UI: designers, diff presentation, templates. Engine: `TableModel` read, diff + scripting, apply, type lists, `describe` (section 3.8).

---

### 1.4 Code generation (`ui/src/codegen/`)

**Decision: renderer-side TypeScript generators.** All inputs already exist in the renderer: `CatalogObject` columns/params from the snapshot, `ObjectDetails` from `/catalog/object` (defaults, comments), and `ColumnInfo` for queries (from a result set or `POST /sessions/{sid}/describe`). No network, instant preview, trivially testable with fixtures.

**Invocation.** Explorer context "Generate code…" on table/view/proc/func/package nodes (multi-select supported → one file per object or one combined file), result-set toolbar "Code ▾" (query codegen for the SQL that produced it), editor context "Generate code for query" (uses `describe` on the statement at cursor), command `codegen.open` (**Ctrl+Alt+G**). Opens a side panel/tab:

```
┌ Generate code — dbo.Customers, dbo.Orders ────────────────────────────────────────────┐
│ Language [C# ▾]  Flavor [Dapper ▾]  Naming [PascalCase ▾]  Namespace [App.Data      ]  │
│ ☑ Nullable reference types  ☑ Data annotations  ☐ Records instead of classes          │
│ Include: ☑ Model  ☑ Repository (CRUD)  ☑ Procedure wrappers  ☐ Interface               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ public sealed class Customer {                                                [Copy]   │
│     public int Id { get; set; }                                         [Save file…]   │
│     public string Name { get; set; } = "";                           [Open as tab]     │
│     public DateTime? CreatedAt { get; set; }                                           │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
Options persist in `Settings.ui.codegen`. Output is a read-only Monaco with the target language's syntax highlighting (Monaco built-in `csharp`, `go`, `typescript`, `java`, `python`, `sql`, `json`).

**Targets (language × flavor):**
| Language | Flavors | Artifacts |
|---|---|---|
| C# | `dapper` (default), `efcore` (entity + `IEntityTypeConfiguration` with keys, max lengths, FKs, table name), `adonet` (`SqlClient`/`ODP.NET`/`Microsoft.Data.Sqlite` raw), `record-only` | model, repository with `GetById/List/Insert/Update/Delete`, proc wrapper `Task<IReadOnlyList<T>> CallXAsync(params)` with output params, query DTO + `QueryAsync` method |
| Go | `database/sql` (default), `sqlx` | struct with `db:"col"`+`json` tags, `sql.NullString`/pointer nullables (option), CRUD funcs with `context.Context`, scanner for query rows, proc call (`EXEC`/`BEGIN … END;` with named binds for Oracle via `godror`) |
| TypeScript | `interface` (default; what React/Angular consume), `node-mssql`, `node-oracledb`, `better-sqlite3`, `zod` schema | interface/DTO with JSDoc, typed query function, `?`-optional for nullable |
| Java | `jdbc` (default), `record` | record/class, `RowMapper`, `PreparedStatement` CRUD, `CallableStatement` wrapper |
| Python | `dataclass` + driver (`pyodbc`, `oracledb`, `sqlite3`), `pydantic` | dataclass/model, typed functions with parameters, cursor mapping |
| SQL | `select`, `insert`, `update`, `delete`, `merge` (T-SQL/Oracle), `exec` (call with named params) | statement templates with all columns, PK in WHERE (SSMS "Script as") |
| JSON | `sample` (one row object with type-appropriate placeholders), `json-schema` | for API mocking |

**Type mapping table** — `ui/src/codegen/types/*.json`, one file per dialect, keys are the normalized base type (lower-case, size stripped); every row defines every language. Excerpt (the full tables are the deliverable; unknown types fall back to `string`/`interface{}`/`unknown`/`Object`/`Any` with a `// TODO: unmapped type X` comment):
| Dialect type | C# | Go | TS | Java | Python |
|---|---|---|---|---|---|
| tsql `int` / plsql `NUMBER(p,0)` p≤9 / sqlite `INTEGER` | `int` | `int32`/`int64`(sqlite) | `number` | `int` | `int` |
| tsql `bigint` / `NUMBER(p,0)` 10≤p≤18 | `long` | `int64` | `number` (`bigint` option) | `long` | `int` |
| `decimal/numeric/money` / `NUMBER(p,s)` s>0 or unspecified / sqlite `REAL`→float, `NUMERIC`→decimal | `decimal` | `float64` (`shopspring.Decimal` option) | `number`/`string` option | `BigDecimal` | `Decimal` |
| `float/real` / `BINARY_DOUBLE/FLOAT` | `double` | `float64` | `number` | `double` | `float` |
| `bit` / `NUMBER(1)` with option / sqlite `BOOLEAN` affinity | `bool` | `bool` | `boolean` | `boolean` | `bool` |
| `nvarchar/varchar/char/text/ntext` / `VARCHAR2/NVARCHAR2/CHAR/CLOB/NCLOB` / `TEXT` | `string` | `string` | `string` | `String` | `str` |
| `date` / `DATE` (Oracle, option `dateAsDateTime`) | `DateOnly`/`DateTime` | `time.Time` | `string` (ISO) | `LocalDate` | `date` |
| `datetime/datetime2/smalldatetime` / `TIMESTAMP` | `DateTime` | `time.Time` | `string`/`Date` option | `LocalDateTime` | `datetime` |
| `datetimeoffset` / `TIMESTAMP WITH TIME ZONE` | `DateTimeOffset` | `time.Time` | `string` | `OffsetDateTime` | `datetime` |
| `time` / `INTERVAL DAY TO SECOND` | `TimeOnly`/`TimeSpan` | `time.Duration` | `string` | `LocalTime`/`Duration` | `time`/`timedelta` |
| `uniqueidentifier` / `RAW(16)` option | `Guid` | `string` (`uuid.UUID` option) | `string` | `UUID` | `UUID` |
| `varbinary/binary/image` / `BLOB/RAW` / `BLOB` | `byte[]` | `[]byte` | `Uint8Array`/`Buffer` | `byte[]` | `bytes` |
| `xml` / `XMLTYPE` | `string` | `string` | `string` | `String` | `str` |
| json (`nvarchar` with ISJSON, Oracle `JSON`, sqlite `JSON` affinity) | `string` (`JsonDocument` option) | `json.RawMessage` | `unknown` | `String` | `Any` |
| `sql_variant`, `hierarchyid`, `geography`, Oracle `SDO_*`, `REF CURSOR` (as param) | `object` | `any` | `unknown` | `Object` | `Any` (+ TODO) |

**Nullable handling** (option per language, defaults shown): C# NRT on → `string?`/`int?` for nullable columns, non-null reference strings initialised to `""` (or `required` keyword option); Go `pointerNullables` (default) → `*string`; `sqlNullTypes` → `sql.NullString`; TS `name?: string` vs `name: string | null` (default the latter for DTOs, `?` for interface flavor option); Java wrappers (`Integer`) for nullable primitives; Python `Optional[int]`/`int | None` (3.10 syntax default).

**Naming conventions**: `pascal` (default C#/Java/TS types), `camel` (TS/Java/Go fields), `snake` (Python, Go `db` tags keep the original column name verbatim), `asIs`. Singularisation of table names for type names (`Customers` → `Customer`) via a small rule list (`ies→y`, `ses→s`, `s→`) with an "exceptions" text box; Oracle `UPPER_SNAKE` → Pascal. Reserved-word escaping per language (`@class`, `class_`, `` `type` ``). Column→property names collide → suffix `_2`.

**Parameterized query code**: the query's parameters are detected by the intel lexer (`param` tokens `@x`, `:x`, `?`); their types come from the user (a small param-type table in the panel, default `string`) or from `ExecuteRequest.params` if the query was last run with parameters. Generated code always uses driver parameters (never string concatenation): Dapper `new { x }`, Go `?`/`@p1`/`:x` rewrites (`database/sql` placeholders differ per driver: SQL Server `@p1` with `sql.Named`, Oracle `:1`/named, SQLite `?`), node-mssql `request.input('x', sql.Int, x)`, JDBC `?` with index map, Python `?`/`:x`/`%s` per driver. Result mapping uses the described `ColumnInfo` (name, kind, nullable).

**Procedure-call wrappers**: parameters from the catalog `p` tuples (`in|out|inout|return`), output params mapped (C# `DynamicParameters` with `ParameterDirection.Output`, Go `sql.Out{}`, Python `cursor.var`), T-SQL return value, Oracle REF CURSOR out params typed as result sets (`OracleDbType.RefCursor`), packages as `PKG.PROC` with the package name becoming the class/module. Result set shape is unknown for procedures unless the user runs it once; the panel offers "Run to infer result columns" (executes with NULL/default parameters after confirmation).

Tests: snapshot tests per target with the "shop" fixture catalog (`ui/src/codegen/__tests__/__snapshots__`), compile smoke tests in CI for C# (`dotnet build` of a generated file in `engine/tests/Codegen.Smoke`), Go (`go vet` if Go is on the agent, else skipped), TS (`tsc --noEmit`).

---

### 1.5 Multiple connections used at the same time

M1 already gives each editor tab its own session and the explorer can expand several connections. M1.5 makes working across connections effortless:
- **Connection pill** on every editor tab header and results pane: `● Prod SQL · AdventureWorks`. Click → dropdown of connections (grouped by folder, MRU first, fuzzy search) and databases; switching creates a new session for the tab (warn + offer Commit/Rollback if `txOpen`). Shortcut **Ctrl+Shift+K** ("Change connection"), database switch **Ctrl+Shift+D**. Tab colour bar = connection `color`; read-only connections show a lock glyph; production colour (red) also tints the Run button border.
- **Active connections panel** (status bar item "3 connections · 5 sessions", command `connections.showActive`): list of open sessions with tab, state (idle/executing/tx open), elapsed of running query, actions Cancel / Disconnect / Disconnect all. Powered by `GET /sessions` (existing) + `session.changed`.
- **Explorer**: each connection root has its own colour bar and a "Disconnect" action that closes its sessions and drops cached catalogs; "Connect all in folder" exists for folders. Catalog loads for different connections run in parallel in the engine (one catalog connection per profile; a `SemaphoreSlim(1)` **per profile**, not global) and the UI shows per-root spinners.
- **Drag & drop across connections**: dragging a table node into an editor whose tab belongs to another connection inserts the name and shows a toast "Inserted dbo.Customers from Prod SQL; this tab runs on Dev SQL" (no auto-switch).
- **Run on multiple connections** (addition A6): toolbar "Run on… ▾" or command `run.multi` (**Ctrl+Alt+Enter**): checklist of connections (folder "All in Work"), optional database per connection, runs the current statement/script on each (engine executes them concurrently, each on a fresh or the tab's session), results pane groups by connection with a tab strip `Dev · Test · Prod`, Messages tab prefixed with the connection name, a summary row `3/3 ok · Prod: 12 rows · Test: error`. Destructive-guard confirmation lists every target. History entries are per connection.
- Engine limits: `Settings.connections.maxSessionsPerProfile` (default 8); exceeding returns 429-style `{ code: "SESSION_LIMIT" }` (new error code, additive) and the UI offers to close idle tabs. Catalog cache memory cap stays global (256 MB, LRU by connection).

---

## 2. Own additions (ranked by value/cost)

| Rank | Feature | Why (one line) | Status |
|---|---|---|---|
| A1 | **In-grid data editing + Table data tab** | The single most used feature in Navicat/TablePlus/DataGrip; double-click a table and fix a row without writing UPDATE. | M1.5 |
| A2 | **Query parameters / bind dialog** | Unblocks Oracle `:binds` (M1 rejects them), makes server filters and codegen injection-safe, and is used daily by every developer re-running a query with different ids. | M1.5 |
| A3 | **Quick object search (Ctrl+P)** | Cheapest big win: jump to any table/proc across loaded schemas in one keystroke; the palette mode already exists. | M1.5 |
| A4 | **Snippets / live templates** | `sel`, `ins`, `cte`, `proc`… with Tab stops; tiny cost on top of Monaco's snippet support; used constantly. | M1.5 |
| A5 | **Explain plan viewer** | Every slow-query investigation needs it; a tree/table view (no graph drawing) keeps the cost low. | M1.5 |
| A6 | **Run on multiple connections** | Dev/test/prod parity checks and migrations; builds on the multi-connection requirement. | M1.5 |
| A7 | **Record view (transpose) + FK navigation** | Wide rows are unreadable in a grid; "go to referenced row" (Ctrl+click an FK cell) is a top DataGrip feature; small cost because it reuses the Table data tab with a filter. | M1.5 (inside A1) |
| D1 | ER diagram | Real value but needs React Flow + auto-layout + printing; weekly, not daily use. | Defer to M2 |
| D2 | Compare two result sets | Rarely used; "export both and diff" covers it. | Defer |
| D3 | CSV/JSON import wizard | Useful but a full feature (mapping, type coercion, batching, errors); schedule for M2 with data transfer. | Defer |
| D4 | Schema compare / sync | Large; M3 as planned. | Defer |

#### A1 In-grid data editing and Table data tab
- **Table data tab**: double-click a table/view node (or Enter, or "Open data" context, **Ctrl+Alt+D**) opens `Data: dbo.Customers` — a grid with the filter bar open (server filtering always on; the SQL is `SELECT * FROM t` + predicate + `ORDER BY pk`, paged by `OFFSET/FETCH` (T-SQL ≥ 2012, Oracle 12c+, SQLite `LIMIT/OFFSET`); older servers get `TOP n` without paging), page size 1,000 with "Load more"/`Ctrl+End` fetches next page, column header sort pushes `ORDER BY` to the server, row count badge via `SELECT COUNT(*)` with the same predicate (lazy, cancellable). Views are editable only when the dialect allows and a PK is inferable (T-SQL single-table view keys via `ColumnInfo.isKey`; else read-only badge).
- **Editing**: available in Table data tabs and in result sets from a single-table `SELECT` where every PK column is present (engine marks `ColumnInfo.isKey` — already in the contract; the UI requires all key columns of `ColumnInfo.table`). Enter/F2/typing starts editing a cell (glide-data-grid editors by kind: text, number, date picker, bool toggle, NULL via **Ctrl+0**, multi-line via Shift+Enter opening the cell viewer in edit mode); **Insert** (or "+" row) adds a row with defaults shown as placeholders; **Delete** marks selected rows; edited cells get a left accent border, inserted rows green tint, deleted rows strikethrough. **Ctrl+S** or "Submit (3)" opens the **pending-changes preview**: the generated statements per dialect with parameters shown as values, `Copy SQL`, `Submit`, `Revert`. Submission runs in one transaction on the tab's session via `ExecuteRequest` with `params` (one statement per change; `stopOnError: true`), then rolls back on any error and keeps the pending buffer so the user can fix it. After success, the affected rows refetch via `SELECT … WHERE pk IN (...)` (to show identities/defaults/triggers' effects). Generated SQL: `UPDATE t SET c = @p1 WHERE pk = @p2` (only changed columns; T-SQL/SQLite use `@pN`, Oracle `:pN`), `INSERT INTO t (cols) VALUES (...)` (T-SQL appends `OUTPUT INSERTED.pk`, Oracle `RETURNING pk INTO :out`, SQLite `RETURNING pk` 3.35+ else `last_insert_rowid()`), `DELETE FROM t WHERE pk = …`. Optimistic concurrency: off by default; option "verify unchanged values" adds `AND col = @old` for edited columns and reports "0 rows affected" as a conflict.
- Record view: **F7** toggles a right panel showing the selected row vertically (name/type/value, editable with the same buffer). FK navigation: cells of FK columns (from the catalog snapshot `fk`) get a small arrow; **Ctrl+click**/context "Go to referenced row" opens the referenced table's Data tab filtered on the key; "Show referencing rows" lists tables referencing this PK.

#### A2 Query parameters
Running a statement containing `param` tokens (`@x` not declared by a `DECLARE` in the batch (T-SQL), `:x` (Oracle/SQLite), `?`, `$x`) opens the **Parameters dialog** (unless all values are remembered and "Don't ask again for this tab" is on): rows = name, type (`string|int|decimal|datetime|date|bool|binary|null|refcursor`), value; MRU values per name per connection in `Settings.ui.paramHistory`. **Ctrl+Enter** in the dialog runs. Oracle `refcursor` type marks an OUT bind whose cursor is returned as an extra result set (this replaces `BIND_VARS_UNSUPPORTED` for the common case; the engine keeps the error only when a bind cannot be typed). Parameters in the editor also get a gutter hint "3 parameters · Ctrl+Alt+P to edit".

#### A3 Quick object search (Ctrl+P)
Palette in `objects` mode: fuzzy over all loaded schemas of all open connections (`ui/src/lib/fuzzy.ts`), item shows `icon name · schema · connection`, type prefixes filter (`t:` tables, `v:`, `p:`, `f:`, `c:` columns), Enter opens the Object tab, **Ctrl+Enter** opens Data tab, **Shift+Enter** inserts the qualified name at the cursor, **Alt+Enter** reveals in explorer. Results in < 30 ms for 50k objects (index built from the catalog store incrementally).

#### A4 Snippets
`ui/src/snippets/`: built-in per dialect (`sel`, `selw`, `selc` (count), `ins`, `upd`, `del`, `cte`, `join`, `case`, `ifx`, `tryc` (T-SQL), `proc`, `fn`, `trg`, `blk` (PL/SQL anonymous block), `pkg`, `cur` (cursor loop), `exc` (exception block), `tbl` (CREATE TABLE), `idx`, `tx` (BEGIN TRAN … COMMIT)), plus user snippets edited in Settings → Snippets (name, prefix, dialect filter, body with `$1`/`${1:default}`/`$0`, stored engine-side as `Settings.snippets[]`). Surfaced through the existing completion provider at statement start (kind `snippet`, ranked below exact keyword matches) and via **Ctrl+J** "Insert snippet…" list. Postfix templates: typing `Customers.sel` + Tab → `SELECT * FROM Customers` (and `.count`, `.ins`, `.upd`, `.del`) handled in the completer when the qualifier resolves to a table.

#### A5 Explain plan
**Ctrl+L** (estimated) and **Ctrl+Shift+L** (actual, runs the query) on the statement at cursor; "Explain" toolbar split button. Engine `POST /sessions/{sid}/explain` (3.8) normalises provider output into a tree:
- SQL Server: `SET SHOWPLAN_XML ON` (estimated) / `SET STATISTICS XML ON` (actual; the query runs, its result sets are delivered normally and the plan XML is the trailing result) → parse `ShowPlanXML` into `RelOp` nodes (PhysicalOp, LogicalOp, EstimatedTotalSubtreeCost, EstimateRows, ActualRows, warnings, missing index hints).
- Oracle: `EXPLAIN PLAN SET STATEMENT_ID = :id FOR <sql>` then `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_PLAN('PLAN_TABLE', :id, 'TYPICAL'))`-free structured read from `PLAN_TABLE` (id, parent_id, operation, options, object_name, cost, cardinality, bytes, access/filter predicates) + the text from `DBMS_XPLAN.DISPLAY` as the raw tab; actual = `GATHER_PLAN_STATISTICS` hint + `DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST')` (text only).
- SQLite: `EXPLAIN QUERY PLAN` rows (id, parent, detail) → tree; actual = same (SQLite has no actual stats).
UI (`ui/src/components/PlanView/`): a tree table (operation, object, est rows, actual rows, cost %, warnings) with the most expensive nodes highlighted, a "Raw" tab (XML/text) and "Copy plan". No graphical layout in M1.5.

---

## 3. UX and design system (checkable)

**Layout principles.** One window, three regions: left dock (Explorer | History | Connections, tabbed, 220–480 px, collapsible Ctrl+B), center tab strip (consoles, data tabs, designers, object tabs, plan views — all are tabs, draggable, Ctrl+Tab MRU switch, Ctrl+W close, middle-click close, Ctrl+Shift+T reopen closed), bottom of each console the results pane (Ctrl+R toggle, splitter, maximise with Ctrl+Shift+R). One toolbar per console tab (Run, Run script, Cancel, connection pill, database, tx mode, Explain, Format, Code ▾), no global ribbon. Nothing important is more than one click or one shortcut away: every toolbar action also exists in the command palette and (when relevant) in a context menu.

**Density and spacing.** 4 px base scale (`--space-1: 4px` … `--space-8: 32px`). Grid row height 28 px (compact 24 px via setting `ui.density: 'comfortable'|'compact'`), explorer row 24 px, toolbar 36 px, tab strip 34 px, status bar 24 px, inputs 28 px (`--input-h`; buttons, selects, search boxes and the toolbar's segmented control too), `--input-h-sm` 24 px only in dense bars (results filter bar, designer cards, inline grid editors), dialog padding 20 px, panel padding 12 px. Hit targets ≥ 24×24 px.

**Typography.** UI: `"Segoe UI Variable Text", "Segoe UI", -apple-system, "SF Pro Text", Inter, system-ui, sans-serif`, 13 px base. Scale (tokens, nothing below 11 px): `--text-xs 11` (status bar, chips, badges, counts, key caps), `--text-sm 12`, `--text-md 13`, `--text-lg 15` (dialog titles, object names, palette input), `--text-xl 20`, `--text-2xl 26` (onboarding headline); line-height 1.4; weights 400/600 only (`--weight-regular` / `--weight-strong`; no 500/700). Code/grid (`--font-mono`, used by every Monaco editor and the grid): `"Cascadia Code", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`, 13 px grid / 14 px editor (editor size follows `Settings.editor.fontSize`); numbers in the grid use `font-variant-numeric: tabular-nums`, right-aligned; NULL rendered italic in `--fg-muted`.

**Color tokens** (`ui/src/theme/tokens.css`, applied on `:root[data-theme=light|dark]`; every component must use tokens, no literal colours in component CSS — lint rule in QA):
| Token | Light | Dark |
|---|---|---|
| `--bg-app` | `#f5f6f8` | `#1b1d21` |
| `--bg-panel` | `#ffffff` | `#24272d` |
| `--bg-elevated` (menus, dialogs) | `#ffffff` | `#2c3038` |
| `--bg-hover` | `#eceef2` | `#30343c` |
| `--bg-selected` | `#dde8fb` | `#2e4466` |
| `--bg-grid-alt` | `#fafbfc` | `#22252a` |
| `--border` (decorative separators, ≥ 1.5:1) | `#ccd1d9` | `#41464f` |
| `--border-strong` (**control boundary**, ≥ 3:1) | `#8a919c` | `#6f7682` |
| `--fg` | `#1c1f24` | `#e6e8eb` |
| `--fg-muted` | `#5f6673` | `#9aa1ab` |
| `--fg-disabled` | `#a0a6b0` | `#646a74` |
| `--accent` | `#2563eb` | `#5b9cff` |
| `--accent-fg` | `#ffffff` | `#0b1220` |
| `--focus-ring` | `#2563eb` | `#8ab4ff` |
| `--success` | `#15803d` | `#4ade80` |
| `--warning` | `#b45309` | `#fbbf24` |
| `--danger` | `#b91c1c` | `#f87171` |
| `--info` | `#0e7490` | `#67e8f9` |
| `--cell-edited` | `#fde68a` 35% | `#facc15` 25% |
| `--cell-inserted` | `#bbf7d0` 40% | `#22c55e` 22% |
| `--cell-deleted` | `#fecaca` 40% | `#ef4444` 22% |
| Connection colours (palette) | red `#dc2626`, orange `#ea580c`, yellow `#b47c03` (stored in profiles as `#ca8a04`), green `#16a34a`, blue `#2563eb`, purple `#7c3aed`, grey `#6b7280` | same hues at +15% lightness |

`--border-strong` is the control-boundary token: buttons, inputs, selects, search boxes, segmented controls and the filter/designer controls draw their outline with it (WCAG 1.4.11, ≥ 3:1 on `--bg-panel`). Purely decorative lines (separators, key caps, table header rules, grid header rule) use `--border`. `--border-control` is a deprecated alias of `--border-strong`, kept for one release. Derived tokens keep text on tinted surfaces at ≥ 4.5:1 without changing the table: `--fg-muted-on-selected` (secondary text on `--bg-selected`/`--bg-active` rows; light = `--fg-muted`, dark `#b0b7c1`), `--accent-on-selected` (light = `--accent-hover`, dark `#9ec5ff`), `--danger-text` (danger text on tinted backgrounds; light = `--danger`, dark `#fca5a5`), `--run-flash` (editor flash of the statement just run). `--fg-disabled` is only for disabled controls, never for informative text. `ui/src/theme/tokens.test.ts` holds the contrast matrix of every (foreground, background) pair the UI paints, both themes.
Monaco themes `dbstudio-light/dark` derive editor background from `--bg-panel` and keyword/identifier colours from the same accent family (keywords `--accent`, strings `--success`-adjacent `#047857`/`#6ee7b7`, comments `--fg-muted`, numbers `#9a3412`/`#fdba74`); both are built from `tokens.css` when Monaco is set up (no literal colours, no first-paint flash), including the suggest/hover/find widgets, the context menu (same look as the app menus) and selected rows (`--bg-selected` with `--fg` text). Every Monaco editor uses `baseMonacoOptions()` (`ui/src/editor/monacoOptions.ts`: light-DOM context views, `--font-mono`, explicit suggest row height). Glide grid theme object is regenerated from the tokens on theme switch.

**Iconography.** `lucide-react` only, 16 px (`--icon-size`), stroke 1.5 (enforced for every icon by the global `svg.lucide` rule in `app.css`), `currentColor`; 14 px (`--icon-size-sm`) is allowed only in the documented dense spots: status bar, chips, tab close buttons, dock tabs, split-button carets, `.btn-xs`, result-set tabs, results quick-search, results badges and the Messages summary (`ui/src/theme/iconSizes.test.ts`); object-type icons are fixed: table `Table2`, view `Eye`, mview `Layers`, proc `SquareFunction`, func `FunctionSquare`, package `Package`, sequence `Hash`, synonym `Link2`, trigger `Zap`, type `Shapes`, column `Columns3` (PK gets a `Key` badge, FK a `Link` badge), connection by provider (`Server` SQL Server, `Database` Oracle, `FileDatabase`-style `File` SQLite). Icons always have an accessible label (tooltip + `aria-label`); icon-only buttons show tooltip after 500 ms with the shortcut.

**Empty states** (each has icon, one-line title, one action button, optional secondary link):
- No connections: "Add your first connection" → opens dialog. Explorer not connected: "Connect to browse objects" → Connect. Results before any run: "Run a statement with Ctrl+Enter" (+ "Open sample SQLite database"). History empty: "Queries you run appear here". Filter yields nothing: "No rows match — Clear filter". Pending changes none: "Edit a cell to start" (in the preview). Codegen without selection: "Pick an object in the explorer or a result set".

**Keyboard-first and command registry.** `ui/src/commands/registry.ts`: `registerCommand({ id, title, category, shortcut?, when?, run })`. **Rule: every user action in a menu, toolbar, context menu or shortcut is a registered command; UI elements dispatch by id.** The palette (Ctrl+Shift+P) lists every command whose `when` is true, with shortcut and category; `commands.list()` is exposed on `window.__dbstudio.commands` in dev for the QA check. Shortcut sheet: **Ctrl+K Ctrl+S** opens a searchable list; conflicts are detected at registration (dev console error). Reserved shortcuts (final): Ctrl+N new tab, Ctrl+Shift+N new connection, Ctrl+P go to object, Ctrl+Shift+P palette, Ctrl+Enter / F5 / Shift+F5 run/script/cancel, Ctrl+Alt+Enter run on multiple, Ctrl+L / Ctrl+Shift+L explain, Shift+Alt+F format, Ctrl+K Ctrl+F format selection, Ctrl+J snippet, Ctrl+Alt+P parameters, Ctrl+F filter (grid/explorer/history, context-sensitive) and Monaco find in editor, Ctrl+Shift+F quick filter cell, Ctrl+S submit changes (grid/designer) or save file (editor), Ctrl+Z/Y undo/redo in grid buffer, F7 record view, F4 design/edit object, Ctrl+Alt+T new table, Ctrl+Alt+D open data, Ctrl+Alt+G generate code, Ctrl+Shift+K change connection, Ctrl+Shift+D change database, Ctrl+B explorer, Ctrl+R results, Ctrl+Shift+H history, Ctrl+Tab / Ctrl+Shift+Tab tab switch, Ctrl+1..9 tab by index, Ctrl+, settings, F1 help/shortcuts.

**Onboarding (first launch).** Welcome screen in the center area (no modal): headline "Connect to a database", three provider cards (SQL Server / Oracle / SQLite) → opens the connection dialog pre-selected; "Open a SQLite file" (file picker, instantly connected); "Try the sample database" creates `%APPDATA%\Rowlit\sample\shop.sqlite` from the test fixture and opens a console with a sample query; link "Import connections from DBeaver/DataGrip" deferred (shown greyed "coming soon" is NOT allowed — omit entirely). The connection dialog: Test button with inline result (server version, 120 ms), "Connect" saves and opens a console in one step, password-save checkbox with DPAPI note, colour picker with the palette above, folder combobox. After the first successful run, a one-time 3-tip strip under the toolbar (Ctrl+Enter, Ctrl+P, Ctrl+Shift+P) with "Got it". Theme follows OS by default.

**Accessibility basics.** Every interactive element reachable by Tab in reading order; visible 2 px focus ring (`--focus-ring`, offset 1 px) on all focusables including grid cells (glide's focus rect uses the token) and the SQL editor (an inset ring on the editor area while it has focus); the production marker on Run is an inner red border plus a PROD tag, never the outer ring; contrast ≥ 4.5:1 for text and ≥ 3:1 for icons/borders in both themes (checked with the tokens above); dialogs are `role=dialog` with `aria-modal`, focus trapped, Esc closes, initial focus on the first input; menus are `role=menu` with arrow-key navigation and typeahead; live region (`aria-live=polite`) announces run completion ("12 rows, 15 ms") and errors; grid exposes row/column count and current cell via `aria-rowcount`/`aria-colindex` on glide's accessibility tree; no information conveyed by colour alone (edited cells also get a border, errors an icon, connection colour has a name in the tooltip); respects `prefers-reduced-motion` (no animated spinners beyond opacity); UI zoom Ctrl+=/− applies to everything incl. grid.

---

## 4. Work breakdown (5 parallel packages)

Shared rules: additive-only contracts; the M1.5 wire types are appended to `ui/src/api/types.ts` and `ui/src/api/client.ts` inside a `// ---------- M1.5 ----------` block **by WP-F only** in its first hour (same pattern as WP-A in M1), together with the engine DTOs, so the four UI packages compile against them from the start. Any package needing a new field asks WP-F; nobody else edits those two files. `Settings` additions: `format`, `snippets`, `grid` (`density`, `pageSize`, `verifyUnchanged`), `connections.maxSessionsPerProfile` — types by WP-F, `DEFAULT_SETTINGS`/`merge` in `ui/src/store/settings.ts` by WP-J. Commands: each package registers its own commands in its own folder (`<folder>/commands.ts`), WP-J owns the registry and wires menu/context-menu items to command ids.

### WP-F — Engine M1.5
Owns: `engine/src/DbStudio.Core/{Designer,Plans,Params}/**`, `engine/src/DbStudio.Host/Endpoints/{Designer,Plans,Filters,Describe}*.cs`, `engine/src/DbStudio.Host/Contracts/M15.cs`, `engine/src/DbStudio.Providers.*/Designer/**`, `engine/src/DbStudio.Providers.*/Plans/**`, `engine/src/DbStudio.Providers.*/Params/**`, `engine/tests/**/M15/**`, `engine/tests/DbStudio.Core.Tests/FormatterParity/**`, plus the M1.5 blocks in `ui/src/api/types.ts` and `ui/src/api/client.ts`. Edits (owned): `ExecutionModels.cs` (add `Params` to `ExecuteRequest` with a default so M1 callers compile), `Program.cs` DI registrations, `HistoryService` query filters, `SessionManager` per-profile limit.
Scope: 3.8 endpoints; `ExecuteRequest.params` binding in all three providers' session code via an `IParamBinder` keyed service that each provider's session calls (`DbCommand` parameter creation, `OracleDbType.RefCursor` → extra result set, SQLite named/positional); `describe` via `CommandBehavior.SchemaOnly`; `TableModel` readers (T-SQL from `sys.*` incl. `sys.default_constraints`, `sys.computed_columns`, `sys.check_constraints`, `sys.identity_columns`; Oracle from `ALL_TAB_COLS`/`ALL_CONSTRAINTS`/`ALL_IND_COLUMNS`/`ALL_TAB_IDENTITY_COLS`/`ALL_COL_COMMENTS`; SQLite from `pragma_table_xinfo`, `pragma_index_*`, `pragma_foreign_key_list`, `sqlite_master.sql` parsed for CHECK/autoincrement/WITHOUT ROWID/STRICT); `TableDiff` + three `IDdlScripter`s incl. the SQLite rebuild; `apply` with transaction semantics per dialect; `IPlanReader`s; `/filters` JSON store under `%APPDATA%\Rowlit\filters.json`; `SESSION_LIMIT`; `/history` filters.
Acceptance/tests: unit tests for `TableDiff` (20 cases) and each scripter (golden DDL files per case: create, add column, rename column, change type, drop default, add FK, SQLite rebuild with indexes+triggers+views preserved, Oracle identity, T-SQL identity rebuild); conformance additions run against SQLite always and SQL Server/Oracle under Docker: apply round-trip (`GET table` → mutate → `script` → `apply` → `GET table` equals desired), parameters (typed binds incl. Oracle REF CURSOR returning rows), `describe` columns match a real run, explain returns ≥ 1 node per dialect; `curl` examples in `engine/tests/docker/README.md`.

### WP-G — Grid: filtering, data editing, data tab, parameters
Owns: `ui/src/filter/**`, `ui/src/components/FilterBar/**`, `ui/src/components/Grid/**` (M1 grid component gets editing; WP-G owns the whole folder now), `ui/src/components/ResultsPane/**`, `ui/src/components/DataTab/**`, `ui/src/components/RecordView/**`, `ui/src/components/PendingChanges/**`, `ui/src/components/ParamsDialog/**`, `ui/src/store/{filters,edits,params}.ts`, `ui/src/data/sqlgen.ts` (UPDATE/INSERT/DELETE/paging/COUNT generation per dialect).
Depends on: WP-F types; intel `statementAt`/model for ORDER BY hoisting (read-only use of `createIntel`).
Acceptance: filter model tests (operators × kinds, AND/OR groups, 1M-row perf); server push rewrite tests for the three dialects incl. ORDER BY hoisting and limit warning; quick filter from cell; saved filters round-trip through `/filters`; data tab paging + sort + count on SQLite fixture; editing: edit/insert/delete → preview shows correct SQL with params → submit in tx → refetch; conflict mode; params dialog appears for `:id` on Oracle and `@id` on T-SQL, remembers values; MSW-based component tests for FilterBar, PendingChanges, ParamsDialog; manual: 100k-row result stays smooth with a 3-condition filter.

### WP-H — Formatter, snippets, explain plan view, editor integration
Owns: `ui/src/format/**`, `ui/src/snippets/**`, `ui/src/components/PlanView/**`, `ui/src/editor/**` edits (formatting provider, snippet completion source, postfix templates, parameter gutter hint, explain commands), `ui/src/intel/complete/postfix.ts` (new file inside intel, coordinated with WP-D's completer by a single hook `extraSources`), `ui/src/components/SnippetsSettings/**`.
Acceptance: formatter guarantees of 1.2 (idempotency, token equality, comment preservation, ScriptDom parity for T-SQL fixtures, 5k-line perf); format document/selection commands; DDL tab "Formatted" toggle; snippets appear at statement start and via Ctrl+J, user snippets persist; postfix `.sel` works for resolved tables; plan view renders fixture plans for all three dialects (JSON fixtures recorded from WP-F) with cost highlighting; no console errors in the playground page.

### WP-I — Designers and code generation
Owns: `ui/src/designer/**` (table, view, procedure wizard, edit-object rewrite `ui/src/designer/rewrite.ts`, DDL preview component, DiffEditor compare), `ui/src/codegen/**` (generators, type tables, naming, `__tests__`), `ui/src/components/CodegenPanel/**`, `ui/src/components/ObjectTab/**` edits (Design/Edit/Generate code buttons — ObjectTab moves to WP-I ownership), `engine/tests/Codegen.Smoke/**` (C# compile smoke of generated output; coordinated with WP-F for the csproj inclusion in `DbStudio.slnx`).
Acceptance: table designer create/alter flows on SQLite (rebuild path) and SQL Server/Oracle under Docker; preview updates live; hand-edited preview applies verbatim; view designer describe preview; procedure wizard templates per dialect; F4 edit rewrites headers correctly (`CREATE OR ALTER`, `OR REPLACE`, SQLite drop+create); codegen snapshots for every language×flavor on the shop fixture, nullable and naming options, parameterized query code, procedure wrappers incl. output params and REF CURSOR; C# smoke compiles; keyboard-only operation of the column grid.

### WP-J — Shell, design system, multi-connection, go-to-object, onboarding
Owns: `ui/src/commands/**` (registry, palette data, shortcut sheet), `ui/src/theme/**` (tokens.css, Monaco and glide theme derivation, density), `ui/src/components/{layout,CommandPalette,Explorer,HistoryPanel,StatusBar,Toolbar,Onboarding,ConnectionsPanel,MultiRun,EmptyState,Shortcuts}/**`, `ui/src/components/ConnectionDialog/**` (polish), `ui/src/store/{settings,ui,tabs,connections,sessions}.ts` edits, `ui/src/App.tsx`, `desktop/src/main/menu.ts` (new menu items for the new commands — WP-J edits, WP-E reviews), `ui/src/lib/fuzzy.ts` improvements.
Scope: everything in section 3; 1.1.2/1.1.3 explorer and history filters; 1.5 connection pill/switcher, active connections panel, parallel catalog spinners, multi-run UI (A6); A3 go-to-object; context-menu wiring of commands registered by WP-G/H/I (`designer.*`, `codegen.*`, `data.open`, `format.*`, `explain.*`); welcome/onboarding; sample database creation (engine endpoint `POST /sample-db` provided by WP-F); accessibility pass; empty states.
Acceptance: `commands.list()` covers every menu/toolbar/context item (automated test walks the menu model and context-menu definitions); shortcut conflicts = 0; token lint passes (no hex colours outside `theme/`); contrast test on tokens; onboarding flow in browser mode with no connections; multi-run on two SQLite connections shows grouped results; go-to-object < 30 ms on 50k objects; Explorer/History filter chips; keyboard-only walkthrough (connect → run → filter → edit → submit) recorded as a Playwright-free vitest+jsdom smoke where feasible and as a manual script in `docs/qa/m15-walkthrough.md`.

Integration order: WP-F contracts (hour 0) → all five in parallel → WP-J wires the commands of G/H/I as they land (each exposes `commands.ts` early with stub handlers) → WP-F fixtures for plan/designer recorded for the UI tests → end-to-end on SQLite, then Docker SQL Server/Oracle.

---

## 3.7–3.9 New API endpoints (additive to PLAN.md section 3)

Errors reuse the existing envelope; new codes: `SESSION_LIMIT`, `DDL_FAILED` (detail includes `failedIndex`, `executed`), `NOT_EDITABLE`.

### 3.7 Filters and history
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/filters?connectionId=&signature=` | – | `[ SavedFilter ]` where `SavedFilter = { "id":"f_01J..", "connectionId":"c_..", "signature":"Id:int|Name:string|Total:decimal", "name":"Big customers", "model": FilterModel, "createdAt":"...", "lastUsedAt":"..." }` (`signature` omitted → all for the connection) |
| POST | `/filters` | `SavedFilter` without id/dates | `SavedFilter` |
| PUT | `/filters/{id}` | partial `{ "name"?, "model"?, "lastUsedAt"? }` | `SavedFilter` |
| DELETE | `/filters/{id}` | – | 204 |
| GET | `/history?...&status=ok,error&from=ISO&to=ISO&pinned=true` | – | existing shape; `label` may now also be `"filter"|"data"|"multi"|"explain"` |

### 3.8 Sessions: parameters, describe, explain
`ExecuteRequest` gains optional `"params":[ { "name":"id", "kind":"int"|"string"|"decimal"|"float"|"bool"|"date"|"datetime"|"datetimeoffset"|"time"|"guid"|"binary"|"null"|"refcursor", "value": 12 | "2026-01-01" | "<base64>" | null, "direction":"in"|"out"|"inout" } ]`. Engine binds by name (`@id`, `:id`) or by position when the name is numeric (`"1"`) or the SQL uses `?`. `exec.done` gains optional `"outParams":[ { "name":"total", "value":... } ]`; a `refcursor` out param produces a normal `exec.resultset` sequence. Non-queries on read-only connections still rejected.

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/sessions/{sid}/describe` | `{ "sql":"SELECT ...", "params":[...]|null }` | `{ "columns":[ColumnInfo], "editable":true, "table":{ "schema":"dbo", "name":"Customers" }|null, "keyColumns":["Id"], "warnings":["ORDER BY ignored"] }` — uses `SchemaOnly`; never executes DML (classifier rejects non-SELECT with `VALIDATION`) |
| POST | `/sessions/{sid}/explain` | `{ "sql":"...", "params":[...]|null, "mode":"estimated"|"actual" }` | `202 { "executionId":"x_.." }`; the run streams normally (actual mode delivers result sets) and ends with a new event `{"type":"exec.plan","executionId","dialect","mode","root": PlanNode, "raw":"<xml or text>", "warnings":[...] }` where `PlanNode = { "id":1, "op":"Clustered Index Seek", "logicalOp":"Seek"|null, "object":"dbo.Customers.PK_Customers"|null, "estRows":1, "actualRows":1|null, "cost":0.0033, "costPct":42.1, "predicate":"[Id]=@id"|null, "warnings":["Missing index ..."], "children":[PlanNode] }` |
| GET | `/sessions` | – | existing `SessionInfo` gains `"executingSince":"..."|null, "tabId":"t1"|null, "label":"query1.sql"|null` (set from `ExecuteRequest.source`) |
| POST | `/sample-db` | – | `{ "path":"C:\\Users\\..\\DbStudio\\sample\\shop.sqlite", "connectionId":"c_.." }` (creates the fixture and a profile named "Sample: Shop") |

### 3.9 Designer
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/connections/{id}/designer/types?database=` | – | `{ "types":[ { "name":"nvarchar", "params":"length"|"precisionScale"|"none", "default":"nvarchar(100)", "category":"string"|"number"|"date"|"binary"|"other" } ], "features":{ "identity":true, "computed":true, "clusteredIndexes":true, "includedColumns":true, "filteredIndexes":true, "onUpdateAction":true, "comments":true, "renameColumn":true, "dropColumn":true, "withoutRowid":false, "strict":false, "transactionalDdl":true } }` |
| GET | `/connections/{id}/designer/table?database=&schema=&name=` | – | `TableModel` (1.3.1) |
| POST | `/connections/{id}/designer/table/script` | `{ "database":"...", "original": TableModel|null, "desired": TableModel }` | `{ "statements":[ { "sql":"ALTER TABLE ...", "kind":"alter", "warning":"Narrowing nvarchar(100) to nvarchar(50) may truncate data"|null } ], "rebuildRequired":false, "transactional":true, "warnings":[ "Oracle ignores ON UPDATE actions" ] }` |
| POST | `/connections/{id}/designer/view/script` | `{ "database", "schema", "name", "originalName":null|"OldName", "body":"SELECT ...", "options":{ "schemaBinding":false, "checkOption":false, "force":false } }` | same shape as above |
| POST | `/connections/{id}/designer/apply` | `{ "database":"...", "statements":["..."], "transactional":true }` | `{ "ok":true, "executed":3, "elapsedMs":40 }` or 409 `{ "error":{ "code":"DDL_FAILED", "message":"...", "detail":{ "failedIndex":1, "executed":1, "rolledBack":true, "providerError": ErrorInfo } } }` — runs on a dedicated short-lived connection; SQLite rebuild PRAGMAs handled as described; pushes `catalog.changed` on success |

Settings additions (`PUT /settings` partial merge, same object on GET): `"format":{ FormatOptions }`, `"snippets":[ { "id":"s_1", "name":"Select count", "prefix":"selc", "dialects":["tsql","plsql","sqlite"]|null, "body":"SELECT COUNT(*) FROM ${1:table}$0" } ]`, `"grid":{ "density":"comfortable"|"compact", "pageSize":1000, "verifyUnchanged":false }`, `"connections":{ "maxSessionsPerProfile":8 }`.

---

## 5. QA checklists (pass/fail; run after M1.5 on SQLite, then on the Docker SQL Server/Oracle)

### 5.1 Styles
- [ ] `grep -rn "#[0-9a-fA-F]\{3,8\}" ui/src --include=*.css --include=*.tsx --include=*.ts | grep -v src/theme/` returns nothing outside tests and mock data, and neither does `rgb(`/`rgba(`/`hsl(` (all colours via tokens; automated in `tokens.test.ts`).
- [ ] Every token in the section 3 table exists in `tokens.css` for both themes with the listed values; switching theme at runtime recolours editor, grid, menus and dialogs without reload.
- [ ] Contrast (measured with an automated checker on the tokens): `--fg`/`--bg-panel` ≥ 4.5:1, `--fg-muted`/`--bg-panel` ≥ 4.5:1, `--border`/`--bg-panel` ≥ 1.5:1 and `--border-strong` ≥ 3:1, `--accent-fg`/`--accent` ≥ 4.5:1 in both themes.
- [ ] Font stacks and sizes as specified (UI 13 px, grid 13 px, editor = setting); numeric grid cells right-aligned with tabular numerals; NULL italic muted.
- [ ] Row heights: grid 28/24 px by density setting, explorer 24 px, toolbar 36 px, status bar 24 px (measure with devtools).
- [ ] All icons are lucide at 16 px/stroke 1.5 (14 px only in the dense spots listed under Iconography); object-type icon mapping matches the table; no emoji glyphs anywhere in the UI.
- [ ] Focus ring visible (2 px, `--focus-ring`) on buttons, inputs, tree rows, tabs, grid cells, menu items in both themes.
- [ ] Edited/inserted/deleted cells use the `--cell-*` tokens and additionally a border/strikethrough (not colour alone).
- [ ] Zoom (Ctrl+=/−/0) scales the whole UI including grid and Monaco; no clipped toolbars at 150%.

### 5.2 Functional logic
- [ ] Filter: for each kind, each listed operator produces correct rows on the fixture (e.g. `Total between 10 and 20` inclusive; `contains` case-insensitive by default; `isNull` matches only NULL, not empty string; `isEmpty` matches `''` only; dates `onDate` ignores time part).
- [ ] Nested group `(A AND B) OR C` evaluates correctly; removing a middle condition re-evaluates; Clear restores all rows and the count.
- [ ] Server push: generated SQL for a SELECT with top-level ORDER BY hoists the ORDER BY; with a CTE wraps correctly; Oracle uses no `AS`; values arrive as parameters (verify in Messages/log that no literal appears); button disabled for proc results and multi-statement batches.
- [ ] Saved filter reappears for a different query with the same column signature and not for a different one.
- [ ] Formatter: `format(format(x)) === format(x)` on all fixtures; comment count/text unchanged; T-SQL ScriptDom parity test passes; PL/SQL package body fixture keeps `/` lines and `END name;`; formatting a document with one broken statement leaves that statement verbatim and formats the rest, showing a warning.
- [ ] Table designer: add/rename/drop/retype column, add/drop PK/unique/index/FK/check on each dialect; preview equals golden DDL; apply then `GET designer/table` equals the desired model; SQLite rebuild preserves indexes, triggers, views and data (row count equal, FK check passes); failing apply on SQL Server/SQLite rolls back fully; Oracle reports `failedIndex`/`executed` accurately.
- [ ] View/proc edit: F4 rewrites header per dialect; running applies; Oracle compile error shows inline; SQLite view edit is atomic.
- [ ] Codegen: snapshots for all language×flavor pairs match; nullable column → nullable type per language default; identity column excluded from INSERT in CRUD code; procedure wrapper includes OUT params and return value; query code uses driver parameters for every detected parameter; names singularised and reserved words escaped (`class`, `type`, `select`).
- [ ] Data editing: edit 2 cells in one row → single UPDATE with 2 SET items; new row with identity → INSERT without identity column and refetched Id shown; delete → DELETE by all PK columns; submit failure keeps buffer and shows error; Ctrl+Z undoes last cell edit; read-only connection shows NOT_EDITABLE and no editors open; results of a JOIN are not editable (badge explains why).
- [ ] Parameters: `@id` undeclared on T-SQL prompts; `DECLARE @id` in the batch does not prompt; Oracle `:id` prompts and binds; Oracle `refcursor` out param yields a result set; `?` positional on SQLite binds in order; values remembered per connection.
- [ ] Explain: estimated plan on each dialect yields a tree with cost % summing to ~100 at the root's children; actual plan on SQL Server also delivers the query's rows; cancel works mid-plan.
- [ ] Multi-connection: two tabs on different connections run concurrently (both timers advance); switching a tab's connection with an open transaction prompts; multi-run on 3 connections groups results and continues after one fails; `maxSessionsPerProfile` exceeded shows the close-idle-tabs offer.
- [ ] History filter params (`status`, `from/to`, `pinned`) return correct subsets; explorer type chips and column search behave as specified.

### 5.3 Design / UX
- [ ] First launch (no connections): welcome screen with provider cards, "Open SQLite file", "Try the sample database"; sample DB path created and console opens with a runnable query; no modal appears unprompted.
- [ ] Connection dialog: Test shows server version inline within the dialog; "Connect" saves and opens a console in one action; colour and folder pickers present.
- [ ] Every empty state in section 3 exists with icon + title + one action (check: results, explorer, history, filter, pending changes, codegen).
- [ ] Each toolbar action, context-menu item and menu item appears in Ctrl+Shift+P with the same title and shortcut (automated `commands.list()` coverage test is green; manual spot-check 10 items).
- [ ] Shortcut sheet (Ctrl+K Ctrl+S) lists every registered shortcut; zero conflicts reported in the dev console at startup.
- [ ] Keyboard-only walkthrough (`docs/qa/m15-walkthrough.md`): add connection → run → open filter with Ctrl+F → quick filter → open data tab → edit cell → Ctrl+S submit → F4 design → Shift+Alt+F format → Ctrl+P jump → Ctrl+Alt+G codegen, all without the mouse; focus never gets lost (always a visible focused element).
- [ ] Dialogs: Esc closes, focus trapped, initial focus on first input, Enter triggers the primary action; menus navigable with arrows and typeahead.
- [ ] Screen-reader smoke (NVDA or Windows Narrator): run completion is announced; grid announces row/column position; icon-only buttons have names.
- [ ] Reduced motion respected; nothing blinks continuously except the execution timer text.
- [ ] Connection colour appears on the tab bar, pill and explorer root; read-only lock glyph visible; production (red) tints the Run button border; tooltip names the colour.

### 5.4 Features (end-to-end on the sample Shop database, then Docker)
- [ ] Open data tab on `Customers`, filter `Name contains 'a'` server-side, sort by `Id` desc, load more pages, count badge correct.
- [ ] Edit a customer, insert one, delete one, preview SQL, submit, verify by re-querying.
- [ ] Design `Orders`: add column `GiftMessage nvarchar(200) NULL` (T-SQL) / `GIFTMESSAGE VARCHAR2(200)` (Oracle) / `GiftMessage TEXT` (SQLite, native ADD COLUMN) and then change its type (SQLite → rebuild) — data preserved. (The sample `Orders` already has a `Note` column.)
- [ ] Create a view with the designer, see describe columns update while typing, apply, open it in explorer; edit with F4, apply again.
- [ ] New procedure wizard → template → fill body → F5 → explorer shows it; F4 reopens with `CREATE OR ALTER`/`OR REPLACE`.
- [ ] Generate C# Dapper repository + Go struct + TS interface for `Customers` and a parameterized query; C# smoke compiles.
- [ ] Format a 300-line script and the package body fixture; re-format is a no-op.
- [ ] Run a query with `:id`/`@id`, parameters dialog remembers the last value; explain plan opens with Ctrl+L.
- [ ] Open the same table on two connections (sample + a copy), run the script on both via Ctrl+Alt+Enter, compare the grouped results.
- [ ] Ctrl+P `t:ord` jumps to `Orders`; Shift+Enter inserts its name into the editor.

### 5.5 Code quality
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:intel` and `dotnet test engine` are green; new tests exist for every package's acceptance list (count ≥: filter 60, formatter 120 fixtures+tests, designer/diff 40, scripters 30 golden files, codegen snapshots ≥ 35, grid editing 30, commands coverage 1, plan parsers 12).
- [ ] No package edited files outside its ownership list (review `git log --stat` per branch); `ui/src/api/types.ts`/`client.ts` changes are only in the M1.5 block authored by WP-F; `IDbProvider.cs` unchanged except additive default interface members (waiver, round 1 B1): `IDbSession.LostTransaction => false` and `IDbSession.FindUnboundParameter(...) => null`; providers need not implement them.
- [ ] Formatter, filter model, codegen and designer diff/rewrite modules import nothing from React, Monaco or the DOM (static import check).
- [ ] No `any` in new TS code except declared driver boundaries (`oxlint` rule on); C# nullable enabled with zero warnings in new files.
- [ ] Every new engine endpoint validates input (400 `VALIDATION` with a message naming the field) and is covered by an integration test on SQLite; DDL apply never runs user statements on the catalog connection or a tab session.
- [ ] No secrets or SQL values logged at info level; parameter values appear in logs only at debug.
- [ ] Bundle: `npm run build` size growth over M1 < 600 KB gzipped (Monaco languages for codegen loaded lazily via dynamic import); the formatter and codegen are code-split chunks. CI enforces this with `.github/scripts/bundle-size.mjs --budget-kb 600` against `.github/bundle-size-baseline.json`, which holds the M1 UI build (commit `bfaac37`); do not re-baseline it to a later build.
- [ ] Documentation: `docs/PLAN.md` section 3 gets a pointer to this spec's 3.7–3.9 (edit by WP-F), `README.md` feature list updated (WP-J), `docs/qa/m15-walkthrough.md` present.

### Critical Files for Implementation
- E:\DbStudio\ui\src\api\types.ts (and E:\DbStudio\ui\src\api\client.ts) — the M1.5 additive wire block that every UI package compiles against; authored by WP-F in hour 0
- E:\DbStudio\engine\src\DbStudio.Core\Models\ExecutionModels.cs — `ExecuteRequest.Params` addition that powers parameters, server filters and data editing in all three providers
- E:\DbStudio\engine\src\DbStudio.Core\Designer\TableDiff.cs (new) with the three `Designer/*DdlScripter.cs` in the provider projects — the correctness core of the table designer, incl. the SQLite rebuild
- E:\DbStudio\ui\src\format\layout.ts (new) over E:\DbStudio\ui\src\intel\types.ts tokens — the comment-preserving, idempotent formatter for all dialects
- E:\DbStudio\ui\src\commands\registry.ts (new) with E:\DbStudio\ui\src\store\ui.ts — the command registry that makes palette coverage, shortcuts and context menus checkable
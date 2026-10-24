# WP-CS (Cassandra / ScyllaDB, dialect `cql`) — UI intel notes

Part of WP-CS: the CQL IntelliSense, splitter, formatter rules, type map and fixture. The engine provider (lead) and
`components/Cassandra/**` + `mocks/packs/cassandra.ts` (parallel agent) have their own notes. File:line references are
to the WP0 commit `686056e`.

## What is in

| File | What |
|---|---|
| `ui/src/intel/dialect/cql.ts` | `define(kit)`: CQL 3.4 + Cassandra 5 keywords (reserved words plus the non-reserved grammar words that are hardly ever column names: FILTERING, TTL, WRITETIME, KEY, CONTAINS, the consistency levels…; `type`, `user`, `role`, `replication`, `password` stay contextual), statement starts (BEGIN/APPLY BATCH, TRUNCATE, USE, DESCRIBE/DESC, LIST, GRANT/REVOKE, CONSISTENCY, SERIAL, TRACING, PAGING, SHOW, EXPAND), data types (`set` left out on purpose: SET is a keyword and the editor would colour UPDATE … SET as a type), `caseFolding: 'lower'`, `"` identifiers, 16 snippets (batch, unlogged batch, keyspace, table with clustering key, UDT, MV, SAI index, ANN vector query, Java UDF, `cons` with a Monaco choice of the 11 consistency levels, …), start keywords (incl. `CONSISTENCY <level>` phrases), CQL after-source / after-expression keywords (ALLOW FILTERING, PER PARTITION LIMIT, CONTAINS KEY, IF EXISTS, ANN OF), `ops2` without `||` / `::` / `>>` (so `frozen<list<int>>>` closes bracket by bracket), the `classify` hook, `keywordFollowers` data (R3-3), lexer hook. |
| lexer hook (in `cql.ts`) | `//` line comments (cqlsh), uuid literals and duration literals (`1h30m`, `12mo`, `500ms`) as one number token, then `traitLexer({ paramPrefixes: ':?', dollarQuotes: true, hexNumbers: true })` (`?` / `:name` bind markers, `$$ … $$` UDF bodies, `0x…` blobs). `--` and `/* */` are the lexer's own. |
| `ui/src/intel/dialect/data/cql-functions.json` | 129 functions: now, uuid, current_* / to_date / to_timestamp / to_unix_timestamp / min_/max_timeuuid (Cassandra 5 snake_case names, the camelCase names as deprecated aliases; dateOf / unixTimestampOf deprecated, removed in 5.0), token, ttl, writetime, maxwritetime, `<type>_as_blob` / `blob_as_<type>` for 18 types (+ camelCase aliases), to_json / from_json, cast, count/min/max/sum/avg, abs/exp/log/log10/round, map_keys/map_values/collection_*, mask_*, similarity_*; operators (CONTAINS, CONTAINS KEY, ANN OF, `+`/`-` on collections and counters …). |
| `ui/src/intel/dialect/data/cql-system.json` | `systemCatalog`: system_schema (11 tables incl. Cassandra 5 column_masks), system (local, peers, peers_v2, size_estimates, table_estimates, compaction_history, built_views, prepared_statements), system_traces (sessions, events), system_auth (roles, role_permissions, role_members, resource_role_permissons_index, network_permissions), system_views (12 virtual tables). Real CQL column types, keys flagged like the shop fixture. |
| `ui/src/intel/split/cql.ts` | `BEGIN [UNLOGGED\|COUNTER] BATCH … APPLY BATCH` is one statement (inner `;` and blank lines included; it also ends a preceding statement that has no `;`; without APPLY BATCH it runs to the end); everything else through `kit.splitSemicolon` (so `$$` bodies, which are single tokens, never split). |
| classify (in `cql.ts`) | DROP …, TRUNCATE → destructive; BATCH → the kind of its first DML statement (never destructive); UPDATE / DELETE → plain update / delete (CQL always needs the primary key, there is no whole-table UPDATE/DELETE); DESCRIBE / DESC / LIST / SHOW → `other`; USE → `use`; CONSISTENCY / SERIAL / TRACING / PAGING / EXPAND → `set`; GRANT / REVOKE → `grant`. |
| `ui/src/format/rules/cql.ts` | FormatRules factory: CQL statement starts (resync points), incomplete words, function keywords (TOKEN, TTL, WRITETIME, CAST, KEYS, ENTRIES, FULL: no space before `(`), operand keywords (+ NAN, INFINITY, UNSET). The layout itself needs R3-1 for batches, type arguments and literals. |
| `ui/src/codegen/types/cql.json` | The 21 native CQL types → C# / Go / TS / Java / Python as the DataStax drivers return them where that compiles without extra imports (varint → `System.Numerics.BigInteger` / `java.math.BigInteger`, timestamp → DateTimeOffset / `java.time.Instant`, inet → IPAddress / `java.net.InetAddress`, blob → `java.nio.ByteBuffer` …). Collections need R3-4 (they fall back to the wire kind meanwhile). Kept small on purpose: the type maps are in the initial `actions` chunk. |
| `ui/src/intel/__tests__/fixtures/shop-cql.json` | The seed's `shop` keyspace: 8 tables, the `orders_by_status` MV, UDT `address` (`type`), UDF `line_total` (`func`). Columns in Cassandra's order (partition keys, clustering keys, then the rest alphabetically), CQL type text (`frozen<address>`, `set<text>`, `map<text, text>`), `isPk` + `nullable: false` for partition and clustering columns, comments `partition key`, `partition key (1 of 2)`, `clustering key ASC|DESC`. `database: null`, `defaultSchema: 'shop'`, `databases: []` (like the Oracle fixture: the keyspace is the schema level). |
| `ui/src/editor/dev/EditorPlayground.tsx` (WP-CS block) | A CQL tour of the shop keyspace (USE, CONSISTENCY, partition / clustering queries, timeuuid functions, collections, LWT, counter, BATCH, UDF, DESCRIBE). |
| tests | `ui/src/intel/__tests__/cql.test.ts` (38), `ui/src/format/__tests__/cql-format.test.ts` (29), `ui/src/codegen/__tests__/cql-types.test.ts` (5). Tests titled `(R3-n)` probe for the shared change and skip themselves until it is in (4 intel, 8 format, 1 codegen); with the R3 diffs below applied all 72 pass (checked by running the suites against patched copies, see "How the R3 diffs were checked"). |

## Measurements

- Initial load: **+0.2 KB** gzipped from this part (the native type map in the initial `actions` chunk; measured by
  building with the WP0 stub `cql.json` and with mine: 1566.5 → 1566.7 KB on the shared worktree). Everything else is in
  the lazy `cql` chunk: **58.2 KB raw / 11.6 KB gzipped** (was 0.32 KB; the function catalog and the system keyspaces
  are most of it). The R3 diffs add code to shared initial chunks (layout ~1 KB raw, parser/completer/codegen
  ~0.3 KB raw each): estimate +0.6 KB gzipped once applied.
- `npm run test:intel`: green except the known timing tests ("5,000-line T-SQL script formats in < 150 ms", and on this
  loaded machine also the PostgreSQL twin): 157 / 213 ms under the full parallel run, also failing on the unchanged
  base tree in the same session; green with `CI=1`. They do not format CQL.

## Deviations

1. **Object.assign for `keywordFollowers`.** `DialectSpec` has no such field yet (R3-3), so `define` returns
   `Object.assign(spec, { keywordFollowers })`; once R3-3 is in, the completer reads it. No behaviour until then.
2. **More non-reserved words lexed as keywords** than the CQL "reserved" list: the shared formatter upper-cases only
   keyword tokens (contextual words are written as typed except a few hard-wired cases), and name diagnostics skip
   keywords. Cost: a column literally named `key`, `ttl`, `json`, `version`, `host` or `session` is coloured as a keyword
   and upper-cased by the formatter (still valid CQL: unquoted names are case-insensitive).
3. **`set` is not in `dataTypes`** (see above): `set<…>` is not offered by type completion; `list`, `map`, `tuple`,
   `frozen`, `vector` are.
4. **Snake_case function names first.** Cassandra 5 renamed the native functions (CASSANDRA-18037); the camelCase names
   are kept as deprecated aliases so 4.x users get signatures and hover too. The completion list shows both (the
   deprecated ones struck through).
5. The fixture has no second keyspace (the seed has one); cross-keyspace completion is tested on the system keyspaces.

## Requests

All diffs below apply cleanly on `686056e` (`git apply --check`), typecheck (`tsc` over the patched files with the app
compiler options) and keep `npm run test:intel` + `src/codegen` green apart from the known timing tests; every change is
guarded by `this.d === 'cql'` / `spec.id === 'cql'` (or a new optional spec field), so the other dialects' fixtures are
untouched.

### R3-1 ui/src/format/layout.ts — CQL layout: batches, type arguments, literals, CQL clauses
Reason: through the SQLite path, `BEGIN BATCH INSERT … VALUES (…); …` glues the first statement to `BEGIN BATCH` and
leaves the body unindented; `map<text, text>` becomes `MAP < text, text >` (and a column list wraps at its comma);
`{…}` / `[…]` literals get inner spaces and their commas break the SET / ORDER BY lists (`phones = [ '1',⏎ '2' ]`);
`PRIMARY KEY ((a, b), c)` becomes `PRIMARY KEY ( (a, b), c)`; `PER PARTITION LIMIT` is cut before LIMIT. The diff adds:
`cqlBatch` (body one level in, APPLY BATCH under BEGIN, optional `USING TIMESTAMP`), generic-bracket spacing + data-type
casing inside `<…>` + no list break at commas inside them, `{…}`/`[…]` matched like parentheses and laid out inline by the
existing `bracket()` (generalised to `}`), no space after `(` before `(`, clause lines for `IF …`, INSERT `USING TTL …`,
`ALLOW FILTERING`, `PER PARTITION LIMIT`, MV `PRIMARY KEY` / `WITH`, `AND` lines for `WITH` table / keyspace options,
header lines for CREATE FUNCTION / AGGREGATE. Goldens: `cql-format.test.ts` "(R3-1)".
Proposed diff:
```diff
--- a/ui/src/format/layout.ts
+++ b/ui/src/format/layout.ts
@@ -64,4 +64,8 @@ const OBJECT_WORDS = set('TYPE BODY PACKAGE SEQUENCE SYNONYM MATERIALIZED DIRECT
 const ITEM_START_WORDS = set('CONSTRAINT PRIMARY FOREIGN');
 const CURSOR_WORDS = set('LOCAL GLOBAL FORWARD_ONLY SCROLL STATIC KEYSET DYNAMIC FAST_FORWARD READ_ONLY SCROLL_LOCKS OPTIMISTIC TYPE_WARNING INSENSITIVE');
+/** CQL: collection / wrapper types taking `<…>` type arguments. */
+const CQL_GENERIC = set('LIST SET MAP FROZEN TUPLE VECTOR');
+/** CQL CREATE FUNCTION / AGGREGATE: header words that start a continuation line. */
+const CQL_ROUTINE_LINES = set('RETURNS CALLED LANGUAGE SFUNC STYPE FINALFUNC INITCOND');
 
 interface St {
@@ -89,4 +93,8 @@ interface St {
   /** PostgreSQL CREATE INDEX that does not fit on one line: INCLUDE / WITH / WHERE start continuation lines. */
   pgIndexBreak?: boolean;
+  /** CQL CREATE / ALTER … WITH options: AND starts a continuation line. */
+  cqlOptions?: boolean;
+  /** CQL CREATE FUNCTION / AGGREGATE: RETURNS, LANGUAGE, AS … start continuation lines. */
+  cqlRoutine?: boolean;
 }
 
@@ -131,4 +139,10 @@ export class Layout {
   /** Inside an inline table-valued function body (RETURN SELECT …). */
   private inlineTvf = false;
+  /** CQL: the `<` / `>` of type arguments (`map<text, frozen<list<int>>>`). */
+  private readonly angles = new Set<number>();
+  /** CQL: words cased as data types there (the generic word and the data types inside its brackets). */
+  private readonly angleTypes = new Set<number>();
+  /** CQL: commas inside type arguments (never list separators). */
+  private readonly angleCommas = new Set<number>();
 
   constructor(toks: FTok[], spec: DialectSpec, o: FormatOptions, eol: string) {
@@ -154,4 +168,38 @@ export class Layout {
     }
     if (stack.length) this.problem = 'unbalanced parentheses';
+    if (this.d === 'cql') this.cqlScan();
+  }
+
+  /** CQL: type-argument brackets, and the `{…}` / `[…]` literal pairs (matched like parentheses for after()). */
+  private cqlScan(): void {
+    const angle: number[] = [];
+    const lit: number[] = [];
+    for (let k = 0; k < this.sig.length; k++) {
+      const t = this.S(k)!;
+      if (t.kind !== 'op') {
+        if (angle.length && t.word && this.spec.dataTypeSet.has(t.u)) this.angleTypes.add(k);
+        if (angle.length && t.kind === 'punct' && t.text === ',') this.angleCommas.add(k);
+        continue;
+      }
+      if (t.text === '<' && this.S(k - 1)?.word && CQL_GENERIC.has(this.U(k - 1))) {
+        angle.push(k);
+        this.angles.add(k);
+        this.angleTypes.add(k - 1);
+      } else if (t.text === '>' && angle.length) {
+        angle.pop();
+        this.angles.add(k);
+      } else if (t.text === '{' || t.text === '[') lit.push(k);
+      else if ((t.text === '}' || t.text === ']') && lit.length) {
+        const o = lit.pop()!;
+        this.match[o] = k;
+        this.match[k] = o;
+      }
+    }
+  }
+
+  /** CQL `{` / `[` of a collection, UDT or vector literal. */
+  private litOpen(k: number): boolean {
+    const t = this.S(k);
+    return this.d === 'cql' && !!t && t.kind === 'op' && (t.text === '{' || t.text === '[');
   }
 
@@ -196,5 +244,5 @@ export class Layout {
   /** Skip a parenthesised group starting at k (returns the index after `)`). */
   private after(k: number): number {
-    return this.P(k, '(') && this.match[k] > k ? this.match[k] + 1 : k + 1;
+    return (this.P(k, '(') || this.litOpen(k)) && this.match[k] > k ? this.match[k] + 1 : k + 1;
   }
 
@@ -347,4 +395,11 @@ export class Layout {
       if (a.kind === 'op' && (at === '[' || at === ':')) return false;
     }
+    if (this.d === 'cql') {
+      // map<text, int>, {'k': 1}, ['a'], m['k']
+      if (this.angles.has(k) || (this.angles.has(k - 1) && at === '<')) return false;
+      if (a.kind === 'op' && (at === '{' || at === '[')) return false;
+      if (b.kind === 'op' && (bt === '}' || bt === ']')) return false;
+      if (b.kind === 'op' && bt === '[' && (a.kind === 'ident' || a.kind === 'quotedIdent' || at === ']')) return false;
+    }
     if (this.d === 'plsql' && a.kind === 'op' && at === '<<') return false;
     if (this.d === 'plsql' && b.kind === 'op' && bt === '>>') return false;
@@ -357,4 +412,5 @@ export class Layout {
     // MERGE … USING (SELECT …) / JOIN t USING (id): a clause keyword, never a function call
     if (a.word && a.u === 'USING') return true;
+    if (this.d === 'cql' && a.kind === 'punct' && a.text === '(') return false;
     if (this.d === 'pgsql') {
       if (a.kind === 'punct' && a.text === '(') return false;
@@ -383,4 +439,5 @@ export class Layout {
   private isTypeAt(k: number): boolean {
     const t = this.S(k)!;
+    if (this.angleTypes.has(k)) return true;
     if (!this.spec.dataTypeSet.has(t.u)) return false;
     const a = this.S(k - 1), b = this.S(k + 1);
@@ -449,5 +506,5 @@ export class Layout {
   private commas(a: number, b: number): number {
     let n = 0;
-    for (let k = a; k < b; k = this.after(k)) if (this.P(k, ',')) n++;
+    for (let k = a; k < b; k = this.after(k)) if (this.P(k, ',') && !this.angleCommas.has(k)) n++;
     return n;
   }
@@ -499,7 +556,29 @@ export class Layout {
     else if (this.d === 'plsql') this.plStatement(indent, outer);
     else if (this.d === 'pgsql') this.pgStatement(indent, outer);
+    else if (this.d === 'cql' && this.cqlBatchAt(this.p) >= 0) this.cqlBatch(indent, this.cqlBatchAt(this.p));
     else this.sqliteStatement(indent, outer);
   }
 
+  // ------------------------------------------------------------------ CQL
+
+  /** `BEGIN [UNLOGGED | COUNTER] BATCH` at k: the index of BATCH, else -1. */
+  private cqlBatchAt(k: number): number {
+    if (!this.W(k, 'BEGIN')) return -1;
+    if (this.W(k + 1, 'BATCH')) return k + 1;
+    return (this.W(k + 1, 'UNLOGGED') || this.W(k + 1, 'COUNTER')) && this.W(k + 2, 'BATCH') ? k + 2 : -1;
+  }
+
+  /** BEGIN BATCH [USING TIMESTAMP n], its statements one level in, APPLY BATCH under BEGIN. */
+  private cqlBatch(indent: number, batchAt: number): void {
+    while (this.p <= batchAt) this.takeKw();
+    if (this.W(this.p, 'USING')) this.expr((k) => DML_START.has(this.U(k)) || this.W(k, 'APPLY'), {});
+    this.statements(indent + 1, (k) => this.W(k, 'APPLY') && this.W(k + 1, 'BATCH'));
+    if (this.eof()) return;
+    this.out.newline(indent);
+    this.take({ kw: true, closer: true });
+    this.takeKw();
+    if (this.P(this.p, ';')) this.take({ space: false });
+  }
+
   // ------------------------------------------------------------------ T-SQL
 
@@ -1180,5 +1259,12 @@ export class Layout {
         return v.has('SELECT') && (n === 'XML' || n === 'JSON' || n === 'BROWSE' || n === 'UPDATE' || n === 'READ' || (this.d === 'pgsql' && (n === 'SHARE' || n === 'NO' || n === 'KEY'))) ? ['for', 1] : null;
       }
-      case 'LIMIT': return this.d !== 'plsql' ? ['limit', 1] : null;
+      case 'LIMIT': return this.d !== 'plsql' && !(this.d === 'cql' && this.W(k - 1, 'PARTITION')) ? ['limit', 1] : null;
+      // CQL: PER PARTITION LIMIT n, ALLOW FILTERING, IF [NOT] EXISTS / IF cond, INSERT … USING TTL, CREATE MATERIALIZED
+      // VIEW … PRIMARY KEY (…) WITH …
+      case 'PER': return this.d === 'cql' && this.W(k + 1, 'PARTITION') && this.W(k + 2, 'LIMIT') ? ['limit', 3] : null;
+      case 'ALLOW': return this.d === 'cql' && this.W(k + 1, 'FILTERING') ? ['allow', 2] : null;
+      case 'IF': return this.d === 'cql' && (v.has('INSERT') || v.has('UPDATE') || v.has('DELETE')) && st.clause !== 'if' ? ['if', 1] : null;
+      case 'PRIMARY': return this.d === 'cql' && this.verbCtx === 'CREATE' && this.W(k + 1, 'KEY') ? ['primaryKey', 2] : null;
+      case 'WITH': return this.d === 'cql' && this.verbCtx === 'CREATE' && st.clause === 'primaryKey' ? ['options', 1] : null;
       case 'OFFSET': return ['offset', 1];
       case 'FETCH': return this.W(k + 1, 'FIRST') || this.W(k + 1, 'NEXT') ? ['fetch', 1] : null;
@@ -1187,4 +1273,5 @@ export class Layout {
       case 'USING':
         if (this.d === 'pgsql' && v.has('DELETE') && !v.has('MERGE') && st.clause === 'from') return ['from', 1];
+        if (this.d === 'cql' && v.has('INSERT') && (st.clause === 'values' || st.clause === 'if' || st.clause === 'insert')) return ['using', 1];
         return v.has('MERGE') && st.clause === 'merge' ? ['using', 1] : null;
       case 'WHEN': return v.has('MERGE') ? ['when', 1] : null;
@@ -1507,5 +1594,5 @@ export class Layout {
     st.list = false;
     st.between = 0;
-    st.andOr = this.o.andOrOnNewLine && (name === 'where' || name === 'having' || name === 'connect' || name === 'start' || name === 'on');
+    st.andOr = this.o.andOrOnNewLine && (name === 'where' || name === 'having' || name === 'connect' || name === 'start' || name === 'on' || (this.d === 'cql' && (name === 'if' || name === 'options')));
     if (name === 'select') {
       while (!this.eof() && SELECT_MODIFIERS.has(this.U(this.p))) this.takeKw();
@@ -1573,4 +1660,11 @@ export class Layout {
         }
         if (u === 'CURSOR' && st.verb === 'DECLARE') { st.seenCursor = true; st.commaBreak = false; }
+        if (this.d === 'cql' && !st.dml && (st.verb === 'CREATE' || st.verb === 'ALTER')) {
+          // CREATE TABLE … WITH a = 1⏎ AND b = 2; CREATE FUNCTION f(…)⏎ RETURNS …⏎ LANGUAGE java⏎ AS $$ … $$
+          if (u === 'WITH') st.cqlOptions = true;
+          else if (u === 'AND' && st.cqlOptions) { this.out.newline(st.base + 1); this.takeKw(); continue; }
+          if ((u === 'FUNCTION' || u === 'AGGREGATE') && !st.cqlRoutine) st.cqlRoutine = true;
+          else if (st.cqlRoutine && (CQL_ROUTINE_LINES.has(u) || (u === 'AS' && this.S(k + 1)?.kind === 'string')) && !this.out.atLineStart) this.out.newline(st.base + 1);
+        }
         if (st.pgIndexBreak && (u === 'INCLUDE' || u === 'WHERE' || (u === 'WITH' && this.P(k + 1, '('))) && !this.out.atLineStart) this.out.newline(st.base + 1);
         if (!st.dml && u === 'FOR' && st.verb === 'OPEN' && (this.W(k + 1, 'SELECT') || this.isCteAt(k + 1))) {
@@ -1632,5 +1726,5 @@ export class Layout {
         if (st.verb === 'INSERT' && (u === 'SELECT' || u === 'EXEC' || u === 'EXECUTE')) st.insertHasSource = true;
       }
-      if (this.d === 'pgsql' && t.kind === 'op' && t.text === '[') { this.bracket(); continue; }
+      if ((this.d === 'pgsql' && t.kind === 'op' && t.text === '[') || this.litOpen(k)) { this.bracket(); continue; }
       if (t.kind === 'punct' && t.text === ',' && (st.list || st.commaBreak)) {
         this.comma(st.list ? st.listIndent : st.base + 1, true);
@@ -1708,7 +1802,7 @@ export class Layout {
       this.out.newline(L + 1);
       while (this.p < e && !this.eof()) {
-        if (this.P(this.p, ',')) { this.comma(L + 1, true); continue; }
+        if (this.P(this.p, ',') && !this.angleCommas.has(this.p)) { this.comma(L + 1, true); continue; }
         const start = this.p;
-        this.expr((q) => q >= e || this.P(q, ','), group && this.o.andOrOnNewLine ? { andOrIndent: L + 1 } : {});
+        this.expr((q) => q >= e || (this.P(q, ',') && !this.angleCommas.has(q)), group && this.o.andOrOnNewLine ? { andOrIndent: L + 1 } : {});
         if (this.p === start) this.take({ kw: this.S(this.p)?.kind === 'keyword' });
       }
@@ -1719,11 +1813,12 @@ export class Layout {
   }
 
-  /** PostgreSQL array subscript / constructor `[…]`: inline, commas never break. */
+  /** PostgreSQL array subscript / constructor `[…]`, CQL collection / UDT literal `{…}` / `[…]`: inline, commas never break. */
   private bracket(): void {
+    const close = this.S(this.p)!.text === '{' ? '}' : ']';
     this.take();
     while (!this.eof()) {
       const t = this.S(this.p)!;
-      if (t.kind === 'op' && t.text === ']') { this.take(); return; }
-      if (t.kind === 'op' && t.text === '[') { this.bracket(); continue; }
+      if (t.kind === 'op' && t.text === close) { this.take(); return; }
+      if (t.kind === 'op' && (t.text === '[' || this.litOpen(this.p))) { this.bracket(); continue; }
       if (t.kind === 'punct' && (t.text === ';' || t.text === ')')) return;
       if (t.kind === 'punct' && t.text === '(') { this.paren(this.parenKind(this.p, this.newSt(0, this.verbCtx, NEVER, true)), this.spaceBeforeParen(this.p)); continue; }
@@ -1764,5 +1859,5 @@ export class Layout {
         continue;
       }
-      if (this.d === 'pgsql' && t.kind === 'op' && t.text === '[') { this.bracket(); continue; }
+      if ((this.d === 'pgsql' && t.kind === 'op' && t.text === '[') || this.litOpen(k)) { this.bracket(); continue; }
       if (t.word) {
         if (t.u === 'CASE') { this.caseExpr(); continue; }
```
Local stub: none (the shared SQLite layout is used; the R3-1 goldens skip themselves: `R3_LAYOUT` probe).

### R3-2 ui/src/intel/parse/partial-parser.ts + ui/src/intel/diagnostics/soft-diagnostics.ts — CQL statement shapes
Reason: (a) a batch is parsed as one expression statement, so there is no table/column completion inside
`BEGIN BATCH … APPLY BATCH`; (b) `UPDATE t USING TTL n SET …` loses its SET/WHERE (no columns after SET, false
"UPDATE without WHERE"); (c) `DELETE col, col FROM t` reports "Unknown table 'col'" and offers no columns before FROM;
`DELETE … USING TIMESTAMP n WHERE` loses its WHERE; (d) the commas of `{…}` / `[…]` literals count as VALUES separators
("INSERT has 5 target columns but 8 values" on the seed's own INSERTs); (e) `address.city` (UDT field) is reported as
"Unknown alias or table 'address'". Tests: `cql.test.ts` "(R3-2)".
Proposed diff:
```diff
--- a/ui/src/intel/parse/partial-parser.ts
+++ b/ui/src/intel/parse/partial-parser.ts
@@ -59,4 +59,5 @@ class Parser {
   readonly lite: boolean;
   readonly pg: boolean;
+  readonly cql: boolean;
 
   constructor(tokens: Token[], spec: DialectSpec, start: number, end: number) {
@@ -68,4 +69,5 @@ class Parser {
     this.lite = spec.id === 'sqlite';
     this.pg = spec.id === 'pgsql';
+    this.cql = spec.id === 'cql';
     const root = this.mkScope('other', null, null, start);
     this.m = { root, scopes: [root], tokens, chains: [], created: [], declared: [], start, end };
@@ -251,4 +253,7 @@ class Parser {
       }
       if (tok.kind === 'punct' && tok.text === ')') { depth--; this.i++; continue; }
+      // CQL collection / UDT / vector literals: their commas are not argument or value separators
+      if (this.cql && tok.kind === 'op' && (tok.text === '{' || tok.text === '[')) { depth++; this.i++; continue; }
+      if (this.cql && tok.kind === 'op' && (tok.text === '}' || tok.text === ']') && depth > 0) { depth--; this.i++; continue; }
       if (isWord(tok) && tok.upper === 'CASE') { caseDepth++; this.i++; continue; }
       if (isWord(tok) && tok.upper === 'END' && caseDepth > 0) {
@@ -354,4 +359,13 @@ class Parser {
       case 'BEGIN':
         if (this.ora) { this.parseBlock(c); return; }
+        if (this.cql && (this.at('BATCH', 1) || ((this.at('UNLOGGED', 1) || this.at('COUNTER', 1)) && this.at('BATCH', 2)))) {
+          // BEGIN [UNLOGGED | COUNTER] BATCH [USING TIMESTAMP n] stmt; … APPLY BATCH
+          this.i += this.at('BATCH', 1) ? 2 : 3;
+          if (this.at('USING')) while (!this.eof() && !this.atP(';') && !['INSERT', 'UPDATE', 'DELETE', 'APPLY'].includes(this.u())) this.i++;
+          this.mark(c, 'unknown', this.prevEnd(), { statementStart: true });
+          this.parseStatementList(c, wordSet('APPLY'));
+          if (this.at('APPLY')) this.i += this.at('BATCH', 1) ? 2 : 1;
+          return;
+        }
         if (this.tsql) {
           if (TSQL_BLOCK_BEGIN_NOT.has(this.u(1))) { this.skipSimple(c); return; }
@@ -1099,4 +1113,9 @@ class Parser {
     const ref = this.parseTableSource(s, false, true);
     if (ref) s.targetTable = ref;
+    if (this.cql && this.at('USING')) {
+      // CQL UPDATE t USING TTL n [AND TIMESTAMP n] SET …
+      this.mark(s, 'unknown', this.t[this.i].end);
+      while (!this.eof() && !this.atP(';') && !this.at('SET')) this.i++;
+    }
     if (this.at('SET')) this.parseSetClause(s);
     if (this.tsql && this.at('OUTPUT')) {
@@ -1122,8 +1141,18 @@ class Parser {
     if (this.tsql && this.at('TOP')) { this.i++; if (this.atP('(')) this.skipParens(); if (this.at('PERCENT')) this.i++; }
     let kwEnd = del.end;
+    if (this.cql && this.t.slice(this.i).some((t) => isWord(t) && t.upper === 'FROM')) {
+      // CQL DELETE col, m['k'], l[0] FROM t: the columns of the target, like a select list
+      this.mark(s, 'select', del.end);
+      if (!this.at('FROM')) this.scanExpr(s, (k) => this.clauseAt(k) === 'FROM');
+    }
     if (this.at('FROM')) { kwEnd = this.t[this.i].end; this.i++; }
     this.mark(s, 'delete', kwEnd);
     const ref = this.parseTableSource(s, false, true);
     if (ref) s.targetTable = ref;
+    if (this.cql && this.at('USING')) {
+      // DELETE FROM t USING TIMESTAMP n WHERE …
+      this.mark(s, 'unknown', this.t[this.i].end);
+      while (!this.eof() && !this.atP(';') && !this.at('WHERE')) this.i++;
+    }
     if (this.tsql && this.at('OUTPUT')) {
       this.i++;
```
```diff
--- a/ui/src/intel/diagnostics/soft-diagnostics.ts
+++ b/ui/src/intel/diagnostics/soft-diagnostics.ts
@@ -115,4 +115,6 @@ export function statementDiagnostics(st: SplitStatement, model: StatementModel,
       const t = binder.resolveQualifier(q, ch.scope);
       if (!t) {
+        // CQL `address.city`: a field of a UDT column (CQL has no table aliases)
+        if (spec.id === 'cql' && q.length === 1 && binder.ownSources(ch.scope).some((src) => src.columns().some((c) => index.keyOfCatalog(c.name) === index.keyOf(q[0].text, q[0].quoted)))) continue;
         if (q.length === 1 && isLikelyAlias(q[0].text, spec) && !index.schema(q[0].text, q[0].quoted) && !binder.findVar(q[0].text, ch.scope) && !spec.packageMap.has(q[0].text.toUpperCase())) {
           if (ch.scope.kind !== 'plsqlBlock' && ch.scope.kind !== 'other' && index.defaultSchemaEntry()) {
```
Local stub: none (the R3-2 tests skip themselves: `R3_PARSER` probe). Apply R3-2 and R3-2b together.

### R3-3 ui/src/intel/dialect/spec.ts + ui/src/intel/complete/completer.ts — `DialectSpec.keywordFollowers`
Reason: CQL shell commands take a keyword argument the completer cannot know: `CONSISTENCY |` must offer the 11 levels,
`SERIAL CONSISTENCY |` SERIAL / LOCAL_SERIAL, `TRACING |` / `PAGING |` ON / OFF, `DESCRIBE |` the object kinds,
`DESCRIBE TABLE |` the tables, `USE |` the keyspaces (today all of them get the function list), `ALLOW |` FILTERING,
`PER |` PARTITION LIMIT, `USING |` TTL / TIMESTAMP. A generic, data-driven hook: one- or two-word keys, `^` = first word of
the statement (so `ORDER BY x DESC |` is not `DESC |`), `@keyspace` / `@table` entries list schemas / tables. The data is
already in `cql.ts` (`FOLLOWERS`). Tests: `cql.test.ts` "(R3-3)".
Proposed diff:
```diff
--- a/ui/src/intel/dialect/spec.ts
+++ b/ui/src/intel/dialect/spec.ts
@@ -161,4 +161,9 @@ export interface DialectSpec {
    */
   classify?: (toks: Token[], head: number) => StatementKind | undefined;
+  /**
+   * Batch 3: keywords the completer offers right after a word (or two words: `'SERIAL CONSISTENCY'`), e.g. CQL
+   * `CONSISTENCY` → the levels. `@keyspace` / `@table` entries list the schemas / tables instead.
+   */
+  keywordFollowers?: Record<string, string[]>;
 }
 
@@ -207,4 +212,5 @@ export interface SpecInit {
   formatRules?: FormatRulesFactory;
   classify?: (toks: Token[], head: number) => StatementKind | undefined;
+  keywordFollowers?: Record<string, string[]>;
 }
 
@@ -263,4 +269,5 @@ export function buildSpec(init: SpecInit): DialectSpec {
     formatRules: init.formatRules,
     classify: init.classify,
+    keywordFollowers: init.keywordFollowers,
   };
 }
```
```diff
--- a/ui/src/intel/complete/completer.ts
+++ b/ui/src/intel/complete/completer.ts
@@ -309,5 +309,5 @@ export function complete(c: CursorContext, env: CompleteEnv): CompletionResult {
   } else if (c.atStatementStart) {
     statementStartItems(items, c, env);
-  } else {
+  } else if (!followerItems(items, c, env)) {
     isIncomplete = clauseItems(items, c, env) || isIncomplete;
   }
@@ -333,4 +333,32 @@ export function complete(c: CursorContext, env: CompleteEnv): CompletionResult {
 }
 
+// ------------------------------------------------------------ keyword followers
+
+/**
+ * DialectSpec.keywordFollowers (Batch 3): after `CONSISTENCY` the levels, after `DESCRIBE TABLE` the tables… Looked
+ * up: the two words before the cursor, then the last one; a `^` key only matches at the start of the statement.
+ * False when nothing is declared for them.
+ */
+function followerItems(items: Items, c: CursorContext, env: CompleteEnv): boolean {
+  const map = env.spec.keywordFollowers;
+  const p = c.prevToken;
+  const word = (t: { kind: string } | null | undefined) => !!t && (t.kind === 'keyword' || t.kind === 'ident');
+  if (!map || !word(p)) return false;
+  const toks = c.statement.tokens;
+  const at = toks.indexOf(p!);
+  const two = at > 0 && word(toks[at - 1]) ? toks[at - 1].upper + ' ' + p!.upper : null;
+  const list = (two && at === 1 ? map['^' + two] : undefined) ?? (two ? map[two] : undefined) ?? (at === 0 ? map['^' + p!.upper] : undefined) ?? map[p!.upper];
+  if (!list) return false;
+  const fe = fenv(c, env);
+  list.forEach((k, i) => {
+    if (k === '@keyspace') {
+      for (const sc of env.index.schemas.values()) items.add({ label: sc.name, kind: 'schema', group: 10, insertText: formatIdent(sc.name, fe), detail: schemaDetail(env, sc.name) });
+      for (const name of env.index.unloadedSchemaNames()) items.add({ label: name, kind: 'schema', group: 10, insertText: formatIdent(name, fe), detail: schemaDetail(env, name) });
+    } else if (k === '@table') tableItems(items, c, env, 9);
+    else items.add({ label: kwCase(k, env.opts), kind: 'keyword', group: 10, relevance: Math.max(0, 40 - i), usageKey: 'kw:' + k });
+  });
+  return true;
+}
+
 // ------------------------------------------------------------ statement start
```
Local stub: `TODO(WPCS-shared) R3-3` in `ui/src/intel/dialect/cql.ts` (`Object.assign(spec, { keywordFollowers })`).

### R3-4 ui/src/codegen/types/index.ts — CQL collection types
Reason: `list<T>`, `set<T>`, `map<K, V>`, `frozen<…>` (nested) are per-column type texts; a table of keys cannot cover
them. The diff resolves them recursively into `List<T>` / `IEnumerable<T>` / `IDictionary<K, V>` (C#, the types the
DataStax C# driver maps), `[]T` / `map[K]V` (Go), `T[]` / `Record<K, V>` (TS), `java.util.List/Set/Map<…>` with boxed
elements (Java), `list/set/dict[…]` (Python); a UDT element stays `object` (known = false). Tests: `cql-types.test.ts`
"(R3-4)".
Proposed diff:
```diff
--- a/ui/src/codegen/types/index.ts
+++ b/ui/src/codegen/types/index.ts
@@ -150,4 +150,45 @@ function pgBase(base: string): string {
 }
 
+/** Top-level comma split of CQL type arguments (`text, frozen<map<int, text>>`). */
+function cqlArgs(s: string): string[] {
+  const out: string[] = [];
+  let depth = 0, from = 0;
+  for (let i = 0; i < s.length; i++) {
+    if (s[i] === '<') depth++;
+    else if (s[i] === '>') depth--;
+    else if (s[i] === ',' && depth === 0) { out.push(s.slice(from, i).trim()); from = i + 1; }
+  }
+  out.push(s.slice(from).trim());
+  return out;
+}
+
+/** CQL `list<T>`, `set<T>`, `map<K, V>`, `frozen<T>` (recursive): the language collection types of the element types. */
+function cqlCollection(typeText: string): ResolvedType | null {
+  const m = /^(frozen|list|set|map)\s*<(.*)>$/i.exec(typeText.trim());
+  if (!m) return null;
+  const kind = m[1].toLowerCase();
+  const args = cqlArgs(m[2]).map((a) => resolveType('cql', a));
+  const tsEl = (t: string) => (/^[A-Za-z_.]+$/.test(t) ? t : `(${t})`);
+  const box = (j: string) => JAVA_BOXED[j] ?? j;
+  const meta = { known: args.every((a) => a.known), length: null, precision: null, scale: null, dbType: typeText };
+  if (kind === 'frozen' && args.length === 1) return { ...args[0], dbType: typeText };
+  if ((kind === 'list' || kind === 'set') && args.length === 1) {
+    const [e] = args;
+    const row: TypeRow = kind === 'list'
+      ? { logical: 'object', cs: `List<${e.cs}>`, go: `[]${e.go}`, ts: `${tsEl(e.ts)}[]`, java: `java.util.List<${box(e.java)}>`, py: `list[${e.py}]` }
+      : { logical: 'object', cs: `IEnumerable<${e.cs}>`, go: `[]${e.go}`, ts: `${tsEl(e.ts)}[]`, java: `java.util.Set<${box(e.java)}>`, py: `set[${e.py}]` };
+    return { ...row, base: typeText.trim().toLowerCase(), ...meta, element: e };
+  }
+  if (kind === 'map' && args.length === 2) {
+    const [k, v] = args;
+    const row: TypeRow = {
+      logical: 'object', cs: `IDictionary<${k.cs}, ${v.cs}>`, go: `map[${k.go}]${v.go}`, ts: `Record<${k.ts === 'number' ? 'number' : 'string'}, ${v.ts}>`,
+      java: `java.util.Map<${box(k.java)}, ${box(v.java)}>`, py: `dict[${k.py}, ${v.py}]`,
+    };
+    return { ...row, base: typeText.trim().toLowerCase(), ...meta };
+  }
+  return null;
+}
+
 /** Resolve a database type text to language types. */
 export function resolveType(dialect: Dialect, typeText: string, opts: TypeOptions & { kind?: ColumnKind } = {}): ResolvedType {
@@ -194,4 +235,8 @@ export function resolveType(dialect: Dialect, typeText: string, opts: TypeOption
   let row = tbl[base];
   let known = !!row;
+  if (!row && dialect === 'cql') {
+    const g = cqlCollection(typeText);
+    if (g) return g;
+  }
   if (!row && dialect === 'sqlite') {
     row = tbl[sqliteAffinity(rawBase)];
```
Local stub: none (collections fall back to the wire kind).

### R3-5 ui/src/snippets/builtins.ts — no SQL-only built-in snippets for cql
Reason: the `ALL` built-ins `cte`, `join` and `case` are not CQL (no CTEs, joins or CASE); they show up at statement
start next to the CQL snippets of the spec. Proposed: give those four a dialect list without
`cql`, e.g. `const NOT_CQL: Dialect[] = ['tsql', 'plsql', 'sqlite', 'pgsql', 'mysql', 'clickhouse', 'snowflake'];` and use it
instead of `ALL` for `cte`, `join`, `case`. (`sel`, `selw`, `selc`, `ins`, `upd`, `del` are fine for CQL.)
Local stub: none.

### Notes for others
- `tokens-core.ts` colours a keyword that is also a data type as a type: that is why `set` is not a CQL data type. If the
  orchestrator wants `set<…>` in type completion, the cheapest change is to colour as `type` only when the next token is
  not a keyword-position word — not requested, just recorded.
- The engine's catalog should report CQL types in `system_schema.columns` spelling (`map<text, text>`, `frozen<address>`)
  and use the column-comment convention of the fixture; codegen and hover read those strings as they are.

## How the R3 diffs were checked

The diffs are generated from patched copies kept outside the worktree; a vitest config with a resolve plugin redirects
the six WP0 modules to the copies, so the full `test:intel` + `src/codegen` suites ran against them without touching a
shared file (1101 passed, 2 skipped; only the two timing tests failed, as on the base tree in the same load). `tsc` was run over
the patched files with the app's compiler options (`rootDirs` over the worktree).

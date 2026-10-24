// CQL (Cassandra 5 / ScyllaDB) dialect spec (plan-batch3 WP-CS), loaded lazily by dialect/registry.ts (D7).
// Rules for this chunk (and every file only it imports: split/cql, format/rules/cql, data/cql-*.json):
// - no runtime import from the shell / intel / format modules (type imports are fine): use the kit arguments instead
//   (DialectKit here, SplitKit in the splitter, FormatKit in the rules factory), else the initial bundle re-partitions;
// - lazy-only shared helpers are fine: ../lexer/traits (traitLexer);
// - export `define` (DialectDefine).
import type { DialectDefine, DialectSpec, FunctionCatalogJson, LexTraits, SnippetDef, SystemCatalogJson } from './spec';
import type { LexHook } from '../lexer/lexer';
import type { StatementKind, Token } from '../types';
import catalog from './data/cql-functions.json';
import system from './data/cql-system.json';
import { traitLexer } from '../lexer/traits';
import { splitCql } from '../split/cql';
import { cqlRules } from '../../format/rules/cql';

// `?` / `:name` bind markers, `$$ … $$` UDF bodies, 0x… blob literals.
const LEX: LexTraits = { paramPrefixes: ':?', dollarQuotes: true, hexNumbers: true };

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z_])/y;
/** Duration literal `1h30m`, `12mo`, `3w2d`, `500ms` (number + unit groups); ISO 8601 `P1Y2M` forms are plain identifiers. */
const DURATION = /(?:\d+(?:mo|ms|us|µs|ns|y|w|d|h|m|s))+(?![0-9A-Za-z_])/iy;
const isIdentChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

/** CQL lexer hook: `//` line comments, uuid and duration literals as one number token, then the LexTraits. */
function cqlLexer(): LexHook {
  const traits = traitLexer(LEX);
  return (lx, start, c, c1) => {
    const t = lx.text;
    // `// …` line comment (cqlsh)
    if (c === 47 && c1 === 47) {
      let e = t.indexOf('\n', start);
      if (e < 0) e = t.length;
      if (e > start && t.charCodeAt(e - 1) === 13) e--;
      lx.pos = e;
      return lx.make('comment', start, e);
    }
    const prev = start > 0 ? t.charCodeAt(start - 1) : 0;
    const hex = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    if (hex && !isIdentChar(prev)) {
      UUID.lastIndex = start;
      if (UUID.test(t)) {
        lx.pos = UUID.lastIndex;
        return lx.make('number', start, lx.pos);
      }
    }
    if (c >= 48 && c <= 57 && !isIdentChar(prev)) {
      DURATION.lastIndex = start;
      if (DURATION.test(t)) {
        lx.pos = DURATION.lastIndex;
        return lx.make('number', start, lx.pos);
      }
    }
    return traits(lx, start, c, c1);
  };
}

const DML = new Set(['INSERT', 'UPDATE', 'DELETE']);
const SESSION = new Set(['CONSISTENCY', 'SERIAL', 'TRACING', 'PAGING', 'EXPAND', 'CAPTURE']);

/** Statement kinds for the destructive-run guard (split/classify.ts calls it before the shared rules). */
function classifyCql(toks: Token[], head: number): StatementKind | undefined {
  const w = (k: number) => {
    const t = toks[k];
    return t && (t.kind === 'keyword' || t.kind === 'ident') ? t.upper : '';
  };
  const u = w(head);
  switch (u) {
    case 'BEGIN': {
      // BEGIN [UNLOGGED | COUNTER] BATCH … APPLY BATCH: the kind of its first statement (never destructive: CQL
      // UPDATE / DELETE always name the primary key)
      let k = head + 1;
      if (w(k) === 'UNLOGGED' || w(k) === 'COUNTER') k++;
      if (w(k) !== 'BATCH') return 'other';
      for (let j = k + 1; j < toks.length; j++) {
        const x = w(j);
        if (DML.has(x)) return x.toLowerCase() as StatementKind;
      }
      return 'insert';
    }
    case 'APPLY': return 'other';
    // UPDATE / DELETE need the full primary key in WHERE: never a whole-table write
    case 'UPDATE': return 'update';
    case 'DELETE': return 'delete';
    case 'DESCRIBE': case 'DESC': case 'LIST': case 'SHOW': return 'other';
    case 'USE': return 'use';
    case 'GRANT': case 'REVOKE': return 'grant';
    case 'TRUNCATE': return 'truncate:destructive';
    case 'DROP': return 'drop:destructive';
    default:
      return SESSION.has(u) ? 'set' : undefined;
  }
}

const LEVELS = 'ONE TWO THREE QUORUM ALL LOCAL_ONE LOCAL_QUORUM EACH_QUORUM ANY SERIAL LOCAL_SERIAL';

// keep the bodies in CQL (no `;` inside snippets that are statement starts: the user adds it)
const SNIPPETS: SnippetDef[] = [
  { prefix: 'selw', label: 'selw', body: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:id} = ${4:?}$0', doc: 'SELECT … FROM … WHERE (partition key)' },
  { prefix: 'ins', label: 'ins', body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})$0', doc: 'INSERT INTO … VALUES' },
  { prefix: 'insne', label: 'insne', body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})\nIF NOT EXISTS$0', doc: 'INSERT … IF NOT EXISTS (lightweight transaction)' },
  { prefix: 'insttl', label: 'insttl', body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})\nUSING TTL ${4:86400}$0', doc: 'INSERT … USING TTL' },
  { prefix: 'upd', label: 'upd', body: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:id} = ${5:?}$0', doc: 'UPDATE … SET … WHERE' },
  { prefix: 'del', label: 'del', body: 'DELETE FROM ${1:table}\nWHERE ${2:id} = ${3:?}$0', doc: 'DELETE FROM … WHERE' },
  { prefix: 'batch', label: 'batch', body: 'BEGIN BATCH\n\t$0\nAPPLY BATCH;', doc: 'BEGIN BATCH … APPLY BATCH' },
  { prefix: 'ubatch', label: 'ubatch', body: 'BEGIN UNLOGGED BATCH\n\t$0\nAPPLY BATCH;', doc: 'BEGIN UNLOGGED BATCH … APPLY BATCH (one partition)' },
  { prefix: 'ks', label: 'ks', body: "CREATE KEYSPACE IF NOT EXISTS ${1:name}\nWITH replication = {'class': '${2|NetworkTopologyStrategy,SimpleStrategy|}', '${3:datacenter1}': ${4:3}}$0", doc: 'CREATE KEYSPACE … WITH replication' },
  { prefix: 'tbl', label: 'tbl', body: 'CREATE TABLE IF NOT EXISTS ${1:name} (\n\t${2:id} ${3:uuid},\n\t${4:created_at} timestamp,\n\t${5:value} text,\n\tPRIMARY KEY ((${2:id}), ${4:created_at})\n) WITH CLUSTERING ORDER BY (${4:created_at} DESC)$0', doc: 'CREATE TABLE with a partition and a clustering key' },
  { prefix: 'type', label: 'type', body: 'CREATE TYPE IF NOT EXISTS ${1:name} (\n\t${2:field} ${3:text}\n)$0', doc: 'CREATE TYPE (user-defined type)' },
  { prefix: 'mv', label: 'mv', body: 'CREATE MATERIALIZED VIEW ${1:name} AS\n\tSELECT ${2:*}\n\tFROM ${3:table}\n\tWHERE ${4:key} IS NOT NULL AND ${5:id} IS NOT NULL\n\tPRIMARY KEY ((${4:key}), ${5:id})$0', doc: 'CREATE MATERIALIZED VIEW' },
  { prefix: 'sai', label: 'sai', body: "CREATE INDEX ${1:name} ON ${2:table} (${3:column}) USING 'sai'$0", doc: 'CREATE INDEX … USING \'sai\' (storage-attached index)' },
  { prefix: 'ann', label: 'ann', body: 'SELECT ${1:*}\nFROM ${2:table}\nORDER BY ${3:embedding} ANN OF [${4:0.1, 0.2, 0.3}]\nLIMIT ${5:10}$0', doc: 'Vector search: ORDER BY … ANN OF […] LIMIT n' },
  { prefix: 'fn', label: 'fn', body: 'CREATE OR REPLACE FUNCTION ${1:name}(${2:x int})\n\tRETURNS NULL ON NULL INPUT\n\tRETURNS ${3:int}\n\tLANGUAGE java\n\tAS \\$\\$ return ${4:x}; \\$\\$$0', doc: 'CREATE FUNCTION (Java UDF)' },
  { prefix: 'cons', label: 'cons', body: `CONSISTENCY \${1|${LEVELS.split(' ').join(',')}|}$0`, doc: 'CONSISTENCY <level> (session consistency level)' },
];

const DESCRIBE_WHAT = [
  'KEYSPACES', 'KEYSPACE', 'TABLES', 'TABLE', 'TYPES', 'TYPE', 'FUNCTIONS', 'FUNCTION', 'AGGREGATES', 'AGGREGATE',
  'MATERIALIZED VIEW', 'INDEX', 'CLUSTER', 'SCHEMA', 'FULL SCHEMA',
];
/**
 * What the completer offers right after a word or two (DialectSpec.keywordFollowers, R3-3): keys are one or two words,
 * `^` = at the start of the statement; `@keyspace` / `@table` list the keyspaces / tables.
 */
const FOLLOWERS: Record<string, string[]> = {
  '^CONSISTENCY': LEVELS.split(' '),
  '^SERIAL': ['CONSISTENCY'],
  '^SERIAL CONSISTENCY': ['SERIAL', 'LOCAL_SERIAL'],
  '^TRACING': ['ON', 'OFF'],
  '^PAGING': ['ON', 'OFF'],
  '^EXPAND': ['ON', 'OFF'],
  '^SHOW': ['VERSION', 'HOST', 'SESSION'],
  '^BEGIN': ['BATCH', 'UNLOGGED BATCH', 'COUNTER BATCH'],
  APPLY: ['BATCH'],
  ALLOW: ['FILTERING'],
  PER: ['PARTITION LIMIT'],
  USING: ['TTL', 'TIMESTAMP'],
  '^LIST': ['ROLES', 'USERS', 'ALL PERMISSIONS', 'PERMISSIONS'],
  '^DESCRIBE': DESCRIBE_WHAT,
  '^DESC': DESCRIBE_WHAT,
  '^DESCRIBE TABLE': ['@table'],
  '^DESC TABLE': ['@table'],
  '^DESCRIBE KEYSPACE': ['@keyspace'],
  '^DESC KEYSPACE': ['@keyspace'],
  '^USE': ['@keyspace'],
  'ON KEYSPACE': ['@keyspace'],
  'ON TABLE': ['@table'],
};

export const define: DialectDefine = (kit) => {
  const spec: DialectSpec = kit.buildSpec({
    id: 'cql',
    // CQL reserved words (Cassandra 5 appendix A), then non-reserved words of the grammar that are hardly ever column
    // names: lexed as keywords so the formatter upper-cases them and name diagnostics skip them (KEY too, for the
    // `PRIMARY KEY (…)` spacing, although system.local has a `key` column). Common column / option names (type, user,
    // role, replication, version, password) stay contextual: coloured, written as typed.
    keywords: `
      ADD ALLOW ALTER AND APPLY ASC AUTHORIZE BATCH BEGIN BY COLUMNFAMILY CREATE DEFAULT DELETE DESC DESCRIBE DROP ENTRIES
      EXECUTE FROM FULL GRANT IF IN INDEX INFINITY INSERT INTO IS KEYSPACE LIMIT MATERIALIZED MBEAN MBEANS MODIFY NAN
      NORECURSIVE NOT NULL OF ON OR ORDER PRIMARY RENAME REPLACE REVOKE SCHEMA SELECT SET TABLE TO TOKEN TRUNCATE
      UNLOGGED UNSET UPDATE USE USING VIEW WHERE WITH
      AS DISTINCT EXISTS TRUE FALSE VALUES GROUP KEY KEYS CONTAINS FILTERING TTL WRITETIME MAXWRITETIME JSON CLUSTERING
      COMPACT STORAGE STATIC PER PARTITION ANN CUSTOM FUNCTION FUNCTIONS AGGREGATE AGGREGATES KEYSPACES TABLES TYPES
      TRIGGER RETURNS CALLED INPUT LANGUAGE SFUNC STYPE FINALFUNC INITCOND TIMESTAMP COUNTER LIKE CAST ROLES USERS
      PERMISSION PERMISSIONS LOGIN SUPERUSER NOSUPERUSER OFF CONSISTENCY VERSION HOST SESSION ${LEVELS}`,
    contextual: `
      TYPE ROLE USER PASSWORD HASHED OPTIONS ACCESS DATACENTERS CIDRS TRIGGERS COLUMNFAMILIES DETERMINISTIC MONOTONIC
      MASKED UNMASK SELECT_MASKED REPLICATION DURABLE_WRITES CLUSTER INDEXES TRACING PAGING SHOW EXPAND LIST FROZEN`,
    notAlias: 'ALLOW PER IF USING TTL TIMESTAMP APPLY BATCH CONTAINS FILTERING JSON GROUP LIMIT ANN',
    statementStarts: `
      SELECT INSERT UPDATE DELETE BEGIN APPLY CREATE ALTER DROP TRUNCATE USE GRANT REVOKE LIST DESCRIBE DESC
      CONSISTENCY SERIAL TRACING PAGING SHOW EXPAND`,
    // `set` is left out: SET is a keyword (UPDATE … SET), the editor would colour it as a type
    dataTypes: `
      ascii bigint blob boolean counter date decimal double duration float inet int smallint text time timestamp
      timeuuid tinyint uuid varchar varint list map tuple frozen vector`,
    catalog: catalog as FunctionCatalogJson,
    systemCatalog: system as unknown as SystemCatalogJson,
    quote: ['"', '"'],
    caseFolding: 'lower',
    batchSeparator: null,
    identExtra: '',
    snippets: SNIPPETS,
    selectKeywords: 'DISTINCT, JSON',
    afterSourceKeywords: 'WHERE, ORDER BY, GROUP BY, PER PARTITION LIMIT, LIMIT, ALLOW FILTERING',
    afterExprKeywords: `
      AND, IN, CONTAINS, CONTAINS KEY, IS NOT NULL, LIKE, ORDER BY, GROUP BY, PER PARTITION LIMIT, LIMIT,
      ALLOW FILTERING, IF EXISTS, IF, ANN OF`,
    startKeywords: `
      SELECT, SELECT JSON, INSERT INTO, UPDATE, DELETE FROM, BEGIN BATCH, BEGIN UNLOGGED BATCH, BEGIN COUNTER BATCH,
      APPLY BATCH, USE, TRUNCATE, TRUNCATE TABLE, DESCRIBE KEYSPACES, DESCRIBE KEYSPACE, DESCRIBE TABLES, DESCRIBE TABLE,
      DESCRIBE TYPES, DESCRIBE TYPE, DESCRIBE FUNCTIONS, DESCRIBE AGGREGATES, DESCRIBE MATERIALIZED VIEW, DESCRIBE INDEX,
      DESCRIBE CLUSTER, DESCRIBE SCHEMA, DESCRIBE FULL SCHEMA, CREATE KEYSPACE, CREATE KEYSPACE IF NOT EXISTS,
      CREATE TABLE, CREATE TABLE IF NOT EXISTS, CREATE TYPE, CREATE TYPE IF NOT EXISTS, CREATE INDEX, CREATE CUSTOM INDEX,
      CREATE MATERIALIZED VIEW, CREATE FUNCTION, CREATE OR REPLACE FUNCTION, CREATE AGGREGATE, CREATE OR REPLACE AGGREGATE,
      CREATE ROLE, CREATE USER, CREATE TRIGGER, ALTER KEYSPACE, ALTER TABLE, ALTER TYPE, ALTER MATERIALIZED VIEW,
      ALTER ROLE, ALTER USER, DROP KEYSPACE, DROP TABLE, DROP TYPE, DROP INDEX, DROP MATERIALIZED VIEW, DROP FUNCTION,
      DROP AGGREGATE, DROP ROLE, DROP USER, DROP TRIGGER, GRANT, REVOKE, LIST ROLES, LIST USERS, LIST ALL PERMISSIONS,
      CONSISTENCY, SERIAL CONSISTENCY, TRACING ON, TRACING OFF, PAGING ON, PAGING OFF, PAGING, SHOW VERSION, SHOW HOST,
      SHOW SESSION, ${LEVELS.split(' ').map((l) => 'CONSISTENCY ' + l).join(', ')}`,
    // no `||` / `::` in CQL; `<` and `>` stay single tokens so `map<text, frozen<list<int>>>` closes one by one
    ops2: ['!=', '<=', '>='],
    ops3: [],
    lex: LEX,
    lexHook: cqlLexer(),
    split: splitCql,
    formatRules: cqlRules,
    classify: classifyCql,
  });
  spec.keywordFollowers = FOLLOWERS; // read by the completer (followerItems)
  return spec;
};

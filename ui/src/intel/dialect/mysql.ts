// MySQL 8.x / MariaDB 10.4–11 dialect spec (plan-batch3 WP-MY), loaded lazily by dialect/registry.ts (D7).
// Rules for this chunk (and every file only it imports: split/mysql, format/rules/mysql, data/mysql-*.json):
// - no runtime import from the shell / intel / format modules (type imports are fine): use the kit arguments instead
//   (DialectKit here, SplitKit in the splitter, FormatKit in the rules factory), else the initial bundle re-partitions;
// - lazy-only shared helpers are fine: ./ansi (ANSI base), ../lexer/traits (traitLexer);
// - export `define` (DialectDefine).
import type { DialectDefine, DialectSpec, FunctionCatalogJson, LexTraits, SnippetDef, SystemCatalogJson } from './spec';
import type { LexHook } from '../lexer/lexer';
import type { StatementKind, Token } from '../types';
import catalog from './data/mysql-functions.json';
import system from './data/mysql-system.json';
import { traitLexer } from '../lexer/traits';
import { splitMysql } from '../split/mysql';
import { mysqlRules } from '../../format/rules/mysql';

const LEX: LexTraits = { backtickIdent: true, hashComment: true, backslashEscapes: true, paramPrefixes: '@:?', hexNumbers: true, stringPrefixes: 'NXB' };

/**
 * Reserved words of MySQL 8.0 / MariaDB (lexed as keywords). Left out on purpose: data type names (they are types, see
 * dataTypes), window/function names that MySQL 8 reserves but MariaDB does not (RANK, ROW_NUMBER, LAG, CUBE, GROUPING …:
 * common column names on MariaDB and 5.7 schemas) and ROW / ROWS / OF / SYSTEM / EMPTY. Added although non-reserved:
 * END, DUPLICATE and ROLLUP (never column names in practice; the formatter upper-cases keywords only).
 */
const KEYWORDS = `
  ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BINARY BOTH BY CALL CASCADE CASE CHANGE CHECK
  COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP
  CURRENT_USER CURSOR DATABASE DATABASES DAY_HOUR DAY_MICROSECOND DAY_MINUTE DAY_SECOND DECLARE DEFAULT DELAYED DELETE
  DESC DESCRIBE DETERMINISTIC DISTINCT DISTINCTROW DIV DROP DUAL DUPLICATE EACH ELSE ELSEIF ENCLOSED END ESCAPED EXCEPT EXISTS EXIT
  EXPLAIN FALSE FETCH FOR FORCE FOREIGN FROM FULLTEXT FUNCTION GENERATED GET GRANT GROUP HAVING HIGH_PRIORITY
  HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE IN INDEX INFILE INNER INOUT INSENSITIVE INSERT INTERSECT INTERVAL
  INTO IO_AFTER_GTIDS IO_BEFORE_GTIDS IS ITERATE JOIN KEY KEYS KILL LATERAL LEADING LEAVE LEFT LIKE LIMIT LINEAR LINES
  LOAD LOCALTIME LOCALTIMESTAMP LOCK LOOP LOW_PRIORITY MASTER_BIND MASTER_SSL_VERIFY_SERVER_CERT MATCH MAXVALUE
  MINUTE_MICROSECOND MINUTE_SECOND MOD MODIFIES NATURAL NOT NO_WRITE_TO_BINLOG NULL ON OPTIMIZE OPTIMIZER_COSTS OPTION
  OPTIONALLY OR ORDER OUT OUTER OUTFILE OVER PARTITION PRIMARY PROCEDURE PURGE RANGE READ READS READ_WRITE RECURSIVE
  REFERENCES REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN RETURNING REVOKE RIGHT RLIKE ROLLUP SCHEMA
  SCHEMAS SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR SET SHOW SIGNAL SPATIAL SPECIFIC SQL SQLEXCEPTION SQLSTATE
  SQLWARNING SQL_BIG_RESULT SQL_CALC_FOUND_ROWS SQL_SMALL_RESULT SSL STARTING STORED STRAIGHT_JOIN TABLE TERMINATED THEN
  TO TRAILING TRIGGER TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING UTC_DATE UTC_TIME UTC_TIMESTAMP
  VALUES VIRTUAL WHEN WHERE WHILE WINDOW WITH WRITE XOR YEAR_MONTH ZEROFILL`;

/** Non-reserved words the completer offers as keywords (identifiers to the lexer). */
const CONTEXTUAL = `
  ACTION AFTER AGAINST AGGREGATE ALGORITHM ALWAYS ANY AT ATOMIC AUTO_INCREMENT AVG_ROW_LENGTH BEGIN BTREE CASCADED
  CHARSET CHECKSUM CLOSE COLLATION COLUMNS COMMENT COMMIT COMMITTED COMPACT COMPLETION COMPRESSED COMPRESSION CONCURRENT
  CONNECTION CONSISTENT CONTAINS COPY CUBE CURRENT DATA DEALLOCATE DEFINER DELAY_KEY_WRITE DIRECTORY DISABLE DISCARD DO
  DYNAMIC ENABLE ENCRYPTION ENDS ENGINE ENGINES ERRORS ESCAPE EVENT EVENTS EVERY EXCHANGE EXCLUSIVE EXECUTE
  EXPANSION EXTENDED FIELDS FILE FIRST FIXED FLUSH FOLLOWING FOLLOWS FORMAT FOUND FULL GLOBAL GRANTS GROUPS HANDLER
  HASH HELP HOSTS IDENTIFIED IMPORT INDEXES INPLACE INSERT_METHOD INSTANT INVISIBLE INVOKER ISOLATION JSON
  KEY_BLOCK_SIZE LANGUAGE LAST LESS LEVEL LIST LOCAL LOCKED LOGS MASTER MAX_ROWS MEMORY MERGE MIN_ROWS MODE MODIFY NAMES
  NEXT NO NONE NOWAIT NULLS OF OFFSET ONLY OPEN OPTIONS OWNER PACK_KEYS PARSER PARTIAL PARTITIONS PASSWORD PERSIST
  PERSIST_ONLY PLUGINS PRECEDES PRECEDING PREPARE PRESERVE PREV PRIVILEGES PROCESS PROCESSLIST PROFILE PROFILES QUERY
  QUICK REBUILD RECOVER REDUNDANT REMOVE REORGANIZE REPAIR REPEATABLE REPLICA RESET RESTART RESUME RETURNS REUSE ROLE
  ROLLBACK ROUTINE ROW ROWS ROW_FORMAT SAVEPOINT SCHEDULE SECURITY SEQUENCE SERIALIZABLE SERVER SESSION SHARE
  SHUTDOWN SIGNED SIMPLE SKIP SLAVE SNAPSHOT SOME SONAME SOUNDS SOURCE SQL_BUFFER_RESULT SQL_CACHE SQL_NO_CACHE START
  STARTS STATS_AUTO_RECALC STATS_PERSISTENT STATUS STOP STORAGE SUBPARTITION SUPER SUSPEND SYSTEM TABLES TABLESPACE
  TEMPORARY TEMPTABLE THAN TRANSACTION TRIGGERS TRUNCATE TYPE UNBOUNDED UNCOMMITTED UNDEFINED UNKNOWN UNTIL UPGRADE
  USER VALIDATION VALUE VARIABLES VERSIONING VIEW VISIBLE WAIT WARNINGS WITHOUT WORK WRAPPER XA XML`;

const STATEMENT_STARTS = `
  SELECT INSERT UPDATE DELETE REPLACE WITH CREATE ALTER DROP TRUNCATE RENAME BEGIN START COMMIT ROLLBACK SAVEPOINT
  RELEASE SET SHOW DESCRIBE DESC EXPLAIN USE CALL DO HANDLER LOCK UNLOCK LOAD GRANT REVOKE ANALYZE OPTIMIZE CHECK
  CHECKSUM REPAIR KILL FLUSH RESET PURGE PREPARE EXECUTE DEALLOCATE DECLARE VALUES TABLE XA INSTALL UNINSTALL SIGNAL
  RESIGNAL GET HELP SHUTDOWN BINLOG CACHE CHANGE IMPORT LEAVE ITERATE OPEN CLOSE RETURN`;

const DATA_TYPES = `
  TINYINT SMALLINT MEDIUMINT INT INTEGER BIGINT DECIMAL DEC NUMERIC FIXED FLOAT DOUBLE REAL BIT BOOL BOOLEAN SERIAL CHAR
  VARCHAR NCHAR NVARCHAR TINYTEXT TEXT MEDIUMTEXT LONGTEXT VARBINARY TINYBLOB BLOB MEDIUMBLOB LONGBLOB ENUM JSON DATE TIME
  DATETIME TIMESTAMP YEAR GEOMETRY POINT LINESTRING POLYGON MULTIPOINT MULTILINESTRING MULTIPOLYGON GEOMETRYCOLLECTION
  INET4 INET6 UUID VECTOR`;

// keep in step with the MySQL snippets requested for ui/src/snippets/builtins.ts (docs/wp-notes/WP-MY.md R3)
const SNIPPETS: SnippetDef[] = [
  { prefix: 'sel', label: 'sel', body: 'SELECT ${1:*}\nFROM ${2:table}$0', doc: 'SELECT ... FROM' },
  { prefix: 'selw', label: 'selw', body: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition}$0', doc: 'SELECT ... FROM ... WHERE' },
  { prefix: 'ins', label: 'ins', body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})$0', doc: 'INSERT INTO ... VALUES' },
  { prefix: 'upsert', label: 'upsert', body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})\nON DUPLICATE KEY UPDATE ${4:column} = VALUES(${4:column})$0', doc: 'INSERT ... ON DUPLICATE KEY UPDATE' },
  { prefix: 'upd', label: 'upd', body: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition}$0', doc: 'UPDATE ... SET ... WHERE' },
  { prefix: 'del', label: 'del', body: 'DELETE FROM ${1:table}\nWHERE ${2:condition}$0', doc: 'DELETE FROM ... WHERE' },
  { prefix: 'cte', label: 'cte', body: 'WITH ${1:cte} AS (\n\tSELECT ${2:*}\n\tFROM ${3:table}\n)\nSELECT *\nFROM ${1:cte}$0', doc: 'Common table expression' },
  { prefix: 'tbl', label: 'tbl', body: 'CREATE TABLE ${1:name} (\n\t${2:id} INT NOT NULL AUTO_INCREMENT,\n\t${3:name} VARCHAR(100) NOT NULL,\n\tPRIMARY KEY (${2:id})\n) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;$0', doc: 'CREATE TABLE (InnoDB, utf8mb4)' },
  { prefix: 'proc', label: 'proc', body: 'CREATE PROCEDURE ${1:name}(IN ${2:p_id} INT)\nBEGIN\n\t$0\nEND;', doc: 'CREATE PROCEDURE ... BEGIN ... END (no DELIMITER needed in Rowlit)' },
  { prefix: 'fn', label: 'fn', body: 'CREATE FUNCTION ${1:name}(${2:p_id} INT)\nRETURNS ${3:INT}\nDETERMINISTIC\nBEGIN\n\tDECLARE v_result ${3:INT};\n\t$0\n\tRETURN v_result;\nEND;', doc: 'CREATE FUNCTION ... RETURNS ... BEGIN ... END' },
  { prefix: 'trg', label: 'trg', body: 'CREATE TRIGGER ${1:trg_name}\n${2:BEFORE} ${3:INSERT} ON ${4:table}\nFOR EACH ROW\nBEGIN\n\t$0\nEND;', doc: 'CREATE TRIGGER ... FOR EACH ROW BEGIN ... END' },
  { prefix: 'evt', label: 'evt', body: 'CREATE EVENT ${1:ev_name}\nON SCHEDULE EVERY ${2:1} ${3:DAY}\nDO\nBEGIN\n\t$0\nEND;', doc: 'CREATE EVENT ... ON SCHEDULE ... DO' },
  { prefix: 'delim', label: 'delim', body: 'DELIMITER $$\n\n$0\n\nDELIMITER ;', doc: 'DELIMITER $$ … DELIMITER ; (mysql client script style)' },
  { prefix: 'tx', label: 'tx', body: 'START TRANSACTION;\n$0\nCOMMIT;', doc: 'START TRANSACTION ... COMMIT' },
];

const isDigit = (c: number) => c >= 48 && c <= 57;

/**
 * The MySQL lexer hook: the LexTraits (traitLexer) plus the MySQL-only tokens:
 * - a `DELIMITER xx` client command line → one `meta` token (the splitter switches the statement delimiter on it);
 * - `$$` and `//`, the usual custom delimiters, as one `op` token each (never valid MySQL otherwise), and identifiers
 *   stop before a `$$` (`END$$` is END + `$$`);
 * - `\G` / `\g` (mysql client terminators) as one `op` token;
 * - "…" strings (the default sql_mode; ANSI_QUOTES servers read them as identifiers) with backslash escapes;
 * - `_utf8mb4'…'` charset introducers as one string token;
 * - `lbl:BEGIN` is a label (the `:` is not a `:name` parameter).
 */
function mysqlLexer(spec: () => DialectSpec): LexHook {
  const traits = traitLexer(LEX);
  return (lx, start, c, c1) => {
    const t = lx.text;
    const n = t.length;
    // DELIMITER xx at the start of a line (only whitespace before it), the delimiter runs to the end of the line
    if ((c === 68 || c === 100) && (t.charCodeAt(start + 9) === 32 || t.charCodeAt(start + 9) === 9) && t.slice(start, start + 9).toUpperCase() === 'DELIMITER') {
      let b = start - 1;
      while (b >= 0 && (t.charCodeAt(b) === 32 || t.charCodeAt(b) === 9)) b--;
      if (b < 0 || t.charCodeAt(b) === 10 || t.charCodeAt(b) === 13) {
        let e = t.indexOf('\n', start);
        if (e < 0) e = n;
        const line = t.slice(start, e);
        const m = /^DELIMITER[ \t]+(\S+)[ \t]*\r?$/i.exec(line);
        if (m) {
          const end = start + line.replace(/[ \t\r]+$/, '').length;
          lx.pos = end;
          return lx.make('meta', start, end);
        }
      }
    }
    if ((c === 36 && c1 === 36) || (c === 47 && c1 === 47)) {
      lx.pos = start + 2;
      return lx.make('op', start, start + 2);
    }
    if (c === 92 && (c1 === 71 || c1 === 103) && !lx.isIdentPart(t.charCodeAt(start + 2))) {
      lx.pos = start + 2;
      return lx.make('op', start, start + 2);
    }
    if (c === 34) {
      let p = start + 1;
      let ok = false;
      while (p < n) {
        const ch = t.charCodeAt(p);
        if (ch === 92) { p += 2; continue; }
        if (ch === 34) {
          if (t.charCodeAt(p + 1) === 34) { p += 2; continue; }
          p++;
          ok = true;
          break;
        }
        p++;
      }
      if (p > n) p = n;
      return lx.multi('string', start, p, !ok);
    }
    if (lx.isIdentStart(c) && c !== 95 && !(c1 === 39 && LEX.stringPrefixes!.includes(String.fromCharCode(c).toUpperCase()))) {
      // identifiers: stop before `$$` (else the lexer scans them itself)
      let p = start + 1;
      let cut = -1;
      while (p < n) {
        const ch = t.charCodeAt(p);
        if (ch === 36 && t.charCodeAt(p + 1) === 36) { cut = p; break; }
        if (!lx.isIdentPart(ch)) break;
        p++;
      }
      if (cut < 0) return null;
      const upper = t.slice(start, cut).toUpperCase();
      lx.pos = cut;
      return lx.make(spec().keywords.has(upper) ? 'keyword' : 'ident', start, cut, upper);
    }
    if (c === 95) {
      // _charset'…' introducer
      let p = start + 1;
      while (p < n && lx.isIdentPart(t.charCodeAt(p))) p++;
      if (t.charCodeAt(p) === 39 && p > start + 1) {
        const [end, ok] = lx.scanEString(p + 1);
        lx.endState = ok ? '' : 'e';
        return lx.multi('string', start, end, !ok);
      }
      return null;
    }
    if (c === 58 && start > 0 && lx.isIdentPart(t.charCodeAt(start - 1)) && !isDigit(t.charCodeAt(start - 1))) return null;
    return traits(lx, start, c, c1);
  };
}

/** True when the token at i is a word with this upper-case text. */
const W = (toks: Token[], i: number, w: string) => !!toks[i] && (toks[i].kind === 'keyword' || toks[i].kind === 'ident') && toks[i].upper === w;

/** Statement kinds the shared classifier does not know (destructive guard, history labels). */
function classify(toks: Token[], head: number): StatementKind | undefined {
  const u = toks[head]?.upper;
  switch (u) {
    case 'REPLACE': return 'insert';
    case 'START': return W(toks, head + 1, 'TRANSACTION') ? 'tx' : 'other';
    case 'BEGIN': return W(toks, head + 1, 'NOT') && W(toks, head + 2, 'ATOMIC') ? 'block' : 'tx';
    case 'XA': return 'tx';
    case 'LOOP': case 'REPEAT': case 'CASE': return 'block';
    case 'DESCRIBE': case 'DESC': return 'explain';
    case 'LOAD': return W(toks, head + 1, 'DATA') || W(toks, head + 1, 'XML') ? 'insert' : 'other';
    case 'HANDLER': case 'LOCK': case 'UNLOCK': case 'SHOW': case 'KILL': case 'FLUSH': return 'other';
    default:
      // `lbl: BEGIN NOT ATOMIC …` / `lbl: LOOP …` (MariaDB compound statements outside routines)
      if (toks[head]?.kind === 'ident' && toks[head + 1]?.text === ':') return 'block';
      return undefined;
  }
}

export const define: DialectDefine = (kit) => {
  let spec: DialectSpec | null = null;
  spec = kit.buildSpec({
    id: 'mysql',
    keywords: KEYWORDS,
    contextual: CONTEXTUAL,
    notAlias: 'USE IGNORE FORCE STRAIGHT_JOIN PARTITION LOCK WINDOW ROWS DUPLICATE',
    statementStarts: STATEMENT_STARTS,
    dataTypes: DATA_TYPES,
    catalog: catalog as FunctionCatalogJson,
    systemCatalog: system as unknown as SystemCatalogJson,
    quote: ['`', '`'],
    // identifiers compare case-insensitively (table names depend on lower_case_table_names; kept as typed)
    caseFolding: 'insensitive',
    batchSeparator: null,
    identExtra: '$',
    snippets: SNIPPETS,
    selectKeywords: 'DISTINCT, DISTINCTROW, CASE, CAST, CONVERT, NULL, EXISTS, NOT, ALL, IF, IFNULL, COALESCE, INTERVAL, HIGH_PRIORITY, STRAIGHT_JOIN, SQL_CALC_FOUND_ROWS, SQL_NO_CACHE',
    afterSourceKeywords: `
      WHERE, INNER JOIN, LEFT JOIN, RIGHT JOIN, CROSS JOIN, STRAIGHT_JOIN, NATURAL JOIN, JOIN, USE INDEX (, FORCE INDEX (,
      IGNORE INDEX (, GROUP BY, ORDER BY, HAVING, WINDOW, LIMIT, FOR UPDATE, FOR SHARE, LOCK IN SHARE MODE, UNION, UNION ALL,
      EXCEPT, INTERSECT, PARTITION (, AS`,
    afterExprKeywords: `
      AND, OR, XOR, NOT, IN, IS NULL, IS NOT NULL, LIKE, NOT LIKE, REGEXP, RLIKE, SOUNDS LIKE, BETWEEN, DIV, MOD, GROUP BY,
      ORDER BY, HAVING, LIMIT, UNION, UNION ALL, WITH ROLLUP, ON DUPLICATE KEY UPDATE`,
    startKeywords: `
      SELECT, INSERT INTO, INSERT IGNORE INTO, REPLACE INTO, UPDATE, DELETE FROM, WITH, WITH RECURSIVE, CREATE TABLE,
      CREATE TABLE IF NOT EXISTS, CREATE INDEX, CREATE UNIQUE INDEX, CREATE FULLTEXT INDEX, CREATE OR REPLACE VIEW,
      CREATE PROCEDURE, CREATE FUNCTION, CREATE TRIGGER, CREATE EVENT, CREATE DATABASE, ALTER TABLE, DROP TABLE,
      DROP TABLE IF EXISTS, TRUNCATE TABLE, RENAME TABLE, CALL, START TRANSACTION, BEGIN, COMMIT, ROLLBACK, SAVEPOINT, SET,
      SET NAMES, SHOW TABLES, SHOW DATABASES, SHOW FULL COLUMNS FROM, SHOW CREATE TABLE, SHOW INDEX FROM, SHOW PROCESSLIST,
      SHOW VARIABLES LIKE, SHOW STATUS LIKE, SHOW WARNINGS, SHOW ENGINE INNODB STATUS, DESCRIBE, EXPLAIN, EXPLAIN ANALYZE,
      EXPLAIN FORMAT=JSON, USE, LOCK TABLES, UNLOCK TABLES, LOAD DATA INFILE, ANALYZE TABLE, OPTIMIZE TABLE, CHECK TABLE,
      REPAIR TABLE, KILL, KILL QUERY, FLUSH, GRANT, REVOKE, PREPARE, EXECUTE, DEALLOCATE PREPARE, HANDLER, DO, DELIMITER`,
    ops2: ['<>', '!=', '<=', '>=', '||', ':=', '->', '<<', '>>', '&&'],
    ops3: ['<=>', '->>'],
    lex: LEX,
    lexHook: mysqlLexer(() => spec!),
    split: splitMysql,
    formatRules: mysqlRules,
    classify,
  });
  return spec;
};

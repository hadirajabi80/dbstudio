// Snowflake dialect spec (plan-batch3 WP-SF), loaded lazily by dialect/registry.ts (D7).
// Rules for this chunk (and every file only it imports: split/snowflake, format/rules/snowflake, data/snowflake-*.json):
// - no runtime import from the shell / intel / format modules (type imports are fine): use the kit arguments instead
//   (DialectKit here, SplitKit in the splitter, FormatKit in the rules factory), else the initial bundle re-partitions;
// - lazy-only shared helpers are fine: ./ansi (ANSI base), ../lexer/traits (traitLexer);
// - export `define` (DialectDefine).
// Unquoted identifiers fold to upper case. Lexing: `'…'` with backslash escapes, `$$ … $$` bodies, `:name` / `?` / `:1`
// binds, but a colon right after a value is the VARIANT path operator (`v:customer.name`, `t.v:items[0]`), never a bind;
// `$1` is a staged-file column and `@stage` a stage reference (plain text, not parameters).
import type { DialectDefine, FunctionCatalogJson, LexTraits, SystemCatalogJson } from './spec';
import type { LexHook } from '../lexer/lexer';
import type { Token } from '../types';
import catalog from './data/snowflake-functions.json';
import system from './data/snowflake-system.json';
import { traitLexer } from '../lexer/traits';
import { splitSnowflake } from '../split/snowflake';
import { snowflakeRules } from '../../format/rules/snowflake';

// `$1` is a staged-file column (SELECT $1, $2 FROM @stage), not a bind: no dollarParams (docs/wp-notes/WP-SF.md R3-3).
const LEX: LexTraits = { backslashEscapes: true, dollarQuotes: true, paramPrefixes: ':?', stringPrefixes: 'X' };

const base = traitLexer(LEX);
const COLON = 58, QUOTE = 34, RBRACKET = 93, RPAREN = 41, DOLLAR = 36;
const isDigit = (c: number) => c >= 48 && c <= 57;

/** The path colon: `:` directly after an identifier, a quoted name, `]` or `)` (and not the `::` cast). */
export const snowflakeLexHook: LexHook = (lx, start, c, c1) => {
  if (c === DOLLAR && isDigit(c1)) {
    let p = start + 1;
    while (p < lx.text.length && isDigit(lx.text.charCodeAt(p))) p++;
    // a staged-file column (`$1`, also `$1:path`): an identifier, never a bind
    lx.pos = p;
    return lx.make('ident', start, p);
  }
  if (c === COLON && c1 !== COLON && start > 0) {
    const p = lx.text.charCodeAt(start - 1);
    if (p !== COLON && (lx.isIdentPart(p) || p === QUOTE || p === RBRACKET || p === RPAREN)) {
      lx.pos = start + 1;
      return lx.make('op', start, start + 1);
    }
  }
  return base(lx, start, c, c1);
};

const head = (toks: Token[], i: number, k: number) => toks[i + k]?.upper ?? '';

export const define: DialectDefine = (kit) =>
  kit.buildSpec({
    id: 'snowflake',
    // Snowflake's reserved keywords (docs "Reserved & limited keywords") plus the statement words.
    keywords: `
      ACCOUNT ALL ALTER AND ANY AS ASC BETWEEN BY CASE CAST CHECK COLUMN CONNECT CONNECTION CONSTRAINT CREATE CROSS
      CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DATABASE DELETE DESC DISTINCT DROP ELSE EXISTS
      FALSE FOLLOWING FOR FROM FULL GRANT GROUP GSCLUSTER HAVING ILIKE IN INCREMENT INNER INSERT INTERSECT INTO IS ISSUE
      JOIN LATERAL LEFT LIKE LOCALTIME LOCALTIMESTAMP MINUS NATURAL NOT NULL OF ON OR ORDER ORGANIZATION QUALIFY REGEXP
      REVOKE RIGHT RLIKE ROW ROWS SAMPLE SCHEMA SELECT SET SOME START TABLE TABLESAMPLE THEN TO TRIGGER TRUE TRY_CAST
      UNION UNIQUE UPDATE USING VALUES VIEW WHEN WHENEVER WHERE WINDOW WITH
      MERGE TRUNCATE UNDROP BEGIN COMMIT ROLLBACK USE SHOW DESCRIBE EXPLAIN CALL EXECUTE IMMEDIATE COPY PUT REMOVE
      DECLARE LIMIT OFFSET FETCH OVER PARTITION PIVOT UNPIVOT END`,
    contextual: `
      ACTION ADD AFTER ALERT APPEND_ONLY ARRAY AT AUTOINCREMENT AUTO_INGEST AUTO_RESUME AUTO_SUSPEND BEFORE CASCADE
      CHANGES CHANGE_TRACKING CLONE CLUSTER CLUSTERING COMMENT COPY_GRANTS CREDENTIALS CURSOR DATA_RETENTION_TIME_IN_DAYS
      DEFAULT DO DYNAMIC EVENT EXCEPTION EXTERNAL FILE FILES FILE_FORMAT FIRST FORMAT FORMAT_NAME FUNCTION FUNCTIONS
      FUTURE GLOBAL HYBRID ICEBERG IDENTITY IF IGNORE INITIALLY_SUSPENDED INTEGRATION KEY LANGUAGE LAST LET LOOP
      MATCH_RECOGNIZE MASKING MATERIALIZED MAX_CLUSTER_COUNT MEASURES MIN_CLUSTER_COUNT NAME NETWORK NEXT NULLS OBJECT
      OBJECTS ON_ERROR OPTIONS OR OUTER OVERWRITE OWNERSHIP PATTERN PIPE PIPES POLICY PRECEDING PRIMARY PRIVILEGES
      PROCEDURE PROCEDURES RANGE RECURSIVE REFERENCES REFRESH RENAME REPEAT REPLACE RESOURCE RESULT RESUME RETURN
      RETURNS ROLE ROLES RUNNING SCALING_POLICY SCHEDULE SCHEMAS SECONDARY SECURE SEQUENCE SERVERLESS SHARE SIZE STAGE
      STAGES STORAGE STREAM STREAMS STRICT SUSPEND SUSPENDED TAG TARGET_LAG TASK TASKS TEMP TEMPORARY TRANSACTION
      TRANSIENT TYPE UNBOUNDED UNSET USER VARIANT VOLATILE WAREHOUSE WAREHOUSES WAREHOUSE_SIZE WHILE WORK`,
    notAlias: 'QUALIFY LATERAL SAMPLE TABLESAMPLE PIVOT UNPIVOT MATCH_RECOGNIZE CHANGES AT BEFORE CONNECT START WINDOW',
    statementStarts: `
      SELECT INSERT UPDATE DELETE MERGE WITH CREATE ALTER DROP UNDROP TRUNCATE BEGIN START COMMIT ROLLBACK USE SHOW
      DESCRIBE DESC LIST LS GET PUT REMOVE RM COPY CALL EXECUTE SET UNSET GRANT REVOKE COMMENT EXPLAIN DECLARE`,
    dataTypes: `
      NUMBER DECIMAL NUMERIC INT INTEGER BIGINT SMALLINT TINYINT BYTEINT FLOAT FLOAT4 FLOAT8 DOUBLE REAL DECFLOAT VARCHAR
      CHAR CHARACTER NCHAR STRING TEXT NVARCHAR BINARY VARBINARY BOOLEAN DATE DATETIME TIME TIMESTAMP TIMESTAMP_LTZ
      TIMESTAMP_NTZ TIMESTAMP_TZ VARIANT OBJECT ARRAY MAP GEOGRAPHY GEOMETRY VECTOR`,
    catalog: catalog as FunctionCatalogJson,
    systemCatalog: system as unknown as SystemCatalogJson,
    quote: ['"', '"'],
    caseFolding: 'upper',
    batchSeparator: null,
    identExtra: '$',
    snippets: [
      { prefix: 'sel', label: 'sel', body: 'SELECT ${1:*}\nFROM ${2:table}$0', doc: 'SELECT ... FROM' },
      { prefix: 'selw', label: 'selw', body: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition}$0', doc: 'SELECT ... FROM ... WHERE' },
      { prefix: 'qual', label: 'qual', body: 'SELECT ${1:*}\nFROM ${2:table}\nQUALIFY ROW_NUMBER() OVER (PARTITION BY ${3:key} ORDER BY ${4:ts} DESC) = 1$0', doc: 'Latest row per key (QUALIFY ROW_NUMBER() = 1)' },
      { prefix: 'flat', label: 'flat', body: 'SELECT ${1:t}.${2:id}, f.value:${3:name}::STRING AS ${3:name}\nFROM ${4:table} ${1:t},\n\tLATERAL FLATTEN(input => ${1:t}.${5:payload}:${6:items}) f$0', doc: 'Explode a VARIANT array with LATERAL FLATTEN' },
      { prefix: 'ins', label: 'ins', body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})$0', doc: 'INSERT INTO ... VALUES' },
      { prefix: 'merge', label: 'merge', body: 'MERGE INTO ${1:target} t\nUSING ${2:source} s ON t.${3:id} = s.${3:id}\nWHEN MATCHED THEN UPDATE SET t.${4:col} = s.${4:col}\nWHEN NOT MATCHED THEN INSERT (${3:id}, ${4:col}) VALUES (s.${3:id}, s.${4:col})$0', doc: 'MERGE INTO ... USING ... WHEN MATCHED / NOT MATCHED' },
      { prefix: 'upd', label: 'upd', body: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition}$0', doc: 'UPDATE ... SET ... WHERE' },
      { prefix: 'del', label: 'del', body: 'DELETE FROM ${1:table}\nWHERE ${2:condition}$0', doc: 'DELETE FROM ... WHERE' },
      { prefix: 'copy', label: 'copy', body: "COPY INTO ${1:table}\nFROM @${2:stage}/${3:path}\nFILE_FORMAT = (TYPE = ${4|CSV,JSON,PARQUET|} ${5:SKIP_HEADER = 1})\nON_ERROR = ${6:'ABORT_STATEMENT'}$0", doc: 'Load files from a stage (COPY INTO)' },
      { prefix: 'proc', label: 'proc', body: 'CREATE OR REPLACE PROCEDURE ${1:name}(${2:P_ID NUMBER})\nRETURNS ${3:VARCHAR}\nLANGUAGE SQL\nAS\n\\$\\$\nBEGIN\n\t$0\n\tRETURN \'ok\';\nEND;\n\\$\\$;', doc: 'CREATE OR REPLACE PROCEDURE ... LANGUAGE SQL (Snowflake Scripting)' },
      { prefix: 'block', label: 'block', body: 'EXECUTE IMMEDIATE \\$\\$\nDECLARE\n\t${1:n} NUMBER DEFAULT 0;\nBEGIN\n\t$0\n\tRETURN ${1:n};\nEND;\n\\$\\$;', doc: 'Anonymous Snowflake Scripting block' },
      { prefix: 'task', label: 'task', body: "CREATE OR REPLACE TASK ${1:name}\n\tWAREHOUSE = ${2:COMPUTE_WH}\n\tSCHEDULE = '${3:USING CRON 0 * * * * UTC}'\nAS\n\t${4:CALL proc()};$0", doc: 'CREATE TASK ... SCHEDULE ... AS' },
      { prefix: 'tt', label: 'tt', body: 'SELECT ${1:*}\nFROM ${2:table} AT (OFFSET => -${3:60}*${4:5})$0', doc: 'Time Travel: the table as of N seconds ago' },
    ],
    selectKeywords: 'DISTINCT, CASE, CAST, TRY_CAST, NULL, IFF, COALESCE, NULLIF, EXISTS, NOT, ALL, TOP',
    afterSourceKeywords: `
      WHERE, INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN, JOIN, NATURAL JOIN, ASOF JOIN, LATERAL FLATTEN(,
      GROUP BY, GROUP BY ALL, ORDER BY, HAVING, QUALIFY, WINDOW, LIMIT, OFFSET, FETCH FIRST, PIVOT (, UNPIVOT (,
      MATCH_RECOGNIZE (, SAMPLE, TABLESAMPLE, AT (, BEFORE (, CHANGES (, UNION, UNION ALL, EXCEPT, MINUS, INTERSECT, AS`,
    afterExprKeywords: `
      AND, OR, NOT, IN, IS NULL, IS NOT NULL, IS DISTINCT FROM, LIKE, ILIKE, RLIKE, LIKE ANY, ILIKE ANY, REGEXP, BETWEEN,
      GROUP BY, ORDER BY, HAVING, QUALIFY, LIMIT, OFFSET, UNION, UNION ALL, EXCEPT, MINUS, INTERSECT, OVER (`,
    startKeywords: `
      SELECT, INSERT INTO, INSERT OVERWRITE INTO, UPDATE, DELETE FROM, MERGE INTO, WITH, CREATE TABLE, CREATE OR REPLACE TABLE,
      CREATE TRANSIENT TABLE, CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE VIEW, CREATE SECURE VIEW, CREATE MATERIALIZED VIEW,
      CREATE DYNAMIC TABLE, CREATE OR REPLACE PROCEDURE, CREATE OR REPLACE FUNCTION, CREATE STAGE, CREATE STREAM,
      CREATE TASK, CREATE PIPE, CREATE FILE FORMAT, CREATE SEQUENCE, CREATE SCHEMA, CREATE DATABASE, CREATE WAREHOUSE,
      ALTER TABLE, ALTER WAREHOUSE, ALTER SESSION SET, ALTER TASK, DROP TABLE, UNDROP TABLE, TRUNCATE TABLE,
      USE WAREHOUSE, USE ROLE, USE DATABASE, USE SCHEMA, USE SECONDARY ROLES, SHOW TABLES, SHOW WAREHOUSES, SHOW GRANTS,
      DESCRIBE TABLE, LIST, GET, PUT, REMOVE, COPY INTO, CALL, EXECUTE IMMEDIATE, EXECUTE TASK, BEGIN, COMMIT, ROLLBACK,
      EXPLAIN, EXPLAIN USING JSON, GRANT, REVOKE, SET, UNSET`,
    ops2: ['<>', '!=', '<=', '>=', '||', '::', '=>', ':=', '->'],
    lex: LEX,
    lexHook: snowflakeLexHook,
    split: splitSnowflake,
    formatRules: snowflakeRules,
    classify: (toks, i) => {
      const u = head(toks, i, 0);
      switch (u) {
        case 'SHOW': case 'DESCRIBE': case 'DESC': case 'LIST': case 'LS': case 'GET': return 'select';
        case 'PUT': case 'COPY': return 'insert';
        case 'REMOVE': case 'RM': return 'delete:destructive';
        case 'UNDROP': return 'create';
        case 'UNSET': return 'set';
        case 'BEGIN': {
          const n = head(toks, i, 1);
          return !n || n === ';' || n === 'TRANSACTION' || n === 'WORK' || n === 'NAME' ? 'tx' : 'block';
        }
        case 'START': return head(toks, i, 1) === 'TRANSACTION' ? 'tx' : undefined;
        case 'DECLARE': return 'block';
        case 'ALTER': return head(toks, i, 1) === 'SESSION' ? 'set' : undefined;
        case 'EXECUTE': return head(toks, i, 1) === 'IMMEDIATE' ? 'block' : 'exec';
        default: return undefined;
      }
    },
  });

// MySQL / MariaDB formatter tables (plan-batch3 WP-MY). Part of the lazy mysql chunk (DialectSpec.formatRules, built by
// format/layout.ts rulesFor): no runtime imports, build from the FormatKit. The layout itself takes MySQL down the SQLite
// path (semicolon-ended statements): backtick identifiers, LIMIT n [OFFSET m] / LIMIT m, n, STRAIGHT_JOIN and GROUP BY
// … WITH ROLLUP come out right from these tables; ON DUPLICATE KEY UPDATE / INSERT … SET / REPLACE INTO clause breaks
// and DELIMITER lines as their own chunks need the layout changes requested in docs/wp-notes/WP-MY.md (R3).
import type { FormatRulesFactory } from '../../intel/dialect/spec';

export const mysqlRules: FormatRulesFactory = (kit) => ({
  ...kit.sqliteRules,
  dialect: 'mysql',
  statementStarts: kit.set(`
    SELECT INSERT UPDATE DELETE REPLACE WITH CREATE ALTER DROP TRUNCATE RENAME BEGIN START COMMIT ROLLBACK SAVEPOINT
    RELEASE SET SHOW DESCRIBE EXPLAIN USE CALL DO HANDLER LOCK UNLOCK LOAD GRANT REVOKE ANALYZE OPTIMIZE CHECK CHECKSUM
    REPAIR KILL FLUSH RESET PURGE PREPARE EXECUTE DEALLOCATE DECLARE VALUES TABLE XA SIGNAL RESIGNAL LEAVE ITERATE OPEN
    CLOSE FETCH RETURN`),
  incomplete: kit.set(`
    SELECT FROM WHERE AND OR XOR NOT ON JOIN STRAIGHT_JOIN AS BY SET INTO VALUES THEN ELSE WHEN CASE IN IS LIKE REGEXP
    RLIKE DIV MOD USING DISTINCT DISTINCTROW PARTITION OVER UPDATE`),
  // keywords called like functions: no space before `(` (IF(a, b, c), REPLACE(s, x, y), LEFT(s, 3) …)
  functionKeywords: kit.set(`
    CAST CONVERT IF REPLACE LEFT RIGHT INSERT MOD REPEAT MATCH DATABASE SCHEMA CHAR CHARSET COLLATION CURRENT_USER
    CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP LOCALTIME LOCALTIMESTAMP UTC_DATE UTC_TIME UTC_TIMESTAMP INTERVAL
    COALESCE NULLIF REGEXP_LIKE`),
  operandKeywords: new Set([...kit.OPERAND_KEYWORDS_COMMON, ...kit.set('LOCALTIME LOCALTIMESTAMP UTC_DATE UTC_TIME UTC_TIMESTAMP CURRENT_USER DUAL')]),
  conditionClauses: kit.CONDITION_CLAUSES,
});

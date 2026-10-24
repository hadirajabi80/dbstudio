// ClickHouse formatter tables (plan-batch3 WP-CH). Part of the lazy clickhouse chunk (DialectSpec.formatRules, built by
// format/layout.ts rulesFor): no runtime imports, build from the FormatKit. Statements end at `;`; the ClickHouse
// statement words (OPTIMIZE, SYSTEM, KILL, ATTACH/DETACH, EXCHANGE, SHOW, DESCRIBE …) start statements, and the clause
// words that need a continuation (PREWHERE, SAMPLE, SETTINGS, FORMAT, ENGINE, TTL …) never end one.
// The shared layout breaks lines at the standard clauses (SELECT/FROM/WHERE/GROUP BY/ORDER BY/LIMIT/JOIN …); the
// ClickHouse-only clauses (PREWHERE, SETTINGS, FORMAT) and JOIN words (ARRAY, GLOBAL, ANY, ASOF …) go through FormatRules.extraClauses / joinWords.
import type { FormatRulesFactory } from '../../intel/dialect/spec';

export const clickhouseRules: FormatRulesFactory = (kit) => ({
  dialect: 'clickhouse',
  statementStarts: kit.set(`
    SELECT INSERT WITH CREATE ALTER DROP TRUNCATE RENAME EXCHANGE ATTACH DETACH OPTIMIZE SYSTEM KILL SHOW DESCRIBE DESC
    EXPLAIN USE SET EXISTS CHECK GRANT REVOKE DELETE UPDATE WATCH UNDROP BACKUP RESTORE BEGIN COMMIT ROLLBACK VALUES`),
  incomplete: kit.set(`
    SELECT FROM WHERE PREWHERE AND OR NOT ON JOIN AS BY SET INTO VALUES THEN ELSE WHEN CASE IN IS USING DISTINCT SAMPLE
    SETTINGS FORMAT ENGINE TTL PARTITION ORDER GROUP LIMIT OFFSET GLOBAL ANY ASOF ARRAY PASTE SEMI ANTI WITH CODEC
    MATERIALIZED ALIAS DEFAULT EPHEMERAL LAYOUT SOURCE LIFETIME TO`),
  functionKeywords: kit.set(`
    CAST EXTRACT TRIM POSITION SUBSTRING IF ANY ARRAY TUPLE LEFT RIGHT REPLACE LIKE ILIKE MATCH COLUMNS DATE TIMESTAMP
    COALESCE NULLIF GREATEST LEAST`),
  operandKeywords: new Set([...kit.OPERAND_KEYWORDS_COMMON, ...kit.set('FINAL TOTALS')]),
  conditionClauses: new Set([...kit.CONDITION_CLAUSES, ...kit.set('PREWHERE')]),
  extraClauses: { PREWHERE: 'where', SETTINGS: 'settings', FORMAT: 'format' },
  joinWords: kit.set('ARRAY GLOBAL ANY ALL ASOF PASTE'),
});

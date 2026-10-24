// Snowflake formatter tables (plan-batch3 WP-SF). Part of the lazy snowflake chunk (DialectSpec.formatRules, built by
// format/layout.ts rulesFor): no runtime imports, build from the FormatKit. Statements end at `;`; `$$` routine bodies are
// single string tokens and stay verbatim. FLATTEN / PIVOT / UNPIVOT / MATCH_RECOGNIZE / OBJECT_CONSTRUCT … are called
// like functions; QUALIFY is a clause line of its own that breaks its condition at AND/OR like WHERE (extraClauses).
import type { FormatRulesFactory } from '../../intel/dialect/spec';

export const snowflakeRules: FormatRulesFactory = (kit) => ({
  ...kit.sqliteRules,
  dialect: 'snowflake',
  statementStarts: kit.set(`
    SELECT INSERT UPDATE DELETE MERGE WITH CREATE ALTER DROP UNDROP TRUNCATE BEGIN START COMMIT ROLLBACK USE SHOW
    DESCRIBE DESC LIST LS GET PUT REMOVE RM COPY CALL EXECUTE SET UNSET GRANT REVOKE COMMENT EXPLAIN DECLARE LET RETURN`),
  incomplete: kit.set(`
    SELECT FROM WHERE AND OR NOT ON JOIN AS BY SET INTO VALUES THEN ELSE WHEN CASE IN IS LATERAL USING DISTINCT OVER
    PARTITION QUALIFY PIVOT UNPIVOT MATCH_RECOGNIZE SAMPLE TABLESAMPLE ILIKE RLIKE`),
  functionKeywords: kit.set(`
    CAST TRY_CAST COALESCE NULLIF GREATEST LEAST EXTRACT POSITION SUBSTRING TRIM IFF FLATTEN PIVOT UNPIVOT
    MATCH_RECOGNIZE OBJECT_CONSTRUCT ARRAY_CONSTRUCT TABLE GENERATOR RESULT_SCAN IDENTIFIER SAMPLE TABLESAMPLE ANY`),
  operandKeywords: new Set([...kit.OPERAND_KEYWORDS_COMMON, ...kit.set('CURRENT_ROLE CURRENT_WAREHOUSE CURRENT_DATABASE CURRENT_SCHEMA LOCALTIMESTAMP')]),
  conditionClauses: new Set([...kit.CONDITION_CLAUSES, 'QUALIFY']),
  extraClauses: { QUALIFY: 'where' },
});

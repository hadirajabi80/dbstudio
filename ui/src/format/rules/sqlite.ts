// SQLite formatter tables: statements end at `;`; CREATE TRIGGER … BEGIN … END; is the only block.
import { CONDITION_CLAUSES, OPERAND_KEYWORDS_COMMON, set, type FormatRules } from './common';

export const SQLITE_TRIGGER_LINES = set('BEFORE AFTER INSTEAD FOR WHEN');

export const sqliteRules: FormatRules = {
  dialect: 'sqlite',
  statementStarts: set(`
    SELECT INSERT UPDATE DELETE REPLACE WITH CREATE ALTER DROP BEGIN COMMIT END ROLLBACK SAVEPOINT RELEASE PRAGMA
    VACUUM ANALYZE ATTACH DETACH EXPLAIN REINDEX VALUES`),
  incomplete: set('SELECT FROM WHERE AND OR NOT ON JOIN AS BY SET INTO VALUES THEN ELSE WHEN CASE IN IS'),
  functionKeywords: set('CAST REPLACE LIKE GLOB RAISE MATCH REGEXP IIF'),
  operandKeywords: OPERAND_KEYWORDS_COMMON,
  conditionClauses: CONDITION_CLAUSES,
};

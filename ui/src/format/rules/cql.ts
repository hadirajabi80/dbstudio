// CQL (Cassandra / ScyllaDB) formatter tables (plan-batch3 WP-CS). Part of the lazy cql chunk (DialectSpec.formatRules,
// built by format/layout.ts rulesFor): no runtime imports, build from the FormatKit.
// The layout itself is the shared SQLite path (semicolon-ended statements, SELECT / INSERT / UPDATE / DELETE clause
// machine, CREATE TABLE column lists). BEGIN BATCH bodies, `<…>` type arguments and `{…}` / `[…]` literals need layout
// support: docs/wp-notes/WP-CS-intel.md, R3-1.
import type { FormatRulesFactory } from '../../intel/dialect/spec';

export const cqlRules: FormatRulesFactory = (kit) => ({
  ...kit.sqliteRules,
  dialect: 'cql',
  statementStarts: kit.set(`
    SELECT INSERT UPDATE DELETE BEGIN APPLY CREATE ALTER DROP TRUNCATE USE GRANT REVOKE LIST DESCRIBE DESC CONSISTENCY
    SERIAL TRACING PAGING SHOW EXPAND`),
  incomplete: kit.set('SELECT FROM WHERE AND OR NOT AS BY SET INTO VALUES IN IS USING IF TTL TIMESTAMP CONTAINS KEY BATCH'),
  // called like functions: no space before `(`
  functionKeywords: kit.set('CAST TOKEN TTL WRITETIME MAXWRITETIME KEYS ENTRIES FULL'),
  operandKeywords: new Set([...kit.OPERAND_KEYWORDS_COMMON, 'NAN', 'INFINITY', 'UNSET']),
  conditionClauses: kit.set('WHERE IF'),
});

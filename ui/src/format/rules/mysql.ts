// MySQL / MariaDB formatter tables (plan-batch3 WP-MY). Part of the lazy mysql chunk (DialectSpec.formatRules, built by
// format/layout.ts rulesFor): no runtime imports, build from the FormatKit. WP0 stub: the SQLite tables under this id.
import type { FormatRulesFactory } from '../../intel/dialect/spec';

export const mysqlRules: FormatRulesFactory = (kit) => ({ ...kit.sqliteRules, dialect: 'mysql' });

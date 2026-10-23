// Snowflake formatter tables (plan-batch3 WP-SF). Part of the lazy snowflake chunk (DialectSpec.formatRules, built by
// format/layout.ts rulesFor): no runtime imports, build from the FormatKit. WP0 stub: the SQLite tables under this id.
import type { FormatRulesFactory } from '../../intel/dialect/spec';

export const snowflakeRules: FormatRulesFactory = (kit) => ({ ...kit.sqliteRules, dialect: 'snowflake' });

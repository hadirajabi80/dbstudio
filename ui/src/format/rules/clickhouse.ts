// ClickHouse formatter tables (plan-batch3 WP-CH). Part of the lazy clickhouse chunk (DialectSpec.formatRules, built by
// format/layout.ts rulesFor): no runtime imports, build from the FormatKit. WP0 stub: the SQLite tables under this id.
import type { FormatRulesFactory } from '../../intel/dialect/spec';

export const clickhouseRules: FormatRulesFactory = (kit) => ({ ...kit.sqliteRules, dialect: 'clickhouse' });

// CQL (Cassandra / ScyllaDB) formatter tables (plan-batch3 WP-CS). Part of the lazy cql chunk (DialectSpec.formatRules, built by
// format/layout.ts rulesFor): no runtime imports, build from the FormatKit. WP0 stub: the SQLite tables under this id.
import type { FormatRulesFactory } from '../../intel/dialect/spec';

export const cqlRules: FormatRulesFactory = (kit) => ({ ...kit.sqliteRules, dialect: 'cql' });

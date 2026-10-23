// CQL statement splitter (plan-batch3 WP-CS): BEGIN [UNLOGGED|COUNTER] BATCH … APPLY BATCH stays one statement. Part of
// the lazy cql chunk (DialectSpec.split): no runtime imports, use the SplitKit. WP0 stub: plain semicolons.
import type { DialectSplitter } from '../dialect/spec';

export const splitCql: DialectSplitter = (b, sig, opts, kit) => kit.splitSemicolon(b, sig, opts);

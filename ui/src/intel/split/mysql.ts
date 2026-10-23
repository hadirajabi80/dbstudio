// MySQL / MariaDB statement splitter (plan-batch3 WP-MY): DELIMITER lines, BEGIN … END bodies, \G. Part of the lazy
// mysql chunk (DialectSpec.split): no runtime imports, use the SplitKit. WP0 stub: plain semicolons.
import type { DialectSplitter } from '../dialect/spec';

export const splitMysql: DialectSplitter = (b, sig, opts, kit) => kit.splitSemicolon(b, sig, opts);

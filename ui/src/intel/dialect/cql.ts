// CQL (Cassandra / ScyllaDB) dialect spec (plan-batch3 WP-CS), loaded lazily by dialect/registry.ts (D7).
// Rules for this chunk (and every file only it imports: split/cql, format/rules/cql, data/cql-*.json):
// - no runtime import from the shell / intel / format modules (type imports are fine): use the kit arguments instead
//   (DialectKit here, SplitKit in the splitter, FormatKit in the rules factory), else the initial bundle re-partitions;
// - lazy-only shared helpers are fine: ./ansi (ANSI base), ../lexer/traits (traitLexer);
// - export `define` (DialectDefine).
// WP0 stub: the ANSI base plus the lexer traits; WP-CS owns this file.
import type { DialectDefine, FunctionCatalogJson, LexTraits } from './spec';
import catalog from './data/cql-functions.json';
import { ansiInit } from './ansi';
import { traitLexer } from '../lexer/traits';
import { splitCql } from '../split/cql';
import { cqlRules } from '../../format/rules/cql';

const LEX: LexTraits = { paramPrefixes: ':?' };

export const define: DialectDefine = (kit) =>
  kit.buildSpec({
    ...ansiInit('cql'),
    catalog: catalog as FunctionCatalogJson,
    caseFolding: 'lower',
    lex: LEX,
    lexHook: traitLexer(LEX),
    split: splitCql,
    formatRules: cqlRules,
  });

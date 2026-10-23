// Snowflake dialect spec (plan-batch3 WP-SF), loaded lazily by dialect/registry.ts (D7).
// Rules for this chunk (and every file only it imports: split/…, format/rules/snowflake, data/snowflake-*.json):
// - no runtime import from the shell / intel / format modules (type imports are fine): use the kit arguments instead
//   (DialectKit here, SplitKit in the splitter, FormatKit in the rules factory), else the initial bundle re-partitions;
// - lazy-only shared helpers are fine: ./ansi (ANSI base), ../lexer/traits (traitLexer);
// - export `define` (DialectDefine).
// WP0 stub: the ANSI base plus the lexer traits; WP-SF owns this file.
import type { DialectDefine, FunctionCatalogJson, LexTraits } from './spec';
import catalog from './data/snowflake-functions.json';
import { ansiInit } from './ansi';
import { traitLexer } from '../lexer/traits';
import { snowflakeRules } from '../../format/rules/snowflake';

const LEX: LexTraits = { backslashEscapes: true, dollarQuotes: true, dollarParams: true, paramPrefixes: ':?' };

export const define: DialectDefine = (kit) =>
  kit.buildSpec({
    ...ansiInit('snowflake'),
    catalog: catalog as FunctionCatalogJson,
    caseFolding: 'upper',
    lex: LEX,
    lexHook: traitLexer(LEX),
    ops2: ['<>', '!=', '<=', '>=', '||', '::', '=>', ':=', '->'],
    formatRules: snowflakeRules,
  });

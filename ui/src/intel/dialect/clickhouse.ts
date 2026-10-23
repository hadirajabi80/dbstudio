// ClickHouse dialect spec (plan-batch3 WP-CH), loaded lazily by dialect/registry.ts (D7).
// Rules for this chunk (and every file only it imports: split/…, format/rules/clickhouse, data/clickhouse-*.json):
// - no runtime import from the shell / intel / format modules (type imports are fine): use the kit arguments instead
//   (DialectKit here, SplitKit in the splitter, FormatKit in the rules factory), else the initial bundle re-partitions;
// - lazy-only shared helpers are fine: ./ansi (ANSI base), ../lexer/traits (traitLexer);
// - export `define` (DialectDefine).
// WP0 stub: the ANSI base plus the lexer traits; WP-CH owns this file.
import type { DialectDefine, FunctionCatalogJson, LexTraits } from './spec';
import catalog from './data/clickhouse-functions.json';
import { ansiInit } from './ansi';
import { traitLexer } from '../lexer/traits';
import { clickhouseRules } from '../../format/rules/clickhouse';

const LEX: LexTraits = { backtickIdent: true, hashComment: true, backslashEscapes: true, braceParams: true, hexNumbers: true };

export const define: DialectDefine = (kit) =>
  kit.buildSpec({
    ...ansiInit('clickhouse'),
    catalog: catalog as FunctionCatalogJson,
    quote: ['`', '`'],
    lex: LEX,
    lexHook: traitLexer(LEX),
    ops2: ['<>', '!=', '<=', '>=', '||', '::', '->', '=='],
    formatRules: clickhouseRules,
  });

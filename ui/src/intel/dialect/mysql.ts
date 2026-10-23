// MySQL / MariaDB dialect spec (plan-batch3 WP-MY), loaded lazily by dialect/registry.ts (D7).
// Rules for this chunk (and every file only it imports: split/mysql, format/rules/mysql, data/mysql-*.json):
// - no runtime import from the shell / intel / format modules (type imports are fine): use the kit arguments instead
//   (DialectKit here, SplitKit in the splitter, FormatKit in the rules factory), else the initial bundle re-partitions;
// - lazy-only shared helpers are fine: ./ansi (ANSI base), ../lexer/traits (traitLexer);
// - export `define` (DialectDefine).
// WP0 stub: the ANSI base plus the lexer traits; WP-MY owns this file.
import type { DialectDefine, FunctionCatalogJson, LexTraits } from './spec';
import catalog from './data/mysql-functions.json';
import { ansiInit } from './ansi';
import { traitLexer } from '../lexer/traits';
import { splitMysql } from '../split/mysql';
import { mysqlRules } from '../../format/rules/mysql';

const LEX: LexTraits = { backtickIdent: true, hashComment: true, backslashEscapes: true, paramPrefixes: '@:?', hexNumbers: true, stringPrefixes: 'NXB' };

export const define: DialectDefine = (kit) =>
  kit.buildSpec({
    ...ansiInit('mysql'),
    catalog: catalog as FunctionCatalogJson,
    quote: ['`', '`'],
    lex: LEX,
    lexHook: traitLexer(LEX),
    ops2: ['<>', '!=', '<=', '>=', '||', ':=', '->', '<<', '>>', '&&'],
    ops3: ['<=>', '->>'],
    split: splitMysql,
    formatRules: mysqlRules,
  });

// Dialect tables shared by the lexer, splitter, parser and completer.
import type { CatalogSchema } from '../../api/types';
import type { FormatRules } from '../../format/rules/common';
import type { Dialect, StatementKind, Token } from '../types';
import type { SplitBuilder, SplitOptions } from '../split/splitter';
import type { LexHook } from '../lexer/lexer';
import type { ExtraCompletionSource } from '../complete/completer';

export interface FunctionSignature { params: string[]; returns?: string; doc?: string }
export interface FunctionDef {
  name: string;
  category: string;
  kind: 'scalar' | 'aggregate' | 'window' | 'table' | 'global' | 'niladic';
  signatures: FunctionSignature[];
  returns?: string;
  doc: string;
  since?: string;
  deprecated?: boolean;
  /**
   * Set-returning functions (`kind: 'table'`): output column names. Absent: one column named after the function
   * (PostgreSQL names a scalar SRF's column after its table alias when one is given).
   */
  columns?: string[];
}
export interface PackageMemberDef { name: string; kind: 'proc' | 'func'; signatures: FunctionSignature[]; doc?: string }
export interface PackageDef { name: string; doc: string; members: PackageMemberDef[] }
export interface OperatorDef { op: string; doc: string }
export interface FunctionCatalogJson { functions: FunctionDef[]; packages?: PackageDef[]; operators?: OperatorDef[] }

export interface SnippetDef { prefix: string; label: string; body: string; doc: string }

export type CaseFolding = 'upper' | 'lower' | 'insensitive';

/**
 * Batch 3 (plan-batch3 D8): lexer traits as data, so a dialect never edits lexer.ts (lexer/traits.ts implements them as the
 * DialectSpec.lexHook of the lazy dialect modules). Every flag defaults to off; the four original dialects keep their
 * hard-wired rules and set none of these.
 */
export interface LexTraits {
  /** `name` is a quoted identifier (MySQL, ClickHouse; SQLite has it built in). */
  backtickIdent?: boolean;
  /** `# …` is a line comment (MySQL, ClickHouse). */
  hashComment?: boolean;
  /** A backslash escapes the next character inside '…' (MySQL, ClickHouse, Snowflake); '' still doubles. */
  backslashEscapes?: boolean;
  /** `$$…$$` / `$tag$…$tag$` string bodies (Snowflake; PostgreSQL has them built in). */
  dollarQuotes?: boolean;
  /**
   * Characters that start a named parameter / variable when an identifier follows (`:` → `:name`, `@` → `@name`;
   * a doubled `@@` also reads `@@sysvar`). `?` here makes a lone `?` a positional parameter.
   */
  paramPrefixes?: string;
  /** `$1`, `$2` … are positional parameters / column references (Snowflake). */
  dollarParams?: boolean;
  /** ClickHouse `{name:Type}` query parameters. */
  braceParams?: boolean;
  /** `0x1F` hexadecimal literals (MySQL, ClickHouse; T-SQL/SQLite have them built in). */
  hexNumbers?: boolean;
  /** Letters that may prefix a '…' string (e.g. 'NXB' for N'…', X'…', B'…'). Default: N only. */
  stringPrefixes?: string;
}

/** Built-in schemas the catalog index consults after the loaded ones (PostgreSQL pg_catalog, MySQL information_schema…). */
export interface SystemCatalogJson { schemas: CatalogSchema[] }

// ---- Batch 3 (plan-batch3 D7): lazily loaded dialect modules ------------------------------------------------------
// A lazy dialect chunk (dialect/<id>.ts and the files only it imports) must not import runtime code from the initial
// bundle: one such import makes the bundler re-partition the shared intel/splitter chunks (measured: about +3 KB gzipped
// on the initial load). It gets what it needs at run time instead: DialectKit (from dialect/registry.ts), SplitKit (from
// split/splitter.ts) and FormatKit (from format/layout.ts). `import type` is always fine.

/** Helpers split/splitter.ts hands a dialect splitter when it calls it. */
export interface SplitKit {
  /** The default splitter: `;` outside parentheses and CASE … END (honours blankLineSplitsStatements). */
  splitSemicolon(b: SplitBuilder, sig: number[], opts: SplitOptions): void;
  isWordTok(t: Token | undefined): boolean;
  /** True when [from, to) of the text holds an empty line. */
  hasBlankLine(text: string, from: number, to: number): boolean;
}

/**
 * Batch 3: statement splitter of a dialect without its own case in split/splitter.ts. Receives the splitter's builder,
 * the indices of the significant tokens and the SplitKit.
 */
export type DialectSplitter = (b: SplitBuilder, sig: number[], opts: SplitOptions, kit: SplitKit) => void;

/** Helpers format/layout.ts hands a dialect's formatter-rules factory. */
export interface FormatKit {
  /** The SQLite tables (semicolon-ended statements): a starting point to spread. */
  sqliteRules: FormatRules;
  /** Word set from a whitespace-separated list (upper case). */
  set(words: string): Set<string>;
  CONDITION_CLAUSES: Set<string>;
  OPERAND_KEYWORDS_COMMON: Set<string>;
}

/** Batch 3: a lazy dialect's formatter rules, built on first use from the FormatKit (format/layout.ts `rulesFor`). */
export type FormatRulesFactory = (kit: FormatKit) => FormatRules;

/** Lookup form of a name under a folding rule ('insensitive' compares upper-cased; quoted names are exact otherwise). */
export function foldName(name: string, quoted: boolean, folding: CaseFolding): string {
  if (folding === 'insensitive') return name.toUpperCase();
  if (quoted) return name;
  return folding === 'upper' ? name.toUpperCase() : name.toLowerCase();
}

export interface DialectSpec {
  id: Dialect;
  /** Reserved words: lexed as `keyword`. */
  keywords: Set<string>;
  /** Non-reserved words offered as keywords by the completer (lexed as `ident`). */
  contextualKeywords: Set<string>;
  /** Words that can never be a table alias (in addition to reserved words). */
  notAlias: Set<string>;
  /** Words that start a statement (splitter + statement-start context). */
  statementStarts: Set<string>;
  dataTypes: string[];
  dataTypeSet: Set<string>;
  functions: FunctionDef[];
  functionMap: Map<string, FunctionDef>;
  packages: PackageDef[];
  packageMap: Map<string, PackageDef>;
  operators: OperatorDef[];
  /** Preferred quote for generated identifiers. */
  quote: [string, string];
  /**
   * 'upper': unquoted identifiers fold to upper case and quoted ones are exact (Oracle); 'lower': unquoted ones fold to
   * lower case and quoted ones are exact (PostgreSQL); 'insensitive': all case-insensitive.
   */
  caseFolding: CaseFolding;
  /** Lookup form of a name written in SQL under `caseFolding`. */
  fold(name: string, quoted: boolean): string;
  batchSeparator: 'go' | 'slash' | null;
  /** Characters that are valid inside an unquoted identifier besides letters, digits and `_`. */
  identExtra: string;
  snippets: SnippetDef[];
  /** Keywords valid in the SELECT list. */
  selectKeywords: string[];
  /** Keywords after a complete FROM source. */
  afterSourceKeywords: string[];
  /** Keywords after a complete WHERE/ON expression. */
  afterExprKeywords: string[];
  /** Keywords offered at statement start. */
  startKeywords: string[];
  /** Batch 3: two-character operators (else the lexer's per-dialect table, else a common ANSI set). */
  ops2?: string[];
  /** Batch 3: three-character operators. */
  ops3?: string[];
  /** Batch 3: lexer traits (see LexTraits): the declaration; `lexHook` implements them. */
  lex?: LexTraits;
  /** Batch 3: the lexer hook (lexer/traits.ts `traitLexer(lex)` in the lazy dialect module). */
  lexHook?: LexHook;
  /** Batch 3: built-in schemas for completion/resolution (PostgreSQL has pg_catalog + information_schema). */
  systemCatalog?: SystemCatalogJson;
  /** Batch 3: statement splitter (dialects without a case in split/splitter.ts; default: semicolons). */
  split?: DialectSplitter;
  /** Batch 3: formatter rules of a lazily loaded dialect (format/layout.ts `rulesFor`; default: the SQLite tables). */
  formatRules?: FormatRulesFactory;
  /**
   * Batch 3: statement classification override (split/classify.ts), called with the significant tokens and the index of
   * the head word; undefined falls through to the shared rules (e.g. MySQL `START TRANSACTION`, CQL `BEGIN BATCH`).
   */
  classify?: (toks: Token[], head: number) => StatementKind | undefined;
  /**
   * Batch 3: dialect-specific completion source (ClickHouse engines after `ENGINE =`, settings, formats …), run before the
   * editor's extra sources by the intel facade.
   */
  complete?: ExtraCompletionSource;
  /**
   * Batch 3: function and type names are case-sensitive (ClickHouse `toYYYYMM`, `UInt32`): completion inserts them as
   * the catalog spells them and Format SQL keeps the case the user typed, whatever the keyword/function case setting.
   */
  preserveNameCase?: boolean;
  /**
   * Batch 3: keywords the completer offers right after a word (or two words: `'SERIAL CONSISTENCY'`), e.g. CQL
   * `CONSISTENCY` → the levels; a `^` prefix only matches at the start of the statement. `@keyspace` / `@table`
   * entries list the schemas / tables instead.
   */
  keywordFollowers?: Record<string, string[]>;
}

export function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}
/** Comma-separated keyword phrases ("GROUP BY, ORDER BY"). */
export function phrases(s: string): string[] {
  return s.split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
}
export function wordSet(s: string): Set<string> {
  return new Set(words(s));
}

const COMMON_NOT_ALIAS = wordSet(`
  LEFT RIGHT FULL INNER OUTER CROSS JOIN NATURAL APPLY ON USING WHERE GROUP ORDER HAVING UNION EXCEPT INTERSECT MINUS
  LIMIT OFFSET FETCH WINDOW RETURNING CONNECT START PIVOT UNPIVOT SAMPLE PARTITION INDEXED NOT WITH SET VALUES OUTPUT
  OPTION FOR INTO WHEN THEN ELSE END LATERAL QUALIFY MODEL SELECT INSERT UPDATE DELETE MERGE FROM AS BY GO
  TABLESAMPLE STRAIGHT_JOIN
`);

/** Input of buildSpec (word lists are whitespace-separated strings, keyword phrases comma-separated). */
export interface SpecInit {
  id: Dialect;
  keywords: string;
  contextual: string;
  notAlias?: string;
  statementStarts: string;
  dataTypes: string;
  catalog: FunctionCatalogJson;
  quote: [string, string];
  caseFolding: CaseFolding;
  batchSeparator: 'go' | 'slash' | null;
  identExtra: string;
  snippets: SnippetDef[];
  selectKeywords: string;
  afterSourceKeywords: string;
  afterExprKeywords: string;
  startKeywords: string;
  ops2?: string[];
  ops3?: string[];
  lex?: LexTraits;
  lexHook?: LexHook;
  systemCatalog?: SystemCatalogJson;
  split?: DialectSplitter;
  formatRules?: FormatRulesFactory;
  classify?: (toks: Token[], head: number) => StatementKind | undefined;
  keywordFollowers?: Record<string, string[]>;
}

/** What dialect/registry.ts hands a lazily loaded dialect module (its `define` export). */
export interface DialectKit {
  buildSpec(init: SpecInit): DialectSpec;
  words(s: string): string[];
  phrases(s: string): string[];
  wordSet(s: string): Set<string>;
}

/** The export of a lazily loaded dialect module (dialect/<id>.ts): `export const define: DialectDefine = (kit) => …`. */
export type DialectDefine = (kit: DialectKit) => DialectSpec;

export function buildSpec(init: SpecInit): DialectSpec {
  const functions = init.catalog.functions ?? [];
  const functionMap = new Map<string, FunctionDef>();
  for (const f of functions) functionMap.set(f.name.toUpperCase(), f);
  const packages = init.catalog.packages ?? [];
  const packageMap = new Map<string, PackageDef>();
  for (const p of packages) packageMap.set(p.name.toUpperCase(), p);
  const notAlias = new Set(COMMON_NOT_ALIAS);
  for (const w of words(init.notAlias ?? '')) notAlias.add(w);
  const statementStarts = wordSet(init.statementStarts);
  for (const w of statementStarts) notAlias.add(w);
  const dataTypes = words(init.dataTypes);
  return {
    id: init.id,
    keywords: wordSet(init.keywords),
    contextualKeywords: wordSet(init.contextual),
    notAlias,
    statementStarts,
    dataTypes,
    dataTypeSet: new Set(dataTypes.map((t) => t.toUpperCase())),
    functions,
    functionMap,
    packages,
    packageMap,
    operators: init.catalog.operators ?? [],
    quote: init.quote,
    caseFolding: init.caseFolding,
    fold: (name: string, quoted: boolean) => foldName(name, quoted, init.caseFolding),
    batchSeparator: init.batchSeparator,
    identExtra: init.identExtra,
    snippets: init.snippets,
    selectKeywords: phrases(init.selectKeywords),
    afterSourceKeywords: phrases(init.afterSourceKeywords),
    afterExprKeywords: phrases(init.afterExprKeywords),
    startKeywords: phrases(init.startKeywords),
    ops2: init.ops2,
    ops3: init.ops3,
    lex: init.lex,
    lexHook: init.lexHook,
    systemCatalog: init.systemCatalog,
    split: init.split,
    formatRules: init.formatRules,
    classify: init.classify,
    keywordFollowers: init.keywordFollowers,
  };
}

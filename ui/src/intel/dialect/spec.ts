// Dialect tables shared by the lexer, splitter, parser and completer.
import type { Dialect } from '../types';

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

export function buildSpec(init: {
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
}): DialectSpec {
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
  };
}

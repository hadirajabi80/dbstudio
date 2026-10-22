// Public types of the Rowlit IntelliSense engine (pure TypeScript: no DOM, no React, no Monaco).
import type { CatalogObjectType, Dialect, ObjectRef, SqlBatch } from '../api/types';

export type { Dialect, ObjectRef, SqlBatch };

export type TokenKind =
  | 'ident' | 'quotedIdent' | 'keyword' | 'string' | 'number' | 'param'
  | 'op' | 'punct' | 'comment' | 'batchSep' | 'ws' | 'eof'
  /** Client meta-command line (psql `\dt`, `\c db`): the whole line, never SQL. */
  | 'meta';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Absolute document offsets, [start, end). */
  start: number;
  end: number;
  /** 1-based line/column of `start`. */
  line: number;
  col: number;
  /** Upper-cased text (precomputed for keyword matching). */
  upper: string;
  /** String/comment/quoted identifier without its closing delimiter. */
  unterminated?: boolean;
}

/** Base kinds; destructive statements get the `:destructive` suffix (DELETE/UPDATE without WHERE, DROP, TRUNCATE). */
export type StatementBaseKind =
  | 'select' | 'insert' | 'update' | 'delete' | 'merge' | 'truncate' | 'drop' | 'create' | 'alter'
  | 'exec' | 'block' | 'declare' | 'set' | 'use' | 'tx' | 'grant' | 'sqlplus' | 'psql' | 'pragma' | 'explain' | 'other' | 'empty';
export type StatementKind = StatementBaseKind | `${StatementBaseKind}:destructive`;

export interface StatementInfo {
  index: number;
  /** Absolute offsets of the statement text (first to last significant token; terminating `;` and `/` excluded). */
  start: number;
  end: number;
  text: string;
  /** 1-based position of `start` / `end`. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  kind: StatementKind;
  isPlsqlBlock: boolean;
  /** T-SQL: index of the GO-delimited batch. Other dialects: same as `index`. */
  batchIndex: number;
  /** Oracle SQL*Plus EXEC rewritten as an anonymous block; what gets sent instead of `text`. */
  execText?: string;
  /** Client command that is skipped on run (Oracle SQL*Plus, PostgreSQL psql `\…` lines). */
  skipOnRun?: boolean;
  /** Oracle block terminated by `END;` without a following `/` line. */
  missingSlash?: boolean;
}

export type CompletionKind =
  | 'table' | 'view' | 'column' | 'alias' | 'schema' | 'database' | 'cte' | 'function' | 'procedure'
  | 'package' | 'keyword' | 'snippet' | 'variable' | 'parameter' | 'sequence' | 'synonym' | 'type' | 'operator';

export interface TextEdit { range: [number, number]; text: string }

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  detail?: string;
  /** Short right-aligned text (column type; a routine's `schema · function`). */
  description?: string;
  /** Muted text right after the label (a routine's parameter list). */
  labelDetail?: string;
  /** A "Loading <schema>…" placeholder: its objects are on their way; the editor refreshes the list when they arrive. */
  loading?: boolean;
  documentation?: string;
  insertText: string;
  isSnippet?: boolean;
  sortText: string;
  filterText: string;
  /** Overrides the result's replaceRange (absolute offsets). */
  range?: [number, number];
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  /** After accepting: re-open suggestions (e.g. schema item inserting `schema.`) or signature help. */
  command?: 'retrigger' | 'signatureHelp';
  /** Total ranking score (higher = better). */
  score: number;
  /** Stable key for usage ranking (MRU). */
  usageKey?: string;
  /** Catalog object behind the item (lazy documentation, definition). */
  ref?: ObjectRef;
  deprecated?: boolean;
}

export interface CompletionResult {
  items: CompletionItem[];
  isIncomplete: boolean;
  /** Absolute offsets of the text the items replace (the typed prefix incl. an opening quote). */
  replaceRange: [number, number];
}

export interface HoverInfo { range: [number, number]; markdown: string }

export interface SignatureInfo {
  label: string;
  documentation?: string;
  parameters: { label: string; documentation?: string }[];
}
export interface SignatureHelpInfo {
  signatures: SignatureInfo[];
  activeSignature: number;
  activeParameter: number;
}

export type DefinitionResult =
  | { kind: 'local'; range: [number, number] }
  | { kind: 'object'; ref: ObjectRef; column?: string };

export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export interface Diagnostic {
  /** Absolute offsets. */
  start: number;
  end: number;
  /** 1-based positions. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
}

export interface IntelOptions {
  keywordCase: 'upper' | 'lower' | 'asIs';
  identifierCase: 'asIs' | 'lower' | 'upper' | 'matchPrefix';
  qualifyObjects: 'never' | 'nonDefaultSchema' | 'always';
  qualifyColumns: 'ambiguous' | 'always';
  blankLineSplitsStatements: boolean;
  runNextStatementOnBlank: boolean;
  /** Join alias generation: initials of camel/underscore words, or the first letter. */
  aliasStyle: 'initials' | 'firstLetter';
  /** Cap for SELECT-before-FROM column suggestions. */
  maxColumnsWithoutFrom: number;
}

export type { CatalogObjectType };

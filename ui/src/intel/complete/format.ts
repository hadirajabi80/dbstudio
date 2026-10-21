// Identifier quoting and case rules (PLAN 4.8).
import type { DialectSpec } from '../dialect/spec';
import type { IntelOptions } from '../types';

const TSQL_PLAIN = /^[\p{L}_#@][\p{L}\p{N}_$#@]*$/u;
const SQLITE_PLAIN = /^[\p{L}_][\p{L}\p{N}_$]*$/u;
const ORACLE_PLAIN = /^[A-Z][A-Z0-9_$#]*$/;
/** PostgreSQL: unquoted names fold to lower case, so a name with upper-case letters must be quoted. */
const PG_PLAIN = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

export function needsQuoting(name: string, spec: DialectSpec): boolean {
  if (!name) return true;
  if (spec.id === 'plsql') return !ORACLE_PLAIN.test(name) || spec.keywords.has(name);
  if (spec.id === 'pgsql') return !PG_PLAIN.test(name) || name !== name.toLowerCase() || spec.keywords.has(name.toUpperCase());
  const re = spec.id === 'tsql' ? TSQL_PLAIN : SQLITE_PLAIN;
  if (!re.test(name)) return true;
  return spec.keywords.has(name.toUpperCase());
}

export function quoteIdent(name: string, open: string): string {
  const close = open === '[' ? ']' : open;
  return open + name.split(close).join(close + close) + close;
}

export interface FormatEnv {
  spec: DialectSpec;
  opts: IntelOptions;
  /** Typed prefix (for matchPrefix case and quote reuse). */
  prefixText: string;
  prefixQuoted: '"' | '[' | '`' | null;
  closingQuoteAfter: boolean;
}

function applyCase(name: string, env: FormatEnv): string {
  // PostgreSQL: unquoted names are lower case already; upper-casing them would only obscure the catalog spelling
  if (env.spec.id === 'pgsql' && (env.opts.identifierCase === 'upper' || env.opts.identifierCase === 'matchPrefix')) return name;
  switch (env.opts.identifierCase) {
    case 'lower': return name.toLowerCase();
    case 'upper': return name.toUpperCase();
    case 'matchPrefix': {
      const p = env.prefixText.replace(/[^\p{L}]/gu, '');
      if (!p) return name;
      if (p === p.toLowerCase()) return name.toLowerCase();
      if (p === p.toUpperCase()) return name.toUpperCase();
      return name;
    }
    default: return name;
  }
}

/**
 * Identifier text to insert. The first part of an insertion reuses the opening quote the user typed
 * (`[Order` → `[Order Lines]`), and the closing quote is omitted when one already follows the cursor.
 */
export function formatIdent(name: string, env: FormatEnv, first = true): string {
  if (needsQuoting(name, env.spec)) {
    const open = first && env.prefixQuoted ? env.prefixQuoted : env.spec.quote[0];
    const q = quoteIdent(name, open);
    if (first && env.prefixQuoted && env.closingQuoteAfter) return q.slice(0, -1);
    return q;
  }
  // case folding is only safe where identifiers are case-insensitive, or for Oracle names that are upper case
  return applyCase(name, env);
}

/** `schema.name` qualified when required by the qualifyObjects setting. */
export function formatObjectName(schema: string | null, name: string, isDefaultSchema: boolean, env: FormatEnv): string {
  const q = env.opts.qualifyObjects;
  const qualify = schema && (q === 'always' || (q === 'nonDefaultSchema' && !isDefaultSchema));
  if (qualify) return formatIdent(schema!, env, true) + '.' + formatIdent(name, env, false);
  return formatIdent(name, env, true);
}

export function kwCase(word: string, opts: IntelOptions): string {
  return opts.keywordCase === 'lower' ? word.toLowerCase() : opts.keywordCase === 'upper' ? word.toUpperCase() : word;
}

/** Escape `$`, `}` and `\` for snippet syntax. */
export function snippetEscape(s: string): string {
  return s.replace(/[\\$}]/g, (m) => '\\' + m);
}

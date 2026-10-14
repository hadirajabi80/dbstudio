// Formatter options (persisted under Settings.format; type owned by api/types.ts) and their defaults.
// Pure TypeScript: no React, Monaco or DOM.
import type { CaseStyle, FormatOptions } from '../api/types';

export type { CaseStyle, FormatOptions };

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  keywordCase: 'upper',
  identifierCase: 'asIs',
  indent: 4,
  useTabs: false,
  commaStyle: 'trailing',
  lineWidth: 120,
  clauseKeywordsOnOwnLine: true,
  andOrOnNewLine: true,
  alignAliases: false,
  blankLineBetweenStatements: 1,
  maxConsecutiveBlankLines: 1,
  functionCase: 'upper',
  datatypeCase: 'upper',
  formatDdlOnOpen: true,
};

const CASES: CaseStyle[] = ['upper', 'lower', 'asIs'];

function int(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
  return Math.max(min, Math.min(max, n));
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}
function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

/** Defaults merged with a (possibly partial or malformed) user object; every value is validated and clamped. */
export function resolveFormatOptions(o?: Partial<FormatOptions> | null): FormatOptions {
  const d = DEFAULT_FORMAT_OPTIONS;
  const p = (o ?? {}) as Partial<Record<keyof FormatOptions, unknown>>;
  return {
    keywordCase: oneOf(p.keywordCase, CASES, d.keywordCase),
    identifierCase: oneOf(p.identifierCase, CASES, d.identifierCase),
    indent: int(p.indent, d.indent, 1, 8),
    useTabs: bool(p.useTabs, d.useTabs),
    commaStyle: oneOf(p.commaStyle, ['trailing', 'leading'] as const, d.commaStyle),
    lineWidth: int(p.lineWidth, d.lineWidth, 40, 400),
    clauseKeywordsOnOwnLine: bool(p.clauseKeywordsOnOwnLine, d.clauseKeywordsOnOwnLine),
    andOrOnNewLine: bool(p.andOrOnNewLine, d.andOrOnNewLine),
    alignAliases: bool(p.alignAliases, d.alignAliases),
    blankLineBetweenStatements: int(p.blankLineBetweenStatements, d.blankLineBetweenStatements, 0, 3),
    maxConsecutiveBlankLines: int(p.maxConsecutiveBlankLines, d.maxConsecutiveBlankLines, 0, 5),
    functionCase: oneOf(p.functionCase, CASES, d.functionCase),
    datatypeCase: oneOf(p.datatypeCase, CASES, d.datatypeCase),
    formatDdlOnOpen: bool(p.formatDdlOnOpen, d.formatDdlOnOpen),
  };
}

export function applyCase(text: string, style: CaseStyle): string {
  return style === 'upper' ? text.toUpperCase() : style === 'lower' ? text.toLowerCase() : text;
}

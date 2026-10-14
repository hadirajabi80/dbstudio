// Public API of the SQL formatter (PLAN-M1.5 1.2). One token-based formatter for T-SQL, PL/SQL and SQLite over
// the intel lexer. Pure TypeScript: no React, Monaco or DOM.
//
// Safety: the document is cut into top-level chunks (statements with their terminators, GO / `/` lines). Each chunk
// is laid out and then re-lexed; unless the token sequence is identical (letter case of words aside) and every
// comment is unchanged, the chunk is emitted verbatim and a warning is returned. Chunks with unterminated strings,
// comments or quoted identifiers, unbalanced parentheses or unclosed blocks are emitted verbatim as well.
import type { Dialect, Token } from '../intel/types';
import { getSpec } from '../intel/dialect';
import { tokenize } from '../intel/lexer/lexer';
import { splitStatements } from '../intel/split/splitter';
import { countNewlines, prepareTokens } from './comments';
import { Layout } from './layout';
import { applyCase, resolveFormatOptions, type FormatOptions } from './options';

export { DEFAULT_FORMAT_OPTIONS, resolveFormatOptions, applyCase } from './options';
export type { FormatOptions, CaseStyle } from './options';

export interface FormatWarning {
  /** 1-based line of the chunk in the input. */
  line: number;
  message: string;
}

export interface FormatResult {
  text: string;
  warnings: FormatWarning[];
  /** Start offsets of every input token (comments included) and of the same token in the output. */
  mapping: { from: number[]; to: number[] };
}

interface Chunk {
  /** Token index range [a, b) in the document tokens. */
  a: number;
  b: number;
  sep: boolean;
  /** T-SQL batch chunk: its statements, formatted one by one when the batch as a whole cannot be laid out. */
  sub?: Chunk[];
}

/**
 * T-SQL statements need no `;`, so the splitter starts a statement at a statement keyword that begins a line; the
 * layout puts keywords at line starts, so splitting the output again could differ. A GO batch is therefore one
 * chunk, and the layout engine finds the statements inside it.
 */
function batchChunks(chunks: Chunk[]): Chunk[] {
  const out: Chunk[] = [];
  let run: Chunk[] = [];
  const flush = () => {
    if (run.length) out.push({ a: run[0].a, b: run[run.length - 1].b, sep: false, sub: run });
    run = [];
  };
  for (const c of chunks) {
    if (c.sep) { flush(); out.push(c); } else run.push(c);
  }
  flush();
  return out;
}

function chunksOf(tokens: Token[], text: string, dialect: Dialect): Chunk[] {
  const spec = getSpec(dialect);
  const split = splitStatements(tokens, text, spec, { blankLineSplitsStatements: false });
  const n = tokens.length - 1; // eof excluded
  const ends: number[] = []; // exclusive token index where a chunk ends (statements)
  for (const st of split.statements) ends.push(st.tokEnd);
  const chunks: Chunk[] = [];
  let a = 0;
  let si = 0;
  let i = 0;
  while (i < n) {
    const t = tokens[i];
    if (t.kind === 'batchSep') {
      if (i > a) chunks.push({ a, b: i, sep: false });
      chunks.push({ a: i, b: i + 1, sep: true });
      i++;
      a = i;
      // trailing comments on the GO line belong to the separator chunk
      while (a < n && tokens[a].kind === 'comment' && countNewlines(text, tokens[a - 1].end, tokens[a].start) === 0) { a++; chunks[chunks.length - 1].b = a; }
      i = a;
      while (si < ends.length && ends[si] <= i) si++;
      continue;
    }
    while (si < ends.length && ends[si] <= i) si++;
    if (si < ends.length && ends[si] - 1 === i && t.kind !== 'comment') {
      // last token of a statement: extend over `;` and same-line comments
      let b = i + 1;
      for (;;) {
        while (b < n && tokens[b].kind === 'punct' && tokens[b].text === ';') b++;
        if (b < n && tokens[b].kind === 'comment' && countNewlines(text, tokens[b - 1].end, tokens[b].start) === 0) { b++; continue; }
        break;
      }
      chunks.push({ a, b, sep: false });
      a = b;
      i = b;
      si++;
      continue;
    }
    i++;
  }
  if (a < n) chunks.push({ a, b: n, sep: false });
  return chunks;
}

function sameTokens(a: Token[], b: Token[]): boolean {
  const x = a.filter((t) => t.kind !== 'eof'), y = b.filter((t) => t.kind !== 'eof');
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i], q = y[i];
    if (p.kind !== q.kind) return false;
    if (p.kind === 'keyword' || p.kind === 'ident' || p.kind === 'batchSep' || p.kind === 'op') {
      if (p.upper !== q.upper) return false;
    } else if (p.text !== q.text) return false;
  }
  return true;
}

function eolOf(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

/** Format a whole document. */
export function formatSql(text: string, dialect: Dialect, options?: Partial<FormatOptions> | null): FormatResult {
  const opts = resolveFormatOptions(options);
  const spec = getSpec(dialect);
  const eol = eolOf(text);
  const tokens = tokenize(text, spec);
  const all = chunksOf(tokens, text, dialect);
  const chunks = dialect === 'tsql' ? batchChunks(all) : all;
  const warnings: FormatWarning[] = [];
  const parts: string[] = [];
  const st = { prevMulti: false, prevSep: false, prevEnd: -1 };
  const emit = (c: Chunk, out: string) => {
    const first = tokens[c.a];
    if (st.prevEnd >= 0) {
      const nl = countNewlines(text, st.prevEnd, first.start);
      let blanks = Math.min(Math.max(0, nl - 1), opts.maxConsecutiveBlankLines);
      if (c.sep) blanks = 0;
      else if (st.prevSep || st.prevMulti) blanks = Math.max(blanks, opts.blankLineBetweenStatements);
      parts.push(eol.repeat(blanks + 1));
    }
    parts.push(out);
    st.prevMulti = out.indexOf('\n') >= 0;
    st.prevSep = c.sep;
    st.prevEnd = tokens[c.b - 1].end;
  };
  const layout = (c: Chunk): { out: string; problem: string | null } => {
    const src = text.slice(tokens[c.a].start, tokens[c.b - 1].end);
    if (tokens.slice(c.a, c.b).some((t) => t.unterminated)) return { out: src, problem: 'unterminated string, comment or identifier' };
    const r = new Layout(prepareTokens(tokens, text, c.a, c.b), spec, opts, eol).setSource(text).run();
    if (r.problem) return { out: src, problem: r.problem };
    if (!sameTokens(tokenize(r.text, spec), tokens.slice(c.a, c.b))) return { out: src, problem: 'layout check failed' };
    return { out: r.text, problem: null };
  };
  for (const c of chunks) {
    if (c.sep) {
      emit(c, tokens.slice(c.a, c.b).map((t, i) => (i === 0 ? applyCase(t.text, opts.keywordCase) : ' ' + t.text)).join(''));
      continue;
    }
    const r = layout(c);
    if (!r.problem || !c.sub || c.sub.length < 2) {
      if (r.problem) warnings.push({ line: tokens[c.a].line, message: `Statement at line ${tokens[c.a].line} left unformatted: ${r.problem}.` });
      emit(c, r.out);
      continue;
    }
    for (const s2 of c.sub) {
      const r2 = layout(s2);
      if (r2.problem) warnings.push({ line: tokens[s2.a].line, message: `Statement at line ${tokens[s2.a].line} left unformatted: ${r2.problem}.` });
      emit(s2, r2.out);
    }
  }
  let result = parts.join('');
  if (result && /\r?\n[ \t]*$/.test(text) && !/\n$/.test(result)) result += eol;
  // the token mapping (cursor preservation) costs one more lexer pass: computed on first use
  let mapping: FormatResult['mapping'] | null = null;
  return {
    text: result,
    warnings,
    get mapping() {
      return (mapping ??= mapTokens(tokens, tokenize(result, spec)));
    },
  };
}

function mapTokens(a: Token[], b: Token[]): { from: number[]; to: number[] } {
  const from: number[] = [], to: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].kind === 'eof') break;
    from.push(a[i].start);
    to.push(b[i].start);
  }
  return { from, to };
}

/** Map an offset in the input to the corresponding offset in the formatted text (cursor preservation). */
export function mapOffset(r: FormatResult, offset: number): number {
  const { from, to } = r.mapping;
  if (!from.length) return Math.min(offset, r.text.length);
  let lo = 0, hi = from.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (from[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  if (from[lo] > offset) return to[0];
  return Math.min(to[lo] + (offset - from[lo]), lo + 1 < to.length ? to[lo + 1] : r.text.length);
}

export interface RangeFormatResult extends FormatResult {
  /** Document offsets [start, end) replaced by `text`. */
  range: [number, number];
}

/**
 * Format only the top-level statements that intersect [start, end). Returns null when the range touches no statement.
 * The replaced range starts at the first statement's line start when only whitespace precedes it on that line, so
 * its indentation is re-applied to every output line.
 */
export function formatRange(text: string, dialect: Dialect, range: [number, number], options?: Partial<FormatOptions> | null): RangeFormatResult | null {
  const spec = getSpec(dialect);
  const tokens = tokenize(text, spec);
  const chunks = chunksOf(tokens, text, dialect);
  const [s0, e0] = range[0] <= range[1] ? range : [range[1], range[0]];
  const hit = chunks.filter((c) => {
    const a = tokens[c.a].start, b = tokens[c.b - 1].end;
    return e0 > s0 ? a < e0 && b > s0 : a <= s0 && s0 <= b;
  });
  if (!hit.length) return null;
  const start = tokens[hit[0].a].start;
  const end = tokens[hit[hit.length - 1].b - 1].end;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lead = text.slice(lineStart, start);
  const indented = /^[ \t]+$/.test(lead);
  const r = formatSql(text.slice(start, end), dialect, options);
  let out = r.text.replace(/\r?\n$/, '');
  if (indented) out = lead + out.split(/(\r?\n)/).map((seg, i, arr) => (i > 0 && arr[i - 1].endsWith('\n') && seg && i % 2 === 0 ? lead + seg : seg)).join('');
  const base = indented ? lineStart : start;
  const m = mapTokens(tokenize(text.slice(start, end), spec), tokenize(out, spec));
  return {
    text: out,
    warnings: r.warnings,
    mapping: { from: m.from.map((x) => x + start), to: m.to.map((x) => x + base) },
    range: [base, end],
  };
}

/** Format a stored object's DDL (Object tab "Formatted" toggle). Falls back to the input when nothing changes safely. */
export function formatDdl(text: string, dialect: Dialect, options?: Partial<FormatOptions> | null): string {
  return formatSql(text, dialect, options).text;
}

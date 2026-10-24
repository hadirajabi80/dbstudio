// Public API of the SQL formatter (PLAN-M1.5 1.2). One token-based formatter for T-SQL, PL/SQL, SQLite and PostgreSQL over
// the intel lexer. Pure TypeScript: no React, Monaco or DOM.
//
// Safety: the document is cut into top-level chunks (statements with their terminators, GO / `/` lines). Each chunk
// is laid out and then re-lexed; unless the token sequence is identical (letter case of words aside, a `;` may move
// before the comments right in front of it, block comment continuation lines may be re-indented) and every comment
// is otherwise unchanged, the chunk is emitted verbatim and a warning is returned. Chunks with unterminated strings,
// comments or quoted identifiers, unbalanced parentheses, CASE without END or unclosed blocks are emitted verbatim
// as well, but only up to the next statement the formatter can resynchronise on (a `;` or a statement keyword
// starting a line outside the statement's open parentheses, never inside a routine body), so one broken statement
// does not leave the rest of the document unformatted.
import type { Dialect, Token } from '../intel/types';
import { getSpec } from '../intel/dialect';
import { tokenize } from '../intel/lexer/lexer';
import { splitStatements } from '../intel/split/splitter';
import { countNewlines, prepareTokens } from './comments';
import { Layout, rulesFor } from './layout';
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
  const starts = split.statements.map((st) => st.tokStart);
  const chunks: Chunk[] = [];
  let a = 0;
  let si = 0;
  let i = 0;
  while (i < n) {
    const t = tokens[i];
    // GO / `/` lines, and MySQL `DELIMITER xx` lines (meta tokens that are no statement): separator chunks
    if (t.kind === 'batchSep' || (t.kind === 'meta' && dialect === 'mysql')) {
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
        // MySQL: a custom delimiter (`$$`, `//` …) or `\G` right after the statement, before the next one, stays with it
        while (dialect === 'mysql' && b < n && tokens[b].kind !== 'comment' && tokens[b].kind !== 'meta' && (si + 1 >= starts.length || b < starts[si + 1])
          && countNewlines(text, tokens[b - 1].end, tokens[b].start) === 0) b++;
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


/**
 * Tokens in the order the safety check compares them: `eof` dropped and every `;` moved before the comments right in
 * front of it (the layout writes `t; -- note` for `t -- note⏎;`).
 */
export function canonicalTokens(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    if (t.kind === 'eof') continue;
    if (t.kind === 'punct' && t.text === ';') {
      let i = out.length;
      while (i > 0 && out[i - 1].kind === 'comment') i--;
      if (i > 0 && i < out.length) {
        out.splice(i, 0, t);
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/** Comment text as compared by the safety check: block comment continuation lines without their indentation. */
export function commentKey(text: string): string {
  return text.indexOf('\n') < 0 ? text : text.split('\n').map((l, i) => (i ? l.replace(/^[ \t]+/, '') : l)).join('\n');
}

function sameTokens(a: Token[], b: Token[]): boolean {
  const x = canonicalTokens(a), y = canonicalTokens(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i], q = y[i];
    if (p.kind !== q.kind) return false;
    if (p.kind === 'keyword' || p.kind === 'ident' || p.kind === 'batchSep' || p.kind === 'op') {
      if (p.upper !== q.upper) return false;
    } else if (p.kind === 'comment') {
      if (commentKey(p.text) !== commentKey(q.text)) return false;
    } else if (p.text !== q.text) return false;
  }
  return true;
}

const ROUTINE_KINDS = new Set(['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'PACKAGE', 'TYPE']);
/** T-SQL ALTER statements that restate a whole routine definition (header and body). */
const TSQL_ALTER_ROUTINE_KINDS = new Set(['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER']);
const ROUTINE_MODIFIERS =new Set(['OR', 'ALTER', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'TEMP', 'TEMPORARY', 'DEFINER', 'NO', 'FORCE']);
/** `END IF`, `END LOOP` … close a PL/SQL control structure that was not opened by BEGIN/CASE. */
const END_SUFFIX_NOT_BLOCK = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT']);

const word = (t: Token | undefined): string | null => (t && (t.kind === 'keyword' || t.kind === 'ident') ? t.upper : null);

/**
 * Context of every token of a chunk (index i - c.a): `nested` inside parentheses opened in the chunk, `body` inside
 * the body of a routine the chunk creates (CREATE [OR ALTER | OR REPLACE] PROCEDURE | FUNCTION | TRIGGER | PACKAGE |
 * TYPE BODY, or T-SQL ALTER PROCEDURE | FUNCTION | TRIGGER … after its AS / IS / BEGIN). T-SQL routine bodies run to the end of the batch; PL/SQL and SQLite bodies
 * end at the END that closes their outermost block.
 */
function tokenContext(tokens: Token[], c: Chunk, dialect: Dialect): { nested: boolean[]; body: boolean[] } {
  const nested: boolean[] = [];
  const body: boolean[] = [];
  let depth = 0;
  /** 0 = no routine, 1 = routine header seen (waiting for AS/IS/BEGIN), 2 = in its body. */
  let routine = 0;
  let blocks = 0;
  let opened = false;
  let skipNext = false;
  const next = (i: number): Token | undefined => {
    for (let k = i + 1; k < c.b; k++) if (tokens[k].kind !== 'comment') return tokens[k];
    return undefined;
  };
  for (let i = c.a; i < c.b; i++) {
    const t = tokens[i];
    nested.push(depth > 0);
    // The header (CREATE … up to AS/IS/BEGIN) is part of the routine too: a cut there would split its definition.
    body.push(routine !== 0);
    if (t.kind === 'comment') continue;
    if (t.kind === 'punct' && t.text === '(') { depth++; continue; }
    if (t.kind === 'punct' && t.text === ')') { depth--; continue; }
    const w = word(t);
    if (!w || depth > 0) continue;
    if (skipNext) { skipNext = false; continue; }
    if (routine === 0 && w === 'ALTER' && dialect === 'tsql') {
      // T-SQL ALTER PROCEDURE | PROC | FUNCTION | TRIGGER restates the whole routine ("Script as ALTER" / "Modify"),
      // so its body is guarded like a CREATE's. (A PL/SQL ALTER … COMPILE has no body.)
      const kind = word(next(i));
      if (kind && TSQL_ALTER_ROUTINE_KINDS.has(kind)) routine = 1;
      continue;
    }
    if (routine === 0 && w === 'CREATE') {
      // CREATE [OR ALTER | OR REPLACE] [EDITIONABLE …] PROCEDURE | FUNCTION | TRIGGER | PACKAGE [BODY] | TYPE BODY
      let k = i + 1;
      while (k < c.b && (tokens[k].kind === 'comment' || ROUTINE_MODIFIERS.has(word(tokens[k]) ?? ''))) k++;
      const kind = word(tokens[k]);
      if (kind && ROUTINE_KINDS.has(kind) && (kind !== 'TYPE' || word(next(k)) === 'BODY')) routine = 1;
      continue;
    }
    if (routine === 1 && (w === 'AS' || w === 'IS' || w === 'BEGIN')) {
      routine = 2;
      // A package (spec or body) is closed by its own END; a procedure by the END of its BEGIN block.
      opened = w === 'BEGIN';
      blocks = w === 'BEGIN' ? 1 : 0;
      continue;
    }
    if (routine !== 2 || dialect === 'tsql') continue;
    if (w === 'BEGIN' || w === 'CASE') {
      blocks++;
      opened = true;
    } else if (w === 'END') {
      const after = word(next(i));
      if (after && END_SUFFIX_NOT_BLOCK.has(after)) { skipNext = true; continue; }
      if (after === 'CASE') skipNext = true; // END CASE closes one CASE
      blocks--;
      if (opened && blocks <= 0) routine = 0;
    }
  }
  return { nested, body };
}

/**
 * Where a chunk the layout could not handle may be cut so the rest is formatted on its own: after a `;`, or before a
 * statement keyword at the start of a line (with the comments on the lines just above it). The piece after the cut
 * must start with a statement keyword that is either on the `;`'s line or in column 1, so the indented statements of
 * a broken block are not pulled out of it. A line-start keyword only counts outside the parentheses opened in the
 * chunk, and nothing inside a routine body is a cut point: an unbalanced subquery or a broken statement of a
 * procedure keeps the whole statement verbatim up to the next top-level `;` (or the batch end). Returns the token
 * index of the cut, or null.
 */
function resyncPoint(tokens: Token[], text: string, c: Chunk, dialect: Dialect): number | null {
  const starts = rulesFor(getSpec(dialect)).statementStarts;
  const isStart = (t: Token | undefined) => !!t && (t.kind === 'keyword' || t.kind === 'ident') && starts.has(t.upper);
  const ctx = tokenContext(tokens, c, dialect);
  for (let j = c.a + 1; j < c.b; j++) {
    const prev = tokens[j - 1], t = tokens[j];
    if (ctx.body[j - c.a]) continue;
    if (prev.kind === 'punct' && prev.text === ';') {
      let k = j;
      while (k < c.b && tokens[k].kind === 'comment' && countNewlines(text, tokens[k - 1].end, tokens[k].start) === 0) k++;
      if (k >= c.b) return null;
      let s = k;
      while (s < c.b && tokens[s].kind === 'comment') s++;
      const first = tokens[s];
      if (isStart(first) && (countNewlines(text, prev.end, first.start) === 0 || first.col === 1)) return k;
      continue;
    }
    if (t.kind === 'comment' || ctx.nested[j - c.a] || !isStart(t) || t.col !== 1 || countNewlines(text, prev.end, t.start) === 0) continue;
    let k = j;
    while (k - 1 > c.a && tokens[k - 1].kind === 'comment' && countNewlines(text, tokens[k - 2].end, tokens[k - 1].start) > 0) k--;
    return k;
  }
  return null;
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
  const warn = (c: Chunk, problem: string) => warnings.push({ line: tokens[c.a].line, message: `Statement at line ${tokens[c.a].line} left unformatted: ${problem}.` });
  /** Lay out a chunk; when it fails, keep the broken statement verbatim and resynchronise on what follows it. */
  const format = (c: Chunk): void => {
    const r = layout(c);
    if (!r.problem) {
      emit(c, r.out);
      return;
    }
    if (c.sub && c.sub.length >= 2) {
      for (const s2 of c.sub) format(s2);
      return;
    }
    const cut = resyncPoint(tokens, text, c, dialect);
    if (cut === null) {
      warn(c, r.problem);
      emit(c, r.out);
      return;
    }
    const head: Chunk = { a: c.a, b: cut, sep: false };
    const h = layout(head);
    if (h.problem) warn(head, h.problem);
    emit(head, h.out);
    format({ a: cut, b: c.b, sep: false });
  };
  for (const c of chunks) {
    if (c.sep) {
      emit(c, tokens[c.a].kind === 'meta'
        ? text.slice(tokens[c.a].start, tokens[c.b - 1].end) // DELIMITER lines verbatim (the delimiter is case-sensitive)
        : tokens.slice(c.a, c.b).map((t, i) => (i === 0 ? applyCase(t.text, opts.keywordCase) : ' ' + t.text)).join(''));
      continue;
    }
    format(c);
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
  // Pair tokens in compare order (a `;` may have moved before a comment), then sort by input offset.
  const x = canonicalTokens(a), y = canonicalTokens(b);
  const n = Math.min(x.length, y.length);
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) pairs.push([x[i].start, y[i].start]);
  pairs.sort((p, q) => p[0] - q[0]);
  return { from: pairs.map((p) => p[0]), to: pairs.map((p) => p[1]) };
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

// Dialect-aware SQL lexer. One engine, dialect tables from DialectSpec.
// - Whole-document mode: `tokenize(text, spec)` (multi-line strings/comments are single tokens).
// - Line mode for Monaco: `lexLine(line, spec, state)` resumes inside a multi-line construct.
// - Incremental mode: `relex(prev, newText, edit)` re-lexes only around the edit and resynchronises.
import type { Token, TokenKind } from '../types';
import type { DialectSpec } from '../dialect/spec';

/**
 * Lexer state between lines ('' = normal). Encoded as a string so Monaco can compare states cheaply.
 * `c<depth>` block comment, `s` single-quoted string, `q<closer>` Oracle q-quote, `e` PostgreSQL E-string,
 * `d<tag>` PostgreSQL dollar-quoted body (`d` alone for `$$`).
 */
export type LexState = string;

const CH_NL = 10, CH_CR = 13, CH_SP = 32, CH_TAB = 9;

const UNI_IDENT_START = /[\p{L}\p{Nl}]/u;
const UNI_IDENT_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]/u;

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isWs(c: number): boolean {
  return c === CH_SP || c === CH_TAB || c === CH_NL || c === CH_CR || c === 12 || c === 11 || c === 0xa0 || c === 0xfeff;
}

const Q_CLOSERS: Record<string, string> = { '[': ']', '{': '}', '<': '>', '(': ')' };

const ORACLE_ATTRS = new Set(['TYPE', 'ROWTYPE', 'FOUND', 'NOTFOUND', 'ROWCOUNT', 'ISOPEN', 'BULK_ROWCOUNT', 'BULK_EXCEPTIONS']);

const OPS3: Record<string, string[]> = {
  tsql: [],
  plsql: [],
  sqlite: ['->>'],
  pgsql: ['->>', '#>>', '!~*', '||/', '<->', '<<=', '>>=', '-|-', '@@@'],
};
const OPS2_COMMON = ['<>', '!=', '<=', '>=', '||', '::'];
const OPS2: Record<string, string[]> = {
  tsql: [...OPS2_COMMON, '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '!<', '!>', '<<', '>>'],
  plsql: [...OPS2_COMMON, ':=', '=>', '**', '..', '<<', '>>'],
  sqlite: [...OPS2_COMMON, '->', '==', '<<', '>>'],
  pgsql: [...OPS2_COMMON, '->', '#>', '@>', '<@', '?|', '?&', '#-', '~*', '!~', '@@', '@?', '&&', '<<', '>>', '|/', ':=', '=>', '..', '&<', '&>'],
};

/** Dollar-quote tag characters (`$tag$`): letters, digits (not first) and `_`; never `$`. */
const DOLLAR_TAG = /\$([\p{L}_][\p{L}\p{N}_]*)?\$/uy;

export class Lexer {
  private readonly text: string;
  private readonly spec: DialectSpec;
  private readonly isTsql: boolean;
  private readonly isOracle: boolean;
  private readonly isSqlite: boolean;
  private readonly isPg: boolean;
  private readonly ops2: string[];
  private readonly ops3: string[];
  pos: number;
  line: number;
  lineStart: number;
  /** True when only whitespace has been seen since the last newline. */
  atLineStart: boolean;
  /** Continuation state when the text ends inside a construct (line mode). */
  endState: LexState = '';

  constructor(text: string, spec: DialectSpec, pos = 0, line = 1, lineStart = 0, atLineStart = true) {
    this.text = text;
    this.spec = spec;
    this.isTsql = spec.id === 'tsql';
    this.isOracle = spec.id === 'plsql';
    this.isSqlite = spec.id === 'sqlite';
    this.isPg = spec.id === 'pgsql';
    this.ops2 = OPS2[spec.id];
    this.ops3 = OPS3[spec.id];
    this.pos = pos;
    this.line = line;
    this.lineStart = lineStart;
    this.atLineStart = atLineStart;
  }

  private isIdentStart(c: number): boolean {
    if (isAsciiLetter(c) || c === 95) return true;
    if (!(c >= 128)) return false; // also NaN (past the end)
    return UNI_IDENT_START.test(String.fromCodePoint(c));
  }
  private isIdentPart(c: number): boolean {
    if (isAsciiLetter(c) || isDigit(c) || c === 95) return true;
    if (Number.isNaN(c)) return false;
    if (c < 128) return this.spec.identExtra.indexOf(String.fromCharCode(c)) >= 0;
    return UNI_IDENT_PART.test(String.fromCodePoint(c));
  }

  /** Skip whitespace, tracking lines. */
  private skipWs(): void {
    const t = this.text;
    const n = t.length;
    let p = this.pos;
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === CH_NL) {
        p++;
        this.line++;
        this.lineStart = p;
        this.atLineStart = true;
      } else if (isWs(c)) {
        p++;
      } else break;
    }
    this.pos = p;
  }

  private make(kind: TokenKind, start: number, end: number, upper?: string, unterminated?: boolean): Token {
    const text = this.text.slice(start, end);
    const tok: Token = {
      kind, text, start, end, line: this.line, col: start - this.lineStart + 1,
      upper: upper ?? (kind === 'ident' || kind === 'keyword' || kind === 'batchSep' ? text.toUpperCase() : text),
    };
    if (unterminated) tok.unterminated = true;
    return tok;
  }

  /** Advance line counters over [from, to). */
  private countLines(from: number, to: number): void {
    const t = this.text;
    let i = t.indexOf('\n', from);
    while (i >= 0 && i < to) {
      this.line++;
      this.lineStart = i + 1;
      i = t.indexOf('\n', i + 1);
    }
  }

  /** Emit a token that may span lines: line/col are computed for its start, then counters advance. */
  private multi(kind: TokenKind, start: number, end: number, unterminated?: boolean): Token {
    const tok = this.make(kind, start, end, undefined, unterminated);
    this.countLines(start, end);
    this.pos = end;
    return tok;
  }

  /** Scan a block comment starting after `/*` at p. Returns [end, depthLeft]. */
  private scanBlockComment(p: number, depth: number): [number, number] {
    const t = this.text;
    const n = t.length;
    const nested = this.isTsql || this.isPg;
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === 42 /* * */ && t.charCodeAt(p + 1) === 47 /* / */) {
        p += 2;
        depth--;
        if (depth === 0) return [p, 0];
      } else if (nested && c === 47 && t.charCodeAt(p + 1) === 42) {
        p += 2;
        depth++;
      } else p++;
    }
    return [n, depth];
  }

  /** Scan a quoted string body after the opening quote. Returns [end, terminated]. */
  private scanString(p: number, q: number): [number, boolean] {
    const t = this.text;
    const n = t.length;
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === q) {
        if (t.charCodeAt(p + 1) === q) { p += 2; continue; }
        return [p + 1, true];
      }
      p++;
    }
    return [n, false];
  }

  /** PostgreSQL E'…' body after the quote: a backslash escapes the next character, `''` is a quote. */
  private scanEString(p: number): [number, boolean] {
    const t = this.text;
    const n = t.length;
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === 92 /* \ */) { p += 2; continue; }
      if (c === 39) {
        if (t.charCodeAt(p + 1) === 39) { p += 2; continue; }
        return [p + 1, true];
      }
      p++;
    }
    return [n, false];
  }

  /** PostgreSQL dollar-quoted body after the opening `$tag$`: ends after the matching `$tag$`. */
  private scanDollar(p: number, tag: string): [number, boolean] {
    const closer = '$' + tag + '$';
    const i = this.text.indexOf(closer, p);
    return i < 0 ? [this.text.length, false] : [i + closer.length, true];
  }

  /** Oracle q'X...X' body after the delimiter char. */
  private scanQQuote(p: number, closer: string): [number, boolean] {
    const t = this.text;
    const n = t.length;
    while (p < n) {
      if (t[p] === closer && t.charCodeAt(p + 1) === 39) return [p + 2, true];
      p++;
    }
    return [n, false];
  }

  /** Quoted identifier: never spans lines (an unterminated one ends at end of line). */
  private scanQuotedIdent(p: number, close: number, doubled: boolean): [number, boolean] {
    const t = this.text;
    const n = t.length;
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === close) {
        if (doubled && t.charCodeAt(p + 1) === close) { p += 2; continue; }
        return [p + 1, true];
      }
      if (c === CH_NL || c === CH_CR) return [p, false];
      p++;
    }
    return [n, false];
  }

  /** Resume inside a construct left open by a previous line (line mode). */
  resume(state: LexState): Token | null {
    if (!state) return null;
    const start = this.pos;
    if (state[0] === 'c') {
      const [end, depth] = this.scanBlockComment(start, Number(state.slice(1)) || 1);
      this.endState = depth > 0 ? 'c' + depth : '';
      return this.multi('comment', start, end, depth > 0);
    }
    if (state === 's') {
      const [end, ok] = this.scanString(start, 39);
      this.endState = ok ? '' : 's';
      return this.multi('string', start, end, !ok);
    }
    if (state[0] === 'q') {
      const [end, ok] = this.scanQQuote(start, state.slice(1));
      this.endState = ok ? '' : state;
      return this.multi('string', start, end, !ok);
    }
    if (state === 'e') {
      const [end, ok] = this.scanEString(start);
      this.endState = ok ? '' : 'e';
      return this.multi('string', start, end, !ok);
    }
    if (state[0] === 'd') {
      const [end, ok] = this.scanDollar(start, state.slice(1));
      this.endState = ok ? '' : state;
      return this.multi('string', start, end, !ok);
    }
    return null;
  }

  /** An operator ending at `end` would swallow the start of a comment (`||` + block comment, `#-` + `-`). */
  private opEndsInComment(end: number): boolean {
    const a = this.text.charCodeAt(end - 1), b = this.text.charCodeAt(end);
    return (a === 47 && b === 42) || (a === 45 && b === 45);
  }

  /**
   * PostgreSQL-only tokens: psql meta-command lines, E'…' / U&'…' / B'…' / X'…' / N'…' strings, U&"…" identifiers,
   * `$1` parameters, `$tag$…$tag$` dollar quoting, numbers (0x1F, 0o17, 0b101, 1_000), `:name` / `@name` parameters.
   * Returns null when the character starts an ordinary token.
   */
  private nextPg(start: number, c: number, c1: number, wasLineStart: boolean): Token | null {
    const t = this.text;
    const n = t.length;
    if (c === 92 /* \ */ && wasLineStart) {
      let e = t.indexOf('\n', start);
      if (e < 0) e = n;
      if (e > start && t.charCodeAt(e - 1) === CH_CR) e--;
      this.pos = e;
      return this.make('meta', start, e);
    }
    if (c1 === 39) {
      const lc = c | 0x20;
      if (lc === 101 /* e */) {
        const [end, ok] = this.scanEString(start + 2);
        this.endState = ok ? '' : 'e';
        return this.multi('string', start, end, !ok);
      }
      if (lc === 98 /* b */ || lc === 120 /* x */ || lc === 110 /* n */) {
        const [end, ok] = this.scanString(start + 2, 39);
        this.endState = ok ? '' : 's';
        return this.multi('string', start, end, !ok);
      }
    }
    if ((c === 85 || c === 117) && c1 === 38 /* & */) {
      const c2 = t.charCodeAt(start + 2);
      if (c2 === 39) {
        const [end, ok] = this.scanString(start + 3, 39);
        this.endState = ok ? '' : 's';
        return this.multi('string', start, end, !ok);
      }
      if (c2 === 34) {
        const [end, ok] = this.scanQuotedIdent(start + 3, 34, true);
        this.pos = end;
        return this.make('quotedIdent', start, end, undefined, !ok);
      }
    }
    if (c === 36 /* $ */) {
      if (isDigit(c1)) {
        let p = start + 1;
        while (p < n && isDigit(t.charCodeAt(p))) p++;
        this.pos = p;
        return this.make('param', start, p);
      }
      DOLLAR_TAG.lastIndex = start;
      const m = DOLLAR_TAG.exec(t);
      if (m) {
        const tag = m[1] ?? '';
        const [end, ok] = this.scanDollar(start + m[0].length, tag);
        this.endState = ok ? '' : 'd' + tag;
        return this.multi('string', start, end, !ok);
      }
      return null;
    }
    if (isDigit(c) || (c === 46 && isDigit(c1))) {
      let p = start;
      const radix = c === 48 ? (c1 | 0x20) : 0;
      const digitRe = radix === 120 ? /[0-9a-fA-F]/ : radix === 111 ? /[0-7]/ : radix === 98 ? /[01]/ : null;
      if (digitRe && digitRe.test(t[start + 2] ?? '')) {
        p += 2;
        while (p < n && (digitRe.test(t[p]) || (t[p] === '_' && digitRe.test(t[p + 1] ?? '')))) p++;
      } else {
        const digits = () => { while (p < n && (isDigit(t.charCodeAt(p)) || (t[p] === '_' && isDigit(t.charCodeAt(p + 1))))) p++; };
        digits();
        if (t.charCodeAt(p) === 46 && t.charCodeAt(p + 1) !== 46) { p++; digits(); }
        const e = t.charCodeAt(p);
        if ((e === 101 || e === 69) && (isDigit(t.charCodeAt(p + 1)) || ((t[p + 1] === '+' || t[p + 1] === '-') && isDigit(t.charCodeAt(p + 2))))) {
          p += 2;
          digits();
        }
      }
      this.pos = p;
      return this.make('number', start, p);
    }
    if ((c === 58 /* : */ && t.charCodeAt(start - 1) !== 58) || c === 64 /* @ */) {
      if (!this.isIdentStart(c1)) return null;
      let p = start + 1;
      while (p < n && this.isIdentPart(t.charCodeAt(p)) && t.charCodeAt(p) !== 36) p++;
      this.pos = p;
      return this.make('param', start, p);
    }
    return null;
  }

  next(): Token {
    this.skipWs();
    const t = this.text;
    const n = t.length;
    const start = this.pos;
    this.endState = '';
    if (start >= n) {
      const e = this.make('eof', n, n);
      return e;
    }
    const wasLineStart = this.atLineStart;
    this.atLineStart = false;
    const c = t.charCodeAt(start);
    const c1 = start + 1 < n ? t.charCodeAt(start + 1) : 0;

    // -- line comment
    if (c === 45 && c1 === 45) {
      let e = t.indexOf('\n', start);
      if (e < 0) e = n;
      if (e > start && t.charCodeAt(e - 1) === CH_CR) e--;
      this.pos = e;
      return this.make('comment', start, e);
    }
    // /* block comment */
    if (c === 47 && c1 === 42) {
      const [end, depth] = this.scanBlockComment(start + 2, 1);
      this.endState = depth > 0 ? 'c' + depth : '';
      return this.multi('comment', start, end, depth > 0);
    }
    // Oracle: `/` alone on a line → batch separator
    if (this.isOracle && c === 47 && wasLineStart) {
      let p = start + 1;
      while (p < n && (t.charCodeAt(p) === CH_SP || t.charCodeAt(p) === CH_TAB || t.charCodeAt(p) === CH_CR)) p++;
      if (p >= n || t.charCodeAt(p) === CH_NL) {
        this.pos = start + 1;
        return this.make('batchSep', start, start + 1, '/');
      }
    }
    // strings
    if (c === 39) {
      const [end, ok] = this.scanString(start + 1, 39);
      this.endState = ok ? '' : 's';
      return this.multi('string', start, end, !ok);
    }
    if (this.isPg) {
      const pg = this.nextPg(start, c, c1, wasLineStart);
      if (pg) return pg;
    }
    // prefixed strings: N'..', Oracle q'..' / nq'..', SQLite X'..'
    if (c1 === 39 || (this.isOracle && (c === 110 || c === 78) && (c1 === 113 || c1 === 81) && t.charCodeAt(start + 2) === 39)) {
      const up = t[start].toUpperCase();
      if (c1 === 39 && ((up === 'N' && !this.isSqlite) || (up === 'X' && this.isSqlite))) {
        const [end, ok] = this.scanString(start + 2, 39);
        this.endState = ok ? '' : 's';
        return this.multi('string', start, end, !ok);
      }
      if (this.isOracle) {
        const qAt = c1 === 39 ? start : start + 1; // index of the q
        const qc = t[qAt];
        if ((qc === 'q' || qc === 'Q') && qAt + 2 < n) {
          const open = t[qAt + 2];
          const closer = Q_CLOSERS[open] ?? open;
          const [end, ok] = this.scanQQuote(qAt + 3, closer);
          this.endState = ok ? '' : 'q' + closer;
          return this.multi('string', start, end, !ok);
        }
      }
    }
    // quoted identifiers
    if (c === 34) {
      const [end, ok] = this.scanQuotedIdent(start + 1, 34, true);
      this.pos = end;
      return this.make('quotedIdent', start, end, undefined, !ok);
    }
    if (c === 91 && (this.isTsql || this.isSqlite)) {
      const [end, ok] = this.scanQuotedIdent(start + 1, 93, this.isTsql);
      this.pos = end;
      return this.make('quotedIdent', start, end, undefined, !ok);
    }
    if (c === 96 && this.isSqlite) {
      const [end, ok] = this.scanQuotedIdent(start + 1, 96, true);
      this.pos = end;
      return this.make('quotedIdent', start, end, undefined, !ok);
    }
    // numbers
    if (isDigit(c) || (c === 46 && isDigit(c1))) {
      let p = start;
      if (c === 48 && (c1 === 120 || c1 === 88) && (this.isTsql || this.isSqlite)) {
        p += 2;
        while (p < n && /[0-9a-fA-F]/.test(t[p])) p++;
      } else {
        while (p < n && isDigit(t.charCodeAt(p))) p++;
        if (t.charCodeAt(p) === 46 && !(this.isOracle && t.charCodeAt(p + 1) === 46)) {
          p++;
          while (p < n && isDigit(t.charCodeAt(p))) p++;
        }
        const e = t.charCodeAt(p);
        if ((e === 101 || e === 69) && (isDigit(t.charCodeAt(p + 1)) || ((t[p + 1] === '+' || t[p + 1] === '-') && isDigit(t.charCodeAt(p + 2))))) {
          p += 2;
          while (p < n && isDigit(t.charCodeAt(p))) p++;
        }
        if (this.isOracle && /[fFdD]/.test(t[p] ?? '') && !this.isIdentPart(t.charCodeAt(p + 1))) p++;
      }
      this.pos = p;
      return this.make('number', start, p);
    }
    // parameters / variables
    if (this.isTsql && c === 64 /* @ */) {
      let p = start + 1;
      if (t.charCodeAt(p) === 64) p++;
      while (p < n && this.isIdentPart(t.charCodeAt(p))) p++;
      this.pos = p;
      return this.make('param', start, p);
    }
    if (this.isOracle && (c === 58 /* : */ || c === 38 /* & */)) {
      if (c === 58 && (this.isIdentStart(c1) || isDigit(c1) || c1 === 34)) {
        let p = start + 1;
        if (c1 === 34) {
          const [end] = this.scanQuotedIdent(p + 1, 34, true);
          p = end;
        } else while (p < n && this.isIdentPart(t.charCodeAt(p))) p++;
        this.pos = p;
        return this.make('param', start, p);
      }
      const amp = c1 === 38 ? 2 : 1;
      if (c === 38 && this.isIdentStart(t.charCodeAt(start + amp))) {
        let p = start + amp;
        while (p < n && this.isIdentPart(t.charCodeAt(p))) p++;
        if (t[p] === '.') p++; // &var. terminator
        this.pos = p;
        return this.make('param', start, p);
      }
    }
    if (this.isSqlite && (c === 63 || ((c === 58 || c === 64 || c === 36) && this.isIdentStart(c1)))) {
      let p = start + 1;
      if (c === 63) while (p < n && isDigit(t.charCodeAt(p))) p++;
      else while (p < n && (this.isIdentPart(t.charCodeAt(p)) || (t[p] === ':' && t[p + 1] === ':'))) p += t[p] === ':' ? 2 : 1;
      this.pos = p;
      return this.make('param', start, p);
    }
    // identifiers (incl. T-SQL #temp / ##temp and $ACTION)
    if (this.isIdentStart(c) || (this.isTsql && (c === 35 /* # */ || (c === 36 && this.isIdentStart(c1))))) {
      let p = start + 1;
      if (this.isTsql && c === 35 && c1 === 35) p++;
      while (p < n) {
        const ch = t.charCodeAt(p);
        if (ch >= 0xd800 && ch <= 0xdbff) {
          const cp = t.codePointAt(p)!;
          if (this.isIdentPart(cp)) { p += 2; continue; }
          break;
        }
        if (!this.isIdentPart(ch)) break;
        p++;
      }
      const text = t.slice(start, p);
      const upper = text.toUpperCase();
      // T-SQL GO [count] on its own line
      if (this.isTsql && wasLineStart && upper === 'GO') {
        let q = p;
        while (q < n && (t.charCodeAt(q) === CH_SP || t.charCodeAt(q) === CH_TAB)) q++;
        let end = p;
        if (isDigit(t.charCodeAt(q))) {
          while (q < n && isDigit(t.charCodeAt(q))) q++;
          end = q;
          while (q < n && (t.charCodeAt(q) === CH_SP || t.charCodeAt(q) === CH_TAB)) q++;
        }
        const qc = t.charCodeAt(q);
        if (q >= n || qc === CH_NL || qc === CH_CR || (qc === 45 && t.charCodeAt(q + 1) === 45)) {
          this.pos = end;
          return this.make('batchSep', start, end, t.slice(start, end).toUpperCase());
        }
      }
      this.pos = p;
      const kind: TokenKind = this.spec.keywords.has(upper) ? 'keyword' : 'ident';
      return this.make(kind, start, p, upper);
    }
    // Oracle (+) outer join marker and %ROWTYPE-style attributes
    if (this.isOracle && c === 40 && /^\(\s*\+\s*\)/.test(t.slice(start, start + 8))) {
      const m = /^\(\s*\+\s*\)/.exec(t.slice(start, start + 8))!;
      this.pos = start + m[0].length;
      return this.make('op', start, this.pos);
    }
    if (this.isOracle && c === 37 /* % */ && this.isIdentStart(c1)) {
      let p = start + 1;
      while (p < n && this.isIdentPart(t.charCodeAt(p))) p++;
      const attr = t.slice(start + 1, p).toUpperCase();
      if (ORACLE_ATTRS.has(attr)) {
        this.pos = p;
        return this.make('op', start, p, '%' + attr);
      }
    }
    // punctuation
    if (c === 40 || c === 41 || c === 44 || c === 59 || (c === 46 && !(this.isOracle && c1 === 46))) {
      this.pos = start + 1;
      return this.make('punct', start, start + 1);
    }
    // operators
    const three = t.substr(start, 3);
    if (this.ops3.length && this.ops3.includes(three) && !(this.isPg && this.opEndsInComment(start + 3))) {
      this.pos = start + 3;
      return this.make('op', start, start + 3);
    }
    const two = t.substr(start, 2);
    if (this.ops2.includes(two) && !(this.isPg && this.opEndsInComment(start + 2))) {
      this.pos = start + 2;
      return this.make('op', start, start + 2);
    }
    // any other single character (incl. lone surrogate pairs)
    const cp = t.codePointAt(start)!;
    const len = cp > 0xffff ? 2 : 1;
    this.pos = start + len;
    return this.make('op', start, start + len);
  }
}

/** Tokenize a whole text. The returned array always ends with an `eof` token. Whitespace is not emitted. */
export function tokenize(text: string, spec: DialectSpec): Token[] {
  const lx = new Lexer(text, spec);
  const out: Token[] = [];
  for (;;) {
    const tok = lx.next();
    out.push(tok);
    if (tok.kind === 'eof') return out;
  }
}

/** Tokens without comments (and without eof). */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== 'comment' && t.kind !== 'eof' && t.kind !== 'ws');
}

export interface LineToken { start: number; kind: TokenKind; upper: string; text: string }

/** Line mode (Monaco tokens provider): lex one line starting in `state`. Offsets are relative to the line. */
export function lexLine(line: string, spec: DialectSpec, state: LexState): { tokens: LineToken[]; endState: LexState } {
  const lx = new Lexer(line, spec);
  const tokens: LineToken[] = [];
  let endState: LexState = '';
  const first = lx.resume(state);
  if (state) lx.atLineStart = false;
  if (first) {
    tokens.push({ start: first.start, kind: first.kind, upper: first.upper, text: first.text });
    if (lx.endState) return { tokens, endState: lx.endState };
  }
  for (;;) {
    const tok = lx.next();
    if (tok.kind === 'eof') break;
    tokens.push({ start: tok.start, kind: tok.kind, upper: tok.upper, text: tok.text });
    if (tok.end >= line.length) endState = lx.endState;
  }
  return { tokens, endState };
}

/** Offsets of line starts (index 0 = line 1). */
export function lineStarts(text: string): number[] {
  const out = [0];
  let i = text.indexOf('\n');
  while (i >= 0) {
    out.push(i + 1);
    i = text.indexOf('\n', i + 1);
  }
  return out;
}

/** 0-based line index containing `offset`. */
export function lineIndexAt(starts: number[], offset: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** 1-based line/col of an offset. */
export function positionAt(starts: number[], offset: number): { line: number; col: number } {
  const li = lineIndexAt(starts, offset);
  return { line: li + 1, col: offset - starts[li] + 1 };
}

/** Index of the first token with end >= offset (binary search). */
function firstEndingAtOrAfter(tokens: Token[], offset: number): number {
  let lo = 0, hi = tokens.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].end >= offset) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export interface TextChange { rangeOffset: number; rangeLength: number; text: string }

/**
 * Incremental re-lex after a single edit. `prev` are the tokens of the text before the edit.
 * Re-lexes from the line containing the edit and stops as soon as the token stream re-synchronises
 * with the old tokens (shifted by the edit delta); the rest are shifted copies.
 */
export function relex(prev: Token[], newText: string, change: TextChange, spec: DialectSpec, newLineStarts?: number[]): Token[] {
  const starts = newLineStarts ?? lineStarts(newText);
  const editStart = change.rangeOffset;
  const oldEditEnd = change.rangeOffset + change.rangeLength;
  const delta = change.text.length - change.rangeLength;
  const newEditEnd = editStart + change.text.length;

  let i = firstEndingAtOrAfter(prev, editStart);
  // restart at the start of the line containing the edit (GO / `/` detection is line based) or earlier
  const li = lineIndexAt(starts, Math.min(editStart, newText.length));
  let restart = Math.min(starts[li], prev[i]?.start ?? editStart);
  while (i > 0 && prev[i - 1].end >= restart) i--;
  if (i < prev.length && prev[i].kind !== 'eof') restart = Math.min(restart, prev[i].start);
  if (restart > editStart) restart = starts[li];

  const rl = lineIndexAt(starts, restart);
  // at line start if only whitespace between the line start and `restart`
  const before = newText.slice(starts[rl], restart);
  const lx = new Lexer(newText, spec, restart, rl + 1, starts[rl], /^\s*$/.test(before));
  const out: Token[] = prev.slice(0, i);

  // old tokens that start at/after the old edit end are sync candidates
  let j = i;
  while (j < prev.length && prev[j].start < oldEditEnd) j++;

  for (;;) {
    const tok = lx.next();
    if (tok.kind === 'eof') { out.push(tok); return out; }
    if (tok.start >= newEditEnd) {
      while (j < prev.length && prev[j].kind !== 'eof' && prev[j].start + delta < tok.start) j++;
      const o = prev[j];
      if (o && o.kind !== 'eof' && o.start + delta === tok.start && o.end + delta === tok.end && o.kind === tok.kind && o.text === tok.text) {
        // in sync: shift the remaining old tokens
        out.push(tok);
        let lineIdx = lineIndexAt(starts, tok.start);
        for (let k = j + 1; k < prev.length; k++) {
          const p = prev[k];
          const s = p.start + delta;
          while (lineIdx + 1 < starts.length && starts[lineIdx + 1] <= s) lineIdx++;
          const shifted: Token = { kind: p.kind, text: p.text, start: s, end: p.end + delta, line: lineIdx + 1, col: s - starts[lineIdx] + 1, upper: p.upper };
          if (p.unterminated) shifted.unterminated = true;
          out.push(shifted);
        }
        return out;
      }
    }
    out.push(tok);
  }
}

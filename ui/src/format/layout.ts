// Formatter layout core (PLAN-M1.5 1.2): token stream → lines. One left-to-right pass with recursive descent over
// blocks (BEGIN…END, IF, LOOP, packages, triggers), SQL statements (clause keywords, lists, JOINs, AND/OR),
// parentheses (subquery blocks, wrapped or inline lists) and CASE expressions.
//
// Invariants (checked again by index.ts, which falls back to the verbatim text when they do not hold):
// - every token of the input is emitted exactly once, in order, with its text unchanged except the letter case of
//   keywords, built-in function names and data types;
// - decisions depend only on the token sequence, comment placement (own line / same line) and blank-line counts,
//   so formatting the output again yields the same text (idempotency).
import type { Dialect } from '../intel/types';
import type { DialectSpec } from '../intel/dialect/spec';
import type { FormatOptions } from './options';
import { applyCase } from './options';
import { Out } from './out';
import type { FTok } from './comments';
import { JOIN_WORDS, NAME_PAREN_KEYWORDS, SET_OPERATORS, set, type FormatRules } from './rules/common';
import { tsqlRules, TSQL_NOT_BLOCK_BEGIN, TSQL_OBJECT_KINDS, TSQL_ROUTINES } from './rules/tsql';
import { plsqlRules, PL_CREATE_MODIFIERS, PL_SUBPROGRAM_PREFIX, PL_TRIGGER_LINES, SQLPLUS, SQL_SET_TARGETS } from './rules/plsql';
import { sqliteRules, SQLITE_TRIGGER_LINES } from './rules/sqlite';

type Stop = (k: number) => boolean;
const NEVER: Stop = () => false;

const RULES: Record<Dialect, FormatRules> = { tsql: tsqlRules, plsql: plsqlRules, sqlite: sqliteRules };

const LIST_CLAUSES = set('select set groupBy orderBy values');
const SELECT_MODIFIERS = set('DISTINCT ALL UNIQUE');
const DML_START = set('INSERT UPDATE DELETE MERGE EXECUTE');
const CAST_FUNCS = set('CONVERT TRY_CONVERT');
const PARAM_MODES = set('IN OUT NOCOPY RETURN RETURNS');
const FOR_WORDS = set('XML JSON PATH AUTO RAW EXPLICIT ROOT TYPE ELEMENTS XSINIL ABSENT INCLUDE_NULL_VALUES WITHOUT_ARRAY_WRAPPER BINARY BASE64 BROWSE');
/** Non-reserved DDL words upper-cased inside CREATE/ALTER statements (never in a name position). */
const DDL_WORDS = set(`
  PRIMARY KEY FOREIGN REFERENCES CASCADE CONSTRAINT GENERATED ALWAYS IDENTITY TABLESPACE NOCACHE CACHE CYCLE NOCYCLE
  MAXVALUE MINVALUE NOMAXVALUE NOMINVALUE SEQUENCE FORCE EDITIONABLE NONEDITIONABLE ENABLE DISABLE NOVALIDATE VALIDATE
  DEFERRABLE INITIALLY DEFERRED IMMEDIATE STORAGE LOGGING NOLOGGING COMPRESS NOCOMPRESS PARALLEL NOPARALLEL
  ORGANIZATION VIRTUAL INVISIBLE VISIBLE ORDER NOORDER RESTRICT CLUSTERED NONCLUSTERED PERSISTED SPARSE ROWGUIDCOL
  AUTOINCREMENT STORED ONLINE FILLFACTOR PAD_INDEX DATA_COMPRESSION SORT_IN_TEMPDB DROP_EXISTING CHAR BYTE`);
/** PL/SQL subprogram header modifiers. */
const HEADER_WORDS = set('DETERMINISTIC PIPELINED PARALLEL_ENABLE RESULT_CACHE RELIES_ON AUTHID DEFINER CURRENT_USER ACCESSIBLE AGGREGATE SHARING METADATA');
const OBJECT_WORDS = set('TYPE BODY PACKAGE SEQUENCE SYNONYM MATERIALIZED DIRECTORY CONTEXT LIBRARY EDITIONABLE NONEDITIONABLE FORCE NOFORCE');
/** DDL words that may start a column-list item. */
const ITEM_START_WORDS = set('CONSTRAINT PRIMARY FOREIGN');
const CURSOR_WORDS = set('LOCAL GLOBAL FORWARD_ONLY SCROLL STATIC KEYSET DYNAMIC FAST_FORWARD READ_ONLY SCROLL_LOCKS OPTIMISTIC TYPE_WARNING INSENSITIVE');

interface St {
  /** Indent of the statement's first line. */
  base: number;
  /** Indent of clause keywords (base, or base+1 inside a MERGE action). */
  clauseIndent: number;
  verb: string;
  /** Clause machine active (SELECT/INSERT/UPDATE/DELETE/MERGE and CREATE … AS SELECT). */
  dml: boolean;
  verbs: Set<string>;
  clause: string;
  list: boolean;
  listIndent: number;
  andOr: boolean;
  between: number;
  /** DECLARE / EXEC: commas break onto base+1, the first item stays on the statement line. */
  commaBreak: boolean;
  insertHasSource: boolean;
  seenSet: boolean;
  seenCursor: boolean;
  stop: Stop;
  /** Inside parentheses: no T-SQL statement boundaries. */
  inParen: boolean;
}

interface TakeOpts {
  /** Treat an identifier as a keyword (letter case). */
  kw?: boolean;
  /** Force (true) or suppress (false) the space before the token. */
  space?: boolean;
  /** Block closer: leading comments indent like the block body. */
  closer?: boolean;
  /** A name that happens to be a reserved word (labels, END name): identifier case. */
  name?: boolean;
}

export interface LayoutOutcome {
  text: string;
  /** Set when the chunk cannot be laid out (unbalanced parentheses or blocks). */
  problem: string | null;
}

export class Layout {
  private readonly toks: FTok[];
  private readonly sig: number[] = [];
  private readonly match: Int32Array;
  private readonly spec: DialectSpec;
  private readonly rules: FormatRules;
  private readonly o: FormatOptions;
  private readonly d: Dialect;
  private readonly out: Out;
  private p = 0;
  private lastAi = -1;
  private prevUnary = false;
  private forceBreak = false;
  private typeCtx = 0;
  private headerCtx = 0;
  private verbCtx = '';
  private problem: string | null = null;
  /** The next token continues the current line without a space (`;WITH`). */
  private glue = false;
  /** Identifiers are option keywords here (WITH RECOMPILE, OPTION (MAXRECURSION 10), CURSOR LOCAL FAST_FORWARD). */
  private kwIdents = 0;
  /** Inside an inline table-valued function body (RETURN SELECT …). */
  private inlineTvf = false;

  constructor(toks: FTok[], spec: DialectSpec, o: FormatOptions, eol: string) {
    this.toks = toks;
    this.spec = spec;
    this.d = spec.id;
    this.rules = RULES[spec.id];
    this.o = o;
    this.out = new Out({ indentSize: o.indent, useTabs: o.useTabs, eol });
    for (let i = 0; i < toks.length; i++) if (toks[i].kind !== 'comment') this.sig.push(i);
    this.match = new Int32Array(this.sig.length).fill(-1);
    const stack: number[] = [];
    for (let k = 0; k < this.sig.length; k++) {
      const t = this.S(k)!;
      if (t.kind !== 'punct') continue;
      if (t.text === '(') stack.push(k);
      else if (t.text === ')') {
        const o2 = stack.pop();
        if (o2 === undefined) { this.problem = 'unbalanced parentheses'; continue; }
        this.match[o2] = k;
        this.match[k] = o2;
      }
    }
    if (stack.length) this.problem = 'unbalanced parentheses';
  }

  run(): LayoutOutcome {
    if (!this.problem) {
      this.statements(0, NEVER, true);
      while (this.p < this.sig.length) {
        // a construct stopped early (stray END / ELSE / ')'): keep going as generic statements
        this.out.newline(0);
        this.take({ kw: true });
        this.statements(0, NEVER, true);
      }
      this.flushTail();
    }
    return { text: this.out.toString(), problem: this.problem };
  }

  // ------------------------------------------------------------------ token access

  private S(k: number): FTok | undefined {
    return k >= 0 && k < this.sig.length ? this.toks[this.sig[k]] : undefined;
  }
  private U(k: number): string {
    const t = this.S(k);
    return t ? (t.word ? t.u : t.kind === 'punct' || t.kind === 'op' ? t.text : t.kind === 'batchSep' ? t.u : '') : '';
  }
  private W(k: number, w: string): boolean {
    const t = this.S(k);
    return !!t && t.word && t.u === w;
  }
  private P(k: number, ch: string): boolean {
    const t = this.S(k);
    return !!t && t.kind === 'punct' && t.text === ch;
  }
  private eof(): boolean {
    return this.p >= this.sig.length;
  }
  private isName(k: number): boolean {
    const t = this.S(k);
    return !!t && (t.kind === 'ident' || t.kind === 'quotedIdent');
  }
  /** Skip a parenthesised group starting at k (returns the index after `)`). */
  private after(k: number): number {
    return this.P(k, '(') && this.match[k] > k ? this.match[k] + 1 : k + 1;
  }

  // ------------------------------------------------------------------ emission

  private take(o: TakeOpts = {}): void {
    const k = this.p;
    const t = this.S(k);
    if (!t) return;
    if (t.kind === 'punct' && t.text === ';' && this.semicolonBeforeTrailing(t)) return;
    this.flushLeading(t, !!o.closer);
    if (this.forceBreak) {
      if (!this.out.atLineStart) this.out.newline(this.out.lineIndent + 1);
      this.forceBreak = false;
    }
    let space = o.space ?? this.spaceBefore(k);
    if (this.glue) { this.glue = false; space = false; this.out.cancelNewline(); }
    this.out.put(o.name ? applyCase(t.text, this.o.identifierCase) : this.caseText(k, !!o.kw), space);
    this.prevUnary = t.kind === 'op' && (t.text === '-' || t.text === '+' || t.text === '~') && this.unaryAt(k);
    this.lastAi = t.ai;
    this.p = k + 1;
    this.flushTrailing();
  }

  /**
   * `FROM t -- note⏎;`: the `;` belongs to the statement, not on a line of its own under the comment. When every
   * token between the previous token and the `;` is a single-line comment already emitted on the current line, the
   * `;` is written before them (`FROM t; -- note`). index.ts compares token sequences with `;` moved before
   * adjacent comments, so this reordering passes its safety check.
   */
  private semicolonBeforeTrailing(t: FTok): boolean {
    if (!this.forceBreak || this.lastAi !== t.ai - 1 || this.out.pending !== null || this.out.atLineStart) return false;
    let first = t.ai - 1;
    while (first >= 0 && this.toks[first].kind === 'comment') first--;
    if (first === t.ai - 1 || first < 0) return false;
    const comments = this.toks.slice(first + 1, t.ai);
    if (comments.some((c) => c.nl > 0 || c.text.indexOf('\n') >= 0)) return false;
    // a comment right after the `;` on its line would be merged into the moved `--` comment
    const after = this.toks[t.ai + 1];
    if (after && after.kind === 'comment' && after.nl === 0) return false;
    if (!this.out.insertBeforeTail(';', comments.map((c) => ' ' + c.text).join(''))) return false;
    this.lastAi = t.ai;
    this.p++;
    this.prevUnary = false;
    return true;
  }

  /** A comment token; continuation lines of a multi-line block comment keep their indent relative to its first line. */
  private putComment(c: FTok, space: boolean): void {
    if (c.text.indexOf('\n') < 0 || !c.text.startsWith('/*') || !this.srcText) {
      this.out.put(c.text, space);
      return;
    }
    this.out.put(c.text, space, visualColumn(this.srcText, c.t.start, this.o.indent));
  }

  private takeKw(n = 1): void {
    for (let i = 0; i < n && !this.eof(); i++) this.take({ kw: true });
  }

  /** Emit tokens [p, end) as the original source slice (SQL*Plus lines). */
  private takeRaw(end: number, src: string): void {
    const a = this.S(this.p)!, z = this.S(end - 1)!;
    this.flushLeading(a, false);
    this.out.put(src.slice(a.t.start, z.t.end), true);
    this.lastAi = z.ai;
    this.p = end;
    this.prevUnary = false;
    this.forceBreak = false;
    this.flushTrailing();
  }

  private flushLeading(t: FTok, closer: boolean): void {
    if (this.lastAi + 1 >= t.ai) return;
    const pending = this.out.pending;
    let tokIndent = pending ?? this.out.lineIndent + 1;
    const commentIndent = pending !== null ? (closer ? pending + 1 : pending) : this.out.atLineStart ? this.out.lineIndent : this.out.lineIndent + 1;
    if (pending === null && this.out.atLineStart) tokIndent = this.out.lineIndent;
    let onLine = false;
    for (let i = this.lastAi + 1; i < t.ai; i++) {
      const c = this.toks[i];
      if (c.nl === 0 && onLine) {
        this.putComment(c, true);
      } else {
        this.out.newline(commentIndent);
        this.out.blank(Math.min(Math.max(0, c.nl - 1), this.o.maxConsecutiveBlankLines));
        this.putComment(c, false);
      }
      onLine = !c.breaksAfter;
      this.lastAi = i;
    }
    this.out.newline(tokIndent);
    this.out.blank(Math.min(Math.max(0, t.nl - 1), this.o.maxConsecutiveBlankLines));
    this.forceBreak = false;
  }

  private flushTrailing(): void {
    for (let i = this.lastAi + 1; i < this.toks.length; i++) {
      const c = this.toks[i];
      if (c.kind !== 'comment' || c.nl > 0) break;
      this.putComment(c, true);
      this.lastAi = i;
      if (c.breaksAfter) this.forceBreak = true;
    }
    const t = this.toks[this.lastAi];
    if (t && t.kind !== 'comment' && t.text.indexOf('\n') >= 0) this.forceBreak = true;
  }

  private flushTail(): void {
    let onLine = !this.out.atLineStart && !this.forceBreak;
    for (let i = this.lastAi + 1; i < this.toks.length; i++) {
      const c = this.toks[i];
      if (c.nl === 0 && onLine) this.putComment(c, true);
      else {
        this.out.newline(this.out.isEmpty ? 0 : Math.min(this.out.lineIndent, 0));
        this.out.blank(Math.min(Math.max(0, c.nl - 1), this.o.maxConsecutiveBlankLines));
        this.putComment(c, false);
      }
      onLine = !c.breaksAfter;
      this.lastAi = i;
    }
  }

  private unaryAt(k: number): boolean {
    const a = this.S(k - 1);
    if (!a) return true;
    if (a.kind === 'op') return !a.u.startsWith('%') && !/^\(\s*\+\s*\)$/.test(a.text);
    if (a.kind === 'punct') return a.text === '(' || a.text === ',';
    if (a.kind === 'keyword') return !this.rules.operandKeywords.has(a.u);
    return false;
  }

  private spaceBefore(k: number): boolean {
    const a = this.S(k - 1), b = this.S(k)!;
    if (!a) return false;
    if (this.prevUnary) return false;
    const at = a.text, bt = b.text;
    if (b.kind === 'punct' && (bt === ',' || bt === ';' || bt === ')' || bt === '.')) return false;
    if (a.kind === 'punct' && (at === '(' || at === '.')) return false;
    if (b.kind === 'op') {
      if (b.u.startsWith('%') && b.u.length > 1) return false;
      if (/^\(\s*\+\s*\)$/.test(bt)) return false;
      if (bt === ':' && this.d !== 'plsql') return false;
    }
    if (at === '::' || bt === '::' || at === '..' || bt === '..') return false;
    if (at === '->' || at === '->>' || bt === '->' || bt === '->>') return false;
    if (this.d === 'plsql' && a.kind === 'op' && at === '<<') return false;
    if (this.d === 'plsql' && b.kind === 'op' && bt === '>>') return false;
    if (b.kind === 'punct' && bt === '(') return this.spaceBeforeParen(k);
    return true;
  }

  private spaceBeforeParen(k: number): boolean {
    const a = this.S(k - 1)!;
    // MERGE … USING (SELECT …) / JOIN t USING (id): a clause keyword, never a function call
    if (a.word && a.u === 'USING') return true;
    if (a.kind === 'ident' && (a.u === 'APPLY' || a.u === 'OVER' || a.u === 'FILTER' || a.u === 'COLUMNS' || a.u === 'ROW' || (a.u === 'INCLUDE' && this.verbCtx === 'CREATE'))) return true;
    if (a.kind === 'ident' && (a.u === 'RECORD' || a.u === 'OBJECT' || a.u === 'VARRAY') && (this.W(k - 2, 'IS') || this.W(k - 2, 'AS'))) return true;
    if (a.kind === 'ident' || a.kind === 'quotedIdent') {
      let j = k - 1;
      while (this.P(j - 1, '.') && (this.S(j - 2)?.kind === 'ident' || this.S(j - 2)?.kind === 'quotedIdent')) j -= 2;
      const kw = this.S(j - 1);
      if (!kw || !kw.word || this.P(j - 1, '.')) return false;
      if (kw.u === 'ON') return this.verbCtx === 'CREATE' || this.verbCtx === 'ALTER';
      if (kw.u === 'TYPE' || kw.u === 'BODY') return this.headerCtx > 0 || this.verbCtx === 'CREATE';
      return NAME_PAREN_KEYWORDS.has(kw.u);
    }
    if (a.kind === 'keyword') {
      if (a.u === 'TABLE') return true;
      return !(this.rules.functionKeywords.has(a.u) || this.spec.functionMap.has(a.u) || this.spec.dataTypeSet.has(a.u));
    }
    return true;
  }

  private isTypeAt(k: number): boolean {
    const t = this.S(k)!;
    if (!this.spec.dataTypeSet.has(t.u)) return false;
    const a = this.S(k - 1), b = this.S(k + 1);
    if (!a || a.text === '.' || (b && b.kind === 'punct' && b.text === '.')) return false;
    if (a.kind === 'param') return this.d === 'tsql';
    if (a.word && a.u === 'AS') return !!b && b.kind === 'punct' && (b.text === ')' || b.text === '(') || (this.S(k - 2)?.kind === 'param');
    if (a.kind === 'punct' && a.text === '(' && this.S(k - 2) && CAST_FUNCS.has(this.S(k - 2)!.u)) return true;
    if (a.word && (a.u === 'RETURNS' || (a.u === 'RETURN' && this.headerCtx > 0))) return true;
    if (this.typeCtx > 0) return a.kind === 'ident' || a.kind === 'quotedIdent' || (a.word && (PARAM_MODES.has(a.u) || a.u === 'OF' || (a.u === 'BY' && this.W(k - 2, 'INDEX'))));
    return false;
  }

  private caseText(k: number, kw: boolean): string {
    const t = this.S(k)!;
    const next = this.S(k + 1);
    const call = !!next && next.kind === 'punct' && next.text === '(' && this.S(k - 1)?.text !== '.';
    if (t.kind === 'keyword' || t.kind === 'batchSep') {
      if (t.kind === 'keyword' && this.isTypeAt(k)) return applyCase(t.text, this.o.datatypeCase);
      if (call && this.spec.functionMap.has(t.u)) return applyCase(t.text, this.o.functionCase);
      return applyCase(t.text, this.o.keywordCase);
    }
    if (t.kind === 'ident') {
      if (call && this.spec.functionMap.has(t.u) && !this.spaceBeforeParen(k + 1)) return applyCase(t.text, this.o.functionCase);
      if (!call && this.spec.functionMap.get(t.u)?.kind === 'niladic' && this.S(k - 1)?.text !== '.' && this.S(k + 1)?.text !== '.') return applyCase(t.text, this.o.functionCase);
      if (this.isTypeAt(k) || (t.u === 'MAX' && this.P(k - 1, '(') && this.spec.dataTypeSet.has(this.U(k - 2)))) return applyCase(t.text, this.o.datatypeCase);
      if (kw || this.kwIdents > 0) return applyCase(t.text, this.o.keywordCase);
      return applyCase(t.text, this.o.identifierCase);
    }
    if (t.kind === 'op' && t.u.startsWith('%') && t.u.length > 1) return applyCase(t.text, this.o.keywordCase);
    return t.text;
  }

  // ------------------------------------------------------------------ measuring

  /** Inline width of tokens [a, b), or Infinity when the range cannot stay on one line. */
  private measure(a: number, b: number): number {
    if (b <= a) return 0;
    const first = this.S(a)!, last = this.S(b - 1)!;
    for (let i = first.ai; i <= last.ai; i++) {
      const t = this.toks[i];
      if (t.kind === 'comment' || t.text.indexOf('\n') >= 0) return Infinity;
    }
    let w = 0;
    let whens = 0;
    let caseDepth = 0;
    for (let k = a; k < b; k++) {
      const t = this.S(k)!;
      if (t.kind === 'punct' && t.text === '(' && (this.W(k + 1, 'SELECT') || (this.W(k + 1, 'WITH') && this.isCteAt(k + 1)))) return Infinity;
      if (t.word && t.u === 'CASE') caseDepth++;
      else if (t.word && t.u === 'END' && caseDepth > 0) caseDepth--;
      else if (t.word && t.u === 'WHEN' && caseDepth > 0 && ++whens > 1) return Infinity;
      w += t.text.length;
      if (k > a && this.spaceBefore(k)) w++;
    }
    return w;
  }

  private fits(a: number, b: number, extra = 0): boolean {
    return this.out.column + 1 + this.measure(a, b) + extra <= this.o.lineWidth;
  }

  /** Top-level comma count in [a, b). */
  private commas(a: number, b: number): number {
    let n = 0;
    for (let k = a; k < b; k = this.after(k)) if (this.P(k, ',')) n++;
    return n;
  }

  // ------------------------------------------------------------------ statement sequences

  /** Blank lines before a statement: preserved (capped), and at least one after a multi-line top-level statement. */
  private separation(k: number, prevMulti: boolean, indent: number): number {
    const t = this.S(k)!;
    let first = t;
    for (let i = this.lastAi + 1; i < t.ai; i++) if (this.toks[i].kind === 'comment') { first = this.toks[i]; break; }
    let b = Math.min(Math.max(0, first.nl - 1), this.o.maxConsecutiveBlankLines);
    if (prevMulti && indent === 0 && !(this.W(k, 'BEGIN') && this.W(k + 1, 'CATCH'))) b = Math.max(b, this.o.blankLineBetweenStatements);
    return b;
  }

  private statements(indent: number, stop: Stop, top = false): void {
    let first = !top || this.out.isEmpty;
    let prevMulti = false;
    while (!this.eof() && !stop(this.p)) {
      if (this.P(this.p, ';')) {
        // `;WITH`: a semicolon starting a line stays glued to the statement after it
        if (this.out.atLineStart && !this.P(this.p + 1, ';') && !stop(this.p + 1) && this.p + 1 < this.sig.length) {
          this.out.newline(indent);
          if (!first) this.out.blank(this.separation(this.p, prevMulti, indent));
          this.take({ space: false });
          this.glue = true;
          first = true;
          continue;
        }
        this.take({ space: false });
        continue;
      }
      const glued = this.glue;
      const blanks = first ? 0 : this.separation(this.p, prevMulti, indent);
      if (!glued) this.out.newline(indent);
      if (!first && !glued) this.out.blank(blanks);
      const before = this.out.linesStarted;
      const start = this.p;
      this.statement(indent, stop);
      if (this.p === start) this.take({ kw: true });
      prevMulti = this.out.linesStarted - before > 1;
      first = false;
    }
  }

  private statement(indent: number, outer: Stop): void {
    if (this.d === 'tsql') this.tsqlStatement(indent, outer);
    else if (this.d === 'plsql') this.plStatement(indent, outer);
    else this.sqliteStatement(indent, outer);
  }

  // ------------------------------------------------------------------ T-SQL

  private isTsqlBlockBegin(k: number): boolean {
    if (!this.W(k, 'BEGIN')) return false;
    const nx = this.U(k + 1);
    return nx === 'TRY' || nx === 'CATCH' || !TSQL_NOT_BLOCK_BEGIN.has(nx);
  }

  private tsqlStatement(indent: number, outer: Stop): void {
    const u = this.U(this.p);
    if (this.isTsqlBlockBegin(this.p)) return this.tsqlBlock(indent);
    if (u === 'IF' || u === 'WHILE') return this.tsqlIf(indent, outer);
    if ((u === 'CREATE' || u === 'ALTER') && this.tsqlRoutineKind(this.p)) return this.tsqlRoutine(indent);
    if (this.isTsqlLabel(this.p)) {
      this.take();
      this.take({ space: false });
      return;
    }
    this.sql(indent, { stop: outer });
  }

  private tsqlBlock(indent: number): void {
    this.takeKw();
    if (this.W(this.p, 'TRY') || this.W(this.p, 'CATCH')) this.takeKw();
    this.statements(indent + 1, (k) => this.W(k, 'END'));
    if (this.eof()) { this.problem ??= 'BEGIN without END'; return; }
    this.out.newline(indent);
    this.take({ kw: true, closer: true });
    if (this.W(this.p, 'TRY') || this.W(this.p, 'CATCH')) this.takeKw();
    if (this.P(this.p, ';')) this.take({ space: false });
  }

  /** T-SQL body start after IF/WHILE conditions. */
  private tsqlBodyStart(k: number): boolean {
    const t = this.S(k);
    if (!t || !t.word) return false;
    if (t.u === 'UPDATE' && this.P(k + 1, '(')) return false;
    if (t.u === 'WITH' && !this.isCteAt(k)) return false;
    return this.rules.statementStarts.has(t.u) && !(t.u === 'ENABLE' || t.u === 'DISABLE');
  }

  private tsqlIf(indent: number, outer: Stop): void {
    const isWhile = this.W(this.p, 'WHILE');
    this.takeKw();
    this.expr((k) => this.tsqlBodyStart(k) || this.P(k, ';') || outer(k), {});
    this.tsqlBody(indent, outer);
    if (isWhile) return;
    if (this.W(this.p, 'ELSE')) {
      this.out.newline(indent);
      this.takeKw();
      if (this.W(this.p, 'IF')) { this.tsqlIf(indent, outer); return; }
      this.tsqlBody(indent, outer);
    }
  }

  private tsqlBody(indent: number, outer: Stop): void {
    if (this.eof() || outer(this.p) || this.W(this.p, 'END') || this.W(this.p, 'ELSE')) return;
    if (this.isTsqlBlockBegin(this.p)) {
      this.out.newline(indent);
      this.tsqlBlock(indent);
      return;
    }
    this.out.newline(indent + 1);
    const start = this.p;
    this.tsqlStatement(indent + 1, outer);
    if (this.p === start) this.take();
  }

  private tsqlRoutineKind(k: number): string | null {
    let j = k + 1;
    if (this.W(j, 'OR') && this.W(j + 1, 'ALTER')) j += 2;
    const u = this.U(j);
    return TSQL_ROUTINES.has(u) ? u : null;
  }

  private takeName(): void {
    if (this.isName(this.p) || this.S(this.p)?.kind === 'keyword') this.take();
    while (this.P(this.p, '.') && this.S(this.p + 1) && (this.S(this.p + 1)!.kind === 'ident' || this.S(this.p + 1)!.kind === 'quotedIdent' || this.S(this.p + 1)!.kind === 'keyword')) {
      this.take();
      this.take();
    }
  }

  private tsqlRoutine(indent: number): void {
    const kind = this.tsqlRoutineKind(this.p)!;
    this.verbCtx = 'CREATE';
    this.headerCtx++;
    this.takeKw();
    if (this.W(this.p, 'OR')) this.takeKw(2);
    this.takeKw();
    this.takeName();
    const isHeaderAs = (k: number) => this.W(k, 'AS') && this.S(k - 1)?.kind !== 'param' && !this.W(k - 1, 'EXECUTE') && !this.W(k - 1, 'EXEC');
    const headerEnd: Stop = (k) => isHeaderAs(k);
    if (kind === 'PROC' || kind === 'PROCEDURE') {
      if (this.P(this.p, '(')) this.paren('params');
      else if (this.S(this.p)?.kind === 'param') {
        this.typeCtx++;
        this.out.newline(indent + 1);
        while (!this.eof() && this.S(this.p)?.kind === 'param') {
          this.expr((k) => this.P(k, ',') || headerEnd(k) || this.W(k, 'WITH') || (this.W(k, 'FOR') && this.W(k + 1, 'REPLICATION')), {});
          if (this.P(this.p, ',')) this.comma(indent + 1, true);
          else break;
        }
        this.typeCtx--;
      }
    } else if (kind === 'FUNCTION') {
      if (this.P(this.p, '(')) this.paren('params', true);
      if (this.W(this.p, 'RETURNS')) {
        this.out.newline(indent);
        this.takeKw();
        this.inlineTvf = this.W(this.p, 'TABLE');
        this.typeCtx++;
        this.expr((k) => headerEnd(k) || (this.W(k, 'WITH') && !this.P(k + 1, '(')), {});
        this.typeCtx--;
      }
    } else if (kind === 'TRIGGER') {
      while (!this.eof() && !headerEnd(this.p)) {
        const u = this.U(this.p);
        if (u === 'ON' || u === 'FOR' || u === 'AFTER' || u === 'INSTEAD' || u === 'WITH' || (u === 'NOT' && this.W(this.p + 1, 'FOR'))) {
          this.out.newline(indent);
          this.takeKw(u === 'INSTEAD' || u === 'NOT' ? 2 : 1);
          if (u === 'NOT') this.takeKw();
          this.expr((k) => headerEnd(k) || ['ON', 'FOR', 'AFTER', 'INSTEAD', 'WITH'].includes(this.U(k)) || (this.W(k, 'NOT') && this.W(k + 1, 'FOR')), {});
        } else this.take();
      }
    } else if (kind === 'VIEW') {
      if (this.P(this.p, '(')) this.paren('call', true);
    }
    while (!this.eof() && !headerEnd(this.p)) {
      if (this.W(this.p, 'WITH') || (this.W(this.p, 'FOR') && this.W(this.p + 1, 'REPLICATION'))) {
        this.out.newline(indent);
        this.takeKw();
        this.kwIdents++;
        this.expr((k) => headerEnd(k), {});
        this.kwIdents--;
      } else this.take({ kw: this.S(this.p)?.word });
    }
    this.headerCtx--;
    if (this.eof()) return;
    this.out.newline(indent);
    this.takeKw();
    if (kind === 'VIEW') {
      this.out.newline(indent);
      this.sql(indent, {});
      return;
    }
    this.statements(indent, NEVER);
  }

  // ------------------------------------------------------------------ PL/SQL

  private plIsSqlPlus(k: number): boolean {
    const t = this.S(k)!;
    if (t.kind === 'op' && t.text === '@') return true;
    if (!t.word) return false;
    if (t.u === 'SET') return !SQL_SET_TARGETS.has(this.U(k + 1));
    return SQLPLUS.has(t.u) && !(t.u === 'EXECUTE' && this.W(k + 1, 'IMMEDIATE'));
  }

  private plDepth = 0;

  private plStatement(indent: number, outer: Stop): void {
    const k = this.p;
    const u = this.U(k);
    if (this.plDepth === 0 && this.plIsSqlPlus(k)) {
      const line = this.S(k)!.t.line;
      let e = k + 1;
      while (e < this.sig.length && this.S(e)!.t.line === line && this.S(e)!.nl === 0) e++;
      this.takeRaw(e, this.srcText);
      return;
    }
    if (u === '<<' && this.S(k)!.kind === 'op') {
      this.take();
      while (!this.eof() && !(this.S(this.p)!.kind === 'op' && this.S(this.p)!.text === '>>')) this.take({ name: true });
      if (!this.eof()) this.take();
      return;
    }
    if (u === 'DECLARE' || u === 'BEGIN') return this.plBlock(indent);
    if (u === 'CREATE') {
      let j = k + 1;
      while (PL_CREATE_MODIFIERS.has(this.U(j))) j++;
      const obj = this.U(j);
      if (obj === 'PROCEDURE' || obj === 'FUNCTION' || obj === 'PACKAGE' || obj === 'TRIGGER' || (obj === 'TYPE' && this.W(j + 1, 'BODY'))) {
        return this.plUnit(indent, j);
      }
    }
    if (this.plDepth > 0) {
      if (u === 'IF') return this.plIf(indent);
      if (u === 'CASE') return this.plCase(indent);
      if (u === 'LOOP' || u === 'WHILE' || u === 'FOR') return this.plLoop(indent);
      if (u === 'FORALL') {
        this.takeKw();
        this.expr((k2) => DML_START.has(this.U(k2)) || this.P(k2, ';'), {});
        this.out.newline(indent + 1);
        this.sql(indent + 1, { stop: outer });
        return;
      }
    }
    this.sql(indent, { stop: outer });
  }

  private srcText = '';
  setSource(src: string): this {
    this.srcText = src;
    return this;
  }

  private endWith(indent: number, extra: string[]): void {
    if (this.eof()) { this.problem ??= 'block without END'; return; }
    this.out.newline(indent);
    this.take({ kw: true, closer: true });
    for (const w of extra) if (this.W(this.p, w)) this.takeKw();
    if (!this.eof() && (this.isName(this.p) || (this.S(this.p)!.word && this.P(this.p + 1, ';')))) this.take({ name: true });
    if (this.P(this.p, ';')) this.take({ space: false });
  }

  private plBody(indent: number, stop: Stop): void {
    this.plDepth++;
    this.statements(indent, stop);
    this.plDepth--;
  }

  private plBlock(indent: number): void {
    const declared = this.W(this.p, 'DECLARE');
    if (declared) {
      this.takeKw();
      this.declarations(indent + 1, (k) => this.W(k, 'BEGIN') || this.W(k, 'END'));
      if (this.W(this.p, 'BEGIN')) this.out.newline(indent);
    }
    this.blockBody(indent, declared);
  }

  /** BEGIN stmts [EXCEPTION handlers] END [name]; `afterDecls`: BEGIN closes a declaration section. */
  private blockBody(indent: number, afterDecls = true): void {
    if (this.W(this.p, 'BEGIN')) {
      this.take({ kw: true, closer: afterDecls });
      this.plBody(indent + 1, (k) => this.W(k, 'EXCEPTION') || this.W(k, 'END'));
    }
    if (this.W(this.p, 'EXCEPTION')) {
      this.out.newline(indent);
      this.take({ kw: true, closer: true });
      this.handlers(indent + 1);
    }
    this.endWith(indent, []);
  }

  private handlers(indent: number): void {
    while (this.W(this.p, 'WHEN')) {
      this.out.newline(indent);
      this.takeKw();
      this.expr((k) => this.W(k, 'THEN'), {});
      if (this.W(this.p, 'THEN')) this.takeKw();
      this.plBody(indent + 1, (k) => this.W(k, 'WHEN') || this.W(k, 'END'));
    }
  }

  private plIf(indent: number): void {
    this.takeKw();
    this.expr((k) => this.W(k, 'THEN'), {});
    if (this.W(this.p, 'THEN')) this.takeKw();
    const bodyStop: Stop = (k) => this.W(k, 'ELSIF') || this.W(k, 'ELSE') || this.W(k, 'END');
    this.plBody(indent + 1, bodyStop);
    while (this.W(this.p, 'ELSIF') || this.W(this.p, 'ELSE')) {
      this.out.newline(indent);
      const elsif = this.W(this.p, 'ELSIF');
      this.take({ kw: true, closer: true });
      if (elsif) {
        this.expr((k) => this.W(k, 'THEN'), {});
        if (this.W(this.p, 'THEN')) this.takeKw();
      }
      this.plBody(indent + 1, bodyStop);
    }
    this.endWith(indent, ['IF']);
  }

  private plCase(indent: number): void {
    this.takeKw();
    this.expr((k) => this.W(k, 'WHEN'), {});
    while (this.W(this.p, 'WHEN') || this.W(this.p, 'ELSE')) {
      this.out.newline(indent + 1);
      const when = this.W(this.p, 'WHEN');
      this.takeKw();
      if (when) {
        this.expr((k) => this.W(k, 'THEN'), {});
        if (this.W(this.p, 'THEN')) this.takeKw();
      }
      this.plBody(indent + 2, (k) => this.W(k, 'WHEN') || this.W(k, 'ELSE') || this.W(k, 'END'));
    }
    this.endWith(indent, ['CASE']);
  }

  private plLoop(indent: number): void {
    if (!this.W(this.p, 'LOOP')) {
      this.takeKw();
      this.expr((k) => this.W(k, 'LOOP') || this.P(k, ';'), {});
    }
    if (!this.W(this.p, 'LOOP')) return;
    this.takeKw();
    this.plBody(indent + 1, (k) => this.W(k, 'END'));
    this.endWith(indent, ['LOOP']);
  }

  private declarations(indent: number, stop: Stop): void {
    let first = true;
    let prevMulti = false;
    this.plDepth++;
    this.typeCtx++;
    while (!this.eof() && !stop(this.p)) {
      if (this.P(this.p, ';')) {
        // `;WITH`: a semicolon starting a line stays glued to the statement after it
        if (this.out.atLineStart && !this.P(this.p + 1, ';') && !stop(this.p + 1) && this.p + 1 < this.sig.length) {
          this.out.newline(indent);
          if (!first) this.out.blank(this.separation(this.p, prevMulti, indent));
          this.take({ space: false });
          this.glue = true;
          first = true;
          continue;
        }
        this.take({ space: false });
        continue;
      }
      const glued = this.glue;
      const blanks = first ? 0 : this.separation(this.p, prevMulti, indent);
      if (!glued) this.out.newline(indent);
      if (!first && !glued) this.out.blank(blanks);
      const before = this.out.linesStarted;
      const start = this.p;
      this.declaration(indent);
      if (this.p === start) this.take();
      prevMulti = this.out.linesStarted - before > 1;
      first = false;
    }
    this.typeCtx--;
    this.plDepth--;
  }

  private subprogramAt(k: number): boolean {
    let j = k;
    while (PL_SUBPROGRAM_PREFIX.has(this.U(j)) && !this.W(j, 'PROCEDURE') && !this.W(j, 'FUNCTION')) j++;
    return this.W(j, 'PROCEDURE') || this.W(j, 'FUNCTION');
  }

  private declaration(indent: number): void {
    const u = this.U(this.p);
    if (this.subprogramAt(this.p)) return this.subprogram(indent);
    if (u === 'CURSOR') {
      this.typeCtx--;
      this.expr((k) => this.W(k, 'IS') || this.P(k, ';'), {});
      if (this.W(this.p, 'IS')) {
        this.takeKw();
        this.out.newline(indent + 1);
        this.sql(indent + 1, {});
      } else if (this.P(this.p, ';')) this.take({ space: false });
      this.typeCtx++;
      return;
    }
    if ((u === 'BEFORE' || u === 'AFTER' || u === 'INSTEAD') && this.timingPointAt(this.p)) {
      // compound trigger timing point: BEFORE STATEMENT IS BEGIN … END BEFORE STATEMENT;
      while (!this.eof() && !this.W(this.p, 'IS')) this.takeKw();
      this.takeKw();
      this.out.newline(indent);
      if (this.W(this.p, 'BEGIN')) {
        this.take({ kw: true, closer: true });
        this.plBody(indent + 1, (k) => this.W(k, 'EXCEPTION') || this.W(k, 'END'));
      }
      if (this.W(this.p, 'EXCEPTION')) {
        this.out.newline(indent);
        this.take({ kw: true, closer: true });
        this.handlers(indent + 1);
      }
      if (this.eof()) return;
      this.out.newline(indent);
      this.take({ kw: true, closer: true });
      while (!this.eof() && !this.P(this.p, ';')) this.takeKw();
      if (this.P(this.p, ';')) this.take({ space: false });
      return;
    }
    this.sql(indent, {});
  }

  private timingPointAt(k: number): boolean {
    for (let j = k + 1; j < k + 5 && j < this.sig.length; j++) if (this.W(j, 'IS')) return true;
    return false;
  }

  private subprogram(indent: number): void {
    this.headerCtx++;
    while (!this.W(this.p, 'PROCEDURE') && !this.W(this.p, 'FUNCTION') && !this.eof()) this.takeKw();
    this.takeKw();
    this.takeName();
    if (this.P(this.p, '(')) this.paren('params', true);
    this.expr((k) => this.W(k, 'IS') || this.W(k, 'AS') || this.P(k, ';'), {});
    this.headerCtx--;
    if (this.P(this.p, ';') || this.eof()) { if (!this.eof()) this.take({ space: false }); return; }
    this.takeKw();
    if (this.W(this.p, 'LANGUAGE') || this.W(this.p, 'EXTERNAL')) {
      this.expr((k) => this.P(k, ';'), {});
      if (this.P(this.p, ';')) this.take({ space: false });
      return;
    }
    this.declarations(indent + 1, (k) => this.W(k, 'BEGIN') || this.W(k, 'END'));
    if (this.W(this.p, 'BEGIN')) this.out.newline(indent);
    this.blockBody(indent);
  }

  private plUnit(indent: number, objAt: number): void {
    this.verbCtx = 'CREATE';
    const obj = this.U(objAt);
    if (obj === 'PROCEDURE' || obj === 'FUNCTION') {
      while (this.p < objAt) this.takeKw();
      this.subprogram(indent);
      return;
    }
    this.headerCtx++;
    while (this.p <= objAt) this.takeKw();
    if (obj === 'TRIGGER') {
      this.takeName();
      while (!this.eof()) {
        const u = this.U(this.p);
        if (u === 'DECLARE' || u === 'BEGIN' || (u === 'COMPOUND' && this.W(this.p + 1, 'TRIGGER'))) break;
        if (PL_TRIGGER_LINES.has(u) && this.S(this.p)!.word) {
          this.out.newline(indent);
          this.takeKw(u === 'INSTEAD' ? 2 : 1);
          if (u === 'FOR') while (this.W(this.p, 'EACH') || this.W(this.p, 'ROW')) this.takeKw();
          continue;
        }
        if (this.P(this.p, '(')) this.paren('call');
        else this.take({ kw: this.S(this.p)!.kind === 'keyword' || u === 'ON' });
      }
      this.headerCtx--;
      if (this.W(this.p, 'COMPOUND')) {
        this.out.newline(indent);
        this.takeKw(2);
        this.declarations(indent + 1, (k) => this.W(k, 'END'));
        this.endWith(indent, []);
        return;
      }
      this.out.newline(indent);
      this.plBlock(indent);
      return;
    }
    // PACKAGE [BODY] / TYPE BODY
    if (this.W(this.p, 'BODY')) this.takeKw();
    this.takeName();
    this.expr((k) => this.W(k, 'IS') || this.W(k, 'AS') || this.P(k, ';'), {});
    this.headerCtx--;
    if (!this.W(this.p, 'IS') && !this.W(this.p, 'AS')) { if (this.P(this.p, ';')) this.take({ space: false }); return; }
    this.takeKw();
    this.declarations(indent + 1, (k) => this.W(k, 'BEGIN') || this.W(k, 'END'));
    if (this.W(this.p, 'BEGIN')) {
      this.out.newline(indent);
      this.blockBody(indent);
      return;
    }
    this.endWith(indent, []);
  }

  // ------------------------------------------------------------------ SQLite

  private sqliteStatement(indent: number, outer: Stop): void {
    const k = this.p;
    if (this.W(k, 'CREATE')) {
      let j = k + 1;
      if (this.W(j, 'TEMP') || this.W(j, 'TEMPORARY')) j++;
      if (this.W(j, 'TRIGGER')) return this.sqliteTrigger(indent, j);
    }
    this.sql(indent, { stop: outer });
  }

  private sqliteTrigger(indent: number, trigAt: number): void {
    this.verbCtx = 'CREATE';
    while (this.p <= trigAt) this.takeKw();
    while (this.W(this.p, 'IF') || this.W(this.p, 'NOT') || this.W(this.p, 'EXISTS')) this.takeKw();
    this.takeName();
    while (!this.eof() && !this.W(this.p, 'BEGIN')) {
      const u = this.U(this.p);
      if (SQLITE_TRIGGER_LINES.has(u) && this.S(this.p)!.word) {
        this.out.newline(indent);
        this.takeKw(u === 'INSTEAD' ? 2 : 1);
        if (u === 'FOR') while (this.W(this.p, 'EACH') || this.W(this.p, 'ROW')) this.takeKw();
        if (u === 'WHEN') this.expr((k) => this.W(k, 'BEGIN'), {});
        continue;
      }
      if (this.P(this.p, '(')) this.paren('call');
      else this.take({ kw: this.S(this.p)!.kind === 'keyword' || u === 'OF' });
    }
    if (this.eof()) return;
    this.out.newline(indent);
    this.take({ kw: true, closer: true });
    this.statements(indent + 1, (k) => this.W(k, 'END'));
    this.endWith(indent, []);
  }

  // ------------------------------------------------------------------ SQL statements

  private isCteAt(k: number): boolean {
    if (!this.W(k, 'WITH')) return false;
    let j = k + 1;
    if (this.W(j, 'RECURSIVE')) j++;
    const n = this.S(j);
    if (!n || !(n.kind === 'ident' || n.kind === 'quotedIdent' || (n.kind === 'keyword' && n.u === 'XMLNAMESPACES'))) return false;
    if (n.u === 'XMLNAMESPACES') return true;
    j++;
    if (this.P(j, '(')) j = this.after(j);
    return this.W(j, 'AS');
  }

  private newSt(indent: number, verb: string, stop: Stop, inParen: boolean): St {
    return {
      base: indent, clauseIndent: indent, verb, dml: false, verbs: new Set(), clause: '', list: false, listIndent: indent + 1,
      andOr: false, between: 0, commaBreak: false, insertHasSource: false, seenSet: false, seenCursor: false, stop, inParen,
    };
  }

  /** Words that end any statement at depth 0 (procedural closers). */
  private stopWord(k: number): boolean {
    const t = this.S(k)!;
    if (!t.word) return false;
    if (this.d === 'tsql') return t.u === 'END' || t.u === 'ELSE';
    if (this.d === 'plsql') return t.u === 'END' || t.u === 'ELSIF' || t.u === 'ELSE';
    return t.u === 'END' && this.plDepth > 0;
  }

  /** T-SQL: does the statement-start word at k begin a new statement (no `;` before it)? */
  private isTsqlLabel(k: number): boolean {
    const t = this.S(k), c = this.S(k + 1);
    return !!t && t.kind === 'ident' && !!c && c.kind === 'op' && c.text === ':';
  }

  private tsqlBoundary(k: number, st: St): boolean {
    const t = this.S(k)!;
    if (this.isTsqlLabel(k)) {
      const pv = this.S(k - 1);
      return !!pv && !(pv.kind === 'op' || (pv.kind === 'punct' && pv.text !== ')') || (pv.word && this.rules.incomplete.has(pv.u)));
    }
    if (!t.word || !this.rules.statementStarts.has(t.u)) return false;
    const prev = this.S(k - 1);
    if (!prev) return false;
    if (prev.kind === 'op') return prev.text === ':' && this.isTsqlLabel(k - 2);
    if (prev.kind === 'punct' && (prev.text === ',' || prev.text === '(' || prev.text === '.')) return false;
    if (prev.word && this.rules.incomplete.has(prev.u)) return false;
    const u = t.u;
    if ((u === 'ENABLE' || u === 'DISABLE') && !this.W(k + 1, 'TRIGGER')) return false;
    if (st.verb === 'INSERT' && !st.insertHasSource && (u === 'SELECT' || u === 'WITH' || u === 'EXEC' || u === 'EXECUTE' || u === 'VALUES')) return false;
    if (st.verb === 'UPDATE' && !st.seenSet && u === 'SET') return false;
    if (u === 'SET' && (prev.u === 'DELETE' || prev.u === 'UPDATE') && this.W(k - 2, 'ON')) return false;
    if (u === 'FETCH' && (prev.u === 'ROW' || prev.u === 'ROWS')) return false;
    if (u === 'WITH' && !this.isCteAt(k)) return false;
    if ((st.verb === 'CREATE' || st.verb === 'ALTER' || st.verb === 'DROP') && (u === 'ALTER' || u === 'DROP' || u === 'SET' || u === 'WITH') && !TSQL_OBJECT_KINDS.has(this.U(k + 1))) return false;
    if (st.verb === 'DECLARE' && st.seenCursor && u === 'SELECT') return false;
    if (prev.u === 'RETURN' && this.inlineTvf && (u === 'SELECT' || u === 'WITH')) return false;
    if (u === 'BEGIN' && (prev.u === 'TRAN' || prev.u === 'TRANSACTION')) return true;
    return true;
  }

  /** Clause keyword phrase starting at k: [name, word count] or null. */
  private clauseAt(k: number, st: St): [string, number] | null {
    const t = this.S(k)!;
    if (!t.word || !st.dml) return null;
    const u = t.u;
    const v = st.verbs;
    switch (u) {
      case 'SELECT': return this.P(k - 1, '(') ? null : ['select', 1];
      case 'FROM': return ['from', 1];
      case 'WHERE': return ['where', 1];
      case 'HAVING': return ['having', 1];
      case 'GROUP': return this.W(k + 1, 'BY') ? ['groupBy', 2] : null;
      case 'ORDER':
        if (this.W(k + 1, 'BY')) return ['orderBy', 2];
        if (this.W(k + 1, 'SIBLINGS') && this.W(k + 2, 'BY')) return ['orderBy', 3];
        return null;
      case 'CONNECT': return this.W(k + 1, 'BY') ? ['connect', 2] : null;
      case 'START': return this.W(k + 1, 'WITH') ? ['start', 2] : null;
      case 'UNION': case 'EXCEPT': case 'INTERSECT': case 'MINUS':
        if (!SET_OPERATORS.has(u) || (u === 'MINUS' && this.d !== 'plsql')) return null;
        return ['setop', this.W(k + 1, 'ALL') || this.W(k + 1, 'DISTINCT') ? 2 : 1];
      case 'INTO': return st.clause === 'select' ? ['into', 1] : null;
      case 'BULK': return st.clause === 'select' && this.W(k + 1, 'COLLECT') && this.W(k + 2, 'INTO') ? ['into', 3] : null;
      case 'VALUES': return v.has('INSERT') && !this.W(k - 1, 'DEFAULT') ? ['values', 1] : null;
      case 'EXEC': case 'EXECUTE': return this.d === 'tsql' && st.clause === 'insert' ? ['exec', 1] : null;
      case 'SET': return v.has('UPDATE') && st.clause !== 'set' ? ['set', 1] : null;
      case 'OUTPUT': return this.d === 'tsql' && (v.has('INSERT') || v.has('UPDATE') || v.has('DELETE') || v.has('MERGE')) ? ['output', 1] : null;
      case 'OPTION': return this.d === 'tsql' && this.P(k + 1, '(') ? ['option', 1] : null;
      case 'FOR': {
        const n = this.U(k + 1);
        return v.has('SELECT') && (n === 'XML' || n === 'JSON' || n === 'BROWSE' || n === 'UPDATE' || n === 'READ') ? ['for', 1] : null;
      }
      case 'LIMIT': return this.d !== 'plsql' ? ['limit', 1] : null;
      case 'OFFSET': return ['offset', 1];
      case 'FETCH': return this.W(k + 1, 'FIRST') || this.W(k + 1, 'NEXT') ? ['fetch', 1] : null;
      case 'RETURNING': return v.has('INSERT') || v.has('UPDATE') || v.has('DELETE') ? ['returning', 1] : null;
      case 'WINDOW': return this.d === 'sqlite' && this.W(k + 2, 'AS') ? ['window', 1] : null;
      case 'USING': return v.has('MERGE') && st.clause === 'merge' ? ['using', 1] : null;
      case 'WHEN': return v.has('MERGE') ? ['when', 1] : null;
      case 'ON': return this.d === 'sqlite' && this.W(k + 1, 'CONFLICT') && v.has('INSERT') ? ['conflict', 2] : null;
      default: return null;
    }
  }

  /** JOIN phrase length at k (0 = none). */
  private joinAt(k: number, st: St): number {
    const t = this.S(k)!;
    if (!t.word || !JOIN_WORDS.has(t.u) || !st.dml) return 0;
    if (!(st.clause === 'from' || st.clause === 'join' || st.clause === 'on')) return 0;
    if ((t.u === 'LEFT' || t.u === 'RIGHT') && this.P(k + 1, '(')) return 0;
    let j = k;
    while (j < this.sig.length && j < k + 5) {
      const u = this.U(j);
      if (u === 'JOIN' || u === 'APPLY' || u === 'STRAIGHT_JOIN') return j - k + 1;
      if (!(JOIN_WORDS.has(u) || u === 'SEMI' || u === 'ANTI' || u === 'HASH' || u === 'LOOP' || u === 'MERGE' || u === 'REMOTE')) return 0;
      j++;
    }
    return 0;
  }

  private stEnd(k: number, st: St): boolean {
    if (k >= this.sig.length) return true;
    if (st.stop(k)) return true;
    const t = this.S(k)!;
    if (t.kind === 'batchSep') return true;
    if (t.kind === 'punct' && (t.text === ';' || t.text === ')')) return true;
    if (this.stopWord(k)) return true;
    if (this.d === 'tsql' && !st.inParen && this.tsqlBoundary(k, st)) return true;
    return false;
  }

  /** End (exclusive) of the clause whose content starts at k. */
  private clauseEnd(k: number, st: St): number {
    let j = k;
    while (j < this.sig.length) {
      if (this.stEnd(j, st)) return j;
      if (this.clauseAt(j, st) || this.joinAt(j, st)) return j;
      if (this.W(j, 'CASE')) { j = this.caseEnd(j) + 1; continue; }
      j = this.after(j);
    }
    return j;
  }

  private sql(indent: number, o: { stop?: Stop; inParen?: boolean }): void {
    const st = this.newSt(indent, this.U(this.p), o.stop ?? NEVER, !!o.inParen);
    const savedVerb = this.verbCtx;
    const savedType = this.typeCtx;
    this.verbCtx = st.verb;
    this.statementHead(st);
    this.statementLoop(st);
    this.verbCtx = savedVerb;
    this.typeCtx = savedType;
  }

  private enterDml(st: St, verb: string): void {
    st.dml = true;
    st.verbs.add(verb);
  }

  private statementHead(st: St): void {
    const u = st.verb;
    if (u === 'WITH' && this.isCteAt(this.p)) {
      this.enterDml(st, 'SELECT');
      this.cte(st);
      if (this.eof() || this.P(this.p, ';') || this.P(this.p, ')') || st.stop(this.p) || this.S(this.p)!.kind === 'batchSep') return;
      this.out.newline(st.base);
      st.verb = this.U(this.p);
      if (st.verb === 'WITH') return;
      return this.statementHead(st);
    }
    switch (u) {
      case 'SELECT':
        this.enterDml(st, 'SELECT');
        this.clause(st, 'select', 1, true);
        return;
      case 'VALUES':
        if (this.d === 'sqlite') { this.enterDml(st, 'INSERT'); this.clause(st, 'values', 1, true); }
        else this.takeKw();
        return;
      case 'INSERT': case 'REPLACE': {
        if (u === 'REPLACE' && this.d !== 'sqlite') { this.takeKw(); return; }
        this.enterDml(st, 'INSERT');
        this.takeKw();
        if (this.W(this.p, 'OR')) this.takeKw(2);
        if (this.W(this.p, 'TOP') && this.P(this.p + 1, '(')) { this.takeKw(); this.paren('call'); }
        if (this.W(this.p, 'INTO')) this.takeKw();
        this.target(st);
        if (this.P(this.p, '(')) this.paren('call', true);
        st.clause = 'insert';
        return;
      }
      case 'UPDATE':
        this.enterDml(st, 'UPDATE');
        this.takeKw();
        if (this.W(this.p, 'TOP') && this.P(this.p + 1, '(')) { this.takeKw(); this.paren('call'); }
        if (this.W(this.p, 'OR') && this.d === 'sqlite') this.takeKw(2);
        st.clause = 'from';
        return;
      case 'DELETE':
        this.enterDml(st, 'DELETE');
        this.takeKw();
        if (this.W(this.p, 'TOP') && this.P(this.p + 1, '(')) { this.takeKw(); this.paren('call'); }
        if (this.W(this.p, 'FROM')) this.takeKw();
        st.clause = 'from';
        return;
      case 'MERGE':
        this.enterDml(st, 'MERGE');
        this.takeKw();
        if (this.W(this.p, 'TOP') && this.P(this.p + 1, '(')) { this.takeKw(); this.paren('call'); }
        if (this.W(this.p, 'INTO')) this.takeKw();
        st.clause = 'merge';
        return;
      case 'EXPLAIN': {
        this.takeKw();
        while (this.W(this.p, 'QUERY') || this.W(this.p, 'PLAN') || this.W(this.p, 'ANALYZE')) this.takeKw();
        if (this.W(this.p, 'SET')) return;
        if (this.W(this.p, 'FOR')) this.takeKw();
        const v = this.U(this.p);
        if (v === 'SELECT' || v === 'INSERT' || v === 'UPDATE' || v === 'DELETE' || v === 'MERGE' || v === 'REPLACE' || (v === 'WITH' && this.isCteAt(this.p))) {
          this.out.newline(st.base);
          st.verb = v;
          this.statementHead(st);
        }
        return;
      }
      case 'DECLARE':
        this.takeKw();
        if (this.d === 'tsql') { st.commaBreak = true; this.typeCtx++; st.clause = 'declare'; }
        return;
      case 'EXEC': case 'EXECUTE':
        this.takeKw();
        if (this.d === 'tsql' && !this.P(this.p, '(')) {
          const end = this.stmtExtent(this.p, st);
          st.commaBreak = this.commas(this.p, end) >= 2;
        }
        return;
      default:
        if (u === 'CREATE' || u === 'ALTER') this.typeCtx++;
        this.take({ kw: this.stmtWordKw(this.p) });
    }
  }

  /** First word of a statement: a keyword unless it is used as a name (`count := 1`, `proc(1)`, `t.x`). */
  private stmtWordKw(k: number): boolean {
    const t = this.S(k);
    if (!t || !t.word) return false;
    if (t.kind === 'keyword') return true;
    const n = this.S(k + 1);
    if (n && ((n.kind === 'punct' && (n.text === '(' || n.text === '.' || n.text === ',')) || n.kind === 'op')) return false;
    return this.spec.statementStarts.has(t.u) || this.spec.contextualKeywords.has(t.u) || this.rules.statementStarts.has(t.u);
  }

  /** Contextual (non-reserved) words acting as keywords in their position: OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY… */
  private contextualKw(k: number): boolean {
    const t = this.S(k)!;
    if (t.kind !== 'ident') return false;
    const p = this.U(k - 1), n = this.U(k + 1);
    const pk = this.S(k - 1)?.kind;
    if (t.u === 'INCLUDE' && n === '(') return this.verbCtx === 'CREATE';
    if ((t.u === 'OVER' || t.u === 'FILTER' || t.u === 'COLUMNS') && n === '(') return true;
    if (p === 'PRAGMA') return this.d === 'plsql';
    if ((t.u === 'RECORD' || t.u === 'OBJECT' || t.u === 'VARRAY') && (p === 'IS' || p === 'AS')) return true;
    if (t.u === 'ROW' && p === 'PIPE') return true;
    if (p === '.' && (t.u === 'NEXTVAL' || t.u === 'CURRVAL')) return true;
    if (p === '.' || n === '.' || n === '(') return false;
    if (t.u === 'WITHIN') return n === 'GROUP';
    if (t.u === 'BULK') return n === 'COLLECT';
    if (t.u === 'COLLECT') return p === 'BULK';
    if (t.u === 'PIPE') return n === 'ROW';
    if (t.u === 'LIMIT') return this.verbCtx === 'FETCH';
    if (t.u === 'PATH') return this.S(k + 1)?.kind === 'string';
    if (t.u === 'SQL') return this.S(k + 1)?.kind === 'op' && n.startsWith('%');
    if (t.u === 'CONSTANT') return this.typeCtx > 0 && (pk === 'ident' || pk === 'quotedIdent');
    if (t.u === 'OUT' && this.d === 'plsql') return this.typeCtx > 0 && (p === 'IN' || pk === 'ident' || pk === 'quotedIdent');
    if (t.u === 'NOCOPY') return this.typeCtx > 0;
    if (PL_SUBPROGRAM_PREFIX.has(t.u) && (n === 'FUNCTION' || n === 'PROCEDURE' || PL_SUBPROGRAM_PREFIX.has(n))) return true;
    if (this.headerCtx > 0 && HEADER_WORDS.has(t.u)) return true;
    if ((p === 'CREATE' || p === 'REPLACE' || p === 'EDITIONABLE' || p === 'NONEDITIONABLE') && OBJECT_WORDS.has(t.u)) return true;
    if (this.verbCtx === 'DROP' && (t.u === 'PURGE' || t.u === 'CASCADE' || t.u === 'CONSTRAINTS')) return true;
    if (t.u === 'REPLACE') return p === 'OR';
    if (t.u === 'READ') return n === 'ONLY' || n === 'WRITE';
    if ((this.verbCtx === 'CREATE' || this.verbCtx === 'ALTER') && DDL_WORDS.has(t.u)) {
      if (ITEM_START_WORDS.has(t.u)) return true;
      const pt = this.S(k - 1);
      if (!pt || (pt.kind === 'punct' && (pt.text === '(' || pt.text === ','))) return false;
      if (pt.word && (NAME_PAREN_KEYWORDS.has(pt.u) || pt.u === 'SEQUENCE' || pt.u === 'SYNONYM' || pt.u === 'COLUMN' || pt.u === 'CONSTRAINT')) return false;
      return true;
    }
    if (p === 'PRAGMA') return true;
    if (this.d === 'tsql' && p === 'WAITFOR' && (t.u === 'DELAY' || t.u === 'TIME')) return true;
    if (t.u === 'PERSISTED') return p === ')';
    if (t.u === 'NO') return n === 'ACTION';
    if (t.u === 'ACTION') return p === 'NO';
    if (this.d === 'tsql' && p === 'SET' && (n === 'ON' || n === 'OFF')) return true;
    switch (t.u) {
      case 'ROWS': case 'ROW': return n === 'ONLY' || n === 'FETCH' || n === 'BETWEEN' || n === 'UNBOUNDED' || n === 'CURRENT' || p === 'CURRENT' || p === 'EACH' || pk === 'number' || pk === 'param';
      case 'ONLY': return p === 'ROWS' || p === 'ROW' || p === 'READ';
      case 'NEXT': case 'FIRST': return p === 'FETCH' || p === 'NULLS';
      case 'LAST': return p === 'NULLS';
      case 'TIES': return p === 'WITH';
      case 'MATCHED': return p === 'WHEN' || p === 'NOT';
      case 'PRECEDING': case 'FOLLOWING': return p === 'UNBOUNDED' || p === 'ROW' || pk === 'number';
      case 'UNBOUNDED': return n === 'PRECEDING' || n === 'FOLLOWING';
      case 'PARTITION': return n === 'BY';
      case 'RANGE': return n === 'BETWEEN' || n === 'UNBOUNDED';
      case 'APPLY': return p === 'CROSS' || p === 'OUTER';
      case 'NOLOCK': case 'READUNCOMMITTED': case 'UPDLOCK': case 'ROWLOCK': case 'TABLOCK': case 'HOLDLOCK': case 'NOWAIT': return p === '(' || p === ',';
      case 'NULLS': return n === 'FIRST' || n === 'LAST';
      case 'KEY': return p === 'PRIMARY' || p === 'FOREIGN';
      case 'STRICT': return p === ')' || p === ',';
      case 'ROWID': return p === 'WITHOUT';
      case 'CURRENT': return n === 'ROW';
      case 'OTHERS': return p === 'WHEN' || p === 'OR';
      case 'OUTPUT': case 'OUT': case 'READONLY':
        return this.d === 'tsql' && p !== 'SELECT' && p !== ',' && (pk === 'param' || [',', ')', 'AS', 'WITH', ';', '', 'FOR'].includes(n));
      case 'OFFSET': return this.d === 'tsql' && (this.S(k + 1)?.kind === 'number' || this.S(k + 1)?.kind === 'param');
      default: return false;
    }
  }

  private stmtExtent(k: number, st: St): number {
    let j = k;
    while (j < this.sig.length && !this.stEnd(j, st)) j = this.W(j, 'CASE') ? this.caseEnd(j) + 1 : this.after(j);
    return j;
  }

  /** Target object of INSERT/MERGE (name, optional alias, table hints). */
  private target(st: St): void {
    void st;
    if (this.P(this.p, '(')) return;
    this.takeName();
  }

  private cte(st: St): void {
    this.takeKw();
    if (this.W(this.p, 'RECURSIVE')) this.takeKw();
    while (!this.eof()) {
      if (this.W(this.p, 'XMLNAMESPACES')) { this.takeKw(); if (this.P(this.p, '(')) this.paren('call'); }
      else {
        this.take();
        if (this.P(this.p, '(')) this.paren('call', true);
        if (this.W(this.p, 'AS')) this.takeKw();
        while (this.W(this.p, 'NOT') || this.W(this.p, 'MATERIALIZED')) this.takeKw();
        if (this.P(this.p, '(')) this.paren('expr');
      }
      if (this.P(this.p, ',')) { this.take({ space: false }); continue; }
      break;
    }
    void st;
  }

  /** Emit a clause keyword phrase and set the clause layout. */
  private clause(st: St, name: string, words: number, first = false): void {
    const ownLine = this.o.clauseKeywordsOnOwnLine || name === 'setop';
    if (name === 'when' || name === 'output' || name === 'option') st.clauseIndent = st.base;
    if (!first && ownLine) this.out.newline(st.clauseIndent);
    this.takeKw(words);
    if (name === 'when') while (['NOT', 'MATCHED', 'BY', 'TARGET', 'SOURCE'].includes(this.U(this.p))) this.takeKw();
    st.clause = name;
    st.list = false;
    st.between = 0;
    st.andOr = this.o.andOrOnNewLine && (name === 'where' || name === 'having' || name === 'connect' || name === 'start' || name === 'on');
    if (name === 'select') {
      while (!this.eof() && SELECT_MODIFIERS.has(this.U(this.p))) this.takeKw();
      if (this.W(this.p, 'TOP')) {
        this.takeKw();
        if (this.P(this.p, '(')) this.paren('call');
        else this.take();
        if (this.W(this.p, 'PERCENT')) this.takeKw();
        if (this.W(this.p, 'WITH') && this.W(this.p + 1, 'TIES')) this.takeKw(2);
      }
    }
    if (name === 'set') st.seenSet = true;
    if (name === 'values' || name === 'select') st.insertHasSource = true;
    if (name === 'setop') {
      if (this.P(this.p, '(')) this.out.newline(st.clauseIndent);
      return;
    }
    if (LIST_CLAUSES.has(name) && ownLine) {
      const end = this.clauseEnd(this.p, st);
      const items = this.commas(this.p, end) + 1;
      st.listIndent = st.clauseIndent + 1;
      st.list = end > this.p && (items > 1 || !this.fits(this.p, end));
      if (st.list) this.out.newline(st.listIndent);
    }
  }

  private comma(indent: number, breakAfter: boolean): void {
    if (!breakAfter) { this.take({ space: false }); return; }
    if (this.o.commaStyle === 'leading') {
      this.out.newline(indent);
      this.take({ space: false });
    } else {
      this.take({ space: false });
      this.out.newline(indent);
    }
  }

  private statementLoop(st: St): void {
    while (!this.eof()) {
      const k = this.p;
      if (this.stEnd(k, st)) {
        if (this.P(k, ';') && !st.stop(k)) this.take({ space: false });
        return;
      }
      const t = this.S(k)!;
      if (t.word) {
        const u = t.u;
        // CREATE VIEW … AS SELECT, CREATE TABLE … AS SELECT: the clause machine starts at the query
        if (!st.dml && (u === 'SELECT' || (u === 'WITH' && this.isCteAt(k))) && (st.verb === 'CREATE' || st.verb === 'ALTER') && this.W(k - 1, 'AS')) {
          this.out.newline(st.base);
          st.verb = u;
          this.statementHead(st);
          continue;
        }
        if (!st.dml && u === 'FOR' && st.seenCursor) {
          // T-SQL DECLARE c CURSOR … FOR SELECT …
          this.takeKw();
          this.out.newline(st.base + 1);
          this.sql(st.base + 1, { stop: st.stop, inParen: st.inParen });
          continue;
        }
        if (u === 'CURSOR' && st.verb === 'DECLARE') { st.seenCursor = true; st.commaBreak = false; }
        if (!st.dml && u === 'FOR' && st.verb === 'OPEN' && (this.W(k + 1, 'SELECT') || this.isCteAt(k + 1))) {
          this.takeKw();
          this.out.newline(st.base + 1);
          this.sql(st.base + 1, { stop: st.stop, inParen: st.inParen });
          continue;
        }
        const c = this.clauseAt(k, st);
        if (c) { this.clause(st, c[0], c[1]); continue; }
        const j = this.joinAt(k, st);
        if (j) {
          this.out.newline(st.clauseIndent);
          this.takeKw(j);
          st.clause = 'join';
          st.andOr = false;
          st.between = 0;
          continue;
        }
        if (u === 'ON' && st.dml && st.clause === 'join') {
          this.takeKw();
          st.clause = 'on';
          st.andOr = this.o.andOrOnNewLine;
          st.between = 0;
          continue;
        }
        if (u === 'THEN' && st.clause === 'when') {
          this.takeKw();
          st.clauseIndent = st.base + 1;
          st.clause = 'action';
          this.out.newline(st.clauseIndent);
          if (this.W(this.p, 'UPDATE')) {
            st.verbs.add('UPDATE');
            this.takeKw();
            if (this.W(this.p, 'SET')) { this.clause(st, 'set', 1, true); st.listIndent = st.clauseIndent + 1; }
          } else if (this.W(this.p, 'INSERT')) {
            st.verbs.add('INSERT');
            this.takeKw();
            if (this.P(this.p, '(')) this.paren('call', true);
          } else if (this.W(this.p, 'DELETE')) this.takeKw();
          continue;
        }
        if ((u === 'AND' || u === 'OR') && st.andOr) {
          if (u === 'AND' && st.between > 0) { st.between--; this.takeKw(); continue; }
          this.out.newline(st.clauseIndent + 1);
          this.takeKw();
          continue;
        }
        if (u === 'AND' && st.between > 0) st.between--;
        if (u === 'BETWEEN') st.between++;
        if (u === 'CASE') { this.caseExpr(); continue; }
        if (u === 'DELETE' && st.verbs.has('MERGE') && st.clauseIndent > st.base && st.clause !== 'action') {
          this.out.newline(st.clauseIndent);
          this.takeKw();
          st.clause = 'action';
          continue;
        }
        if (u === 'UPDATE' && this.W(k - 1, 'DO')) st.verbs.add('UPDATE');
        if (st.verb === 'INSERT' && (u === 'SELECT' || u === 'EXEC' || u === 'EXECUTE')) st.insertHasSource = true;
      }
      if (t.kind === 'punct' && t.text === ',' && (st.list || st.commaBreak)) {
        this.comma(st.list ? st.listIndent : st.base + 1, true);
        continue;
      }
      if (t.kind === 'punct' && t.text === '(') {
        const opt = st.clause === 'option';
        if (opt) this.kwIdents++;
        this.paren(this.parenKind(k, st), this.spaceBeforeParen(k));
        if (opt) this.kwIdents--;
        continue;
      }
      const optionWord = t.kind === 'ident' && ((st.clause === 'for' && FOR_WORDS.has(t.u)) || (st.seenCursor && !st.dml && CURSOR_WORDS.has(t.u)));
      this.take({ kw: t.kind === 'keyword' || optionWord || this.contextualKw(k) });
    }
  }

  private parenKind(k: number, st: St): 'columns' | 'call' | 'expr' {
    const a = this.S(k - 1);
    if (!a) return 'expr';
    if (a.word && (a.u === 'OBJECT' || a.u === 'RECORD')) return 'columns';
    if (a.word && a.u === 'TABLE' && (this.S(k - 2)?.kind === 'param' || this.W(k - 2, 'AS') || this.W(k - 2, 'RETURNS'))) return 'columns';
    if (a.word && (a.u === 'ADD' || a.u === 'MODIFY') && st.verb === 'ALTER' && this.d === 'plsql') return 'columns';
    if ((a.kind === 'ident' || a.kind === 'quotedIdent') && (st.verb === 'CREATE')) {
      let j = k - 1;
      while (this.P(j - 1, '.')) j -= 2;
      if (this.W(j - 1, 'TABLE') || (this.W(j - 1, 'EXISTS') && this.W(j - 2, 'NOT') && this.W(j - 4, 'TABLE'))) return 'columns';
    }
    return a.kind === 'ident' || a.kind === 'quotedIdent' || (a.kind === 'keyword' && !this.spaceBeforeParen(k)) ? 'call' : 'expr';
  }

  // ------------------------------------------------------------------ parentheses

  /**
   * `(` at p. Subqueries become blocks; column definitions always wrap one per line; parameter lists wrap when they
   * have more than two items; everything else stays inline when it fits and otherwise wraps one item per line.
   */
  private paren(kind: 'columns' | 'params' | 'call' | 'expr', space?: boolean): void {
    const k = this.p;
    const e = this.match[k];
    if (e < 0) { this.take(); return; }
    const sp = space === undefined ? undefined : space;
    if (e === k + 1) {
      this.take({ space: sp });
      this.take({ space: false });
      return;
    }
    const subquery = this.W(k + 1, 'SELECT') || (this.W(k + 1, 'WITH') && this.isCteAt(k + 1)) || (this.d === 'sqlite' && this.W(k + 1, 'VALUES'));
    if (subquery) {
      this.take({ space: sp });
      const L = this.out.lineIndent;
      this.out.newline(L + 1);
      this.sql(L + 1, { stop: (q) => q >= e, inParen: true });
      this.drainTo(e, L + 1);
      this.out.newline(L);
      this.take({ closer: true });
      return;
    }
    const items = this.commas(k + 1, e) + 1;
    let wrap: boolean;
    if (kind === 'columns') wrap = true;
    else if (kind === 'params') wrap = items > 2 || !this.fits(k, e + 1);
    else wrap = !this.fits(k, e + 1);
    if (kind === 'columns' || kind === 'params') this.typeCtx++;
    this.take({ space: sp });
    if (!wrap) {
      this.expr((q) => q >= e, {});
      this.drainTo(e, this.out.lineIndent + 1);
      this.take({ space: false });
    } else {
      const L = this.out.lineIndent;
      const group = kind === 'expr' && items === 1;
      this.out.newline(L + 1);
      while (this.p < e && !this.eof()) {
        if (this.P(this.p, ',')) { this.comma(L + 1, true); continue; }
        const start = this.p;
        this.expr((q) => q >= e || this.P(q, ','), group && this.o.andOrOnNewLine ? { andOrIndent: L + 1 } : {});
        if (this.p === start) this.take({ kw: this.S(this.p)?.kind === 'keyword' });
      }
      this.out.newline(L);
      this.take({ closer: true });
    }
    if (kind === 'columns' || kind === 'params') this.typeCtx--;
  }

  /** Emit whatever is left before index e (defensive: a nested construct stopped early). */
  private drainTo(e: number, indent: number): void {
    while (this.p < e && !this.eof()) {
      const start = this.p;
      this.expr((q) => q >= e, {});
      if (this.p === start) {
        if (this.out.atLineStart) this.out.newline(indent);
        this.take({ kw: this.S(this.p)?.kind === 'keyword' });
      }
    }
  }

  // ------------------------------------------------------------------ expressions

  /**
   * Emit tokens until `stop` (checked at the current nesting level), delegating parentheses and CASE.
   * `andOrIndent`: break before top-level AND/OR (grouped conditions in wrapped parentheses).
   */
  private expr(stop: Stop, o: { andOrIndent?: number }): void {
    let between = 0;
    while (!this.eof()) {
      const k = this.p;
      if (stop(k)) return;
      const t = this.S(k)!;
      if (t.kind === 'batchSep') return;
      if (t.kind === 'punct' && t.text === ')') return;
      if (t.kind === 'punct' && t.text === ';') return;
      if (t.kind === 'punct' && t.text === '(') {
        this.paren(this.parenKind(k, this.newSt(0, this.verbCtx, NEVER, true)), this.spaceBeforeParen(k));
        continue;
      }
      if (t.word) {
        if (t.u === 'CASE') { this.caseExpr(); continue; }
        if (t.u === 'BETWEEN') between++;
        if ((t.u === 'AND' || t.u === 'OR') && o.andOrIndent !== undefined) {
          if (t.u === 'AND' && between > 0) between--;
          else this.out.newline(o.andOrIndent);
          this.takeKw();
          continue;
        }
        if (t.u === 'AND' && between > 0) between--;
      }
      this.take({ kw: t.kind === 'keyword' || this.contextualKw(k) });
    }
  }

  /** Index of the END closing the CASE at k (or the last index when unmatched). */
  private caseEnd(k: number): number {
    let depth = 0;
    for (let j = k; j < this.sig.length; j = this.after(j)) {
      const t = this.S(j)!;
      if (t.kind === 'batchSep' || (t.kind === 'punct' && (t.text === ';' || t.text === ')'))) return j - 1;
      if (!t.word) continue;
      if (t.u === 'CASE') depth++;
      else if (t.u === 'END') { if (--depth === 0) return j; }
    }
    return this.sig.length - 1;
  }

  private caseExpr(): void {
    const k = this.p;
    const end = this.caseEnd(k);
    if (!this.W(end, 'END')) {
      this.problem ??= 'CASE without END';
      this.takeKw();
      return;
    }
    let whens = 0;
    for (let j = k + 1, depth = 0; j < end; j = this.after(j)) {
      if (this.W(j, 'CASE')) depth++;
      else if (this.W(j, 'END')) depth--;
      else if (depth === 0 && this.W(j, 'WHEN')) whens++;
    }
    const inline = whens <= 1 && this.fits(k, end + 1);
    const atEnd: Stop = (q) => q >= end;
    if (inline) {
      this.takeKw();
      this.expr((q) => q >= end, {});
      this.take({ kw: true });
      return;
    }
    const L = this.out.lineIndent;
    this.takeKw();
    this.expr((q) => atEnd(q) || this.W(q, 'WHEN') || this.W(q, 'ELSE'), {});
    while (this.p < end && (this.W(this.p, 'WHEN') || this.W(this.p, 'ELSE'))) {
      this.out.newline(L + 1);
      const when = this.W(this.p, 'WHEN');
      this.takeKw();
      if (when) {
        this.expr((q) => atEnd(q) || this.W(q, 'THEN'), {});
        if (this.W(this.p, 'THEN')) this.takeKw();
      }
      this.expr((q) => atEnd(q) || this.W(q, 'WHEN') || this.W(q, 'ELSE'), {});
    }
    this.drainTo(end, L + 1);
    this.out.newline(L);
    this.take({ kw: true, closer: true });
  }
}

/** Visual column (tabs expanded to `tab` stops) of offset `at` in `text`. */
function visualColumn(text: string, at: number, tab: number): number {
  let col = 0;
  for (let i = text.lastIndexOf('\n', at - 1) + 1; i < at; i++) col = text[i] === '\t' ? col + tab - (col % tab) : col + 1;
  return col;
}

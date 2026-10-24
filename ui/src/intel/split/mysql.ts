// MySQL / MariaDB statement splitter (plan-batch3 WP-MY). Part of the lazy mysql chunk (DialectSpec.split): no runtime
// imports, the SplitKit and the builder are all it uses.
//
// - `DELIMITER xx` lines (the mysql client command; the lexer hook makes the line one `meta` token) switch the
//   statement delimiter and are not statements themselves: nothing of them is executed. With a custom delimiter a
//   statement runs to the next occurrence of the delimiter outside strings, comments and quoted identifiers (raw text
//   match like the mysql client: `END$$`, `END //`, `END;;`, `END|`), the delimiter is not part of the statement text.
//   `DELIMITER ;` restores the default.
// - With `;`, compound statements stay whole without DELIMITER: CREATE [DEFINER = …] [AGGREGATE] PROCEDURE | FUNCTION |
//   TRIGGER | EVENT (and ALTER EVENT … DO) bodies, MariaDB's top-level BEGIN NOT ATOMIC / IF / CASE / LOOP / REPEAT /
//   WHILE / `lbl:` blocks. BEGIN … END, IF … END IF, CASE … END [CASE], LOOP … END LOOP, WHILE … END WHILE, REPEAT …
//   UNTIL … END REPEAT nest; IF / REPEAT / WHILE / LOOP only open a block in statement position (`IF(`, `REPEAT(` in
//   expressions are functions). A top-level `BEGIN;` / `BEGIN WORK` starts a transaction.
// - `\G` / `\g` end a statement like `;`; so do a stray `$$` / `//` (a routine selected without its DELIMITER lines).
//   These terminators are not part of the text but are inside the statement range [start, end], so the cursor right
//   after `END$$` still runs that statement.
// - Every statement is its own batch (SplitBuilder.add numbers non-T-SQL batches by statement).
import type { DialectSplitter, SplitKit } from '../dialect/spec';
import type { SplitBuilder, SplitOptions, SplitStatement } from './splitter';
import type { Token } from '../types';

const ROUTINES = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT']);
/** Object words after CREATE that rule out a routine (the CREATE header scan stops there). */
const NOT_ROUTINE = new Set([
  'TABLE', 'VIEW', 'INDEX', 'DATABASE', 'SCHEMA', 'USER', 'ROLE', 'SEQUENCE', 'SERVER', 'TABLESPACE', 'LOGFILE', 'SPATIAL',
  'FULLTEXT', 'UNIQUE', 'TEMPORARY', 'RESOURCE', 'PACKAGE', 'SYNONYM',
]);
const COMPOUND_START = new Set(['IF', 'CASE', 'LOOP', 'REPEAT', 'WHILE']);
/** END IF / END LOOP … : the word after END belongs to the END. */
const END_SUFFIX = new Set(['IF', 'CASE', 'LOOP', 'REPEAT', 'WHILE']);
/** Words after which IF / REPEAT / WHILE / LOOP start a statement (else `IF(` / `REPEAT(` are function calls). */
const STATEMENT_PREV = new Set(['BEGIN', 'THEN', 'ELSE', 'DO', 'LOOP', 'REPEAT', 'ROW']);

const word = (t: Token | undefined, kit: SplitKit): string => (t && kit.isWordTok(t) ? t.upper : '');
const isTerminator = (t: Token): boolean =>
  (t.kind === 'punct' && t.text === ';') || (t.kind === 'op' && (t.text === '\\G' || t.text === '\\g' || t.text === '$$' || t.text === '//'));

/** 1-based line / column of a document offset, counted from a token whose position is known. */
function posAt(b: SplitBuilder, from: Token, offset: number): { line: number; col: number } {
  let line = from.line;
  for (let i = b.text.indexOf('\n', from.start); i >= 0 && i < offset; i = b.text.indexOf('\n', i + 1)) line++;
  return { line, col: offset - (b.text.lastIndexOf('\n', offset - 1) + 1) + 1 };
}

/** The statement range also covers its non-`;` terminator (text stays without it). */
function extendTo(b: SplitBuilder, st: SplitStatement | null, end: number): void {
  if (!st || end <= st.end) return;
  const p = posAt(b, b.tokens[st.tokStart], end);
  st.end = end;
  st.endLine = p.line;
  st.endCol = p.col;
}

/** Is the statement starting at sig index k a compound one (routine definition or MariaDB block)? */
function isCompound(b: SplitBuilder, sig: number[], k: number, kit: SplitKit): boolean {
  const toks = b.tokens;
  const at = (j: number) => (j < sig.length ? toks[sig[j]] : undefined);
  const u = word(at(k), kit);
  if (u === 'CREATE' || u === 'ALTER') {
    for (let j = k + 1; j < sig.length && j <= k + 24; j++) {
      const x = at(j)!;
      if (x.kind === 'punct' && x.text === ';') return false;
      const w = word(x, kit);
      if (ROUTINES.has(w)) return u === 'CREATE' || w === 'EVENT';
      if (NOT_ROUTINE.has(w)) return false;
    }
    return false;
  }
  if (u === 'BEGIN') return word(at(k + 1), kit) === 'NOT' && word(at(k + 2), kit) === 'ATOMIC';
  if (COMPOUND_START.has(u)) return true;
  // lbl: BEGIN | LOOP | REPEAT | WHILE
  const c = at(k + 1);
  return at(k)?.kind === 'ident' && !!c && c.kind === 'op' && c.text === ':' && ['BEGIN', 'LOOP', 'REPEAT', 'WHILE'].includes(word(at(k + 2), kit));
}

/**
 * Default delimiter: one statement from sig index k. Returns the sig index to continue at.
 */
function splitDefault(b: SplitBuilder, sig: number[], k: number, opts: SplitOptions, kit: SplitKit): number {
  const toks = b.tokens;
  const compound = isCompound(b, sig, k, kit);
  let parens = 0, depth = 0, last = k, j = k;
  for (; j < sig.length; j++) {
    const x = toks[sig[j]];
    if (x.kind === 'meta') break;
    if (!compound && j > k && parens === 0 && depth === 0 && opts.blankLineSplitsStatements && kit.hasBlankLine(b.text, toks[sig[j - 1]].end, x.start)) break;
    if (x.kind === 'punct') {
      if (x.text === '(') parens++;
      else if (x.text === ')') parens = Math.max(0, parens - 1);
    }
    if (parens === 0 && depth === 0 && isTerminator(x)) {
      const st = b.add(sig[k], sig[last]);
      if (x.text !== ';') extendTo(b, st, x.end);
      return j + 1;
    }
    if (parens === 0 && kit.isWordTok(x)) {
      const u = x.upper;
      if (u === 'CASE') depth++;
      else if (u === 'END') {
        if (depth > 0) depth--;
        if (END_SUFFIX.has(word(toks[sig[j + 1]], kit))) { last = ++j; continue; }
      } else if (compound) {
        if (u === 'BEGIN') {
          // the statement's own BEGIN is a block only as BEGIN NOT ATOMIC (isCompound checked it)
          depth++;
        } else if (u === 'IF' || u === 'LOOP' || u === 'REPEAT' || u === 'WHILE') {
          const prev = j > k ? toks[sig[j - 1]] : undefined;
          const statementPos = !prev
            || (prev.kind === 'punct' && prev.text === ';')
            || (prev.kind === 'op' && prev.text === ':')
            || STATEMENT_PREV.has(word(prev, kit));
          if (statementPos) depth++;
        }
      }
    }
    last = j;
  }
  b.add(sig[k], sig[last]);
  return j;
}

/**
 * Custom delimiter: one statement from token index `first` (a significant token) up to the next delimiter occurrence
 * outside strings / comments / quoted identifiers, a `\G`, or a DELIMITER line. Returns the token index to resume at.
 */
function splitCustom(b: SplitBuilder, first: number, delim: string): number {
  const toks = b.tokens, text = b.text;
  let lastSig = -1;
  let np = text.indexOf(delim, toks[first].start);
  /** `cut`: the delimiter starts inside the last token (an odd delimiter glued to a word), so the text ends there. */
  const emit = (lastTi: number, cut: number | null, termEnd: number | null) => {
    if (lastTi < first) return;
    const body = cut !== null ? text.slice(toks[first].start, cut).replace(/\s+$/, '') : null;
    if (body === '') return;
    const st = b.add(first, lastTi, body !== null ? { text: body } : undefined);
    if (termEnd !== null) extendTo(b, st, termEnd);
  };
  for (let i = first; i < toks.length; i++) {
    const x = toks[i];
    if (x.kind === 'eof') break;
    if (x.kind === 'meta') { emit(lastSig, null, null); return i; }
    if (x.kind === 'comment') continue;
    if (np >= 0 && np < x.start) np = text.indexOf(delim, x.start); // the previous hit was inside a skipped token
    if (x.kind === 'op' && (x.text === '\\G' || x.text === '\\g')) { emit(lastSig, null, x.end); return i + 1; }
    if (x.kind !== 'string' && x.kind !== 'quotedIdent' && np >= 0 && np < x.end) {
      const termEnd = np + delim.length;
      emit(np > x.start ? i : lastSig, np > x.start ? np : null, termEnd);
      let r = i;
      while (r < toks.length && toks[r].kind !== 'eof' && toks[r].start < termEnd) r++;
      return r;
    }
    lastSig = i;
  }
  emit(lastSig, null, null);
  return toks.length;
}

export const splitMysql: DialectSplitter = (b, sig, opts, kit) => {
  const toks = b.tokens;
  let delim = ';';
  let k = 0;
  while (k < sig.length) {
    const t = toks[sig[k]];
    if (t.kind === 'meta') {
      const m = /^DELIMITER[ \t]+(\S+)/i.exec(t.text);
      if (m) delim = m[1];
      k++;
      continue;
    }
    if (delim === ';') {
      if (isTerminator(t)) { k++; continue; }
      k = splitDefault(b, sig, k, opts, kit);
      continue;
    }
    const resume = splitCustom(b, sig[k], delim);
    while (k < sig.length && sig[k] < resume) k++;
  }
};

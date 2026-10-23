// Snowflake statement splitter (plan-batch3 WP-SF). Part of the lazy snowflake chunk (DialectSpec.split): no runtime
// imports, use the SplitKit. `$$ … $$` bodies are single string tokens already (lexer dollarQuotes), so CREATE PROCEDURE
// … AS $$ …; … $$ and EXECUTE IMMEDIATE $$ … $$ stay whole. This adds Snowflake Scripting blocks written without `$$`:
// `DECLARE … BEGIN … END;` and `BEGIN <statement>; … END;` are one statement (BEGIN, IF, FOR, WHILE, REPEAT, LOOP and
// CASE open a level, END closes it, END IF / END FOR / … close what they name). `BEGIN;` / `BEGIN TRANSACTION` /
// `BEGIN WORK` / `BEGIN NAME t` start a transaction and end at their `;` like any statement.
import type { DialectSplitter } from '../dialect/spec';

const OPENERS = new Set(['BEGIN', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'LOOP', 'IF']);
const NAMED_END = new Set(['IF', 'FOR', 'WHILE', 'REPEAT', 'LOOP', 'CASE']);
const TX_BEGIN = new Set(['TRANSACTION', 'WORK', 'NAME']);

export const splitSnowflake: DialectSplitter = (b, sig, opts, kit) => {
  const toks = b.tokens;
  const word = (k: number) => (k < sig.length && kit.isWordTok(toks[sig[k]]) ? toks[sig[k]].upper : '');
  const isSemi = (k: number) => k < sig.length && toks[sig[k]].kind === 'punct' && toks[sig[k]].text === ';';
  const startsBlock = (k: number) => word(k) === 'DECLARE' || (word(k) === 'BEGIN' && k + 1 < sig.length && !isSemi(k + 1) && !TX_BEGIN.has(word(k + 1)));

  // Plain statements: the shared semicolon splitter (CASE … END, parentheses, blank lines). Blocks: handled here.
  let k = 0;
  let plainFrom = 0;
  const flushPlain = (to: number) => {
    if (to > plainFrom) kit.splitSemicolon(b, sig.slice(plainFrom, to), opts);
  };
  while (k < sig.length) {
    const atStart = k === 0 || isSemi(k - 1);
    if (!atStart || !startsBlock(k)) { k++; continue; }
    flushPlain(k);
    let depth = 0, declares = 0, parens = 0, j = k, last = k, ended = -1;
    for (; j < sig.length; j++) {
      const t = toks[sig[j]];
      if (t.kind === 'punct') {
        if (t.text === '(') parens++;
        else if (t.text === ')') parens = Math.max(0, parens - 1);
        else if (t.text === ';' && parens === 0 && depth === 0) { ended = j; break; }
      } else if (kit.isWordTok(t)) {
        const u = t.upper;
        const prevEnd = j > k && word(j - 1) === 'END';
        if (u === 'DECLARE') { depth++; declares++; }
        else if (u === 'BEGIN' && declares > 0 && !prevEnd) declares--;
        else if (u === 'END' && depth > 0) {
          depth--;
          if (NAMED_END.has(word(j + 1))) { j++; last = j; continue; }
        } else if (!prevEnd && OPENERS.has(u)) {
          const cursorFor = u === 'FOR' && word(j - 1) === 'CURSOR';
          const ifExists = u === 'IF' && (word(j + 1) === 'EXISTS' || word(j + 1) === 'NOT');
          if (!cursorFor && !ifExists) depth++;
        }
      }
      last = j;
    }
    b.add(sig[k], sig[last]);
    k = ended >= 0 ? ended + 1 : Math.max(j, last + 1);
    plainFrom = k;
  }
  flushPlain(sig.length);
};

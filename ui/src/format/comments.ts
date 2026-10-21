// Formatter token preparation and comment attachment (PLAN-M1.5 1.2 step 5).
//
// Every comment is attached to a neighbour by the layout engine:
// - trailing: a comment on the same line as the token before it (`a, -- note`). Re-emitted right after that token,
//   one space apart; a `--` comment (or a multi-line block comment) forces the next token onto a new line.
// - inline: a block comment between two tokens of one line (`SELECT /*+ hint */ a`). Re-emitted in place.
// - leading: a comment on its own line. Re-emitted on its own line at the indent of the next emitted line,
//   keeping up to `maxConsecutiveBlankLines` blank lines before it.
// Comment text is never changed, except that the continuation lines of a multi-line block comment move by as many
// columns as its first line moved (their indentation relative to the comment start is kept).
import type { Token } from '../intel/types';

export interface FTok {
  t: Token;
  kind: Token['kind'];
  text: string;
  /** Upper-cased text for words and `%ATTR` operators; the text otherwise. */
  u: string;
  /** Index in the chunk's token array (comments included). */
  ai: number;
  /** Newlines between the previous token (comment or not) and this one. */
  nl: number;
  /** keyword or identifier. */
  word: boolean;
  /** A `--` comment, or any token whose text spans lines. */
  breaksAfter: boolean;
}

export function countNewlines(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = text.indexOf('\n', from); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Wrap tokens [from, to) of a document for the layout engine (`eof` excluded). */
export function prepareTokens(tokens: Token[], text: string, from: number, to: number): FTok[] {
  const out: FTok[] = [];
  let prevEnd = from < tokens.length ? tokens[from].start : 0;
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.kind === 'eof') break;
    const word = t.kind === 'keyword' || t.kind === 'ident';
    const multiLine = t.text.indexOf('\n') >= 0;
    out.push({
      t, kind: t.kind, text: t.text,
      u: word || t.kind === 'batchSep' || (t.kind === 'op' && t.upper.startsWith('%')) ? t.upper : t.text,
      ai: out.length,
      nl: i === from ? 0 : countNewlines(text, prevEnd, t.start),
      word,
      breaksAfter: (t.kind === 'comment' && t.text.startsWith('--')) || multiLine || t.kind === 'meta',
    });
    prevEnd = t.end;
  }
  return out;
}

export type CommentRole = 'leading' | 'trailing' | 'inline';

/** Role of comment `c` given the next token (null at the end of the chunk). */
export function commentRole(c: FTok, next: FTok | null): CommentRole {
  if (c.nl > 0) return 'leading';
  if (c.breaksAfter || !next || next.nl > 0) return 'trailing';
  return 'inline';
}

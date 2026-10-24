// CQL statement splitter (plan-batch3 WP-CS). Part of the lazy cql chunk (DialectSpec.split): no runtime imports, use
// the SplitKit.
// - `BEGIN [UNLOGGED | COUNTER] BATCH … APPLY BATCH` is one statement, whatever `;` it holds (the `;` after APPLY BATCH
//   ends it). A batch without APPLY BATCH runs to the end of the text.
// - `$$ … $$` UDF bodies and strings are single tokens, so their `;` never split.
// - Everything else: the default splitter (`;` outside parentheses; a blank line when blankLineSplitsStatements is on).
import type { DialectSplitter } from '../dialect/spec';
import type { Token } from '../types';

const word = (t: Token | undefined, w: string) => !!t && (t.kind === 'keyword' || t.kind === 'ident') && t.upper === w;

export const splitCql: DialectSplitter = (b, sig, opts, kit) => {
  const toks = b.tokens;
  const at = (k: number) => (k < sig.length ? toks[sig[k]] : undefined);
  /** Index (in sig) of BATCH when a batch starts at k, else -1. */
  const batchAt = (k: number): number => {
    if (!word(at(k), 'BEGIN')) return -1;
    if (word(at(k + 1), 'BATCH')) return k + 1;
    if ((word(at(k + 1), 'UNLOGGED') || word(at(k + 1), 'COUNTER')) && word(at(k + 2), 'BATCH')) return k + 2;
    return -1;
  };
  let from = 0;
  let k = 0;
  while (k < sig.length) {
    if (batchAt(k) < 0) { k++; continue; }
    // the statements before the batch
    if (k > from) kit.splitSemicolon(b, sig.slice(from, k), opts);
    let j = batchAt(k) + 1;
    let last = sig.length - 1;
    for (; j < sig.length; j++) {
      if (word(at(j), 'APPLY') && word(at(j + 1), 'BATCH')) { last = j + 1; break; }
    }
    b.add(sig[k], sig[last]);
    k = last + 1;
    while (k < sig.length && at(k)!.kind === 'punct' && at(k)!.text === ';') k++;
    from = k;
  }
  if (from < sig.length) kit.splitSemicolon(b, from === 0 ? sig : sig.slice(from), opts);
};

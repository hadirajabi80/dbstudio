// Server filter rewrite (PLAN-M1.5 1.1.1):
//   [WITH …] SELECT * FROM (<original without top-level ORDER BY>) [AS] q WHERE <predicate> [ORDER BY <hoisted>]
// Statement structure comes from the intel lexer/splitter (comments, strings and brackets are respected).
import type { Dialect } from '../api/types';
import { createIntel, getSpec, tokenize, type Intel, type Token } from '../intel';

const intels = new Map<Dialect, Intel>();
function intelFor(d: Dialect): Intel {
  let i = intels.get(d);
  if (!i) {
    i = createIntel(d, { blankLineSplitsStatements: false });
    intels.set(d, i);
  }
  return i;
}

/** `sql` is exactly one SELECT statement (a `WITH …` prefix, comments and a trailing semicolon allowed). */
export function isSingleSelect(sql: string, dialect: Dialect): boolean {
  const intel = intelFor(dialect);
  const uri = 'filter://kind';
  intel.setDocument(uri, sql);
  const sts = intel.statements(uri).filter((s) => s.kind !== 'empty');
  return sts.length === 1 && sts[0].kind.startsWith('select');
}

export interface SelectAnalysis {
  ok: true;
  /** `WITH …` prefix (hoisted outside the wrapper), or ''. */
  cte: string;
  /** Main query text without the top-level ORDER BY (when hoistable) and without trailing `;`. */
  body: string;
  /** Top-level ORDER BY item list (without the keywords), or null. */
  orderBy: string | null;
  /** ORDER BY rewritten for the wrapper (`q.` prefixes), or null when it cannot be hoisted safely. */
  outerOrderBy: string | null;
  /** The original limits its rows (TOP / LIMIT / FETCH FIRST / OFFSET / ROWNUM). */
  limited: boolean;
  /** T-SQL `OPTION (…)` query hint, moved to the end of the wrapper. */
  option: string;
}

export type AnalysisResult = SelectAnalysis | { ok: false; reason: string };

const SIG = (t: Token) => t.kind !== 'ws' && t.kind !== 'comment' && t.kind !== 'eof' && t.kind !== 'batchSep';

/** Is this a single SELECT (CTEs allowed) that can be wrapped? */
export function analyzeSelect(sql: string, dialect: Dialect): AnalysisResult {
  const intel = intelFor(dialect);
  const uri = 'filter://analyze';
  intel.setDocument(uri, sql);
  const sts = intel.statements(uri).filter((s) => s.kind !== 'empty');
  if (sts.length !== 1) return { ok: false, reason: 'Server filtering needs a single SELECT' };
  const st = sts[0];
  if (!st.kind.startsWith('select')) return { ok: false, reason: 'Server filtering needs a single SELECT' };
  const text = st.text.replace(/;\s*$/, '');
  const toks = tokenize(text, getSpec(dialect)).filter(SIG);
  if (toks.length === 0) return { ok: false, reason: 'Server filtering needs a single SELECT' };

  // Depth of each token (parentheses only).
  const depth: number[] = [];
  let dd = 0;
  for (const t of toks) {
    if (t.text === ')') dd--;
    depth.push(dd);
    if (t.text === '(') dd++;
  }
  const kw = (i: number, ...words: string[]) => toks[i] && (toks[i].kind === 'keyword' || toks[i].kind === 'ident') && words.includes(toks[i].upper);

  // CTE prefix: WITH … up to the first SELECT at depth 0.
  let mainStart = 0;
  if (kw(0, 'WITH')) {
    const sel = toks.findIndex((_t, i) => i > 0 && depth[i] === 0 && kw(i, 'SELECT'));
    if (sel < 0) return { ok: false, reason: 'Server filtering needs a single SELECT' };
    mainStart = sel;
  } else if (!kw(0, 'SELECT') && toks[0].text !== '(') {
    return { ok: false, reason: 'Server filtering needs a single SELECT' };
  }
  const cte = mainStart > 0 ? text.slice(toks[0].start, toks[mainStart].start).trim() : '';

  for (let i = mainStart; i < toks.length; i++) {
    if (depth[i] !== 0) continue;
    if (kw(i, 'INTO') && dialect === 'tsql') return { ok: false, reason: 'SELECT … INTO cannot be filtered on the server' };
    if (kw(i, 'FOR') && (kw(i + 1, 'XML', 'JSON', 'BROWSE') || kw(i + 1, 'UPDATE'))) {
      return { ok: false, reason: `FOR ${toks[i + 1].upper} queries cannot be filtered on the server` };
    }
  }

  // Limits anywhere at depth 0 of the main query.
  let limited = false;
  let hasTop = false;
  for (let i = mainStart; i < toks.length; i++) {
    if (depth[i] !== 0) continue;
    if (kw(i, 'TOP') && dialect === 'tsql') limited = hasTop = true;
    if (kw(i, 'LIMIT') && dialect === 'sqlite') limited = true;
    if (kw(i, 'FETCH') && kw(i + 1, 'FIRST', 'NEXT')) limited = true;
    if (kw(i, 'OFFSET')) limited = true;
    if (kw(i, 'ROWNUM') && dialect === 'plsql') limited = true;
  }

  // Last top-level ORDER BY of the main query.
  let ob = -1;
  for (let i = toks.length - 2; i >= mainStart; i--) {
    if (depth[i] === 0 && kw(i, 'ORDER') && kw(i + 1, 'BY')) {
      ob = i;
      break;
    }
  }
  // OPTION (…) hint at the very end (T-SQL)
  let optStart = -1;
  if (dialect === 'tsql') {
    for (let i = mainStart; i < toks.length; i++) if (depth[i] === 0 && kw(i, 'OPTION') && toks[i + 1]?.text === '(') optStart = i;
  }
  const option = optStart >= 0 ? text.slice(toks[optStart].start).trim() : '';
  const endTok = optStart >= 0 ? optStart : toks.length;
  const mainEnd = optStart >= 0 ? toks[optStart].start : text.length;

  let orderBy: string | null = null;
  let body = text.slice(toks[mainStart].start, mainEnd).trim();
  let outerOrderBy: string | null = null;
  if (ob >= 0) {
    // ORDER BY items end at OFFSET / FETCH / LIMIT (those stay inside with the ORDER BY that defines them).
    let itemsEnd = endTok;
    for (let i = ob + 2; i < endTok; i++) {
      if (depth[i] === 0 && (kw(i, 'OFFSET', 'LIMIT') || (kw(i, 'FETCH') && kw(i + 1, 'FIRST', 'NEXT')))) {
        itemsEnd = i;
        break;
      }
    }
    const itemsText = text.slice(toks[ob + 2]?.start, itemsEnd < toks.length ? toks[itemsEnd].start : mainEnd).trim();
    orderBy = itemsText || null;
    outerOrderBy = orderBy ? hoistOrderBy(toks.slice(ob + 2, itemsEnd), depth.slice(ob + 2, itemsEnd), text, dialect) : null;
    // ORDER BY that defines a limit (OFFSET/FETCH/LIMIT after it, or T-SQL TOP) stays inside; the outer one keeps the order.
    const keepInside = itemsEnd < endTok || hasTop;
    if (!keepInside) body = text.slice(toks[mainStart].start, toks[ob].start).trim();
  }
  return { ok: true, cte, body, orderBy, outerOrderBy, limited, option };
}

/**
 * ORDER BY items for the wrapper: `alias.col` / `col` → `q.col`; ordinals stay; expressions get their
 * qualifiers replaced by `q.`. Returns null if an item cannot be expressed against the wrapper.
 * Oracle: the column after `q.` is always quoted (an unquoted name folds to upper case, as Oracle itself does), the
 * same way the filter predicate quotes result columns, so case-sensitive identifiers survive the hoist.
 */
function hoistOrderBy(items: Token[], depth: number[], text: string, dialect: Dialect): string | null {
  const col = (t: Token) => (dialect === 'plsql' && t.kind === 'ident' ? `"${t.text.toUpperCase()}"` : t.text);
  const groups: Token[][] = [[]];
  items.forEach((t, i) => {
    if (depth[i] === 0 && t.text === ',') groups.push([]);
    else groups[groups.length - 1].push(t);
  });
  const out: string[] = [];
  for (const g of groups) {
    if (g.length === 0) return null;
    // split trailing modifiers
    let end = g.length;
    while (end > 0 && /^(ASC|DESC|NULLS|FIRST|LAST)$/.test(g[end - 1].upper) && g[end - 1].kind !== 'quotedIdent') end--;
    const mods = g.slice(end).map((t) => t.upper).join(' ');
    const expr = g.slice(0, end);
    if (expr.length === 0) return null;
    let rendered: string;
    if (expr.length === 1 && expr[0].kind === 'number') rendered = expr[0].text;
    else if (isChain(expr)) rendered = `q.${col(expr[expr.length - 1])}`;
    else {
      // expression: replace each identifier chain a.b → q.b
      let s = '';
      for (let i = 0; i < expr.length; i++) {
        const t = expr[i];
        const gap = i > 0 ? text.slice(expr[i - 1].end, t.start) : '';
        s += gap;
        if ((t.kind === 'ident' || t.kind === 'quotedIdent') && expr[i + 1]?.text === '.' && (expr[i + 2]?.kind === 'ident' || expr[i + 2]?.kind === 'quotedIdent')) {
          let j = i;
          while (expr[j + 1]?.text === '.' && (expr[j + 2]?.kind === 'ident' || expr[j + 2]?.kind === 'quotedIdent')) j += 2;
          s += `q.${col(expr[j])}`;
          i = j;
        } else s += t.text;
      }
      rendered = s;
    }
    out.push(mods ? `${rendered} ${mods}` : rendered);
  }
  return out.join(', ');
}

function isChain(ts: Token[]): boolean {
  if (ts.length % 2 === 0) return false;
  for (let i = 0; i < ts.length; i++) {
    if (i % 2 === 0 ? ts[i].kind !== 'ident' && ts[i].kind !== 'quotedIdent' : ts[i].text !== '.') return false;
  }
  return true;
}

export interface RewriteResult {
  sql: string;
  limited: boolean;
  /** Hoisted ORDER BY, when there was one. */
  orderBy: string | null;
}

/** Wrap a SELECT with a WHERE predicate. Throws a plain Error with a user-facing reason when not possible. */
export function rewriteWithPredicate(sql: string, dialect: Dialect, where: string): RewriteResult {
  const a = analyzeSelect(sql, dialect);
  if (!a.ok) throw new Error(a.reason);
  const alias = dialect === 'plsql' ? 'q' : 'AS q';
  const indent = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n');
  const parts = [a.cte, `SELECT * FROM (\n${indent(a.body)}\n) ${alias}`, `WHERE ${where}`];
  if (a.outerOrderBy) parts.push(`ORDER BY ${a.outerOrderBy}`);
  if (a.option) parts.push(a.option);
  return { sql: parts.filter(Boolean).join('\n'), limited: a.limited, orderBy: a.outerOrderBy };
}

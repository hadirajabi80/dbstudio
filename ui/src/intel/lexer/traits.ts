// Batch 3 (plan-batch3 D7/D8): the lexer hook that implements LexTraits (backticks, `#` comments, backslash escapes,
// `$$` bodies, `$1` / `:name` / `@var` / `?` / `{name:Type}` parameters, 0x literals, string prefixes). Lazy-only: the
// Batch 3 dialect modules import it (`lexHook: traitLexer(lex)`), the shell never does, so it costs the initial bundle
// nothing. Type imports only (see the D7 note in intel/dialect/spec.ts).
import type { LexTraits } from '../dialect/spec';
import type { LexHook } from './lexer';

const DOLLAR_TAG = /\$([\p{L}_][\p{L}\p{N}_]*)?\$/uy;
const BRACE_PARAM = /\{\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*[^{}\n]+\}/y;
const isDigit = (c: number) => c >= 48 && c <= 57;

/** The hook for a set of traits (DialectSpec.lexHook). */
export function traitLexer(lex: LexTraits): LexHook {
  const prefixes = lex.paramPrefixes ?? '';
  const stringPrefixes = lex.stringPrefixes ?? '';
  return (lx, start, c, c1) => {
    const t = lx.text;
    const n = t.length;
    // # line comment
    if (c === 35 && lex.hashComment) {
      let e = t.indexOf('\n', start);
      if (e < 0) e = n;
      if (e > start && t.charCodeAt(e - 1) === 13) e--;
      lx.pos = e;
      return lx.make('comment', start, e);
    }
    // '…' (and X'…' / B'…' / N'…' prefixes): backslash escapes when the dialect has them
    const prefixed = c1 === 39 && stringPrefixes.includes(String.fromCharCode(c).toUpperCase());
    if (c === 39 || prefixed) {
      const body = start + (prefixed ? 2 : 1);
      if (lex.backslashEscapes) {
        const [end, ok] = lx.scanEString(body);
        lx.endState = ok ? '' : 'e';
        return lx.multi('string', start, end, !ok);
      }
      if (!prefixed) return null; // plain '…': the lexer's own scanner
      const [end, ok] = lx.scanString(body, 39);
      lx.endState = ok ? '' : 's';
      return lx.multi('string', start, end, !ok);
    }
    // $1 parameters, $$…$$ / $tag$…$tag$ bodies
    if (c === 36) {
      if (lex.dollarParams && isDigit(c1)) {
        let p = start + 1;
        while (p < n && isDigit(t.charCodeAt(p))) p++;
        lx.pos = p;
        return lx.make('param', start, p);
      }
      if (lex.dollarQuotes) {
        DOLLAR_TAG.lastIndex = start;
        const m = DOLLAR_TAG.exec(t);
        if (m) {
          const tag = m[1] ?? '';
          const [end, ok] = lx.scanDollar(start + m[0].length, tag);
          lx.endState = ok ? '' : 'd' + tag;
          return lx.multi('string', start, end, !ok);
        }
      }
      return null;
    }
    // `quoted identifier`
    if (c === 96 && lex.backtickIdent) {
      const [end, ok] = lx.scanQuotedIdent(start + 1, 96, true);
      lx.pos = end;
      return lx.make('quotedIdent', start, end, undefined, !ok);
    }
    // 0x1F
    if (c === 48 && (c1 === 120 || c1 === 88) && lex.hexNumbers) {
      let p = start + 2;
      while (p < n && /[0-9a-fA-F]/.test(t[p])) p++;
      lx.pos = p;
      return lx.make('number', start, p);
    }
    // {name:Type}
    if (c === 123 && lex.braceParams) {
      BRACE_PARAM.lastIndex = start;
      const m = BRACE_PARAM.exec(t);
      if (!m) return null;
      lx.pos = start + m[0].length;
      return lx.make('param', start, lx.pos);
    }
    // ? / ?1
    if (c === 63) {
      if (!prefixes.includes('?')) return null;
      let p = start + 1;
      while (p < n && isDigit(t.charCodeAt(p))) p++;
      lx.pos = p;
      return lx.make('param', start, p);
    }
    // :name, @name, @@sysvar (never the :: cast)
    if (c < 128 && prefixes.includes(String.fromCharCode(c))) {
      if (c === 58 && (c1 === 58 || t.charCodeAt(start - 1) === 58)) return null;
      let p = start + 1;
      if (c === 64 && c1 === 64) p++;
      if (!lx.isIdentStart(t.charCodeAt(p))) return null;
      while (p < n && lx.isIdentPart(t.charCodeAt(p))) p++;
      lx.pos = p;
      return lx.make('param', start, p);
    }
    return null;
  };
}

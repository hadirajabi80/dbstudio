import { describe, expect, it } from 'vitest';
import { getSpec } from '../dialect';
import { lexLine, relex, tokenize } from '../lexer/lexer';
import type { Dialect, Token } from '../types';

const kinds = (d: Dialect, s: string) => tokenize(s, getSpec(d)).filter((t) => t.kind !== 'eof').map((t) => `${t.kind}:${t.text}`);
const one = (d: Dialect, s: string): Token => tokenize(s, getSpec(d))[0];

describe('lexer: common', () => {
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: basic select', (d) => {
    expect(kinds(d, 'SELECT a, b FROM t;')).toEqual(['keyword:SELECT', 'ident:a', 'punct:,', 'ident:b', 'keyword:FROM', 'ident:t', 'punct:;']);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: always ends with eof', (d) => {
    const t = tokenize('', getSpec(d));
    expect(t).toHaveLength(1);
    expect(t[0].kind).toBe('eof');
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: line comment to end of line', (d) => {
    expect(kinds(d, 'a -- hello\nb')).toEqual(['ident:a', 'comment:-- hello', 'ident:b']);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: line comment at EOF', (d) => {
    expect(kinds(d, '-- x')).toEqual(['comment:-- x']);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: CRLF line comment excludes \\r', (d) => {
    expect(kinds(d, 'a -- c\r\nb')).toEqual(['ident:a', 'comment:-- c', 'ident:b']);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: block comment', (d) => {
    expect(kinds(d, 'a /* x\ny */ b')).toEqual(['ident:a', 'comment:/* x\ny */', 'ident:b']);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: unterminated block comment', (d) => {
    const t = one(d, '/* open');
    expect(t.kind).toBe('comment');
    expect(t.unterminated).toBe(true);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])("%s: string with '' escape", (d) => {
    expect(kinds(d, "'it''s'")).toEqual(["string:'it''s'"]);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: multi-line string is one token', (d) => {
    const t = tokenize("'a\nb' x", getSpec(d));
    expect(t[0].kind).toBe('string');
    expect(t[1].line).toBe(2);
    expect(t[1].col).toBe(4);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: unterminated string', (d) => {
    const t = one(d, "'abc");
    expect(t.kind).toBe('string');
    expect(t.unterminated).toBe(true);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: double-quoted identifier with "" escape', (d) => {
    expect(kinds(d, '"a""b"')).toEqual(['quotedIdent:"a""b"']);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: unterminated quoted identifier stops at end of line', (d) => {
    const t = tokenize('"abc\nSELECT', getSpec(d));
    expect(t[0].kind).toBe('quotedIdent');
    expect(t[0].unterminated).toBe(true);
    expect(t[0].text).toBe('"abc');
    expect(t[1].upper).toBe('SELECT');
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: numbers', (d) => {
    expect(kinds(d, '1 2.5 .5 1e10 3E-2')).toEqual(['number:1', 'number:2.5', 'number:.5', 'number:1e10', 'number:3E-2']);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: line/col tracking', (d) => {
    const t = tokenize('a\n  b\n\n   c', getSpec(d));
    expect(t.slice(0, 3).map((x) => [x.line, x.col])).toEqual([[1, 1], [2, 3], [4, 4]]);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: unicode identifiers', (d) => {
    expect(kinds(d, 'SELECT Größe, имя, 名前 FROM Café')).toEqual(['keyword:SELECT', 'ident:Größe', 'punct:,', 'ident:имя', 'punct:,', 'ident:名前', 'keyword:FROM', 'ident:Café']);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: operators', (d) => {
    expect(kinds(d, 'a <> b != c <= d >= e || f')).toEqual(['ident:a', 'op:<>', 'ident:b', 'op:!=', 'ident:c', 'op:<=', 'ident:d', 'op:>=', 'ident:e', 'op:||', 'ident:f']);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: very long line', (d) => {
    const s = 'SELECT ' + Array.from({ length: 5000 }, (_, i) => `c${i}`).join(', ') + ' FROM t';
    const t = tokenize(s, getSpec(d));
    expect(t).toHaveLength(1 + 5000 + 4999 + 2 + 1);
    expect(t[t.length - 2].col).toBe(s.length);
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: upper is precomputed for words', (d) => {
    expect(one(d, 'select').upper).toBe('SELECT');
  });
  it.each(['tsql', 'plsql', 'sqlite'] as Dialect[])('%s: offsets are contiguous with source', (d) => {
    const s = "SELECT 'x' /* c */ , [y] -- z\n FROM \"t\"";
    for (const t of tokenize(s, getSpec(d))) expect(s.slice(t.start, t.end)).toBe(t.text);
  });
});

describe('lexer: T-SQL', () => {
  const k = (s: string) => kinds('tsql', s);
  it('nested block comments', () => {
    expect(k('/* a /* b */ c */ x')).toEqual(['comment:/* a /* b */ c */', 'ident:x']);
  });
  it('nested unterminated comment', () => {
    expect(one('tsql', '/* a /* b */ c').unterminated).toBe(true);
  });
  it('bracket identifiers with ]] escape', () => {
    expect(k('[a]]b] [Order Lines]')).toEqual(['quotedIdent:[a]]b]', 'quotedIdent:[Order Lines]']);
  });
  it('N strings', () => {
    expect(k("N'héllo' n'x'")).toEqual(["string:N'héllo'", "string:n'x'"]);
  });
  it('variables and globals', () => {
    expect(k('@x @@ROWCOUNT @a_1')).toEqual(['param:@x', 'param:@@ROWCOUNT', 'param:@a_1']);
  });
  it('temp tables', () => {
    expect(k('#tmp ##global')).toEqual(['ident:#tmp', 'ident:##global']);
  });
  it('$ACTION', () => {
    expect(k('$ACTION')).toEqual(['ident:$ACTION']);
  });
  it('hex literal', () => {
    expect(k('0x1F 0XAB')).toEqual(['number:0x1F', 'number:0XAB']);
  });
  it('GO on its own line is a batch separator', () => {
    expect(k('SELECT 1\nGO\nSELECT 2')).toEqual(['keyword:SELECT', 'number:1', 'batchSep:GO', 'keyword:SELECT', 'number:2']);
  });
  it('GO with a count', () => {
    expect(k('x\nGO 5\n')).toEqual(['ident:x', 'batchSep:GO 5']);
  });
  it('GO with trailing comment', () => {
    expect(k('x\n  go -- done\ny')).toEqual(['ident:x', 'batchSep:go', 'comment:-- done', 'ident:y']);
  });
  it('GO not alone on its line is an identifier', () => {
    expect(k('SELECT GO FROM t')).toContain('ident:GO');
    expect(k('GO x')).toEqual(['ident:GO', 'ident:x']);
  });
  it('GO inside a comment or string is not a separator', () => {
    expect(k("/*\nGO\n*/ 'a\nGO\n'")).toEqual(['comment:/*\nGO\n*/', "string:'a\nGO\n'"]);
  });
  it('GO at EOF', () => {
    expect(k('x\nGO')).toEqual(['ident:x', 'batchSep:GO']);
  });
  it('compound assignment operators', () => {
    expect(k('@a += 1')).toEqual(['param:@a', 'op:+=', 'number:1']);
  });
  it('reserved words are keywords; contextual words identifiers', () => {
    expect(k('SELECT TOP 1 x FROM t CROSS APPLY f()')).toEqual(['keyword:SELECT', 'keyword:TOP', 'number:1', 'ident:x', 'keyword:FROM', 'ident:t', 'keyword:CROSS', 'ident:APPLY', 'ident:f', 'punct:(', 'punct:)']);
  });
  it('dotted names', () => {
    expect(k('db..t')).toEqual(['ident:db', 'punct:.', 'punct:.', 'ident:t']);
  });
});

describe('lexer: Oracle', () => {
  const k = (s: string) => kinds('plsql', s);
  it.each([["q'[it's]'"], ["q'{a}'"], ["q'<a>'"], ["q'(a)'"], ["q'!a!'"], ["Q'#x#'"], ["nq'[x]'"], ["NQ'|x|'"]])('q-quote %s', (s) => {
    expect(k(s)).toEqual([`string:${s}`]);
  });
  it("q-quote may contain quotes and ] without ]'", () => {
    expect(k("q'[a ] ' b]' x")).toEqual(["string:q'[a ] ' b]'", 'ident:x']);
  });
  it('unterminated q-quote', () => {
    expect(one('plsql', "q'[abc").unterminated).toBe(true);
  });
  it('bind variables and substitution variables', () => {
    expect(k(':id :1 &name &&twice')).toEqual(['param::id', 'param::1', 'param:&name', 'param:&&twice']);
  });
  it(':= is an operator, not a bind', () => {
    expect(k('x := 1')).toEqual(['ident:x', 'op::=', 'number:1']);
  });
  it('=> named notation', () => {
    expect(k('p_id => 1')).toEqual(['ident:p_id', 'op:=>', 'number:1']);
  });
  it('%TYPE / %ROWTYPE attributes are operators', () => {
    expect(k('t.c%TYPE r%ROWTYPE c%NOTFOUND')).toEqual(['ident:t', 'punct:.', 'ident:c', 'op:%TYPE', 'ident:r', 'op:%ROWTYPE', 'ident:c', 'op:%NOTFOUND']);
  });
  it('(+) outer join marker', () => {
    expect(k('a.id = b.id(+)')).toEqual(['ident:a', 'punct:.', 'ident:id', 'op:=', 'ident:b', 'punct:.', 'ident:id', 'op:(+)']);
  });
  it('(+) with spaces', () => {
    expect(k('b.id( + )')).toEqual(['ident:b', 'punct:.', 'ident:id', 'op:( + )']);
  });
  it('slash alone on a line is a batch separator', () => {
    expect(k('END;\n/\nSELECT')).toEqual(['keyword:END', 'punct:;', 'batchSep:/', 'keyword:SELECT']);
  });
  it('slash with surrounding spaces', () => {
    expect(k('x\n  /  \ny')).toEqual(['ident:x', 'batchSep:/', 'ident:y']);
  });
  it('slash inside a string is not a separator', () => {
    expect(k("'a\n/\nb'")).toEqual(["string:'a\n/\nb'"]);
  });
  it('division is not a separator', () => {
    expect(k('a / b\n/ 2')).toEqual(['ident:a', 'op:/', 'ident:b', 'op:/', 'number:2']);
  });
  it('identifiers with $ and #', () => {
    expect(k('v$session a#b')).toEqual(['ident:v$session', 'ident:a#b']);
  });
  it('range operator ..', () => {
    expect(k('1..10')).toEqual(['number:1', 'op:..', 'number:10']);
  });
  it('binary float/double suffixes', () => {
    expect(k('1.5f 2d')).toEqual(['number:1.5f', 'number:2d']);
  });
  it('label delimiters', () => {
    expect(k('<<main_loop>>')).toEqual(['op:<<', 'ident:main_loop', 'op:>>']);
  });
  it('dblink @', () => {
    expect(k('t@remote')).toEqual(['ident:t', 'op:@', 'ident:remote']);
  });
  it('block comments are not nested', () => {
    expect(k('/* a /* b */ c */')).toEqual(['comment:/* a /* b */', 'ident:c', 'op:*', 'op:/']);
  });
});

describe('lexer: SQLite', () => {
  const k = (s: string) => kinds('sqlite', s);
  it('backtick and bracket identifiers', () => {
    expect(k('`a b` [c d]')).toEqual(['quotedIdent:`a b`', 'quotedIdent:[c d]']);
  });
  it('parameters', () => {
    expect(k('? ?12 :n @n $n')).toEqual(['param:?', 'param:?12', 'param::n', 'param:@n', 'param:$n']);
  });
  it('blob literals', () => {
    expect(k("X'0A0B' x'ff'")).toEqual(["string:X'0A0B'", "string:x'ff'"]);
  });
  it('json operators', () => {
    expect(k("d -> '$.a' ->> 'b'")).toEqual(['ident:d', 'op:->', "string:'$.a'", 'op:->>', "string:'b'"]);
  });
  it('== operator', () => {
    expect(k('a == b')).toEqual(['ident:a', 'op:==', 'ident:b']);
  });
  it('common column names stay identifiers', () => {
    expect(k('key action data')).toEqual(['ident:key', 'ident:action', 'ident:data']);
  });
  it('no GO / slash separators', () => {
    expect(k('x\nGO\n/')).toEqual(['ident:x', 'ident:GO', 'op:/']);
  });
});

describe('lexer: line mode (Monaco)', () => {
  const tsql = getSpec('tsql'), ora = getSpec('plsql');
  it('carries an open block comment to the next line', () => {
    const a = lexLine('x /* start', tsql, '');
    expect(a.endState).toBe('c1');
    const b = lexLine('still */ y', tsql, a.endState);
    expect(b.tokens.map((t) => t.kind)).toEqual(['comment', 'ident']);
    expect(b.endState).toBe('');
  });
  it('tracks nesting depth across lines (T-SQL)', () => {
    const a = lexLine('/* a /* b', tsql, '');
    expect(a.endState).toBe('c2');
    const b = lexLine('*/ still', tsql, a.endState);
    expect(b.endState).toBe('c1');
  });
  it('carries an open string', () => {
    const a = lexLine("x = 'abc", tsql, '');
    expect(a.endState).toBe('s');
    const b = lexLine("def' y", tsql, a.endState);
    expect(b.tokens.map((t) => t.kind)).toEqual(['string', 'ident']);
  });
  it('carries an open q-quote with its closer', () => {
    const a = lexLine("x := q'[abc", ora, '');
    expect(a.endState).toBe('q]');
    const b = lexLine("d]' ;", ora, a.endState);
    expect(b.tokens.map((t) => t.kind)).toEqual(['string', 'punct']);
  });
  it('GO recognised on its own line', () => {
    expect(lexLine('GO', tsql, '').tokens[0].kind).toBe('batchSep');
  });
  it('GO in a continued comment line is a comment', () => {
    expect(lexLine('GO */', tsql, 'c1').tokens[0].kind).toBe('comment');
  });
  it('closed constructs leave a normal end state', () => {
    expect(lexLine("SELECT 'a' /* b */", tsql, '').endState).toBe('');
  });
  it('line mode agrees with whole-document tokens', () => {
    const text = "SELECT a, /* c1\nc2 */ 'x\ny' FROM t -- z\nGO\nSELECT 1";
    const whole = tokenize(text, tsql).filter((t) => t.kind !== 'eof');
    const fromLines: string[] = [];
    let st = '';
    for (const line of text.split('\n')) {
      const r = lexLine(line, tsql, st);
      for (const t of r.tokens) fromLines.push(t.kind);
      st = r.endState;
    }
    // multi-line tokens appear once per line in line mode
    expect(fromLines.filter((k) => k !== 'comment' && k !== 'string')).toEqual(whole.map((t) => t.kind).filter((k) => k !== 'comment' && k !== 'string'));
  });
});

describe('lexer: incremental relex', () => {
  const cases: { d: Dialect; text: string }[] = [
    { d: 'tsql', text: "SELECT a, b FROM t WHERE x = 'q';\nGO\n/* c */ SELECT [x y] FROM #tmp\nGO 3\nEXEC p @a = 1" },
    { d: 'plsql', text: "BEGIN\n  x := q'[a]';\n  dbms_output.put_line(x);\nEND;\n/\nSELECT * FROM t WHERE a = b(+);" },
    { d: 'sqlite', text: "SELECT d ->> '$.a' FROM t; -- c\nINSERT INTO t VALUES (?, :n, X'00');" },
  ];
  const edits = ["'", '/*', '*/', '\n', 'GO\n', ' ', 'x', '--', '"', '[', '\nGO\n', '/', "q'[", ';'];
  for (const c of cases) {
    it(`${c.d}: random edits match a full re-tokenize`, () => {
      const spec = getSpec(c.d);
      let text = c.text;
      let toks = tokenize(text, spec);
      let seed = 7;
      const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      for (let step = 0; step < 300; step++) {
        const at = rnd(text.length + 1);
        const del = rnd(3) === 0 ? Math.min(rnd(4), text.length - at) : 0;
        const ins = rnd(4) === 0 ? '' : edits[rnd(edits.length)];
        const next = text.slice(0, at) + ins + text.slice(at + del);
        toks = relex(toks, next, { rangeOffset: at, rangeLength: del, text: ins }, spec);
        text = next;
        const full = tokenize(text, spec);
        expect(toks.map((t) => [t.kind, t.start, t.end, t.line, t.col, t.text])).toEqual(full.map((t) => [t.kind, t.start, t.end, t.line, t.col, t.text]));
      }
    });
  }
  it('re-lexes only near the edit (shifted tokens are reused)', () => {
    const spec = getSpec('tsql');
    const lines = Array.from({ length: 500 }, (_, i) => `SELECT c${i} FROM t${i};`).join('\n');
    const toks = tokenize(lines, spec);
    const at = 10;
    const next = lines.slice(0, at) + 'x' + lines.slice(at);
    const r = relex(toks, next, { rangeOffset: at, rangeLength: 0, text: 'x' }, spec);
    expect(r[r.length - 2].start).toBe(toks[toks.length - 2].start + 1);
    expect(r[r.length - 2].text).toBe(toks[toks.length - 2].text);
  });
});

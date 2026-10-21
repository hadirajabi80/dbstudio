// Formatter behaviour: options, range formatting, cursor mapping, safety fallbacks and performance.
import { describe, expect, it } from 'vitest';
import { formatRange, formatSql, mapOffset, resolveFormatOptions } from '../index';
import { getSpec } from '../../intel/dialect';
import { tokenize } from '../../intel/lexer/lexer';
import type { Dialect } from '../../intel/types';

const fmt = (sql: string, d: Dialect = 'tsql', o = {}) => formatSql(sql, d, o).text;

function sameTokens(a: string, b: string, d: Dialect): boolean {
  const n = (s: string) => tokenize(s, getSpec(d)).map((t) => `${t.kind}:${t.kind === 'keyword' || t.kind === 'ident' || t.kind === 'batchSep' || t.kind === 'op' ? t.upper : t.text}`).join('\n');
  return n(a) === n(b);
}

describe('options', () => {
  it('resolves and clamps', () => {
    const o = resolveFormatOptions({ indent: 99, lineWidth: 5, keywordCase: 'shout' as never, commaStyle: 'leading' });
    expect(o.indent).toBe(8);
    expect(o.lineWidth).toBe(40);
    expect(o.keywordCase).toBe('upper');
    expect(o.commaStyle).toBe('leading');
  });

  it('keyword case lower / asIs; identifiers untouched', () => {
    expect(fmt('Select Name From Customers', 'tsql', { keywordCase: 'lower' })).toBe('select Name\nfrom Customers');
    expect(fmt('Select Name From Customers', 'tsql', { keywordCase: 'asIs' })).toBe('Select Name\nFrom Customers');
  });

  it('function and data type case', () => {
    expect(fmt('select getdate(), cast(x as int)', 'tsql', { functionCase: 'lower', datatypeCase: 'lower' })).toBe('SELECT\n    getdate(),\n    cast(x AS int)');
    expect(fmt('declare @a nvarchar(10)', 'tsql', { datatypeCase: 'upper' })).toBe('DECLARE @a NVARCHAR(10)');
  });

  it('identifier case is opt-in', () => {
    expect(fmt('select Name from Customers', 'tsql', { identifierCase: 'lower' })).toBe('SELECT name\nFROM customers');
  });

  it('indent size and tabs', () => {
    expect(fmt('select a, b from t', 'tsql', { indent: 2 })).toBe('SELECT\n  a,\n  b\nFROM t');
    expect(fmt('select a, b from t', 'tsql', { useTabs: true })).toBe('SELECT\n\ta,\n\tb\nFROM t');
  });

  it('leading commas', () => {
    expect(fmt('select a, b, c from t', 'tsql', { commaStyle: 'leading' })).toBe('SELECT\n    a\n    , b\n    , c\nFROM t');
    expect(fmt('select f(aaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbb, cccccccccccccccccccc)', 'tsql', { commaStyle: 'leading', lineWidth: 40 }))
      .toBe('SELECT\n    f(\n        aaaaaaaaaaaaaaaa\n        , bbbbbbbbbbbbbbbbbbbb\n        , cccccccccccccccccccc\n    )');
  });

  it('AND/OR on new lines can be turned off', () => {
    expect(fmt('select 1 from t where a = 1 and b = 2', 'tsql', { andOrOnNewLine: false })).toBe('SELECT 1\nFROM t\nWHERE a = 1 AND b = 2');
  });

  it('clause keywords can stay inline', () => {
    expect(fmt('select a, b from t where x = 1', 'tsql', { clauseKeywordsOnOwnLine: false })).toBe('SELECT a, b FROM t WHERE x = 1');
  });

  it('line width decides inline vs wrapped lists', () => {
    const sql = 'select * from t where id in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)';
    expect(fmt(sql)).toBe('SELECT *\nFROM t\nWHERE id IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)');
    expect(fmt(sql, 'tsql', { lineWidth: 40 }).split('\n').length).toBeGreaterThan(10);
  });

  it('blank lines between statements and the consecutive blank-line cap', () => {
    expect(fmt('select 1\n\n\n\nselect 2', 'tsql', { maxConsecutiveBlankLines: 2 })).toBe('SELECT 1\n\n\nSELECT 2');
    expect(fmt('select a, b from t; select 1;', 'sqlite', { blankLineBetweenStatements: 2 })).toBe('SELECT\n    a,\n    b\nFROM t;\n\n\nSELECT 1;');
  });

  it('keeps the trailing newline and CRLF line ends', () => {
    expect(fmt('select 1\n')).toBe('SELECT 1\n');
    expect(fmt('select a, b\r\nfrom t\r\n')).toBe('SELECT\r\n    a,\r\n    b\r\nFROM t\r\n');
  });
});

describe('safety', () => {
  it('a broken statement stays verbatim, the rest is formatted, a warning names its line', () => {
    const r = formatSql('select 1 from t;\nselect (1 from t;\n', 'plsql');
    expect(r.text).toBe('SELECT 1\nFROM t;\n\nselect (1 from t;\n');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].line).toBe(2);
  });

  it('T-SQL batch with a broken statement: the other statements are still formatted', () => {
    const r = formatSql('select a, b from t\nselect (1 from t\nGO\nselect 2', 'tsql');
    expect(r.warnings).toHaveLength(1);
    expect(r.text).toContain('GO\n\nSELECT 2');
  });

  it('resynchronises after an unbalanced statement: later statements on the same line are formatted', () => {
    const r = formatSql('select a from t;  select (b from u;  select c from v;', 'sqlite');
    expect(r.text).toBe('SELECT a\nFROM t;\n\nselect (b from u;\nSELECT c\nFROM v;');
    expect(r.warnings).toEqual([{ line: 1, message: 'Statement at line 1 left unformatted: unbalanced parentheses.' }]);
    expect(formatSql(r.text, 'sqlite').text).toBe(r.text);
  });

  it('resynchronises on a statement keyword in column 1 (no `;`), never on an indented one', () => {
    const r = formatSql('select case when a then 1 from t\nselect b from u', 'tsql');
    expect(r.text).toBe('select case when a then 1 from t\nSELECT b\nFROM u');
    // …but not while a parenthesis of the broken statement is open: that keyword starts a subquery
    expect(formatSql('select (a from t\nselect b from u', 'tsql').text).toBe('select (a from t\nselect b from u');
    // inside an unclosed block the indented statements stay where they are
    const block = 'begin\n  select (1 from t;\n  select 2;\n';
    expect(formatSql(block, 'tsql').text).toBe(block.replace(/\n$/, '') + '\n');
  });

  it('never resynchronises inside parentheses opened by the broken statement (logic-r1-05)', () => {
    const sql = 'select (a from t where x in (\nselect 1 from z\nselect c from v';
    const r = formatSql(sql, 'sqlite');
    expect(r.text).toBe(sql);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].line).toBe(1);
    // once the parentheses of the chunk are closed again, a column-1 keyword is a cut point as before
    expect(formatSql('select (a from t)) x\nselect b from u', 'tsql').text).toBe('select (a from t)) x\nSELECT b\nFROM u');
  });

  it('never resynchronises inside a routine body: the whole broken procedure stays as typed (logic-r1-05)', () => {
    const sql = 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT (1 FROM t;\n  SELECT 2;\nEND';
    const r = formatSql(sql, 'tsql');
    expect(r.text).toBe(sql);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].line).toBe(1);
    // the same inside a GO batch: the statements after the separator are still formatted
    const batch = `${sql}\nGO\nselect a from t`;
    const b = formatSql(batch, 'tsql');
    expect(b.text).toBe(`${sql}\nGO\n\nSELECT a\nFROM t`);
    expect(b.warnings).toHaveLength(1);
    // PL/SQL and SQLite routines end at the END of their block; what follows the routine is formatted again
    const trig = 'CREATE TRIGGER tr AFTER INSERT ON t\nBEGIN\n  UPDATE u SET a = (1;\nEND;\nselect x from y;';
    const s = formatSql(trig, 'sqlite');
    expect(s.text.startsWith('CREATE TRIGGER tr AFTER INSERT ON t\nBEGIN\n  UPDATE u SET a = (1;\nEND;')).toBe(true);
    expect(s.warnings).toHaveLength(1);
    const ora = 'CREATE OR REPLACE PROCEDURE p IS\nBEGIN\n  IF x THEN\n    SELECT (1 INTO v FROM dual;\n  END IF;\nEND;\n/';
    const o = formatSql(ora, 'plsql');
    expect(o.text).toBe(ora);
    expect(o.warnings).toHaveLength(1);
  });

  it('guards a T-SQL ALTER PROCEDURE / TRIGGER body like a CREATE one (logic-r2-02)', () => {
    // what "Script as ALTER" / "Modify" emits: no blank line between AS and BEGIN, the body is not split
    const proc = 'ALTER PROCEDURE p AS\nBEGIN\n  SELECT (1 FROM t;\n  SELECT 2;\nEND';
    const p = formatSql(proc, 'tsql');
    expect(p.text).toBe(proc);
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0].line).toBe(1);
    expect(formatSql(proc.replace('PROCEDURE', 'PROC'), 'tsql').text).toBe(proc.replace('PROCEDURE', 'PROC'));
    // a column-1 statement keyword inside the body is not a cut point: SELECT 2; stays in the trigger
    const trig = 'ALTER TRIGGER trg AFTER INSERT ON t AS\nBEGIN\n  SELECT (1 FROM t;\nSELECT 2;\nEND';
    const t = formatSql(trig, 'tsql');
    expect(t.text).toBe(trig);
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0].line).toBe(1);
    const fn = 'ALTER FUNCTION /* c */ dbo.f() RETURNS INT AS\nBEGIN\n  RETURN (1;\nEND';
    expect(formatSql(fn, 'tsql').text).toBe(fn);
    // the guard ends at the batch: what follows GO is formatted again
    const b = formatSql(`${proc}\nGO\nselect a from t`, 'tsql');
    expect(b.text).toBe(`${proc}\nGO\n\nSELECT a\nFROM t`);
    expect(b.warnings).toHaveLength(1);
    // other ALTER statements are not routines: a broken one is resynchronised as before
    const tbl = formatSql('alter table t add c int default case when 1\nselect a from u', 'tsql');
    expect(tbl.text).toBe('alter table t add c int default case when 1\nSELECT a\nFROM u');
    // PL/SQL ALTER PROCEDURE … COMPILE has no body: nothing after it is guarded
    const ora = formatSql('alter procedure p compile;\nselect case when a then 1 from t\nselect b from dual', 'plsql');
    expect(ora.text).toBe('ALTER PROCEDURE p compile;\nselect case when a then 1 from t\nSELECT b\nFROM dual');
  });

  it('warns about CASE without END and keeps the statement verbatim', () => {
    const r = formatSql('SELECT CASE WHEN a THEN 1 FROM t', 'sqlite');
    expect(r.text).toBe('SELECT CASE WHEN a THEN 1 FROM t');
    expect(r.warnings[0].message).toContain('CASE without END');
  });

  it('keeps `;` with its statement after a trailing comment', () => {
    expect(fmt('select a from t -- trailing\n;', 'sqlite')).toBe('SELECT a\nFROM t; -- trailing');
    // a comment after the `;` on its line: nothing moves (it would merge the two comments)
    expect(fmt('select a from t -- one\n; -- two', 'sqlite')).toBe('SELECT a\nFROM t -- one\n    ; -- two');
    const r = formatSql('select a from t -- trailing\n;', 'sqlite');
    expect(mapOffset(r, 'select a from t -- trailing\n'.length)).toBe('SELECT a\nFROM t'.length);
  });

  it('re-indents block comment continuation lines relative to the comment start', () => {
    const sql = 'select a,\n            /* x\n               y\n                 z */\n    b from t';
    expect(fmt(sql, 'sqlite')).toBe('SELECT\n    a,\n    /* x\n       y\n         z */\n    b\nFROM t');
  });

  it("MERGE … USING ( gets a space before the parenthesis", () => {
    expect(fmt('merge t as tgt using(select 1 as a) as s on tgt.a = s.a when matched then delete;')).toContain('USING (\n');
  });

  it('unterminated string → verbatim', () => {
    const r = formatSql("select 'abc", 'tsql');
    expect(r.text).toBe("select 'abc");
    expect(r.warnings).toHaveLength(1);
  });

  it('never merges tokens: unary minus, comment-like and word sequences', () => {
    for (const [sql, d] of [
      ['select - -1, a - -b, 1 - - 2', 'tsql'], ['select a/ *b*/c from t', 'tsql'], ['select 1 go_on from t', 'tsql'],
      ["select n 'x', x'00' from t", 'sqlite'], ['select a(+) from t where b = :x', 'plsql'], ['select 1..2', 'plsql'],
    ] as [string, Dialect][]) {
      const out = fmt(sql, d);
      expect(sameTokens(sql, out, d)).toBe(true);
      expect(fmt(out, d)).toBe(out);
    }
  });

  it('a column named go is never put at the start of a line', () => {
    const sql = 'select a,\ngo\nfrom t';
    const out = fmt(sql);
    expect(sameTokens(sql, out, 'tsql')).toBe(true);
  });

  it('GO n and Oracle / lines are kept', () => {
    expect(fmt('insert into t values (1)\ngo 5')).toBe('INSERT INTO t\nVALUES (1)\nGO 5');
    expect(fmt('begin null; end;\n/\nselect 1 from dual', 'plsql')).toBe('BEGIN\n    NULL;\nEND;\n/\n\nSELECT 1\nFROM dual');
  });
});

describe('range formatting and cursor mapping', () => {
  it('formats only the statements intersecting the selection', () => {
    const text = 'select a, b from t;\nselect c, d from u;\nselect e from v;';
    const r = formatRange(text, 'sqlite', [25, 30])!;
    expect(r.range).toEqual([20, 39]);
    expect(r.text).toBe('SELECT\n    c,\n    d\nFROM u;');
  });

  it('re-applies the indentation of the first line', () => {
    const text = 'select 1;\n  select a, b from t;';
    const r = formatRange(text, 'sqlite', [14, 16])!;
    expect(r.range).toEqual([10, 31]);
    expect(r.text).toBe('  SELECT\n      a,\n      b\n  FROM t;');
  });

  it('caret position (no selection) picks the statement around it', () => {
    const r = formatRange('select 1;\n\nselect x, y from t;', 'sqlite', [14, 14])!;
    expect(r.text).toBe('SELECT\n    x,\n    y\nFROM t;');
  });

  it('maps an offset inside a token to the same token after formatting', () => {
    const text = 'select  Name ,Total from Customers';
    const r = formatSql(text, 'tsql');
    const at = mapOffset(r, text.indexOf('Total') + 2);
    expect(r.text.slice(at - 2, at + 3)).toBe('Total');
  });
});

describe('dialect constructs', () => {
  it('T-SQL nested IF / ELSE binds to the inner IF', () => {
    expect(fmt('if @a = 1 if @b = 1 print 1 else print 2')).toBe('IF @a = 1\n    IF @b = 1\n        PRINT 1\n    ELSE\n        PRINT 2');
  });

  it('T-SQL CASE inside function arguments', () => {
    expect(fmt('select coalesce(case when a = 1 then 2 end, 0)')).toBe('SELECT COALESCE(CASE WHEN a = 1 THEN 2 END, 0)');
  });

  it('PL/SQL package body keeps END name; and the / line', () => {
    const out = fmt('create or replace package body p as procedure x is begin null; end x; end p;\n/', 'plsql');
    expect(out).toBe('CREATE OR REPLACE PACKAGE BODY p AS\n    PROCEDURE x IS\n    BEGIN\n        NULL;\n    END x;\nEND p;\n/');
  });

  it('SQLite trigger body', () => {
    expect(fmt('create trigger t after delete on a begin delete from b where a_id = old.id; end;', 'sqlite'))
      .toBe('CREATE TRIGGER t\nAFTER DELETE ON a\nBEGIN\n    DELETE FROM b\n    WHERE a_id = old.id;\nEND;');
  });
});

describe('large inputs', () => {
  function oraclePackage(procs: number): string {
    const out = ['create or replace package body big_pkg as'];
    for (let i = 0; i < procs; i++) {
      out.push(
        `  -- procedure ${i}`,
        `  procedure p${i}(p_id in number, p_name in varchar2 default null) is`,
        `    v_total number := 0;`,
        `    cursor c is select id, total from orders where customer_id = p_id;`,
        `  begin`,
        `    for r in c loop`,
        `      if r.total > 100 then v_total := v_total + r.total; elsif r.total < 0 then raise_application_error(-20000 - ${i}, 'neg'); end if;`,
        `    end loop;`,
        `    update customers set total = v_total, name = nvl(p_name, name) where id = p_id;`,
        `  exception when others then raise;`,
        `  end p${i};`,
      );
    }
    out.push('end big_pkg;', '/');
    return out.join('\n');
  }

  it('600-line Oracle package body: idempotent, token-equal, END names and / kept', () => {
    const src = oraclePackage(55);
    expect(src.split('\n').length).toBeGreaterThanOrEqual(600);
    const r = formatSql(src, 'plsql');
    expect(r.warnings).toEqual([]);
    expect(sameTokens(src, r.text, 'plsql')).toBe(true);
    expect(formatSql(r.text, 'plsql').text).toBe(r.text);
    expect(r.text).toContain('    END p54;\nEND big_pkg;\n/');
  });

  it('5,000-line T-SQL script formats in < 150 ms', () => {
    const lines: string[] = [];
    while (lines.length < 5000) {
      lines.push(
        '-- report ' + lines.length,
        'select c.Name, o.Total, case when o.Total > 100 then 1 else 0 end as Big',
        'from Customers c join Orders o on o.CustomerId = c.Id',
        "where o.Total > 10 and c.Name like 'A%'",
        'order by o.Total desc;',
        'update Orders set Total = Total * 2 where Id in (select Id from Archive where Flag = 1);',
        'if @x = 1 begin print @x end',
      );
    }
    const src = lines.join('\n');
    const r = formatSql(src, 'tsql'); // warm up (JIT) and correctness
    expect(r.warnings).toEqual([]);
    // Two more warm-up runs: after a single one V8 is still tiering the layout code up, and the timed runs measured
    // JIT warm-up (~150 ms) instead of the formatter (~60 ms steady state on the QA machine). Budget and input unchanged.
    formatSql(src, 'tsql');
    formatSql(src, 'tsql');
    // median of 5 runs: robust against a busy machine
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      formatSql(src, 'tsql');
      times.push(performance.now() - t0);
    }
    const median = times.sort((a, b) => a - b)[2];
    // The 150 ms budget (PLAN-M1.5 1.2) is enforced by `npm run test:intel` (node environment). The app suite
    // (`npm test`, jsdom, every package in parallel) also picks this file up; there it only guards against
    // pathological regressions. Shared CI runners are 2-4x slower than a developer machine and their timing is
    // noisy, so CI only fails on a clear (4x) regression; the 150 ms budget is checked locally.
    const onCi = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CI;
    const budget = typeof document === 'undefined' ? (onCi ? 600 : 150) : 1000;
    expect(median).toBeLessThan(budget);
  });
});

describe('PostgreSQL (docs/PLAN-PG.md 3.6, P43)', () => {
  const pg = (sql: string, o = {}) => formatSql(sql, 'pgsql', o);

  it('keeps :: unspaced and upper-cases known types after it', () => {
    expect(pg('select a::int, b :: text, c::order_status from t').text).toBe('SELECT\n    a::INT,\n    b::TEXT,\n    c::order_status\nFROM t');
  });

  it('lays out the function header and keeps the $$ body byte-identical', () => {
    const body = '$$\nDECLARE x int;\n  BEGIN\n\tx := 1;   -- keep   me\n  RETURN x;\nEND\n$$';
    const r = pg(`create or replace function f(a int, b text) returns int language plpgsql stable as ${body};`);
    expect(r.warnings).toEqual([]);
    expect(r.text).toBe(`CREATE OR REPLACE FUNCTION f(a INT, b TEXT)\nRETURNS INT\nLANGUAGE plpgsql\nSTABLE\nAS ${body};`);
    expect(pg(r.text).text).toBe(r.text);
  });

  it('DO blocks and $$ bodies containing ; stay one statement each', () => {
    const r = pg("do $$ begin raise notice 'a;b'; end $$; select 1;");
    expect(r.text).toBe("DO $$ begin raise notice 'a;b'; end $$;\nSELECT 1;");
  });

  it('an unterminated $$ body stays verbatim with a warning; the statement before is formatted', () => {
    const r = pg('select 1 from t;\ncreate function f() returns int as $$ select 1;');
    expect(r.text.startsWith('SELECT 1\nFROM t;')).toBe(true);
    expect(r.text).toContain('create function f() returns int as $$ select 1;');
    expect(r.warnings).toHaveLength(1);
  });

  it('psql meta-command lines are kept verbatim', () => {
    expect(pg('\\c shop\nselect 1;\n\\dt').text).toBe('\\c shop\nSELECT 1;\n\\dt');
  });

  it('JSON operators and array subscripts', () => {
    expect(pg("select data->'a'->>'b', arr[1:2], arr[i] from t").text).toBe("SELECT\n    data -> 'a' ->> 'b',\n    arr[1:2],\n    arr[i]\nFROM t");
  });

  it('5,000-line PostgreSQL script formats in < 150 ms', () => {
    const lines: string[] = [];
    while (lines.length < 5000) {
      lines.push(
        '-- report ' + lines.length,
        "select c.name, o.total::numeric(10,2), o.meta->>'k' as k from customers c join orders o on o.customer_id = c.id",
        "where o.total > 10 and c.name ilike 'A%' order by o.total desc limit 10;",
        "insert into t (a, b) values (1, 'x') on conflict (a) do update set b = excluded.b returning *;",
        'do $$ begin perform 1; end $$;',
      );
    }
    const src = lines.join('\n');
    const r = pg(src);
    expect(r.warnings).toEqual([]);
    expect(sameTokens(src, r.text, 'pgsql')).toBe(true);
    pg(src);
    pg(src);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      pg(src);
      times.push(performance.now() - t0);
    }
    const median = times.sort((a, b) => a - b)[2];
    const onCi = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CI;
    const budget = typeof document === 'undefined' ? (onCi ? 600 : 150) : 1000;
    expect(median).toBeLessThan(budget);
  });
});

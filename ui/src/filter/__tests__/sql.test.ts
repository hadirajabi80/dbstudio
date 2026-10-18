import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind, Dialect } from '../../api/types';
import { newCondition, newGroup, type FilterOp, type FilterValue } from '../model';
import { computeView } from '../evaluate';
import { analyzeSelect, rewriteWithPredicate } from '../rewrite';
import { buildPredicate, inlineParams, splitForServer } from '../sql';

const col = (name: string, kind: ColumnKind): ColumnInfo => ({
  name, ordinal: 0, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'Orders', schema: 'dbo', isKey: false,
});
const COLS = [col('Id', 'int'), col('Name', 'string'), col('Total', 'decimal'), col('OrderDate', 'datetime'), col('Paid', 'bool'), col('At', 'time'), col('Doc', 'xml')];

const one = (d: Dialect, column: string, op: FilterOp, values: FilterValue[] = [], cs = false) => {
  const c = { ...newCondition(column, op, values), ...(cs ? { caseSensitive: true } : {}) };
  return buildPredicate(newGroup('and', [c]), COLS, d, { alias: 'q' });
};

describe('server predicate per dialect', () => {
  it('numbers bind typed parameters, never literals', () => {
    const r = one('tsql', 'Total', 'between', ['10', '20.5']);
    expect(r.where).toBe('q.Total BETWEEN @fp1 AND @fp2');
    expect(r.params).toEqual([{ name: 'fp1', kind: 'int', value: 10 }, { name: 'fp2', kind: 'decimal', value: '20.5' }]);
    expect(one('plsql', 'Id', 'gt', [5]).where).toBe('q."Id" > :fp1');
    expect(one('sqlite', 'Total', 'eq', ['2.5']).params[0]).toEqual({ name: 'fp1', kind: 'float', value: 2.5 });
  });

  it('contains: + concatenation on T-SQL, || on Oracle/SQLite, LIKE metacharacters escaped', () => {
    const t = one('tsql', 'Name', 'contains', ['50%_[x]']);
    expect(t.where).toBe("q.Name LIKE '%' + @fp1 + '%' ESCAPE '\\'");
    expect(t.params[0].value).toBe('50\\%\\_\\[x]');
    const o = one('plsql', 'Name', 'contains', ['acme']);
    expect(o.where).toBe(`UPPER(q."Name") LIKE '%' || UPPER(:fp1) || '%' ESCAPE '\\'`);
    const s = one('sqlite', 'Name', 'startsWith', ['ac']);
    expect(s.where).toBe("q.Name LIKE @fp1 || '%' ESCAPE '\\'");
    expect(one('sqlite', 'Name', 'endsWith', ['x']).where).toBe("q.Name LIKE '%' || @fp1 ESCAPE '\\'");
    expect(one('tsql', 'Name', 'notContains', ['a']).where).toBe("NOT (q.Name LIKE '%' + @fp1 + '%' ESCAPE '\\')");
  });

  it('case sensitivity: COLLATE on T-SQL, plain on Oracle, instr()/NOCASE on SQLite', () => {
    expect(one('tsql', 'Name', 'contains', ['A'], true).where).toBe("q.Name COLLATE Latin1_General_CS_AS LIKE '%' + @fp1 + '%' ESCAPE '\\'");
    expect(one('plsql', 'Name', 'eq', ['A'], true).where).toBe('q."Name" = :fp1');
    expect(one('plsql', 'Name', 'eq', ['A']).where).toBe('UPPER(q."Name") = UPPER(:fp1)');
    expect(one('sqlite', 'Name', 'contains', ['A'], true).where).toBe('instr(q.Name, @fp1) > 0');
    expect(one('sqlite', 'Name', 'eq', ['A']).where).toBe('q.Name = @fp1 COLLATE NOCASE');
    expect(one('sqlite', 'Name', 'startsWith', ['A'], true).where).toBe('substr(q.Name, 1, length(@fp1)) = @fp1');
  });

  it('IN lists, NULL checks, booleans, empty strings', () => {
    expect(one('tsql', 'Id', 'in', [1, 2, 3]).where).toBe('q.Id IN (@fp1, @fp2, @fp3)');
    expect(one('plsql', 'Name', 'notIn', ['a', 'b']).where).toBe('UPPER(q."Name") NOT IN (UPPER(:fp1), UPPER(:fp2))');
    expect(one('sqlite', 'Name', 'in', ['a']).where).toBe('q.Name COLLATE NOCASE IN (@fp1)');
    expect(one('tsql', 'Name', 'isNull').where).toBe('q.Name IS NULL');
    expect(one('tsql', 'Paid', 'isTrue').where).toBe('q.Paid = 1');
    expect(one('sqlite', 'Paid', 'isFalse').where).toBe('q.Paid = 0');
    expect(one('tsql', 'Name', 'isEmpty').where).toBe("q.Name = ''");
    const ora = one('plsql', 'Name', 'isEmpty');
    expect(ora.where).toBe('q."Name" IS NULL');
    expect(ora.warnings[0]).toMatch(/Oracle/);
  });

  it('dates: half-open ranges with datetime parameters (T-SQL/Oracle), date()/datetime() on SQLite', () => {
    const t = one('tsql', 'OrderDate', 'onDate', ['2026-01-03']);
    expect(t.where).toBe('q.OrderDate >= @fp1 AND q.OrderDate < @fp2');
    expect(t.params).toEqual([{ name: 'fp1', kind: 'datetime', value: '2026-01-03T00:00:00' }, { name: 'fp2', kind: 'datetime', value: '2026-01-04T00:00:00' }]);
    expect(one('plsql', 'OrderDate', 'after', ['2026-01-03']).where).toBe('q."OrderDate" >= :fp1');
    expect(one('plsql', 'OrderDate', 'after', ['2026-01-03']).params[0].value).toBe('2026-01-04T00:00:00');
    expect(one('tsql', 'OrderDate', 'before', ['2026-01-03 10:30']).where).toBe('q.OrderDate < @fp1');
    expect(one('tsql', 'OrderDate', 'between', ['2026-01-01', '2026-01-31']).params.map((p) => p.value)).toEqual(['2026-01-01T00:00:00', '2026-02-01T00:00:00']);
    const s = one('sqlite', 'OrderDate', 'onDate', ['2026-01-03']);
    expect(s.where).toBe('date(q.OrderDate) = @fp1');
    expect(s.params[0]).toEqual({ name: 'fp1', kind: 'string', value: '2026-01-03' });
    expect(one('sqlite', 'OrderDate', 'after', ['2026-01-03 10:00']).where).toBe('datetime(q.OrderDate) > @fp1');
    const last = buildPredicate(newGroup('and', [newCondition('OrderDate', 'last', [7, 'days'])]), COLS, 'tsql', { alias: 'q', now: new Date(2026, 0, 10, 12) });
    expect(last.where).toBe('q.OrderDate >= @fp1 AND q.OrderDate <= @fp2');
    expect(last.params.map((p) => p.value)).toEqual(['2026-01-03T00:00:00', '2026-01-10T12:00:00']);
  });

  it('time comparisons per dialect', () => {
    expect(one('tsql', 'At', 'before', ['12:00']).where).toBe('q.At < @fp1');
    expect(one('tsql', 'At', 'before', ['12:00']).params[0]).toEqual({ name: 'fp1', kind: 'time', value: '12:00:00' });
    expect(one('sqlite', 'At', 'after', ['08:00']).where).toBe('time(q.At) > @fp1');
    expect(one('plsql', 'At', 'between', ['08:00', '09:00']).where).toBe(`TO_CHAR(q."At", 'HH24:MI:SS') BETWEEN :fp1 AND :fp2`);
  });

  it('xml columns are cast for LIKE on T-SQL', () => {
    expect(one('tsql', 'Doc', 'contains', ['<a']).where).toBe("CAST(q.Doc AS NVARCHAR(MAX)) LIKE '%' + @fp1 + '%' ESCAPE '\\'");
  });

  it('AND/OR groups get parentheses; regex stays client-side', () => {
    const tree = newGroup('or', [
      newGroup('and', [newCondition('Name', 'contains', ['a']), newCondition('Total', 'gt', [100])]),
      newCondition('Id', 'eq', [5]),
    ]);
    const r = buildPredicate(tree, COLS, 'tsql', { alias: 'q' });
    expect(r.where).toBe("(q.Name LIKE '%' + @fp1 + '%' ESCAPE '\\' AND q.Total > @fp2) OR q.Id = @fp3");
    expect(r.clientOnly).toBeNull();

    const withRegex = newGroup('and', [newCondition('Id', 'gt', [1]), newCondition('Name', 'regex', ['^A'])]);
    const r2 = buildPredicate(withRegex, COLS, 'sqlite', { alias: 'q' });
    expect(r2.where).toBe('q.Id > @fp1');
    expect(r2.clientOnly?.items).toHaveLength(1);

    const orRegex = newGroup('or', [newCondition('Id', 'gt', [1]), newCondition('Name', 'regex', ['^A'])]);
    const r3 = buildPredicate(orRegex, COLS, 'sqlite', { alias: 'q' });
    expect(r3.where).toBeNull();
    expect(r3.clientOnly).not.toBeNull();
    expect(splitForServer(orRegex, COLS).server).toBeNull();
  });

  it('BETWEEN inside AND is not mistaken for a group', () => {
    const tree = newGroup('or', [newCondition('Total', 'between', [1, 2]), newCondition('Id', 'eq', [9])]);
    expect(buildPredicate(tree, COLS, 'tsql', { alias: 'q' }).where).toBe('q.Total BETWEEN @fp1 AND @fp2 OR q.Id = @fp3');
  });

  it('quick text search becomes OR of LIKEs over string columns', () => {
    const r = buildPredicate(null, COLS, 'sqlite', { quick: 'ac', alias: null });
    expect(r.where).toBe("(Name LIKE '%' || @fp1 || '%' ESCAPE '\\' OR Doc LIKE '%' || @fp1 || '%' ESCAPE '\\')");
    expect(r.params).toHaveLength(1);
  });

  it('incomplete conditions are skipped, unknown columns warn', () => {
    const r = buildPredicate(newGroup('and', [newCondition('Id', 'eq', []), newCondition('Nope', 'eq', [1])]), COLS, 'tsql');
    expect(r.where).toBeNull();
    expect(r.params).toEqual([]);
  });

  it('inlineParams renders a readable preview', () => {
    const r = one('tsql', 'Name', 'eq', ["O'Brien"]);
    expect(inlineParams(r.where!, r.params, 'tsql')).toBe("q.Name = N'O''Brien'");
    const o = one('plsql', 'OrderDate', 'before', ['2026-01-03']);
    expect(inlineParams(o.where!, o.params, 'plsql')).toBe(`q."OrderDate" < TIMESTAMP '2026-01-03 00:00:00'`);
  });
});

describe('server rewrite', () => {
  const W = 'q.Total > @fp1';
  it('wraps a plain SELECT; Oracle uses no AS', () => {
    expect(rewriteWithPredicate('SELECT * FROM Orders', 'tsql', W).sql).toBe('SELECT * FROM (\n  SELECT * FROM Orders\n) AS q\nWHERE q.Total > @fp1');
    expect(rewriteWithPredicate('SELECT * FROM ORDERS;', 'plsql', 'q."TOTAL" > :fp1').sql).toBe('SELECT * FROM (\n  SELECT * FROM ORDERS\n) q\nWHERE q."TOTAL" > :fp1');
    expect(rewriteWithPredicate('select * from orders;', 'sqlite', W).sql).toBe('SELECT * FROM (\n  select * from orders\n) AS q\nWHERE q.Total > @fp1');
  });

  it('hoists a top-level ORDER BY with q. prefixes (T-SQL forbids it inside)', () => {
    const r = rewriteWithPredicate('SELECT o.Id, o.Total FROM dbo.Orders o ORDER BY o.Total DESC, 1', 'tsql', W);
    expect(r.sql).toBe('SELECT * FROM (\n  SELECT o.Id, o.Total FROM dbo.Orders o\n) AS q\nWHERE q.Total > @fp1\nORDER BY q.Total DESC, 1');
    expect(r.orderBy).toBe('q.Total DESC, 1');
    const o = rewriteWithPredicate('SELECT * FROM t ORDER BY "Name" NULLS LAST', 'plsql', 'x = 1');
    expect(o.sql).toContain('ORDER BY q."Name" NULLS LAST');
    expect(o.sql).not.toMatch(/\(\n.*ORDER BY.*\n\) q/s);
    const e = rewriteWithPredicate('SELECT * FROM t ORDER BY UPPER(t.name) ASC', 'sqlite', 'x = 1');
    expect(e.sql).toContain('ORDER BY UPPER(q.name) ASC');
  });

  it('ignores ORDER BY inside subqueries, windows and comments', () => {
    const sql = "SELECT id, ROW_NUMBER() OVER (ORDER BY total) rn /* ORDER BY x */ FROM (SELECT * FROM t ORDER BY 1 LIMIT 5) s -- ORDER BY y";
    const a = analyzeSelect(sql, 'sqlite');
    expect(a.ok && a.orderBy).toBeNull();
  });

  it('keeps CTEs outside the derived table', () => {
    const r = rewriteWithPredicate('WITH big AS (SELECT * FROM Orders WHERE Total > 100 ORDER BY Id OFFSET 0 ROWS)\nSELECT * FROM big ORDER BY Id', 'tsql', W);
    expect(r.sql).toBe('WITH big AS (SELECT * FROM Orders WHERE Total > 100 ORDER BY Id OFFSET 0 ROWS)\nSELECT * FROM (\n  SELECT * FROM big\n) AS q\nWHERE q.Total > @fp1\nORDER BY q.Id');
    const o = rewriteWithPredicate('WITH a AS (SELECT 1 x FROM dual) SELECT * FROM a', 'plsql', 'q.x = :fp1');
    expect(o.sql.startsWith('WITH a AS (SELECT 1 x FROM dual)\nSELECT * FROM (')).toBe(true);
  });

  it('detects limits and leaves them inside', () => {
    const t = rewriteWithPredicate('SELECT TOP 100 * FROM Orders ORDER BY Total DESC', 'tsql', W);
    expect(t.limited).toBe(true);
    expect(t.sql).toBe('SELECT * FROM (\n  SELECT TOP 100 * FROM Orders ORDER BY Total DESC\n) AS q\nWHERE q.Total > @fp1\nORDER BY q.Total DESC');
    const s = rewriteWithPredicate('SELECT * FROM orders ORDER BY id LIMIT 50', 'sqlite', W);
    expect(s.limited).toBe(true);
    expect(s.sql).toContain('ORDER BY id LIMIT 50\n) AS q');
    expect(s.sql.endsWith('ORDER BY q.id')).toBe(true);
    const o = rewriteWithPredicate('SELECT * FROM orders ORDER BY id FETCH FIRST 10 ROWS ONLY', 'plsql', W);
    expect(o.limited).toBe(true);
    expect(o.sql).toContain('FETCH FIRST 10 ROWS ONLY\n) q');
    const off = rewriteWithPredicate('SELECT * FROM Orders ORDER BY Id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY', 'tsql', W);
    expect(off.limited).toBe(true);
    expect(rewriteWithPredicate('SELECT * FROM t', 'sqlite', W).limited).toBe(false);
  });

  it('moves the T-SQL OPTION hint to the end', () => {
    const r = rewriteWithPredicate('SELECT * FROM Orders ORDER BY Id OPTION (RECOMPILE)', 'tsql', W);
    expect(r.sql.endsWith('ORDER BY q.Id\nOPTION (RECOMPILE)')).toBe(true);
  });

  it('refuses what cannot be wrapped', () => {
    expect(analyzeSelect('UPDATE t SET a = 1', 'tsql')).toEqual({ ok: false, reason: 'Server filtering needs a single SELECT' });
    expect(analyzeSelect('SELECT 1; SELECT 2', 'sqlite').ok).toBe(false);
    expect(analyzeSelect('EXEC dbo.GetCustomer 1', 'tsql').ok).toBe(false);
    expect(analyzeSelect('SELECT * INTO #t FROM Orders', 'tsql').ok).toBe(false);
    expect(analyzeSelect('SELECT * FROM Orders FOR JSON PATH', 'tsql').ok).toBe(false);
    expect(() => rewriteWithPredicate('DELETE FROM t', 'sqlite', W)).toThrow(/single SELECT/);
  });
});

describe('precedence (code-03): compound parts are always parenthesized', () => {
  const orOfGroups = () => newGroup('or', [
    newGroup('and', [newCondition('Name', 'eq', ['Paris']), newCondition('Total', 'gt', [10])]),
    newGroup('and', [newCondition('Name', 'eq', ['Rome']), newCondition('Total', 'lt', [5])]),
  ]);

  it('OR of groups combined with quick search: the OR is wrapped before AND-ing the search', () => {
    const r = buildPredicate(orOfGroups(), COLS, 'sqlite', { alias: 'q', quick: 'zz' });
    expect(r.where).toBe(
      '((q.Name = @fp1 COLLATE NOCASE AND q.Total > @fp2) OR (q.Name = @fp3 COLLATE NOCASE AND q.Total < @fp4))'
      + " AND (q.Name LIKE '%' || @fp5 || '%' ESCAPE '\\' OR q.Doc LIKE '%' || @fp5 || '%' ESCAPE '\\')",
    );
  });

  it('OR of groups inside an AND keeps its own parentheses', () => {
    const tree = newGroup('and', [orOfGroups(), newCondition('Id', 'gt', [0])]);
    expect(buildPredicate(tree, COLS, 'tsql', { alias: 'q' }).where).toBe(
      '((q.Name = @fp1 AND q.Total > @fp2) OR (q.Name = @fp3 AND q.Total < @fp4)) AND q.Id > @fp5',
    );
  });

  it('a compound date range next to an OR is wrapped', () => {
    const tree = newGroup('or', [newCondition('OrderDate', 'onDate', ['2026-01-03']), newCondition('Id', 'eq', [1])]);
    expect(buildPredicate(tree, COLS, 'tsql', { alias: 'q' }).where).toBe('(q.OrderDate >= @fp1 AND q.OrderDate < @fp2) OR q.Id = @fp3');
  });
});

describe('client/server parity for mixed-precision date ranges (logic-17)', () => {
  const D = [col('CreatedAt', 'datetime')];
  const rows: CellValue[][] = [
    ['2024-01-01T09:59:59'], ['2024-01-01T10:00:00'], ['2024-01-01T23:00:00'], ['2024-01-02T00:00:00'],
    ['2024-01-02T15:30:00'], ['2024-01-02T23:59:59'], ['2024-01-03T00:00:00'], ['2024-01-04T08:00:00'],
  ];
  const clientCount = (values: string[]) =>
    computeView({ length: rows.length, get: (i) => rows[i] }, D, { quickFilter: '', filter: newGroup('and', [newCondition('CreatedAt', 'between', values)]), sort: [] })!.length;
  /** Evaluates the generated T-SQL/Oracle predicate (>=, <, BETWEEN on ISO values) like the server would. */
  const serverCount = (d: Dialect, values: string[]) => {
    const r = buildPredicate(newGroup('and', [newCondition('CreatedAt', 'between', values)]), D, d, { alias: null });
    const p = (name: string) => String(r.params.find((x) => x.name === name)!.value).replace(' ', 'T');
    const ph = d === 'plsql' ? ':' : '@';
    const conds = r.where!.split(' AND ').reduce<string[]>((acc, part) => {
      if (acc.length && /BETWEEN [^ ]+$/.test(acc[acc.length - 1])) acc[acc.length - 1] += ` AND ${part}`;
      else acc.push(part);
      return acc;
    }, []);
    return rows.filter(([v]) => conds.every((c) => {
      const cell = String(v);
      let m = new RegExp(String.raw`BETWEEN ${ph}(\w+) AND ${ph}(\w+)$`).exec(c);
      if (m) return cell >= p(m[1]) && cell <= p(m[2]);
      m = new RegExp(String.raw`(>=|<) ${ph}(\w+)$`).exec(c);
      if (!m) throw new Error(`unexpected predicate ${c}`);
      return m[1] === '>=' ? cell >= p(m[2]) : cell < p(m[2]);
    })).length;
  };

  it('a date-only upper bound includes that whole day on the server, as in the grid', () => {
    const values = ['2024-01-01 10:00', '2024-01-02'];
    expect(clientCount(values)).toBe(5);
    for (const d of ['tsql', 'plsql'] as const) expect(serverCount(d, values), d).toBe(5);
    const t = buildPredicate(newGroup('and', [newCondition('CreatedAt', 'between', values)]), D, 'tsql', { alias: 'q' });
    expect(t.where).toBe('q.CreatedAt >= @fp1 AND q.CreatedAt < @fp2');
    expect(t.params.map((x) => x.value)).toEqual(['2024-01-01T10:00:00', '2024-01-03T00:00:00']);
    const s = buildPredicate(newGroup('and', [newCondition('CreatedAt', 'between', values)]), D, 'sqlite', { alias: 'q' });
    expect(s.where).toBe('datetime(q.CreatedAt) >= @fp1 AND datetime(q.CreatedAt) < @fp2');
    expect(s.params.map((x) => x.value)).toEqual(['2024-01-01 10:00:00', '2024-01-03']);
  });

  it('full datetime bounds stay an inclusive BETWEEN on both sides', () => {
    const values = ['2024-01-01 10:00', '2024-01-02 15:30'];
    expect(clientCount(values)).toBe(serverCount('tsql', values));
    expect(buildPredicate(newGroup('and', [newCondition('CreatedAt', 'between', values)]), D, 'tsql').where).toBe('CreatedAt BETWEEN @fp1 AND @fp2');
  });

  it('PL/SQL quotes every result column, date predicates included, and the hoisted ORDER BY', () => {
    const cols = [col('D', 'datetime'), col('CITY', 'string')];
    const r = buildPredicate(newGroup('and', [newCondition('D', 'gte', ['2024-01-01']), newCondition('CITY', 'eq', ['x'], 1)]), cols, 'plsql', { alias: 'q' });
    expect(r.where).toBe('q."D" >= :fp1 AND UPPER(q."CITY") = UPPER(:fp2)');
    expect(rewriteWithPredicate('SELECT * FROM t ORDER BY City, t.Code DESC', 'plsql', 'x = 1').orderBy).toBe('q."CITY", q."CODE" DESC');
    expect(rewriteWithPredicate('SELECT * FROM t ORDER BY "City"', 'plsql', 'x = 1').orderBy).toBe('q."City"');
    expect(rewriteWithPredicate('SELECT * FROM t ORDER BY City', 'tsql', 'x = 1').orderBy).toBe('q.City');
  });
});

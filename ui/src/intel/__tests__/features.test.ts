// Hover, signature help, definition, soft diagnostics, ranking.
import { describe, expect, it } from 'vitest';
import { createIntel } from '../index';
import { makeAlias } from '../complete/completer';
import { matchScore, segments, sortTextFor, UsageStore } from '../complete/ranker';
import { needsQuoting } from '../complete/format';
import { getSpec } from '../dialect';
import type { Dialect } from '../types';
import { doc, fixtures, intelFor, stripMd } from './helpers';

function at(d: Dialect, input: string) {
  const i = intelFor(d);
  return { i, ...doc(i, input) };
}
const diags = (d: Dialect, sql: string) => { const x = at(d, sql); return x.i.softDiagnostics(x.uri); };

describe('hover', () => {
  it('column with PK/FK badges and comment', () => {
    const x = at('tsql', 'SELECT c.CountryId, c.Name FROM Customers c');
    const h = x.i.hover(x.uri, x.text.indexOf('CountryId') + 2)!;
    expect(stripMd(h.markdown)).toContain('dbo.Customers.CountryId int NULL [FK → dbo.Countries.Id]');
    const n = x.i.hover(x.uri, x.text.indexOf('Name') + 1)!;
    expect(n.markdown).toContain('Display name');
  });
  it('table hover lists columns', () => {
    const x = at('tsql', 'SELECT * FROM Orders');
    const h = x.i.hover(x.uri, x.text.indexOf('Orders') + 1)!;
    expect(stripMd(h.markdown)).toContain('dbo.Orders (table)');
    expect(h.markdown).toContain('| CustomerId | int NOT NULL | FK |');
  });
  it('synonym hover shows the target', () => {
    const x = at('tsql', 'SELECT * FROM Cust');
    const h = x.i.hover(x.uri, x.text.indexOf('Cust') + 1)!;
    expect(stripMd(h.markdown)).toContain('synonym dbo.Cust → dbo.Customers');
  });
  it('function hover shows signatures', () => {
    const x = at('tsql', 'SELECT DATEADD(day, 1, GETDATE())');
    const h = x.i.hover(x.uri, 9)!;
    expect(h.markdown).toContain('DATEADD(');
  });
  it('variable hover', () => {
    const x = at('tsql', 'DECLARE @n int; SELECT @n');
    const h = x.i.hover(x.uri, x.text.lastIndexOf('@n') + 1)!;
    expect(stripMd(h.markdown)).toContain('variable @n int');
  });
  it('CTE hover lists output columns', () => {
    const x = at('tsql', 'WITH big AS (SELECT Id, Total AS Amt FROM Orders) SELECT * FROM big');
    const h = x.i.hover(x.uri, x.text.lastIndexOf('big') + 1)!;
    expect(stripMd(h.markdown)).toBe('cte big (Id, Amt)');
  });
  it('package member hover', () => {
    const x = at('plsql', 'BEGIN order_api.get_total(1); END;');
    const h = x.i.hover(x.uri, x.text.indexOf('get_total') + 2)!;
    expect(h.markdown).toContain('FUNCTION ORDER_API.GET_TOTAL(p_id IN NUMBER) RETURN NUMBER');
  });
  it('sequence NEXTVAL hover', () => {
    const x = at('plsql', 'SELECT orders_seq.nextval FROM dual');
    expect(x.i.hover(x.uri, x.text.indexOf('nextval') + 1)!.markdown).toContain('SHOP.ORDERS_SEQ.NEXTVAL');
  });
  it('no hover on whitespace or unknown names', () => {
    const x = at('tsql', 'SELECT  zzz FROM Orders');
    expect(x.i.hover(x.uri, 7)).toBeNull();
    expect(x.i.hover(x.uri, x.text.indexOf('zzz') + 1)).toBeNull();
  });
});

describe('definition', () => {
  it('CTE usage → WITH entry', () => {
    const x = at('tsql', 'WITH big AS (SELECT 1 x) SELECT * FROM big');
    expect(x.i.definition(x.uri, x.text.lastIndexOf('big') + 1)).toEqual({ kind: 'local', range: [5, 8] });
  });
  it('variable → DECLARE', () => {
    const x = at('tsql', 'DECLARE @n int; SELECT @n');
    expect(x.i.definition(x.uri, x.text.lastIndexOf('@n') + 1)).toEqual({ kind: 'local', range: [8, 10] });
  });
  it('temp table → creating statement (across GO)', () => {
    const x = at('tsql', 'CREATE TABLE #t (a int);\nGO\nSELECT * FROM #t');
    expect(x.i.definition(x.uri, x.text.lastIndexOf('#t') + 1)).toEqual({ kind: 'local', range: [13, 15] });
  });
  it('column → its table with the column', () => {
    const x = at('tsql', 'SELECT o.Total FROM Orders o');
    expect(x.i.definition(x.uri, x.text.indexOf('Total') + 1)).toEqual({ kind: 'object', ref: { database: 'shop', schema: 'dbo', name: 'Orders', type: 'table' }, column: 'Total' });
  });
  it('procedure in EXEC', () => {
    const x = at('tsql', 'EXEC GetCustomer 1');
    expect(x.i.definition(x.uri, 7)).toEqual({ kind: 'object', ref: { database: 'shop', schema: 'dbo', name: 'GetCustomer', type: 'proc' } });
  });
  it('synonym resolves to its target', () => {
    const x = at('plsql', 'SELECT * FROM cust');
    expect(x.i.definition(x.uri, x.text.indexOf('cust') + 1)).toEqual({ kind: 'object', ref: { database: null, schema: 'SHOP', name: 'CUSTOMERS', type: 'table' } });
  });
  it('CTE column → projection in the CTE body', () => {
    const x = at('tsql', 'WITH big AS (SELECT Total AS Amt FROM Orders) SELECT b.Amt FROM big b');
    const d = x.i.definition(x.uri, x.text.lastIndexOf('Amt') + 1)!;
    expect(d).toEqual({ kind: 'local', range: [x.text.indexOf('Amt'), x.text.indexOf('Amt') + 3] });
  });
});

describe('signature help', () => {
  it('built-in overloads choose by argument count', () => {
    const x = at('tsql', 'SELECT ROUND(1.5, 0, |');
    const s = x.i.signatureHelp(x.uri, x.offset)!;
    expect(s.activeParameter).toBe(2);
    expect(s.signatures[s.activeSignature].parameters.length).toBeGreaterThan(2);
  });
  it('nested calls use the innermost function', () => {
    const x = at('tsql', 'SELECT COALESCE(LEFT(Name, |), 1) FROM Products');
    const s = x.i.signatureHelp(x.uri, x.offset)!;
    expect(s.signatures[0].label.startsWith('LEFT(')).toBe(true);
    expect(s.activeParameter).toBe(1);
  });
  it('commas inside nested parens are not counted', () => {
    const x = at('sqlite', "SELECT substr(trim(a, 'x'), |");
    expect(x.i.signatureHelp(x.uri, x.offset)!.activeParameter).toBe(1);
  });
  it('Oracle named notation highlights by name', () => {
    const x = at('plsql', 'BEGIN order_api.create_order(p_total => |');
    expect(x.i.signatureHelp(x.uri, x.offset)!.activeParameter).toBe(1);
  });
  it('T-SQL EXEC without parentheses counts commas', () => {
    const x = at('tsql', 'EXEC Sales.CloseInvoice 1|');
    const s = x.i.signatureHelp(x.uri, x.offset)!;
    expect(s.signatures[0].label).toBe('Sales.CloseInvoice @InvoiceId int');
  });
  it('none inside a string', () => {
    const x = at('tsql', "SELECT LEFT('a, |");
    expect(x.i.signatureHelp(x.uri, x.offset)).toBeNull();
  });
  it('none for IN lists', () => {
    const x = at('tsql', 'SELECT * FROM t WHERE a IN (1, |');
    expect(x.i.signatureHelp(x.uri, x.offset)).toBeNull();
  });
});

describe('soft diagnostics', () => {
  it('unterminated string, comment and identifier', () => {
    expect(diags('tsql', "SELECT 'abc").map((d) => d.code)).toContain('unterminated');
    expect(diags('tsql', 'SELECT 1 /* x').map((d) => d.message)).toContain('Unterminated comment');
    expect(diags('tsql', 'SELECT [abc FROM t').map((d) => d.message)).toContain('Unterminated quoted identifier');
  });
  it('unbalanced parentheses', () => {
    expect(diags('tsql', 'SELECT (1 + 2 FROM Orders').some((d) => d.message === "Unclosed '('")).toBe(true);
    expect(diags('tsql', 'SELECT 1) FROM Orders').some((d) => d.message === "Unbalanced ')'")).toBe(true);
  });
  it('unknown table only when the schema is loaded', () => {
    expect(diags('tsql', 'SELECT * FROM Nope').map((d) => d.message)).toContain("Unknown table 'Nope'");
    expect(diags('tsql', 'SELECT * FROM Other.Nope').some((d) => d.code === 'unknown-table')).toBe(false);
    expect(diags('tsql', 'SELECT * FROM #tmp').some((d) => d.code === 'unknown-table')).toBe(false);
    const noCatalog = createIntel('tsql');
    const d = doc(noCatalog, 'SELECT * FROM Nope');
    expect(noCatalog.softDiagnostics(d.uri)).toEqual([]);
  });
  it('known tables, CTEs, synonyms and temp tables produce no warnings', () => {
    const sql = 'WITH x AS (SELECT Id FROM Orders) SELECT c.Name, x.Id FROM Cust c JOIN x ON x.Id = c.Id;\nSELECT 1 AS a INTO #t;\nSELECT a FROM #t';
    expect(diags('tsql', sql)).toEqual([]);
  });
  it('unknown alias', () => {
    expect(diags('tsql', 'SELECT z.Name FROM Customers c').map((d) => d.message)).toContain("Unknown alias or table 'z'");
  });
  it('duplicate alias', () => {
    expect(diags('tsql', 'SELECT * FROM Orders o JOIN Customers o ON 1 = 1').map((d) => d.message)).toContain("Duplicate alias 'o'");
  });
  it('ambiguous unqualified column (info)', () => {
    const d = diags('tsql', 'SELECT Name FROM Customers c JOIN Countries co ON co.Id = c.CountryId').find((x) => x.code === 'ambiguous-column')!;
    expect(d.severity).toBe('info');
  });
  it('UPDATE without WHERE', () => {
    expect(diags('tsql', 'UPDATE Orders SET Total = 0').map((d) => d.message)).toContain('UPDATE without WHERE');
    expect(diags('tsql', 'UPDATE Orders SET Total = 0 WHERE Id = 1').some((d) => d.code === 'no-where')).toBe(false);
  });
  it('INSERT column count mismatch', () => {
    expect(diags('tsql', 'INSERT INTO Orders (CustomerId, Total) VALUES (1)').map((d) => d.message)).toContain('INSERT has 2 target columns but 1 values');
  });
  it('Oracle block without /', () => {
    expect(diags('plsql', 'BEGIN NULL; END;').some((d) => d.code === 'missing-slash' && d.severity === 'info')).toBe(true);
  });
  it('SQL*Plus command warning', () => {
    expect(diags('plsql', 'SET SERVEROUTPUT ON').some((d) => d.code === 'sqlplus' && d.severity === 'warning')).toBe(true);
  });
  it('Oracle pseudo columns and PUBLIC-synonym candidates are not flagged', () => {
    expect(diags('plsql', 'SELECT c.ROWID, ROWNUM FROM customers c WHERE ROWNUM < 2').filter((d) => d.severity !== 'info')).toEqual([]);
  });
  it('record fields are checked (PL/SQL %ROWTYPE)', () => {
    const d = diags('plsql', 'DECLARE r customers%ROWTYPE; BEGIN x := r.nmae; END;\n/');
    expect(d.map((x) => x.message)).toContain("Column 'nmae' not found in r");
  });
  it('diagnostic positions are 1-based document line/col', () => {
    const d = diags('tsql', 'SELECT 1;\nGO\nSELECT c.Nmae\nFROM Customers c').find((x) => x.code === 'unknown-column')!;
    expect([d.line, d.col, d.endLine, d.endCol]).toEqual([3, 10, 3, 14]);
  });
});

describe('ranking primitives', () => {
  it.each([
    ['Name', 'Name', 100], ['name', 'Name', 96], ['na', 'Name', 90], ['cid', 'CustomerId', 70], ['o_d', 'order_date', 70],
    ['tom', 'CustomerId', 50], ['xyz', 'Name', -1],
  ])('matchScore(%s, %s) ≈ %d', (p, l, s) => {
    const r = matchScore(p, l);
    if (s < 0) expect(r).toBe(-1);
    else expect(r).toBeGreaterThanOrEqual(s - 5);
  });
  it('ordering: exact > prefix > word-start > substring > subsequence', () => {
    const order = ['Ord', 'Orders', 'OrderDate', 'BigOrderTable', 'xOxrxd'].map((l) => matchScore('ord', l));
    expect(order[0]).toBeGreaterThan(order[1]);
    expect(order[1]).toBeGreaterThan(order[3]);
    expect(order[3]).toBeGreaterThan(order[4]);
  });
  it('subsequence requires at least 3 typed characters', () => {
    expect(matchScore('ce', 'Category')).toBe(-1);
    expect(matchScore('cte', 'Category')).toBeGreaterThan(0);
  });
  it('spaces in a quoted prefix act as separators', () => {
    expect(matchScore('Order ', 'OrderLines')).toBeGreaterThanOrEqual(85);
  });
  it('segments', () => {
    expect(segments('CustomerId')).toEqual(['Customer', 'Id']);
    expect(segments('order_date')).toEqual(['order', 'date']);
    expect(segments('HTTPServer2Log')).toEqual(['HTTP', 'Server', '2', 'Log']);
  });
  it('sortText keeps higher scores first', () => {
    expect(sortTextFor(9100) < sortTextFor(9000)).toBe(true);
    expect(sortTextFor(9000.5) < sortTextFor(9000.4)).toBe(true);
  });
  it('usage boost grows with use and decays with age', () => {
    let now = Date.UTC(2026, 9, 1);
    const u = new UsageStore({}, () => now);
    expect(u.boost('k')).toBe(0);
    u.record('k');
    const one = u.boost('k');
    u.record('k');
    u.record('k');
    expect(u.boost('k')).toBeGreaterThan(one);
    now += 120 * 24 * 3600 * 1000;
    expect(u.boost('k')).toBeLessThan(one);
    expect(u.boost('k')).toBeLessThanOrEqual(15);
  });
  it('alias generation', () => {
    const taken = new Set(['C', 'O']);
    expect(makeAlias('OrderLines', taken, 'initials')).toBe('ol');
    expect(makeAlias('Countries', taken, 'initials')).toBe('co');
    expect(makeAlias('Orders', taken, 'initials')).toBe('ord'); // 'or' is reserved
    expect(makeAlias('Products', new Set(), 'firstLetter')).toBe('p');
    expect(makeAlias('order_items', new Set(), 'initials')).toBe('oi');
  });
  it.each([
    ['tsql', 'Customers', false], ['tsql', 'Order Details', true], ['tsql', 'select', true], ['tsql', '#tmp', false],
    ['plsql', 'CUSTOMERS', false], ['plsql', 'MixedCase', true], ['plsql', 'DATE', true], ['sqlite', 'order', true], ['sqlite', 'key', false],
  ] as [Dialect, string, boolean][])('needsQuoting(%s, %s) = %s', (d, name, q) => {
    expect(needsQuoting(name, getSpec(d))).toBe(q);
  });
});

describe('catalog index', () => {
  it('incremental per-schema update keeps unchanged schemas', () => {
    const i = createIntel('tsql');
    i.setCatalog(fixtures.tsql);
    const snap = JSON.parse(JSON.stringify(fixtures.tsql));
    snap.schemas[1].version = 2;
    snap.schemas[1].objects.push({ t: 'table', n: 'Refunds', c: [['Id', 'int', 0, 1, 0, null]] });
    i.setCatalog(snap);
    const d = doc(i, 'SELECT * FROM Sales.|');
    expect(i.complete(d.uri, d.offset).items.map((x) => x.label).sort()).toEqual(['Invoices', 'Refunds']);
  });
  it('setCatalog(null) clears', () => {
    const i = createIntel('tsql');
    i.setCatalog(fixtures.tsql);
    i.setCatalog(null);
    const d = doc(i, 'SELECT * FROM |');
    expect(i.complete(d.uri, d.offset).items.some((x) => x.kind === 'table')).toBe(false);
  });
  it('FK graph is bidirectional (incoming FKs hoist referencing tables)', () => {
    const x = at('tsql', 'SELECT * FROM Countries co JOIN |');
    expect(x.i.complete(x.uri, x.offset).items[0].label).toBe('Customers c ON c.CountryId = co.Id');
  });
  it('composite FKs are joined with AND', () => {
    const i = createIntel('sqlite');
    i.setCatalog({ connectionId: 'x', dialect: 'sqlite', database: 'main', defaultSchema: 'main', version: 1, databases: [], schemas: [{ name: 'main', version: 1, objects: [
      { t: 'table', n: 'a', c: [['k1', 'INTEGER', 0, 1, 0, null], ['k2', 'INTEGER', 0, 1, 0, null]], pk: ['k1', 'k2'] },
      { t: 'table', n: 'b', c: [['a1', 'INTEGER', 0, 0, 0, null], ['a2', 'INTEGER', 0, 0, 0, null]], fk: [{ n: 'fk', cols: ['a1', 'a2'], rs: 'main', rt: 'a', rcols: ['k1', 'k2'] }] },
    ] }] });
    const d = doc(i, 'SELECT * FROM a JOIN b ON |');
    expect(i.complete(d.uri, d.offset).items[0].label).toBe('b.a1 = a.k1 AND b.a2 = a.k2');
  });
});

import { describe, expect, it } from 'vitest';
import { getSpec } from '../dialect';
import { tokenize, significant } from '../lexer/lexer';
import { buildModel, scopeAt } from '../parse/partial-parser';
import type { Dialect } from '../types';
import { createIntel } from '../index';
import { complete, doc, find, intelFor, labels } from './helpers';

function model(d: Dialect, sql: string) {
  const spec = getSpec(d);
  const toks = significant(tokenize(sql, spec)).filter((t) => t.kind !== 'batchSep');
  return buildModel(toks, spec, 0, sql.length);
}
const cols = (items: { kind: string; label: string }[]) => items.filter((x) => x.kind === 'column').map((x) => x.label);

describe('partial parser: structure', () => {
  it('table sources with and without AS', () => {
    const m = model('tsql', 'SELECT * FROM a AS x, b y JOIN c ON 1 = 1 LEFT OUTER JOIN d dd ON 1=1 CROSS APPLY f(x.id) fx');
    const s = m.scopes.find((x) => x.kind === 'select')!;
    expect(s.sources.map((r) => [r.parts.map((p) => p.text).join('.'), r.alias, r.kind])).toEqual([
      ['a', 'x', 'table'], ['b', 'y', 'table'], ['c', null, 'table'], ['d', 'dd', 'table'], ['f', 'fx', 'function'],
    ]);
  });
  it('alias is not taken from a following keyword', () => {
    const m = model('tsql', 'SELECT * FROM a WHERE x = 1');
    expect(m.scopes.find((x) => x.kind === 'select')!.sources[0].alias).toBeNull();
  });
  it('contextual keywords are not aliases', () => {
    const m = model('tsql', 'SELECT * FROM a OUTER APPLY f() z');
    const s = m.scopes.find((x) => x.kind === 'select')!;
    expect(s.sources[0].alias).toBeNull();
    expect(s.sources[1].alias).toBe('z');
  });
  it('quoted identifiers and multi-part names', () => {
    const m = model('tsql', 'SELECT * FROM [my db].[dbo].[Order Lines] [o l]');
    const r = m.scopes.find((x) => x.kind === 'select')!.sources[0];
    expect(r.parts.map((p) => p.text)).toEqual(['my db', 'dbo', 'Order Lines']);
    expect(r.alias).toBe('o l');
  });
  it('T-SQL db..table', () => {
    const r = model('tsql', 'SELECT * FROM shop..Orders o').scopes.find((x) => x.kind === 'select')!.sources[0];
    expect(r.parts.map((p) => p.text)).toEqual(['shop', '', 'Orders']);
  });
  it('table hints are skipped', () => {
    const r = model('tsql', 'SELECT * FROM Orders o WITH (NOLOCK) WHERE 1 = 1').scopes.find((x) => x.kind === 'select')!.sources[0];
    expect(r.alias).toBe('o');
  });
  it('derived table with column aliases', () => {
    const r = model('tsql', 'SELECT * FROM (VALUES (1, 2)) v(a, b)').scopes.find((x) => x.kind === 'select' && x.sources.length)!.sources[0];
    expect(r.kind).toBe('values');
    expect(r.columnAliases).toEqual(['a', 'b']);
  });
  it('projections: AS alias, bare alias, T-SQL alias = expr, stars', () => {
    const s = model('tsql', 'SELECT a.x AS ax, y yy, cnt = COUNT(*), a.*, *, @v = 1, CASE WHEN 1=1 THEN 2 END c FROM a').scopes.find((x) => x.kind === 'select')!;
    expect(s.projections.map((p) => [p.alias, p.colRef?.name.text ?? null, p.star ? 'star' : null, !!p.assignment])).toEqual([
      ['ax', 'x', null, false], ['yy', 'y', null, false], ['cnt', null, null, false], [null, null, 'star', false],
      [null, null, 'star', false], [null, null, null, true], ['c', null, null, false],
    ]);
  });
  it('UNION branches are separate scopes', () => {
    const m = model('tsql', 'SELECT a FROM t1 UNION ALL SELECT b FROM t2');
    const sel = m.scopes.filter((x) => x.kind === 'select');
    expect(sel).toHaveLength(2);
    expect(sel[1].isBranch).toBe(true);
    expect(sel[0].sources.map((r) => r.parts[0].text)).toEqual(['t1']);
    expect(sel[1].sources.map((r) => r.parts[0].text)).toEqual(['t2']);
  });
  it('subquery scopes: correlated in WHERE, isolated in FROM and CTE', () => {
    const m = model('tsql', 'WITH c AS (SELECT 1 x) SELECT * FROM (SELECT 2 y) d WHERE EXISTS (SELECT 1 FROM t)');
    const exists = m.scopes.find((x) => x.kind === 'exists')!;
    const derived = m.scopes.find((x) => x.kind === 'subquery')!;
    const cte = m.scopes.find((x) => x.kind === 'cte')!;
    expect(exists.outer).not.toBeNull();
    expect(derived.outer).toBeNull();
    expect(cte.outer).toBeNull();
  });
  it('CROSS APPLY subquery is correlated', () => {
    const m = model('tsql', 'SELECT * FROM a CROSS APPLY (SELECT TOP 1 * FROM b WHERE b.id = a.id) x');
    expect(m.scopes.find((x) => x.kind === 'subquery')!.outer).not.toBeNull();
  });
  it('CTE with explicit column list and RECURSIVE', () => {
    const m = model('sqlite', 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n');
    const owner = m.scopes.find((x) => x.ctes.length)!;
    expect(owner.ctes[0]).toMatchObject({ name: 'n', columns: ['i'], recursive: true });
  });
  it('INSERT target, column list, VALUES count', () => {
    const s = model('tsql', 'INSERT INTO dbo.Orders (a, b, c) VALUES (1, 2), (3, 4)').scopes.find((x) => x.kind === 'insert')!;
    expect(s.targetTable!.parts.map((p) => p.text)).toEqual(['dbo', 'Orders']);
    expect(s.insertColumns!.map((p) => p.text)).toEqual(['a', 'b', 'c']);
    expect(s.valuesCount).toBe(2);
  });
  it('INSERT ... SELECT creates a child select', () => {
    const m = model('tsql', 'INSERT INTO t (a) SELECT x FROM s');
    const ins = m.scopes.find((x) => x.kind === 'insert')!;
    expect(ins.children.some((c) => c.kind === 'select' && c.sources[0].parts[0].text === 's')).toBe(true);
  });
  it('UPDATE with FROM and alias target', () => {
    const s = model('tsql', 'UPDATE o SET o.Total = 1 FROM Orders o WHERE o.Id = 1').scopes.find((x) => x.kind === 'update')!;
    expect(s.targetTable!.parts[0].text).toBe('o');
    expect(s.sources.map((r) => r.alias ?? r.parts[0].text)).toEqual(['o', 'o']);
    expect(s.hasWhere).toBe(true);
  });
  it('DELETE target and WHERE', () => {
    const s = model('sqlite', 'DELETE FROM t WHERE a = 1').scopes.find((x) => x.kind === 'delete')!;
    expect(s.targetTable!.parts[0].text).toBe('t');
    expect(s.hasWhere).toBe(true);
  });
  it('MERGE target, source and ON join', () => {
    const s = model('tsql', 'MERGE INTO t AS tt USING s ss ON tt.id = ss.id WHEN MATCHED THEN UPDATE SET a = 1;').scopes.find((x) => x.kind === 'merge')!;
    expect(s.sources.map((r) => r.alias)).toEqual(['tt', 'ss']);
    expect(s.joins[0].right.alias).toBe('ss');
  });
  it('T-SQL DECLARE variables and table variables', () => {
    const m = model('tsql', 'DECLARE @a int = 5, @b nvarchar(50), @t TABLE (X int NOT NULL, Y decimal(18,2))');
    expect([...m.root.localVars.values()].map((v) => [v.name, v.kind, v.type])).toEqual([
      ['@a', 'var', 'int'], ['@b', 'var', 'nvarchar(50)'], ['@t', 'tableVar', 'TABLE'],
    ]);
    expect(m.root.localVars.get('@T')!.columns!.map((c) => [c.name, c.type, c.nullable])).toEqual([['X', 'int', false], ['Y', 'decimal(18, 2)', true]]);
  });
  it('CREATE TABLE #temp registers columns', () => {
    const m = model('tsql', 'CREATE TABLE #t (Id int PRIMARY KEY IDENTITY(1,1), Name varchar(10) NOT NULL, CONSTRAINT c UNIQUE (Name))');
    expect(m.created[0].kind).toBe('tempTable');
    expect(m.created[0].columns!.map((c) => [c.name, !!c.isPk, !!c.identity])).toEqual([['Id', true, true], ['Name', false, false]]);
  });
  it('SELECT ... INTO #t registers a temp table from the query', () => {
    const m = model('tsql', 'SELECT Id, Total AS T INTO #x FROM Orders');
    expect(m.created[0]).toMatchObject({ name: '#x', kind: 'tempTable' });
    expect(m.created[0].fromScope).toBeTruthy();
  });
  it('T-SQL procedure parameters become variables', () => {
    const m = model('tsql', 'CREATE PROCEDURE p @id int, @name nvarchar(10) = NULL OUTPUT AS BEGIN SELECT @id END');
    expect([...m.root.localVars.values()].map((v) => [v.name, v.kind, v.direction])).toEqual([['@id', 'param', 'in'], ['@name', 'param', 'out']]);
  });
  it('PL/SQL declarations: %ROWTYPE, %TYPE, cursors, constants', () => {
    const m = model('plsql', 'DECLARE r customers%ROWTYPE; n customers.name%TYPE; c CONSTANT NUMBER := 1; CURSOR cur IS SELECT id FROM orders; BEGIN NULL; END;');
    const b = m.scopes.find((x) => x.kind === 'plsqlBlock')!;
    expect(b.localVars.get('R')!.rowtypeOf!.map((p) => p.text)).toEqual(['customers']);
    expect(b.localVars.get('N')!.typeOf!.map((p) => p.text)).toEqual(['customers', 'name']);
    expect(b.localVars.get('C')!.type).toBe('NUMBER');
    expect(b.localVars.get('CUR')!.kind).toBe('cursor');
    expect(b.localVars.get('CUR')!.query).toBeTruthy();
  });
  it('PL/SQL FOR loops register records', () => {
    const m = model('plsql', 'BEGIN FOR r IN (SELECT id, name FROM customers) LOOP NULL; END LOOP; FOR i IN 1..10 LOOP NULL; END LOOP; END;');
    const b = m.scopes.find((x) => x.kind === 'plsqlBlock')!;
    expect(b.localVars.get('R')!.query).toBeTruthy();
    expect(b.localVars.get('I')!.type).toBe('PLS_INTEGER');
  });
  it('PL/SQL nested IF/ELSIF/ELSE and CASE statements are tolerated', () => {
    const m = model('plsql', "BEGIN IF a = 1 THEN NULL; ELSIF a = 2 THEN x := 1; ELSE CASE a WHEN 1 THEN NULL; ELSE NULL; END CASE; END IF; UPDATE t SET a = 1 WHERE b = 2; END;");
    expect(m.scopes.some((x) => x.kind === 'update' && x.hasWhere)).toBe(true);
  });
  it('Oracle (+) outer join does not break parsing', () => {
    const m = model('plsql', 'SELECT * FROM a, b WHERE a.id = b.id(+) AND b.x(+) = 1');
    const s = m.scopes.find((x) => x.kind === 'select')!;
    expect(s.sources.map((r) => r.parts[0].text)).toEqual(['a', 'b']);
    expect(m.chains.filter((c) => c.parts.length === 2).map((c) => c.parts.map((p) => p.text).join('.'))).toEqual(['a.id', 'b.id', 'b.x']);
  });
  it('Oracle dblink sources are remote', () => {
    const r = model('plsql', 'SELECT * FROM emp@remote e').scopes.find((x) => x.kind === 'select')!.sources[0];
    expect(r.remote).toBe(true);
    expect(r.alias).toBe('e');
  });
  it('Oracle trigger :NEW/:OLD rows', () => {
    const m = model('plsql', 'CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON orders FOR EACH ROW BEGIN :NEW.id := 1; END;');
    const b = m.scopes.find((x) => x.kind === 'plsqlBlock')!;
    expect(b.localVars.get('NEW')!.rowtypeOf!.map((p) => p.text)).toEqual(['orders']);
  });
  it('SQLite trigger NEW/OLD rows and body statements', () => {
    const m = model('sqlite', 'CREATE TRIGGER t AFTER UPDATE ON orders BEGIN UPDATE customers SET name = NEW.total WHERE id = OLD.customer_id; END');
    expect(m.scopes.some((x) => x.kind === 'update')).toBe(true);
    expect(m.scopes.find((x) => x.kind === 'plsqlBlock')!.localVars.has('NEW')).toBe(true);
  });
  it('T-SQL statements inside BEGIN/END without semicolons', () => {
    const m = model('tsql', 'BEGIN SELECT a FROM t1 UPDATE t2 SET b = 1 WHERE c = 2 DELETE FROM t3 END');
    expect(m.scopes.filter((s) => s.kind !== 'other').map((s) => s.kind)).toEqual(['select', 'update', 'delete']);
  });
  it('never throws on garbage and keeps every token position valid', () => {
    for (const d of ['tsql', 'plsql', 'sqlite'] as Dialect[]) {
      for (const sql of ['((((', ')))) SELECT', 'SELECT FROM WHERE GROUP BY ORDER BY', 'WITH AS AS AS', 'INSERT INTO ( VALUES ((', 'CREATE', 'BEGIN END END END', 'CASE WHEN THEN END END', ', , ,', "SELECT 'unterminated", 'UPDATE SET = = =', 'MERGE USING ON WHEN THEN']) {
        expect(() => model(d, sql)).not.toThrow();
      }
    }
  });
  it('scopeAt picks the innermost scope', () => {
    const sql = 'SELECT * FROM a WHERE x IN (SELECT y FROM b WHERE z = 1)';
    const m = model('tsql', sql);
    expect(scopeAt(m, sql.indexOf('z')).sources[0].parts[0].text).toBe('b');
    expect(scopeAt(m, sql.indexOf('x')).sources[0].parts[0].text).toBe('a');
  });
});

describe('completion edge cases', () => {
  it('UNION branch only sees its own sources', () => {
    const r = complete('tsql', 'SELECT Name FROM Products UNION SELECT | FROM Countries');
    expect(cols(r.items)).toEqual(['Id', 'Name']);
    expect(r.items.find((x) => x.kind === 'column')!.detail).toBe('Countries');
  });
  it('CTE referenced inside a later CTE body and in the main query', () => {
    const r = complete('tsql', 'WITH a AS (SELECT Id, Name FROM Customers), b AS (SELECT Id FROM a) SELECT * FROM b JOIN a ON a.| ');
    expect(cols(r.items)).toEqual(['Id', 'Name']);
  });
  it('CTE names are offered in FROM first', () => {
    const r = complete('tsql', 'WITH recent AS (SELECT * FROM Orders) SELECT * FROM |');
    expect(r.items[0].label).toBe('recent');
    expect(r.items[0].kind).toBe('cte');
  });
  it('recursive CTE sees itself', () => {
    const r = complete('sqlite', 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT n.| FROM n) SELECT * FROM n');
    expect(cols(r.items)).toEqual(['i']);
  });
  it('derived table with explicit column aliases', () => {
    const r = complete('tsql', 'SELECT * FROM (VALUES (1, 2)) v(a, b) WHERE v.|');
    expect(cols(r.items)).toEqual(['a', 'b']);
  });
  it('subquery * expansion through two levels', () => {
    const r = complete('tsql', 'SELECT * FROM (SELECT * FROM (SELECT Id, Price FROM Products) x) y WHERE y.|');
    expect(cols(r.items)).toEqual(['Id', 'Price']);
  });
  it('qualified star in a subquery', () => {
    const r = complete('tsql', 'SELECT * FROM (SELECT c.*, o.Total FROM Customers c JOIN Orders o ON o.CustomerId = c.Id) z WHERE z.|');
    expect(cols(r.items)).toEqual(['Id', 'Name', 'Email', 'CountryId', 'Total']);
  });
  it('schema-qualified table in FROM', () => {
    const r = complete('tsql', 'SELECT * FROM Sales.Invoices i WHERE i.|');
    expect(cols(r.items)).toEqual(['Id', 'OrderId', 'Amount', 'IssuedAt']);
  });
  it('three-part names in the current database', () => {
    const r = complete('tsql', 'SELECT * FROM shop.dbo.Products p WHERE p.|');
    expect(cols(r.items)).toEqual(['Id', 'Name', 'Price']);
  });
  it('db..table shortcut', () => {
    const r = complete('tsql', 'SELECT * FROM shop..Countries c WHERE c.|');
    expect(cols(r.items)).toEqual(['Id', 'Name']);
  });
  it('database qualifier lists schemas', () => {
    const r = complete('tsql', 'SELECT * FROM shop.|');
    expect(labels(r.items).sort()).toEqual(['Sales', 'dbo']);
  });
  it('table name used as qualifier without alias', () => {
    const r = complete('tsql', 'SELECT Customers.| FROM Customers');
    expect(cols(r.items)).toEqual(['Id', 'Name', 'Email', 'CountryId']);
  });
  it('SELECT before FROM offers columns of all tables and appends FROM', () => {
    const r = complete('tsql', 'SELECT Pri|');
    const it = find(r.items, 'Price')!;
    expect(it.detail).toBe('Products');
    expect(it.insertText).toBe('Price$0 FROM Products');
    expect(it.isSnippet).toBe(true);
  });
  it('statement start: table inserts SELECT * FROM', () => {
    const r = complete('tsql', 'Produ|');
    expect(find(r.items, 'Products')!.insertText).toBe('SELECT * FROM Products');
  });
  it('keyword case setting', () => {
    const r = complete('tsql', 'sel|', { keywordCase: 'lower' });
    expect(r.items[0].label).toBe('select');
  });
  it('identifier case: matchPrefix', () => {
    const r = complete('plsql', 'SELECT * FROM cust|', { identifierCase: 'matchPrefix' });
    expect(find(r.items, 'CUSTOMERS')!.insertText).toBe('customers');
  });
  it('qualifyObjects=always', () => {
    const r = complete('tsql', 'SELECT * FROM Prod|', { qualifyObjects: 'always' });
    expect(find(r.items, 'Products')!.insertText).toBe('dbo.Products');
  });
  it('qualifyColumns=always', () => {
    const r = complete('tsql', 'SELECT | FROM Products p', { qualifyColumns: 'always' });
    expect(find(r.items, 'Price')!.insertText).toBe('p.Price');
  });
  it('reserved-word and spaced names are quoted with the dialect quote', () => {
    const i = createIntel('tsql');
    i.setCatalog({ connectionId: 'q', dialect: 'tsql', database: 'q', defaultSchema: 'dbo', version: 1, databases: [], schemas: [{ name: 'dbo', version: 1, objects: [{ t: 'table', n: 'Order Details', c: [['Key', 'int', 0, 0, 0, null]] }, { t: 'table', n: 'Select', c: [] }] }] });
    const d0 = doc(i, 'SELECT * FROM |');
    const r = i.complete(d0.uri, d0.offset);
    expect(find(r.items, 'Order Details')!.insertText).toBe('[Order Details]');
    expect(find(r.items, 'Select')!.insertText).toBe('[Select]');
    const d = doc(i, 'SELECT d.| FROM [Order Details] d');
    expect(i.complete(d.uri, d.offset).items.find((x) => x.label === 'Key')!.insertText).toBe('[Key]');
    const o = createIntel('plsql');
    o.setCatalog({ connectionId: 'q', dialect: 'plsql', database: null, defaultSchema: 'S', version: 1, databases: [], schemas: [{ name: 'S', version: 1, objects: [{ t: 'table', n: 'lower_case', c: [] }, { t: 'table', n: 'SIZE', c: [] }] }] });
    const d2 = doc(o, 'SELECT * FROM |');
    const r2 = o.complete(d2.uri, d2.offset);
    expect(find(r2.items, 'lower_case')!.insertText).toBe('"lower_case"');
    expect(find(r2.items, 'SIZE')!.insertText).toBe('"SIZE"');
  });
  it('typed opening bracket with closing bracket after the cursor', () => {
    const r = complete('tsql', 'SELECT * FROM [Cou|]');
    expect(find(r.items, 'Countries')!.range).toEqual(['SELECT * FROM '.length, 'SELECT * FROM [Cou]'.length]);
  });
  it('@ prefix → variables and @@ globals only', () => {
    const r = complete('tsql', 'DECLARE @total int; SELECT @|');
    expect(r.items[0].label).toBe('@total');
    expect(r.items.every((x) => x.label.startsWith('@'))).toBe(true);
    const g = complete('tsql', 'SELECT @@ROW|');
    expect(g.items[0].label).toBe('@@ROWCOUNT');
  });
  it('# prefix in FROM → temp tables', () => {
    const r = complete('tsql', 'CREATE TABLE #work (a int);\nSELECT * FROM #w|');
    expect(r.items[0].label).toBe('#work');
  });
  it('CREATE TABLE earlier in the script is known before the catalog refresh', () => {
    const r = complete('sqlite', 'CREATE TABLE audit (id INTEGER, at TEXT);\nSELECT a.| FROM audit a');
    expect(cols(r.items)).toEqual(['id', 'at']);
  });
  it('T-SQL trigger inserted/deleted pseudo tables', () => {
    const r = complete('tsql', 'CREATE TRIGGER trg ON Orders AFTER UPDATE AS BEGIN SELECT i.| FROM inserted i END');
    expect(cols(r.items)).toEqual(['Id', 'CustomerId', 'OrderDate', 'Total']);
  });
  it('Oracle cursor FOR loop record', () => {
    const r = complete('plsql', 'BEGIN FOR rec IN (SELECT id, name FROM customers) LOOP dbms_output.put_line(rec.|); END LOOP; END;');
    expect(cols(r.items)).toEqual(['ID', 'NAME']);
  });
  it('Oracle named cursor record', () => {
    const r = complete('plsql', 'DECLARE CURSOR c IS SELECT id, total FROM orders; BEGIN FOR r IN c LOOP x := r.|; END LOOP; END;');
    expect(cols(r.items)).toEqual(['ID', 'TOTAL']);
  });
  it('Oracle %ROWTYPE of a cursor', () => {
    const r = complete('plsql', 'DECLARE CURSOR c IS SELECT id FROM orders; v c%ROWTYPE; BEGIN x := v.|; END;');
    expect(cols(r.items)).toEqual(['ID']);
  });
  it('Oracle trigger :NEW.', () => {
    const r = complete('plsql', 'CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON orders FOR EACH ROW BEGIN :NEW.| END;');
    expect(cols(r.items)).toEqual(['ID', 'CUSTOMER_ID', 'ORDER_DATE', 'TOTAL']);
  });
  it('Oracle built-in package members', () => {
    const r = complete('plsql', 'BEGIN dbms_output.|');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['PUT_LINE', 'ENABLE', 'GET_LINES']));
  });
  it('Oracle schema.package.member', () => {
    const r = complete('plsql', 'BEGIN shop.order_api.|');
    expect(labels(r.items).sort()).toEqual(['CREATE_ORDER', 'GET_TOTAL']);
  });
  it('Oracle other schema objects', () => {
    const r = complete('plsql', 'SELECT * FROM hr.|');
    expect(labels(r.items)).toEqual(['EMPLOYEES']);
  });
  it('unknown schema qualifier asks the host to load it', () => {
    const i = intelFor('tsql', { aliasStyle: 'firstLetter' });
    const asked: string[] = [];
    i.setSchemaRequester((s) => asked.push(s));
    const d = doc(i, 'SELECT * FROM Reporting.|');
    const r = i.complete(d.uri, d.offset);
    expect(r.items).toEqual([]);
    expect(r.isIncomplete).toBe(true);
    expect(asked).toEqual(['Reporting']);
  });
  it('JOIN ... USING marker and NATURAL JOIN', () => {
    const r = complete('sqlite', 'SELECT * FROM orders NATURAL JOIN |');
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.some((x) => x.label === 'customers')).toBe(true);
  });
  it('after a complete FROM source → keyword flow', () => {
    const r = complete('tsql', 'SELECT * FROM Orders o |');
    expect(labels(r.items, 3)).toEqual(expect.arrayContaining(['WHERE']));
    expect(r.items.some((x) => x.kind === 'table')).toBe(false);
  });
  it('typing the alias keeps keyword suggestions', () => {
    const r = complete('tsql', 'SELECT * FROM Orders W|');
    expect(r.items[0].label).toBe('WHERE');
  });
  it('ORDER BY after an expression → ASC/DESC', () => {
    const r = complete('tsql', 'SELECT * FROM Orders ORDER BY Total |');
    expect(labels(r.items, 2)).toEqual(['ASC', 'DESC']);
  });
  it('GROUP BY after an expression → HAVING first', () => {
    const r = complete('tsql', 'SELECT CustomerId FROM Orders GROUP BY CustomerId |');
    expect(r.items[0].label).toBe('HAVING');
  });
  it('alias generation avoids taken aliases and reserved words', () => {
    const r = complete('tsql', 'SELECT * FROM OrderLines o JOIN Orders ord ON ord.Id = o.OrderId JOIN |');
    expect(r.items.some((x) => x.label.startsWith('Products p ON p.Id = o.ProductId'))).toBe(true);
    expect(r.items.some((x) => x.label.startsWith('Customers c ON c.Id = ord.CustomerId'))).toBe(true);
  });
  it('function completion inserts parentheses and triggers signature help', () => {
    const r = complete('tsql', 'SELECT DATEAD|');
    const f = find(r.items, 'DATEADD')!;
    expect(f.insertText).toBe('DATEADD($0)');
    expect(f.command).toBe('signatureHelp');
  });
  it('niladic functions insert no parentheses', () => {
    const r = complete('plsql', 'SELECT SYSDAT|');
    expect(find(r.items, 'SYSDATE')!.insertText).toBe('SYSDATE');
  });
  it('usage ranking boosts accepted items', () => {
    const i = intelFor('tsql', { maxColumnsWithoutFrom: 2999 });
    const first = i.complete(doc(i, 'SELECT | FROM Customers').uri, 7);
    const email = first.items.find((x) => x.label === 'Email')!;
    expect(first.items[0].label).toBe('Id');
    for (let k = 0; k < 5; k++) i.recordAccepted(email);
    const again = i.complete(doc(i, 'SELECT | FROM Customers').uri, 7);
    expect(again.items[0].label).toBe('Email');
    expect(Object.keys(i.getUsage())).toContain(email.usageKey!);
  });
  it('no completion right after a number', () => {
    expect(complete('tsql', 'SELECT 12|').items).toEqual([]);
  });
  it('no completion inside a block comment, completion after it', () => {
    expect(complete('tsql', 'SELECT /* Cu| */ 1').items).toEqual([]);
    expect(complete('tsql', 'SELECT /* x */ | FROM Products').items[0].label).toBe('Id');
  });
  it('completion after ; starts a new statement', () => {
    const r = complete('tsql', 'SELECT 1; |');
    expect(r.items[0].label).toBe('SELECT');
  });
  it('INSERT column list excludes already listed columns', () => {
    const r = complete('tsql', 'INSERT INTO Orders (Total, |');
    expect(cols(r.items)).toEqual(['CustomerId', 'OrderDate']);
  });
  it('INSERT without column list: VALUES snippet uses insertable columns', () => {
    const r = complete('tsql', 'INSERT INTO Countries VALUES (|');
    expect(r.items[0].insertText).toBe('${1:Id}, ${2:Name}');
  });
  it('VALUES snippet uses NULL placeholders for nullable columns', () => {
    const r = complete('tsql', 'INSERT INTO Customers (Name, Email) VALUES (|');
    expect(r.items[0].insertText).toBe('${1:Name}, ${2:NULL}');
  });
  it('MERGE WHEN NOT MATCHED INSERT column list targets the MERGE target', () => {
    const r = complete('tsql', 'MERGE INTO Countries t USING Countries s ON t.Id = s.Id WHEN NOT MATCHED THEN INSERT (|');
    expect(cols(r.items)).toEqual(['Id', 'Name']);
  });
  it('SQLite upsert excluded + RETURNING', () => {
    const r = complete('sqlite', 'INSERT INTO orders (id, total) VALUES (1, 2) RETURNING |');
    expect(cols(r.items)).toEqual(['id', 'customer_id', 'order_date', 'total']);
  });
  it('ALTER TABLE ... ALTER COLUMN suggests columns of the table', () => {
    const r = complete('tsql', 'ALTER TABLE Orders ALTER COLUMN |');
    expect(cols(r.items)).toEqual(['Id', 'CustomerId', 'OrderDate', 'Total']);
  });
  it('column definition data types', () => {
    const r = complete('tsql', 'CREATE TABLE x (a nvar|');
    expect(r.items[0].label.toLowerCase()).toBe('nvarchar');
  });
  it('DROP TABLE suggests tables only', () => {
    const r = complete('tsql', 'DROP TABLE |');
    expect(r.items.every((x) => x.kind === 'table' || x.kind === 'schema')).toBe(true);
    expect(labels(r.items)).toContain('Orders');
  });
  it('DECLARE type position offers data types', () => {
    const r = complete('tsql', 'DECLARE @x |');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['INT', 'NVARCHAR', 'TABLE']));
  });
  it('PL/SQL declare: table%ROWTYPE via table names and data types', () => {
    const r = complete('plsql', 'DECLARE v |');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['NUMBER', 'VARCHAR2', 'CUSTOMERS']));
  });
  it('EXEC schema-qualified procedures', () => {
    const r = complete('tsql', 'EXEC Sales.|');
    expect(labels(r.items)).toEqual(['CloseInvoice']);
  });
  it('EXEC args skip already named parameters', () => {
    const r = complete('plsql', 'BEGIN log_event(p_msg => 1, |');
    expect(find(r.items, 'p_level =>')).toBeTruthy();
    expect(find(r.items, 'p_msg =>')).toBeFalsy();
  });
});


// The 54 acceptance cases of PLAN 4.14.
import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot } from '../../api/types';
import { createIntel } from '../index';
import type { Dialect } from '../types';
import { complete, doc, find, fixtures, indexOf, intelFor, labels, stripMd } from './helpers';

const cols = (items: { kind: string; label: string }[]) => items.filter((x) => x.kind === 'column').map((x) => x.label);

describe('4.14 T-SQL completion', () => {
  it('#1 SELECT | FROM Customers c → columns first, then alias, *, functions; no tables', () => {
    const r = complete('tsql', 'SELECT | FROM Customers c');
    expect(labels(r.items, 4)).toEqual(['Id', 'Name', 'Email', 'CountryId']);
    expect(r.items[0].detail).toBe('c · Customers');
    const ic = indexOf(r.items, 'c', (x) => x.kind === 'alias');
    const star = indexOf(r.items, '*');
    const fn = r.items.findIndex((x) => x.kind === 'function');
    expect(ic).toBe(4);
    expect(star).toBeGreaterThan(ic);
    expect(fn).toBeGreaterThan(star);
    expect(r.items.some((x) => x.kind === 'table')).toBe(false);
  });

  it('#2 SELECT c.| → exactly the columns of Customers + *', () => {
    const r = complete('tsql', 'SELECT c.| FROM Customers c');
    expect(labels(r.items).sort()).toEqual(['*', 'CountryId', 'Email', 'Id', 'Name'].sort());
    expect(r.items.some((x) => x.kind === 'keyword')).toBe(false);
  });

  it('#3 SELECT c.na| → Name first, CountryId not before Name', () => {
    const r = complete('tsql', 'SELECT c.na| FROM Customers c JOIN Orders o ON o.CustomerId = c.Id');
    expect(r.items[0].label).toBe('Name');
    const ci = indexOf(r.items, 'CountryId');
    expect(ci === -1 || ci > 0).toBe(true);
  });

  it('#4 two sources → Id twice, qualified inserts', () => {
    const r = complete('tsql', 'SELECT | FROM Customers c JOIN Orders o ON o.CustomerId = c.Id');
    const ids = r.items.filter((x) => x.label === 'Id' && x.kind === 'column');
    expect(ids.map((x) => x.detail).sort()).toEqual(['c · Customers', 'o · Orders']);
    expect(ids.map((x) => x.insertText).sort()).toEqual(['c.Id', 'o.Id']);
    expect(cols(r.items)).toEqual(expect.arrayContaining(['Name', 'Email', 'CountryId', 'CustomerId', 'OrderDate', 'Total']));
    expect(find(r.items, 'Name')!.insertText).toBe('Name'); // unambiguous → bare
  });

  it('#5 SELECT * FROM | → dbo tables/views, Sales schema; no columns, no functions', () => {
    const r = complete('tsql', 'SELECT * FROM |');
    const top = labels(r.items, 7);
    expect(top).toEqual(expect.arrayContaining(['Customers', 'Orders', 'OrderLines', 'Products', 'Countries', 'vActiveCustomers']));
    expect(find(r.items, 'Sales', (x) => x.kind === 'schema')).toBeTruthy();
    expect(r.items.some((x) => x.kind === 'column' || x.kind === 'function')).toBe(false);
  });

  it('#6 SELECT * FROM Sales.| → Invoices only', () => {
    const r = complete('tsql', 'SELECT * FROM Sales.|');
    expect(labels(r.items)).toEqual(['Invoices']);
  });

  it('#7 JOIN | → FK related tables and join snippets on top', () => {
    const r = complete('tsql', 'SELECT * FROM Customers c JOIN |');
    const top = labels(r.items, 4);
    expect(top).toEqual(expect.arrayContaining(['Orders', 'Orders o ON o.CustomerId = c.Id', 'Countries co ON co.Id = c.CountryId']));
    const snip = find(r.items, 'Orders o ON o.CustomerId = c.Id')!;
    expect(snip.kind).toBe('snippet');
    expect(snip.insertText).toBe('Orders o ON o.CustomerId = c.Id');
    expect(snip.detail).toBe('FK_Orders_Customers');
    expect(indexOf(r.items, 'Products')).toBeGreaterThan(indexOf(r.items, 'Orders'));
  });

  it('#8 JOIN Orders o ON | → FK condition, then o columns, then c columns', () => {
    const r = complete('tsql', 'SELECT * FROM Customers c JOIN Orders o ON |');
    expect(r.items[0].label).toBe('o.CustomerId = c.Id');
    const colItems = r.items.filter((x) => x.kind === 'column');
    const firstC = colItems.findIndex((x) => x.detail?.startsWith('c '));
    const lastO = colItems.map((x) => x.detail?.startsWith('o ')).lastIndexOf(true);
    expect(lastO).toBeLessThan(firstC);
  });

  it('#9 second JOIN hoists FK tables of every alias with the right alias in snippets', () => {
    const r = complete('tsql', 'SELECT * FROM Orders o JOIN OrderLines ol ON ol.OrderId = o.Id JOIN |');
    const top = labels(r.items, 6);
    expect(top).toEqual(expect.arrayContaining(['Products', 'Customers']));
    expect(find(r.items, 'Products p ON p.Id = ol.ProductId')).toBeTruthy();
    expect(find(r.items, 'Customers c ON c.Id = o.CustomerId')).toBeTruthy();
  });

  it('#10 INSERT INTO Orders (| → insertable columns by ordinal, all-columns item, identity only with prefix', () => {
    const r = complete('tsql', 'INSERT INTO Orders (|');
    expect(r.items[0].insertText).toBe('CustomerId, OrderDate, Total');
    expect(r.items[0].detail).toBe('all insertable columns');
    expect(cols(r.items)).toEqual(['CustomerId', 'OrderDate', 'Total']);
    const withI = complete('tsql', 'INSERT INTO Orders (I|');
    expect(find(withI.items, 'Id', (x) => x.kind === 'column')).toBeTruthy();
  });

  it('#11 VALUES (| → snippet with the column list, NULL, DEFAULT, functions', () => {
    const r = complete('tsql', 'INSERT INTO Orders (CustomerId, Total) VALUES (|');
    expect(r.items[0].insertText).toBe('${1:CustomerId}, ${2:Total}');
    expect(r.items[0].isSnippet).toBe(true);
    expect(find(r.items, 'NULL')).toBeTruthy();
    expect(find(r.items, 'DEFAULT')).toBeTruthy();
    expect(find(r.items, 'GETDATE', (x) => x.kind === 'function')).toBeTruthy();
  });

  it('#12 UPDATE Orders SET | → columns of Orders only, no identity', () => {
    const r = complete('tsql', 'UPDATE Orders SET |');
    expect(cols(r.items)).toEqual(['CustomerId', 'OrderDate', 'Total']);
    expect(r.items.every((x) => x.kind === 'column')).toBe(true);
  });

  it('#13 UPDATE alias ... FROM ... WHERE c.| → columns of Customers', () => {
    const r = complete('tsql', 'UPDATE o SET o.Total = 1 FROM Orders o JOIN Customers c ON c.Id = o.CustomerId WHERE c.|');
    expect(cols(r.items)).toEqual(['Id', 'Name', 'Email', 'CountryId']);
  });

  it('#14 CTE output columns through the CTE alias', () => {
    const r = complete('tsql', 'WITH big AS (SELECT Id, Total AS Amt FROM Orders) SELECT b.| FROM big b');
    expect(cols(r.items)).toEqual(['Id', 'Amt']);
  });

  it('#15 CTE * expansion inside a later CTE', () => {
    const r = complete('tsql', 'WITH a AS (SELECT * FROM Customers), b AS (SELECT a.| FROM a)');
    expect(cols(r.items)).toEqual(['Id', 'Name', 'Email', 'CountryId']);
  });

  it('#16 derived table columns', () => {
    const r = complete('tsql', 'SELECT * FROM (SELECT Id, Name FROM Products) p WHERE p.|');
    expect(cols(r.items)).toEqual(['Id', 'Name']);
  });

  it('#17 EXISTS subquery sees outer alias; inner ranked first', () => {
    const r = complete('tsql', 'SELECT * FROM Customers c WHERE EXISTS (SELECT 1 FROM Orders o WHERE o.CustomerId = |)');
    const colItems = r.items.filter((x) => x.kind === 'column');
    expect(colItems.some((x) => x.insertText === 'c.Id')).toBe(true);
    expect(colItems.some((x) => x.insertText === 'o.Id')).toBe(true);
    const firstC = colItems.findIndex((x) => x.detail?.startsWith('c '));
    const lastO = colItems.map((x) => x.detail?.startsWith('o ')).lastIndexOf(true);
    expect(lastO).toBeLessThan(firstC);
  });

  it('#18 backward inference: tables having the selected column first', () => {
    const r = complete('tsql', 'SELECT Name FROM |');
    const top = labels(r.items.filter((x) => x.kind === 'table' || x.kind === 'view'), 4);
    expect(top).toEqual(expect.arrayContaining(['Customers', 'Products', 'Countries']));
    expect(indexOf(r.items, 'Orders')).toBeGreaterThan(indexOf(r.items, 'Countries'));
  });

  it('#19 [Order | → OrderLines matches ignoring the bracket, typed [ replaced', () => {
    const r = complete('tsql', 'SELECT * FROM [Order |');
    const it = find(r.items, 'OrderLines')!;
    expect(it).toBeTruthy();
    expect(it.insertText).toBe('OrderLines');
    expect(r.replaceRange[0]).toBe('SELECT * FROM '.length);
    expect(r.items[0].label === 'OrderLines' || r.items[0].label === 'Orders').toBe(true);
  });

  it('#20 Cust| → synonym and Customers; Customers first', () => {
    const r = complete('tsql', 'SELECT * FROM Cust|');
    const syn = find(r.items, 'Cust')!;
    expect(syn.kind).toBe('synonym');
    expect(syn.detail).toBe('→ dbo.Customers');
    expect(indexOf(r.items, 'Customers')).toBeLessThan(indexOf(r.items, 'Cust'));
  });

  it('#21 columns through a synonym', () => {
    const r = complete('tsql', 'SELECT * FROM Cust s WHERE s.|');
    expect(cols(r.items)).toEqual(['Id', 'Name', 'Email', 'CountryId']);
  });

  it('#22 EXEC | → procedures and schema items', () => {
    const r = complete('tsql', 'EXEC |');
    expect(r.items[0].label).toBe('GetCustomer');
    expect(find(r.items, 'Sales', (x) => x.kind === 'schema')).toBeTruthy();
  });

  it('#23 EXEC GetCustomer | → @Id = snippet; signature help @Id int', () => {
    const r = complete('tsql', 'EXEC GetCustomer |');
    expect(r.items[0].insertText).toBe('@Id = ');
    const i = intelFor('tsql');
    const d = doc(i, 'EXEC GetCustomer |');
    const sh = i.signatureHelp(d.uri, d.offset)!;
    expect(sh.signatures[0].parameters.map((p) => p.label)).toEqual(['@Id int']);
    expect(sh.activeParameter).toBe(0);
  });

  it('#24 table variable columns', () => {
    const r = complete('tsql', 'DECLARE @t TABLE (X int, Y nvarchar(10)); SELECT | FROM @t');
    expect(labels(r.items, 2)).toEqual(['X', 'Y']);
  });

  it('#25 temp table remembered across GO batches', () => {
    const r = complete('tsql', 'SELECT Id INTO #tmp FROM Orders;\nGO\nSELECT | FROM #tmp');
    expect(r.items[0].label).toBe('Id');
    expect(r.items[0].kind).toBe('column');
  });

  it('#26 dbo.fn| → fnTax with signature; signature help after (', () => {
    const r = complete('tsql', 'SELECT dbo.fn|');
    const f = find(r.items, 'fnTax')!;
    expect(f.detail).toBe('(@amount decimal)');
    const i = intelFor('tsql');
    const d = doc(i, 'SELECT dbo.fnTax(|');
    const sh = i.signatureHelp(d.uri, d.offset)!;
    expect(sh.signatures[0].label).toContain('@amount decimal');
  });

  it('#27 ORDER BY → columns; projection aliases listed', () => {
    const r = complete('tsql', 'SELECT * FROM Orders ORDER BY |');
    expect(cols(r.items)).toEqual(['Id', 'CustomerId', 'OrderDate', 'Total']);
    const r2 = complete('tsql', 'SELECT Total AS T FROM Orders ORDER BY |');
    expect(find(r2.items, 'T', (x) => x.kind === 'alias')).toBeTruthy();
  });

  it('#28 after a complete predicate keywords rank above columns', () => {
    const r = complete('tsql', 'SELECT * FROM Orders WHERE Total > 10 |');
    const firstCol = r.items.findIndex((x) => x.kind === 'column');
    for (const k of ['AND', 'OR', 'ORDER BY', 'GROUP BY']) {
      const i = indexOf(r.items, k);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(firstCol);
    }
  });

  it('#29 statement start after GO; statementAt is the third statement', () => {
    const r = complete('tsql', 'SELECT 1\nGO\nSEL|');
    expect(r.items[0].label).toBe('SELECT');
    expect(r.items.some((x) => x.kind === 'snippet' && x.label === 'sel')).toBe(true);
    const i = intelFor('tsql');
    const d = doc(i, 'SELECT 1\nGO\nSEL|');
    const st = i.statementAt(d.uri, d.offset)!;
    expect(st.index).toBe(1);
    expect(st.text).toBe('SEL');
    expect(st.batchIndex).toBe(1);
    expect(i.batchesFor(d.uri)).toEqual([{ sql: 'SELECT 1', line: 1, col: 1 }, { sql: 'SEL', line: 3, col: 1 }]);
  });

  it('#30 splitting with ;, blank lines, statement starts and a procedure body', () => {
    const i = intelFor('tsql');
    const d = doc(i, 'SELECT 1;\n\nSELECT 2\nSELECT 3\nGO\nCREATE PROC p AS\nBEGIN\n SELECT 4\n SELECT 5\nEND\nGO');
    expect(i.statements(d.uri).map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3', 'CREATE PROC p AS\nBEGIN\n SELECT 4\n SELECT 5\nEND']);
    expect(i.batchesFor(d.uri)).toHaveLength(2);
  });
});

describe('4.14 PL/SQL completion', () => {
  it('#31 columns resolved case-insensitively from the upper-case catalog', () => {
    const r = complete('plsql', 'SELECT | FROM customers c');
    expect(labels(r.items, 4)).toEqual(['ID', 'NAME', 'EMAIL', 'COUNTRY_ID']);
  });

  it('#32 schema qualifier → tables/views/packages/sequences/synonyms', () => {
    const r = complete('plsql', 'SELECT * FROM shop.|');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['CUSTOMERS', 'ORDERS', 'V_ORDER_TOTALS', 'ORDER_API', 'ORDERS_SEQ', 'CUST']));
    expect(indexOf(r.items, 'CUSTOMERS')).toBeLessThan(indexOf(r.items, 'ORDER_API'));
  });

  it('#33 package members with parameter details', () => {
    const r = complete('plsql', 'BEGIN order_api.|');
    expect(labels(r.items).sort()).toEqual(['CREATE_ORDER', 'GET_TOTAL']);
    expect(find(r.items, 'CREATE_ORDER')!.detail).toBe('(p_cust IN NUMBER, p_total IN NUMBER)');
    expect(find(r.items, 'GET_TOTAL')!.detail).toBe('(p_id IN NUMBER) RETURN NUMBER');
  });

  it('#34 sequence pseudo columns', () => {
    const r = complete('plsql', 'SELECT orders_seq.|');
    expect(labels(r.items).sort()).toEqual(['CURRVAL', 'NEXTVAL']);
  });

  it('#35 private synonym columns', () => {
    const r = complete('plsql', 'SELECT * FROM cust WHERE |');
    expect(cols(r.items)).toEqual(['ID', 'NAME', 'EMAIL', 'COUNTRY_ID']);
  });

  it('#36 DUAL via PUBLIC synonym; lazy resolver invoked with DUAL', async () => {
    const intel = createIntel('plsql');
    intel.setCatalog(fixtures.plsql);
    const asked: string[] = [];
    intel.setPublicSynonymResolver(async (name) => {
      asked.push(name);
      return name === 'DUAL' ? { t: 'table', n: 'DUAL', c: [['DUMMY', 'VARCHAR2(1)', 1, 0, 0, null]] } : null;
    });
    const r = complete('plsql', 'SELECT * FROM dual|', undefined, intel);
    expect(asked).toContain('DUAL');
    expect(find(r.items, 'DUAL')).toBeTruthy();
    await Promise.resolve();
    await Promise.resolve();
    const r2 = complete('plsql', 'SELECT * FROM dual d WHERE d.|', undefined, intel);
    expect(cols(r2.items)).toEqual(['DUMMY']);
  });

  it('#37 %ROWTYPE record fields', () => {
    const r = complete('plsql', 'DECLARE r customers%ROWTYPE; BEGIN SELECT * INTO r FROM customers WHERE id=1; dbms_output.put_line(r.|); END;');
    expect(cols(r.items)).toEqual(['ID', 'NAME', 'EMAIL', 'COUNTRY_ID']);
  });

  it('#38 quoted mixed-case names keep their quotes; unquoted name does not resolve', () => {
    const r = complete('plsql', 'SELECT * FROM "Mixed|"');
    const it = find(r.items, 'MixedCase')!;
    expect(it.insertText).toBe('"MixedCase');
    const r2 = complete('plsql', 'SELECT * FROM M|');
    expect(find(r2.items, 'MixedCase')!.insertText).toBe('"MixedCase"');
    const r3 = complete('plsql', 'SELECT * FROM mixedcase m WHERE m.|');
    expect(cols(r3.items)).toEqual([]);
    const r4 = complete('plsql', 'SELECT * FROM "MixedCase" m WHERE m.|');
    expect(cols(r4.items)).toEqual(['Value', 'ID']);
  });

  it('#39 splitting: SQL, block, procedure, SQL; / lines excluded', () => {
    const i = intelFor('plsql');
    const d = doc(i, 'SELECT 1 FROM dual;\nBEGIN\n NULL;\nEND;\n/\nCREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;\n/\nSELECT 2 FROM dual;');
    const sts = i.statements(d.uri);
    expect(sts.map((s) => s.text)).toEqual(['SELECT 1 FROM dual', 'BEGIN\n NULL;\nEND;', 'CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;', 'SELECT 2 FROM dual']);
    expect(sts.map((s) => s.isPlsqlBlock)).toEqual([false, true, true, false]);
  });

  it('#40 package procedure signature with arg 2 active and named-notation item', () => {
    const i = intelFor('plsql');
    const d = doc(i, 'BEGIN order_api.create_order(1, |');
    const sh = i.signatureHelp(d.uri, d.offset)!;
    expect(sh.signatures[0].label).toBe('order_api.create_order(p_cust IN NUMBER, p_total IN NUMBER)');
    expect(sh.activeParameter).toBe(1);
    const r = i.complete(d.uri, d.offset);
    expect(find(r.items, 'p_total =>')).toBeTruthy();
    expect(find(r.items, 'p_cust =>')).toBeFalsy();
  });
});

describe('4.14 SQLite', () => {
  it('#41 attached database tables', () => {
    const r = complete('sqlite', 'SELECT * FROM archive.|');
    expect(labels(r.items).sort()).toEqual(['customers_old', 'orders_2020']);
  });

  it('#42 json_extract signature help; -> operator hover', () => {
    const i = intelFor('sqlite');
    const d = doc(i, 'SELECT json_extract(|');
    const sh = i.signatureHelp(d.uri, d.offset)!;
    expect(sh.signatures[0].label.toLowerCase()).toContain('json_extract(');
    const h = doc(i, "SELECT data -|> '$.a' FROM t");
    const hv = i.hover(h.uri, h.offset)!;
    expect(hv.markdown).toContain('->');
  });

  it('#43 INSERT column list excludes the INTEGER PRIMARY KEY rowid alias', () => {
    const r = complete('sqlite', 'INSERT INTO orders (|');
    expect(cols(r.items)).toEqual(['customer_id', 'order_date', 'total']);
  });

  it('#44 clause detection with LIMIT after the cursor', () => {
    const r = complete('sqlite', 'SELECT * FROM orders o WHERE o.| LIMIT 1');
    expect(cols(r.items)).toEqual(['id', 'customer_id', 'order_date', 'total']);
  });
});

describe('4.14 all dialects', () => {
  const owner: Record<Dialect, string> = { tsql: 'dbo.Customers', plsql: 'SHOP.CUSTOMERS', sqlite: 'main.customers' };
  for (const dialect of ['tsql', 'plsql', 'sqlite'] as Dialect[]) {
    it(`#45 ${dialect}: unknown column through a resolved qualifier`, () => {
      const i = intelFor(dialect);
      const d = doc(i, 'SELECT c.Nmae FROM Customers c');
      const diags = i.softDiagnostics(d.uri);
      const w = diags.find((x) => x.code === 'unknown-column')!;
      expect(w.severity).toBe('warning');
      expect(w.message).toBe(`Column 'Nmae' not found in ${owner[dialect]}`);
      expect(d.text.slice(w.start, w.end)).toBe('Nmae');
      expect(w.line).toBe(1);
      expect(w.col).toBe(10);
    });

    it(`#46 ${dialect}: DELETE without WHERE`, () => {
      const i = intelFor(dialect);
      const d = doc(i, 'DELETE FROM Orders');
      expect(i.softDiagnostics(d.uri).some((x) => x.code === 'no-where' && x.severity === 'warning' && x.message === 'DELETE without WHERE')).toBe(true);
      expect(i.classify('DELETE FROM Orders')).toBe('delete:destructive');
      expect(i.classify('DELETE FROM Orders WHERE Id = 1')).toBe('delete');
    });

    it(`#47 ${dialect}: hover on alias`, () => {
      const i = intelFor(dialect);
      const d = doc(i, 'SELECT * FROM Customers c|');
      const h = i.hover(d.uri, d.offset - 1)!;
      expect(stripMd(h.markdown)).toContain(`alias c → ${owner[dialect]} (table), 4 columns`);
    });

    it(`#48 ${dialect}: F12 on table → object; on alias → its definition`, () => {
      const i = intelFor(dialect);
      const d = doc(i, 'SELECT c.Name FROM Customers c');
      const def = i.definition(d.uri, d.text.indexOf('Customers') + 2)!;
      const [schema, name] = owner[dialect].split('.');
      expect(def).toEqual({ kind: 'object', ref: { database: fixtures[dialect].database, schema, name, type: 'table' } });
      const a = i.definition(d.uri, d.text.indexOf('c.Name'))!;
      const aliasAt = d.text.lastIndexOf(' c') + 1;
      expect(a).toEqual({ kind: 'local', range: [aliasAt, aliasAt + 1] });
    });
  }
});

describe('4.14 perf (#49)', () => {
  it('5,000 tables × 20 columns: index build < 150 ms, completion p95 < 5 ms on a 300-line script', () => {
    const objects = [];
    for (let t = 0; t < 5000; t++) {
      const c = [];
      for (let k = 0; k < 20; k++) c.push([k === 0 ? 'Id' : `Col${k}_${t % 50}`, 'int', 1, k === 0 ? 1 : 0, 0, null]);
      objects.push({ t: 'table', n: `Table${t}`, c, pk: ['Id'], fk: t > 0 ? [{ n: `FK_${t}`, cols: ['Col1_' + (t % 50)], rs: 'dbo', rt: `Table${t - 1}`, rcols: ['Id'] }] : [] });
    }
    objects.push({ t: 'table', n: 'Customers', c: fixtures.tsql.schemas[0].objects[0].c, pk: ['Id'] });
    const snap = { connectionId: 'perf', dialect: 'tsql', database: 'big', defaultSchema: 'dbo', version: 1, databases: [], schemas: [{ name: 'dbo', version: 1, objects }] } as unknown as CatalogSnapshot;
    const intel = createIntel('tsql');
    // warm up the JIT on a small catalog first
    intel.setCatalog(fixtures.tsql);
    const t0 = performance.now();
    intel.setCatalog(snap);
    const build = performance.now() - t0;
    const lines: string[] = [];
    for (let k = 0; k < 290; k++) lines.push(k % 10 === 0 ? `SELECT t.Id, t.Col1_${k % 50} FROM Table${k} t WHERE t.Id = ${k};` : `  -- filler line ${k} with some text`);
    lines.push('SELECT c.Name');
    lines.push('FROM Customers c');
    lines.push('JOIN Table1 t1 ON t1.Id = c.Id');
    lines.push('WHERE c.');
    for (let k = 0; k < 6; k++) lines.push(`-- tail ${k}`);
    const text = lines.join('\n');
    const offset = text.indexOf('WHERE c.') + 'WHERE c.'.length;
    intel.setDocument('perf://1', text);
    for (let k = 0; k < 20; k++) intel.complete('perf://1', offset);
    const times: number[] = [];
    for (let k = 0; k < 200; k++) {
      // simulate typing: the edit invalidates the statement under the cursor
      intel.applyEdit('perf://1', { rangeOffset: offset, rangeLength: 0, text: 'N' });
      const a = performance.now();
      const r = intel.complete('perf://1', offset + 1);
      times.push(performance.now() - a);
      expect(r.items[0].label).toBe('Name');
      intel.applyEdit('perf://1', { rangeOffset: offset, rangeLength: 1, text: '' });
    }
    times.sort((x, y) => x - y);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`perf: index build ${build.toFixed(1)} ms, completion p50 ${times[100].toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
    expect(build).toBeLessThan(150);
    expect(p95).toBeLessThan(5);
  });
});

describe('4.14 T-SQL (continued)', () => {
  it('#50 no suggestions inside a string literal', () => {
    expect(complete('tsql', "SELECT * FROM Customers c WHERE c.Name LIKE 'a|").items).toEqual([]);
  });

  it('#51 no suggestions inside a comment', () => {
    expect(complete('tsql', '-- SELECT * FROM |').items).toEqual([]);
  });

  it('#52 IN subquery: inner columns first, then outer', () => {
    const r = complete('tsql', 'SELECT * FROM Customers WHERE Id IN (SELECT CustomerId FROM Orders WHERE |)');
    const colItems = r.items.filter((x) => x.kind === 'column');
    const firstOuter = colItems.findIndex((x) => x.detail === 'Customers' || x.detail?.endsWith('· Customers'));
    const lastInner = colItems.map((x) => x.detail === 'Orders' || !!x.detail?.endsWith('· Orders')).lastIndexOf(true);
    expect(firstOuter).toBeGreaterThan(-1);
    expect(lastInner).toBeLessThan(firstOuter);
  });

  it('#53 MERGE ... ON | → columns of target and source (no FK)', () => {
    const r = complete('tsql', 'MERGE INTO Customers t USING Staging s ON |');
    expect(cols(r.items)).toEqual(expect.arrayContaining(['Id', 'Name', 'Email', 'CountryId']));
    expect(r.items.filter((x) => x.kind === 'column').every((x) => x.detail?.startsWith('t '))).toBe(true);
    expect(find(r.items, 's', (x) => x.kind === 'alias')).toBeTruthy();
  });

  it('#54 correlated scalar subquery in the SELECT list sees the outer alias', () => {
    const r = complete('tsql', 'SELECT c.Id, (SELECT COUNT(*) FROM Orders o WHERE o.CustomerId = c.|) FROM Customers c');
    expect(cols(r.items)).toEqual(['Id', 'Name', 'Email', 'CountryId']);
  });
});

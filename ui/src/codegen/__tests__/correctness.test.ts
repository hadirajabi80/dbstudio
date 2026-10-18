// Generated code that compiles and runs (QA features-07/08/09, logic-22): Java imports are complete, server-defaulted
// columns are left to the database on INSERT, better-sqlite3 / sqlite3 bind only types they accept and map 0/1 and
// ISO text back, and query parameter types follow the columns they are compared with.
//
// Runtime smoke tests: the TypeScript better-sqlite3 output runs against node:sqlite (same binding rules: no booleans,
// no Dates); the Python sqlite3 output is py_compiled and round-tripped in an in-memory database when a Python 3
// interpreter is on PATH (skipped otherwise).
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import type { CatalogSnapshot } from '../../api/types';
import tsqlShop from '../../intel/__tests__/fixtures/shop-tsql.json';
import sqliteShop from '../../intel/__tests__/fixtures/shop-sqlite.json';
import { generate, inferQueryParamTypes, joinFiles, paramTypeOfColumn, queryObject } from '..';
import type { CgColumn, CgInput, CgTable } from '../model';
import type { CodegenOptions } from '../options';
import { crudSql, PH, type CrudOptions } from '../sqlgen';

// The app's tsconfig has no Node types: the few Node APIs the smoke tests need are typed here and loaded dynamically.
interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
interface NodeApis {
  spawnSync(cmd: string, args: string[], o: { encoding: 'utf8'; timeout: number; env?: Record<string, string | undefined> }): SpawnResult;
  mkdtempSync(prefix: string): string;
  writeFileSync(path: string, text: string): void;
  rmSync(path: string, o: { recursive: boolean; force: boolean }): void;
  tmpdir(): string;
  join(...parts: string[]): string;
  execPath: string;
  env: Record<string, string | undefined>;
}
const load = (id: string) => import(/* @vite-ignore */ id) as Promise<Record<string, unknown>>;
const [cp, fsMod, os, pathMod] = await Promise.all([load('node:child_process'), load('node:fs'), load('node:os'), load('node:path')]);
const node = {
  spawnSync: cp.spawnSync, mkdtempSync: fsMod.mkdtempSync, writeFileSync: fsMod.writeFileSync, rmSync: fsMod.rmSync, tmpdir: os.tmpdir,
  join: pathMod.join, execPath: (globalThis as unknown as { process: { execPath: string } }).process.execPath,
  env: (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env,
} as unknown as NodeApis;
const { join, writeFileSync, spawnSync } = node;

const JAVA_SNAPSHOTS = import.meta.glob('./__snapshots__/java/*.java', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const PYTHON_SNAPSHOTS = import.meta.glob('./__snapshots__/python/*.py', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const col = (name: string, dbType: string, extra: Partial<CgColumn> = {}): CgColumn => ({
  name, dbType, nullable: false, pk: false, identity: false, computed: false, ...extra,
});

/** SQLite Orders: identity key, decimal / date / datetime columns and two NOT NULL columns with server defaults. */
const orders: CgTable = {
  kind: 'table', schema: 'main', name: 'Orders', primaryKey: ['Id'], foreignKeys: [],
  columns: [
    col('Id', 'INTEGER', { pk: true, identity: true }),
    col('CustomerId', 'INTEGER'),
    col('Total', 'NUMERIC(10,2)'),
    col('OrderDate', 'DATE'),
    col('ShippedAt', 'DATETIME', { nullable: true }),
    col('IsActive', 'BOOLEAN', { hasDefault: true }),
    col('CreatedAt', 'DATETIME', { hasDefault: true }),
  ],
};
const ORDERS_DDL = `CREATE TABLE Orders (
  Id INTEGER PRIMARY KEY AUTOINCREMENT,
  CustomerId INTEGER NOT NULL,
  Total NUMERIC(10,2) NOT NULL,
  OrderDate DATE NOT NULL,
  ShippedAt DATETIME,
  IsActive BOOLEAN NOT NULL DEFAULT 1,
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;

/**
 * SQLite Events for the runtime smoke test (features-r2-03): a timestamp with milliseconds written by SQLite itself
 * (strftime('%f') default) and a DATETIME column that may hold a number (unix seconds or a julian day).
 */
const events: CgTable = {
  kind: 'table', schema: 'main', name: 'Events', primaryKey: ['Id'], foreignKeys: [],
  columns: [
    col('Id', 'INTEGER', { pk: true, identity: true }),
    col('Name', 'TEXT'),
    col('UpdatedAt', 'DATETIME', { hasDefault: true }),
    col('HappenedAt', 'DATETIME', { nullable: true }),
  ],
};
const EVENTS_DDL = `CREATE TABLE Events (
  Id INTEGER PRIMARY KEY AUTOINCREMENT,
  Name TEXT NOT NULL,
  UpdatedAt DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  HappenedAt DATETIME
);`;

/** A query with bool, datetime, date and decimal parameters (types given, as the Parameters strip would). */
const activeSince = queryObject(
  'ActiveSince',
  'SELECT Id, IsActive, CreatedAt, Total FROM Orders WHERE IsActive = :active AND CreatedAt > :since AND OrderDate = :day AND Total > :min',
  'sqlite',
  [col('Id', 'INTEGER'), col('IsActive', 'BOOLEAN'), col('CreatedAt', 'DATETIME', { nullable: true }), col('Total', 'NUMERIC')],
  { active: 'bool', since: 'datetime', day: 'date', min: 'decimal' },
);

const CRUD: CrudOptions = { placeholder: PH.colon, bindName: (c) => c.name };

const sqliteInput: CgInput = { dialect: 'sqlite', objects: [orders, activeSince] };
const text = (input: CgInput, o: Partial<CodegenOptions>) => joinFiles(generate(input, o));

// ---------------- Java imports (features-07) ----------------

/** Simple names a generated unit may use, with the package that must be imported for them. */
const JAVA_PACKAGES: Record<string, string> = {
  LocalDate: 'java.time', LocalDateTime: 'java.time', LocalTime: 'java.time', OffsetDateTime: 'java.time', Duration: 'java.time',
  Instant: 'java.time', UUID: 'java.util', List: 'java.util', ArrayList: 'java.util', Map: 'java.util', LinkedHashMap: 'java.util',
  HashMap: 'java.util', Optional: 'java.util', Objects: 'java.util', BigDecimal: 'java.math', BigInteger: 'java.math',
  DataSource: 'javax.sql', Connection: 'java.sql', PreparedStatement: 'java.sql', CallableStatement: 'java.sql', ResultSet: 'java.sql',
  SQLException: 'java.sql', Types: 'java.sql', Timestamp: 'java.sql',
};

/** Simple names used in `unit` (code only: comments and string literals removed) without a matching import. */
export function missingJavaImports(unit: string): string[] {
  const imports = new Set([...unit.matchAll(/^import\s+([\w.]+(?:\.\*)?);/gm)].map((m) => m[1]));
  const code = unit
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/^(?:import|package)\s.*$/gm, '');
  const out: string[] = [];
  for (const [name, pkg] of Object.entries(JAVA_PACKAGES)) {
    // a use of the simple name that is not the tail of a qualified name (java.time.LocalDate) or a member (x.Types)
    if (!new RegExp(`(?<![\\w.])${name}\\b`).test(code)) continue;
    if (!imports.has(`${pkg}.${name}`) && !imports.has(`${pkg}.*`)) out.push(`${pkg}.${name}`);
  }
  return out;
}

const units = (combined: string) => combined.split(/^\/\/ ==== (?=[\w.]+\.java ====$)/m).filter((u) => u.trim());

describe('Java imports are complete (features-07)', () => {
  it('the checker finds a missing import', () => {
    const unit = 'package p;\nimport java.sql.*;\nclass A { Object f(ResultSet rs) throws SQLException { return LocalDateTime.parse(rs.getString("a")); } }';
    expect(missingJavaImports(unit)).toEqual(['java.time.LocalDateTime']);
    expect(missingJavaImports(`import java.time.LocalDateTime;\n${unit}`)).toEqual([]);
    // names in comments, strings and qualified names do not count
    expect(missingJavaImports('package p;\n/** LocalDate */ class B { String s = "UUID"; java.time.Duration d; }')).toEqual([]);
  });

  it('finds the Java snapshots', () => expect(Object.keys(JAVA_SNAPSHOTS).length).toBeGreaterThanOrEqual(6));
  for (const [file, content] of Object.entries(JAVA_SNAPSHOTS)) {
    it(`every unit of ${file.split('/').pop()}`, () => {
      const problems = units(content)
        .map((u) => ({ unit: u.split('\n')[0], missing: missingJavaImports(u) }))
        .filter((x) => x.missing.length);
      expect(problems).toEqual([]);
    });
  }

  it('SQLite DAOs that parse dates and query classes import java.time', () => {
    for (const flavor of ['jdbc', 'jpa'] as const) {
      const all = text(sqliteInput, { language: 'java', flavor, namespace: 'com.example' });
      const problems = units(all).map((u) => missingJavaImports(u)).filter((m) => m.length);
      expect(problems, flavor).toEqual([]);
    }
    const dao = units(text(sqliteInput, { language: 'java', flavor: 'jdbc', namespace: 'com.example' })).find((u) => u.startsWith('OrderDao.java'))!;
    expect(dao).toContain('LocalDateTime.parse');
    expect(dao).toContain('import java.time.LocalDateTime;');
    expect(dao).toContain('import java.time.LocalDate;');
  });
});

// ---------------- server defaults on INSERT (logic-22) ----------------

describe('server-defaulted columns are left to the database on INSERT (logic-22)', () => {
  it('crudSql leaves them out of INSERT but keeps them in UPDATE', () => {
    const crud = crudSql(orders, 'sqlite', CRUD);
    expect(crud.insert!.sql).toMatch(/INSERT INTO Orders \(CustomerId, Total, OrderDate, ShippedAt\)/);
    expect(crud.insert!.defaulted.map((c) => c.name)).toEqual(['IsActive', 'CreatedAt']);
    expect(crud.update!.sql).toContain('IsActive = ');
  });

  it('a defaulted key column is still inserted', () => {
    const t: CgTable = { ...orders, columns: [col('Code', 'TEXT', { pk: true, hasDefault: true }), col('Name', 'TEXT')], primaryKey: ['Code'] };
    expect(crudSql(t, 'sqlite', CRUD).insert!.sql).toContain('(Code, Name)');
  });

  const cases: [CodegenOptions['language'], string][] = [
    ['csharp', 'dapper'], ['csharp', 'adonet'], ['go', 'database-sql'], ['go', 'sqlx'], ['java', 'jdbc'], ['python', 'dataclass'], ['typescript', 'driver'],
  ];
  for (const [language, flavor] of cases) {
    it(`${language} / ${flavor}: INSERT without IsActive / CreatedAt, with a doc note`, () => {
      const out = text({ dialect: 'sqlite', objects: [orders] }, { language, flavor });
      expect(out).toMatch(/INSERT INTO Orders \(CustomerId, Total, OrderDate, ShippedAt\)/);
      expect(out).toContain('IsActive and CreatedAt are not inserted, so the server defaults apply');
    });
  }

  it('TypeScript insert DTO omits the generated key and the defaulted columns', () => {
    expect(text({ dialect: 'sqlite', objects: [orders] }, { language: 'typescript', flavor: 'driver' })).toContain("e: Omit<Order, 'id' | 'isActive' | 'createdAt'>");
  });

  it('ORMs: EF Core ValueGeneratedOnAdd, JPA insertable = false, SQLAlchemy server_default', () => {
    const ef = text({ dialect: 'sqlite', objects: [orders] }, { language: 'csharp', flavor: 'efcore' });
    expect(ef).toContain('builder.Property(e => e.IsActive).ValueGeneratedOnAdd();');
    expect(ef).toContain('builder.Property(e => e.CreatedAt).ValueGeneratedOnAdd();');
    expect(ef).not.toContain('builder.Property(e => e.Total).ValueGeneratedOnAdd();');
    const jpa = text({ dialect: 'sqlite', objects: [orders] }, { language: 'java', flavor: 'jpa' });
    expect(jpa).toContain('@Column(name = "IsActive", nullable = false, insertable = false)');
    expect(jpa).toContain('@Column(name = "Total", nullable = false, precision = 10, scale = 2)');
    const sa = text({ dialect: 'sqlite', objects: [orders] }, { language: 'python', flavor: 'sqlalchemy' });
    expect(sa).toContain('mapped_column("IsActive", Boolean(), server_default=FetchedValue())');
  });
});

// ---------------- better-sqlite3 binding (features-08) ----------------

describe('TypeScript better-sqlite3 queries bind and map like the CRUD code (features-08)', () => {
  it('bool → Number(), Date → SQLite text (UTC timestamp, local calendar DATE), rows 0/1 → boolean and text → Date', async () => {
    const out = text({ dialect: 'sqlite', objects: [activeSince] }, { language: 'typescript', flavor: 'driver', tsDate: 'Date' });
    expect(out).toContain('getActiveSince(db: Database, active: boolean, since: Date, day: Date, min: number)');
    expect(out).toContain('.all({ active: Number(active), since: toSqliteDateTime(since), day: toSqliteDate(day), min })');
    expect(out).toContain('isActive: r["IsActive"] === 1');
    // SQLite returns a number for a date stored as unix seconds / julian day: the helper takes both (features-r2-03).
    expect(out).toContain('createdAt: r["CreatedAt"] == null ? null : fromSqliteDateTime(r["CreatedAt"] as string | number)');
    expect(out).toContain('function fromSqliteDateTime(v: string | number): Date {');
    // the helpers are emitted once, after the imports, and only the ones the file uses
    expect(out.match(/^function toSqliteDateTime\(/gm)).toHaveLength(1);
    // milliseconds are kept when there are any (a strftime('%f') value round-trips unchanged), dropped when zero
    expect(out).toContain("return d.toISOString().replace('T', ' ').replace(/\\.000Z$/, '').replace(/Z$/, '');");
    expect(out).not.toContain('function fromSqliteDate(');
    await expect(out).toMatchFileSnapshot('./__snapshots__/typescript/query-bool-date.sqlite.ts.snap');
  });

  it('positional parameters are converted too; tsDate string leaves dates as text', () => {
    const q = queryObject('ByFlag', 'SELECT Id, IsActive FROM Orders WHERE IsActive = ? AND CreatedAt > ?', 'sqlite', [col('Id', 'INTEGER'), col('IsActive', 'BOOLEAN')], { p1: 'bool', p2: 'datetime' });
    const out = text({ dialect: 'sqlite', objects: [q] }, { language: 'typescript', flavor: 'driver' });
    expect(out).toContain('.all(Number(p1), p2)');
    expect(out).toContain('isActive: r["IsActive"] === 1');
  });
});

// ---------------- Python sqlite3 binding (features-09) ----------------

describe('Python sqlite3 binds text for Decimal and dates (features-09)', () => {
  const py = text(sqliteInput, { language: 'python', flavor: 'dataclass' });

  it('insert / update', () => {
    expect(py).toContain('cur.execute(_ORDER_INSERT, (e.customer_id, str(e.total), e.order_date.isoformat(), (e.shipped_at.isoformat(" ") if e.shipped_at is not None else None)))');
    expect(py).toContain('e.created_at.isoformat(" "), e.id))');
  });

  it('query parameters', () => {
    expect(py).toContain('{"active": active, "since": since.isoformat(" "), "day": day.isoformat(), "min": str(min)}');
  });

  it('other drivers bind the Python objects as they are', () => {
    const tsql = text({ dialect: 'tsql', objects: [{ ...orders, schema: 'dbo', columns: orders.columns.map((c) => ({ ...c, dbType: c.dbType === 'NUMERIC(10,2)' ? 'decimal(10,2)' : c.dbType === 'DATE' ? 'date' : c.dbType === 'DATETIME' ? 'datetime2' : c.dbType === 'BOOLEAN' ? 'bit' : 'int' })) }] }, { language: 'python', flavor: 'dataclass' });
    expect(tsql).not.toContain('str(e.total)');
    expect(tsql).not.toContain('.isoformat(');
  });
});

// ---------------- query parameter types (logic-22) ----------------

describe('query parameter types follow the compared columns (logic-22)', () => {
  const tsqlSnap = tsqlShop as unknown as CatalogSnapshot;
  const sqliteSnap = sqliteShop as unknown as CatalogSnapshot;

  it('comparisons, BETWEEN, IN, LIKE and qualified columns', () => {
    const sql = 'SELECT c.Name FROM dbo.Customers c JOIN dbo.Orders o ON o.CustomerId = c.Id\n'
      + 'WHERE c.Id = @id AND o.Total > @minTotal AND o.OrderDate BETWEEN @from AND @to AND c.Name LIKE @name AND c.CountryId IN (@a, @b) AND @x <= o.Total';
    expect(inferQueryParamTypes(sql, 'tsql', tsqlSnap)).toEqual({
      id: 'int', minTotal: 'decimal', from: 'datetime', to: 'datetime', name: 'string', a: 'int', b: 'int', x: 'decimal',
    });
  });

  it('the QA query: named and positional parameters of SQLite', () => {
    const sql = 'SELECT * FROM customers WHERE name = :name AND id > :minId AND country_id = ?';
    expect(inferQueryParamTypes(sql, 'sqlite', sqliteSnap)).toEqual({ name: 'string', minId: 'long', p1: 'long' });
  });

  it('INSERT … VALUES, UPDATE … SET and LIMIT', () => {
    expect(inferQueryParamTypes('INSERT INTO orders (customer_id, total, order_date) VALUES (?, ?, :d)', 'sqlite', sqliteSnap)).toEqual({ p1: 'long', p2: 'float', d: 'string' });
    expect(inferQueryParamTypes('UPDATE dbo.Products SET Price = @price WHERE Id = @id', 'tsql', tsqlSnap)).toEqual({ price: 'decimal', id: 'int' });
    expect(inferQueryParamTypes('SELECT id FROM customers LIMIT :n', 'sqlite', sqliteSnap)).toEqual({ n: 'int' });
  });

  it('unknown columns and missing catalogs infer nothing (callers default to string)', () => {
    expect(inferQueryParamTypes('SELECT 1 WHERE @v = 1', 'tsql', tsqlSnap)).toEqual({});
    expect(inferQueryParamTypes('SELECT * FROM dbo.Customers WHERE Id = @id', 'tsql', null)).toEqual({});
  });

  it('column type text → parameter type', () => {
    expect(paramTypeOfColumn('tsql', 'bit')).toBe('bool');
    expect(paramTypeOfColumn('tsql', 'datetimeoffset(7)')).toBe('datetimeoffset');
    expect(paramTypeOfColumn('plsql', 'NUMBER(12,2)')).toBe('decimal');
    expect(paramTypeOfColumn('sqlite', 'BOOLEAN')).toBe('bool');
  });

  it('inferred types reach the generated signature', () => {
    const sql = 'SELECT id, name FROM customers WHERE id > :minId AND country_id = ?';
    const q = queryObject('Q', sql, 'sqlite', [col('id', 'INTEGER'), col('name', 'TEXT')], inferQueryParamTypes(sql, 'sqlite', sqliteSnap));
    const go = text({ dialect: 'sqlite', objects: [q] }, { language: 'go', flavor: 'database-sql' });
    expect(go).toMatch(/minID int64, p1 int64/);
  });
});

// ---------------- runtime smoke tests ----------------

const tmp = node.mkdtempSync(join(node.tmpdir(), 'dbstudio-codegen-'));
afterAll(() => node.rmSync(tmp, { recursive: true, force: true }));

describe('TypeScript better-sqlite3 date helpers (features-r2-03)', () => {
  /** The emitted helpers, compiled to plain functions. */
  const helpers = (() => {
    const src = text({ dialect: 'sqlite', objects: [orders, events, activeSince] }, { language: 'typescript', flavor: 'driver', tsDate: 'Date' });
    const body = [...src.matchAll(/^function (?:to|from)Sqlite\w+\([\s\S]*?^\}$/gm)].map((m) => m[0]).join('\n');
    const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(`${js}\nreturn { toSqliteDateTime, fromSqliteDateTime, toSqliteDate, fromSqliteDate };`)() as {
      toSqliteDateTime(d: Date): string;
      fromSqliteDateTime(v: string | number): Date;
      toSqliteDate(d: Date): string;
      fromSqliteDate(v: string | number): Date;
    };
  })();

  it('writes milliseconds only when there are any', () => {
    expect(helpers.toSqliteDateTime(new Date('2026-10-18T09:42:57.207Z'))).toBe('2026-10-18 09:42:57.207');
    expect(helpers.toSqliteDateTime(new Date('2026-10-18T09:42:57.000Z'))).toBe('2026-10-18 09:42:57');
    expect(helpers.toSqliteDateTime(helpers.fromSqliteDateTime('2026-10-18 09:42:57.207'))).toBe('2026-10-18 09:42:57.207');
    expect(helpers.toSqliteDateTime(helpers.fromSqliteDateTime('2026-10-18 09:42:57'))).toBe('2026-10-18 09:42:57');
  });

  it('reads text, unix seconds and julian day numbers', () => {
    expect(helpers.fromSqliteDateTime('2026-10-18 09:42:57').toISOString()).toBe('2026-10-18T09:42:57.000Z');
    expect(helpers.fromSqliteDateTime('2026-10-18T09:42:57+02:00').toISOString()).toBe('2026-10-18T07:42:57.000Z');
    expect(helpers.fromSqliteDateTime(1792316577).toISOString()).toBe('2026-10-18T09:42:57.000Z');
    // julianday('2026-10-18 12:00:00') = 2461332.0; julian day 2440587.5 is the unix epoch
    expect(helpers.fromSqliteDateTime(2461332).toISOString()).toBe('2026-10-18T12:00:00.000Z');
    expect(helpers.fromSqliteDateTime(2440587.5).toISOString()).toBe('1970-01-01T00:00:00.000Z');
    const d = helpers.fromSqliteDate(2461332);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 18, 0]);
    const u = helpers.fromSqliteDate(1792316577);
    expect([u.getFullYear(), u.getMonth(), u.getDate()]).toEqual([2026, 9, 18]);
  });
});

describe('TypeScript better-sqlite3 output runs (node:sqlite stand-in)', () => {
  for (const tsDate of ['Date', 'string'] as const) {
    it(`CRUD and query round-trip, tsDate=${tsDate}`, () => {
      const src = text({ dialect: 'sqlite', objects: [orders, events, activeSince] }, { language: 'typescript', flavor: 'driver', tsDate });
      const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      writeFileSync(join(tmp, `gen-${tsDate}.mjs`), js);
      // A local calendar day (new Date(y, m, d)): stored as that day in every time zone.
      const day = tsDate === 'Date' ? 'new Date(2026, 9, 18)' : "'2026-10-18'";
      // Same day as the server-defaulted CreatedAt: a text comparison against SQLite's own format must still match.
      const since = tsDate === 'Date' ? 'new Date(o.createdAt.getTime() - 1000)' : "'1999-01-01 00:00:00'";
      const shipped = tsDate === 'Date' ? "new Date('2026-10-19T08:30:00Z')" : "'2026-10-19 08:30:00'";
      writeFileSync(join(tmp, `run-${tsDate}.mjs`), `
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import * as g from './gen-${tsDate}.mjs';
// Runs with TZ=Asia/Tehran (UTC+03:30): a local-time reading of SQLite's UTC text would be 3.5 h off.
assert.notEqual(new Date(2026, 9, 18).getTimezoneOffset(), 0, 'the smoke test must run in a non-UTC time zone');
const db = new DatabaseSync(':memory:');
db.exec(${JSON.stringify(ORDERS_DDL)});
const raw = (id) => ({ ...db.prepare('SELECT OrderDate, ShippedAt, CreatedAt FROM Orders WHERE Id = ?').get(id) });
const id = g.insertOrder(db, { customerId: 7, total: 19.99, orderDate: ${day}, shippedAt: null });
assert.equal(typeof id, 'number');
const o = g.getOrder(db, id);
assert.ok(o);
assert.equal(o.isActive, true, 'server default applies');
assert.equal(o.total, 19.99);
assert.equal(o.shippedAt, null);
const raw0 = raw(id);
assert.equal(raw0.OrderDate, '2026-10-18', 'DATE is stored as the local calendar day');
assert.match(raw0.CreatedAt, /^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d$/);
${tsDate === 'Date'
  ? `assert.ok(o.orderDate instanceof Date);
assert.deepEqual([o.orderDate.getFullYear(), o.orderDate.getMonth(), o.orderDate.getDate(), o.orderDate.getHours()], [2026, 9, 18, 0]);
assert.ok(o.createdAt instanceof Date);
assert.ok(Math.abs(o.createdAt.getTime() - Date.now()) < 60000, 'CURRENT_TIMESTAMP is read as UTC: ' + o.createdAt.toISOString());`
  : `assert.equal(o.orderDate, '2026-10-18');
assert.equal(o.createdAt, raw0.CreatedAt);`}
// get → update without changes leaves the stored text byte for byte as it was
assert.equal(g.updateOrder(db, o), true);
assert.deepEqual(raw(id), raw0);
assert.equal(g.updateOrder(db, { ...o, shippedAt: ${shipped}, isActive: false }), true);
const o2 = g.getOrder(db, id);
assert.equal(o2.isActive, false);
assert.equal(raw(id).ShippedAt, '2026-10-19 08:30:00');
${tsDate === 'Date' ? "assert.equal(o2.shippedAt.toISOString(), '2026-10-19T08:30:00.000Z');" : "assert.equal(o2.shippedAt, '2026-10-19 08:30:00');"}
assert.deepEqual(raw(id).CreatedAt, raw0.CreatedAt);
const rows = g.getActiveSince(db, false, ${since}, ${day}, 1);
assert.equal(rows.length, 1, 'CreatedAt > :since with a same-day value finds the row');
assert.equal(rows[0].isActive, false);
assert.equal(g.listOrders(db).length, 1);
assert.equal(g.deleteOrder(db, id), true);

// features-r2-03: a timestamp SQLite wrote with milliseconds survives get → update unchanged.
db.exec(${JSON.stringify(EVENTS_DDL)});
const rawEvent = (eid) => ({ ...db.prepare('SELECT UpdatedAt, HappenedAt FROM Events WHERE Id = ?').get(eid) });
const eid = g.insertEvent(db, { name: 'deploy', happenedAt: null });
assert.match(rawEvent(eid).UpdatedAt, /^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\.\\d{3}$/, 'the %f default writes milliseconds');
// A default that happened to land on .000 would not show the difference: make the milliseconds non-zero.
db.prepare("UPDATE Events SET UpdatedAt = substr(UpdatedAt, 1, 20) || '207' WHERE Id = ?").run(eid);
const ev0 = rawEvent(eid);
assert.equal(g.updateEvent(db, g.getEvent(db, eid)), true);
assert.deepEqual(rawEvent(eid), ev0, 'get → update leaves the stored text unchanged');
${tsDate === 'Date'
  ? 'assert.equal(g.getEvent(db, eid).updatedAt.getUTCMilliseconds(), 207);'
  : 'assert.equal(g.getEvent(db, eid).updatedAt, ev0.UpdatedAt);'}
// SQLite may store a datetime as INTEGER unix seconds or REAL julian day: reading it must not throw.
const sqliteUtc = (sql, v) => db.prepare(sql).get(v).t;
for (const [v, asText] of [
  [1792316577, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch') AS t"],
  [2461332.25, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?) AS t"],
]) {
  db.prepare('UPDATE Events SET HappenedAt = ? WHERE Id = ?').run(v, eid);
  const e = g.getEvent(db, eid);
  ${tsDate === 'Date' ? 'assert.equal(e.happenedAt.toISOString(), new Date(sqliteUtc(asText, v)).toISOString());' : 'assert.equal(e.happenedAt, v);'}
  assert.equal(g.listEvents(db).length, 1);
}
console.log('ok');
`);
      const r = spawnSync(node.execPath, [join(tmp, `run-${tsDate}.mjs`)], { encoding: 'utf8', timeout: 30000, env: { ...node.env, TZ: 'Asia/Tehran' } });
      expect(r.stderr.replace(/^.*ExperimentalWarning.*$\n?|^\(Use `node --trace-warnings.*$\n?/gm, '').trim()).toBe('');
      expect(r.stdout.trim()).toBe('ok');
    });
  }
});

/** A Python 3 interpreter, or null (the Windows Store alias `python` exits non-zero without one). */
function findPython(): string[] | null {
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0 && r.stdout.trim() === '3') return cmd;
  }
  return null;
}
const python = findPython();

describe.skipIf(!python)('Python output compiles and runs (sqlite3)', () => {
  const run = (args: string[]) => spawnSync(python![0], [...python!.slice(1), '-I', ...args], { encoding: 'utf8', timeout: 60000 });

  it('every Python snapshot compiles', () => {
    const files = Object.entries(PYTHON_SNAPSHOTS).map(([name, content]) => {
      const p = join(tmp, name.split('/').pop()!);
      writeFileSync(p, content);
      return p;
    });
    expect(files.length).toBeGreaterThanOrEqual(9);
    // .pyc files go to the temp folder, never next to the snapshots
    const code = [
      'import os, py_compile, sys',
      'for i, f in enumerate(sys.argv[2:]):',
      "    py_compile.compile(f, cfile=os.path.join(sys.argv[1], str(i) + '.pyc'), doraise=True)",
    ].join('\n');
    const r = run(['-c', code, tmp, ...files]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('insert / get / update / query / delete round-trip in memory', () => {
    writeFileSync(join(tmp, 'gen_orders.py'), text(sqliteInput, { language: 'python', flavor: 'dataclass' }));
    writeFileSync(join(tmp, 'run_orders.py'), `
import sqlite3, sys
from datetime import date, datetime
from decimal import Decimal
sys.path.insert(0, ${JSON.stringify(tmp)})
import gen_orders as g

conn = sqlite3.connect(":memory:")
conn.executescript(${JSON.stringify(ORDERS_DDL)})
repo = g.OrderRepository(conn)
new_id = repo.insert(g.Order(id=0, customer_id=7, total=Decimal("19.99"), order_date=date(2026, 10, 18), shipped_at=None, is_active=False, created_at=datetime(2000, 1, 1)))
conn.commit()
o = repo.get(new_id)
assert o is not None
assert o.total == Decimal("19.99"), o.total
assert o.order_date == date(2026, 10, 18), o.order_date
assert o.shipped_at is None
assert o.is_active is True, "server default applies"
assert isinstance(o.created_at, datetime) and o.created_at.year > 2000
o.shipped_at = datetime(2026, 10, 19, 8, 30)
o.is_active = False
assert repo.update(o)
o2 = repo.get(new_id)
assert o2.shipped_at == datetime(2026, 10, 19, 8, 30), o2.shipped_at
assert o2.is_active is False
rows = g.get_active_since(conn, active=False, since=datetime(1999, 1, 1), day=date(2026, 10, 18), min=Decimal("1"))
assert len(rows) == 1 and rows[0].total == Decimal("19.99"), rows
assert len(repo.list_all()) == 1
assert repo.delete(new_id)
print("ok")
`);
    const r = run(['-W', 'error::DeprecationWarning', join(tmp, 'run_orders.py')]);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('ok');
  });
});

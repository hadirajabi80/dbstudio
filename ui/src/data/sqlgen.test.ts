import { describe, expect, it } from 'vitest';
import type { ColumnInfo, ColumnKind } from '../api/types';
import {
  countSql, distinctSql, generateChange, generateChanges, keylessOrder, NO_KEY_ORDER_MAX_ROWS, noKeyOrder, previewScript, refetchSql, rollbackToSavepointSql, savepointSql, selectPageSql,
  tsqlDeclaredType, uniqueOrderKey, type RowChange, type TableTarget,
} from './sqlgen';

const col = (name: string, kind: ColumnKind, nullable = true): ColumnInfo => ({
  name, ordinal: 0, dbType: kind, kind, nullable, size: null, precision: null, scale: null, table: 'Customers', schema: 'dbo', isKey: name === 'Id',
});
const Id = col('Id', 'int', false);
const Name = col('Name', 'string');
const Total = col('Total', 'decimal');
const Born = col('Born', 'date');
const Active = col('Active', 'bool');
const T: TableTarget = { schema: 'dbo', name: 'Customers', keyColumns: ['Id'], identityColumns: ['Id'], defaultSchema: null };

const upd: RowChange = { kind: 'update', ref: '3', key: [{ column: Id, value: 7 }], set: [{ column: Name, value: 'Ada', old: 'Ad' }, { column: Total, value: '12.50', old: null }] };

describe('UPDATE', () => {
  it('one statement with only changed columns, @pN on T-SQL', () => {
    const s = generateChange(upd, T, 'tsql');
    expect(s.sql).toBe('UPDATE dbo.Customers SET Name = @p1, Total = @p2 WHERE Id = @p3');
    expect(s.params).toEqual([{ name: 'p1', kind: 'string', value: 'Ada' }, { name: 'p2', kind: 'decimal', value: '12.50' }, { name: 'p3', kind: 'int', value: 7 }]);
    expect(s.expectOne).toBe(true);
  });
  it(':pN on Oracle with quoted mixed-case identifiers', () => {
    const s = generateChange(upd, { ...T, defaultSchema: 'DBO' }, 'plsql');
    expect(s.sql).toBe('UPDATE "dbo"."Customers" SET "Name" = :p1, "Total" = :p2 WHERE "Id" = :p3');
  });
  it('SQLite leaves the default schema out', () => {
    const s = generateChange(upd, { ...T, schema: 'main', defaultSchema: 'main' }, 'sqlite');
    expect(s.sql).toBe('UPDATE Customers SET Name = @p1, Total = @p2 WHERE Id = @p3');
    expect(s.params[1]).toEqual({ name: 'p2', kind: 'float', value: '12.50' });
  });
  it('verify unchanged values adds old-value checks (NULL as IS NULL)', () => {
    const s = generateChange(upd, T, 'tsql', { verifyUnchanged: true });
    expect(s.sql).toBe('UPDATE dbo.Customers SET Name = @p1, Total = @p2 WHERE Id = @p3 AND Name = @p4 AND Total IS NULL');
    expect(s.params[3]).toEqual({ name: 'p4', kind: 'string', value: 'Ad' });
  });
  it('booleans: bit on T-SQL, 1/0 elsewhere', () => {
    const c: RowChange = { kind: 'update', ref: '1', key: [{ column: Id, value: 1 }], set: [{ column: Active, value: true, old: false }] };
    expect(generateChange(c, T, 'tsql').params[0]).toEqual({ name: 'p1', kind: 'bool', value: true });
    expect(generateChange(c, T, 'sqlite').params[0]).toEqual({ name: 'p1', kind: 'int', value: 1 });
  });
  it('composite keys', () => {
    const c: RowChange = { kind: 'update', ref: '1', key: [{ column: col('OrderId', 'int'), value: 1 }, { column: col('Line', 'int'), value: 2 }], set: [{ column: Name, value: 'x', old: 'y' }] };
    expect(generateChange(c, { ...T, name: 'Lines', keyColumns: ['OrderId', 'Line'] }, 'sqlite').sql).toBe('UPDATE dbo.Lines SET Name = @p1 WHERE OrderId = @p2 AND Line = @p3');
  });
});

describe('INSERT', () => {
  const ins: RowChange = { kind: 'insert', ref: 'new1', values: [{ column: Id, value: null }, { column: Name, value: 'Grace' }, { column: Born, value: '1906-12-09' }] };
  it('T-SQL omits the identity column and returns it with OUTPUT INSERTED … INTO a table variable (works with triggers)', () => {
    const s = generateChange(ins, T, 'tsql');
    expect(s.sql).toBe('DECLARE @ins TABLE (Id int);\nINSERT INTO dbo.Customers (Name, Born) OUTPUT INSERTED.Id INTO @ins VALUES (@p1, @p2);\nSELECT * FROM @ins;');
    expect(s.params[1]).toEqual({ name: 'p2', kind: 'date', value: '1906-12-09' });
    expect(s.returning).toEqual(['Id']);
  });
  it('Oracle returns the key into an out bind', () => {
    const s = generateChange(ins, T, 'plsql');
    expect(s.sql).toBe('INSERT INTO "dbo"."Customers" ("Name", "Born") VALUES (:p1, :p2) RETURNING "Id" INTO :out1');
    expect(s.params[2]).toEqual({ name: 'out1', kind: 'int', value: null, direction: 'out' });
  });
  it('SQLite uses RETURNING from 3.35, last_insert_rowid() before', () => {
    expect(generateChange(ins, T, 'sqlite', { sqliteVersion: '3.46.1' }).sql).toBe('INSERT INTO dbo.Customers (Name, Born) VALUES (@p1, @p2) RETURNING Id');
    const old = generateChange(ins, T, 'sqlite', { sqliteVersion: '3.31.1' });
    expect(old.sql).toBe('INSERT INTO dbo.Customers (Name, Born) VALUES (@p1, @p2)');
    expect(old.followUp).toBe('SELECT last_insert_rowid() AS Id');
    expect(old.params[1]).toEqual({ name: 'p2', kind: 'string', value: '1906-12-09' });
  });
  it('user-supplied key is inserted and not returned; empty row → DEFAULT VALUES', () => {
    const s = generateChange({ kind: 'insert', ref: 'n', values: [{ column: Id, value: 42 }] }, { ...T, identityColumns: [] }, 'tsql');
    expect(s.sql).toBe('INSERT INTO dbo.Customers (Id) VALUES (@p1)');
    expect(s.returning).toEqual([]);
    expect(generateChange({ kind: 'insert', ref: 'n', values: [] }, T, 'tsql', { columns: [Id] }).sql)
      .toBe('DECLARE @ins TABLE (Id int);\nINSERT INTO dbo.Customers OUTPUT INSERTED.Id INTO @ins DEFAULT VALUES;\nSELECT * FROM @ins;');
    expect(generateChange({ kind: 'insert', ref: 'n', values: [] }, T, 'sqlite').sql).toBe('INSERT INTO dbo.Customers DEFAULT VALUES RETURNING Id');
  });
});

describe('DELETE and ordering', () => {
  it('deletes by every key column', () => {
    const s = generateChange({ kind: 'delete', ref: '5', key: [{ column: Id, value: 9 }] }, T, 'plsql');
    expect(s.sql).toBe('DELETE FROM "dbo"."Customers" WHERE "Id" = :p1');
  });
  it('verify mode compares comparable original values', () => {
    const s = generateChange({ kind: 'delete', ref: '5', key: [{ column: Id, value: 9 }], original: [{ column: Id, value: 9 }, { column: Name, value: null }, { column: col('Pic', 'binary'), value: null }] }, T, 'sqlite', { verifyUnchanged: true });
    expect(s.sql).toBe('DELETE FROM dbo.Customers WHERE Id = @p1 AND Name IS NULL');
  });
  it('runs deletes, then updates, then inserts; preview inlines parameters', () => {
    const list = generateChanges([
      { kind: 'insert', ref: 'n', values: [{ column: Name, value: "O'Hara" }] }, upd, { kind: 'delete', ref: '1', key: [{ column: Id, value: 1 }] },
    ], T, 'tsql');
    expect(list.map((s) => s.kind)).toEqual(['delete', 'update', 'insert']);
    expect(previewScript(list, 'tsql')).toBe(
      "DELETE FROM dbo.Customers WHERE Id = 1;\nUPDATE dbo.Customers SET Name = N'Ada', Total = 12.50 WHERE Id = 7;\nINSERT INTO dbo.Customers (Name) VALUES (N'O''Hara');\nSELECT CAST(SCOPE_IDENTITY() AS bigint) AS Id;",
    );
  });
});

describe('paging, count, refetch, distinct', () => {
  it('T-SQL OFFSET/FETCH with the key as tiebreaker; TOP on SQL Server 2008', () => {
    expect(selectPageSql(T, 'tsql', { where: 'Name LIKE @fp1', sort: [{ column: 'Name', dir: 'desc' }], offset: 1000, limit: 1000, serverVersion: '16.0.4145.4' }).sql)
      .toBe('SELECT *\nFROM dbo.Customers\nWHERE Name LIKE @fp1\nORDER BY Name DESC, Id\nOFFSET 1000 ROWS FETCH NEXT 1000 ROWS ONLY');
    const old = selectPageSql(T, 'tsql', { offset: 0, limit: 500, serverVersion: '10.50.6000' });
    expect(old).toEqual({ sql: 'SELECT TOP 500 *\nFROM dbo.Customers\nORDER BY Id', pageable: false });
    expect(selectPageSql({ ...T, keyColumns: [] }, 'tsql', { offset: 0, limit: 10 }).sql).toContain('ORDER BY (SELECT NULL)');
    // features-25: a heap pages by every orderable column
    const heap = { ...T, keyColumns: [], orderFallback: noKeyOrder('tsql', [Name, Total, col('Pic', 'binary')], false) };
    expect(selectPageSql(heap, 'tsql', { offset: 1000, limit: 10 }).sql).toBe('SELECT *\nFROM dbo.Customers\nORDER BY Name, Total\nOFFSET 1000 ROWS FETCH NEXT 10 ROWS ONLY');
    expect(selectPageSql(heap, 'tsql', { offset: 0, limit: 10, sort: [{ column: 'Total', dir: 'desc' }] }).sql).toContain('ORDER BY Total DESC, Name');
  });
  it('Oracle 12c+ OFFSET/FETCH, ROWNUM before', () => {
    expect(selectPageSql(T, 'plsql', { offset: 0, limit: 100, serverVersion: '23.5' }).sql).toBe('SELECT *\nFROM "dbo"."Customers"\nORDER BY "Id"\nOFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY');
    expect(selectPageSql(T, 'plsql', { offset: 0, limit: 100, serverVersion: '11.2.0.4' })).toEqual({ sql: 'SELECT * FROM (\nSELECT *\nFROM "dbo"."Customers"\nORDER BY "Id"\n)\nWHERE ROWNUM <= 100', pageable: false });
  });
  it('SQLite LIMIT/OFFSET', () => {
    expect(selectPageSql({ ...T, schema: 'main', defaultSchema: 'main' }, 'sqlite', { offset: 2000, limit: 1000, sort: [{ column: 'Id', dir: 'desc' }] }).sql).toBe('SELECT *\nFROM Customers\nORDER BY Id DESC\nLIMIT 1000 OFFSET 2000');
  });
  it('no key: rowid (SQLite) / ROWID (Oracle) keep pages deterministic; views use their columns', () => {
    const noKey = (d: 'sqlite' | 'plsql', view = false) => ({ ...T, schema: 'main', defaultSchema: 'main', keyColumns: [], orderFallback: noKeyOrder(d, [Name, Total], view) });
    expect(selectPageSql(noKey('sqlite'), 'sqlite', { offset: 1000, limit: 1000 }).sql).toBe('SELECT *\nFROM Customers\nORDER BY rowid\nLIMIT 1000 OFFSET 1000');
    expect(selectPageSql(noKey('sqlite'), 'sqlite', { offset: 0, limit: 10, sort: [{ column: 'Name', dir: 'asc' }] }).sql).toContain('ORDER BY Name, rowid');
    expect(selectPageSql(noKey('plsql'), 'plsql', { offset: 0, limit: 10, serverVersion: '19.3' }).sql).toContain('ORDER BY ROWID\nOFFSET 0 ROWS');
    expect(selectPageSql(noKey('sqlite', true), 'sqlite', { offset: 0, limit: 10 }).sql).toContain('ORDER BY Name, Total');
  });
  it('COUNT(*) with the same predicate', () => {
    expect(countSql(T, 'sqlite', 'Name LIKE @fp1')).toBe('SELECT COUNT(*) AS row_count\nFROM dbo.Customers\nWHERE Name LIKE @fp1');
  });
  it('refetch by key', () => {
    const r = refetchSql(T, 'tsql', [[{ column: Id, value: 1 }], [{ column: Id, value: 2 }]]);
    expect(r.sql).toBe('SELECT *\nFROM dbo.Customers\nWHERE Id = @k1 OR Id = @k2');
    const c = refetchSql(T, 'sqlite', [[{ column: Id, value: 1 }, { column: Name, value: 'a' }], [{ column: Id, value: 2 }, { column: Name, value: 'b' }]]);
    expect(c.sql.endsWith('WHERE (Id = @k1 AND Name = @k2) OR (Id = @k3 AND Name = @k4)')).toBe(true);
  });
  it('distinct values per dialect', () => {
    expect(distinctSql(T, 'tsql', 'Name')).toBe('SELECT TOP 500 Name, COUNT(*) AS cnt\nFROM dbo.Customers\nGROUP BY Name\nORDER BY COUNT(*) DESC');
    expect(distinctSql(T, 'sqlite', 'Name', 'Id > @fp1', 10).endsWith('LIMIT 10')).toBe(true);
    expect(distinctSql(T, 'plsql', 'Name').endsWith('FETCH FIRST 500 ROWS ONLY')).toBe(true);
    expect(distinctSql(T, 'plsql', 'Name', null, 500, '11.2.0.4')).toBe('SELECT * FROM (\nSELECT "Name", COUNT(*) AS "cnt"\nFROM "dbo"."Customers"\nGROUP BY "Name"\nORDER BY COUNT(*) DESC\n)\nWHERE ROWNUM <= 500');
  });
});

describe('T-SQL INSERT key capture (features-10)', () => {
  const guid: ColumnInfo = { ...col('Code', 'guid', false), dbType: 'uniqueidentifier' };
  const dec: ColumnInfo = { ...col('Num', 'decimal', false), dbType: 'decimal', precision: 18, scale: 2 };
  const str: ColumnInfo = { ...col('Sku', 'string', false), dbType: 'nvarchar', size: 40 };
  it('declares the key columns with their SQL types (composite keys too)', () => {
    const t: TableTarget = { schema: 'dbo', name: 'Parts', keyColumns: ['Code', 'Num', 'Sku'], identityColumns: [], defaultSchema: null };
    const s = generateChange({ kind: 'insert', ref: 'n', values: [{ column: Name, value: 'x' }] }, t, 'tsql', { columns: [guid, dec, str, Name] });
    expect(s.sql).toBe(
      'DECLARE @ins TABLE (Code uniqueidentifier, Num decimal(18, 2), Sku nvarchar(40));\n'
      + 'INSERT INTO dbo.Parts (Name) OUTPUT INSERTED.Code, INSERTED.Num, INSERTED.Sku INTO @ins VALUES (@p1);\nSELECT * FROM @ins;',
    );
    expect(s.returning).toEqual(['Code', 'Num', 'Sku']);
  });
  it('falls back to SCOPE_IDENTITY() for a single identity key of unknown type', () => {
    const odd: ColumnInfo = { ...Id, dbType: 'dbo.MyIntType' };
    const s = generateChange({ kind: 'insert', ref: 'n', values: [{ column: Name, value: 'x' }] }, T, 'tsql', { columns: [odd, Name] });
    expect(s.sql).toBe('INSERT INTO dbo.Customers (Name) VALUES (@p1);\nSELECT CAST(SCOPE_IDENTITY() AS bigint) AS Id;');
  });
  it('maps engine type names to declarations', () => {
    expect(tsqlDeclaredType({ ...Name, dbType: 'nvarchar', size: 2147483647 })).toBe('nvarchar(max)');
    expect(tsqlDeclaredType({ ...Name, dbType: 'varchar', size: 12 })).toBe('varchar(12)');
    expect(tsqlDeclaredType({ ...Name, dbType: 'datetime2', scale: 3 })).toBe('datetime2(3)');
    expect(tsqlDeclaredType({ ...Name, dbType: 'geography' })).toBeNull();
  });
});

describe('savepoints (code-01)', () => {
  it('per dialect', () => {
    expect(savepointSql('tsql')).toBe('SAVE TRANSACTION dbs_edit');
    expect(rollbackToSavepointSql('tsql')).toBe('ROLLBACK TRANSACTION dbs_edit');
    expect(savepointSql('plsql')).toBe('SAVEPOINT dbs_edit');
    expect(rollbackToSavepointSql('sqlite')).toBe('ROLLBACK TO SAVEPOINT dbs_edit');
  });
});

describe('keyless paging order (features-r1-04)', () => {
  const many = Array.from({ length: 12 }, (_, i) => col(`C${i}`, 'string'));
  it('the column fallback orders by at most 8 orderable columns', () => {
    expect(noKeyOrder('tsql', many, false)).toHaveLength(8);
    expect(noKeyOrder('tsql', [col('Pic', 'binary'), Name], true)).toEqual(['Name']);
  });
  it('SQLite tables always use rowid; everything else sorts only when counted and small', () => {
    expect(keylessOrder('sqlite', [Name], false, null)).toEqual(['rowid']);
    expect(keylessOrder('sqlite', [Name, Total], true, null)).toBeNull();
    expect(keylessOrder('sqlite', [Name, Total], true, 2500)).toEqual(['Name', 'Total']);
    expect(keylessOrder('tsql', [Name], false, NO_KEY_ORDER_MAX_ROWS)).toEqual(['Name']);
    expect(keylessOrder('tsql', [Name], false, NO_KEY_ORDER_MAX_ROWS + 1)).toBeNull();
    expect(keylessOrder('plsql', [Name], false, 10)).toEqual(['ROWID']);
    expect(keylessOrder('plsql', [Name], false, null)).toBeNull();
    expect(keylessOrder('tsql', [col('Pic', 'binary')], true, 10)).toBeNull();
    // Without an order the page has no deterministic ORDER BY (T-SQL needs the placeholder).
    expect(selectPageSql({ ...T, keyColumns: [] }, 'tsql', { offset: 1000, limit: 10 }).sql).toContain('ORDER BY (SELECT NULL)');
  });
  it('a unique index or constraint orders a table without a primary key', () => {
    const Email = col('Email', 'string', false);
    const Code = col('Code', 'string');
    const Ref = col('Ref', 'int', false);
    const cols = [Name, Email, Code, Ref, col('Pic', 'binary')];
    const ix = (columns: string[], unique = true) => ({ unique, columns, isPrimaryKey: false });
    expect(uniqueOrderKey([ix(['name'], false), ix(['EMAIL'])], cols)).toEqual(['Email']);
    // NOT NULL columns win over nullable ones (several NULLs can tie), then the fewest columns.
    expect(uniqueOrderKey([ix(['Code']), ix(['Email', 'Ref'])], cols)).toEqual(['Email', 'Ref']);
    expect(uniqueOrderKey([ix(['Code']), ix(['Name'])], cols)).toEqual(['Code']);
    // Every column must be in the result and orderable.
    expect(uniqueOrderKey([ix(['Missing'])], cols)).toBeNull();
    expect(uniqueOrderKey([ix(['Pic'])], cols)).toBeNull();
    expect(uniqueOrderKey(null, cols)).toBeNull();
  });
});

// MySQL / MariaDB grid editing SQL: backtick identifiers, INSERT () VALUES (), LAST_INSERT_ID() read-back, RELEASE SAVEPOINT.
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, ColumnKind } from '../api/types';
import { generateChange, releaseSavepointSql, rollbackToSavepointSql, savepointSql, type TableTarget } from './sqlgen';

const col = (name: string, kind: ColumnKind, dbType: string = kind): ColumnInfo => ({
  name, ordinal: 0, dbType, kind, nullable: true, size: null, precision: null, scale: null, table: 'orders', schema: 'shop', isKey: name === 'id',
});
const id = col('id', 'int', 'int');
const name = col('name', 'string', 'varchar(255)');
const order = col('order', 'string', 'varchar(20)');
const T: TableTarget = { schema: 'shop', name: 'orders', keyColumns: ['id'], identityColumns: ['id'], defaultSchema: 'shop' };

describe('mysql inserts', () => {
  it('reads the generated key back with LAST_INSERT_ID()', () => {
    const s = generateChange({ kind: 'insert', ref: '1', values: [{ column: name, value: 'Ada' }, { column: id, value: null }] }, T, 'mysql');
    expect(s.sql).toBe('INSERT INTO orders (name) VALUES (@p1)');
    expect(s.followUp).toBe('SELECT LAST_INSERT_ID() AS id');
    expect(s.returning).toEqual(['id']);
  });

  it('an all-default row is INSERT … () VALUES ()', () => {
    const s = generateChange({ kind: 'insert', ref: '1', values: [] }, T, 'mysql');
    expect(s.sql).toBe('INSERT INTO orders () VALUES ()');
    expect(s.followUp).toBe('SELECT LAST_INSERT_ID() AS id');
  });

  it('a typed key needs no read-back; a non-identity key has none', () => {
    const typed = generateChange({ kind: 'insert', ref: '1', values: [{ column: id, value: 7 }] }, T, 'mysql');
    expect(typed.followUp).toBeUndefined();
    const guid = generateChange({ kind: 'insert', ref: '1', values: [{ column: name, value: 'x' }] }, { ...T, identityColumns: [] }, 'mysql');
    expect(guid.followUp).toBeUndefined();
  });

  it('quotes reserved column names with backticks', () => {
    const s = generateChange({ kind: 'update', ref: '1', key: [{ column: id, value: 1 }], set: [{ column: order, value: 'x', old: 'y' }] }, { ...T, name: 'group' }, 'mysql');
    expect(s.sql).toBe('UPDATE `group` SET `order` = @p1 WHERE id = @p2');
  });
});

describe('mysql savepoints', () => {
  it('has SAVEPOINT / ROLLBACK TO / RELEASE', () => {
    expect(savepointSql('mysql')).toBe('SAVEPOINT dbs_edit');
    expect(rollbackToSavepointSql('mysql')).toBe('ROLLBACK TO SAVEPOINT dbs_edit');
    expect(releaseSavepointSql('mysql')).toBe('RELEASE SAVEPOINT dbs_edit');
    expect(releaseSavepointSql('plsql')).toBeNull();
  });
});

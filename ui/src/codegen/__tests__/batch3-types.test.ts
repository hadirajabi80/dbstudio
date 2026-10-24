// Batch 3 type spellings: MySQL unsigned / tinyint(1) / char(36), ClickHouse wrappers, Snowflake NUMBER(p, 0).
import { describe, expect, it } from 'vitest';
import { resolveType } from '../types';

describe('MySQL types', () => {
  it('unsigned integers use the unsigned rows', () => {
    expect(resolveType('mysql', 'bigint unsigned')).toMatchObject({ cs: 'ulong', go: 'uint64' });
    expect(resolveType('mysql', 'int(10) unsigned')).toMatchObject({ cs: 'uint', go: 'uint32' });
    expect(resolveType('mysql', 'tinyint unsigned')).toMatchObject({ cs: 'byte' });
    expect(resolveType('mysql', 'bigint')).toMatchObject({ cs: 'long' });
  });

  it('tinyint(1) and bit(1) are booleans, wider ones are not', () => {
    expect(resolveType('mysql', 'tinyint(1)')).toMatchObject({ cs: 'bool', ts: 'boolean' });
    expect(resolveType('mysql', 'tinyint(4)')).toMatchObject({ cs: 'sbyte' });
    expect(resolveType('mysql', 'bit(1)')).toMatchObject({ cs: 'bool' });
    expect(resolveType('mysql', 'bit')).toMatchObject({ cs: 'bool' });
    expect(resolveType('mysql', 'bit(8)')).toMatchObject({ cs: 'ulong' });
  });

  it('char(36) is a Guid, other char sizes are strings', () => {
    expect(resolveType('mysql', 'char(36)')).toMatchObject({ cs: 'Guid', length: 36 });
    expect(resolveType('mysql', 'char(10)')).toMatchObject({ cs: 'string' });
  });
});

describe('ClickHouse wrapper types', () => {
  it('Nullable / LowCardinality / SimpleAggregateFunction unwrap to the inner type', () => {
    expect(resolveType('clickhouse', 'Nullable(Int32)')).toMatchObject({ cs: 'int', base: 'int32', dbType: 'Nullable(Int32)' });
    expect(resolveType('clickhouse', 'LowCardinality(Nullable(String))')).toMatchObject({ cs: 'string' });
    expect(resolveType('clickhouse', 'SimpleAggregateFunction(sum, UInt64)')).toMatchObject({ cs: 'ulong' });
    expect(resolveType('clickhouse', 'SimpleAggregateFunction(anyLast, Nullable(DateTime64(3, \'UTC\')))').known).toBe(true);
  });

  it('Array(T) is a list of T', () => {
    const r = resolveType('clickhouse', 'Array(Nullable(String))');
    expect(r).toMatchObject({ array: true, cs: 'string[]', go: '[]string', ts: 'string[]', py: 'list[str]' });
    expect(resolveType('clickhouse', 'Array(Array(UInt8))')).toMatchObject({ cs: 'byte[][]' });
  });
});

describe('Snowflake NUMBER', () => {
  it('NUMBER(p, 0) and bare NUMBER are int64, a scale keeps decimal', () => {
    expect(resolveType('snowflake', 'NUMBER(38,0)')).toMatchObject({ cs: 'long', go: 'int64' });
    expect(resolveType('snowflake', 'NUMBER')).toMatchObject({ cs: 'long' });
    expect(resolveType('snowflake', 'NUMBER(10)')).toMatchObject({ cs: 'long' });
    expect(resolveType('snowflake', 'NUMBER(10,2)')).toMatchObject({ cs: 'decimal' });
    expect(resolveType('snowflake', 'DECIMAL(18,0)')).toMatchObject({ cs: 'long' });
  });
});

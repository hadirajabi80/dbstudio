// ClickHouse dictionaries: the catalog type `type` is queryable and labelled "Dictionaries" on ClickHouse connections only.
import { describe, expect, it } from 'vitest';
import { isTabular, objectTypeLabel } from './sql';

describe('dictionaries (ClickHouse)', () => {
  it('are tabular on ClickHouse only', () => {
    expect(isTabular('type', 'clickhouse')).toBe(true);
    expect(isTabular('type', 'pgsql')).toBe(false);
    expect(isTabular('type')).toBe(false);
    expect(isTabular('table')).toBe(true);
    expect(isTabular('proc', 'clickhouse')).toBe(false);
  });

  it('have their own folder label', () => {
    expect(objectTypeLabel('type', 'clickhouse')).toBe('Dictionaries');
    expect(objectTypeLabel('type', 'plsql')).toBe('Types');
    expect(objectTypeLabel('table', 'clickhouse')).toBe('Tables');
  });
});

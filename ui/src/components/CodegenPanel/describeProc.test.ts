// features-14: SQL Server procedure result columns are described from metadata, without running the procedure.
import { describe, expect, it } from 'vitest';
import { DESCRIBE_PROC_SQL, parseDescribeRows, tsqlKind } from './describeProc';

const COLS = ['name', 'system_type_name', 'is_nullable', 'column_ordinal', 'error_number', 'error_message'].map((name) => ({ name }));

describe('describe a T-SQL procedure', () => {
  it('queries sys.dm_exec_describe_first_result_set_for_object with a bound name (no EXEC)', () => {
    expect(DESCRIBE_PROC_SQL).toContain('sys.dm_exec_describe_first_result_set_for_object(OBJECT_ID(@name), 0)');
    expect(DESCRIBE_PROC_SQL).not.toMatch(/\bEXEC\b/i);
    expect(DESCRIBE_PROC_SQL).toContain('ORDER BY column_ordinal');
  });

  it('turns the rows into result columns', () => {
    const out = parseDescribeRows(COLS, [
      ['Id', 'int', false, 1, null, null],
      ['Name', 'nvarchar(100)', true, 2, null, null],
      ['Total', 'decimal(18,2)', 1, 3, null, null],
      ['PlacedAt', 'datetime2(7)', 0, 4, null, null],
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.columns.map((c) => [c.name, c.dbType, c.kind, c.nullable, c.ordinal])).toEqual([
      ['Id', 'int', 'int', false, 0],
      ['Name', 'nvarchar(100)', 'string', true, 1],
      ['Total', 'decimal(18,2)', 'decimal', true, 2],
      ['PlacedAt', 'datetime2(7)', 'datetime', false, 3],
    ]);
  });

  it('reports why there are no columns', () => {
    const err = parseDescribeRows(COLS, [[null, null, null, null, 11529, "The metadata could not be determined because every code path results in an error; see previous errors for some of these."]]);
    expect(err).toEqual({ ok: false, reason: expect.stringContaining('metadata could not be determined') });
    expect(parseDescribeRows(COLS, [])).toEqual({ ok: false, reason: 'it returns no result set' });
  });

  it('maps SQL Server type names to wire kinds', () => {
    expect(tsqlKind('bit')).toBe('bool');
    expect(tsqlKind('uniqueidentifier')).toBe('guid');
    expect(tsqlKind('varbinary(max)')).toBe('binary');
    expect(tsqlKind('datetimeoffset(7)')).toBe('datetimeoffset');
    expect(tsqlKind('geography')).toBe('other');
  });
});

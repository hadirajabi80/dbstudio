// Executed query under a result grid: bind values inlined as literals of each dialect, the parameterised form, and the
// statement of the selected result set.
import { describe, expect, it } from 'vitest';
import type { QueryParam } from '../../api/types';
import { bindLiteral, inlineBinds, parameterisedSql, resultStatement, type ExecutedQuery } from './executedQuery';

const p = (name: string, kind: QueryParam['kind'], value: QueryParam['value'], extra: Partial<QueryParam> = {}): QueryParam => ({ name, kind, value, ...extra });

describe('inlineBinds', () => {
  it('T-SQL: N-quoted strings with doubled quotes, numbers, dates, NULL; strings, comments, @@vars and unknown names untouched', () => {
    const sql = "SELECT * FROM t WHERE name = @p1 AND id = @P2 AND n = @@ROWCOUNT AND note = '@p1' -- @p1\nAND d = @d AND v = @v AND l = @local";
    const r = inlineBinds(sql, [p('p1', 'string', "O'Brien"), p('p2', 'int', 7), p('d', 'datetime', '2026-01-03T10:00:00'), p('v', 'null', null)], 'tsql');
    expect(r.inlined).toBe(true);
    expect(r.sql).toBe("SELECT * FROM t WHERE name = N'O''Brien' AND id = 7 AND n = @@ROWCOUNT AND note = '@p1' -- @p1\nAND d = '2026-01-03T10:00:00' AND v = NULL AND l = @local");
  });

  it('Oracle: DATE / TIMESTAMP literals, plain quoted strings, booleans as 1/0', () => {
    const sql = 'SELECT * FROM t WHERE d = :fp1 AND ts >= :fp2 AND name = :fp3 AND flag = :fp4';
    const r = inlineBinds(sql, [p('fp1', 'date', '2026-01-03'), p('fp2', 'datetime', '2026-01-03T10:00:00'), p('fp3', 'string', "it's"), p('fp4', 'bool', true)], 'plsql');
    expect(r.sql).toBe("SELECT * FROM t WHERE d = DATE '2026-01-03' AND ts >= TIMESTAMP '2026-01-03 10:00:00' AND name = 'it''s' AND flag = 1");
  });

  it('SQLite: @name, :name, $name, ? and ?n; booleans 1/0, decimals raw, blobs as X\'..\'', () => {
    const sql = 'SELECT * FROM t WHERE a = @fp1 AND b = :name AND c = ? AND d = ?2 AND e = $x';
    const r = inlineBinds(sql, [p('fp1', 'bool', true), p('name', 'string', 'x'), p('1', 'int', 5), p('2', 'decimal', '12.50'), p('x', 'binary', 'AQL/')], 'sqlite');
    expect(r.sql).toBe("SELECT * FROM t WHERE a = 1 AND b = 'x' AND c = 5 AND d = 12.50 AND e = X'0102FF'");
  });

  it('PostgreSQL: $n and @name; TRUE/FALSE; ::casts, the jsonb ? operator and dollar-quoted bodies untouched', () => {
    const sql = "SELECT * FROM t WHERE a = $1 AND b = @fp1 AND c::int = 3 AND j ? 'k' AND s = $2 AND body = $$ $1 $$";
    const r = inlineBinds(sql, [p('1', 'bool', false), p('fp1', 'string', "it's"), p('2', 'null', null)], 'pgsql');
    expect(r.sql).toBe("SELECT * FROM t WHERE a = FALSE AND b = 'it''s' AND c::int = 3 AND j ? 'k' AND s = NULL AND body = $$ $1 $$");
  });

  it('keeps out parameters and ref cursors as placeholders; nothing to inline → unchanged', () => {
    const sql = 'EXEC dbo.p @a, @o OUTPUT';
    expect(inlineBinds(sql, [p('a', 'int', 1), p('o', 'int', null, { direction: 'out' })], 'tsql').sql).toBe('EXEC dbo.p 1, @o OUTPUT');
    expect(inlineBinds('SELECT 1', [], 'tsql')).toEqual({ sql: 'SELECT 1', inlined: false });
    expect(inlineBinds('SELECT @zz', [p('a', 'int', 1)], 'tsql')).toEqual({ sql: 'SELECT @zz', inlined: false });
  });

  it('a numeric kind with a non-numeric text is quoted, never pasted raw', () => {
    expect(bindLiteral(p('a', 'int', '1; DROP TABLE t'), 'sqlite')).toBe("'1; DROP TABLE t'");
    expect(bindLiteral(p('a', 'float', 1.5), 'pgsql')).toBe('1.5');
    expect(bindLiteral(p('a', 'binary', 'AQL/'), 'tsql')).toBe('0x0102FF');
  });
});

describe('parameterisedSql', () => {
  it('the statement as sent, then its binds as a comment', () => {
    const q: ExecutedQuery = { sql: 'SELECT * FROM t WHERE id = @fp1', params: [p('fp1', 'string', "O'Brien")], dialect: 'tsql', connectionId: 'c', database: null };
    expect(parameterisedSql(q)).toBe("SELECT * FROM t WHERE id = @fp1\n-- Parameters:\n--   @fp1 (string) = N'O''Brien'");
    expect(parameterisedSql({ ...q, dialect: 'plsql', sql: 'SELECT * FROM t WHERE id = :fp1' })).toContain("--   :fp1 (string) = 'O''Brien'");
  });
});

describe('resultStatement', () => {
  const rs = (id: number, batchIndex: number) => ({ id, batchIndex });
  const batch = (sql: string) => ({ sql, line: 1, col: 1 });

  it('the batch of the result set', () => {
    const exec = { batches: [batch('UPDATE t SET a = 1'), batch('SELECT * FROM b ')], resultSets: [rs(0, 1)] };
    expect(resultStatement(exec, rs(0, 1), 'sqlite')).toBe('SELECT * FROM b');
  });

  it('a T-SQL batch with several SELECTs: the one matching the selected result set', () => {
    const exec = { batches: [batch('SET NOCOUNT ON;\nSELECT * FROM a;\nSELECT * FROM b WHERE id = @id')], resultSets: [rs(0, 0), rs(1, 0)] };
    expect(resultStatement(exec, rs(1, 0), 'tsql')).toBe('SELECT * FROM b WHERE id = @id');
    expect(resultStatement(exec, rs(0, 0), 'tsql')).toBe('SELECT * FROM a');
  });

  it('falls back to the whole batch when results and SELECTs cannot be matched (procedures)', () => {
    const exec = { batches: [batch('EXEC dbo.report')], resultSets: [rs(0, 0), rs(1, 0)] };
    expect(resultStatement(exec, rs(1, 0), 'tsql')).toBe('EXEC dbo.report');
  });
});

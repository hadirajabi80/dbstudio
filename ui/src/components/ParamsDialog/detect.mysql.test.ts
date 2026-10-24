// MySQL / MariaDB bind detection (R3-P1): `@user_var` / `@@sysvar` are variables, not binds; `:name` and `?` still are.
import { beforeAll, describe, expect, it } from 'vitest';
import { getSpec, tokenize } from '../../intel';
import { ensureDialect } from '../../intel/dialect/registry';
import { statementParams } from '../../editor/param-hint';
import { detectParams } from './detect';

beforeAll(async () => {
  await ensureDialect('mysql');
});

const d = (sql: string) => detectParams([{ sql, line: 1, col: 1 }], 'mysql');

describe('detectParams (mysql)', () => {
  it('@user_var and @@sysvar are not binds', () => {
    expect(d('SET @n := 0; SELECT @n := @n + 1, @@sql_mode FROM t')).toEqual([]);
    expect(d('SELECT @@version, @x')).toEqual([]);
  });

  it(':name and ? are binds', () => {
    expect(d('SELECT * FROM t WHERE a = :id AND b = ? AND c = ?')).toEqual([
      { name: 'id', display: ':id', positional: false },
      { name: '1', display: '?', positional: true },
      { name: '2', display: '?', positional: true },
    ]);
  });

  it('routine definitions (also with DEFINER / AGGREGATE) and events are definitions', () => {
    expect(d('CREATE DEFINER = `root`@`localhost` PROCEDURE p(IN a INT) BEGIN SELECT :a; END')).toEqual([]);
    expect(d('CREATE DEFINER=CURRENT_USER AGGREGATE FUNCTION f(x INT) RETURNS INT RETURN :x')).toEqual([]);
    expect(d('CREATE EVENT ev ON SCHEDULE EVERY 1 DAY DO DELETE FROM t WHERE id < :n')).toEqual([]);
  });

  it('strings and comments never produce binds', () => {
    expect(d("SELECT '@a :b ?' -- :c\n, `x` # ?")).toEqual([]);
  });

  it('the editor hint skips variables too', () => {
    const toks = tokenize('SET @n := 1; SELECT :id, @n', getSpec('mysql'));
    expect(statementParams(toks, 0, toks.length, 'mysql')).toEqual([':id']);
  });
});

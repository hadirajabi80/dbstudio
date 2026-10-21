// PostgreSQL bind detection for the Parameters dialog (docs/PLAN-PG.md 4.3): `$n` positional, `:x` / `@x` named,
// never `?` (jsonb operator) and never `::type` casts; strings, comments and $$ bodies are skipped.
import { describe, expect, it } from 'vitest';
import { detectParams } from './detect';

const d = (sql: string) => detectParams([{ sql, line: 1, col: 1 }], 'pgsql');

describe('detectParams (pgsql)', () => {
  it('$1, $2 are positional and named by their number', () => {
    expect(d('SELECT * FROM orders WHERE id = $1 AND total > $2')).toEqual([
      { name: '1', display: '$1', positional: true },
      { name: '2', display: '$2', positional: true },
    ]);
  });

  it('a repeated $n is listed once', () => {
    expect(d('SELECT $1, $1 + 1').map((p) => p.name)).toEqual(['1']);
  });

  it(':name and @name are named binds', () => {
    expect(d('SELECT * FROM t WHERE a = :customer_id AND b = @since')).toEqual([
      { name: 'customer_id', display: ':customer_id', positional: false },
      { name: 'since', display: '@since', positional: false },
    ]);
  });

  it('? is the jsonb key-exists operator, not a bind', () => {
    expect(d("SELECT * FROM t WHERE doc ? 'tier' AND doc ?| array['a']")).toEqual([]);
  });

  it('::casts are not binds', () => {
    expect(d("SELECT '1'::int, x::text FROM t WHERE y = :y")).toEqual([{ name: 'y', display: ':y', positional: false }]);
  });

  it('strings and comments are skipped', () => {
    expect(d("SELECT ':a', '$1' -- :b\n/* @c */ FROM t")).toEqual([]);
  });

  it('DO blocks have no binds', () => {
    expect(d("DO $$ BEGIN RAISE NOTICE '%', 1; END $$")).toEqual([]);
  });
});

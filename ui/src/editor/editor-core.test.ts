// Pure editor modules (no Monaco): highlighting tokens, object URIs, run target resolution, marker conversion.
import { describe, expect, it, vi } from 'vitest';
import { createIntel, getSpec } from '../intel';
import { tokenizeLine } from './tokens-core';
import { objectUri, parseObjectUri } from './object-uri';
import { resolveRunTarget } from './run-target';
import { LatestRequest, serverMarkers, softMarkers } from './markers-core';

const SEV = { error: 8, warning: 4, info: 2 };

describe('tokens-core', () => {
  const scopes = (line: string, d: 'tsql' | 'plsql' | 'sqlite' = 'tsql', st = '') => tokenizeLine(line, getSpec(d), st).tokens.map((t) => t.scopes);
  it('keywords, identifiers, functions, types, variables', () => {
    expect(scopes('SELECT GETDATE(), CAST(x AS int), @v FROM t')).toEqual([
      'keyword', 'predefined', 'delimiter.parenthesis', 'delimiter.parenthesis', 'delimiter', 'predefined', 'delimiter.parenthesis',
      'identifier', 'keyword', 'type', 'delimiter.parenthesis', 'delimiter', 'variable', 'keyword', 'identifier',
    ]);
  });
  it('global @@ variables are predefined', () => expect(scopes('@@ROWCOUNT')).toEqual(['predefined']));
  it('batch separator', () => expect(scopes('GO 2')).toEqual(['keyword.batch']));
  it('Oracle / separator', () => expect(scopes('/', 'plsql')).toEqual(['keyword.batch']));
  it('column named like a type after a dot stays an identifier', () => expect(scopes('t.date', 'sqlite')).toEqual(['identifier', 'delimiter', 'identifier']));
  it('leading whitespace gets an empty scope token at 0', () => {
    const r = tokenizeLine('  x', getSpec('tsql'), '');
    expect(r.tokens[0]).toEqual({ startIndex: 0, scopes: '' });
    expect(r.tokens[1]).toEqual({ startIndex: 2, scopes: 'identifier' });
  });
  it('multi-line comment state', () => {
    const a = tokenizeLine('/* a', getSpec('tsql'), '');
    expect(a.endState).toBe('c1');
    expect(scopes('b */ SELECT', 'tsql', a.endState)).toEqual(['comment', 'keyword']);
  });
  it('PostgreSQL: $n params, :: casts to types, psql lines, $$ bodies across lines', () => {
    const pg = (line: string, st = '') => tokenizeLine(line, getSpec('pgsql'), st);
    expect(pg('SELECT $1::int').tokens.map((t) => t.scopes)).toEqual(['keyword', 'variable', 'operator', 'type']);
    expect(pg('\\dt public.*').tokens.map((t) => t.scopes)).toEqual(['keyword.batch']);
    const a = pg('AS $$');
    expect(a.endState).toBe('d');
    const b = pg("  SELECT 'not code';", a.endState);
    expect(b.tokens.map((t) => t.scopes)).toEqual(['string']);
    expect(pg('$$ LANGUAGE sql;', b.endState).tokens.map((t) => t.scopes)).toEqual(['string', 'keyword.contextual', 'identifier', 'delimiter']);
  });
});

describe('object-uri', () => {
  it('round trips refs with special characters', () => {
    const ref = { database: 'my db', schema: 'Sales/EU', name: 'Order Lines?', type: 'table' as const };
    const u = objectUri('c_1', ref, 'Qty', 'dbstudio-tab://tab/t1.sql');
    expect(u.startsWith('dbstudio-object://c_1/my%20db/Sales%2FEU/table/')).toBe(true);
    expect(parseObjectUri(u)).toEqual({ connectionId: 'c_1', ref, column: 'Qty', owner: 'dbstudio-tab://tab/t1.sql' });
  });
  it('null database / schema', () => {
    const ref = { database: null, schema: null, name: 'x', type: 'view' as const };
    expect(parseObjectUri(objectUri('c', ref))!.ref).toEqual(ref);
  });
  it('rejects other URIs', () => {
    expect(parseObjectUri('file:///x')).toBeNull();
    expect(parseObjectUri('dbstudio-object://c/d/s/bogus/n')).toBeNull();
  });
});

describe('run-target', () => {
  const setup = (d: 'tsql' | 'plsql', text: string) => { const i = createIntel(d); i.setDocument('u', text); return i; };
  it('statement at cursor', () => {
    const i = setup('tsql', 'SELECT 1\n\nSELECT 2');
    expect(resolveRunTarget(i, 'u', 'statement', 12, null)).toEqual({ label: 'statement', batches: [{ sql: 'SELECT 2', line: 3, col: 1 }], text: 'SELECT 2', range: [10, 18] });
  });
  it('selection wins over statement and is GO-aware', () => {
    const text = 'SELECT 1\nGO\nSELECT 2\nSELECT 3';
    const i = setup('tsql', text);
    const t = resolveRunTarget(i, 'u', 'statement', 0, [0, text.length])!;
    expect(t.label).toBe('selection');
    expect(t.batches.map((b) => [b.sql, b.line])).toEqual([['SELECT 1', 1], ['SELECT 2\nSELECT 3', 3]]);
  });
  it('whitespace-only selection falls back to the statement', () => {
    const i = setup('tsql', 'SELECT 1   ');
    expect(resolveRunTarget(i, 'u', 'statement', 2, [9, 11])!.label).toBe('statement');
  });
  it('script runs every batch', () => {
    const i = setup('tsql', 'SELECT 1\nGO\nSELECT 2');
    expect(resolveRunTarget(i, 'u', 'script', 0, null)!.batches).toHaveLength(2);
  });
  it('Oracle EXEC is rewritten; SQL*Plus commands produce no batches', () => {
    const i = setup('plsql', 'EXEC p(1)\nSET SERVEROUTPUT ON');
    expect(resolveRunTarget(i, 'u', 'statement', 2, null)!.batches[0].sql).toBe('BEGIN p(1); END;');
    expect(resolveRunTarget(i, 'u', 'statement', 12, null)!.batches).toEqual([]);
  });
  it('empty document', () => {
    const i = setup('tsql', '  \n ');
    expect(resolveRunTarget(i, 'u', 'script', 0, null)).toBeNull();
    expect(resolveRunTarget(i, 'u', 'statement', 0, null)).toBeNull();
  });
});

describe('markers-core', () => {
  it('soft diagnostics keep positions and widen empty ranges', () => {
    const m = softMarkers([{ start: 0, end: 0, line: 2, col: 5, endLine: 2, endCol: 5, severity: 'warning', code: 'x', message: 'm' }], SEV);
    expect(m[0]).toMatchObject({ startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 6, severity: 4, code: 'x' });
  });
  it('server diagnostics: empty range widened to the word end', () => {
    const m = serverMarkers([{ line: 3, col: 10, endLine: 0, endCol: 0, severity: 'error', code: 'SQL46010', message: 'Incorrect syntax' }], SEV, 'server', () => 14);
    expect(m[0]).toMatchObject({ startLineNumber: 3, startColumn: 10, endLineNumber: 3, endColumn: 14, severity: 8, code: 'SQL46010' });
  });
  it('LatestRequest applies only the newest result', async () => {
    vi.useFakeTimers();
    const lr = new LatestRequest<number>(400);
    const applied: number[] = [];
    let resolveFirst: (v: number) => void = () => {};
    lr.schedule(() => new Promise<number>((r) => { resolveFirst = r; }), (v) => applied.push(v));
    vi.advanceTimersByTime(400);
    lr.schedule(() => Promise.resolve(2), (v) => applied.push(v));
    vi.advanceTimersByTime(399);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1);
    resolveFirst(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([2]);
    vi.useRealTimers();
  });
  it('debounce: rapid schedules run once', () => {
    vi.useFakeTimers();
    const lr = new LatestRequest<number>(400);
    const run = vi.fn(() => Promise.resolve(1));
    for (let k = 0; k < 5; k++) { lr.schedule(run, () => {}); vi.advanceTimersByTime(100); }
    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

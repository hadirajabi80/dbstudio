// CQL type map for code generation (plan-batch3 WP-CS, codegen/types/cql.json).
import { describe, expect, it } from 'vitest';
import { resolveType, TYPE_TABLES } from '../types';

const t = (type: string) => resolveType('cql', type);
const langs = (type: string) => { const r = t(type); return [r.cs, r.go, r.ts, r.java, r.py]; };
// generic list<T> / set<T> / map<K, V> / frozen<T> resolution (docs/wp-notes/WP-CS-intel.md R3-4)
const R3_GENERICS = t('list<timeuuid>').known;

describe('CQL type map', () => {
  it('native types', () => {
    expect(langs('text')).toEqual(['string', 'string', 'string', 'String', 'str']);
    expect(langs('int')).toEqual(['int', 'int32', 'number', 'int', 'int']);
    expect(langs('bigint')).toEqual(['long', 'int64', 'number', 'long', 'int']);
    expect(t('counter').cs).toBe('long');
    expect(t('varint').cs).toBe('System.Numerics.BigInteger');
    expect(t('decimal')).toMatchObject({ cs: 'decimal', java: 'BigDecimal', py: 'Decimal' });
    expect(t('uuid').cs).toBe('Guid');
    expect(t('timeuuid').java).toBe('UUID');
    expect(t('timestamp')).toMatchObject({ logical: 'datetimeoffset', cs: 'DateTimeOffset', java: 'java.time.Instant' });
    expect(t('date')).toMatchObject({ cs: 'DateOnly', java: 'LocalDate' });
    expect(t('time').cs).toBe('TimeOnly');
    expect(t('duration').logical).toBe('interval');
    expect(t('inet')).toMatchObject({ cs: 'IPAddress', java: 'java.net.InetAddress' });
    expect(t('blob')).toMatchObject({ cs: 'byte[]', go: '[]byte', py: 'bytes' });
    expect(t('boolean').ts).toBe('boolean');
    for (const k of ['ascii', 'varchar', 'tinyint', 'smallint', 'float', 'double']) expect(t(k).known, k).toBe(true);
  });

  it('collections fall back to the wire kind until R3-4', () => {
    if (R3_GENERICS) return;
    expect(resolveType('cql', 'set<text>', { kind: 'other' })).toMatchObject({ cs: 'object', known: false });
  });

  it('every row names all languages', () => {
    for (const [key, row] of Object.entries(TYPE_TABLES.cql)) for (const l of ['cs', 'go', 'ts', 'java', 'py'] as const) expect(row[l], `${key}.${l}`).toBeTruthy();
  });

  it('UDTs fall back to the wire kind', () => {
    expect(resolveType('cql', 'frozen<address>', { kind: 'other' }).known).toBe(false);
    expect(resolveType('cql', 'address', { kind: 'string' }).cs).toBe('string');
  });

  it.skipIf(!R3_GENERICS)('(R3-4) any list / set / map / frozen, nested', () => {
    expect(langs('set<text>')).toEqual(['IEnumerable<string>', '[]string', 'string[]', 'java.util.Set<String>', 'set[str]']);
    expect(langs('list<int>')).toEqual(['List<int>', '[]int32', 'number[]', 'java.util.List<Integer>', 'list[int]']);
    expect(langs('map<text, text>')).toEqual(['IDictionary<string, string>', 'map[string]string', 'Record<string, string>', 'java.util.Map<String, String>', 'dict[str, str]']);
    expect(langs('list<timeuuid>')).toEqual(['List<Guid>', '[]string', 'string[]', 'java.util.List<UUID>', 'list[UUID]']);
    expect(langs('frozen<map<text, frozen<list<int>>>>')).toEqual(['IDictionary<string, List<int>>', 'map[string][]int32', 'Record<string, number[]>', 'java.util.Map<String, java.util.List<Integer>>', 'dict[str, list[int]]']);
    expect(t('map<int, boolean>').java).toBe('java.util.Map<Integer, Boolean>');
    expect(t('set<frozen<address>>').known).toBe(false);
  });
});

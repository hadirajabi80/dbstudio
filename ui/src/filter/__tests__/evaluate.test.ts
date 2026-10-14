import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { compileFilter, computeView, countMatches } from '../evaluate';
import {
  appendAnd, columnSignature, newCondition, newGroup, normalizeModel, removeNode, type FilterNode, type FilterOp, type FilterValue,
} from '../model';
import { OPS_BY_CLASS, operatorsFor } from '../operators';
import { compareDecimalStrings, conditionProblem, periodBounds, splitList } from '../values';

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'T', schema: 'dbo', isKey: name === 'id',
});

export const COLUMNS: ColumnInfo[] = [
  col('id', 'int', 0), col('name', 'string', 1), col('total', 'decimal', 2), col('price', 'float', 3), col('created', 'datetime', 4),
  col('day', 'date', 5), col('at', 'time', 6), col('active', 'bool', 7), col('data', 'binary', 8), col('code', 'guid', 9), col('doc', 'json', 10),
];

const BIN = { $bin: 'AQI=', len: 2 };
export const ROWS: CellValue[][] = [
  [1, 'Acme Ltd', '1250.00', 1.5, '2026-01-03T10:00:00', '2026-01-03', '08:30:00', true, BIN, '6F9619FF-8B86-D011-B42D-00C04FC964FF', '{"a":1}'],
  [2, 'acme corp', '10.00', 20, '2026-01-03T23:59:59.9970000', '2026-01-04', '12:00:00', false, null, '11111111-0000-0000-0000-000000000000', null],
  [3, '', '20.00', null, '2026-02-10T00:00:00', null, '18:45:10.1230000', null, BIN, null, '[]'],
  [4, null, '99999999999999999999.5', 3.25, null, '2025-12-31', null, 1, null, '22222222-0000-0000-0000-000000000000', '{"b":2}'],
  [5, 'Zeta_50%', '-5', 0, '2026-01-02 09:00:00', '2026-01-02', '23:59:59', 0, BIN, '33333333-0000-0000-0000-000000000000', '{}'],
];

const ids = (node: FilterNode | null) => {
  const idx = computeView({ length: ROWS.length, get: (i) => ROWS[i] }, COLUMNS, { quickFilter: '', filter: node && node.kind === 'group' ? node : node ? newGroup('and', [node]) : null, sort: [] });
  return idx ? Array.from(idx, (i) => ROWS[i][0]) : ROWS.map((r) => r[0]);
};
const cond = (column: string, op: FilterOp, values: FilterValue[] = [], caseSensitive = false) => {
  const c = newCondition(column, op, values);
  return caseSensitive ? { ...c, caseSensitive } : c;
};

type Case = [string, FilterOp, FilterValue[], number[], boolean?];

// [column, op, values, expected ids, caseSensitive]
const MATRIX: Record<string, Case[]> = {
  'int': [
    ['id', 'eq', [3], [3]], ['id', 'neq', ['3'], [1, 2, 4, 5]], ['id', 'lt', [3], [1, 2]], ['id', 'lte', [3], [1, 2, 3]],
    ['id', 'gt', [3], [4, 5]], ['id', 'gte', ['3'], [3, 4, 5]], ['id', 'between', [2, 4], [2, 3, 4]], ['id', 'in', [1, '5'], [1, 5]],
    ['id', 'notIn', [1, 5], [2, 3, 4]], ['id', 'isNull', [], []], ['id', 'isNotNull', [], [1, 2, 3, 4, 5]],
  ],
  'decimal': [
    ['total', 'eq', ['10'], [2]], ['total', 'gt', ['100'], [1, 4]], ['total', 'lt', [0], [5]], ['total', 'between', ['10', '20'], [2, 3]],
    ['total', 'gte', ['99999999999999999999.4'], [4]], ['total', 'gt', ['99999999999999999999.5'], []], ['total', 'in', ['10.0', '-5'], [2, 5]],
    ['total', 'notIn', ['10.0'], [1, 3, 4, 5]], ['total', 'neq', ['20'], [1, 2, 4, 5]], ['total', 'lte', ['-5'], [5]],
  ],
  'float': [
    ['price', 'eq', [1.5], [1]], ['price', 'gt', [1], [1, 2, 4]], ['price', 'between', [0, 2], [1, 5]], ['price', 'isNull', [], [3]],
    ['price', 'isNotNull', [], [1, 2, 4, 5]], ['price', 'lte', ['0'], [5]],
  ],
  'string': [
    ['name', 'contains', ['ACME'], [1, 2]], ['name', 'contains', ['Acme'], [1], true], ['name', 'notContains', ['acme'], [3, 5]],
    ['name', 'startsWith', ['acme'], [1, 2]], ['name', 'endsWith', ['LTD'], [1]], ['name', 'endsWith', ['Ltd'], [1], true],
    ['name', 'eq', ['acme corp'], [2]], ['name', 'eq', ['ACME CORP'], [], true], ['name', 'neq', ['acme corp'], [1, 3, 5]],
    ['name', 'in', ['acme ltd', 'zeta_50%'], [1, 5]], ['name', 'notIn', ['acme ltd'], [2, 3, 5]], ['name', 'isEmpty', [], [3]],
['name', 'isNull', [], [4]], ['name', 'isNotNull', [], [1, 2, 3, 5]],
    ['name', 'regex', ['^a.*(ltd|corp)$'], [1, 2]], ['name', 'regex', ['^A'], [1], true], ['name', 'contains', ['_50%'], [5]],
  ],
  'json/guid': [
    ['doc', 'contains', ['"a"'], [1]], ['doc', 'isNull', [], [2]], ['code', 'startsWith', ['6f96'], [1]], ['code', 'eq', ['11111111-0000-0000-0000-000000000000'], [2]],
  ],
  'datetime': [
    ['created', 'onDate', ['2026-01-03'], [1, 2]], ['created', 'before', ['2026-01-03'], [5]], ['created', 'after', ['2026-01-03'], [3]],
    ['created', 'after', ['2026-01-03 12:00'], [2, 3]], ['created', 'before', ['2026-01-03T10:00:01'], [1, 5]],
    ['created', 'between', ['2026-01-02', '2026-01-03'], [1, 2, 5]], ['created', 'isNull', [], [4]], ['created', 'isNotNull', [], [1, 2, 3, 5]],
  ],
  'date': [
    ['day', 'onDate', ['2026-01-04'], [2]], ['day', 'before', ['2026-01-01'], [4]], ['day', 'after', ['2026-01-02'], [1, 2]],
    ['day', 'between', ['2025-12-31', '2026-01-02'], [4, 5]], ['day', 'isNull', [], [3]], ['day', 'isNotNull', [], [1, 2, 4, 5]],
  ],
  'time': [
    ['at', 'before', ['12:00'], [1]], ['at', 'after', ['12:00'], [3, 5]], ['at', 'between', ['08:00', '12:00:00'], [1, 2]],
    ['at', 'after', ['18:45:10'], [3, 5]], ['at', 'isNull', [], [4]], ['at', 'isNotNull', [], [1, 2, 3, 5]],
  ],
  'bool': [
    ['active', 'isTrue', [], [1, 4]], ['active', 'isFalse', [], [2, 5]], ['active', 'isNull', [], [3]], ['active', 'isNotNull', [], [1, 2, 4, 5]],
  ],
  'binary': [
    ['data', 'isNull', [], [2, 4]], ['data', 'isNotNull', [], [1, 3, 5]],
  ],
};

describe('filter evaluation: every operator × column kind', () => {
  for (const [group, cases] of Object.entries(MATRIX)) {
    describe(group, () => {
      it.each(cases)('%s %s %j → %j', (column, op, values, expected, cs) => {
        expect(ids(cond(column, op, values, !!cs))).toEqual(expected);
      });
    });
  }

  it('every operator offered for a kind is covered by the matrix', () => {
    const covered = new Map<string, Set<string>>();
    const kindOf = (name: string) => COLUMNS.find((c) => c.name === name)!.kind;
    for (const cases of Object.values(MATRIX)) {
      for (const [column, op] of cases) {
        const k = kindOf(column);
        if (!covered.has(k)) covered.set(k, new Set());
        covered.get(k)!.add(op);
      }
    }
    for (const k of ['int', 'string', 'datetime', 'date', 'time', 'bool', 'binary'] as ColumnKind[]) {
      const missing = operatorsFor(k).filter((op) => !covered.get(k)?.has(op) && op !== 'last' && op !== 'next');
      expect(missing, `kind ${k}`).toEqual([]);
    }
  });

  it('isNull matches only NULL and isEmpty only the empty string', () => {
    expect(ids(cond('name', 'isNull'))).toEqual([4]);
    expect(ids(cond('name', 'isEmpty'))).toEqual([3]);
  });

  it('negative operators never match NULL (SQL semantics)', () => {
    expect(ids(cond('name', 'neq', ['x']))).not.toContain(4);
    expect(ids(cond('name', 'notContains', ['x']))).not.toContain(4);
    expect(ids(cond('price', 'notIn', [99]))).not.toContain(3);
  });

  it('last / next N days, weeks and months relative to now', () => {
    const now = new Date(2026, 0, 4, 12, 0, 0);
    const rows: CellValue[][] = [[1, '2026-01-04T08:00:00'], [2, '2026-01-01T00:00:00'], [3, '2025-12-28T23:00:00'], [4, '2026-01-05T09:00:00'], [5, '2026-02-03T00:00:00']];
    const cols = [col('id', 'int', 0), col('t', 'datetime', 1)];
    const run = (op: FilterOp, values: FilterValue[]) => {
      const idx = computeView({ length: rows.length, get: (i) => rows[i] }, cols, { quickFilter: '', filter: newGroup('and', [newCondition('t', op, values)]), sort: [] }, { now });
      return Array.from(idx!, (i) => rows[i][0]);
    };
    expect(run('last', [3, 'days'])).toEqual([1, 2]);
    expect(run('last', [1, 'weeks'])).toEqual([1, 2, 3]);
    expect(run('next', [1, 'days'])).toEqual([4]);
    expect(run('next', [1, 'months'])).toEqual([4, 5]);
    expect(periodBounds('last', 2, 'days', now)).toEqual({ from: '2026-01-02T00:00:00', to: '2026-01-04T12:00:00' });
  });

  it('incomplete or invalid conditions are ignored instead of hiding every row', () => {
    expect(ids(cond('id', 'eq', []))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(cond('id', 'eq', ['abc']))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(cond('name', 'regex', ['(']))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(cond('created', 'before', ['yesterday']))).toEqual([1, 2, 3, 4, 5]);
    expect(conditionProblem(cond('id', 'eq', ['abc']), 'int')).toMatch(/not a number/);
    expect(conditionProblem(cond('id', 'between', [1]), 'int')).toMatch(/both/);
    expect(conditionProblem(cond('created', 'onDate', ['2026-02-30']), 'datetime')).toMatch(/YYYY/);
    expect(conditionProblem(cond('id', 'isNull'), 'int')).toBeNull();
  });

  it('disabled conditions and unknown columns are skipped', () => {
    expect(ids({ ...cond('id', 'eq', [1]), enabled: false })).toEqual([1, 2, 3, 4, 5]);
    expect(compileFilter(cond('nope', 'eq', [1]), COLUMNS)).toBeNull();
  });

  it('resolves columns case-insensitively and by ordinal hint for duplicate names', () => {
    expect(ids(cond('NAME', 'contains', ['zeta']))).toEqual([5]);
    const dupCols = [col('id', 'int', 0), col('id', 'int', 1)];
    const rows = [[1, 9], [2, 1]];
    const f = newGroup('and', [newCondition('id', 'eq', [1], 1)]);
    const idx = computeView({ length: 2, get: (i) => rows[i] }, dupCols, { quickFilter: '', filter: f, sort: [] });
    expect(Array.from(idx!)).toEqual([1]);
  });
});

describe('AND / OR groups', () => {
  it('(A AND B) OR C', () => {
    const a = cond('name', 'contains', ['acme']);
    const b = cond('total', 'gt', [100]);
    const c = cond('id', 'eq', [5]);
    const tree = newGroup('or', [newGroup('and', [a, b]), c]);
    expect(ids(tree)).toEqual([1, 5]);
  });
  it('removing a middle condition re-evaluates', () => {
    const a = cond('id', 'gte', [2]);
    const b = cond('price', 'gt', [5]);
    const c = cond('active', 'isFalse');
    const tree = newGroup('and', [a, b, c]);
    expect(ids(tree)).toEqual([2]);
    expect(ids(removeNode(tree, b.id))).toEqual([2, 5]);
  });
  it('OR of three, nested AND inside OR inside AND', () => {
    expect(ids(newGroup('or', [cond('id', 'eq', [1]), cond('id', 'eq', [3]), cond('id', 'eq', [5])]))).toEqual([1, 3, 5]);
    const t = newGroup('and', [cond('id', 'lte', [4]), newGroup('or', [cond('name', 'isNull'), newGroup('and', [cond('active', 'isTrue'), cond('price', 'lt', [2])])])]);
    expect(ids(t)).toEqual([1, 4]);
  });
  it('negated group', () => {
    expect(ids({ ...newGroup('and', [cond('id', 'lte', [2])]), negate: true })).toEqual([3, 4, 5]);
  });
  it('empty groups are neutral and Clear restores every row', () => {
    expect(ids(newGroup('and', []))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(newGroup('or', [newGroup('and', []), cond('id', 'eq', [2])]))).toEqual([2]);
    expect(ids(null)).toEqual([1, 2, 3, 4, 5]);
  });
  it('appendAnd wraps an OR root', () => {
    const or = newGroup('or', [cond('id', 'eq', [1]), cond('id', 'eq', [2])]);
    const next = appendAnd(or, cond('active', 'isTrue'));
    expect(next.logic).toBe('and');
    expect(ids(next)).toEqual([1]);
  });
  it('quick filter combines with the tree', () => {
    const idx = computeView({ length: ROWS.length, get: (i) => ROWS[i] }, COLUMNS, { quickFilter: 'CORP', filter: newGroup('and', [cond('id', 'lte', [3])]), sort: [] });
    expect(Array.from(idx!, (i) => ROWS[i][0])).toEqual([2]);
  });
  it('countMatches agrees with computeView', () => {
    const t = newGroup('or', [cond('name', 'contains', ['a']), cond('price', 'isNull')]);
    expect(countMatches({ length: ROWS.length, get: (i) => ROWS[i] }, COLUMNS, t)).toBe(ids(t).length);
  });
});

describe('model helpers', () => {
  it('operator lists per kind follow the spec', () => {
    expect(OPS_BY_CLASS.number).toEqual(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'notIn', 'isNull', 'isNotNull']);
    expect(operatorsFor('bool')).toEqual(['isTrue', 'isFalse', 'isNull', 'isNotNull']);
    expect(operatorsFor('binary')).toEqual(['isNull', 'isNotNull']);
    expect(operatorsFor('cursor')).toEqual(['isNull', 'isNotNull']);
    expect(operatorsFor('date')).toContain('last');
    expect(operatorsFor('time')).toEqual(expect.arrayContaining(['before', 'after', 'between']));
    expect(operatorsFor('guid')).toContain('regex');
  });
  it('column signature is order-independent', () => {
    expect(columnSignature([{ name: 'b', kind: 'int' }, { name: 'a', kind: 'string' }])).toBe('a:string|b:int');
    expect(columnSignature([{ name: 'a', kind: 'string' }, { name: 'b', kind: 'int' }])).toBe('a:string|b:int');
  });
  it('normalizes foreign/M1 shapes', () => {
    const m = normalizeModel({ root: { logic: 'or', items: [{ column: 'id', op: 'eq', values: [1] }, { column: 1, op: 'in', value: 'a, b' }] } }, COLUMNS);
    expect(m.root.logic).toBe('or');
    expect(m.root.items[0]).toMatchObject({ kind: 'condition', column: 'id', op: 'eq', values: [1] });
    expect(m.root.items[1]).toMatchObject({ column: 'name', ordinal: 1, values: ['a', 'b'] });
  });
  it('splits typed lists with quotes', () => {
    expect(splitList('a, b ,"c, d", \'e\'\'s\'')).toEqual(['a', 'b', 'c, d', "e's"]);
    expect(splitList('')).toEqual([]);
  });
  it('compares long decimals exactly', () => {
    expect(compareDecimalStrings('99999999999999999999.5', '99999999999999999999.4')).toBe(1);
    expect(compareDecimalStrings('-1.5', '-1.25')).toBe(-1);
    expect(compareDecimalStrings('10', '9.99')).toBe(1);
    expect(compareDecimalStrings('1.50', '1.5')).toBe(0);
  });
});

describe('decimal text comparison', () => {
  it.each([
    ['1250.00', '1250', 0], ['0.5', '0.5', 0], ['.5', '0.5', 0], ['-5', '-5', 0], ['12', '100', -1], ['-12', '-100', 1],
    ['007.10', '7.1', 0], ['-0.00', '0', 0], ['10.01', '10.1', -1], ['99999999999999999999.5', '99999999999999999999.4', 1],
  ])('%s vs %s', async (a, b, sign) => {
    const { compareDecimalText } = await import('../values');
    expect(Math.sign(compareDecimalText(a as string, b as string)!)).toBe(sign);
  });
  it('falls back on non-plain text', async () => {
    const { compareDecimalText } = await import('../values');
    expect(compareDecimalText('1e5', '1')).toBeUndefined();
    expect(compareDecimalText(' 1', '1')).toBeUndefined();
    expect(compareDecimalText('', '1')).toBeUndefined();
  });
});

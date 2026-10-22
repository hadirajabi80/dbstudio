import { describe, expect, it } from 'vitest';
import type { ObjectListItem } from '../../api/types.objects';
import {
  countByGroup, filterObjects, formatModified, formatRowsShort, formatSize, fromCatalog, groupForType, nextSort, objectsTitle, sortObjects,
} from './model';

const item = (p: Partial<ObjectListItem> & Pick<ObjectListItem, 'name' | 'type'>): ObjectListItem => ({
  schema: 'dbo', rowCount: null, sizeBytes: null, modified: null, created: null, comment: null, ...p,
});

const ITEMS: ObjectListItem[] = [
  item({ name: 'Orders', type: 'table', rowCount: 5000, sizeBytes: 900_000, modified: '2026-06-24T08:15:00', comment: 'All orders' }),
  item({ name: 'customers', type: 'table', rowCount: 500, sizeBytes: 150_000, modified: '2026-09-18T10:15:00' }),
  item({ name: 'order_audit', type: 'trigger', comment: 'on orders' }),
  item({ name: 'v_orders', type: 'view' }),
  item({ name: 'mv_totals', type: 'mview' }),
  item({ name: 'GetOrder', type: 'proc', schema: 'sales' }),
  item({ name: 'fnTax', type: 'func' }),
  item({ name: 'OrdersOf', type: 'tablefunc' }),
  item({ name: 'Lines', type: 'table', rowCount: null }),
];

describe('Objects tab model', () => {
  it('counts per type group (views include materialized views, functions include table functions)', () => {
    const c = countByGroup(ITEMS);
    expect(c.all).toBe(9);
    expect(c.table).toBe(3);
    expect(c.view).toBe(2);
    expect(c.func).toBe(2);
    expect(c.proc).toBe(1);
    expect(c.trigger).toBe(1);
    expect(c.sequence).toBe(0);
  });

  it('filters by group and by every word of the query in schema.name or the comment', () => {
    expect(filterObjects(ITEMS, 'table', '').map((i) => i.name)).toEqual(['Orders', 'customers', 'Lines']);
    expect(filterObjects(ITEMS, 'all', 'ORDER').map((i) => i.name)).toEqual(['Orders', 'order_audit', 'v_orders', 'GetOrder', 'OrdersOf']);
    expect(filterObjects(ITEMS, 'all', 'sales.get').map((i) => i.name)).toEqual(['GetOrder']);
    expect(filterObjects(ITEMS, 'all', 'on orders').map((i) => i.name)).toEqual(['order_audit']);
    expect(filterObjects(ITEMS, 'view', 'tot').map((i) => i.name)).toEqual(['mv_totals']);
  });

  it('sorts by name (case-insensitive), numbers with nulls last in both directions', () => {
    expect(sortObjects(ITEMS, { key: 'name', dir: 'asc' }).slice(0, 3).map((i) => i.name)).toEqual(['customers', 'fnTax', 'GetOrder']);
    const rows = sortObjects(ITEMS.filter((i) => i.type === 'table'), { key: 'rows', dir: 'desc' });
    expect(rows.map((i) => i.name)).toEqual(['Orders', 'customers', 'Lines']);
    const asc = sortObjects(ITEMS.filter((i) => i.type === 'table'), { key: 'rows', dir: 'asc' });
    expect(asc.map((i) => i.name)).toEqual(['customers', 'Orders', 'Lines']);
    expect(sortObjects(ITEMS, { key: 'modified', dir: 'desc' })[0].name).toBe('customers');
  });

  it('header clicks flip the direction; numbers and dates start descending', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'rows')).toEqual({ key: 'rows', dir: 'desc' });
    expect(nextSort({ key: 'rows', dir: 'desc' }, 'comment')).toEqual({ key: 'comment', dir: 'asc' });
  });

  it('builds the fallback list from the loaded catalog and titles the tab', () => {
    const list = fromCatalog([{ name: 'dbo', version: 1, objects: [{ t: 'table', n: 'A', cm: 'x' }] }, { name: 'hr', version: 1, objects: [{ t: 'view', n: 'B' }] }], 'dbo');
    expect(list).toEqual([{ type: 'table', schema: 'dbo', name: 'A', rowCount: null, sizeBytes: null, modified: null, created: null, comment: 'x' }]);
    expect(fromCatalog([{ name: 'dbo', version: 1, objects: [{ t: 'table', n: 'A' }] }, { name: 'hr', version: 1, objects: [{ t: 'view', n: 'B' }] }], null)).toHaveLength(2);
    expect(objectsTitle('Shop', 'dbo')).toBe('Objects: Shop.dbo');
    expect(objectsTitle(null, 'main')).toBe('Objects: main');
    expect(objectsTitle('Shop', null)).toBe('Objects: Shop');
    expect(groupForType('tablefunc')).toBe('func');
    expect(groupForType(undefined)).toBe('all');
  });

  it('formats sizes, compact row counts and server-local dates', () => {
    expect(formatSize(null)).toBe('');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(8192)).toBe('8.0 KB');
    expect(formatSize(43_200_000)).toBe('41.2 MB');
    expect(formatSize(5 * 1024 ** 4)).toBe('5.0 TB');
    expect(formatRowsShort(950)).toBe('950');
    expect(formatRowsShort(12_000)).toBe('12.0K');
    expect(formatRowsShort(150_000)).toBe('150K');
    expect(formatRowsShort(4_500_000)).toBe('4.5M');
    expect(formatModified('2026-06-24T08:15:00+00:00')).toBe('2026-06-24 08:15');
  });
});

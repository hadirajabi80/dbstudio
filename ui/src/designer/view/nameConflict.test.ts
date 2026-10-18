// logic-07: a new (or renamed) view must not silently take the name of an existing table or view.
import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot } from '../../api/types';
import { viewNameConflict } from './nameConflict';

const snap = {
  defaultSchema: 'main',
  schemas: [
    {
      name: 'main',
      objects: [
        { t: 'table', n: 'Countries' },
        { t: 'view', n: 'CustomerOrderTotals' },
        { t: 'proc', n: 'NotAView' },
      ],
    },
    { name: 'audit', objects: [{ t: 'view', n: 'Log' }] },
  ],
} as unknown as Pick<CatalogSnapshot, 'schemas' | 'defaultSchema'>;

describe('viewNameConflict', () => {
  it('flags an existing view or table for a new view (case-insensitive)', () => {
    expect(viewNameConflict(snap, 'sqlite', null, 'CustomerOrderTotals', null)).toEqual({ name: 'CustomerOrderTotals', type: 'view' });
    expect(viewNameConflict(snap, 'sqlite', 'main', 'customerordertotals', null)).toEqual({ name: 'CustomerOrderTotals', type: 'view' });
    expect(viewNameConflict(snap, 'sqlite', null, ' countries ', null)).toEqual({ name: 'Countries', type: 'table' });
  });

  it('a free name, another object kind or another schema is no conflict', () => {
    expect(viewNameConflict(snap, 'sqlite', null, 'vActiveCustomers', null)).toBeNull();
    expect(viewNameConflict(snap, 'sqlite', null, 'NotAView', null)).toBeNull();
    expect(viewNameConflict(snap, 'tsql', 'main', 'Log', null)).toBeNull();
    expect(viewNameConflict(snap, 'tsql', 'AUDIT', 'log', null)).toEqual({ name: 'Log', type: 'view' });
  });

  it('editing a view under its own name (any letter case) is fine; renaming onto another one is not', () => {
    expect(viewNameConflict(snap, 'sqlite', null, 'CustomerOrderTotals', 'CustomerOrderTotals')).toBeNull();
    expect(viewNameConflict(snap, 'sqlite', null, 'CUSTOMERORDERTOTALS', 'CustomerOrderTotals')).toBeNull();
    expect(viewNameConflict(snap, 'sqlite', null, 'Countries', 'CustomerOrderTotals')).toEqual({ name: 'Countries', type: 'table' });
  });

  it('no name or no catalog yet: nothing to check', () => {
    expect(viewNameConflict(snap, 'sqlite', null, '  ', null)).toBeNull();
    expect(viewNameConflict(null, 'sqlite', null, 'Countries', null)).toBeNull();
  });
});

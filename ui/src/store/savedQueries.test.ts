// Saved queries store against the mock engine (mocks/savedQueries.ts): load once per connection, create / rename /
// duplicate / delete keep the list in step, duplicate names are refused, and the scope helpers.
import { beforeEach, describe, expect, it } from 'vitest';
import { isDuplicateNameError, type SavedQuery } from '../api/savedQueries';
import { installMockEngine } from '../test/mockServer';
import { findSavedQuery, freeQueryName, nameTaken, queriesIn, sameScope, scopeLabel, useSavedQueries } from './savedQueries';

const mock = installMockEngine({ frameDelay: 0 });

const q = (name: string, database: string | null, schema: string | null, id = name): SavedQuery => ({
  id, connectionId: 'c1', database, schema, name, sql: '', description: null, createdAt: '', updatedAt: '',
});

describe('saved queries store', () => {
  beforeEach(() => {
    mock.reset();
    useSavedQueries.setState({ byConn: {} });
  });

  it('loads a connection once (ensure), sorted by name', async () => {
    await Promise.all([useSavedQueries.getState().ensure('c_shop'), useSavedQueries.getState().ensure('c_shop')]);
    await useSavedQueries.getState().ensure('c_shop');
    expect(mock.hits('/connections/c_shop/queries')).toHaveLength(1);
    const s = useSavedQueries.getState().byConn.c_shop!;
    expect(s.status).toBe('ready');
    expect(s.items.map((x) => x.name)).toEqual(['Low stock', 'Orders this week', 'Top customers']);
    await useSavedQueries.getState().load('c_shop');
    expect(mock.hits('/connections/c_shop/queries')).toHaveLength(2);
  });

  it('create, update, duplicate and remove keep the list in step', async () => {
    const st = useSavedQueries.getState();
    await st.ensure('c_shop');
    const created = await st.create('c_shop', { database: 'main', schema: 'main', name: 'Big orders', sql: 'SELECT 1', description: 'd' });
    expect(created.id).toMatch(/^q_/);
    expect(findSavedQuery(created.id, 'c_shop')?.name).toBe('Big orders');

    const renamed = await useSavedQueries.getState().update('c_shop', created.id, { name: 'Large orders', sql: 'SELECT 2' });
    expect(renamed.sql).toBe('SELECT 2');
    expect(useSavedQueries.getState().byConn.c_shop!.items.filter((x) => x.id === created.id).map((x) => x.name)).toEqual(['Large orders']);

    const copy = await useSavedQueries.getState().duplicate('c_shop', created.id);
    expect(copy.name).toBe('Large orders (copy)');
    expect(useSavedQueries.getState().byConn.c_shop!.items).toHaveLength(5);

    await useSavedQueries.getState().remove('c_shop', created.id);
    expect(findSavedQuery(created.id)).toBeUndefined();
    expect(useSavedQueries.getState().byConn.c_shop!.items).toHaveLength(4);
  });

  it('refuses a name already used in the schema (any case) with a VALIDATION error on name', async () => {
    const e = await useSavedQueries.getState().create('c_shop', { database: 'main', schema: 'main', name: 'top CUSTOMERS', sql: '' }).catch((x: unknown) => x);
    expect(isDuplicateNameError(e)).toBe(true);
    // the same name in another schema is fine
    await expect(useSavedQueries.getState().create('c_shop', { database: 'main', schema: 'temp', name: 'Top customers', sql: '' })).resolves.toBeTruthy();
  });

  it('records a failed load as an error (no retry by ensure)', async () => {
    await useSavedQueries.getState().ensure('c_missing');
    expect(useSavedQueries.getState().byConn.c_missing?.status).toBe('error');
    await useSavedQueries.getState().ensure('c_missing');
    expect(mock.hits('/connections/c_missing/queries')).toHaveLength(1);
    useSavedQueries.getState().forget('c_missing');
    expect(useSavedQueries.getState().byConn.c_missing).toBeUndefined();
  });
});

describe('scope helpers', () => {
  const items = [q('A', 'Shop', 'dbo'), q('b', 'Shop', 'sales'), q('C', null, 'SHOP'), q('D', 'Staging', 'dbo')];

  it('queriesIn filters by database and schema (null schema = every schema of the database)', () => {
    expect(queriesIn(items, 'Shop', 'dbo').map((x) => x.name)).toEqual(['A']);
    expect(queriesIn(items, 'Shop', null).map((x) => x.name)).toEqual(['A', 'b']);
    expect(queriesIn(items, null, 'SHOP').map((x) => x.name)).toEqual(['C']);
    expect(queriesIn(undefined, 'Shop', 'dbo')).toEqual([]);
  });

  it('names: taken ignoring case, free names, labels', () => {
    expect(nameTaken(items, { database: 'Shop', schema: 'dbo' }, ' a ')).toBe(true);
    expect(nameTaken(items, { database: 'Shop', schema: 'dbo' }, 'a', 'A')).toBe(false); // its own name
    expect(nameTaken(items, { database: 'Shop', schema: 'sales' }, 'a')).toBe(false);
    expect(freeQueryName([q('Query 1', 'Shop', 'dbo')], { database: 'Shop', schema: 'dbo' })).toBe('Query 2');
    expect(freeQueryName(items, { database: 'Shop', schema: 'dbo' }, 'Report')).toBe('Report');
    expect(freeQueryName(items, { database: 'Shop', schema: 'dbo' }, 'a')).toBe('a 2');
    expect(scopeLabel({ database: 'Shop', schema: 'dbo' })).toBe('Shop.dbo');
    expect(scopeLabel({ database: 'main', schema: 'main' })).toBe('main');
    expect(scopeLabel({ database: null, schema: 'SHOP' })).toBe('SHOP');
    expect(sameScope({ database: null, schema: 'x' }, { database: '', schema: 'x' })).toBe(true);
  });
});

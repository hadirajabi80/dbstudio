import { describe, expect, it } from 'vitest';
import type { SearchErrorItem, SearchHitItem } from '../../api/types.search';
import {
  buildRequest, dataAllowed, DEFAULT_OPTIONS, flattenGroups, groupHits, keyLabel, matchedText, scopeFromTarget, scopeLabel, segments, totals,
  type SearchScope,
} from './model';

const relational = (cid: string) => cid !== 'c_redis';

function hit(p: Partial<SearchHitItem> & Pick<SearchHitItem, 'match' | 'text'>): SearchHitItem {
  return {
    kind: 'hit', connectionId: 'c1', database: 'Shop', schema: 'dbo', object: { name: 'Customers', type: 'table' }, ranges: [[0, 4]],
    column: null, dataType: null, line: null, key: null, more: 0, ...p,
  };
}

describe('scope from the explorer selection', () => {
  it('connection, database, schema, type folder and table nodes', () => {
    expect(scopeFromTarget({ kind: 'connection', connectionId: 'c1' }, relational)).toEqual({ scope: { kind: 'connection', connectionId: 'c1' } });
    expect(scopeFromTarget({ kind: 'container', connectionId: 'c1', database: 'Shop', schema: null }, relational))
      .toEqual({ scope: { kind: 'database', connectionId: 'c1', database: 'Shop' } });
    expect(scopeFromTarget({ kind: 'container', connectionId: 'c1', database: 'Shop', schema: 'dbo' }, relational))
      .toEqual({ scope: { kind: 'schema', connectionId: 'c1', database: 'Shop', schema: 'dbo' } });
    // A "Procedures" folder: its schema and a type filter.
    expect(scopeFromTarget({ kind: 'container', connectionId: 'c1', database: null, schema: 'SHOP', objectType: 'proc' }, relational))
      .toEqual({ scope: { kind: 'schema', connectionId: 'c1', database: null, schema: 'SHOP' }, types: ['procs'] });
    expect(scopeFromTarget({ kind: 'object', connectionId: 'c1', database: 'Shop', ref: { database: 'Shop', schema: 'dbo', name: 'Orders', type: 'table' } }, relational))
      .toEqual({ scope: { kind: 'objects', connectionId: 'c1', database: 'Shop', objects: [{ schema: 'dbo', name: 'Orders', type: 'table' }] } });
  });

  it('several selected objects, and nodes that cannot be searched', () => {
    const multi = scopeFromTarget({
      kind: 'object', connectionId: 'c1', database: null, ref: { database: null, schema: 'main', name: 'a', type: 'table' },
      refs: [{ database: null, schema: 'main', name: 'a', type: 'table' }, { database: null, schema: 'main', name: 'v', type: 'view' }],
    }, relational);
    expect(multi?.scope.kind === 'objects' && multi.scope.objects.map((o) => o.name)).toEqual(['a', 'v']);
    expect(scopeFromTarget({ kind: 'connection', connectionId: 'c_redis' }, relational)).toBeNull();
    expect(scopeFromTarget({ kind: 'source', connectionId: 'c1', providerId: 'redis', nodeType: 'key', path: ['0'] }, relational)).toBeNull();
    expect(scopeFromTarget({ kind: 'tab', tabId: 't1' }, relational)).toBeNull();
    expect(scopeFromTarget(null, relational)).toBeNull();
  });
});

describe('request', () => {
  const schema: SearchScope = { kind: 'schema', connectionId: 'c1', database: 'Shop', schema: 'dbo' };

  it('all connections = the connected ones; types expand to object types', () => {
    const r = buildRequest({ kind: 'all' }, { ...DEFAULT_OPTIONS, term: 'cust', types: ['procs', 'views'] }, ['c1', 'c2']);
    expect(r).toMatchObject({
      term: 'cust', targets: [{ connectionId: 'c1' }, { connectionId: 'c2' }], types: ['proc', 'package', 'view', 'mview'],
      in: { names: true, columns: true, code: true, data: false },
    });
    expect(buildRequest({ kind: 'all' }, { ...DEFAULT_OPTIONS, term: 'x' }, [])).toEqual({ error: expect.stringContaining('No connection is connected') });
    expect(buildRequest(schema, { ...DEFAULT_OPTIONS, term: '  ' }, [])).toEqual({ error: expect.any(String) });
  });

  it('data only in a schema or chosen objects, with a clamped row limit', () => {
    expect(dataAllowed(schema)).toBe(true);
    expect(dataAllowed({ kind: 'connection', connectionId: 'c1' })).toBe(false);
    const r = buildRequest(schema, { ...DEFAULT_OPTIONS, term: 'x', data: true, rowLimit: 99999 }, []);
    expect(r).toMatchObject({ in: { data: true }, dataRowLimit: 1000, targets: [{ connectionId: 'c1', database: 'Shop', schema: 'dbo' }] });
    const db = buildRequest({ kind: 'database', connectionId: 'c1', database: 'Shop' }, { ...DEFAULT_OPTIONS, term: 'x', data: true }, []);
    expect(db).toMatchObject({ in: { data: false } });
    const nothing = buildRequest({ kind: 'database', connectionId: 'c1', database: 'Shop' }, { ...DEFAULT_OPTIONS, term: 'x', names: false, columns: false, code: false, data: true }, []);
    expect(nothing).toEqual({ error: 'Choose what to search in.' });
    const objects = buildRequest({ kind: 'objects', connectionId: 'c1', database: null, objects: [{ schema: 'main', name: 't', type: 'table' }] }, { ...DEFAULT_OPTIONS, term: 'x' }, []);
    expect(objects).toMatchObject({ targets: [{ connectionId: 'c1', database: null, objects: [{ schema: 'main', name: 't', type: 'table' }] }] });
  });

  it('labels', () => {
    const name = (c: string) => (c === 'c1' ? 'Prod' : c);
    expect(scopeLabel({ kind: 'all' }, name)).toBe('All connections');
    expect(scopeLabel(schema, name)).toBe('Prod › Shop › dbo');
    expect(scopeLabel({ ...schema, database: 'main' }, name, () => false)).toBe('Prod › dbo');
    expect(scopeLabel({ kind: 'objects', connectionId: 'c1', database: null, objects: [{ schema: 'dbo', name: 'T', type: 'table' }] }, name)).toBe('Prod › dbo.T');
    expect(scopeLabel({ kind: 'objects', connectionId: 'c1', database: null, objects: [{ schema: 'dbo', name: 'T', type: 'table' }, { schema: 'dbo', name: 'U', type: 'table' }] }, name))
      .toBe('Prod › 2 objects in dbo');
  });
});

describe('results', () => {
  const hits: SearchHitItem[] = [
    hit({ match: 'code', text: 'SELECT * FROM Customers', ranges: [[14, 4]], object: { name: 'GetCustomer', type: 'proc' }, line: 12 }),
    hit({ match: 'name', text: 'Customers' }),
    hit({ match: 'data', text: 'Cust Ltd', column: 'Name', key: [{ column: 'Id', value: 7 }] }),
    hit({ match: 'column', text: 'CustomerType', column: 'CustomerType', dataType: 'int' }),
    hit({ match: 'code', text: 'WHERE c.Cust = 1', ranges: [[8, 4]], object: { name: 'GetCustomer', type: 'proc' }, line: 3 }),
    hit({ match: 'code', text: '', ranges: [], object: { name: 'GetCustomer', type: 'proc' }, line: null, more: 5 }),
    hit({ connectionId: 'c0', database: null, schema: 'main', match: 'name', text: 'customers' }),
  ];
  const errors: SearchErrorItem[] = [{ kind: 'error', connectionId: 'c1', database: 'Shop', schema: 'secret', message: 'denied', table: null, notice: false }];
  const groups = groupHits(hits, errors, { nameOf: (c) => (c === 'c0' ? 'Alpha' : 'Beta') });

  it('groups connection › schema › object, sorted, with counts per kind', () => {
    expect(groups.map((g) => g.connectionId)).toEqual(['c0', 'c1']); // by connection name
    const beta = groups[1];
    expect(beta.errors).toHaveLength(1);
    expect(beta.schemas.map((s) => s.label)).toEqual(['Shop › dbo']);
    const [customers, proc] = beta.schemas[0].objects;
    expect(customers.name).toBe('Customers');
    expect(customers.nameHit?.text).toBe('Customers');
    expect(customers.hits.map((h) => h.match)).toEqual(['column', 'data']);
    expect(customers.counts).toEqual({ column: 1, code: 0, data: 1 });
    expect(proc.hits.map((h) => h.line)).toEqual([3, 12, null]); // by line, the "more" summary last
    expect(proc.counts.code).toBe(7); // 2 lines + 5 more
    expect(totals(groups)).toEqual({ matches: 11, objects: 3, connections: 2 });
    expect(groups[0].schemas[0].label).toBe('main');
  });

  it('flattens with collapsed groups', () => {
    const all = flattenGroups(groups, new Set());
    expect(all.map((r) => r.kind)).toEqual(['conn', 'schema', 'object', 'conn', 'error', 'schema', 'object', 'hit', 'hit', 'object', 'hit', 'hit', 'hit']);
    expect(all[2]).toMatchObject({ kind: 'object', expandable: false, expanded: false }); // a name match only: no children
    const collapsed = flattenGroups(groups, new Set([groups[0].key, groups[1].schemas[0].objects[1].key]));
    expect(collapsed.map((r) => r.kind)).toEqual(['conn', 'conn', 'error', 'schema', 'object', 'hit', 'hit', 'object']);
    const child = all[7];
    expect(child.kind === 'hit' && child.parent).toBe(groups[1].schemas[0].objects[0].key);
  });

  it('highlight segments, matched text, key labels', () => {
    expect(segments('SELECT x FROM t', [[7, 1], [14, 1]])).toEqual([
      { text: 'SELECT ', hit: false }, { text: 'x', hit: true }, { text: ' FROM ', hit: false }, { text: 't', hit: true },
    ]);
    expect(segments('abc', null)).toEqual([{ text: 'abc', hit: false }]);
    expect(segments('abc', [[1, 1], [1, 2], [9, 1]])).toEqual([{ text: 'a', hit: false }, { text: 'b', hit: true }, { text: 'c', hit: false }]);
    expect(matchedText({ text: 'Ann Smith', ranges: [[4, 5]] })).toBe('Smith');
    expect(keyLabel([{ column: 'Id', value: 7 }, { column: 'Line', value: null }])).toBe('Id = 7, Line = NULL');
  });
});

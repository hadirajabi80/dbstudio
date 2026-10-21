// Query-bar / pipeline completion: caret context and suggestions (docs/PLAN-M2.md 6.3 "autocomplete fields,
// operators, values").
import { describe, expect, it } from 'vitest';
import type { MongoFieldPath } from '../../api/types';
import { caretContext, fieldPathOf, stageNames, suggest, type CompletionMode } from '../complete';

const FIELDS: MongoFieldPath[] = [
  { path: '_id', types: ['objectId'] },
  { path: 'status', types: ['string'], values: ['"paid"', '"pending"', '"shipped"'] },
  { path: 'total', types: ['double'] },
  { path: 'paid', types: ['bool'] },
  { path: 'createdAt', types: ['date'] },
  { path: 'address', types: ['object'] },
  { path: 'address.city', types: ['string'], values: ['"Berlin"', '"Paris"'] },
  { path: 'items', types: ['array'] },
  { path: 'items.sku', types: ['string'] },
];

/** `|` marks the caret. */
function ctx(src: string) {
  const i = src.indexOf('|');
  return caretContext(src.replace('|', ''), i);
}
function labels(src: string, mode: CompletionMode = 'filter') {
  return suggest(mode, ctx(src), FIELDS).map((s) => s.label);
}

describe('caretContext', () => {
  it('finds a key position at the top level', () => {
    expect(ctx('{ |')).toMatchObject({ where: 'key', keys: [], prefix: '' });
    expect(ctx('{ sta|')).toMatchObject({ where: 'key', keys: [], prefix: 'sta' });
    expect(ctx('{ a: 1, |')).toMatchObject({ where: 'key', keys: [] });
  });
  it('treats bare text like the inside of a document', () => {
    expect(ctx('sta|')).toMatchObject({ where: 'key', prefix: 'sta' });
    expect(ctx('|')).toMatchObject({ where: 'key' });
  });
  it('finds value positions with the key chain', () => {
    expect(ctx('{ status: |')).toMatchObject({ where: 'value', keys: ['status'] });
    expect(ctx('{ total: { $gt: |')).toMatchObject({ where: 'value', keys: ['total', '$gt'] });
    expect(ctx('{ status: { $in: ["paid", |')).toMatchObject({ where: 'value', keys: ['status', '$in'] });
  });
  it('knows operator-key positions', () => {
    expect(ctx('{ total: { |')).toMatchObject({ where: 'key', keys: ['total'] });
    expect(ctx('{ $or: [ { |')).toMatchObject({ where: 'key', keys: ['$or'] });
  });
  it('detects open strings', () => {
    expect(ctx('{ status: "pa|')).toMatchObject({ where: 'value', prefix: 'pa', quote: '"' });
    expect(ctx("{ 'add|")).toMatchObject({ where: 'key', prefix: 'add', quote: "'" });
  });
  it('is nowhere after a complete value', () => {
    expect(ctx('{ a: 1 |').where).toBe('none');
    expect(ctx('{ a: true |').where).toBe('none');
  });
  it('offers nothing inside a helper call', () => {
    expect(ctx('{ _id: ObjectId(|').where).toBe('none');
  });
  it('builds field paths from non-operator keys', () => {
    expect(fieldPathOf(['address', 'city'])).toBe('address.city');
    expect(fieldPathOf(['items', '$elemMatch', 'sku', '$eq'])).toBe('items.sku');
  });
});

describe('suggest (filter)', () => {
  it('offers fields and top-level operators at the top', () => {
    const l = labels('{ |');
    expect(l).toContain('status');
    expect(l.indexOf('status')).toBeLessThan(l.indexOf('$or'));
    expect(l).toContain('$or');
    expect(l).toContain('items.sku');
  });
  it('filters by the prefix', () => {
    expect(labels('{ sta|')).toEqual(['status']);
  });
  it('offers query operators inside a field document', () => {
    const l = labels('{ total: { |');
    expect(l).toContain('$gt');
    expect(l).toContain('$exists');
  });
  it('offers sampled values and helpers for a field', () => {
    const l = labels('{ status: |');
    expect(l.slice(0, 3)).toEqual(['"paid"', '"pending"', '"shipped"']);
    expect(l).toContain('ISODate');
  });
  it('offers values inside $in and in open strings', () => {
    expect(labels('{ status: { $in: [|')).toContain('"paid"');
    expect(labels('{ status: "pa|')).toEqual(['paid']);
    expect(labels('{ address.city: |')).toContain('"Berlin"');
  });
  it('offers $type aliases and $exists booleans', () => {
    expect(labels('{ a: { $type: |')).toContain('"objectId"');
    expect(labels('{ a: { $exists: |')).toEqual(['false', 'true']);
  });
  it('ranks date helpers first for date fields', () => {
    const s = suggest('filter', ctx('{ createdAt: { $gte: |'), FIELDS);
    expect(s[0].label).toBe('ISODate');
  });
  it('inserts operators as snippets with escaped $', () => {
    const s = suggest('filter', ctx('{ total: { $g|'), FIELDS).find((x) => x.label === '$gt');
    expect(s).toMatchObject({ insert: '\\$gt: ${1}', snippet: true });
  });
  it('quotes dotted field names outside quotes', () => {
    const s = suggest('filter', ctx('{ items|'), FIELDS).find((x) => x.label === 'items.sku');
    expect(s?.insert).toBe('"items.sku"');
  });
  it('offers sub-fields inside $elemMatch', () => {
    expect(labels('{ items: { $elemMatch: { |')).toContain('sku');
  });
  it('offers expression operators inside $expr', () => {
    expect(labels('{ $expr: { |')).toContain('$add');
  });
});

describe('suggest (projection, sort, stages)', () => {
  it('projection: fields, then 1/0', () => {
    expect(labels('{ |', 'projection')).toContain('status');
    expect(labels('{ status: |', 'projection').slice(0, 2)).toEqual(['1', '0']);
  });
  it('sort: fields, then 1/-1', () => {
    expect(labels('{ createdAt: |', 'sort')).toEqual(['1', '-1']);
  });
  it('$group: _id, accumulators and field references', () => {
    expect(labels('{ |', 'stage:$group')).toEqual(['_id']);
    expect(labels('{ _id: "$status", n: { |', 'stage:$group')).toContain('$sum');
    expect(labels('{ _id: "$st|', 'stage:$group')).toEqual(['$status']);
  });
  it('$match behaves like the filter', () => {
    expect(labels('{ |', 'stage:$match')).toContain('$or');
  });
  it('$lookup: option keys and local fields', () => {
    expect(labels('{ |', 'stage:$lookup')).toContain('foreignField');
    expect(labels('{ localField: |', 'stage:$lookup')).toContain('status');
  });
  it('$unwind at the root offers field references', () => {
    expect(labels('"$it|', 'stage:$unwind')).toContain('$items');
  });
  it('lists stages and flags write stages', () => {
    const s = stageNames();
    expect(s.find((x) => x.name === '$out')?.write).toBe(true);
    expect(s.find((x) => x.name === '$match')?.write).toBe(false);
  });
});

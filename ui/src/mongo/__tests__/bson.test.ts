// EJSON ⇄ BsonValue ⇄ shell text round trips (docs/PLAN-M2.md 6.3, QA "EJSON types round-trip edits").
import { describe, expect, it } from 'vitest';
import {
  B, base64Length, bsonEquals, formatDouble, fromEjson, getPath, hasTrunc, numberValue, objectIdTime, parseEjson, parseEjsonDoc,
  previewText, scalarShell, setField, toEjsonJson, toEjsonText, toShell, uuidOf, withoutField, type BsonValue,
} from '../bson';
import { parseShell } from '../shellJson';

const CANONICAL = JSON.stringify({
  _id: { $oid: '66f1a2b3c4d5e6f708192a3b' },
  name: 'Alice',
  qty: { $numberInt: '3' },
  big: { $numberLong: '9007199254740993' },
  price: { $numberDecimal: '19.99' },
  ratio: { $numberDouble: '5.0' },
  half: { $numberDouble: '0.5' },
  nan: { $numberDouble: 'NaN' },
  at: { $date: { $numberLong: '1704067200000' } },
  bin: { $binary: { base64: 'AQID', subType: '00' } },
  uid: { $binary: { base64: 'EjRWeJASNJh2VDIQEjRWeA==', subType: '04' } },
  re: { $regularExpression: { pattern: 'a/b', options: 'i' } },
  ts: { $timestamp: { t: 1700000000, i: 2 } },
  lo: { $minKey: 1 },
  hi: { $maxKey: 1 },
  tags: ['a', { $numberInt: '1' }],
  nested: { a: { b: null } },
});

describe('fromEjson (canonical)', () => {
  const doc = parseEjsonDoc(CANONICAL);
  const f = (k: string) => getPath(doc, k)!;

  it('keeps every BSON type', () => {
    expect(f('_id')).toEqual({ t: 'objectId', v: '66f1a2b3c4d5e6f708192a3b' });
    expect(f('qty')).toEqual({ t: 'int', v: 3 });
    expect(f('big')).toEqual({ t: 'long', v: '9007199254740993' });
    expect(f('price')).toEqual({ t: 'decimal', v: '19.99' });
    expect(f('ratio')).toEqual({ t: 'double', v: 5 });
    expect(f('at')).toEqual({ t: 'date', v: 1704067200000 });
    expect(f('bin')).toEqual({ t: 'binData', v: 'AQID', sub: '00' });
    expect(f('re')).toEqual({ t: 'regex', pattern: 'a/b', flags: 'i' });
    expect(f('ts')).toEqual({ t: 'timestamp', ts: 1700000000, inc: 2 });
    expect(f('lo').t).toBe('minKey');
    expect(f('hi').t).toBe('maxKey');
    expect(Number.isNaN((f('nan') as { v: number }).v)).toBe(true);
    expect(getPath(doc, 'tags.1')).toEqual({ t: 'int', v: 1 });
    expect(getPath(doc, 'nested.a.b')).toEqual({ t: 'null' });
  });

  it('keeps key order', () => {
    expect(doc.v.map(([k]) => k).slice(0, 4)).toEqual(['_id', 'name', 'qty', 'big']);
  });

  it('round-trips to canonical EJSON', () => {
    expect(toEjsonJson(doc)).toEqual(JSON.parse(CANONICAL));
  });

  it('round-trips through shell text', () => {
    const shell = toShell(doc);
    const back = parseShell(shell);
    expect(bsonEquals(back, doc)).toBe(true);
  });
});

describe('fromEjson (relaxed and legacy)', () => {
  it('reads relaxed numbers and ISO dates', () => {
    expect(fromEjson(5)).toEqual({ t: 'int', v: 5 });
    expect(fromEjson(5.5)).toEqual({ t: 'double', v: 5.5 });
    expect(fromEjson(2 ** 40)).toEqual({ t: 'long', v: String(2 ** 40) });
    expect(fromEjson({ $date: '2024-01-01T00:00:00Z' })).toEqual({ t: 'date', v: 1704067200000 });
  });
  it('reads $uuid and legacy $binary', () => {
    expect(fromEjson({ $uuid: '12345678-9012-3456-7890-123456789012' })).toMatchObject({ t: 'binData', sub: '04' });
    expect(fromEjson({ $binary: 'AQID', $type: '0' })).toEqual({ t: 'binData', v: 'AQID', sub: '00' });
  });
  it('reads $trunc markers', () => {
    const v = fromEjson({ $trunc: 'abc', len: { $numberInt: '40000' } });
    expect(v).toEqual({ t: 'trunc', preview: 'abc', len: 40000, binary: false, sub: undefined });
    expect(hasTrunc(B.doc([['a', B.arr([v])]]))).toBe(true);
  });
  it('does not treat query operators as wrappers', () => {
    expect(fromEjson({ $regex: 'a', $options: 'i' }).t).toBe('object');
  });
  it('rejects broken JSON', () => {
    expect(() => parseEjson('{')).toThrow(/Invalid Extended JSON/);
  });
});

describe('shell text', () => {
  it('prints doubles with a decimal point', () => {
    expect(formatDouble(5)).toBe('5.0');
    expect(formatDouble(-0)).toBe('-0.0');
    expect(formatDouble(1e21)).toBe('1e+21');
    expect(formatDouble(Infinity)).toBe('Infinity');
  });
  it('prints helpers for typed values', () => {
    expect(scalarShell(B.oid('66F1A2B3C4D5E6F708192A3B'))).toBe('ObjectId("66f1a2b3c4d5e6f708192a3b")');
    expect(scalarShell(B.long('12'))).toBe('NumberLong("12")');
    expect(scalarShell(B.decimal('1.50'))).toBe('NumberDecimal("1.50")');
    expect(scalarShell(B.date(0))).toBe('ISODate("1970-01-01T00:00:00.000Z")');
    expect(scalarShell({ t: 'regex', pattern: 'a/b', flags: 'i' })).toBe('/a\\/b/i');
    expect(scalarShell(B.bin('AQID', '00'))).toBe('BinData(0, "AQID")');
    expect(scalarShell({ t: 'timestamp', ts: 1, inc: 2 })).toBe('Timestamp(1, 2)');
  });
  it('prints UUIDs as UUID()', () => {
    const u = fromEjson({ $uuid: '12345678-9012-3456-7890-123456789012' });
    expect(uuidOf(u)).toBe('12345678-9012-3456-7890-123456789012');
    expect(scalarShell(u)).toBe('UUID("12345678-9012-3456-7890-123456789012")');
  });
  it('quotes keys that are not identifiers', () => {
    expect(toShell(B.doc([['a.b', B.int(1)], ['ok', B.int(2)], ['with space', B.int(3)]]), { inline: 80 })).toBe('{ "a.b": 1, ok: 2, "with space": 3 }');
  });
  it('pretty prints nested documents', () => {
    expect(toShell(B.doc([['a', B.doc([['b', B.arr([B.int(1), B.int(2)])]])]]))).toBe('{\n  a: {\n    b: [\n      1,\n      2\n    ]\n  }\n}');
  });
  it('prints dates outside 0–9999 with Date(ms)', () => {
    expect(scalarShell(B.date(-62198755200001))).toBe('Date(-62198755200001)');
  });
});

describe('helpers', () => {
  it('picks int32/int64/double like mongosh', () => {
    expect(numberValue(1)).toEqual({ t: 'int', v: 1 });
    expect(numberValue(2 ** 31)).toEqual({ t: 'long', v: '2147483648' });
    expect(numberValue(1.5)).toEqual({ t: 'double', v: 1.5 });
  });
  it('edits fields immutably', () => {
    const d = B.doc([['a', B.int(1)]]);
    const d2 = setField(d, 'b', B.int(2));
    expect(d.v.length).toBe(1);
    expect(d2.v.map(([k]) => k)).toEqual(['a', 'b']);
    expect(withoutField(d2, 'a').v.map(([k]) => k)).toEqual(['b']);
  });
  it('reads the ObjectId timestamp', () => {
    expect(objectIdTime('66f1a2b3c4d5e6f708192a3b')?.toISOString()).toBe('2024-09-23T17:17:39.000Z');
  });
  it('previews values', () => {
    expect(previewText(B.arr([B.int(1), B.int(2)]))).toBe('[2]');
    expect(previewText(B.bin('AQID'))).toBe('<binary 3 bytes>');
    expect(base64Length('AQID')).toBe(3);
  });
  it('writes relaxed EJSON text', () => {
    const v: BsonValue = B.doc([['n', B.int(1)], ['d', B.date(0)], ['l', B.long('5')]]);
    expect(JSON.parse(toEjsonText(v, 'relaxed'))).toEqual({ n: 1, d: { $date: '1970-01-01T00:00:00.000Z' }, l: 5 });
  });
});

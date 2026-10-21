// Shell JSON parser (mirror of the engine's ShellJson.cs): helpers, lenient JSON, error positions.
import { describe, expect, it } from 'vitest';
import { getPath, type BsonValue } from '../bson';
import { checkShell, isEmptyDocText, parseIsoDate, parseShell, parseShellArray, parseShellDoc, ShellJsonError, tokenize } from '../shellJson';

const at = (text: string, path: string): BsonValue | undefined => getPath(parseShell(text), path);

describe('parseShell', () => {
  it('parses strict JSON', () => {
    expect(parseShell('{"a": 1, "b": "x", "c": [true, null]}')).toEqual({
      t: 'object', v: [['a', { t: 'int', v: 1 }], ['b', { t: 'string', v: 'x' }], ['c', { t: 'array', v: [{ t: 'bool', v: true }, { t: 'null' }] }]],
    });
  });
  it('treats empty text as {}', () => {
    expect(parseShell('  ')).toEqual({ t: 'object', v: [] });
    expect(isEmptyDocText('')).toBe(true);
    expect(isEmptyDocText('{ }')).toBe(true);
    expect(isEmptyDocText('{a:1}')).toBe(false);
  });
  it('accepts unquoted keys, $ operators and dotted paths', () => {
    const v = parseShell('{ status: "paid", total: { $gt: 100 }, items.sku: "A1" }');
    expect(getPath(v, 'total')).toEqual({ t: 'object', v: [['$gt', { t: 'int', v: 100 }]] });
    expect(v.t === 'object' && v.v[2][0]).toBe('items.sku');
  });
  it('accepts single quotes, comments and trailing commas', () => {
    const v = parseShell("{\n  // the customer\n  name: 'O\\'Brien', /* block */\n  tags: ['a', 'b',],\n}");
    expect(getPath(v, 'name')).toEqual({ t: 'string', v: "O'Brien" });
    expect(getPath(v, 'tags')).toEqual({ t: 'array', v: [{ t: 'string', v: 'a' }, { t: 'string', v: 'b' }] });
  });
  it('picks number types', () => {
    expect(at('{a: 1}', 'a')).toEqual({ t: 'int', v: 1 });
    expect(at('{a: 1.0}', 'a')).toEqual({ t: 'double', v: 1 });
    expect(at('{a: 2e3}', 'a')).toEqual({ t: 'double', v: 2000 });
    expect(at('{a: 3000000000}', 'a')).toEqual({ t: 'long', v: '3000000000' });
    expect(at('{a: 9223372036854775807}', 'a')).toEqual({ t: 'long', v: '9223372036854775807' });
    expect(at('{a: -5}', 'a')).toEqual({ t: 'int', v: -5 });
    expect(at('{a: 0x10}', 'a')).toEqual({ t: 'int', v: 16 });
  });
  it('parses NaN, Infinity and undefined', () => {
    expect(at('{a: -Infinity}', 'a')).toEqual({ t: 'double', v: -Infinity });
    expect(Number.isNaN((at('{a: NaN}', 'a') as { v: number }).v)).toBe(true);
    expect(at('{a: undefined}', 'a')).toEqual({ t: 'undefined' });
  });
  it('parses ObjectId, ISODate and Date', () => {
    expect(at('{_id: ObjectId("66f1a2b3c4d5e6f708192a3b")}', '_id')).toEqual({ t: 'objectId', v: '66f1a2b3c4d5e6f708192a3b' });
    expect(at('{d: ISODate("2024-01-01T00:00:00Z")}', 'd')).toEqual({ t: 'date', v: 1704067200000 });
    expect(at('{d: new Date("2024-01-01")}', 'd')).toEqual({ t: 'date', v: 1704067200000 });
    expect(at('{d: Date(0)}', 'd')).toEqual({ t: 'date', v: 0 });
    expect(at('{d: ISODate("2024-01-01T10:00:00+02:00")}', 'd')).toEqual({ t: 'date', v: Date.UTC(2024, 0, 1, 8) });
    expect(at('{_id: ObjectId()}', '_id')?.t).toBe('objectId');
  });
  it('parses number helpers', () => {
    expect(at('{a: NumberLong("123")}', 'a')).toEqual({ t: 'long', v: '123' });
    expect(at('{a: Long(5)}', 'a')).toEqual({ t: 'long', v: '5' });
    expect(at('{a: NumberInt(7)}', 'a')).toEqual({ t: 'int', v: 7 });
    expect(at('{a: NumberDecimal("1.10")}', 'a')).toEqual({ t: 'decimal', v: '1.10' });
    expect(at('{a: Decimal128("2")}', 'a')).toEqual({ t: 'decimal', v: '2' });
    expect(at('{a: Double(3)}', 'a')).toEqual({ t: 'double', v: 3 });
  });
  it('parses binary helpers', () => {
    expect(at('{b: BinData(0, "AQID")}', 'b')).toEqual({ t: 'binData', v: 'AQID', sub: '00' });
    expect(at('{b: HexData(0, "010203")}', 'b')).toEqual({ t: 'binData', v: 'AQID', sub: '00' });
    expect(at('{b: UUID("12345678-9012-3456-7890-123456789012")}', 'b')).toMatchObject({ t: 'binData', sub: '04' });
  });
  it('parses regex literals and RegExp()', () => {
    expect(at('{name: /^al/i}', 'name')).toEqual({ t: 'regex', pattern: '^al', flags: 'i' });
    expect(at('{p: /a\\/b/}', 'p')).toEqual({ t: 'regex', pattern: 'a/b', flags: '' });
    expect(at('{p: RegExp("x", "mi")}', 'p')).toEqual({ t: 'regex', pattern: 'x', flags: 'im' });
    expect(at('{p: [/a/, /b/]}', 'p.1')).toEqual({ t: 'regex', pattern: 'b', flags: '' });
  });
  it('parses Timestamp, MinKey, MaxKey, Code, DBRef', () => {
    expect(at('{t: Timestamp(1, 2)}', 't')).toEqual({ t: 'timestamp', ts: 1, inc: 2 });
    expect(at('{t: Timestamp({t: 3, i: 4})}', 't')).toEqual({ t: 'timestamp', ts: 3, inc: 4 });
    expect(at('{a: MinKey, b: MaxKey()}', 'a')).toEqual({ t: 'minKey' });
    expect(at('{a: MinKey, b: MaxKey()}', 'b')).toEqual({ t: 'maxKey' });
    expect(at('{c: Code("function(){}")}', 'c')).toEqual({ t: 'javascript', v: 'function(){}' });
    expect(at('{r: DBRef("users", 1)}', 'r.$ref')).toEqual({ t: 'string', v: 'users' });
  });
  it('converts EJSON wrappers', () => {
    expect(at('{a: {"$oid": "66f1a2b3c4d5e6f708192a3b"}}', 'a')).toEqual({ t: 'objectId', v: '66f1a2b3c4d5e6f708192a3b' });
    expect(at('{a: {"$numberLong": "5"}}', 'a')).toEqual({ t: 'long', v: '5' });
    expect(at('{a: {"$date": "2024-01-01T00:00:00Z"}}', 'a')).toEqual({ t: 'date', v: 1704067200000 });
    expect(at('{a: {"$date": {"$numberLong": "0"}}}', 'a')).toEqual({ t: 'date', v: 0 });
  });
  it('keeps operator documents as documents', () => {
    expect(at('{a: {$gt: 1, $lt: 5}}', 'a')?.t).toBe('object');
  });
  it('parses pipelines and bare field lists', () => {
    expect(parseShellArray('[{ $match: {} }, { $limit: 5 }]')).toHaveLength(2);
    expect(parseShellDoc('status: "paid"')).toEqual({ t: 'object', v: [['status', { t: 'string', v: 'paid' }]] });
  });
});

describe('errors', () => {
  const err = (text: string) => {
    try {
      parseShell(text);
    } catch (e) {
      return e as ShellJsonError;
    }
    throw new Error('expected an error');
  };
  it('reports the position of a missing comma', () => {
    const e = err('{ a: 1\n  b: 2 }');
    expect(e).toBeInstanceOf(ShellJsonError);
    expect(e.line).toBe(2);
    expect(e.col).toBe(3);
    expect(e.message).toMatch(/Expected ',' or '}'/);
  });
  it('reports unterminated strings and documents', () => {
    expect(err('{ a: "x').message).toMatch(/Unterminated string/);
    expect(err('{ a: 1').message).toMatch(/text ended/);
  });
  it('reports bad helpers and bare words', () => {
    expect(err('{ a: ObjectId("zz") }').message).toMatch(/24-character hex/);
    expect(err('{ a: paid }').message).toMatch(/strings need quotes/);
    expect(err('{ a: Foo(1) }').message).toMatch(/Unknown function Foo/);
    expect(err('{ a: ISODate("nope") }').message).toMatch(/cannot parse/);
  });
  it('reports trailing text', () => {
    expect(err('{} {}').message).toMatch(/after the value/);
  });
  it('checkShell returns null or the error', () => {
    expect(checkShell('{a: 1}')).toBeNull();
    expect(checkShell('[1]')).toBeInstanceOf(ShellJsonError);
    expect(checkShell('[1]', 'array')).toBeNull();
    expect(checkShell('5', 'value')).toBeNull();
  });
});

describe('tokenize and dates', () => {
  it('flags open strings and keeps comments on request', () => {
    const t = tokenize('{ a: "pa', true);
    expect(t[t.length - 2]).toMatchObject({ kind: 'string', value: 'pa', open: true });
    expect(tokenize('// c\n{}', true)[0].kind).toBe('comment');
  });
  it('parses ISO dates with and without zones', () => {
    expect(parseIsoDate('2024-01-01')).toBe(1704067200000);
    expect(parseIsoDate('2024-01-01T00:00:00')).toBe(1704067200000);
    expect(parseIsoDate('garbage')).toBeNull();
  });
});

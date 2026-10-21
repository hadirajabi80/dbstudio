// Schema analysis → $jsonSchema draft and mixed-type detection (docs/PLAN-M2.md 6.5).
import { describe, expect, it } from 'vitest';
import type { MongoSchemaResult } from '../../api/types';
import { toShell } from '../bson';
import { jsonSchemaFrom, mixedTypeFields, validatorFrom } from '../jsonSchema';

const RESULT: MongoSchemaResult = {
  sampled: 10,
  fields: [
    { path: '_id', types: [{ bsonType: 'objectId', count: 10, pct: 100 }], probability: 1, nested: [], examples: [] },
    { path: 'phone', types: [{ bsonType: 'string', count: 6, pct: 60 }, { bsonType: 'int', count: 3, pct: 30 }, { bsonType: 'null', count: 1, pct: 10 }], probability: 1, nested: [], examples: [] },
    { path: 'nick', types: [{ bsonType: 'string', count: 4, pct: 100 }], probability: 0.4, nested: [], examples: [] },
    {
      path: 'address', types: [{ bsonType: 'object', count: 10, pct: 100 }], probability: 1, examples: [],
      nested: [{ path: 'address.city', types: [{ bsonType: 'string', count: 10, pct: 100 }], probability: 1, nested: [], examples: [] }],
    },
    {
      path: 'items', types: [{ bsonType: 'array', count: 10, pct: 100 }], probability: 1, examples: [],
      nested: [{ path: 'items.qty', types: [{ bsonType: 'int', count: 9, pct: 90 }, { bsonType: 'double', count: 1, pct: 10 }], probability: 1, nested: [], examples: [] }],
    },
  ],
};

describe('jsonSchemaFrom', () => {
  it('builds required, bsonType and nested properties', () => {
    const s = toShell(jsonSchemaFrom(RESULT), { inline: 400 });
    expect(s).toContain('required: ["_id", "phone", "address", "items"]');
    expect(s).toContain('phone: { bsonType: ["string", "int", "null"] }');
    expect(s).toContain('nick: { bsonType: "string" }');
    expect(s).toContain('address: { bsonType: "object", required: ["city"], properties: { city: { bsonType: "string" } } }');
    expect(s).toContain('items: { bsonType: "array", items: { bsonType: "object", required: ["qty"], properties: { qty: { bsonType: ["int", "double"] } } } }');
  });
  it('wraps the schema in $jsonSchema', () => {
    const v = validatorFrom(RESULT);
    expect(v.t === 'object' && v.v[0][0]).toBe('$jsonSchema');
  });
  it('lists mixed-type fields, ignoring null', () => {
    expect(mixedTypeFields(RESULT.fields)).toEqual(['phone', 'items.qty']);
  });
});

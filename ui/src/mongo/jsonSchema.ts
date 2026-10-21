// Schema analysis → `$jsonSchema` validator draft (docs/PLAN-M2.md 6.5 "export JSON Schema", "Generate from schema
// analysis"): bsonType per field from the observed types, `required` for fields present in every sampled document,
// nested `properties` for subdocuments and `items` for arrays of documents.
import type { MongoSchemaField, MongoSchemaResult } from '../api/types';
import { B, type BsonEntry, type BsonValue } from './bson';

/** Server `$type` aliases are also valid `bsonType` names, except `undefined` (deprecated) which is dropped. */
function bsonTypes(f: MongoSchemaField): string[] {
  return [...new Set(f.types.map((t) => t.bsonType).filter((t) => t !== 'undefined'))];
}

function leafName(path: string): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? path : path.slice(i + 1);
}

function fieldSchema(f: MongoSchemaField): BsonValue {
  const types = bsonTypes(f);
  const entries: BsonEntry[] = [];
  entries.push(['bsonType', types.length === 1 ? B.str(types[0]) : B.arr(types.map(B.str))]);
  const docChildren = f.nested ?? [];
  if (docChildren.length) {
    const sub = objectSchema(docChildren);
    if (types.includes('array') && !types.includes('object')) {
      entries.push(['items', sub]);
    } else {
      for (const e of sub.t === 'object' ? sub.v : []) if (e[0] !== 'bsonType') entries.push(e);
    }
  }
  return B.doc(entries);
}

function objectSchema(fields: MongoSchemaField[]): BsonValue {
  const required = fields.filter((f) => f.probability >= 0.9999).map((f) => leafName(f.path));
  const props: BsonEntry[] = fields.map((f) => [leafName(f.path), fieldSchema(f)]);
  const entries: BsonEntry[] = [['bsonType', B.str('object')]];
  if (required.length) entries.push(['required', B.arr(required.map(B.str))]);
  entries.push(['properties', B.doc(props)]);
  return B.doc(entries);
}

/** The `$jsonSchema` body for a schema analysis result. */
export function jsonSchemaFrom(result: MongoSchemaResult): BsonValue {
  return objectSchema(result.fields);
}

/** A complete validator document `{ $jsonSchema: … }`. */
export function validatorFrom(result: MongoSchemaResult): BsonValue {
  return B.doc([['$jsonSchema', jsonSchemaFrom(result)]]);
}

/** Fields whose values have more than one type (ignoring null/missing), depth-first. */
export function mixedTypeFields(fields: readonly MongoSchemaField[]): string[] {
  const out: string[] = [];
  const walk = (fs: readonly MongoSchemaField[]) => {
    for (const f of fs) {
      if (f.types.filter((t) => t.bsonType !== 'null' && t.bsonType !== 'undefined').length > 1) out.push(f.path);
      if (f.nested?.length) walk(f.nested);
    }
  };
  walk(fields);
  return out;
}

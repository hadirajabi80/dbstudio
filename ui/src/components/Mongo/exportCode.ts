// "Export to code" (docs/PLAN-M2.md 6.4): a find query or an aggregation pipeline as mongosh, Node.js driver, C#
// driver (BsonDocument pipeline + PipelineDefinition), Python (pymongo) and Java driver code. Works on parsed
// BsonValue trees so every BSON type is written with the target driver's own constructor.
import { formatDouble, isoDate, toShell, uuidOf, type BsonValue } from '../../mongo/bson';

export type CodeLanguage = 'shell' | 'node' | 'csharp' | 'python' | 'java';

export const CODE_LANGUAGES: { id: CodeLanguage; label: string; monaco: string }[] = [
  { id: 'shell', label: 'mongosh', monaco: 'javascript' },
  { id: 'node', label: 'Node.js', monaco: 'javascript' },
  { id: 'csharp', label: 'C#', monaco: 'csharp' },
  { id: 'python', label: 'Python', monaco: 'python' },
  { id: 'java', label: 'Java', monaco: 'java' },
];

export type ExportInput =
  | { kind: 'aggregate'; db: string; coll: string; pipeline: BsonValue[] }
  | { kind: 'find'; db: string; coll: string; filter: BsonValue; projection?: BsonValue | null; sort?: BsonValue | null; skip?: number; limit?: number; collation?: BsonValue | null };

export interface ExportOptions {
  /** Include imports, client creation and the result loop (default true). */
  boilerplate?: boolean;
  uri?: string;
}

const isEmptyDoc = (v: BsonValue | null | undefined) => !v || (v.t === 'object' && v.v.length === 0);

function ind(level: number, unit = '  '): string {
  return unit.repeat(level);
}

// ---------------------------------------------------------------------------------------------------------------
// value emitters

/** Short containers of short parts stay on one line. */
function fitsInline(parts: string[]): boolean {
  return parts.every((x) => !x.includes('\n')) && parts.join(', ').length <= 60;
}

interface Emitter {
  value(v: BsonValue, level: number): string;
  uses: Set<string>;
}

function jsString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}
function dqString(s: string): string {
  return JSON.stringify(s);
}
function pyString(s: string): string {
  return jsString(s);
}

function jsKey(k: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : jsString(k);
}

function nodeEmitter(): Emitter {
  const uses = new Set<string>();
  const value = (v: BsonValue, level: number): string => {
    switch (v.t) {
      case 'string': return jsString(v.v);
      case 'int': return String(v.v);
      case 'double': {
        if (!Number.isFinite(v.v) || Number.isInteger(v.v)) {
          uses.add('Double');
          return `new Double(${Number.isNaN(v.v) ? 'NaN' : v.v === Infinity ? 'Infinity' : v.v === -Infinity ? '-Infinity' : formatDouble(v.v)})`;
        }
        return String(v.v);
      }
      case 'long': uses.add('Long'); return `Long.fromString(${jsString(v.v)})`;
      case 'decimal': uses.add('Decimal128'); return `Decimal128.fromString(${jsString(v.v)})`;
      case 'bool': return String(v.v);
      case 'null': return 'null';
      case 'undefined': return 'undefined';
      case 'objectId': uses.add('ObjectId'); return `new ObjectId(${jsString(v.v)})`;
      case 'date': return `new Date(${jsString(isoDate(v.v) ?? new Date(v.v).toISOString())})`;
      case 'binData': {
        const u = uuidOf(v);
        if (u) { uses.add('UUID'); return `new UUID(${jsString(u)})`; }
        uses.add('Binary');
        return `new Binary(Buffer.from(${jsString(v.v)}, 'base64'), ${parseInt(v.sub, 16)})`;
      }
      case 'regex': return `/${v.pattern.replace(/\//g, '\\/')}/${v.flags}`;
      case 'timestamp': uses.add('Timestamp'); return `new Timestamp({ t: ${v.ts}, i: ${v.inc} })`;
      case 'minKey': uses.add('MinKey'); return 'new MinKey()';
      case 'maxKey': uses.add('MaxKey'); return 'new MaxKey()';
      case 'symbol': return jsString(v.v);
      case 'javascript': uses.add('Code'); return `new Code(${jsString(v.v)})`;
      case 'dbPointer': uses.add('DBRef'); uses.add('ObjectId'); return `new DBRef(${jsString(v.ref)}, new ObjectId(${jsString(v.id)}))`;
      case 'trunc': return jsString(v.preview);
      case 'array': {
        if (!v.v.length) return '[]';
        const items = v.v.map((x) => value(x, level + 1));
        if (fitsInline(items)) return `[${items.join(', ')}]`;
        return `[\n${items.map((x) => ind(level + 1) + x).join(',\n')}\n${ind(level)}]`;
      }
      case 'object': {
        if (!v.v.length) return '{}';
        const pairs = v.v.map(([k, x]) => `${jsKey(k)}: ${value(x, level + 1)}`);
        if (fitsInline(pairs)) return `{ ${pairs.join(', ')} }`;
        return `{\n${pairs.map((x) => ind(level + 1) + x).join(',\n')}\n${ind(level)}}`;
      }
    }
  };
  return { value, uses };
}

function shellEmitter(): Emitter {
  return {
    uses: new Set(),
    value: (v, level) => toShell(v, { inline: 60 }).split('\n').map((l, i) => (i ? ind(level) + l : l)).join('\n'),
  };
}

function pythonEmitter(): Emitter {
  const uses = new Set<string>();
  const value = (v: BsonValue, level: number): string => {
    switch (v.t) {
      case 'string': return pyString(v.v);
      case 'int': return String(v.v);
      case 'double':
        if (Number.isNaN(v.v)) return "float('nan')";
        if (v.v === Infinity) return "float('inf')";
        if (v.v === -Infinity) return "float('-inf')";
        return formatDouble(v.v);
      case 'long': uses.add('Int64'); return `Int64(${v.v})`;
      case 'decimal': uses.add('Decimal128'); return `Decimal128(${pyString(v.v)})`;
      case 'bool': return v.v ? 'True' : 'False';
      case 'null': case 'undefined': return 'None';
      case 'objectId': uses.add('ObjectId'); return `ObjectId(${pyString(v.v)})`;
      case 'date': {
        uses.add('datetime');
        const d = new Date(v.v);
        const parts = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
        const ms = d.getUTCMilliseconds();
        return `datetime(${parts.join(', ')}${ms ? `, ${ms * 1000}` : ''}, tzinfo=timezone.utc)`;
      }
      case 'binData': {
        const u = uuidOf(v);
        if (u) { uses.add('uuid'); return `UUID(${pyString(u)})`; }
        uses.add('Binary'); uses.add('base64');
        return `Binary(base64.b64decode(${pyString(v.v)}), ${parseInt(v.sub, 16)})`;
      }
      case 'regex': uses.add('Regex'); return `Regex(${pyString(v.pattern)}, ${pyString(v.flags)})`;
      case 'timestamp': uses.add('Timestamp'); return `Timestamp(${v.ts}, ${v.inc})`;
      case 'minKey': uses.add('MinKey'); return 'MinKey()';
      case 'maxKey': uses.add('MaxKey'); return 'MaxKey()';
      case 'symbol': return pyString(v.v);
      case 'javascript': uses.add('Code'); return `Code(${pyString(v.v)})`;
      case 'dbPointer': uses.add('DBRef'); uses.add('ObjectId'); return `DBRef(${pyString(v.ref)}, ObjectId(${pyString(v.id)}))`;
      case 'trunc': return pyString(v.preview);
      case 'array': {
        if (!v.v.length) return '[]';
        const items = v.v.map((x) => value(x, level + 1));
        if (fitsInline(items)) return `[${items.join(', ')}]`;
        return `[\n${items.map((x) => ind(level + 1, '    ') + x).join(',\n')}\n${ind(level, '    ')}]`;
      }
      case 'object': {
        if (!v.v.length) return '{}';
        const pairs = v.v.map(([k, x]) => `${pyString(k)}: ${value(x, level + 1)}`);
        if (fitsInline(pairs)) return `{${pairs.join(', ')}}`;
        return `{\n${pairs.map((x) => ind(level + 1, '    ') + x).join(',\n')}\n${ind(level, '    ')}}`;
      }
    }
  };
  return { value, uses };
}

function csString(s: string): string {
  return dqString(s);
}

function csharpEmitter(): Emitter {
  const uses = new Set<string>();
  const pad = (l: number) => ind(l, '    ');
  const value = (v: BsonValue, level: number): string => {
    switch (v.t) {
      case 'string': return csString(v.v);
      case 'int': return String(v.v);
      case 'double':
        if (Number.isNaN(v.v)) return 'double.NaN';
        if (v.v === Infinity) return 'double.PositiveInfinity';
        if (v.v === -Infinity) return 'double.NegativeInfinity';
        return formatDouble(v.v);
      case 'long': return `${v.v}L`;
      case 'decimal': return `Decimal128.Parse(${csString(v.v)})`;
      case 'bool': return String(v.v);
      case 'null': return 'BsonNull.Value';
      case 'undefined': return 'BsonUndefined.Value';
      case 'objectId': return `ObjectId.Parse(${csString(v.v)})`;
      case 'date': return `new BsonDateTime(DateTime.Parse(${csString(isoDate(v.v) ?? new Date(v.v).toISOString())}, null, DateTimeStyles.AdjustToUniversal))`;
      case 'binData': {
        const u = uuidOf(v);
        if (u) return `new BsonBinaryData(Guid.Parse(${csString(u)}), GuidRepresentation.Standard)`;
        return `new BsonBinaryData(Convert.FromBase64String(${csString(v.v)}), (BsonBinarySubType)${parseInt(v.sub, 16)})`;
      }
      case 'regex': return `new BsonRegularExpression(${csString(v.pattern)}, ${csString(v.flags)})`;
      case 'timestamp': return `new BsonTimestamp(${v.ts}, ${v.inc})`;
      case 'minKey': return 'BsonMinKey.Value';
      case 'maxKey': return 'BsonMaxKey.Value';
      case 'symbol': return csString(v.v);
      case 'javascript': return `new BsonJavaScript(${csString(v.v)})`;
      case 'dbPointer': return `new BsonDocument { { "$ref", ${csString(v.ref)} }, { "$id", ObjectId.Parse(${csString(v.id)}) } }`;
      case 'trunc': return csString(v.preview);
      case 'array': {
        if (!v.v.length) return 'new BsonArray()';
        const items = v.v.map((x) => value(x, level + 1));
        const inline = `new BsonArray { ${items.join(', ')} }`;
        if (inline.length <= 80 && !inline.includes('\n')) return inline;
        return `new BsonArray\n${pad(level)}{\n${items.map((x) => pad(level + 1) + x).join(',\n')}\n${pad(level)}}`;
      }
      case 'object': {
        if (!v.v.length) return 'new BsonDocument()';
        if (v.v.length === 1) return `new BsonDocument(${csString(v.v[0][0])}, ${value(v.v[0][1], level)})`;
        const pairs = v.v.map(([k, x]) => `{ ${csString(k)}, ${value(x, level + 1)} }`);
        const inline = `new BsonDocument { ${pairs.join(', ')} }`;
        if (inline.length <= 80 && !inline.includes('\n')) return inline;
        return `new BsonDocument\n${pad(level)}{\n${pairs.map((x) => pad(level + 1) + x).join(',\n')}\n${pad(level)}}`;
      }
    }
  };
  return { value, uses };
}

function javaEmitter(): Emitter {
  const uses = new Set<string>();
  const pad = (l: number) => ind(l, '    ');
  const value = (v: BsonValue, level: number): string => {
    switch (v.t) {
      case 'string': return dqString(v.v);
      case 'int': return String(v.v);
      case 'double':
        if (Number.isNaN(v.v)) return 'Double.NaN';
        if (v.v === Infinity) return 'Double.POSITIVE_INFINITY';
        if (v.v === -Infinity) return 'Double.NEGATIVE_INFINITY';
        return `${formatDouble(v.v)}d`;
      case 'long': return `${v.v}L`;
      case 'decimal': uses.add('org.bson.types.Decimal128'); return `Decimal128.parse(${dqString(v.v)})`;
      case 'bool': return String(v.v);
      case 'null': case 'undefined': return 'null';
      case 'objectId': uses.add('org.bson.types.ObjectId'); return `new ObjectId(${dqString(v.v)})`;
      case 'date': uses.add('java.util.Date'); return `new Date(${v.v}L)`;
      case 'binData': {
        const u = uuidOf(v);
        if (u) { uses.add('java.util.UUID'); return `UUID.fromString(${dqString(u)})`; }
        uses.add('org.bson.types.Binary'); uses.add('java.util.Base64');
        return `new Binary((byte) ${parseInt(v.sub, 16)}, Base64.getDecoder().decode(${dqString(v.v)}))`;
      }
      case 'regex': uses.add('org.bson.BsonRegularExpression'); return `new BsonRegularExpression(${dqString(v.pattern)}, ${dqString(v.flags)})`;
      case 'timestamp': uses.add('org.bson.BsonTimestamp'); return `new BsonTimestamp(${v.ts}, ${v.inc})`;
      case 'minKey': uses.add('org.bson.types.MinKey'); return 'new MinKey()';
      case 'maxKey': uses.add('org.bson.types.MaxKey'); return 'new MaxKey()';
      case 'symbol': return dqString(v.v);
      case 'javascript': uses.add('org.bson.types.Code'); return `new Code(${dqString(v.v)})`;
      case 'dbPointer': uses.add('com.mongodb.DBRef'); uses.add('org.bson.types.ObjectId'); return `new DBRef(${dqString(v.ref)}, new ObjectId(${dqString(v.id)}))`;
      case 'trunc': return dqString(v.preview);
      case 'array':
        uses.add('java.util.Arrays');
        if (!v.v.length) return 'Arrays.asList()';
        if (v.v.every((x) => x.t !== 'array' && x.t !== 'object')) {
          const inline = `Arrays.asList(${v.v.map((x) => value(x, level + 1)).join(', ')})`;
          if (inline.length <= 80) return inline;
        }
        return `Arrays.asList(\n${v.v.map((x) => pad(level + 1) + value(x, level + 1)).join(',\n')})`;
      case 'object':
        if (!v.v.length) return 'new Document()';
        return v.v
          .map(([k, x], i) => (i === 0 ? `new Document(${dqString(k)}, ${value(x, level + 1)})` : `\n${pad(level + 1)}.append(${dqString(k)}, ${value(x, level + 1)})`))
          .join('');
    }
  };
  return { value, uses };
}

// ---------------------------------------------------------------------------------------------------------------
// programs

const DEFAULT_URI = 'mongodb://localhost:27017';

function findOptions(input: Extract<ExportInput, { kind: 'find' }>) {
  return {
    projection: isEmptyDoc(input.projection) ? null : input.projection!,
    sort: isEmptyDoc(input.sort) ? null : input.sort!,
    collation: isEmptyDoc(input.collation) ? null : input.collation!,
    skip: input.skip && input.skip > 0 ? input.skip : 0,
    limit: input.limit && input.limit > 0 ? input.limit : 0,
  };
}

function shellCode(input: ExportInput): string {
  const e = shellEmitter();
  const target = `db.getSiblingDB(${jsString(input.db)}).getCollection(${jsString(input.coll)})`;
  if (input.kind === 'aggregate') {
    if (!input.pipeline.length) return `${target}.aggregate([]);`;
    return `${target}.aggregate([\n${input.pipeline.map((s) => `  ${e.value(s, 1)}`).join(',\n')}\n]);`;
  }
  const o = findOptions(input);
  let s = `${target}.find(${e.value(input.filter, 0)}${o.projection ? `, ${e.value(o.projection, 0)}` : ''})`;
  if (o.collation) s += `\n  .collation(${e.value(o.collation, 1)})`;
  if (o.sort) s += `\n  .sort(${e.value(o.sort, 1)})`;
  if (o.skip) s += `\n  .skip(${o.skip})`;
  if (o.limit) s += `\n  .limit(${o.limit})`;
  return `${s};`;
}

function nodeCode(input: ExportInput, opts: ExportOptions): string {
  const e = nodeEmitter();
  let body: string;
  if (input.kind === 'aggregate') {
    body = `const pipeline = ${e.value({ t: 'array', v: input.pipeline }, 0)};\n\nconst cursor = coll.aggregate(pipeline);`;
  } else {
    const o = findOptions(input);
    const optEntries: string[] = [];
    if (o.projection) optEntries.push(`  projection: ${e.value(o.projection, 1)}`);
    if (o.sort) optEntries.push(`  sort: ${e.value(o.sort, 1)}`);
    if (o.collation) optEntries.push(`  collation: ${e.value(o.collation, 1)}`);
    if (o.skip) optEntries.push(`  skip: ${o.skip}`);
    if (o.limit) optEntries.push(`  limit: ${o.limit}`);
    body = `const filter = ${e.value(input.filter, 0)};\n`;
    body += optEntries.length ? `const options = {\n${optEntries.join(',\n')}\n};\n\nconst cursor = coll.find(filter, options);` : `\nconst cursor = coll.find(filter);`;
  }
  if (opts.boilerplate === false) return body;
  const imports = ['MongoClient', ...[...e.uses].sort()];
  return [
    `import { ${imports.join(', ')} } from 'mongodb';`,
    '',
    `const client = new MongoClient(${jsString(opts.uri ?? DEFAULT_URI)});`,
    `const coll = client.db(${jsString(input.db)}).collection(${jsString(input.coll)});`,
    '',
    body,
    'for await (const doc of cursor) {',
    '  console.log(doc);',
    '}',
    'await client.close();',
  ].join('\n');
}

function pythonCode(input: ExportInput, opts: ExportOptions): string {
  const e = pythonEmitter();
  let body: string;
  if (input.kind === 'aggregate') {
    body = `pipeline = ${e.value({ t: 'array', v: input.pipeline }, 0)}\n\ncursor = coll.aggregate(pipeline)`;
  } else {
    const o = findOptions(input);
    body = `filter = ${e.value(input.filter, 0)}\n`;
    const args = ['filter'];
    if (o.projection) { body += `projection = ${e.value(o.projection, 0)}\n`; args.push('projection=projection'); }
    if (o.sort) {
      const pairs = o.sort.t === 'object' ? o.sort.v.map(([k, x]) => `(${pyString(k)}, ${e.value(x, 0)})`) : [];
      body += `sort = [${pairs.join(', ')}]\n`;
      args.push('sort=sort');
    }
    if (o.collation) { body += `collation = ${e.value(o.collation, 0)}\n`; args.push('collation=collation'); }
    if (o.skip) args.push(`skip=${o.skip}`);
    if (o.limit) args.push(`limit=${o.limit}`);
    body += `\ncursor = coll.find(${args.join(', ')})`;
  }
  if (opts.boilerplate === false) return body;
  const lines: string[] = [];
  if (e.uses.has('base64')) lines.push('import base64');
  if (e.uses.has('datetime')) lines.push('from datetime import datetime, timezone');
  if (e.uses.has('uuid')) lines.push('from uuid import UUID');
  const fromBson: [string, string][] = [
    ['ObjectId', 'bson.objectid'], ['Decimal128', 'bson.decimal128'], ['Int64', 'bson.int64'], ['Binary', 'bson.binary'],
    ['Regex', 'bson.regex'], ['Timestamp', 'bson.timestamp'], ['MinKey', 'bson.min_key'], ['MaxKey', 'bson.max_key'],
    ['Code', 'bson.code'], ['DBRef', 'bson.dbref'],
  ];
  for (const [name, mod] of fromBson) if (e.uses.has(name)) lines.push(`from ${mod} import ${name}`);
  lines.push('from pymongo import MongoClient', '', `client = MongoClient(${pyString(opts.uri ?? DEFAULT_URI)})`, `coll = client[${pyString(input.db)}][${pyString(input.coll)}]`, '', body, 'for doc in cursor:', '    print(doc)');
  return lines.join('\n');
}

function csharpCode(input: ExportInput, opts: ExportOptions): string {
  const e = csharpEmitter();
  let body: string;
  if (input.kind === 'aggregate') {
    const stages = input.pipeline.map((s) => `    ${e.value(s, 1)}`).join(',\n');
    body = `PipelineDefinition<BsonDocument, BsonDocument> pipeline = new BsonDocument[]\n{\n${stages}\n};\n\nvar results = await coll.Aggregate(pipeline).ToListAsync();`;
  } else {
    const o = findOptions(input);
    body = `var filter = ${e.value(input.filter, 0)};\n`;
    let chain = 'coll.Find(filter';
    chain += o.collation ? `, new FindOptions { Collation = Collation.FromBsonDocument(${e.value(o.collation, 1)}) })` : ')';
    if (o.projection) body += `var projection = ${e.value(o.projection, 0)};\n`;
    if (o.sort) body += `var sort = ${e.value(o.sort, 0)};\n`;
    if (o.projection) chain += '\n    .Project(projection)';
    if (o.sort) chain += '\n    .Sort(sort)';
    if (o.skip) chain += `\n    .Skip(${o.skip})`;
    if (o.limit) chain += `\n    .Limit(${o.limit})`;
    body += `\nvar results = await ${chain}\n    .ToListAsync();`;
  }
  if (opts.boilerplate === false) return body;
  return [
    'using System.Globalization;',
    'using MongoDB.Bson;',
    'using MongoDB.Driver;',
    '',
    `var client = new MongoClient(${csString(opts.uri ?? DEFAULT_URI)});`,
    `var coll = client.GetDatabase(${csString(input.db)}).GetCollection<BsonDocument>(${csString(input.coll)});`,
    '',
    body,
    'foreach (var doc in results)',
    '{',
    '    Console.WriteLine(doc.ToJson());',
    '}',
  ].join('\n');
}

function javaCode(input: ExportInput, opts: ExportOptions): string {
  const e = javaEmitter();
  let body: string;
  if (input.kind === 'aggregate') {
    e.uses.add('java.util.Arrays');
    e.uses.add('java.util.List');
    const stages = input.pipeline.map((s) => `            ${e.value(s, 3)}`).join(',\n');
    body = `        List<Document> pipeline = Arrays.asList(\n${stages});\n\n        for (Document doc : coll.aggregate(pipeline)) {\n            System.out.println(doc.toJson());\n        }`;
  } else {
    const o = findOptions(input);
    body = `        Document filter = ${e.value(input.filter, 2)};\n`;
    let chain = 'coll.find(filter)';
    if (o.projection) { body += `        Document projection = ${e.value(o.projection, 2)};\n`; chain += '\n                .projection(projection)'; }
    if (o.sort) { body += `        Document sort = ${e.value(o.sort, 2)};\n`; chain += '\n                .sort(sort)'; }
    if (o.skip) chain += `\n                .skip(${o.skip})`;
    if (o.limit) chain += `\n                .limit(${o.limit})`;
    body += `\n        for (Document doc : ${chain}) {\n            System.out.println(doc.toJson());\n        }`;
  }
  if (opts.boilerplate === false) return body.replace(/^ {8}/gm, '');
  const imports = ['com.mongodb.client.MongoClient', 'com.mongodb.client.MongoClients', 'com.mongodb.client.MongoCollection', 'org.bson.Document', ...e.uses].sort();
  return [
    ...[...new Set(imports)].map((i) => `import ${i};`),
    '',
    'public class Query {',
    '    public static void main(String[] args) {',
    `        try (MongoClient client = MongoClients.create(${dqString(opts.uri ?? DEFAULT_URI)})) {`,
    `            MongoCollection<Document> coll = client.getDatabase(${dqString(input.db)}).getCollection(${dqString(input.coll)});`,
    '',
    body.replace(/^ {8}/gm, '            '),
    '        }',
    '    }',
    '}',
  ].join('\n');
}

/** Source code for the query or pipeline in the given language. */
export function exportCode(lang: CodeLanguage, input: ExportInput, opts: ExportOptions = {}): string {
  switch (lang) {
    case 'shell': return shellCode(input);
    case 'node': return nodeCode(input, opts);
    case 'python': return pythonCode(input, opts);
    case 'csharp': return csharpCode(input, opts);
    case 'java': return javaCode(input, opts);
  }
}

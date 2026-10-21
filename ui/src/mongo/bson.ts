// BSON values on the UI side (docs/PLAN-M2.md 6.3). The engine sends documents as canonical Extended JSON text; the
// UI parses them into `BsonValue` trees (ordered keys, every BSON type kept), renders them, and writes them back as
// mongosh-style shell text (`ObjectId("…")`, `ISODate("…")`, `NumberLong("…")`), which the engine's ShellJson parser
// reads. That round trip keeps ObjectId, Date, Decimal128, Binary, Int64, Int32 and Double apart.

export type BsonType =
  | 'string' | 'int' | 'long' | 'double' | 'decimal' | 'bool' | 'null' | 'undefined' | 'objectId' | 'date' | 'binData'
  | 'regex' | 'timestamp' | 'minKey' | 'maxKey' | 'symbol' | 'javascript' | 'dbPointer' | 'array' | 'object' | 'trunc';

export type BsonEntry = [string, BsonValue];

export type BsonValue =
  | { t: 'string'; v: string }
  | { t: 'int'; v: number }
  /** Int64 as a decimal string (exact beyond 2^53). */
  | { t: 'long'; v: string }
  | { t: 'double'; v: number }
  | { t: 'decimal'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'undefined' }
  | { t: 'objectId'; v: string }
  /** Milliseconds since the epoch. */
  | { t: 'date'; v: number }
  /** base64 payload; `sub` = subtype as two hex digits ("00", "04"). */
  | { t: 'binData'; v: string; sub: string }
  | { t: 'regex'; pattern: string; flags: string }
  | { t: 'timestamp'; ts: number; inc: number }
  | { t: 'minKey' }
  | { t: 'maxKey' }
  | { t: 'symbol'; v: string }
  | { t: 'javascript'; v: string; scope?: BsonValue }
  | { t: 'dbPointer'; ref: string; id: string }
  | { t: 'array'; v: BsonValue[] }
  | { t: 'object'; v: BsonEntry[] }
  /** A value the engine cut (`$trunc`): strings > 32 KB, binary > 8 KB. "Load full" fetches the document. */
  | { t: 'trunc'; preview: string; len: number; binary: boolean; sub?: string };

export type BsonDoc = Extract<BsonValue, { t: 'object' }>;

// ---------------------------------------------------------------------------------------------------------------
// Constructors

export const B = {
  str: (v: string): BsonValue => ({ t: 'string', v }),
  int: (v: number): BsonValue => ({ t: 'int', v }),
  long: (v: string | number | bigint): BsonValue => ({ t: 'long', v: String(v) }),
  double: (v: number): BsonValue => ({ t: 'double', v }),
  decimal: (v: string): BsonValue => ({ t: 'decimal', v }),
  bool: (v: boolean): BsonValue => ({ t: 'bool', v }),
  null: (): BsonValue => ({ t: 'null' }),
  oid: (v: string): BsonValue => ({ t: 'objectId', v: v.toLowerCase() }),
  date: (v: number | string | Date): BsonValue => ({ t: 'date', v: typeof v === 'number' ? v : new Date(v).getTime() }),
  bin: (v: string, sub = '00'): BsonValue => ({ t: 'binData', v, sub }),
  arr: (v: BsonValue[]): BsonValue => ({ t: 'array', v }),
  doc: (entries: BsonEntry[] | Record<string, BsonValue>): BsonDoc =>
    ({ t: 'object', v: Array.isArray(entries) ? entries : Object.entries(entries) }),
};

/** A JS number as the BSON type mongosh would pick (integers in int32 range → int, other integers → long). */
export function numberValue(n: number): BsonValue {
  if (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) return { t: 'int', v: n };
  if (Number.isSafeInteger(n)) return { t: 'long', v: String(n) };
  return { t: 'double', v: n };
}

// ---------------------------------------------------------------------------------------------------------------
// Extended JSON (canonical and relaxed) → BsonValue

export class EjsonError extends Error {}

/** Parses canonical or relaxed Extended JSON text. */
export function parseEjson(text: string): BsonValue {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new EjsonError(`Invalid Extended JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return fromEjson(j);
}

/** Parses a canonical EJSON document text; non-documents become `{ value: … }` so callers always get a document. */
export function parseEjsonDoc(text: string): BsonDoc {
  const v = parseEjson(text);
  return v.t === 'object' ? v : B.doc([['value', v]]);
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function only(o: Record<string, unknown>, ...keys: string[]): boolean {
  const ks = Object.keys(o);
  return ks.length === keys.length && keys.every((k) => ks.includes(k));
}

function hexToBase64(hex: string): string {
  const clean = hex.replace(/-/g, '');
  let bin = '';
  for (let i = 0; i < clean.length; i += 2) bin += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return btoa(bin);
}

export function base64ToHex(b64: string): string {
  let out = '';
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return '';
  }
  for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return out;
}

/** Byte length of a base64 payload. */
export function base64Length(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function parseDouble(s: string): number {
  if (s === 'Infinity') return Infinity;
  if (s === '-Infinity') return -Infinity;
  if (s === 'NaN') return NaN;
  return Number(s);
}

/** Converts parsed JSON (canonical or relaxed EJSON) into a BsonValue. */
export function fromEjson(j: unknown): BsonValue {
  if (j === null) return { t: 'null' };
  if (typeof j === 'boolean') return { t: 'bool', v: j };
  if (typeof j === 'number') return Number.isInteger(j) ? numberValue(j) : { t: 'double', v: j };
  if (typeof j === 'string') return { t: 'string', v: j };
  if (Array.isArray(j)) return { t: 'array', v: j.map(fromEjson) };
  if (!isObj(j)) return { t: 'string', v: String(j) };
  const o = j;
  if (only(o, '$oid') && typeof o.$oid === 'string') return { t: 'objectId', v: o.$oid };
  if (only(o, '$date')) {
    const d = o.$date;
    if (typeof d === 'string') return { t: 'date', v: Date.parse(d) };
    if (typeof d === 'number') return { t: 'date', v: d };
    if (isObj(d) && typeof d.$numberLong === 'string') return { t: 'date', v: Number(d.$numberLong) };
  }
  if (only(o, '$numberInt') && typeof o.$numberInt === 'string') return { t: 'int', v: Number(o.$numberInt) };
  if (only(o, '$numberLong') && typeof o.$numberLong === 'string') return { t: 'long', v: o.$numberLong };
  if (only(o, '$numberDouble') && typeof o.$numberDouble === 'string') return { t: 'double', v: parseDouble(o.$numberDouble) };
  if (only(o, '$numberDecimal') && typeof o.$numberDecimal === 'string') return { t: 'decimal', v: o.$numberDecimal };
  if (only(o, '$binary')) {
    const b = o.$binary;
    if (isObj(b) && typeof b.base64 === 'string') return { t: 'binData', v: b.base64, sub: String(b.subType ?? '00').padStart(2, '0') };
  }
  if (only(o, '$binary', '$type') && typeof o.$binary === 'string') return { t: 'binData', v: o.$binary, sub: String(o.$type).padStart(2, '0') };
  if (only(o, '$uuid') && typeof o.$uuid === 'string') return { t: 'binData', v: hexToBase64(o.$uuid), sub: '04' };
  if (only(o, '$regularExpression') && isObj(o.$regularExpression)) {
    const r = o.$regularExpression;
    return { t: 'regex', pattern: String(r.pattern ?? ''), flags: String(r.options ?? '') };
  }
  if (only(o, '$timestamp') && isObj(o.$timestamp)) return { t: 'timestamp', ts: Number(o.$timestamp.t), inc: Number(o.$timestamp.i) };
  if (only(o, '$minKey')) return { t: 'minKey' };
  if (only(o, '$maxKey')) return { t: 'maxKey' };
  if (only(o, '$undefined')) return { t: 'undefined' };
  if (only(o, '$symbol') && typeof o.$symbol === 'string') return { t: 'symbol', v: o.$symbol };
  if (only(o, '$code') && typeof o.$code === 'string') return { t: 'javascript', v: o.$code };
  if (only(o, '$code', '$scope') && typeof o.$code === 'string') return { t: 'javascript', v: o.$code, scope: fromEjson(o.$scope) };
  if (only(o, '$dbPointer') && isObj(o.$dbPointer)) {
    const p = o.$dbPointer;
    const id = isObj(p.$id) && typeof p.$id.$oid === 'string' ? p.$id.$oid : String(p.$id);
    return { t: 'dbPointer', ref: String(p.$ref), id };
  }
  if ('$trunc' in o && 'len' in o && typeof o.$trunc === 'string') {
    const len = fromEjson(o.len);
    return {
      t: 'trunc', preview: o.$trunc, len: len.t === 'int' || len.t === 'double' ? len.v : len.t === 'long' ? Number(len.v) : 0,
      binary: o.binary === true, sub: typeof o.subType === 'string' ? o.subType : undefined,
    };
  }
  return { t: 'object', v: Object.entries(o).map(([k, v]) => [k, fromEjson(v)] as BsonEntry) };
}

// ---------------------------------------------------------------------------------------------------------------
// BsonValue → canonical / relaxed Extended JSON (for copy and export)

export function toEjsonJson(v: BsonValue, mode: 'canonical' | 'relaxed' = 'canonical'): unknown {
  const c = mode === 'canonical';
  switch (v.t) {
    case 'string': return v.v;
    case 'int': return c ? { $numberInt: String(v.v) } : v.v;
    case 'long': return c || !Number.isSafeInteger(Number(v.v)) ? { $numberLong: v.v } : Number(v.v);
    case 'double':
      if (!Number.isFinite(v.v)) return { $numberDouble: Number.isNaN(v.v) ? 'NaN' : v.v > 0 ? 'Infinity' : '-Infinity' };
      return c ? { $numberDouble: Object.is(v.v, -0) ? '-0.0' : Number.isInteger(v.v) ? `${v.v}.0` : String(v.v) } : v.v;
    case 'decimal': return { $numberDecimal: v.v };
    case 'bool': return v.v;
    case 'null': return null;
    case 'undefined': return { $undefined: true };
    case 'objectId': return { $oid: v.v };
    case 'date': {
      const d = new Date(v.v);
      const y = d.getUTCFullYear();
      return !c && y >= 1970 && y <= 9999 ? { $date: d.toISOString() } : { $date: { $numberLong: String(v.v) } };
    }
    case 'binData': return { $binary: { base64: v.v, subType: v.sub } };
    case 'regex': return { $regularExpression: { pattern: v.pattern, options: v.flags } };
    case 'timestamp': return { $timestamp: { t: v.ts, i: v.inc } };
    case 'minKey': return { $minKey: 1 };
    case 'maxKey': return { $maxKey: 1 };
    case 'symbol': return { $symbol: v.v };
    case 'javascript': return v.scope ? { $code: v.v, $scope: toEjsonJson(v.scope, mode) } : { $code: v.v };
    case 'dbPointer': return { $dbPointer: { $ref: v.ref, $id: { $oid: v.id } } };
    case 'array': return v.v.map((x) => toEjsonJson(x, mode));
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const [k, x] of v.v) o[k] = toEjsonJson(x, mode);
      return o;
    }
    case 'trunc': return { $trunc: v.preview, len: v.len };
  }
}

export function toEjsonText(v: BsonValue, mode: 'canonical' | 'relaxed' = 'relaxed', indent: number | undefined = 2): string {
  return JSON.stringify(toEjsonJson(v, mode), null, indent);
}

// ---------------------------------------------------------------------------------------------------------------
// BsonValue → shell text (what the editors show and what the engine parses back)

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** A key as mongosh prints it: bare when it is an identifier, else double-quoted. */
export function shellKey(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/** Doubles always keep a decimal point (`5.0`) so they re-parse as double, not int. */
export function formatDouble(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (Object.is(n, -0)) return '-0.0';
  const s = String(n);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

export function isoDate(ms: number): string | null {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y >= 0 && y <= 9999 ? d.toISOString() : null;
}

function escapeRegexBody(p: string): string {
  return p.replace(/(^|[^\\])\//g, '$1\\/').replace(/\n/g, '\\n');
}

/** Hex string of a UUID binary (subtype 4, 16 bytes), formatted 8-4-4-4-12; null otherwise. */
export function uuidOf(v: BsonValue): string | null {
  if (v.t !== 'binData' || (v.sub !== '04' && v.sub !== '03')) return null;
  const h = base64ToHex(v.v);
  if (h.length !== 32 || v.sub !== '04') return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Shell text of a scalar (and compact text of containers). */
export function scalarShell(v: BsonValue): string {
  switch (v.t) {
    case 'string': return JSON.stringify(v.v);
    case 'int': return String(v.v);
    case 'long': return `NumberLong("${v.v}")`;
    case 'double': return formatDouble(v.v);
    case 'decimal': return `NumberDecimal("${v.v}")`;
    case 'bool': return String(v.v);
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    case 'objectId': return `ObjectId("${v.v}")`;
    case 'date': {
      const iso = isoDate(v.v);
      return iso ? `ISODate("${iso}")` : `Date(${v.v})`;
    }
    case 'binData': {
      const u = uuidOf(v);
      return u ? `UUID("${u}")` : `BinData(${parseInt(v.sub, 16)}, "${v.v}")`;
    }
    case 'regex': return `/${escapeRegexBody(v.pattern)}/${v.flags}`;
    case 'timestamp': return `Timestamp(${v.ts}, ${v.inc})`;
    case 'minKey': return 'MinKey';
    case 'maxKey': return 'MaxKey';
    case 'symbol': return JSON.stringify({ $symbol: v.v });
    case 'javascript': return v.scope ? JSON.stringify(toEjsonJson(v)) : `Code(${JSON.stringify(v.v)})`;
    case 'dbPointer': return JSON.stringify(toEjsonJson(v));
    case 'trunc': return JSON.stringify(v.preview);
    case 'array': return `[${v.v.map(scalarShell).join(', ')}]`;
    case 'object': return v.v.length ? `{ ${v.v.map(([k, x]) => `${shellKey(k)}: ${scalarShell(x)}`).join(', ')} }` : '{}';
  }
}

/** Pretty shell text (2-space indent). `inline` keeps short containers on one line. */
export function toShell(v: BsonValue, opts: { indent?: number; inline?: number } = {}): string {
  const indent = opts.indent ?? 2;
  const inline = opts.inline ?? 0;
  const pad = (n: number) => ' '.repeat(n * indent);
  const go = (x: BsonValue, level: number): string => {
    if (x.t !== 'array' && x.t !== 'object') return scalarShell(x);
    if (x.v.length === 0) return x.t === 'array' ? '[]' : '{}';
    const compact = scalarShell(x);
    if (inline > 0 && compact.length <= inline && !compact.includes('\n')) return compact;
    if (x.t === 'array') return `[\n${x.v.map((e) => pad(level + 1) + go(e, level + 1)).join(',\n')}\n${pad(level)}]`;
    return `{\n${x.v.map(([k, e]) => `${pad(level + 1)}${shellKey(k)}: ${go(e, level + 1)}`).join(',\n')}\n${pad(level)}}`;
  };
  return go(v, 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

export const TYPE_LABEL: Record<BsonType, string> = {
  string: 'String', int: 'Int32', long: 'Int64', double: 'Double', decimal: 'Decimal128', bool: 'Boolean', null: 'Null',
  undefined: 'Undefined', objectId: 'ObjectId', date: 'Date', binData: 'Binary', regex: 'RegExp', timestamp: 'Timestamp',
  minKey: 'MinKey', maxKey: 'MaxKey', symbol: 'Symbol', javascript: 'Code', dbPointer: 'DBPointer', array: 'Array',
  object: 'Object', trunc: 'Truncated',
};

/** Label of a server `$type` alias (`objectId`, `bool`, `binData`, …) as used by the schema and fields endpoints. */
export function typeAliasLabel(alias: string): string {
  return (TYPE_LABEL as Record<string, string>)[alias] ?? (alias === 'javaScript' ? 'Code' : alias.charAt(0).toUpperCase() + alias.slice(1));
}

export function isContainer(v: BsonValue): v is Extract<BsonValue, { t: 'array' | 'object' }> {
  return v.t === 'array' || v.t === 'object';
}

export function getField(doc: BsonValue, key: string): BsonValue | undefined {
  if (doc.t !== 'object') return undefined;
  return doc.v.find(([k]) => k === key)?.[1];
}

/** Value at a dotted path (array indexes allowed: `items.0.sku`). */
export function getPath(doc: BsonValue, path: string): BsonValue | undefined {
  let cur: BsonValue | undefined = doc;
  for (const part of path.split('.')) {
    if (!cur) return undefined;
    if (cur.t === 'object') cur = cur.v.find(([k]) => k === part)?.[1];
    else if (cur.t === 'array' && /^\d+$/.test(part)) cur = cur.v[Number(part)];
    else return undefined;
  }
  return cur;
}

export function setField(doc: BsonDoc, key: string, value: BsonValue): BsonDoc {
  const i = doc.v.findIndex(([k]) => k === key);
  const v = [...doc.v];
  if (i >= 0) v[i] = [key, value];
  else v.push([key, value]);
  return { t: 'object', v };
}

export function withoutField(doc: BsonDoc, key: string): BsonDoc {
  return { t: 'object', v: doc.v.filter(([k]) => k !== key) };
}

/** True when the value (or anything inside it) was truncated by the engine. */
export function hasTrunc(v: BsonValue): boolean {
  if (v.t === 'trunc') return true;
  if (v.t === 'array') return v.v.some(hasTrunc);
  if (v.t === 'object') return v.v.some(([, x]) => hasTrunc(x));
  return false;
}

export function bsonEquals(a: BsonValue, b: BsonValue): boolean {
  return JSON.stringify(toEjsonJson(a)) === JSON.stringify(toEjsonJson(b));
}

/** Creation time embedded in an ObjectId (first 4 bytes = seconds). */
export function objectIdTime(hex: string): Date | null {
  if (!/^[0-9a-f]{24}$/i.test(hex)) return null;
  return new Date(parseInt(hex.slice(0, 8), 16) * 1000);
}

/** A fresh ObjectId (time + random), for clone/insert previews. */
export function newObjectId(now = Date.now()): string {
  const t = Math.floor(now / 1000).toString(16).padStart(8, '0');
  let r = '';
  for (let i = 0; i < 16; i++) r += Math.floor(Math.random() * 16).toString(16);
  return t + r;
}

/** Short one-line preview of a value for table cells and summaries. */
export function previewText(v: BsonValue, max = 80): string {
  let s: string;
  switch (v.t) {
    case 'string': s = v.v; break;
    case 'array': s = `[${v.v.length}]`; break;
    case 'object': s = `{${v.v.length ? '…' : ''}}`; break;
    case 'long': s = v.v; break;
    case 'decimal': s = v.v; break;
    case 'objectId': s = v.v; break;
    case 'date': s = isoDate(v.v) ?? String(v.v); break;
    case 'trunc': s = v.binary ? `<binary ${v.len.toLocaleString()} bytes>` : v.preview; break;
    case 'binData': {
      const u = uuidOf(v);
      s = u ?? `<binary ${base64Length(v.v).toLocaleString()} bytes>`;
      break;
    }
    default: s = scalarShell(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

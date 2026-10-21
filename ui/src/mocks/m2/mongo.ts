// Mongo mock routes and stream emitters (docs/PLAN-M2.md section 6, package M2-M): an in-memory "shop" deployment
// (customers, orders, products, a view, a time-series collection) with a small query engine (filters, projection,
// sort, the common aggregation stages), explain trees, schema/import/export/index jobs, validation and a
// `mongo.changes` stream. Documents travel as canonical Extended JSON text, exactly like the engine.
import { http, HttpResponse, type RequestHandler } from 'msw';
import type {
  MongoAggregateRequest, MongoCollectionInfo, MongoCreateCollectionRequest, MongoCreateIndexRequest, MongoExplainRequest,
  MongoExportRequest, MongoFieldPath, MongoFindRequest, MongoImportError, MongoImportRequest, MongoIndexInfo, MongoIndexKeyPart,
  MongoProfiling, MongoProfilingRequest, MongoSchemaField, MongoValidation, PlanNode,
} from '../../api/types';
import {
  B, getPath, numberValue, toEjsonJson, type BsonDoc, type BsonEntry, type BsonValue,
} from '../../mongo/bson';
import { parseShell, parseShellDoc, ShellJsonError } from '../../mongo/shellJson';
import { M2_PREFIX, type M2MockContext } from './index';

// ---------------------------------------------------------------------------------------------------------------
// fixture

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function oidFrom(ts: number, n: number): string {
  return Math.floor(ts / 1000).toString(16).padStart(8, '0') + n.toString(16).padStart(16, '0');
}

const FIRST = ['Alice', 'Bob', 'Carla', 'Dmitri', 'Erin', 'Farah', 'Goran', 'Hana', 'Ivo', 'Jules', 'Kemal', 'Lena', 'Milo', 'Nora', 'Oskar', 'Priya'];
/** Right-to-left sample names (Persian, Arabic, mixed) for a few customers; the PRNG sequence is unchanged. */
const RTL_NAMES: Record<number, string> = { 1: 'علی رضایی', 2: 'مریم احمدی', 3: 'محمد عبدالله', 4: 'Order #12 سفارش' };
const LAST = ['Martin', 'Okafor', 'Silva', 'Novak', 'Kim', 'Haddad', 'Berg', 'Rossi', 'Ivanova', 'Dubois', 'Tanaka', 'Moreau'];
const CITIES: [string, string][] = [['Berlin', 'DE'], ['Paris', 'FR'], ['Lisbon', 'PT'], ['Oslo', 'NO'], ['Austin', 'US'], ['Osaka', 'JP'], ['Lyon', 'FR']];
const PRODUCTS = ['Espresso beans', 'Pour-over kettle', 'Ceramic mug', 'Grinder', 'Milk frother', 'Cold brew jar', 'Tea sampler', 'Scale', 'Filter papers', 'Travel tumbler', 'Moka pot', 'Chai spice'];

export interface MockColl {
  type: 'collection' | 'view' | 'timeseries';
  docs: BsonDoc[];
  indexes: MongoIndexInfo[];
  validation: MongoValidation;
  viewOn?: string;
  pipeline?: BsonValue[];
}

export type MockDeployment = Map<string, Map<string, MockColl>>;

function idIndex(): MongoIndexInfo {
  return { name: '_id_', key: [{ field: '_id', type: 1 }], unique: true, sparse: false, ttlSeconds: null, partialFilter: null, collation: null, size: 20480, usage: { ops: 1204, since: '2026-10-01T08:00:00.000Z' } };
}

function idx(name: string, key: MongoIndexKeyPart[], extra: Partial<MongoIndexInfo> = {}): MongoIndexInfo {
  return { name, key, unique: false, sparse: false, ttlSeconds: null, partialFilter: null, collation: null, size: 16384, usage: { ops: 0, since: '2026-10-01T08:00:00.000Z' }, ...extra };
}

const NO_VALIDATION: MongoValidation = { validator: null, level: 'strict', action: 'error' };

/** The deterministic shop fixture (fresh copy per mock engine). */
export function createMongoFixture(): MockDeployment {
  const r = prng(42);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const base = Date.UTC(2024, 0, 1);
  const customers: BsonDoc[] = [];
  for (let i = 0; i < 60; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const [city, country] = pick(CITIES);
    const created = base + Math.floor(r() * 300) * 86400000;
    const entries: BsonEntry[] = [
      ['_id', B.oid(oidFrom(created, 0x1000 + i))],
      ['name', B.str(RTL_NAMES[i] ?? `${first} ${last}`)],
      ['email', B.str(`${first}.${last}${i}@example.com`.toLowerCase())],
      ['tier', B.str(pick(['gold', 'silver', 'silver', 'bronze', 'bronze', 'bronze']))],
    ];
    // mixed types on purpose: phone is a string, a number or missing
    const pr = r();
    if (pr < 0.55) entries.push(['phone', B.str(`+49 30 ${Math.floor(r() * 9000000 + 1000000)}`)]);
    else if (pr < 0.8) entries.push(['phone', numberValue(Math.floor(r() * 900000000 + 100000000))]);
    entries.push(
      ['address', B.doc([['street', B.str(`${Math.floor(r() * 200) + 1} ${pick(['Main St', 'Rue Haute', 'Hauptstraße', 'Avenida Sol'])}`)], ['city', B.str(city)], ['country', B.str(country)]])],
      ['tags', B.arr(['vip', 'newsletter', 'wholesale', 'beta'].filter(() => r() < 0.35).map(B.str))],
      ['createdAt', B.date(created)],
      ['balance', B.decimal((Math.floor(r() * 100000) / 100).toFixed(2))],
      ['visits', B.long(Math.floor(r() * 5000))],
    );
    if (i % 7 === 0) entries.push(['avatar', B.bin('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', '00')]);
    customers.push(B.doc(entries));
  }
  const products: BsonDoc[] = PRODUCTS.map((name, i) => {
    const rating = i % 4 === 0 ? B.str('n/a') : i % 3 === 0 ? B.int(4) : B.double(Math.round((3 + r() * 2) * 10) / 10);
    return B.doc([
      ['_id', B.oid(oidFrom(base, 0x2000 + i))],
      ['sku', B.str(`SKU-${(100 + i).toString()}`)],
      ['name', B.str(name)],
      ['price', B.decimal((5 + Math.floor(r() * 9000) / 100).toFixed(2))],
      ['stock', B.long(Math.floor(r() * 400))],
      ['rating', rating],
      ['tags', B.arr([pick(['coffee', 'tea', 'gear']), pick(['bestseller', 'new', 'sale'])].map(B.str))],
    ]);
  });
  const orders: BsonDoc[] = [];
  for (let i = 0; i < 240; i++) {
    const c = pick(customers);
    const created = base + Math.floor(r() * 280 * 86400) * 1000;
    const status = pick(['paid', 'paid', 'paid', 'pending', 'shipped', 'shipped', 'cancelled']);
    const items: BsonValue[] = [];
    let total = 0;
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const p = pick(products);
      const qty = 1 + Math.floor(r() * 4);
      const price = Number((getPath(p, 'price') as { v: string }).v);
      total += qty * price;
      items.push(B.doc([['sku', getPath(p, 'sku')!], ['qty', B.int(qty)], ['price', B.double(price)]]));
    }
    const entries: BsonEntry[] = [
      ['_id', B.oid(oidFrom(created, 0x3000 + i))],
      ['customerId', getPath(c, '_id')!],
      ['customer', getPath(c, 'name')!],
      ['status', B.str(status)],
      ['total', B.double(Math.round(total * 100) / 100)],
      ['items', B.arr(items)],
      ['createdAt', B.date(created)],
    ];
    if (status === 'paid' || status === 'shipped') entries.push(['paidAt', B.date(created + 3600000)]);
    if (i === 3) entries.push(['notes', B.str('Gift wrap. '.repeat(3500))]);
    orders.push(B.doc(entries));
  }
  const events: BsonDoc[] = [];
  for (let i = 0; i < 100; i++) {
    const ts = base + i * 60000;
    events.push(B.doc([['_id', B.oid(oidFrom(ts, 0x4000 + i))], ['ts', B.date(ts)], ['meta', B.doc([['sensor', B.str(`s-${i % 4}`)]])], ['value', B.double(Math.round(r() * 1000) / 10)]]));
  }
  const customerValidator = B.doc([['$jsonSchema', B.doc([
    ['bsonType', B.str('object')],
    ['required', B.arr([B.str('name'), B.str('email')])],
    ['properties', B.doc([
      ['name', B.doc([['bsonType', B.str('string')]])],
      ['email', B.doc([['bsonType', B.str('string')], ['pattern', B.str('^.+@.+$')]])],
      ['tier', B.doc([['enum', B.arr([B.str('gold'), B.str('silver'), B.str('bronze')])]])],
    ])],
  ])]]);
  const shop = new Map<string, MockColl>([
    ['customers', {
      type: 'collection', docs: customers, validation: { validator: ejson(customerValidator), level: 'moderate', action: 'warn' },
      indexes: [idIndex(), idx('email_1', [{ field: 'email', type: 1 }], { unique: true, usage: { ops: 87, since: '2026-10-01T08:00:00.000Z' } })],
    }],
    ['orders', {
      type: 'collection', docs: orders, validation: NO_VALIDATION,
      indexes: [idIndex(), idx('status_1_createdAt_-1', [{ field: 'status', type: 1 }, { field: 'createdAt', type: -1 }], { usage: { ops: 3412, since: '2026-10-01T08:00:00.000Z' } }), idx('customerId_1', [{ field: 'customerId', type: 1 }])],
    }],
    ['products', {
      type: 'collection', docs: products, validation: NO_VALIDATION,
      indexes: [idIndex(), idx('name_text', [{ field: 'name', type: 'text' }]), idx('sku_1', [{ field: 'sku', type: 1 }], { unique: true })],
    }],
    ['paid_orders', { type: 'view', docs: [], indexes: [], validation: NO_VALIDATION, viewOn: 'orders', pipeline: [B.doc([['$match', B.doc([['status', B.str('paid')]])]])] }],
  ]);
  const analytics = new Map<string, MockColl>([
    ['events', { type: 'timeseries', docs: events, indexes: [], validation: NO_VALIDATION }],
  ]);
  return new Map([['shop', shop], ['analytics', analytics], ['admin', new Map()]]);
}

// ---------------------------------------------------------------------------------------------------------------
// EJSON out

const TRUNC_STRING = 32768;

function truncate(v: BsonValue): BsonValue {
  if (v.t === 'string' && v.v.length > TRUNC_STRING) return { t: 'trunc', preview: v.v.slice(0, 1000), len: v.v.length, binary: false };
  if (v.t === 'array') return { t: 'array', v: v.v.map(truncate) };
  if (v.t === 'object') return { t: 'object', v: v.v.map(([k, x]) => [k, truncate(x)] as BsonEntry) };
  return v;
}

export function ejson(v: BsonValue, trunc = false): string {
  return JSON.stringify(toEjsonJson(trunc ? truncate(v) : v, 'canonical'));
}

// ---------------------------------------------------------------------------------------------------------------
// query engine (enough of MongoDB for the UI)

const TYPE_ORDER: Record<string, number> = {
  minKey: 0, null: 1, undefined: 1, int: 2, long: 2, double: 2, decimal: 2, string: 3, symbol: 3, object: 4, array: 5, binData: 6,
  objectId: 7, bool: 8, date: 9, timestamp: 10, regex: 11, maxKey: 99,
};

function num(v: BsonValue): number | null {
  if (v.t === 'int' || v.t === 'double') return v.v;
  if (v.t === 'long' || v.t === 'decimal') return Number(v.v);
  return null;
}

export function compare(a: BsonValue | undefined, b: BsonValue | undefined): number {
  const A = a ?? ({ t: 'null' } as BsonValue);
  const Bv = b ?? ({ t: 'null' } as BsonValue);
  const ta = TYPE_ORDER[A.t] ?? 50;
  const tb = TYPE_ORDER[Bv.t] ?? 50;
  if (ta !== tb) return ta - tb;
  const na = num(A);
  const nb = num(Bv);
  if (na !== null && nb !== null) return na - nb;
  if (A.t === 'string' && Bv.t === 'string') return A.v < Bv.v ? -1 : A.v > Bv.v ? 1 : 0;
  if (A.t === 'objectId' && Bv.t === 'objectId') return A.v < Bv.v ? -1 : A.v > Bv.v ? 1 : 0;
  if (A.t === 'date' && Bv.t === 'date') return A.v - Bv.v;
  if (A.t === 'bool' && Bv.t === 'bool') return Number(A.v) - Number(Bv.v);
  return ejson(A).localeCompare(ejson(Bv));
}

const eq = (a: BsonValue | undefined, b: BsonValue) => a !== undefined && TYPE_ORDER[a.t] === TYPE_ORDER[b.t] && compare(a, b) === 0;

/** Values at a dotted path, descending into arrays (MongoDB semantics). */
function valuesAt(doc: BsonValue, path: string): BsonValue[] {
  const parts = path.split('.');
  let cur: BsonValue[] = [doc];
  for (const p of parts) {
    const next: BsonValue[] = [];
    for (const c of cur) {
      if (c.t === 'object') {
        const f = c.v.find(([k]) => k === p)?.[1];
        if (f !== undefined) next.push(f);
      } else if (c.t === 'array') {
        if (/^\d+$/.test(p) && c.v[Number(p)] !== undefined) next.push(c.v[Number(p)]);
        for (const e of c.v) if (e.t === 'object') {
          const f = e.v.find(([k]) => k === p)?.[1];
          if (f !== undefined) next.push(f);
        }
      }
    }
    cur = next;
  }
  return cur;
}

function expand(vals: BsonValue[]): BsonValue[] {
  const out: BsonValue[] = [];
  for (const v of vals) {
    out.push(v);
    if (v.t === 'array') out.push(...v.v);
  }
  return out;
}

function typeMatches(v: BsonValue, alias: BsonValue): boolean {
  const a = alias.t === 'string' ? alias.v : '';
  if (a === 'number') return num(v) !== null;
  const map: Record<string, string> = { object: 'object', bool: 'bool', binData: 'binData', javascript: 'javascript' };
  return (map[a] ?? a) === v.t;
}

function regexOf(v: BsonValue): RegExp | null {
  if (v.t === 'regex') return new RegExp(v.pattern, v.flags.replace(/[^gimsuy]/g, ''));
  if (v.t === 'string') return new RegExp(v.v);
  return null;
}

function opMatch(vals: BsonValue[], op: string, arg: BsonValue, cond: BsonDoc): boolean {
  const all = expand(vals);
  switch (op) {
    case '$eq': return arg.t === 'null' ? vals.length === 0 || all.some((v) => v.t === 'null') : all.some((v) => eq(v, arg));
    case '$ne': return !opMatch(vals, '$eq', arg, cond);
    case '$gt': return all.some((v) => TYPE_ORDER[v.t] === TYPE_ORDER[arg.t] && compare(v, arg) > 0);
    case '$gte': return all.some((v) => TYPE_ORDER[v.t] === TYPE_ORDER[arg.t] && compare(v, arg) >= 0);
    case '$lt': return all.some((v) => TYPE_ORDER[v.t] === TYPE_ORDER[arg.t] && compare(v, arg) < 0);
    case '$lte': return all.some((v) => TYPE_ORDER[v.t] === TYPE_ORDER[arg.t] && compare(v, arg) <= 0);
    case '$in': return arg.t === 'array' && arg.v.some((x) => (x.t === 'regex' ? all.some((v) => v.t === 'string' && regexOf(x)!.test(v.v)) : opMatch(vals, '$eq', x, cond)));
    case '$nin': return !opMatch(vals, '$in', arg, cond);
    case '$exists': return (arg.t === 'bool' ? arg.v : num(arg) !== 0) === vals.length > 0;
    case '$type': return all.some((v) => (arg.t === 'array' ? arg.v.some((a) => typeMatches(v, a)) : typeMatches(v, arg)));
    case '$regex': {
      const opts = cond.v.find(([k]) => k === '$options')?.[1];
      const re = arg.t === 'regex' ? new RegExp(arg.pattern, (opts?.t === 'string' ? opts.v : arg.flags).replace(/[^gimsuy]/g, '')) : arg.t === 'string' ? new RegExp(arg.v, opts?.t === 'string' ? opts.v.replace(/[^gimsuy]/g, '') : '') : null;
      return !!re && all.some((v) => v.t === 'string' && re.test(v.v));
    }
    case '$options': return true;
    case '$size': return vals.some((v) => v.t === 'array' && v.v.length === num(arg));
    case '$all': return arg.t === 'array' && arg.v.every((x) => all.some((v) => eq(v, x)));
    case '$elemMatch': return arg.t === 'object' && vals.some((v) => v.t === 'array' && v.v.some((e) => (isOperatorDoc(arg) ? condMatches([e], arg) : e.t === 'object' && matches(e, arg))));
    case '$not': return arg.t === 'object' ? !condMatches(vals, arg) : arg.t === 'regex' ? !all.some((v) => v.t === 'string' && regexOf(arg)!.test(v.v)) : true;
    case '$mod': return arg.t === 'array' && all.some((v) => num(v) !== null && num(v)! % num(arg.v[0])! === num(arg.v[1]));
    default: throw new MockQueryError(`unknown operator: ${op}`);
  }
}

class MockQueryError extends Error {}

function condMatches(vals: BsonValue[], cond: BsonDoc): boolean {
  return cond.v.every(([op, arg]) => opMatch(vals, op, arg, cond));
}

function isOperatorDoc(v: BsonValue): v is BsonDoc {
  return v.t === 'object' && v.v.length > 0 && v.v.every(([k]) => k.startsWith('$'));
}

export function matches(doc: BsonValue, filter: BsonDoc): boolean {
  return filter.v.every(([k, v]) => {
    switch (k) {
      case '$and': return v.t === 'array' && v.v.every((f) => f.t === 'object' && matches(doc, f));
      case '$or': return v.t === 'array' && v.v.some((f) => f.t === 'object' && matches(doc, f));
      case '$nor': return v.t === 'array' && !v.v.some((f) => f.t === 'object' && matches(doc, f));
      case '$comment': return true;
      case '$expr': return truthy(evalExpr(doc, v));
      case '$text': {
        const s = getPath(v, '$search');
        const words = s?.t === 'string' ? s.v.toLowerCase().split(/\s+/).filter(Boolean) : [];
        return words.some((w) => JSON.stringify(toEjsonJson(doc)).toLowerCase().includes(w));
      }
      case '$jsonSchema': case '$where': return true;
    }
    if (k.startsWith('$')) throw new MockQueryError(`unknown top level operator: ${k}`);
    const vals = valuesAt(doc, k);
    if (isOperatorDoc(v)) return condMatches(vals, v);
    if (v.t === 'regex') return expand(vals).some((x) => x.t === 'string' && regexOf(v)!.test(x.v));
    return opMatch(vals, '$eq', v, B.doc([]));
  });
}

function truthy(v: BsonValue | undefined): boolean {
  if (!v) return false;
  if (v.t === 'bool') return v.v;
  if (v.t === 'null' || v.t === 'undefined') return false;
  const n = num(v);
  return n === null ? true : n !== 0;
}

function evalExpr(doc: BsonValue, e: BsonValue): BsonValue {
  if (e.t === 'string' && e.v.startsWith('$') && !e.v.startsWith('$$')) {
    const vals = valuesAt(doc, e.v.slice(1));
    const direct = getPath(doc, e.v.slice(1));
    return direct ?? (vals.length > 1 ? B.arr(vals) : vals[0] ?? { t: 'null' });
  }
  if (e.t === 'array') return B.arr(e.v.map((x) => evalExpr(doc, x)));
  if (e.t !== 'object') return e;
  if (e.v.length === 1 && e.v[0][0].startsWith('$')) {
    const [op, arg] = e.v[0];
    const args = arg.t === 'array' ? arg.v.map((x) => evalExpr(doc, x)) : [evalExpr(doc, arg)];
    const nums = args.map((a) => num(a) ?? 0);
    switch (op) {
      case '$literal': return arg;
      case '$add': return B.double(nums.reduce((a, b) => a + b, 0));
      case '$subtract': return B.double(nums[0] - nums[1]);
      case '$multiply': return B.double(nums.reduce((a, b) => a * b, 1));
      case '$divide': return B.double(nums[0] / nums[1]);
      case '$round': return B.double(Math.round(nums[0] * 10 ** (nums[1] ?? 0)) / 10 ** (nums[1] ?? 0));
      case '$concat': return B.str(args.map((a) => (a.t === 'string' ? a.v : '')).join(''));
      case '$toUpper': return B.str(args[0].t === 'string' ? args[0].v.toUpperCase() : '');
      case '$toLower': return B.str(args[0].t === 'string' ? args[0].v.toLowerCase() : '');
      case '$size': return B.int(args[0].t === 'array' ? args[0].v.length : 0);
      case '$sum': {
        const flat = args.flatMap((a) => (a.t === 'array' ? a.v : [a]));
        return B.double(flat.reduce((s, a) => s + (num(a) ?? 0), 0));
      }
      case '$year': return B.int(args[0].t === 'date' ? new Date(args[0].v).getUTCFullYear() : 0);
      case '$month': return B.int(args[0].t === 'date' ? new Date(args[0].v).getUTCMonth() + 1 : 0);
      case '$toString': return B.str(args[0].t === 'objectId' || args[0].t === 'string' ? args[0].v : JSON.stringify(toEjsonJson(args[0], 'relaxed')));
      case '$eq': return B.bool(compare(args[0], args[1]) === 0);
      case '$gt': return B.bool(compare(args[0], args[1]) > 0);
      case '$gte': return B.bool(compare(args[0], args[1]) >= 0);
      case '$lt': return B.bool(compare(args[0], args[1]) < 0);
      case '$lte': return B.bool(compare(args[0], args[1]) <= 0);
      case '$ne': return B.bool(compare(args[0], args[1]) !== 0);
      case '$and': return B.bool(args.every(truthy));
      case '$or': return B.bool(args.some(truthy));
      case '$ifNull': return args[0].t === 'null' ? args[1] : args[0];
      case '$arrayElemAt': return args[0].t === 'array' ? args[0].v[num(args[1]) ?? 0] ?? { t: 'null' } : { t: 'null' };
      case '$type': return B.str(args[0].t === 'object' ? 'object' : args[0].t);
      default: return { t: 'null' };
    }
  }
  return { t: 'object', v: e.v.map(([k, x]) => [k, evalExpr(doc, x)] as BsonEntry) };
}

function setPath(doc: BsonDoc, path: string, value: BsonValue): BsonDoc {
  const [head, ...rest] = path.split('.');
  if (!rest.length) {
    const i = doc.v.findIndex(([k]) => k === head);
    const v = [...doc.v];
    if (i >= 0) v[i] = [head, value];
    else v.push([head, value]);
    return { t: 'object', v };
  }
  const cur = doc.v.find(([k]) => k === head)?.[1];
  return setPath(doc, head, setPath(cur?.t === 'object' ? cur : B.doc([]), rest.join('.'), value));
}

function unsetPath(doc: BsonDoc, path: string): BsonDoc {
  const [head, ...rest] = path.split('.');
  if (!rest.length) return { t: 'object', v: doc.v.filter(([k]) => k !== head) };
  return { t: 'object', v: doc.v.map(([k, x]) => [k, k === head && x.t === 'object' ? unsetPath(x, rest.join('.')) : x] as BsonEntry) };
}

export function project(doc: BsonDoc, proj: BsonDoc): BsonDoc {
  if (!proj.v.length) return doc;
  const nonId = proj.v.filter(([k]) => k !== '_id');
  const isInclusion = nonId.some(([, v]) => (num(v) !== null && num(v) !== 0) || (v.t === 'bool' && v.v) || v.t === 'string' || v.t === 'object');
  const idSpec = proj.v.find(([k]) => k === '_id')?.[1];
  const keepId = !idSpec || truthy(idSpec);
  if (isInclusion) {
    let out = B.doc([]);
    if (keepId && getPath(doc, '_id')) out = setPath(out, '_id', getPath(doc, '_id')!);
    for (const [k, v] of nonId) {
      if (v.t === 'string' || v.t === 'object') out = setPath(out, k, evalExpr(doc, v));
      else if (truthy(v)) {
        const x = getPath(doc, k);
        if (x !== undefined) out = setPath(out, k, x);
      }
    }
    return out;
  }
  let out = doc;
  for (const [k] of nonId) out = unsetPath(out, k);
  if (!keepId) out = unsetPath(out, '_id');
  return out;
}

export function sortDocs(docs: BsonDoc[], sort: BsonDoc): BsonDoc[] {
  if (!sort.v.length) return docs;
  return [...docs].sort((a, b) => {
    for (const [k, dir] of sort.v) {
      const c = compare(getPath(a, k), getPath(b, k));
      if (c) return (num(dir) ?? 1) < 0 ? -c : c;
    }
    return 0;
  });
}

function accumulate(op: string, arg: BsonValue, group: BsonDoc[]): BsonValue {
  const vals = group.map((d) => evalExpr(d, arg));
  const nums = vals.map(num).filter((n): n is number => n !== null);
  switch (op) {
    case '$sum': return arg.t !== 'string' && num(arg) !== null ? numberValue(group.length * num(arg)!) : B.double(nums.reduce((a, b) => a + b, 0));
    case '$avg': return nums.length ? B.double(nums.reduce((a, b) => a + b, 0) / nums.length) : { t: 'null' };
    case '$min': return vals.reduce((m, v) => (compare(v, m) < 0 ? v : m), vals[0] ?? { t: 'null' });
    case '$max': return vals.reduce((m, v) => (compare(v, m) > 0 ? v : m), vals[0] ?? { t: 'null' });
    case '$first': return vals[0] ?? { t: 'null' };
    case '$last': return vals[vals.length - 1] ?? { t: 'null' };
    case '$push': return B.arr(vals);
    case '$addToSet': {
      const seen = new Set<string>();
      return B.arr(vals.filter((v) => (seen.has(ejson(v)) ? false : (seen.add(ejson(v)), true))));
    }
    case '$count': return B.int(group.length);
    default: throw new MockQueryError(`unknown group operator '${op}'`);
  }
}

export function runPipeline(dep: MockDeployment, db: string, input: BsonDoc[], pipeline: BsonValue[]): BsonDoc[] {
  let docs = input;
  for (const stage of pipeline) {
    if (stage.t !== 'object' || stage.v.length !== 1) throw new MockQueryError('A pipeline stage specification object must contain exactly one field.');
    const [name, arg] = stage.v[0];
    switch (name) {
      case '$match': docs = docs.filter((d) => matches(d, arg as BsonDoc)); break;
      case '$project': docs = docs.map((d) => project(d, arg as BsonDoc)); break;
      case '$addFields': case '$set':
        docs = docs.map((d) => (arg as BsonDoc).v.reduce((acc, [k, e]) => setPath(acc, k, evalExpr(d, e)), d));
        break;
      case '$unset': {
        const fields = arg.t === 'array' ? arg.v.map((x) => (x.t === 'string' ? x.v : '')) : arg.t === 'string' ? [arg.v] : [];
        docs = docs.map((d) => fields.reduce((acc, f) => unsetPath(acc, f), d));
        break;
      }
      case '$sort': docs = sortDocs(docs, arg as BsonDoc); break;
      case '$skip': docs = docs.slice(num(arg) ?? 0); break;
      case '$limit': docs = docs.slice(0, num(arg) ?? 0); break;
      case '$sample': docs = docs.slice(0, num(getPath(arg, 'size') ?? B.int(0)) ?? 0); break;
      case '$count': docs = [B.doc([[arg.t === 'string' ? arg.v : 'count', B.int(docs.length)]])]; break;
      case '$unwind': {
        const path = (arg.t === 'string' ? arg.v : (getPath(arg, 'path') as { v: string } | undefined)?.v ?? '').replace(/^\$/, '');
        const keep = arg.t === 'object' && truthy(getPath(arg, 'preserveNullAndEmptyArrays'));
        docs = docs.flatMap((d) => {
          const v = getPath(d, path);
          if (v?.t === 'array') return v.v.length ? v.v.map((e) => setPath(d, path, e)) : keep ? [d] : [];
          return v === undefined || v.t === 'null' ? (keep ? [d] : []) : [d];
        });
        break;
      }
      case '$group': {
        const spec = arg as BsonDoc;
        const idExpr = getPath(spec, '_id') ?? { t: 'null' };
        const groups = new Map<string, { id: BsonValue; docs: BsonDoc[] }>();
        for (const d of docs) {
          const id = evalExpr(d, idExpr);
          const k = ejson(id);
          if (!groups.has(k)) groups.set(k, { id, docs: [] });
          groups.get(k)!.docs.push(d);
        }
        docs = [...groups.values()].map((g) => B.doc([['_id', g.id], ...spec.v.filter(([k]) => k !== '_id').map(([k, acc]) => {
          const [op, a] = acc.t === 'object' && acc.v.length === 1 ? acc.v[0] : ['$first', acc];
          return [k, accumulate(op, a, g.docs)] as BsonEntry;
        })]));
        break;
      }
      case '$sortByCount': {
        docs = runPipeline(dep, db, docs, [B.doc([['$group', B.doc([['_id', arg], ['count', B.doc([['$sum', B.int(1)]])]])]]), B.doc([['$sort', B.doc([['count', B.int(-1)]])]])]);
        break;
      }
      case '$replaceRoot': case '$replaceWith': {
        const e = name === '$replaceRoot' ? getPath(arg, 'newRoot') ?? arg : arg;
        docs = docs.map((d) => {
          const v = evalExpr(d, e);
          if (v.t !== 'object') throw new MockQueryError(`'newRoot' expression must evaluate to an object, but resulting value was of type ${v.t}`);
          return v;
        });
        break;
      }
      case '$lookup': {
        const from = getPath(arg, 'from');
        const lf = getPath(arg, 'localField');
        const ff = getPath(arg, 'foreignField');
        const as = getPath(arg, 'as');
        const other = from?.t === 'string' ? collDocs(dep, db, from.v) : [];
        docs = docs.map((d) => setPath(d, as?.t === 'string' ? as.v : 'joined', B.arr(other.filter((o) => {
          const a = lf?.t === 'string' ? getPath(d, lf.v) : undefined;
          const b = ff?.t === 'string' ? getPath(o, ff.v) : undefined;
          return a !== undefined && b !== undefined && compare(a, b) === 0;
        }))));
        break;
      }
      case '$facet': {
        const out = (arg as BsonDoc).v.map(([k, sub]) => [k, B.arr(runPipeline(dep, db, docs, sub.t === 'array' ? sub.v : []))] as BsonEntry);
        docs = [B.doc(out)];
        break;
      }
      case '$out': case '$merge': break;
      default:
        throw new MockQueryError(`Unrecognized pipeline stage name: '${name}'`);
    }
  }
  return docs;
}

function collDocs(dep: MockDeployment, db: string, coll: string): BsonDoc[] {
  const c = dep.get(db)?.get(coll);
  if (!c) return [];
  if (c.type === 'view' && c.viewOn) return runPipeline(dep, db, collDocs(dep, db, c.viewOn), c.pipeline ?? []);
  return c.docs;
}

// ---------------------------------------------------------------------------------------------------------------
// schema analysis and fields (mirrors the engine services)

function typeAlias(v: BsonValue): string {
  return v.t === 'trunc' ? 'string' : v.t;
}

interface Acc { count: number; types: Map<string, number>; examples: BsonValue[]; nested: Map<string, Acc>; min?: BsonValue; max?: BsonValue; distinct: Set<string> }

function newAcc(): Acc {
  return { count: 0, types: new Map(), examples: [], nested: new Map(), distinct: new Set() };
}

function addValue(acc: Acc, v: BsonValue) {
  acc.types.set(typeAlias(v), (acc.types.get(typeAlias(v)) ?? 0) + 1);
  const key = ejson(v);
  if (v.t !== 'object' && v.t !== 'array') {
    if (acc.distinct.size < 1000) acc.distinct.add(key);
    if (acc.examples.length < 5 && !acc.examples.some((e) => ejson(e) === key)) acc.examples.push(v);
    if (num(v) !== null || v.t === 'date' || v.t === 'string') {
      if (!acc.min || compare(v, acc.min) < 0) acc.min = v;
      if (!acc.max || compare(v, acc.max) > 0) acc.max = v;
    }
  }
}

function walkDoc(doc: BsonDoc, into: Map<string, Acc>) {
  for (const [k, v] of doc.v) {
    let acc = into.get(k);
    if (!acc) into.set(k, (acc = newAcc()));
    acc.count++;
    addValue(acc, v);
    if (v.t === 'object') walkDoc(v, acc.nested);
    if (v.t === 'array') for (const e of v.v) if (e.t === 'object') walkDoc(e, acc.nested);
  }
}

function relaxed(v: BsonValue): unknown {
  if (v.t === 'string' && v.v.length > 100) return `${v.v.slice(0, 100)}…`;
  return toEjsonJson(v, 'relaxed');
}

function toFields(m: Map<string, Acc>, parentCount: number, prefix: string): MongoSchemaField[] {
  return [...m.entries()].map(([k, a]) => {
    const total = [...a.types.values()].reduce((x, y) => x + y, 0);
    const f: MongoSchemaField = {
      path: prefix + k,
      types: [...a.types.entries()].sort((x, y) => y[1] - x[1]).map(([bsonType, count]) => ({ bsonType, count, pct: Math.round((count / total) * 1000) / 10 })),
      probability: Math.min(1, a.count / Math.max(1, parentCount)),
      nested: toFields(a.nested, a.count, `${prefix}${k}.`),
      examples: a.examples.map(relaxed),
    };
    if (a.min && a.max) f.stats = { min: relaxed(a.min), max: relaxed(a.max), distinct: a.distinct.size };
    return f;
  });
}

export function analyzeSchema(docs: BsonDoc[]) {
  const root = new Map<string, Acc>();
  for (const d of docs) walkDoc(d, root);
  return { sampled: docs.length, fields: toFields(root, docs.length, '') };
}

export function fieldPaths(docs: BsonDoc[]): MongoFieldPath[] {
  const out: MongoFieldPath[] = [];
  const walk = (m: Map<string, Acc>, prefix: string) => {
    for (const [k, a] of m) {
      const path = prefix + k;
      const types = [...a.types.keys()];
      const enumerable = path !== '_id' && types.every((t) => ['string', 'bool', 'int', 'long'].includes(t)) && a.distinct.size <= 20 && a.distinct.size < a.count / 2;
      out.push({ path, types, values: enumerable ? [...a.distinct] : null });
      walk(a.nested, `${path}.`);
    }
  };
  const root = new Map<string, Acc>();
  for (const d of docs) walkDoc(d, root);
  walk(root, '');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// explain

function explainTree(c: MockColl, ns: string, filter: BsonDoc, sort: BsonDoc, matched: number, verbosity: string, limit: number) {
  const firstKey = filter.v.find(([k]) => !k.startsWith('$'))?.[0];
  const index = c.indexes.find((i) => i.key[0]?.field === firstKey && i.key[0].type !== 'text');
  const stats = verbosity !== 'queryPlanner';
  let id = 0;
  const node = (op: string, extra: Partial<PlanNode> = {}, props: Record<string, string> = {}, children: PlanNode[] = []): PlanNode => ({
    id: 0, op, logicalOp: null, object: null, estRows: null, actualRows: null, cost: null, costPct: null, predicate: null, warnings: [], props, children, ...extra,
  });
  const returned = Math.min(matched, limit || matched);
  let leaf: PlanNode;
  let docsExamined: number;
  let keysExamined: number;
  if (index) {
    keysExamined = matched;
    docsExamined = matched;
    const ix = node('IXSCAN', { object: index.name, actualRows: stats ? matched : null, predicate: `${firstKey}: [${JSON.stringify(toEjsonJson(getPath(filter, firstKey!) ?? B.null(), 'relaxed'))}]` },
      { keyPattern: JSON.stringify(Object.fromEntries(index.key.map((k) => [k.field, k.type]))), indexBounds: JSON.stringify({ [firstKey!]: ['[…]'] }), isMultiKey: 'false', direction: 'forward', ...(stats ? { keysExamined: String(matched), executionTimeMillisEstimate: '0' } : {}) });
    leaf = node('FETCH', { actualRows: stats ? matched : null, predicate: filter.v.length > 1 ? JSON.stringify(toEjsonJson(B.doc(filter.v.slice(1)), 'relaxed')) : null }, stats ? { docsExamined: String(matched), executionTimeMillisEstimate: '0' } : {}, [ix]);
  } else {
    keysExamined = 0;
    docsExamined = c.docs.length;
    leaf = node('COLLSCAN', { object: ns, actualRows: stats ? matched : null, predicate: filter.v.length ? JSON.stringify(toEjsonJson(filter, 'relaxed')) : null, warnings: ['Collection scan'] },
      { direction: 'forward', ...(stats ? { docsExamined: String(c.docs.length), executionTimeMillisEstimate: String(Math.max(1, Math.round(c.docs.length / 200))) } : {}) });
  }
  let root = leaf;
  const sortInMemory = sort.v.length > 0 && !(index && index.key.some((k) => k.field === sort.v[0][0]));
  if (sortInMemory) root = node('SORT', { actualRows: stats ? returned : null, predicate: JSON.stringify(toEjsonJson(sort, 'relaxed')), warnings: ['In-memory sort'] }, { memLimit: '104857600', type: 'simple' }, [root]);
  if (limit) root = node('LIMIT', { actualRows: stats ? returned : null }, { limitAmount: String(limit) }, [root]);
  const number = (n: PlanNode) => {
    n.id = ++id;
    n.children.forEach(number);
  };
  number(root);
  root.props = { ...root.props, rejectedPlans: index ? '1' : '0' };
  const warnings: string[] = [];
  if (!index) warnings.push('Collection scan: no index was used to find the documents.');
  if (stats && docsExamined / Math.max(1, returned) > 10) warnings.push(`Examined ${docsExamined} documents to return ${returned} (${Math.round(docsExamined / Math.max(1, returned))}×).`);
  if (sortInMemory) warnings.push('Sort in memory: add an index that matches the sort.');
  if (index) warnings.push('1 rejected plan(s).');
  return {
    root, warnings,
    summary: {
      nReturned: stats ? returned : null, docsExamined: stats ? docsExamined : null, keysExamined: stats ? keysExamined : null,
      executionTimeMs: stats ? Math.max(1, Math.round(docsExamined / 200)) : null, indexes: index ? [index.name] : [], collscan: !index, sortInMemory, rejectedPlans: index ? 1 : 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CSV

export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === delimiter) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

type CsvType = 'string' | 'number' | 'boolean' | 'date' | 'objectId';

function inferType(values: string[]): CsvType {
  const vs = values.filter((v) => v !== '');
  if (!vs.length) return 'string';
  if (vs.every((v) => /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v))) return 'number';
  if (vs.every((v) => /^(true|false)$/i.test(v))) return 'boolean';
  if (vs.every((v) => /^[0-9a-f]{24}$/i.test(v))) return 'objectId';
  if (vs.every((v) => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v))) return 'date';
  return 'string';
}

function convert(v: string, t: CsvType): BsonValue {
  switch (t) {
    case 'number': {
      if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) throw new Error(`'${v}' is not a number`);
      return /[.eE]/.test(v) ? B.double(Number(v)) : numberValue(Number(v));
    }
    case 'boolean':
      if (!/^(true|false)$/i.test(v)) throw new Error(`'${v}' is not a boolean`);
      return B.bool(/^true$/i.test(v));
    case 'objectId':
      if (!/^[0-9a-f]{24}$/i.test(v)) throw new Error(`'${v}' is not an ObjectId`);
      return B.oid(v);
    case 'date': {
      const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) || v.length === 10 ? v : `${v}Z`);
      if (Number.isNaN(ms)) throw new Error(`'${v}' is not a date`);
      return B.date(ms);
    }
    default: return B.str(v);
  }
}

interface ParsedImport { docs: BsonDoc[]; columns: { name: string; inferredType: CsvType }[] | null; errors: MongoImportError[] }

function parseImport(req: MongoImportRequest, max = Infinity): ParsedImport {
  const text = req.upload ?? '';
  const errors: MongoImportError[] = [];
  const docs: BsonDoc[] = [];
  if (req.format === 'csv') {
    const csv = req.csv ?? { header: true, delimiter: ',', typeInference: true };
    const rows = parseCsv(text, csv.delimiter === '\\t' ? '\t' : csv.delimiter || ',');
    const header = csv.header ? rows.shift() ?? [] : (rows[0] ?? []).map((_, i) => `field${i + 1}`);
    const sample = rows.slice(0, 20);
    const columns = header.map((name, i) => ({ name, inferredType: csv.typeInference ? inferType(sample.map((r) => r[i] ?? '')) : ('string' as CsvType) }));
    rows.forEach((r, ri) => {
      if (docs.length >= max) return;
      try {
        let d = B.doc([]);
        columns.forEach((c, i) => {
          const raw = r[i] ?? '';
          if (raw === '') return;
          const t = (csv.types?.[c.name] ?? c.inferredType) as CsvType;
          try {
            d = setPath(d, c.name, convert(raw, t));
          } catch (e) {
            throw new Error(`row ${ri + 1}: ${(e as Error).message} for column ${c.name}`);
          }
        });
        docs.push(d);
      } catch (e) {
        errors.push({ index: ri, message: (e as Error).message });
      }
    });
    return { docs, columns, errors };
  }
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith('[')) {
      const v = parseShell(trimmed);
      if (v.t === 'array') v.v.forEach((x, i) => (x.t === 'object' ? docs.push(x) : errors.push({ index: i, message: 'not a document' })));
    } else {
      trimmed.split(/\r?\n/).filter((l) => l.trim()).forEach((line, i) => {
        try {
          docs.push(parseShellDoc(line));
        } catch (e) {
          errors.push({ index: i, message: (e as Error).message });
        }
      });
    }
  } catch (e) {
    errors.push({ index: 0, message: (e as Error).message });
  }
  return { docs: docs.slice(0, max), columns: null, errors };
}

// ---------------------------------------------------------------------------------------------------------------
// export

function flatten(v: BsonValue, prefix: string, out: Map<string, string>) {
  if (v.t === 'object' && v.v.length) {
    for (const [k, x] of v.v) flatten(x, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  let s: string;
  switch (v.t) {
    case 'string': s = v.v; break;
    case 'objectId': s = v.v; break;
    case 'date': s = new Date(v.v).toISOString(); break;
    case 'null': s = ''; break;
    case 'long': case 'decimal': s = v.v; break;
    case 'int': case 'double': s = String(v.v); break;
    case 'bool': s = String(v.v); break;
    case 'binData': s = v.v; break;
    default: s = JSON.stringify(toEjsonJson(v, 'relaxed'));
  }
  out.set(prefix, s);
}

function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportText(docs: BsonDoc[], req: MongoExportRequest): string {
  const mode = req.ejsonMode ?? 'relaxed';
  if (req.format === 'json') return `[\n${docs.map((d) => `  ${JSON.stringify(toEjsonJson(d, mode))}`).join(',\n')}\n]\n`;
  if (req.format === 'jsonl') return docs.map((d) => JSON.stringify(toEjsonJson(d, mode))).join('\n') + '\n';
  const flat = docs.map((d) => {
    const m = new Map<string, string>();
    flatten(d, '', m);
    return m;
  });
  const cols = req.fields?.length ? req.fields : [...new Set(flat.flatMap((m) => [...m.keys()]))];
  return [cols.map(csvCell).join(','), ...flat.map((m) => cols.map((c) => csvCell(m.get(c) ?? '')).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// handlers

function err(status: number, code: string, message: string, detail?: unknown) {
  return HttpResponse.json({ error: { code, message, detail } }, { status });
}

class HttpError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function parseField(text: string | null | undefined, field: string): BsonDoc {
  try {
    return parseShellDoc(text ?? '');
  } catch (e) {
    if (e instanceof ShellJsonError) throw new HttpError(400, 'VALIDATION', `${field}: ${e.message}`, { field, offset: e.offset, line: e.line, col: e.col });
    throw e;
  }
}

function parseValue(text: string, field: string): BsonValue {
  try {
    return parseShell(text);
  } catch (e) {
    if (e instanceof ShellJsonError) throw new HttpError(400, 'VALIDATION', `${field}: ${e.message}`, { field });
    throw e;
  }
}

type ChangeListener = (item: Record<string, unknown>) => void;

export function createMongoHandlers(ctx: M2MockContext): RequestHandler[] {
  const dep = createMongoFixture();
  const listeners = new Set<{ db: string; coll: string | null; fn: ChangeListener }>();
  const P = `${M2_PREFIX}/mongo/:cid`;

  const notify = (db: string, coll: string, operationType: string, doc: BsonDoc | null, id: BsonValue) => {
    for (const l of listeners) {
      if (l.db !== db || (l.coll && l.coll !== coll)) continue;
      l.fn({
        ts: new Date().toISOString(), operationType, ns: { db, coll }, documentKey: ejson(B.doc([['_id', id]])),
        fullDocument: doc ? ejson(doc, true) : null,
        updateDescription: operationType === 'update' && doc ? { updatedFields: ejson(B.doc([['status', getPath(doc, 'status') ?? B.null()]])), removedFields: [] } : null,
      });
    }
  };

  ctx.streams.register('mongo.changes', ({ params, push, signal, end }) => {
    const db = String(params.db ?? '');
    const coll = params.coll ? String(params.coll) : null;
    if (!dep.has(db)) {
      end(`Database '${db}' does not exist.`);
      return;
    }
    const l = { db, coll, fn: (item: Record<string, unknown>) => push([item]) };
    listeners.add(l);
    // a little life: every few seconds an order changes status
    const timer = (coll === 'orders' || coll === null) && db === 'shop' && params.simulate !== false
      ? setInterval(() => {
        const c = dep.get('shop')!.get('orders')!;
        const i = Math.floor(Math.random() * c.docs.length);
        const next = getPath(c.docs[i], 'status')?.t === 'string' && (getPath(c.docs[i], 'status') as { v: string }).v === 'paid' ? 'shipped' : 'paid';
        c.docs[i] = setPath(c.docs[i], 'status', B.str(next));
        notify('shop', 'orders', 'update', c.docs[i], getPath(c.docs[i], '_id')!);
      }, 2500)
      : null;
    signal.addEventListener('abort', () => {
      listeners.delete(l);
      if (timer) clearInterval(timer);
    });
  });

  /** Wraps a handler: source client check, error mapping, latency. */
  const route = <T,>(fn: (a: { cid: string; db: string; coll: string; params: Record<string, string>; request: Request; body: T }) => Promise<Response> | Response) =>
    async ({ params, request }: { params: Record<string, string | readonly string[] | undefined>; request: Request }) => {
      const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, decodeURIComponent(String(v ?? ''))]));
      const client = ctx.clients.get(p.cid);
      if (!('connectionId' in client)) return err(client.status, client.code, client.message);
      let body = {} as T;
      if (request.method !== 'GET' && request.headers.get('content-type')?.includes('json')) body = (await request.json().catch(() => ({}))) as T;
      try {
        return await fn({ cid: p.cid, db: p.db ?? '', coll: p.coll ?? '', params: p, request, body });
      } catch (e) {
        if (e instanceof HttpError) return err(e.status, e.code, e.message, e.detail);
        if (e instanceof MockQueryError) return err(422, 'PROVIDER_ERROR', e.message, { providerCode: 2, codeName: 'BadValue' });
        throw e;
      }
    };

  const profiling = new Map<string, MongoProfiling>();
  const readOnly = (cid: string, action: string) => {
    const c = ctx.engine.conn(cid);
    if (c?.readOnly) throw new HttpError(403, 'READ_ONLY', `The connection '${c.name}' is read-only: ${action} is not allowed.`, { action });
  };
  const getDb = (db: string) => {
    const d = dep.get(db);
    if (!d) throw new HttpError(404, 'NOT_FOUND', `Database '${db}' was not found.`);
    return d;
  };
  const getColl = (db: string, coll: string) => {
    const c = getDb(db).get(coll);
    if (!c) throw new HttpError(404, 'NOT_FOUND', `Collection '${db}.${coll}' was not found.`);
    return c;
  };
  const idOf = (text: string) => parseValue(text, '_id');
  const nameCheck = (name: string, field: string) => {
    if (!name || /[$\0]/.test(name) || name.startsWith('system.')) throw new HttpError(400, 'VALIDATION', `${field} is not a valid collection name.`, { field });
  };

  return [
    http.get(`${P}/server`, route(() => ctx.ok({
      server: { version: 'MongoDB 7.0.14 (replica set rs0)', productVersion: '7.0.14', serverName: 'mongo-dev:27017', user: null, database: null },
      type: 'replicaSet', setName: 'rs0', members: [{ host: 'mongo-dev:27017', state: 'PRIMARY', health: true }], isAtlas: false, maxWireVersion: 21,
    }))),
    http.get(`${P}/databases`, route(({ cid }) => {
      const conf = ctx.engine.conn(cid)?.props.database;
      const names = [...dep.keys()].filter((n) => !conf || n === conf);
      return ctx.ok(names.map((name) => ({ name, sizeOnDisk: [...dep.get(name)!.values()].reduce((s, c) => s + c.docs.length * 412, 8192), empty: dep.get(name)!.size === 0 })));
    })),
    http.get(`${P}/db/:db/collections`, route(({ db }) => {
      const list: MongoCollectionInfo[] = [...getDb(db).entries()].map(([name, c]) => ({
        name, type: c.type, count: c.type === 'view' ? null : c.docs.length, readOnly: c.type === 'view', viewOn: c.viewOn ?? null,
      }));
      return ctx.ok(list.sort((a, b) => a.name.localeCompare(b.name)));
    })),
    http.post(`${P}/db/:db/collections`, route<MongoCreateCollectionRequest>(({ cid, db, body }) => {
      readOnly(cid, 'create a collection');
      nameCheck(body.name, 'name');
      let d = dep.get(db);
      if (!d) dep.set(db, (d = new Map()));
      if (d.has(body.name)) throw new HttpError(422, 'PROVIDER_ERROR', `Collection ${db}.${body.name} already exists.`, { providerCode: 48, codeName: 'NamespaceExists' });
      const o = body.options ?? {};
      d.set(body.name, o.viewOn
        ? { type: 'view', docs: [], indexes: [], validation: NO_VALIDATION, viewOn: o.viewOn, pipeline: (o.pipeline ?? []).map((s) => parseValue(s, 'pipeline')) }
        : { type: o.timeseries ? 'timeseries' : 'collection', docs: [], indexes: o.timeseries ? [] : [idIndex()], validation: o.validator ? { validator: ejson(parseValue(o.validator, 'validator')), level: 'strict', action: 'error' } : NO_VALIDATION });
      return new HttpResponse(null, { status: 204 });
    })),
    http.delete(`${P}/db/:db`, route(({ cid, db }) => {
      readOnly(cid, 'drop a database');
      getDb(db);
      dep.delete(db);
      return new HttpResponse(null, { status: 204 });
    })),
    http.delete(`${P}/db/:db/coll/:coll`, route(({ cid, db, coll }) => {
      readOnly(cid, 'drop a collection');
      getColl(db, coll);
      getDb(db).delete(coll);
      return new HttpResponse(null, { status: 204 });
    })),
    http.post(`${P}/db/:db/coll/:coll/rename`, route<{ newName: string; dropTarget: boolean }>(({ cid, db, coll, body }) => {
      readOnly(cid, 'rename a collection');
      nameCheck(body.newName, 'newName');
      const d = getDb(db);
      const c = getColl(db, coll);
      if (d.has(body.newName) && !body.dropTarget) throw new HttpError(422, 'PROVIDER_ERROR', 'target namespace exists', { providerCode: 48, codeName: 'NamespaceExists' });
      d.delete(coll);
      d.set(body.newName, c);
      return new HttpResponse(null, { status: 204 });
    })),
    http.get(`${P}/db/:db/coll/:coll/stats`, route(({ db, coll }) => {
      const c = getColl(db, coll);
      const docs = collDocs(dep, db, coll);
      const size = docs.reduce((s, d) => s + ejson(d).length, 0);
      return ctx.ok({ count: docs.length, size, avgObjSize: docs.length ? Math.round(size / docs.length) : null, storageSize: c.type === 'view' ? null : Math.round(size * 0.45), indexes: c.indexes.length, totalIndexSize: c.indexes.reduce((s, i) => s + (i.size ?? 0), 0) });
    })),
    http.post(`${P}/db/:db/coll/:coll/fields`, route<{ sampleSize?: number; filter?: string | null }>(({ db, coll, body }) => {
      getColl(db, coll);
      const filter = parseField(body.filter, 'filter');
      const docs = collDocs(dep, db, coll).filter((d) => matches(d, filter)).slice(0, body.sampleSize ?? 500);
      return ctx.ok({ sampled: docs.length, fields: fieldPaths(docs) });
    })),
    http.post(`${P}/db/:db/coll/:coll/find`, route<MongoFindRequest>(({ db, coll, body }) => {
      getColl(db, coll);
      if (!(body.limit >= 1 && body.limit <= 1000)) throw new HttpError(400, 'VALIDATION', 'limit must be between 1 and 1000.', { field: 'limit' });
      if (body.skip < 0) throw new HttpError(400, 'VALIDATION', 'skip must be 0 or more.', { field: 'skip' });
      const filter = parseField(body.filter, 'filter');
      const projection = parseField(body.projection, 'projection');
      const sort = parseField(body.sort, 'sort');
      parseField(body.collation, 'collation');
      const all = collDocs(dep, db, coll);
      const hit = sortDocs(filter.v.length ? all.filter((d) => matches(d, filter)) : all, sort);
      const page = hit.slice(body.skip, body.skip + body.limit).map((d) => project(d, projection));
      // a "slow" count on huge filters is simulated with $where
      const slow = filter.v.some(([k]) => k === '$where');
      return ctx.ok({ docs: page.map((d) => ejson(d, true)), count: slow ? { value: all.length, exact: false } : { value: hit.length, exact: true } });
    })),
    http.get(`${P}/db/:db/coll/:coll/doc`, route(({ db, coll, request }) => {
      getColl(db, coll);
      const id = idOf(new URL(request.url).searchParams.get('_id') ?? '');
      const d = collDocs(dep, db, coll).find((x) => compare(getPath(x, '_id'), id) === 0);
      return ctx.ok({ doc: d ? ejson(d) : null });
    })),
    http.post(`${P}/db/:db/coll/:coll/docs`, route<{ doc: string }>(({ cid, db, coll, body }) => {
      readOnly(cid, 'insert documents');
      const c = getColl(db, coll);
      if (c.type === 'view') throw new HttpError(422, 'PROVIDER_ERROR', `Namespace ${db}.${coll} is a view, not a collection`, { providerCode: 166, codeName: 'CommandNotSupportedOnView' });
      let d = parseField(body.doc, 'doc');
      let id = getPath(d, '_id');
      if (!id) {
        id = B.oid(oidFrom(Date.now(), Math.floor(Math.random() * 1e12)));
        d = B.doc([['_id', id], ...d.v]);
      }
      if (c.docs.some((x) => compare(getPath(x, '_id'), id) === 0)) {
        throw new HttpError(422, 'PROVIDER_ERROR', `E11000 duplicate key error collection: ${db}.${coll} index: _id_ dup key: { _id: ${ejson(id)} }`, { providerCode: 11000, codeName: 'DuplicateKey' });
      }
      c.docs.push(d);
      notify(db, coll, 'insert', d, id);
      return ctx.ok({ insertedId: ejson(id) });
    })),
    http.put(`${P}/db/:db/coll/:coll/docs`, route<{ _id: string; doc: string }>(({ cid, db, coll, body }) => {
      readOnly(cid, 'replace a document');
      const c = getColl(db, coll);
      const id = idOf(body._id);
      let d = parseField(body.doc, 'doc');
      const docId = getPath(d, '_id');
      if (docId && compare(docId, id) !== 0) throw new HttpError(400, 'VALIDATION', 'Changing _id needs insert + delete.', { field: 'doc._id' });
      if (!docId) d = B.doc([['_id', id], ...d.v]);
      const i = c.docs.findIndex((x) => compare(getPath(x, '_id'), id) === 0);
      if (i < 0) return ctx.ok({ matched: 0, modified: 0 });
      const modified = ejson(c.docs[i]) !== ejson(d) ? 1 : 0;
      c.docs[i] = d;
      notify(db, coll, 'replace', d, id);
      return ctx.ok({ matched: 1, modified });
    })),
    http.delete(`${P}/db/:db/coll/:coll/docs`, route<{ ids: string[] }>(({ cid, db, coll, body }) => {
      readOnly(cid, 'delete documents');
      const c = getColl(db, coll);
      const ids = (body.ids ?? []).map(idOf);
      const before = c.docs.length;
      const gone = c.docs.filter((x) => ids.some((id) => compare(getPath(x, '_id'), id) === 0));
      c.docs = c.docs.filter((x) => !gone.includes(x));
      for (const g of gone) notify(db, coll, 'delete', null, getPath(g, '_id')!);
      return ctx.ok({ deleted: before - c.docs.length });
    })),
    http.post(`${P}/db/:db/coll/:coll/aggregate`, route<MongoAggregateRequest>(({ cid, db, coll, body }) => {
      getColl(db, coll);
      const stages = body.pipeline.map((s, i) => {
        const v = parseValue(s, `pipeline[${i}]`);
        if (v.t !== 'object' || v.v.length !== 1 || !v.v[0][0].startsWith('$')) throw new HttpError(400, 'VALIDATION', `pipeline[${i}]: a stage must be a document with one $stage field.`, { field: `pipeline[${i}]`, stage: i });
        return v;
      });
      let run = body.previewStage != null ? stages.slice(0, body.previewStage + 1) : stages;
      const lastName = (run[run.length - 1] as BsonDoc | undefined)?.v[0][0];
      let writeStageSkipped = false;
      if (lastName === '$out' || lastName === '$merge') {
        if (body.previewStage != null) {
          run = run.slice(0, -1);
          writeStageSkipped = true;
        } else {
          readOnly(cid, 'run $out/$merge');
          const docs = runPipeline(dep, db, collDocs(dep, db, coll), run.slice(0, -1));
          const target = (run[run.length - 1] as BsonDoc).v[0][1];
          const tname = target.t === 'string' ? target.v : (getPath(target, 'into') as { v: string } | undefined)?.v ?? 'out';
          getDb(db).set(tname, { type: 'collection', docs, indexes: [idIndex()], validation: NO_VALIDATION });
          return ctx.ok({ docs: [], truncated: false });
        }
      }
      const out = runPipeline(dep, db, collDocs(dep, db, coll), run);
      const page = out.slice(body.skip ?? 0, (body.skip ?? 0) + body.limit);
      return ctx.ok({ docs: page.map((d) => ejson(d, true)), truncated: out.length > (body.skip ?? 0) + body.limit, ...(writeStageSkipped ? { writeStageSkipped } : {}) });
    })),
    http.post(`${P}/db/:db/coll/:coll/explain`, route<MongoExplainRequest>(({ db, coll, body }) => {
      const c = getColl(db, coll);
      let filter = B.doc([]);
      let sort = B.doc([]);
      let limit = 0;
      if (body.kind === 'find') {
        filter = parseField(body.filter, 'filter');
        sort = parseField(body.sort, 'sort');
        limit = body.limit;
      } else {
        const first = body.pipeline[0] ? parseValue(body.pipeline[0], 'pipeline[0]') : null;
        if (first?.t === 'object' && first.v[0]?.[0] === '$match' && first.v[0][1].t === 'object') filter = first.v[0][1];
      }
      const matched = collDocs(dep, db, coll).filter((d) => matches(d, filter)).length;
      const t = explainTree(c, `${db}.${coll}`, filter, sort, matched, body.verbosity, limit);
      if (body.kind === 'aggregate' && body.pipeline.length > 1) {
        const later = body.pipeline.slice(1).map((s) => {
          const v = parseValue(s, 'pipeline');
          return v.t === 'object' ? v.v[0]?.[0] ?? '$stage' : '$stage';
        });
        let root = t.root;
        let id = 100;
        for (const op of later) root = { id: ++id, op, logicalOp: null, object: null, estRows: null, actualRows: null, cost: null, costPct: null, predicate: null, warnings: [], children: [root] };
        t.root = root;
      }
      const raw = JSON.stringify({ queryPlanner: { namespace: `${db}.${coll}`, winningPlan: { stage: t.root.op } }, executionStats: t.summary }, null, 2);
      return ctx.ok({ raw, root: t.root, warnings: t.warnings, summary: t.summary });
    })),
    http.post(`${P}/db/:db/coll/:coll/schema`, route<{ sampleSize: number; filter?: string | null }>(({ db, coll, body }) => {
      getColl(db, coll);
      const filter = parseField(body.filter, 'filter');
      const docs = collDocs(dep, db, coll).filter((d) => matches(d, filter)).slice(0, body.sampleSize || 1000);
      const jobId = ctx.jobs.start('mongo.schema', async (report) => {
        report(Math.floor(docs.length / 2), docs.length, 'Sampling documents');
        await new Promise((r) => setTimeout(r, 30));
        report(docs.length, docs.length, 'Analyzing');
        return analyzeSchema(docs);
      });
      return ctx.ok({ jobId }, { status: 202 });
    })),
    http.get(`${P}/db/:db/coll/:coll/indexes`, route(({ db, coll }) => ctx.ok(getColl(db, coll).indexes))),
    http.post(`${P}/db/:db/coll/:coll/indexes`, route<MongoCreateIndexRequest>(({ cid, db, coll, body }) => {
      readOnly(cid, 'create an index');
      const c = getColl(db, coll);
      if (!body.key?.length) throw new HttpError(400, 'VALIDATION', 'An index needs at least one key.', { field: 'key' });
      const o = body.options ?? {};
      const name = o.name || body.key.map((k) => `${k.field}_${k.type}`).join('_');
      if (c.indexes.some((i) => i.name === name)) throw new HttpError(422, 'PROVIDER_ERROR', `An index with name '${name}' already exists.`, { providerCode: 86, codeName: 'IndexKeySpecsConflict' });
      const info: MongoIndexInfo = {
        name, key: body.key, unique: !!o.unique, sparse: !!o.sparse, ttlSeconds: o.expireAfterSeconds ?? null,
        partialFilter: o.partialFilterExpression ? ejson(parseValue(o.partialFilterExpression, 'options.partialFilterExpression')) : null,
        collation: o.collation ? ejson(parseValue(o.collation, 'options.collation')) : null, size: 4096, usage: { ops: 0, since: new Date().toISOString() },
      };
      // big collections (> 100 docs) build "in the background" with progress
      if (c.docs.length > 100) {
        const jobId = ctx.jobs.start('mongo.createIndex', async (report, signal) => {
          for (let i = 1; i <= 4; i++) {
            if (signal.aborted) throw new Error('Index build aborted');
            report(Math.round((c.docs.length * i) / 4), c.docs.length, 'Index Build: scanning collection');
            await new Promise((r) => setTimeout(r, 40));
          }
          c.indexes.push(info);
          return { name };
        });
        return ctx.ok({ name, jobId });
      }
      c.indexes.push(info);
      return ctx.ok({ name, jobId: null });
    })),
    http.delete(`${P}/db/:db/coll/:coll/indexes/:name`, route(({ cid, db, coll, params }) => {
      readOnly(cid, 'drop an index');
      const c = getColl(db, coll);
      if (params.name === '_id_') throw new HttpError(400, 'VALIDATION', 'The _id index cannot be dropped.', { field: 'name' });
      if (!c.indexes.some((i) => i.name === params.name)) throw new HttpError(422, 'PROVIDER_ERROR', `index not found with name [${params.name}]`, { providerCode: 27, codeName: 'IndexNotFound' });
      c.indexes = c.indexes.filter((i) => i.name !== params.name);
      return new HttpResponse(null, { status: 204 });
    })),
    http.get(`${P}/db/:db/profiling`, route(({ db }) => ctx.ok(profiling.get(db) ?? { level: 0, slowms: 100, sampleRate: 1 }))),
    http.put(`${P}/db/:db/profiling`, route<MongoProfilingRequest>(({ cid, db, body }) => {
      if (body.level !== 0 && body.level !== 1 && body.level !== 2) throw new HttpError(400, 'VALIDATION', 'level is 0 (off), 1 (slow operations) or 2 (all operations).', { field: 'level' });
      readOnly(cid, 'change the profiling level');
      const cur = profiling.get(db) ?? { level: 0, slowms: 100, sampleRate: 1 };
      const next: MongoProfiling = { level: body.level, slowms: body.slowms ?? cur.slowms, sampleRate: body.sampleRate ?? cur.sampleRate };
      profiling.set(db, next);
      return ctx.ok(next);
    })),
    http.get(`${P}/db/:db/coll/:coll/validation`, route(({ db, coll }) => ctx.ok(getColl(db, coll).validation))),
    http.put(`${P}/db/:db/coll/:coll/validation`, route<MongoValidation>(({ cid, db, coll, body }) => {
      readOnly(cid, 'change validation');
      const c = getColl(db, coll);
      const v = body.validator && body.validator.trim() ? parseField(body.validator, 'validator') : null;
      c.validation = { validator: v && v.v.length ? ejson(v) : null, level: body.level, action: body.action };
      return ctx.ok(c.validation);
    })),
    http.post(`${P}/db/:db/coll/:coll/export`, route<MongoExportRequest>(({ db, coll, body }) => {
      getColl(db, coll);
      const filter = parseField(body.filter, 'filter');
      const projection = parseField(body.projection, 'projection');
      const sort = parseField(body.sort, 'sort');
      let docs = sortDocs(collDocs(dep, db, coll).filter((d) => matches(d, filter)), sort).map((d) => project(d, projection));
      if (body.limit) docs = docs.slice(0, body.limit);
      const text = exportText(docs, body);
      if (body.path === null) {
        return new HttpResponse(text, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${coll}.${body.format}"` } });
      }
      const jobId = ctx.jobs.start('mongo.export', async (report) => {
        report(docs.length, docs.length, 'Writing');
        return { path: body.path, docs: docs.length };
      });
      return ctx.ok({ jobId }, { status: 202 });
    })),
    http.post(`${P}/db/:db/coll/:coll/import/preview`, route<MongoImportRequest>(({ db, coll, body }) => {
      getColl(db, coll);
      const p = parseImport(body, 20);
      return ctx.ok({ docs: p.docs.map((d) => ejson(d)), columns: p.columns, errors: p.errors.slice(0, 100) });
    })),
    http.post(`${P}/db/:db/coll/:coll/import`, route<MongoImportRequest>(({ cid, db, coll, body }) => {
      readOnly(cid, 'import documents');
      const c = getColl(db, coll);
      const p = parseImport(body);
      const jobId = ctx.jobs.start('mongo.import', async (report, signal) => {
        let inserted = 0;
        let upserted = 0;
        const errors = [...p.errors];
        const batch = Math.max(1, body.batchSize || 1000);
        for (let i = 0; i < p.docs.length; i += batch) {
          if (signal.aborted) throw new Error('cancelled');
          for (const [j, d] of p.docs.slice(i, i + batch).entries()) {
            const key = body.upsertKey || '_id';
            const kv = getPath(d, key);
            const existing = kv ? c.docs.findIndex((x) => compare(getPath(x, key), kv) === 0) : -1;
            if (body.mode === 'upsert' && existing >= 0) {
              c.docs[existing] = getPath(d, '_id') ? d : B.doc([['_id', getPath(c.docs[existing], '_id')!], ...d.v]);
              upserted++;
            } else if (existing >= 0 && key === '_id') {
              errors.push({ index: i + j, message: `E11000 duplicate key error dup key: { _id: ${ejson(kv!)} }` });
              if (body.stopOnError) break;
            } else {
              c.docs.push(getPath(d, '_id') ? d : B.doc([['_id', B.oid(oidFrom(Date.now(), 0x9000 + i + j))], ...d.v]));
              inserted++;
            }
          }
          report(Math.min(p.docs.length, i + batch), p.docs.length, `Imported ${inserted + upserted}`);
          await new Promise((r) => setTimeout(r, 5));
        }
        return { inserted, upserted, failed: errors.length, errors: errors.slice(0, 100) };
      });
      return ctx.ok({ jobId }, { status: 202 });
    })),
  ];
}

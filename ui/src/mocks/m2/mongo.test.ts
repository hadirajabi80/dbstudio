// The Mongo mock's query engine (it backs `npm run dev:mock` and the UI tests, so its semantics follow MongoDB).
import { describe, expect, it } from 'vitest';
import { B, getPath, toShell } from '../../mongo/bson';
import { parseShellArray, parseShellDoc } from '../../mongo/shellJson';
import { analyzeSchema, compare, createMongoFixture, exportText, fieldPaths, matches, parseCsv, project, runPipeline, sortDocs } from './mongo';

const dep = createMongoFixture();
const orders = dep.get('shop')!.get('orders')!.docs;
const customers = dep.get('shop')!.get('customers')!.docs;
const q = (f: string) => orders.filter((d) => matches(d, parseShellDoc(f)));

describe('mongo mock', () => {
  it('builds a deterministic fixture', () => {
    expect(orders).toHaveLength(240);
    expect(customers).toHaveLength(60);
    expect(toShell(createMongoFixture().get('shop')!.get('orders')!.docs[0])).toBe(toShell(orders[0]));
  });

  it('matches comparison, $in, $exists, $regex and logical operators', () => {
    const paid = q('{ status: "paid" }').length;
    expect(paid).toBeGreaterThan(0);
    expect(q('{ status: { $in: ["paid", "shipped"] } }').length).toBe(paid + q('{ status: "shipped" }').length);
    expect(q('{ $or: [{ status: "paid" }, { status: { $ne: "paid" } }] }')).toHaveLength(240);
    expect(q('{ total: { $gt: 100, $lte: 200 } }').every((d) => { const t = (getPath(d, 'total') as { v: number }).v; return t > 100 && t <= 200; })).toBe(true);
    expect(q('{ notes: { $exists: true } }')).toHaveLength(1);
    expect(q('{ customer: /^a/i }').every((d) => /^a/i.test((getPath(d, 'customer') as { v: string }).v))).toBe(true);
  });

  it('matches inside arrays and with $elemMatch', () => {
    const sku = (getPath(orders[0], 'items.0.sku') as { v: string }).v;
    expect(q(`{ "items.sku": "${sku}" }`).length).toBeGreaterThan(0);
    expect(q('{ items: { $elemMatch: { qty: { $gte: 4 } } } }').length).toBeGreaterThan(0);
    expect(q('{ items: { $size: 0 } }')).toHaveLength(0);
  });

  it('projects and sorts', () => {
    const p = project(orders[0], parseShellDoc('{ total: 1, _id: 0 }'));
    expect(p.v.map(([k]) => k)).toEqual(['total']);
    const s = sortDocs(orders, parseShellDoc('{ total: -1 }'));
    expect(compare(getPath(s[0], 'total'), getPath(s[1], 'total'))).toBeGreaterThanOrEqual(0);
  });

  it('runs $match/$unwind/$group/$sort/$limit pipelines', () => {
    const out = runPipeline(dep, 'shop', orders, parseShellArray('[{ $unwind: "$items" }, { $group: { _id: "$items.sku", qty: { $sum: "$items.qty" } } }, { $sort: { qty: -1 } }, { $limit: 3 }]'));
    expect(out).toHaveLength(3);
    expect(compare(getPath(out[0], 'qty'), getPath(out[2], 'qty'))).toBeGreaterThanOrEqual(0);
    expect(runPipeline(dep, 'shop', orders, parseShellArray('[{ $count: "n" }]'))[0]).toEqual(B.doc([['n', B.int(240)]]));
  });

  it('analyzes schemas and samples field paths', () => {
    const s = analyzeSchema(customers);
    const phone = s.fields.find((f) => f.path === 'phone')!;
    expect(phone.types.length).toBeGreaterThan(1);
    expect(phone.probability).toBeLessThan(1);
    expect(s.fields.find((f) => f.path === 'address')!.nested.map((n) => n.path)).toContain('address.city');
    const tier = fieldPaths(customers).find((f) => f.path === 'tier')!;
    expect(tier.values?.length).toBe(3);
  });

  it('parses CSV with quotes and exports flattened CSV', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    const csv = exportText([parseShellDoc('{ a: 1, b: { c: "x,y" }, d: [1, 2] }')], { format: 'csv', filter: '', path: null });
    expect(csv).toBe('a,b.c,d\n1,"x,y","[1,2]"\n');
  });
});

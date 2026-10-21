// Synthetic catalogs for the 500-table performance test and the dev-only "synthetic ER diagram" command (QA: the
// 500-table file loads with LOD). Deterministic for a seed.
import type { CatalogColumnTuple, CatalogForeignKey, CatalogObject, CatalogSchema } from '../../api/types';

export interface SyntheticSpec {
  tables: number;
  columns: number;
  fks: number;
  /** Tables are spread over this many schemas (`s0`, `s1`, …); 1 = one schema named `main`. */
  schemas?: number;
  seed?: number;
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['int', 'varchar(100)', 'nvarchar(400)', 'datetime2', 'decimal(12,2)', 'bit', 'uniqueidentifier', 'text', 'bigint', 'date'];
const WORDS = ['customer', 'order', 'invoice', 'product', 'supplier', 'warehouse', 'shipment', 'payment', 'account', 'employee', 'region', 'campaign', 'ticket', 'contract', 'asset', 'ledger'];

export function syntheticSchemas(spec: SyntheticSpec): CatalogSchema[] {
  const rnd = mulberry32(spec.seed ?? 42);
  const schemaCount = Math.max(1, spec.schemas ?? 1);
  const schemaName = (i: number) => (schemaCount === 1 ? 'main' : `s${i % schemaCount}`);
  const names = Array.from({ length: spec.tables }, (_, i) => `${WORDS[i % WORDS.length]}_${String(i).padStart(3, '0')}`);
  const objects: { schema: string; o: CatalogObject }[] = names.map((n, i) => {
    const cols: CatalogColumnTuple[] = [['id', 'int', 0, 1, 1, null]];
    for (let c = 1; c < spec.columns; c++) cols.push([`col_${c}`, TYPES[Math.floor(rnd() * TYPES.length)], rnd() < 0.4 ? 1 : 0, 0, 0, null]);
    return { schema: schemaName(i), o: { t: 'table', n, c: cols, pk: ['id'], fk: [] } };
  });
  let made = 0;
  for (let attempt = 0; made < spec.fks && spec.tables > 1 && attempt < spec.fks * 20; attempt++) {
    // referencing table: any but the first; referenced: an earlier table (keeps a DAG-like, realistic shape)
    const from = 1 + Math.floor(rnd() * (spec.tables - 1));
    const to = Math.floor(rnd() * from);
    const src = objects[from];
    const colName = `${names[to]}_id`;
    if (src.o.c!.some((c) => c[0] === colName)) continue;
    src.o.c!.push([colName, 'int', rnd() < 0.3 ? 1 : 0, 0, 0, null]);
    const fk: CatalogForeignKey = { n: `fk_${names[from]}_${names[to]}`, cols: [colName], rs: objects[to].schema, rt: names[to], rcols: ['id'] };
    src.o.fk!.push(fk);
    made++;
  }
  const bySchema = new Map<string, CatalogObject[]>();
  for (const { schema, o } of objects) bySchema.set(schema, [...(bySchema.get(schema) ?? []), o]);
  return [...bySchema.entries()].map(([name, objs]) => ({ name, version: 1, objects: objs }));
}

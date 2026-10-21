// PostgreSQL (pgsql) support of the TypeScript (node-postgres, zod, Prisma), Python (psycopg 3, SQLAlchemy, Pydantic)
// and JSON generators (docs/PLAN-PG.md 4.1), on the pgsql shop fixture and a few edge-case tables.
import { describe, expect, it } from 'vitest';
import { generate } from '..';
import type { CgColumn, CgInput } from '../model';
import type { CodegenOptions } from '../options';
import { shopInput } from './shop';

const ALL = { model: true, repository: true, procedures: true, interface: false };
const gen = (o: Partial<CodegenOptions>, input: CgInput = shopInput('pgsql')) => generate(input, { combined: true, include: ALL, ...o });
const text = (o: Partial<CodegenOptions>, input?: CgInput) => gen(o, input).map((f) => f.content).join('\n');

const col = (name: string, dbType: string, extra: Partial<CgColumn> = {}): CgColumn => ({ name, dbType, nullable: false, pk: false, identity: false, computed: false, ...extra });

/** Self-references, a one-to-one table, a keyless table and an enum named like a model. */
const EDGE: CgInput = {
  dialect: 'pgsql',
  objects: [
    {
      kind: 'table', schema: 'public', name: 'people', primaryKey: ['id'],
      columns: [col('id', 'integer', { identity: true }), col('manager_id', 'integer', { nullable: true }), col('mentor_id', 'integer', { nullable: true }), col('mood', 'mood', { enumLabels: ['ok', 'in-progress'] }), col('net', 'cidr', { nullable: true })],
      foreignKeys: [
        { name: 'people_manager_fk', columns: ['manager_id'], refSchema: 'public', refTable: 'people', refColumns: ['id'] },
        { name: 'people_mentor_fk', columns: ['mentor_id'], refSchema: 'public', refTable: 'people', refColumns: ['id'] },
      ],
    },
    {
      kind: 'table', schema: 'public', name: 'person_profile', primaryKey: ['person_id'], columns: [col('person_id', 'integer'), col('bio', 'text', { nullable: true })],
      foreignKeys: [{ name: 'profile_person_fk', columns: ['person_id'], refSchema: 'public', refTable: 'people', refColumns: ['id'] }],
    },
    {
      kind: 'table', schema: 'public', name: 'audit_log', primaryKey: [], columns: [col('person_id', 'integer'), col('at', 'timestamp')],
      foreignKeys: [{ name: 'audit_person_fk', columns: ['person_id'], refSchema: 'public', refTable: 'people', refColumns: ['id'] }],
    },
    { kind: 'table', schema: 'public', name: 'mood', primaryKey: ['id'], columns: [col('id', 'integer')], foreignKeys: [] },
    { kind: 'query', name: 'LikeQuery', sql: "SELECT id FROM people WHERE name LIKE 'a%' AND id = :id", params: [{ name: 'id', type: 'int', positional: false }], columns: [col('id', 'integer')] },
  ],
};

describe('TypeScript / pgsql', () => {
  it('types enums as literal unions / z.enum and arrays as lists', () => {
    const ts = text({ language: 'typescript', flavor: 'interface' });
    expect(ts).toContain("status: 'new' | 'paid' | 'shipped' | 'cancelled';");
    expect(ts).toContain("statuses: ('new' | 'paid' | 'shipped' | 'cancelled')[] | null;");
    expect(ts).toContain('counts: number[] | null;');
    const zod = text({ language: 'typescript', flavor: 'zod' });
    expect(zod).toContain("status: z.enum(['new', 'paid', 'shipped', 'cancelled']),");
    expect(zod).toContain('tags: z.array(z.string()).nullable(),');
  });

  it('node-postgres: $n placeholders, camelCase aliases and RETURNING', () => {
    const ts = text({ language: 'typescript', flavor: 'driver' });
    expect(ts).toContain("import pg, { type Pool, type PoolClient } from 'pg';");
    expect(ts).toContain('SELECT id, customer_id AS "customerId", order_date AS "orderDate", status, total, note\nFROM public.orders\nWHERE id = $1');
    expect(ts).toContain('VALUES ($1, $2, $3)\nRETURNING invoice_id');
    expect(ts).toContain('return result.rows[0].invoice_id;');
    expect(ts).not.toMatch(/= \?/);
  });

  it('node-postgres: int8 / numeric read through scoped type parsers, honest about the defaults', () => {
    const ts = text({ language: 'typescript', flavor: 'driver' });
    expect(ts).toContain('const pgTypes = new pg.TypeOverrides();');
    expect(ts).toContain('pgTypes.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));');
    expect(ts).toContain('types: pgTypes');
    // bigint / string mappings keep pg's text (string) or parse to BigInt.
    const big = text({ language: 'typescript', flavor: 'driver', tsBigint: 'bigint', tsDecimal: 'string' });
    expect(big).toContain('(v) => BigInt(v)');
    expect(big).not.toContain('builtins.NUMERIC');
    expect(text({ language: 'typescript', flavor: 'driver', tsBigint: 'string' })).not.toContain('builtins.INT8');
  });

  it('node-postgres: functions, table functions (catalog result columns) and procedures with INOUT', () => {
    const ts = text({ language: 'typescript', flavor: 'driver' });
    expect(ts).toContain('SELECT public.fn_tax($1::numeric) AS value');
    expect(ts).toContain('export async function fnTax2(pool: Pool | PoolClient, amount: number, rate: number)');
    expect(ts).toContain('SELECT id, order_date AS "orderDate", total FROM public.orders_of($1::bigint)');
    expect(ts).toContain('Promise<OrdersOfRow[]>');
    expect(ts).toContain('CALL public.add_order_line(${args.join(\', \')})');
    expect(ts).toContain('lineNo: row?.p_line_no ?? null,');
  });

  it('numbers the files of overloaded routines', () => {
    const paths = generate(shopInput('pgsql'), { language: 'typescript', flavor: 'driver', combined: false, include: ALL }).map((f) => f.path);
    expect(paths).toContain('fnTax.ts');
    expect(paths).toContain('fnTax2.ts');
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('Prisma / pgsql', () => {
  const prisma = () => gen({ language: 'typescript', flavor: 'prisma' });

  it('emits one schema.prisma shown as plaintext', () => {
    const files = prisma();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('schema.prisma');
    expect(files[0].language).toBe('plaintext');
  });

  it('declares datasource, generator and multiSchema schemas', () => {
    const p = prisma()[0].content;
    expect(p).toContain('provider = "postgresql"');
    expect(p).toContain('provider        = "prisma-client-js"');
    expect(p).toContain('previewFeatures = ["multiSchema", "views"]');
    expect(p).toContain('schemas  = ["public", "sales"]');
    expect(p).toMatch(/model Invoice \{[\s\S]*?@@map\("invoices"\)\n {2}@@schema\("sales"\)\n\}/);
  });

  it('maps models: ids, identity, native types, @map and composite ids', () => {
    const p = prisma()[0].content;
    expect(p).toMatch(/model Customer \{\n {2}id +BigInt +@id @default\(autoincrement\(\)\)/);
    expect(p).toMatch(/name +String +@db\.VarChar\(100\)/);
    expect(p).toMatch(/createdAt +DateTime +@db\.Timestamptz\(6\) @default\(now\(\)\) @map\("created_at"\)/);
    expect(p).toContain('@@id([orderId, lineNo])');
    expect(p).toMatch(/wait +Unsupported\("interval"\)\?/);
    expect(p).toMatch(/tags +String\[\]\n/);
  });

  it('declares enums from the catalog types', () => {
    const p = prisma()[0].content;
    expect(p).toContain('enum OrderStatus {\n  new\n  paid\n  shipped\n  cancelled\n\n  @@map("order_status")\n  @@schema("public")\n}');
    expect(p).toMatch(/status +OrderStatus +@default\(dbgenerated\(\)\)/);
    expect(p).toMatch(/statuses +OrderStatus\[\]/);
  });

  it('adds relations with back-relations, across schemas', () => {
    const p = prisma()[0].content;
    expect(p).toContain('customer   Customer @relation(fields: [customerId], references: [id], map: "invoices_customer_id_fkey")');
    expect(p).toMatch(/model Customer \{[\s\S]*?invoices +Invoice\[\]/);
    expect(p).toMatch(/country +Country\? +@relation\(fields: \[countryId\]/);
  });

  it('names self relations, makes PK foreign keys one-to-one and ignores keyless tables', () => {
    const p = gen({ language: 'typescript', flavor: 'prisma' }, EDGE)[0].content;
    expect(p).toContain('@relation(name: "people_manager_fk", fields: [managerId], references: [id], map: "people_manager_fk")');
    expect(p).toMatch(/peopleByManager +Person\[\] +@relation\("people_manager_fk"\)/);
    expect(p).toMatch(/personProfile +PersonProfile\?\n/);
    expect(p).toMatch(/model AuditLog \{[\s\S]*?@@ignore\n\}/);
    expect(p).not.toMatch(/auditLog/);
    expect(p).toContain('enum MoodEnum {\n  ok\n  in_progress @map("in-progress")');
    expect(p).toMatch(/net +Unsupported\("cidr"\)\?/);
    expect(p).not.toContain('multiSchema');
  });
});

describe('Python / pgsql', () => {
  it('dataclass + psycopg 3: %s placeholders, execute().fetchone(), RETURNING, Json wrappers', () => {
    const py = text({ language: 'python', flavor: 'dataclass' });
    expect(py).toContain('import psycopg');
    expect(py).toContain('def __init__(self, conn: psycopg.Connection[Any]) -> None:');
    expect(py).toContain('WHERE invoice_id = %s');
    expect(py).toContain('row = self._conn.execute(_INVOICE_INSERT, (e.customer_id, e.amount, e.pdf)).fetchone()');
    expect(py).toContain('RETURNING invoice_id');
    expect(py).toContain('Jsonb(e.profile) if e.profile is not None else None');
    expect(py).toContain('statuses = %s::order_status[]');
    expect(py).not.toMatch(/= \?/);
    expect(py).not.toContain('sqlite3');
  });

  it('types enums as Literal, arrays as list[...] and inet as ipaddress classes', () => {
    const py = text({ language: 'python', flavor: 'dataclass' });
    expect(py).toContain('status: Literal["new", "paid", "shipped", "cancelled"]');
    expect(py).toContain('counts: list[int] | None');
    expect(py).toContain('ip: IPv4Address | IPv6Address | None');
    expect(py).toContain('from ipaddress import IPv4Address, IPv6Address');
    const pyd = text({ language: 'python', flavor: 'pydantic' });
    expect(pyd).toContain('statuses: list[Literal["new", "paid", "shipped", "cancelled"]] | None = Field(default=None)');
  });

  it('functions, overloads, table functions and CALL with INOUT', () => {
    const py = text({ language: 'python', flavor: 'dataclass' });
    expect(py).toContain('row = conn.execute("SELECT public.fn_tax(%s::numeric) AS value", (amount,)).fetchone()');
    expect(py).toContain('def fn_tax2(conn: psycopg.Connection[Any], amount: Decimal, rate: Decimal) -> Decimal | None:');
    expect(py).toContain('rows = conn.execute("SELECT id, order_date, total FROM public.orders_of(%s::bigint)", (customer_id,)).fetchall()');
    expect(py).toContain('sql = f"CALL public.add_order_line({\', \'.join(args)})"');
    expect(py).toContain('return AddOrderLineResult(line_no=row[0] if row is not None else None)');
  });

  it('queries: positional $n → %s, named :x → %(x)s with literal % doubled', () => {
    expect(text({ language: 'python', flavor: 'dataclass' })).toContain('rows = conn.execute(_CUSTOMER_ORDERS_SQL, (p1, p2)).fetchall()');
    const edge = text({ language: 'python', flavor: 'dataclass' }, EDGE);
    expect(edge).toContain("WHERE name LIKE 'a%%' AND id = %(id)s");
    expect(edge).toContain('conn.execute(_LIKE_QUERY_SQL, {"id": id})');
  });

  it('SQLAlchemy: postgresql dialect types, Identity, Computed and schemas', () => {
    const sa = text({ language: 'python', flavor: 'sqlalchemy' });
    expect(sa).toMatch(/from sqlalchemy\.dialects\.postgresql import ARRAY, .*ENUM, .*INET, .*JSONB, .*UUID as PG_UUID/);
    expect(sa).toContain('id: Mapped[int] = mapped_column(BigInteger(), Identity(), primary_key=True)');
    expect(sa).toContain('line_total: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), Computed("qty * unit_price", persisted=True))');
    expect(sa).toContain('statuses: Mapped[list[Literal["new", "paid", "shipped", "cancelled"]] | None] = mapped_column(ARRAY(ENUM("new", "paid", "shipped", "cancelled", name="order_status")))');
    expect(sa).toContain('__table_args__ = {"schema": "sales", "comment": "Issued invoices"}');
    expect(sa).toContain('sku: Mapped[UUID] = mapped_column(PG_UUID(), server_default=FetchedValue())');
    expect(sa).not.toContain('autoincrement=True');
  });
});

describe('JSON / pgsql', () => {
  it('describes arrays and enums', () => {
    const schema = JSON.parse(text({ language: 'json', flavor: 'json-schema' }));
    const zoo = schema.$defs.TypeZoo.properties;
    expect(zoo.counts).toEqual({ type: ['array', 'null'], items: { type: 'integer' } });
    expect(zoo.statuses.items).toEqual({ type: 'string', enum: ['new', 'paid', 'shipped', 'cancelled'] });
    expect(schema.$defs.Order.properties.status).toEqual({ type: 'string', enum: ['new', 'paid', 'shipped', 'cancelled'] });
    expect(schema.$defs.OrdersOfRow.properties.orderDate).toEqual({ type: ['string', 'null'], format: 'date-time' });
    const sample = JSON.parse(text({ language: 'json', flavor: 'sample' }));
    expect(sample.TypeZoo.counts).toEqual([1]);
    expect(sample.Order.status).toBe('new');
  });
});

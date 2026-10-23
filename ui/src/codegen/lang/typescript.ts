// TypeScript generator: interfaces (default), Node driver data access (node-mssql / node-oracledb / node-postgres /
// better-sqlite3, chosen by the connection's dialect), Zod schemas and (PostgreSQL) a Prisma schema.
import type { Dialect } from '../../api/types';
import type { CgColumn, CgInput, CgPackage, CgParam, CgQuery, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import { camel, NameScope, pascal, queryFnBase, withSuffix } from '../naming';
import type { CodegenOptions } from '../options';
import { bindNameOf, DIALECT_LABEL, friendlyParam, localName, membersOf, objectLabel, pkMembers, routineSqlName, typeNameOf, type Member } from '../shape';
import { crudSql, defaultsNote, PH, qi, quoteAlias, rewriteQuery, trimStatement } from '../sqlgen';
import { resolveType, type ResolvedType } from '../types';
import { commentText, sq, Writer } from '../writer';
import { generatePrisma } from './prisma';

interface Ctx {
  d: Dialect;
  o: CodegenOptions;
  imports: Map<string, string>;
  /** Private helper functions the unit uses (emitted once per file, after the imports), by name. */
  helpers: Map<string, string>;
  /** Exported function names of the whole run (one module when combined). */
  exported: Set<string>;
}

/** Claim an exported name; on a clash use `alt` (e.g. a procedure wrapper named like a CRUD function). */
function claim(ctx: Ctx, name: string, alt: string): string {
  const n = ctx.exported.has(name) ? alt : name;
  ctx.exported.add(n);
  return n;
}

// ---------------- types ----------------

function baseTs(t: ResolvedType, o: CodegenOptions): string {
  // PostgreSQL arrays and enums (only resolved for pgsql): `number[]`, `'new' | 'paid'`, `('new' | 'paid')[]`.
  if (t.array && t.element) {
    const e = baseTs(t.element, o);
    return /^[A-Za-z_$][\w$.]*$/.test(e) ? `${e}[]` : `(${e})[]`;
  }
  if (t.enumLabels?.length) return t.enumLabels.map((l) => sq(l)).join(' | ');
  if ((t.logical === 'date' || t.logical === 'datetime' || t.logical === 'datetimeoffset') && o.tsDate === 'Date') return 'Date';
  if (t.logical === 'decimal' && o.tsDecimal === 'string') return 'string';
  if (t.logical === 'int64' && o.tsBigint !== 'number') return o.tsBigint;
  return t.ts;
}

function tsType(t: ResolvedType, nullable: boolean, o: CodegenOptions, forOptional = false): string {
  const b = baseTs(t, o);
  if (!nullable || forOptional) return b;
  return b === 'unknown' ? 'unknown' : `${b} | null`;
}

function prop(m: Member, o: CodegenOptions): string {
  const optional = m.nullable && o.tsNullable === 'optional';
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(m.name) ? m.name : `'${m.name}'`;
  return `${name}${optional ? '?' : ''}: ${tsType(m.type, m.nullable, o, optional)};`;
}

function docLine(w: Writer, text: string | null | undefined) {
  const t = commentText(text);
  if (t) w.line(`/** ${t} */`);
}

function backtick(sql: string): string {
  return `\`${sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;
}

// ---------------- interface / zod ----------------

function interfaceDecl(w: Writer, typeName: string, members: Member[], doc: string | null, ctx: Ctx) {
  docLine(w, doc);
  w.block(`export interface ${typeName} {`, () => {
    for (const m of members) {
      const notes = [commentText(m.col.comment), m.type.known ? '' : `TODO: unmapped type ${m.col.dbType}`, pgDriverNote(m, ctx)].filter(Boolean).join(' — ');
      if (notes) w.line(`/** ${notes} */`);
      w.line(prop(m, ctx.o));
    }
  });
}

function zodType(m: Member, o: CodegenOptions): string {
  let z = zodBase(m.type, o);
  if (m.nullable) z += o.tsNullable === 'optional' ? '.nullish()' : '.nullable()';
  return z;
}

function zodBase(t: ResolvedType, o: CodegenOptions): string {
  if (t.array && t.element) return `z.array(${zodBase(t.element, o)})`;
  if (t.enumLabels?.length) return `z.enum([${t.enumLabels.map((l) => sq(l)).join(', ')}])`;
  switch (baseTs(t, o)) {
    case 'number':
      return /^(int|uint)/.test(t.logical) ? 'z.number().int()' : 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'Date':
      return 'z.coerce.date()';
    case 'bigint':
      return 'z.bigint()';
    case 'Buffer':
      return 'z.instanceof(Uint8Array)';
    case 'unknown':
      return 'z.unknown()';
    default:
      if (t.logical === 'guid') return 'z.string().uuid()';
      if (t.logical === 'datetime' || t.logical === 'datetimeoffset') return 'z.string().datetime({ offset: true, local: true })';
      if (t.logical === 'date') return 'z.string().date()';
      return t.length && t.logical === 'string' ? `z.string().max(${t.length})` : 'z.string()';
  }
}

function zodDecl(w: Writer, typeName: string, members: Member[], doc: string | null, ctx: Ctx) {
  ctx.imports.set('zod', "import { z } from 'zod';");
  docLine(w, doc);
  w.block(`export const ${typeName}Schema = z.object({`, () => {
    for (const m of members) {
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(m.name) ? m.name : `'${m.name}'`;
      w.line(`${name}: ${zodType(m, ctx.o)},`);
    }
  }, '});');
  w.blank();
  w.line(`export type ${typeName} = z.infer<typeof ${typeName}Schema>;`);
}

// ---------------- drivers ----------------

const DRIVER: Record<Dialect, { module: string; conn: string; import: string }> = {
  tsql: { module: 'mssql', conn: 'sql.ConnectionPool | sql.Transaction', import: "import sql from 'mssql';" },
  plsql: { module: 'oracledb', conn: 'oracledb.Connection', import: "import oracledb from 'oracledb';" },
  sqlite: { module: 'better-sqlite3', conn: 'Database', import: "import type { Database } from 'better-sqlite3';" },
  // node-postgres: a Pool, or a PoolClient checked out of it for a transaction.
  pgsql: { module: 'pg', conn: 'Pool | PoolClient', import: "import type { Pool, PoolClient } from 'pg';" },
  // WP-MY begin
  mysql: { module: 'mysql2/promise', conn: 'Pool | PoolConnection', import: "import type { Pool, PoolConnection } from 'mysql2/promise';" },
  // WP-MY end
  // WP-CH begin
  clickhouse: { module: '@clickhouse/client', conn: 'ClickHouseClient', import: "import type { ClickHouseClient } from '@clickhouse/client';" },
  // WP-CH end
  // WP-SF begin
  snowflake: { module: 'snowflake-sdk', conn: 'snowflake.Connection', import: "import snowflake from 'snowflake-sdk';" },
  // WP-SF end
  // WP-CS begin
  cql: { module: 'cassandra-driver', conn: 'Client', import: "import type { Client } from 'cassandra-driver';" },
  // WP-CS end
};

const MSSQL_TYPE: Record<string, string> = {
  int: 'sql.Int', integer: 'sql.Int', bigint: 'sql.BigInt', smallint: 'sql.SmallInt', tinyint: 'sql.TinyInt', bit: 'sql.Bit', decimal: 'sql.Decimal',
  numeric: 'sql.Numeric', money: 'sql.Money', smallmoney: 'sql.SmallMoney', float: 'sql.Float', real: 'sql.Real', date: 'sql.Date',
  datetime: 'sql.DateTime', datetime2: 'sql.DateTime2', smalldatetime: 'sql.SmallDateTime', datetimeoffset: 'sql.DateTimeOffset', time: 'sql.Time',
  char: 'sql.Char', varchar: 'sql.VarChar', nchar: 'sql.NChar', nvarchar: 'sql.NVarChar', text: 'sql.Text', ntext: 'sql.NText', sysname: 'sql.NVarChar',
  binary: 'sql.Binary', varbinary: 'sql.VarBinary', image: 'sql.Image', uniqueidentifier: 'sql.UniqueIdentifier', xml: 'sql.Xml',
  sql_variant: 'sql.Variant', timestamp: 'sql.VarBinary', rowversion: 'sql.VarBinary', json: 'sql.NVarChar',
};

function mssqlType(t: ResolvedType): string {
  const base = MSSQL_TYPE[t.base] ?? 'sql.NVarChar';
  if (t.logical === 'string' || t.logical === 'binary') {
    if (/Text|NText|Image|Xml/.test(base)) return base;
    return `${base}(${t.length ?? 'sql.MAX'})`;
  }
  if (t.logical === 'decimal' && t.precision && /Decimal|Numeric/.test(base)) return `${base}(${t.precision}, ${t.scale ?? 0})`;
  return base;
}

function oracleType(t: ResolvedType): string {
  switch (t.logical) {
    case 'string':
    case 'xml':
    case 'json':
      return 'oracledb.STRING';
    case 'binary':
      return 'oracledb.BUFFER';
    case 'date':
    case 'datetime':
    case 'datetimeoffset':
      return 'oracledb.DATE';
    case 'cursor':
      return 'oracledb.CURSOR';
    default:
      return 'oracledb.NUMBER';
  }
}

/**
 * Date conversions of the better-sqlite3 flavor, in SQLite's own text formats so stored values sort and compare
 * correctly against what SQLite writes itself (CURRENT_TIMESTAMP, datetime(), date(), strftime('%f')):
 * - timestamps are UTC 'YYYY-MM-DD HH:MM:SS', with '.SSS' when the Date has milliseconds (so a value SQLite wrote with
 *   strftime('%Y-%m-%d %H:%M:%f') is written back as it was), and read back as UTC (ISO text with 'T', 'Z' or an
 *   offset is read as written),
 * - DATE columns hold the local calendar day 'YYYY-MM-DD' of the Date and read back as local midnight, so
 *   new Date(1990, 4, 17) is stored as '1990-05-17' in every time zone,
 * - SQLite may also store a date as a number (INTEGER unix seconds or REAL julian day number): both read as a Date.
 *   Numbers above 1e8 are unix seconds (1973 onwards), smaller ones julian day numbers (2440587.5 = 1970-01-01).
 */
const SQLITE_DATE_HELPERS = {
  toSqliteDateTime: [
    "/** A Date as SQLite's UTC timestamp text 'YYYY-MM-DD HH:MM:SS' (CURRENT_TIMESTAMP's format), with '.SSS' when it has milliseconds. */",
    'function toSqliteDateTime(d: Date): string {',
    "  return d.toISOString().replace('T', ' ').replace(/\\.000Z$/, '').replace(/Z$/, '');",
    '}',
  ],
  fromSqliteDateTime: [
    "/** A SQLite timestamp as a Date: text 'YYYY-MM-DD HH:MM:SS[.SSS]' is UTC (ISO text with 'T', 'Z' or an offset is read as written); a number is unix seconds (> 1e8) or a julian day. */",
    'function fromSqliteDateTime(v: string | number): Date {',
    "  if (typeof v === 'number') return new Date(v > 1e8 ? v * 1000 : (v - 2440587.5) * 86400000);",
    "  const iso = v.length === 10 ? `${v}T00:00:00` : v.replace(' ', 'T');",
    '  return new Date(/(Z|[+-]\\d\\d:?\\d\\d)$/i.test(iso) ? iso : `${iso}Z`);',
    '}',
  ],
  toSqliteDate: [
    "/** The local calendar day of a Date as SQLite DATE text 'YYYY-MM-DD'. */",
    'function toSqliteDate(d: Date): string {',
    "  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;",
    '}',
  ],
  fromSqliteDate: [
    "/** SQLite DATE text 'YYYY-MM-DD' as a Date at local midnight of that day; a number (unix seconds > 1e8, else a julian day) gives its UTC day. */",
    'function fromSqliteDate(v: string | number): Date {',
    "  if (typeof v === 'number') {",
    '    const t = new Date(v > 1e8 ? v * 1000 : (v - 2440587.5) * 86400000);',
    '    return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());',
    '  }',
    "  const [y, m, d] = v.slice(0, 10).split('-').map(Number);",
    '  return new Date(y, m - 1, d);',
    '}',
  ],
} satisfies Record<string, string[]>;

/** Use one of the date helpers in the current unit (emitted once per file) and return its name. */
function helper(ctx: Ctx, name: keyof typeof SQLITE_DATE_HELPERS): string {
  ctx.helpers.set(name, SQLITE_DATE_HELPERS[name].join('\n'));
  return name;
}

/** better-sqlite3 cannot bind booleans or Dates: convert at the boundary. */
function sqliteBind(expr: string, t: ResolvedType, nullable: boolean, ctx: Ctx): string {
  const { o } = ctx;
  if (t.logical === 'bool') return nullable ? `${expr} == null ? null : Number(${expr})` : `Number(${expr})`;
  if (baseTs(t, o) === 'Date') {
    const fn = helper(ctx, t.logical === 'date' ? 'toSqliteDate' : 'toSqliteDateTime');
    return nullable ? `${expr} == null ? null : ${fn}(${expr})` : `${fn}(${expr})`;
  }
  return nullable && ctxOptional(o) ? `${expr} ?? null` : expr;
}

const ctxOptional = (o: CodegenOptions) => o.tsNullable === 'optional';

function needsRowMap(members: Member[], d: Dialect, o: CodegenOptions): boolean {
  return d === 'sqlite' && members.some((m) => m.type.logical === 'bool' || baseTs(m.type, o) === 'Date');
}

/** A better-sqlite3 row value as the member's type: 0/1 → boolean, SQLite date text → Date (tsDate 'Date'), else a cast. */
function sqliteRead(src: string, m: Member, ctx: Ctx): string {
  const { o } = ctx;
  if (m.type.logical === 'bool') return m.nullable ? `${src} == null ? null : ${src} === 1` : `${src} === 1`;
  if (baseTs(m.type, o) === 'Date') {
    const fn = helper(ctx, m.type.logical === 'date' ? 'fromSqliteDate' : 'fromSqliteDateTime');
    // SQLite returns what is stored: text in its own formats, or a number (unix seconds / julian day) for numeric dates.
    return m.nullable ? `${src} == null ? null : ${fn}(${src} as string | number)` : `${fn}(${src} as string | number)`;
  }
  return `${src} as ${tsType(m.type, m.nullable, o)}`;
}

function rowMapper(w: Writer, typeName: string, members: Member[], ctx: Ctx) {
  w.block(`function to${typeName}(r: Record<string, unknown>): ${typeName} {`, () => {
    w.block('return {', () => {
      for (const m of members) w.line(`${m.name}: ${sqliteRead(`r[${JSON.stringify(m.name)}]`, m, ctx)},`);
    }, '};');
  });
}

function driverCrud(w: Writer, t: CgTable, typeName: string, members: Member[], ctx: Ctx) {
  const { d, o } = ctx;
  const drv = DRIVER[d];
  ctx.imports.set(drv.module, drv.import);
  const byCol = new Map(members.map((m) => [m.col, m]));
  const ph = d === 'tsql' ? (n: string) => `@${n}` : d === 'plsql' ? (n: string) => `:${n}` : () => '?';
  const crud = crudSql(t, d, {
    placeholder: ph,
    bindName: (c) => byCol.get(c)!.name,
    alias: (c) => (byCol.get(c)!.name === c.name ? null : byCol.get(c)!.name),
    identityReturn: d === 'sqlite' ? 'none' : 'auto',
    newline: '\n',
  });
  const pk = pkMembers(members, t.primaryKey);
  const plural = camel(t.name);
  for (const n of ['get', 'insert', 'update', 'delete']) ctx.exported.add(`${n}${typeName}`);
  ctx.exported.add(`list${pascal(plural)}`);
  const scope = new NameScope(['db', 'pool', 'conn', 'result', 'row', 'info', 'e', 'request']);
  const keys = pk.map((m) => ({ m, local: scope.take(localName(m.col.name, o)) }));
  const keySig = keys.map((k) => `${k.local}: ${tsType(k.m.type, false, o)}`).join(', ');
  const connParam = d === 'tsql' ? 'pool' : d === 'plsql' ? 'conn' : 'db';
  const conn = `${connParam}: ${drv.conn}`;
  const mapRows = needsRowMap(members, d, o);
  if (mapRows) {
    rowMapper(w, typeName, members, ctx);
    w.blank();
  }
  const sqlName = (n: string) => `${camel(typeName)}${n}Sql`;
  const decl = (n: string, sql: string) => {
    w.line(`const ${sqlName(n)} = ${backtick(sql)};`);
    w.blank();
  };
  decl('Select', crud.selectAll);
  if (crud.selectByPk) decl('Get', crud.selectByPk.sql);
  if (crud.insert) decl('Insert', crud.insert.sql);
  if (crud.update) decl('Update', crud.update.sql);
  if (crud.delete) decl('Delete', crud.delete.sql);

  const mssqlInputs = (cols: { bind: string; expr: string; t: ResolvedType }[]) => cols.map((c) => `.input('${c.bind}', ${mssqlType(c.t)}, ${c.expr})`).join('\n');
  const entityBinds = (cols: typeof crud.update extends null ? never : NonNullable<typeof crud.update>['params']) =>
    cols.map((c) => ({ bind: byCol.get(c)!.name, expr: `e.${byCol.get(c)!.name}`, t: byCol.get(c)!.type, nullable: byCol.get(c)!.nullable }));
  const keyBinds = keys.map((k) => ({ bind: k.m.name, expr: k.local, t: k.m.type, nullable: false }));
  const oracleObj = (b: { bind: string; expr: string }[]) => `{ ${b.map((x) => (x.bind === x.expr ? x.bind : `${x.bind}: ${x.expr}`)).join(', ')} }`;
  const nul = (e: string, nullable: boolean) => (nullable && ctxOptional(o) ? `${e} ?? null` : e);

  // get
  if (crud.selectByPk) {
    w.line(`/** The ${t.name} row with the given key, or undefined. */`);
    if (d === 'tsql') {
      w.block(`export async function get${typeName}(${conn}, ${keySig}): Promise<${typeName} | undefined> {`, () => {
        w.line('const result = await pool');
        w.indent().line('.request()').lines_(mssqlInputs(keyBinds)).line(`.query<${typeName}>(${sqlName('Get')});`).dedent();
        w.line('return result.recordset[0];');
      });
    } else if (d === 'plsql') {
      w.block(`export async function get${typeName}(${conn}, ${keySig}): Promise<${typeName} | undefined> {`, () => {
        w.line(`const result = await conn.execute<${typeName}>(${sqlName('Get')}, ${oracleObj(keyBinds)}, { outFormat: oracledb.OUT_FORMAT_OBJECT });`);
        w.line('return result.rows?.[0];');
      });
    } else {
      w.block(`export function get${typeName}(${conn}, ${keySig}): ${typeName} | undefined {`, () => {
        if (mapRows) {
          w.line(`const row = db.prepare<unknown[], Record<string, unknown>>(${sqlName('Get')}).get(${keys.map((k) => k.local).join(', ')});`);
          w.line(`return row ? to${typeName}(row) : undefined;`);
        } else {
          w.line(`return db.prepare<unknown[], ${typeName}>(${sqlName('Get')}).get(${keys.map((k) => k.local).join(', ')});`);
        }
      });
    }
    w.blank();
  }
  // list
  w.line(`/** Every ${t.name} row. */`);
  if (d === 'tsql') {
    w.block(`export async function list${pascal(plural)}(${conn}): Promise<${typeName}[]> {`, () => {
      w.line(`const result = await pool.request().query<${typeName}>(${sqlName('Select')});`);
      w.line('return result.recordset;');
    });
  } else if (d === 'plsql') {
    w.block(`export async function list${pascal(plural)}(${conn}): Promise<${typeName}[]> {`, () => {
      w.line(`const result = await conn.execute<${typeName}>(${sqlName('Select')}, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });`);
      w.line('return result.rows ?? [];');
    });
  } else {
    w.block(`export function list${pascal(plural)}(${conn}): ${typeName}[] {`, () => {
      if (mapRows) w.line(`return db.prepare<[], Record<string, unknown>>(${sqlName('Select')}).all().map(to${typeName});`);
      else w.line(`return db.prepare<[], ${typeName}>(${sqlName('Select')}).all();`);
    });
  }
  // insert
  if (crud.insert) {
    w.blank();
    const ins = crud.insert;
    const identity = t.columns.find((c) => c.identity);
    const idMember = identity ? byCol.get(identity)! : null;
    const binds = entityBinds(ins.params);
    // The generated key and the server-defaulted columns are not inserted: callers need not (and cannot) pass them.
    const omitted = [...(idMember ? [idMember.name] : []), ...ins.defaulted.map((c) => byCol.get(c)!.name)];
    const inputType = omitted.length ? `Omit<${typeName}, ${omitted.map((n) => `'${n}'`).join(' | ')}>` : typeName;
    const idTs = idMember ? tsType(idMember.type, false, o) : null;
    const note = defaultsNote(ins, !!crud.update);
    w.line(`/** ${idMember ? `Inserts a row and returns its generated ${identity!.name}.` : 'Inserts a row.'}${note ? ` ${note}` : ''} */`);
    if (d === 'tsql') {
      w.block(`export async function insert${typeName}(${conn}, e: ${inputType}): Promise<${idTs ?? 'void'}> {`, () => {
        w.line(idMember ? 'const result = await pool' : 'await pool');
        w.indent().line('.request()').lines_(mssqlInputs(binds.map((b) => ({ ...b, expr: nul(b.expr, b.nullable) })))).line(`.query${idMember ? `<{ ${/^[A-Za-z_$][\w$]*$/.test(idMember.col.name) ? idMember.col.name : JSON.stringify(idMember.col.name)}: ${idTs} }>` : ''}(${sqlName('Insert')});`).dedent();
        if (idMember) w.line(`return result.recordset[0].${/^[A-Za-z_$][\w$]*$/.test(idMember.col.name) ? idMember.col.name : `[${JSON.stringify(idMember.col.name)}]`};`);
      });
    } else if (d === 'plsql') {
      w.block(`export async function insert${typeName}(${conn}, e: ${inputType}): Promise<${idTs ?? 'void'}> {`, () => {
        const obj = binds.map((b) => `${b.bind}: ${nul(b.expr, b.nullable)}`);
        if (idMember && ins.returningBind) obj.push(`${ins.returningBind}: { dir: oracledb.BIND_OUT, type: ${oracleType(idMember.type)} }`);
        const outBinds = idMember && ins.returningBind ? `{ ${ins.returningBind}: ${idTs}[] }` : null;
        w.line(`${outBinds ? 'const result = ' : ''}await conn.execute${outBinds ? `<${outBinds}>` : ''}(${sqlName('Insert')}, {`);
        w.indent();
        for (const x of obj) w.line(`${x},`);
        w.dedent();
        w.line('});');
        // DML RETURNING INTO yields one array element per affected row.
        if (outBinds) w.line(`return result.outBinds!.${ins.returningBind}[0];`);
      });
    } else {
      w.block(`export function insert${typeName}(${conn}, e: ${inputType}): ${idTs ? idTs : 'void'} {`, () => {
        const args = binds.map((b) => sqliteBind(b.expr, b.t, b.nullable, ctx)).join(', ');
        if (idMember) {
          w.line(`const info = db.prepare(${sqlName('Insert')}).run(${args});`);
          w.line(idTs === 'bigint' ? 'return BigInt(info.lastInsertRowid);' : `return Number(info.lastInsertRowid);`);
        } else {
          w.line(`db.prepare(${sqlName('Insert')}).run(${args});`);
        }
      });
    }
  }
  // update / delete
  const affected = (name: string, verb: string, sqlKey: string, binds: { bind: string; expr: string; t: ResolvedType; nullable: boolean }[], params: string) => {
    w.blank();
    w.line(`/** ${verb}; returns false when no row has the key. */`);
    if (d === 'tsql') {
      w.block(`export async function ${name}(${conn}, ${params}): Promise<boolean> {`, () => {
        w.line('const result = await pool');
        w.indent().line('.request()').lines_(mssqlInputs(binds.map((b) => ({ ...b, expr: nul(b.expr, b.nullable) })))).line(`.query(${sqlName(sqlKey)});`).dedent();
        w.line('return result.rowsAffected[0] === 1;');
      });
    } else if (d === 'plsql') {
      w.block(`export async function ${name}(${conn}, ${params}): Promise<boolean> {`, () => {
        w.line(`const result = await conn.execute(${sqlName(sqlKey)}, { ${binds.map((b) => (b.bind === b.expr ? b.bind : `${b.bind}: ${nul(b.expr, b.nullable)}`)).join(', ')} });`);
        w.line('return result.rowsAffected === 1;');
      });
    } else {
      w.block(`export function ${name}(${conn}, ${params}): boolean {`, () => {
        w.line(`return db.prepare(${sqlName(sqlKey)}).run(${binds.map((b) => sqliteBind(b.expr, b.t, b.nullable, ctx)).join(', ')}).changes === 1;`);
      });
    }
  };
  if (crud.update) affected(`update${typeName}`, `Updates every non-key column of the ${t.name} row with the key of e`, 'Update', entityBinds(crud.update.params), `e: ${typeName}`);
  if (crud.delete) affected(`delete${typeName}`, `Deletes the ${t.name} row with the given key`, 'Delete', keyBinds, keySig);
}

// ---------------- routines ----------------

function routineDriver(w: Writer, r: CgRoutine, ctx: Ctx, prefix: string) {
  const { d, o } = ctx;
  const drv = DRIVER[d];
  ctx.imports.set(drv.module, drv.import);
  const fn = claim(ctx, camel(`${prefix}${r.name}`), camel(`${prefix}${r.name}_proc`));
  const scope = new NameScope(['pool', 'conn', 'result', 'request', 'rows', 'out']);
  const args = callParams(r)
    .filter((p) => p.direction === 'in' || p.direction === 'inout')
    .map((p) => {
      const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
      return { p, rt, local: scope.take(localName(bindNameOf(p), o)), type: tsType(rt, p.hasDefault, o) };
    });
  const outs = callParams(r).filter((p) => p.direction === 'out' || p.direction === 'inout');
  const ret = returnParam(r);
  const sqlName = routineSqlName(r, d, qi);
  const connParam = d === 'tsql' ? 'pool' : 'conn';
  const sig = [`${connParam}: ${drv.conn}`, ...args.map((a) => `${a.local}: ${a.type}${a.p.hasDefault ? ' = null' : ''}`)].join(', ');
  const resultName = pascal(`${prefix}${r.name}_result`);
  const outProps = outs.map((p) => {
    const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
    return { p, rt, name: camel(friendlyParam(bindNameOf(p))), cursor: isRefCursor(p.dbType), type: isRefCursor(p.dbType) ? 'Record<string, unknown>[]' : tsType(rt, true, o) };
  });

  if (r.kind === 'func' && ret) {
    const rt = resolveType(d, ret.dbType, { numberOneAsBool: o.numberOneAsBool });
    const t = tsType(rt, true, o);
    w.line(`/** Calls ${objectLabel(r)}. */`);
    w.block(`export async function ${fn}(${sig}): Promise<${t}> {`, () => {
      if (d === 'tsql') {
        w.line('const result = await pool');
        w.indent().line('.request()').lines_(args.map((a) => `.input('${bindNameOf(a.p)}', ${mssqlType(a.rt)}, ${a.local})`)).line(`.query<{ value: ${t} }>(${backtick(`SELECT ${sqlName}(${callParams(r).map((p) => p.name).join(', ')}) AS value`)});`).dedent();
        w.line('return result.recordset[0]?.value ?? null;');
      } else {
        w.line(`const result = await conn.execute<{ VALUE: ${t} }>(`);
        w.indent();
        w.line(`${backtick(`SELECT ${sqlName}(${callParams(r).map((p) => `:${bindNameOf(p)}`).join(', ')}) AS value FROM DUAL`)},`);
        w.line(`{ ${args.map((a) => `${bindNameOf(a.p)}: ${a.local}`).join(', ')} },`);
        w.line('{ outFormat: oracledb.OUT_FORMAT_OBJECT },');
        w.dedent();
        w.line(');');
        w.line('return result.rows?.[0]?.VALUE ?? null;');
      }
    });
    return;
  }

  const hasRows = d === 'tsql';
  const fields = [...(hasRows ? ['rows: Record<string, unknown>[];'] : []), ...outProps.map((p) => `${p.name}: ${p.type};`), ...(d === 'tsql' ? ['returnValue: number;'] : [])];
  const hasResult = outProps.length > 0 || hasRows;
  if (hasResult) {
    w.line(`/** What ${objectLabel(r)} returns. */`);
    w.block(`export interface ${resultName} {`, () => fields.forEach((f) => w.line(f)));
    w.blank();
  }
  w.line(`/** Calls ${objectLabel(r)}. */`);
  w.block(`export async function ${fn}(${sig}): Promise<${hasResult ? resultName : 'void'}> {`, () => {
    if (d === 'tsql') {
      w.line('const result = await pool');
      w.indent().line('.request()');
      for (const p of callParams(r)) {
        const a = args.find((x) => x.p === p);
        const op = outProps.find((x) => x.p === p);
        if (p.direction === 'in') w.line(`.input('${bindNameOf(p)}', ${mssqlType(a!.rt)}, ${a!.local})`);
        else if (p.direction === 'out') w.line(`.output('${bindNameOf(p)}', ${mssqlType(op!.rt)})`);
        else w.line(`.output('${bindNameOf(p)}', ${mssqlType(op!.rt)}, ${a!.local})`);
      }
      w.line(`.execute(${JSON.stringify(sqlName)});`).dedent();
      w.block('return {', () => {
        w.line('rows: result.recordset ?? [],');
        for (const p of outProps) w.line(`${p.name}: result.output.${bindNameOf(p.p)} as ${p.type},`);
        w.line('returnValue: result.returnValue,');
      }, '};');
    } else {
      const binds = callParams(r).map((p) => {
        const a = args.find((x) => x.p === p);
        const op = outProps.find((x) => x.p === p);
        if (p.direction === 'in') return `${bindNameOf(p)}: ${a!.local}`;
        if (p.direction === 'out') return `${bindNameOf(p)}: { dir: oracledb.BIND_OUT, type: ${oracleType(op!.rt)}${op!.rt.logical === 'string' && !op!.cursor ? `, maxSize: ${op!.rt.length ?? 32767}` : ''} }`;
        return `${bindNameOf(p)}: { dir: oracledb.BIND_INOUT, val: ${a!.local}, type: ${oracleType(op!.rt)} }`;
      });
      const call = `BEGIN ${sqlName}(${callParams(r).map((p) => `${bindNameOf(p)} => :${bindNameOf(p)}`).join(', ')}); END;`;
      const outType = outProps.length ? `{ ${outProps.map((p) => `${bindNameOf(p.p)}: ${p.cursor ? 'oracledb.ResultSet<Record<string, unknown>>' : p.type}`).join('; ')} }` : 'never';
      w.line(`${outProps.length ? 'const result = ' : ''}await conn.execute${outProps.length ? `<${outType}>` : ''}(${backtick(call)}, {`);
      w.indent();
      for (const b of binds) w.line(`${b},`);
      w.dedent();
      w.line(`}${outProps.some((p) => p.cursor) ? ', { outFormat: oracledb.OUT_FORMAT_OBJECT }' : ''});`);
      if (outProps.length) {
        w.line('const out = result.outBinds!;');
        for (const c of outProps.filter((p) => p.cursor)) {
          const rs = `${c.name}Cursor`;
          w.line(`const ${rs} = out.${bindNameOf(c.p)};`);
          w.line(`const ${c.name}Rows = await ${rs}.getRows();`);
          w.line(`await ${rs}.close();`);
        }
        w.block('return {', () => {
          for (const p of outProps) w.line(p.cursor ? `${p.name}: ${p.name}Rows,` : `${p.name}: out.${bindNameOf(p.p)},`);
        }, '};');
      }
    }
  });
}

// ---------------- queries ----------------

function queryDriver(w: Writer, q: CgQuery, ctx: Ctx) {
  const { d, o } = ctx;
  const drv = DRIVER[d];
  ctx.imports.set(drv.module, drv.import);
  const rowType = typeNameOf(withSuffix(q.name, 'row'), o, false);
  const members = membersOf(q.columns, d, o, rowType);
  interfaceDecl(w, rowType, members, `Row of the ${q.name} query.`, ctx);
  w.blank();
  const fn = claim(ctx, camel(queryFnBase(q.name)), camel(withSuffix(q.name, 'query')));
  const scope = new NameScope(['pool', 'conn', 'db', 'result']);
  const args = q.params.map((p) => {
    const local = scope.take(localName(p.name, o));
    // better-sqlite3 binds numbers, strings, bigints, buffers and null only: booleans and Dates are converted.
    return { p, local, type: queryParamTs(p.type, o), bind: d === 'sqlite' ? sqliteBind(local, queryParamResolved(p.type), false, ctx) : local };
  });
  const style = d === 'tsql' ? 'at' : d === 'plsql' ? 'colon' : 'keep';
  const { sql, order } = rewriteQuery(trimStatement(q.sql), d, style);
  const aliased = members.some((m) => m.name !== m.col.name);
  w.line(`const ${fn}Sql = ${backtick(sql)};`);
  w.blank();
  if (aliased) w.line(`// Rows arrive keyed by column name; ${members.filter((m) => m.name !== m.col.name).map((m) => `${m.col.name} -> ${m.name}`).join(', ')} are mapped below.`);
  const mapExpr = (r: string) =>
    `{ ${members.map((m) => {
      const src = `${r}[${JSON.stringify(m.col.name)}]`;
      return `${m.name}: ${d === 'sqlite' ? sqliteRead(src, m, ctx) : `${src} as ${tsType(m.type, m.nullable, o)}`}`;
    }).join(', ')} }`;
  const connParam = d === 'tsql' ? 'pool' : d === 'plsql' ? 'conn' : 'db';
  const sig = [`${connParam}: ${drv.conn}`, ...args.map((a) => `${a.local}: ${a.type}`)].join(', ');
  w.line(`/** Runs the ${q.name} query. */`);
  if (d === 'tsql') {
    w.block(`export async function ${fn}(${sig}): Promise<${rowType}[]> {`, () => {
      w.line('const result = await pool');
      w.indent().line('.request()').lines_(args.map((a) => `.input('${a.p.name}', ${queryParamMssql(a.p.type)}, ${a.local})`)).line(`.query${aliased ? '' : `<${rowType}>`}(${fn}Sql);`).dedent();
      w.line(aliased ? `return result.recordset.map((r) => (${mapExpr('r')}));` : 'return result.recordset;');
    });
  } else if (d === 'plsql') {
    w.block(`export async function ${fn}(${sig}): Promise<${rowType}[]> {`, () => {
      w.line(`const result = await conn.execute<${aliased ? 'Record<string, unknown>' : rowType}>(${fn}Sql, { ${args.map((a) => (a.p.name === a.local ? a.local : `${a.p.name}: ${a.local}`)).join(', ')} }, { outFormat: oracledb.OUT_FORMAT_OBJECT });`);
      w.line(aliased ? `return (result.rows ?? []).map((r) => (${mapExpr('r')}));` : 'return result.rows ?? [];');
    });
  } else {
    const positional = q.params.some((p) => p.positional);
    const bindArgs = positional
      ? order.map((n) => args.find((a) => a.p.name === n)!.bind).join(', ')
      : `{ ${args.map((a) => (a.p.name === a.bind ? a.bind : `${a.p.name}: ${a.bind}`)).join(', ')} }`;
    w.block(`export function ${fn}(${sig}): ${rowType}[] {`, () => {
      w.line(`const rows = db.prepare<unknown[], Record<string, unknown>>(${fn}Sql).all(${args.length ? bindArgs : ''});`);
      w.line(`return rows.map((r) => (${mapExpr('r')}));`);
    });
  }
}

function queryParamTs(t: CgQuery['params'][number]['type'], o: CodegenOptions): string {
  if (t === 'int' || t === 'float') return 'number';
  if (t === 'long') return o.tsBigint === 'number' ? 'number' : o.tsBigint;
  if (t === 'decimal') return o.tsDecimal;
  if (t === 'bool') return 'boolean';
  if (t === 'binary') return 'Buffer';
  if (t === 'date' || t === 'datetime' || t === 'datetimeoffset') return o.tsDate === 'Date' ? 'Date' : 'string';
  return 'string';
}

/** A query parameter type as a resolved type (for the shared per-driver conversions). */
function queryParamResolved(t: CgQuery['params'][number]['type']): ResolvedType {
  const db: Record<string, string> = {
    string: 'nvarchar', int: 'int', long: 'bigint', decimal: 'decimal', float: 'float', bool: 'bit', date: 'date', datetime: 'datetime2',
    datetimeoffset: 'datetimeoffset', time: 'time', guid: 'uniqueidentifier', binary: 'varbinary',
  };
  return resolveType('tsql', db[t] ?? 'nvarchar');
}

function queryParamMssql(t: CgQuery['params'][number]['type']): string {
  const m: Record<string, string> = {
    string: 'sql.NVarChar(sql.MAX)', int: 'sql.Int', long: 'sql.BigInt', decimal: 'sql.Decimal(38, 10)', float: 'sql.Float', bool: 'sql.Bit',
    date: 'sql.Date', datetime: 'sql.DateTime2', datetimeoffset: 'sql.DateTimeOffset', time: 'sql.Time', guid: 'sql.UniqueIdentifier', binary: 'sql.VarBinary(sql.MAX)',
  };
  return m[t] ?? 'sql.NVarChar(sql.MAX)';
}

// ---------------- PostgreSQL (node-postgres) ----------------

/** A type as node-postgres reads it: money arrives as locale-formatted text ('$1,234.50'), so it is typed as a string. */
function pgReadType(t: ResolvedType): ResolvedType {
  return t.base === 'money' ? { ...t, logical: 'string', ts: 'string' } : t;
}

const pgReadMember = (m: Member): Member => ({ ...m, type: pgReadType(m.type) });

/** What node-postgres does differently from the field type, as a doc note (driver flavor only). */
function pgDriverNote(m: Member, ctx: Ctx): string {
  if (ctx.d !== 'pgsql' || ctx.o.flavor !== 'driver') return '';
  const t = m.type;
  if (t.base === 'money') return "money arrives as locale-formatted text ('$1,234.50')";
  if (t.array && t.element?.enumLabels?.length) return "node-postgres returns arrays of enum types as text ('{new,paid}') unless a type parser is registered for the array type's OID";
  if (t.array && t.element && pgParser(t.element, ctx.o)) return "array elements keep node-postgres' default parsing (int8 / numeric / date elements are not converted)";
  return '';
}

/** Parser order and doc text of the scoped node-postgres type parsers. */
const PG_PARSER_DOC: [string, string][] = [
  ['INT8', 'int8 as a {ts} (node-postgres returns it as text because values can exceed 2^53)'],
  ['NUMERIC', 'numeric as a number (text by default; digits beyond a double are lost: set the decimal mapping to string to keep them)'],
  ['DATE', 'date kept as text (node-postgres would return a Date at local midnight)'],
  ['TIMESTAMP', 'timestamp kept as text (node-postgres would return a Date)'],
  ['TIMESTAMPTZ', 'timestamptz kept as text (node-postgres would return a Date)'],
  ['INTERVAL', 'interval kept as text (node-postgres would return an interval object)'],
];

/** The node-postgres type parser that makes a column read as its field type, if pg's default does not: [builtin, parse fn]. */
function pgParser(t: ResolvedType, o: CodegenOptions): [string, string] | null {
  if (t.array) return null;
  switch (t.logical) {
    case 'int64':
      if (o.tsBigint === 'number') return ['INT8', '(v) => Number.parseInt(v, 10)'];
      return o.tsBigint === 'bigint' ? ['INT8', '(v) => BigInt(v)'] : null;
    case 'decimal':
      return o.tsDecimal === 'number' ? ['NUMERIC', '(v) => Number.parseFloat(v)'] : null;
    case 'date':
      return o.tsDate === 'string' ? ['DATE', '(v) => v'] : null;
    case 'datetime':
      return o.tsDate === 'string' ? ['TIMESTAMP', '(v) => v'] : null;
    case 'datetimeoffset':
      return o.tsDate === 'string' ? ['TIMESTAMPTZ', '(v) => v'] : null;
    case 'interval':
      return ['INTERVAL', '(v) => v'];
    default:
      return null;
  }
}

/** Register the parsers the read types need (emitted once per file as `pgTypes`); true when the query must pass them. */
function registerPgTypes(ctx: Ctx, types: ResolvedType[]): boolean {
  let any = false;
  for (const t of types) {
    const p = pgParser(t, ctx.o);
    if (!p) continue;
    ctx.helpers.set(`pg:${p[0]}`, `pgTypes.setTypeParser(pg.types.builtins.${p[0]}, ${p[1]});`);
    any = true;
  }
  return any;
}

/** The `pgTypes` declaration for the parser lines of a file (helpers keyed `pg:<builtin>`). */
function pgTypesBlock(helpers: Map<string, string>, o: CodegenOptions): string {
  const used = PG_PARSER_DOC.filter(([k]) => helpers.has(`pg:${k}`));
  return [
    '/**',
    ' * node-postgres type parsers of the queries below, passed per query so the global pg.types stay untouched:',
    ...used.map(([, doc]) => ` * - ${doc.replace('{ts}', o.tsBigint === 'bigint' ? 'bigint' : 'number')}`),
    ' */',
    'const pgTypes = new pg.TypeOverrides();',
    ...used.map(([k]) => helpers.get(`pg:${k}`)!),
  ].join('\n');
}

/** `pool.query(...)`: the config form with the scoped parsers when the result needs them, else `(text, values)`. */
function pgCall(w: Writer, lhs: string, rowType: string | null, text: string, values: string[] | 'values', parsed: boolean) {
  const generic = rowType ? `<${rowType}>` : '';
  const vals = values === 'values' ? 'values' : `[${values.join(', ')}]`;
  if (!parsed) {
    w.line(`${lhs}pool.query${generic}(${text}${values === 'values' || values.length ? `, ${vals}` : ''});`);
    return;
  }
  const fields = [`text: ${text}`, ...(values === 'values' ? ['values'] : values.length ? [`values: ${vals}`] : []), 'types: pgTypes'];
  const one = `${lhs}pool.query${generic}({ ${fields.join(', ')} });`;
  if (one.length <= 120) {
    w.line(one);
    return;
  }
  w.block(`${lhs}pool.query${generic}({`, () => fields.forEach((f) => w.line(`${f},`)), '});');
}

/** A value as node-postgres should bind it: JSON columns are stringified (pg would send a JS array as a PostgreSQL array). */
function pgBind(expr: string, t: ResolvedType, nullable: boolean, o: CodegenOptions): string {
  if (t.logical === 'json' && !t.array) return nullable ? `${expr} == null ? null : JSON.stringify(${expr})` : `JSON.stringify(${expr})`;
  return nullable && ctxOptional(o) ? `${expr} ?? null` : expr;
}

const propKey = (n: string) => (/^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n));
const propAccess = (n: string) => (/^[A-Za-z_$][\w$]*$/.test(n) ? `.${n}` : `[${JSON.stringify(n)}]`);

function pgCrud(w: Writer, t: CgTable, typeName: string, members: Member[], ctx: Ctx) {
  const { d, o } = ctx;
  ctx.imports.set('pg', DRIVER.pgsql.import);
  const byCol = new Map(members.map((m) => [m.col, m]));
  const crud = crudSql(t, d, {
    placeholder: PH.dollar,
    bindName: (c) => byCol.get(c)!.name,
    // node-postgres keys rows by the select-list name: alias the columns whose property is spelled differently.
    alias: (c) => (byCol.get(c)!.name === c.name ? null : byCol.get(c)!.name),
    identityReturn: 'auto',
    newline: '\n',
  });
  const pk = pkMembers(members, t.primaryKey);
  const plural = camel(t.name);
  for (const n of ['get', 'insert', 'update', 'delete']) ctx.exported.add(`${n}${typeName}`);
  ctx.exported.add(`list${pascal(plural)}`);
  const scope = new NameScope(['pool', 'result', 'e', 'values', 'pgTypes']);
  const keys = pk.map((m) => ({ m, local: scope.take(localName(m.col.name, o)) }));
  const keySig = keys.map((k) => `${k.local}: ${tsType(k.m.type, false, o)}`).join(', ');
  const conn = `pool: ${DRIVER.pgsql.conn}`;
  const rowParsed = registerPgTypes(ctx, members.map((m) => m.type));
  const sqlName = (n: string) => `${camel(typeName)}${n}Sql`;
  const decl = (n: string, sql: string) => {
    w.line(`const ${sqlName(n)} = ${backtick(sql)};`);
    w.blank();
  };
  decl('Select', crud.selectAll);
  if (crud.selectByPk) decl('Get', crud.selectByPk.sql);
  if (crud.insert) decl('Insert', crud.insert.sql);
  if (crud.update) decl('Update', crud.update.sql);
  if (crud.delete) decl('Delete', crud.delete.sql);
  const entityValues = (cols: { name: string }[]) =>
    cols.map((c) => {
      const m = members.find((x) => x.col.name === c.name)!;
      return pgBind(`e.${m.name}`, m.type, m.nullable, o);
    });

  if (crud.selectByPk) {
    w.line(`/** The ${t.name} row with the given key, or undefined. */`);
    w.block(`export async function get${typeName}(${conn}, ${keySig}): Promise<${typeName} | undefined> {`, () => {
      pgCall(w, 'const result = await ', typeName, sqlName('Get'), keys.map((k) => k.local), rowParsed);
      w.line('return result.rows[0];');
    });
    w.blank();
  }
  w.line(`/** Every ${t.name} row. */`);
  w.block(`export async function list${pascal(plural)}(${conn}): Promise<${typeName}[]> {`, () => {
    pgCall(w, 'const result = await ', typeName, sqlName('Select'), [], rowParsed);
    w.line('return result.rows;');
  });
  if (crud.insert) {
    w.blank();
    const ins = crud.insert;
    const identity = ins.returning;
    const idMember = identity ? byCol.get(identity)! : null;
    // The generated key, the server-defaulted and the generated (computed) columns are not inserted.
    const omitted = [
      ...(idMember ? [idMember.name] : []),
      ...ins.defaulted.map((c) => byCol.get(c)!.name),
      ...members.filter((m) => m.col.computed && m !== idMember).map((m) => m.name),
    ];
    const inputType = omitted.length ? `Omit<${typeName}, ${omitted.map((n) => sq(n)).join(' | ')}>` : typeName;
    const idTs = idMember ? tsType(idMember.type, false, o) : null;
    const note = defaultsNote(ins, !!crud.update);
    w.line(`/** ${idMember ? `Inserts a row and returns its generated ${identity!.name} (RETURNING).` : 'Inserts a row.'}${note ? ` ${note}` : ''} */`);
    w.block(`export async function insert${typeName}(${conn}, e: ${inputType}): Promise<${idTs ?? 'void'}> {`, () => {
      const values = entityValues(ins.params);
      if (idMember && identity) {
        pgCall(w, 'const result = await ', `{ ${propKey(identity.name)}: ${idTs} }`, sqlName('Insert'), values, registerPgTypes(ctx, [idMember.type]));
        w.line(`return result.rows[0]${propAccess(identity.name)};`);
      } else pgCall(w, 'await ', null, sqlName('Insert'), values, false);
    });
  }
  const affected = (name: string, verb: string, sqlKey: string, values: string[], params: string) => {
    w.blank();
    w.line(`/** ${verb}; returns false when no row has the key. */`);
    w.block(`export async function ${name}(${conn}, ${params}): Promise<boolean> {`, () => {
      pgCall(w, 'const result = await ', null, sqlName(sqlKey), values, false);
      w.line('return result.rowCount === 1;');
    });
  };
  if (crud.update) affected(`update${typeName}`, `Updates every non-key column of the ${t.name} row with the key of e`, 'Update', entityValues(crud.update.params), `e: ${typeName}`);
  if (crud.delete) affected(`delete${typeName}`, `Deletes the ${t.name} row with the given key`, 'Delete', keys.map((k) => k.local), keySig);
}

/** Claim an exported name, numbering repeats (`fnTax`, `fnTax2`): PostgreSQL overloads share a name. */
function claimNumbered(ctx: Ctx, name: string): string {
  let n = name;
  for (let i = 2; ctx.exported.has(n); i++) n = `${name}${i}`;
  ctx.exported.add(n);
  return n;
}

/** `public.fn_tax(amount numeric, rate numeric = default)` for docs. */
export function pgSignature(r: CgRoutine): string {
  const ps = callParams(r).map((p) => [p.direction === 'in' ? '' : `${p.direction.toUpperCase()} `, p.name, p.name ? ' ' : '', p.dbType, p.hasDefault ? ' = default' : ''].join(''));
  return `${objectLabel(r)}(${ps.join(', ')})`;
}

function pgRoutine(w: Writer, r: CgRoutine, ctx: Ctx) {
  const { d, o } = ctx;
  ctx.imports.set('pg', DRIVER.pgsql.import);
  const fn = claimNumbered(ctx, camel(r.name));
  const params = callParams(r);
  const scope = new NameScope(['pool', 'result', 'values', 'args', 'row', 'pgTypes']);
  const named = params.every((p) => !!bindNameOf(p));
  const inputs = params
    .filter((p) => p.direction === 'in' || p.direction === 'inout')
    .map((p, i) => {
      const rt = pgReadType(resolveType(d, p.dbType));
      // Without parameter names an omitted argument cannot be skipped (named notation needs the name).
      const optional = p.hasDefault && named;
      return { p, rt, optional, local: scope.take(bindNameOf(p) ? localName(bindNameOf(p), o) : `arg${i + 1}`), type: tsType(rt, optional || p.direction === 'inout', o) };
    });
  const sig = [
    `pool: ${DRIVER.pgsql.conn}`,
    ...inputs.filter((a) => !a.optional).map((a) => `${a.local}: ${a.type}`),
    ...inputs.filter((a) => a.optional).map((a) => `${a.local}?: ${a.type}`),
  ].join(', ');
  const sqlName = routineSqlName(r, d, qi);
  const isProc = r.kind === 'proc';
  const outs = params.filter((p) => p.direction === 'out' || p.direction === 'inout');
  // A function's OUT parameters come back as result columns; a procedure takes NULL for each OUT argument.
  const sqlParams = params.filter((p) => isProc || p.direction !== 'out');
  const firstOptional = sqlParams.findIndex((p) => inputs.find((a) => a.p === p)?.optional);
  const dynamic = firstOptional >= 0;
  const head = dynamic ? sqlParams.slice(0, firstOptional) : sqlParams;
  const headValues: string[] = [];
  const headArgs = head.map((p) => {
    const a = inputs.find((x) => x.p === p);
    if (!a) return 'NULL';
    headValues.push(a.local);
    return `$${headValues.length}::${p.dbType}`;
  });
  /** Emit the argument list; returns the SQL text expression builder and the values expression. */
  const argList = (): { text: (sql: (args: string) => string) => string; values: string[] | 'values' } => {
    if (!dynamic) return { text: (sql) => backtick(sql(headArgs.join(', '))), values: headValues };
    w.line(`const values: unknown[] = [${headValues.join(', ')}];`);
    w.line(`const args: string[] = [${headArgs.map((a) => sq(a)).join(', ')}];`);
    for (const p of sqlParams.slice(firstOptional)) {
      const a = inputs.find((x) => x.p === p);
      const nm = `${qi(bindNameOf(p), d)} => `;
      if (!a) w.line(`args.push(${sq(`${nm}NULL`)});`);
      else if (a.optional) {
        w.block(`if (${a.local} !== undefined) {`, () => {
          w.line(`values.push(${a.local});`);
          w.line(`args.push(\`${nm}$\${values.length}::${p.dbType}\`);`);
        });
      } else {
        w.line(`values.push(${a.local});`);
        w.line(`args.push(\`${nm}$\${values.length}::${p.dbType}\`);`);
      }
    }
    return { text: (sql) => `\`${sql('${args.join(\', \')}')}\``, values: 'values' };
  };
  const doc = `/** Calls ${pgSignature(r)}.${dynamic ? ' Arguments left undefined keep their defaults.' : ''} */`;
  const ret = returnParam(r);
  const retText = ret?.dbType.trim() ?? '';

  if (!isProc) {
    // Result shape: catalog result columns (RETURNS TABLE) / OUT columns → typed rows; SETOF / record → loose rows; void; else one scalar.
    const tableCols = r.resultColumns?.length ? r.resultColumns : null;
    const outCols: CgColumn[] = outs.map((p) => ({ name: bindNameOf(p), dbType: p.dbType, nullable: true, pk: false, identity: false, computed: false }));
    const cols = tableCols ?? (outCols.length ? outCols : null);
    if (cols) {
      const many = !!tableCols || /^setof\s/i.test(retText);
      const rowType = pascal(`${fn}_row`);
      const members = membersOf(cols, d, o, rowType).map(pgReadMember);
      interfaceDecl(w, rowType, members, `Row of ${objectLabel(r)}.`, ctx);
      w.blank();
      const list = members.map((m) => (m.name === m.col.name ? qi(m.col.name, d) : `${qi(m.col.name, d)} AS ${quoteAlias(m.name, d)}`)).join(', ');
      const parsed = registerPgTypes(ctx, members.map((m) => m.type));
      w.line(doc);
      w.block(`export async function ${fn}(${sig}): Promise<${many ? `${rowType}[]` : `${rowType} | undefined`}> {`, () => {
        const a = argList();
        pgCall(w, 'const result = await ', rowType, a.text((args) => `SELECT ${list} FROM ${sqlName}(${args})`), a.values, parsed);
        w.line(many ? 'return result.rows;' : 'return result.rows[0];');
      });
      return;
    }
    if (/^(setof\s|record$)/i.test(retText)) {
      w.line(doc);
      w.block(`export async function ${fn}(${sig}): Promise<Record<string, unknown>[]> {`, () => {
        const a = argList();
        pgCall(w, 'const result = await ', 'Record<string, unknown>', a.text((args) => `SELECT * FROM ${sqlName}(${args})`), a.values, false);
        w.line('return result.rows;');
      });
      return;
    }
    if (!ret || /^void$/i.test(retText)) {
      w.line(doc);
      w.block(`export async function ${fn}(${sig}): Promise<void> {`, () => {
        const a = argList();
        pgCall(w, 'await ', null, a.text((args) => `SELECT ${sqlName}(${args})`), a.values, false);
      });
      return;
    }
    const rt = pgReadType(resolveType(d, retText));
    const t = tsType(rt, true, o);
    const parsed = registerPgTypes(ctx, [rt]);
    w.line(doc);
    w.block(`export async function ${fn}(${sig}): Promise<${t}> {`, () => {
      const a = argList();
      pgCall(w, 'const result = await ', `{ value: ${t} }`, a.text((args) => `SELECT ${sqlName}(${args}) AS value`), a.values, parsed);
      w.line('return result.rows[0]?.value ?? null;');
    });
    return;
  }

  // Procedure: CALL returns one row with the OUT / INOUT values, keyed by parameter name.
  const outProps = outs.map((p) => {
    const rt = pgReadType(resolveType(d, p.dbType));
    return { p, rt, key: bindNameOf(p), name: camel(friendlyParam(bindNameOf(p))), type: tsType(rt, true, o) };
  });
  const resultName = pascal(`${fn}_result`);
  if (outProps.length) {
    w.line(`/** What ${objectLabel(r)} returns (its OUT / INOUT parameters). */`);
    w.block(`export interface ${resultName} {`, () => outProps.forEach((p) => w.line(`${p.name}: ${p.type};`)));
    w.blank();
  }
  w.line(doc);
  w.block(`export async function ${fn}(${sig}): Promise<${outProps.length ? resultName : 'void'}> {`, () => {
    const a = argList();
    const text = a.text((args) => `CALL ${sqlName}(${args})`);
    if (!outProps.length) {
      pgCall(w, 'await ', null, text, a.values, false);
      return;
    }
    const rowType = `{ ${outProps.map((p) => `${propKey(p.key)}: ${p.type}`).join('; ')} }`;
    pgCall(w, 'const result = await ', rowType, text, a.values, registerPgTypes(ctx, outProps.map((p) => p.rt)));
    w.line('const row = result.rows[0];');
    w.block('return {', () => outProps.forEach((p) => w.line(`${p.name}: row?.${propAccess(p.key).replace(/^\./, '')} ?? null,`)), '};');
  });
}

function pgQueryFn(w: Writer, q: CgQuery, ctx: Ctx) {
  const { d, o } = ctx;
  ctx.imports.set('pg', DRIVER.pgsql.import);
  const rowType = typeNameOf(withSuffix(q.name, 'row'), o, false);
  const members = membersOf(q.columns, d, o, rowType).map(pgReadMember);
  interfaceDecl(w, rowType, members, `Row of the ${q.name} query.`, ctx);
  w.blank();
  const fn = claim(ctx, camel(queryFnBase(q.name)), camel(withSuffix(q.name, 'query')));
  const scope = new NameScope(['pool', 'result', 'r', 'pgTypes']);
  const args = q.params.map((p) => ({ p, local: scope.take(localName(p.name, o)), type: queryParamTs(p.type, o) }));
  // node-postgres binds $1, $2, ... only: `:name` / `@name` parameters are renumbered.
  const { sql, order } = rewriteQuery(trimStatement(q.sql), d, 'dollar');
  const aliased = members.some((m) => m.name !== m.col.name);
  const parsed = registerPgTypes(ctx, members.map((m) => m.type));
  w.line(`const ${fn}Sql = ${backtick(sql)};`);
  w.blank();
  if (aliased) w.line(`// Rows arrive keyed by column name; ${members.filter((m) => m.name !== m.col.name).map((m) => `${m.col.name} -> ${m.name}`).join(', ')} are mapped below.`);
  // Optional members (tsNullable 'optional') take undefined for the NULLs node-postgres returns.
  const mapExpr = (r: string) =>
    `{ ${members.map((m) => {
      const v = `${r}[${JSON.stringify(m.col.name)}] as ${tsType(m.type, m.nullable, o)}`;
      return `${m.name}: ${m.nullable && ctxOptional(o) && tsType(m.type, true, o) !== 'unknown' ? `(${v}) ?? undefined` : v}`;
    }).join(', ')} }`;
  const sig = [`pool: ${DRIVER.pgsql.conn}`, ...args.map((a) => `${a.local}: ${a.type}`)].join(', ');
  w.line(`/** Runs the ${q.name} query. */`);
  w.block(`export async function ${fn}(${sig}): Promise<${rowType}[]> {`, () => {
    const values = order.map((n) => args.find((a) => a.p.name === n)?.local ?? 'undefined');
    pgCall(w, 'const result = await ', aliased ? 'Record<string, unknown>' : rowType, `${fn}Sql`, values, parsed);
    w.line(aliased ? `return result.rows.map((r) => (${mapExpr('r')}));` : 'return result.rows;');
  });
}

// ---------------- assembly ----------------

interface Unit {
  name: string;
  label: string;
  imports: Map<string, string>;
  helpers: Map<string, string>;
  body: string;
}

export function generateTypeScript(input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const d = input.dialect;
  if (o.flavor === 'prisma' && d === 'pgsql') return generatePrisma(input, o);
  const units: Unit[] = [];
  const exported = new Set<string>();
  /** node-postgres data access (pgsql + driver flavor): members are typed as pg reads them. */
  const pgDriver = d === 'pgsql' && o.flavor === 'driver';
  const unitFor = (name: string, label: string, fn: (w: Writer, ctx: Ctx) => void) => {
    const ctx: Ctx = { d, o, imports: new Map(), helpers: new Map(), exported };
    const w = new Writer('  ');
    fn(w, ctx);
    // One file per unit: PostgreSQL overloads (and same-named routines of two schemas) get numbered file names.
    let file = name;
    for (let i = 2; units.some((u) => u.name === file); i++) file = `${name}${i}`;
    if (!w.isEmpty) units.push({ name: file, label, imports: ctx.imports, helpers: ctx.helpers, body: w.toString() });
  };
  for (const obj of input.objects) {
    if (isTable(obj)) {
      const typeName = typeNameOf(obj.name, o);
      const members = membersOf(obj.columns, d, o, typeName).map((m) => (pgDriver ? pgReadMember(m) : m));
      const doc = [commentText(obj.comment), `${obj.kind === 'view' ? 'View' : 'Table'} ${objectLabel(obj)}.`].filter(Boolean).join(' — ');
      unitFor(camel(typeName), objectLabel(obj), (w, ctx) => {
        if (o.flavor === 'zod') zodDecl(w, typeName, members, doc, ctx);
        else interfaceDecl(w, typeName, members, doc, ctx);
        if (o.flavor === 'driver' && o.include.repository) {
          w.blank();
          if (d === 'pgsql') pgCrud(w, obj, typeName, members, ctx);
          else driverCrud(w, obj, typeName, members, ctx);
        }
      });
    } else if (obj.kind === 'query') {
      unitFor(camel(obj.name), obj.name, (w, ctx) => {
        if (pgDriver) pgQueryFn(w, obj, ctx);
        else if (o.flavor === 'driver') queryDriver(w, obj, ctx);
        else {
          const rowType = typeNameOf(`${obj.name}_row`, o, false);
          const members = membersOf(obj.columns, d, o, rowType);
          if (o.flavor === 'zod') zodDecl(w, rowType, members, `Row of the ${obj.name} query.`, ctx);
          else interfaceDecl(w, rowType, members, `Row of the ${obj.name} query.`, ctx);
        }
      });
    } else if (o.flavor === 'driver' && o.include.procedures && d !== 'sqlite') {
      if (isRoutine(obj) && d === 'pgsql') unitFor(camel(obj.name), objectLabel(obj), (w, ctx) => pgRoutine(w, obj, ctx));
      else if (isRoutine(obj)) unitFor(camel(obj.name), objectLabel(obj), (w, ctx) => routineDriver(w, obj, ctx, ''));
      else if (obj.kind === 'package') {
        const pkg = obj as CgPackage;
        unitFor(camel(pkg.name), objectLabel(pkg), (w, ctx) => pkg.members.forEach((m, i) => {
          if (i) w.blank();
          routineDriver(w, m, ctx, `${pkg.name}_`);
        }));
      }
    } else if (isRoutine(obj) && o.include.procedures && o.flavor !== 'driver') {
      // Interfaces / zod: parameter shapes for API layers.
      unitFor(camel(obj.name), objectLabel(obj), (w, ctx) => paramsInterface(w, obj, ctx, ''));
    } else if (obj.kind === 'package' && o.include.procedures && o.flavor !== 'driver') {
      const pkg = obj as CgPackage;
      unitFor(camel(pkg.name), objectLabel(pkg), (w, ctx) => pkg.members.forEach((m, i) => {
        if (i) w.blank();
        paramsInterface(w, m, ctx, `${pkg.name}_`);
      }));
    }
  }
  if (!units.length) return [];
  const header = (labels: string[]) => `// Generated by Rowlit from ${DIALECT_LABEL[d]}: ${labels.join(', ')}. Review before use.`;
  const file = (us: Unit[]) => {
    const imports = new Map<string, string>();
    us.forEach((u) => u.imports.forEach((v, k) => imports.set(k, v)));
    const helpers = new Map<string, string>();
    us.forEach((u) => u.helpers.forEach((v, k) => helpers.set(k, v)));
    // node-postgres type parsers (keyed pg:<builtin>) become one scoped TypeOverrides block, which needs pg's value export.
    if ([...helpers.keys()].some((k) => k.startsWith('pg:'))) {
      const block = pgTypesBlock(helpers, o);
      for (const k of [...helpers.keys()]) if (k.startsWith('pg:')) helpers.delete(k);
      helpers.set('pgTypes', block);
      imports.set('pg', "import pg, { type Pool, type PoolClient } from 'pg';");
    }
    const imp = [...imports.values()].sort();
    const help = [...helpers.keys()].sort().map((k) => helpers.get(k)!);
    return [
      header(us.map((u) => u.label)), '', ...(imp.length ? [...imp, ''] : []), ...(help.length ? [help.join('\n\n'), ''] : []),
      us.map((u) => u.body).join('\n\n'), '',
    ].join('\n');
  };
  if (o.combined) return [{ path: units.length === 1 ? `${units[0].name}.ts` : 'db.ts', language: 'typescript', content: file(units) }];
  return units.map((u) => ({ path: `${u.name}.ts`, language: 'typescript', content: file([u]) }));
}

function paramsInterface(w: Writer, r: CgRoutine, ctx: Ctx, prefix: string) {
  const { d, o } = ctx;
  // PostgreSQL overloads share a name: FnTaxParams, FnTax2Params.
  const name = d === 'pgsql' ? `${claimNumbered(ctx, pascal(r.name))}Params` : pascal(`${prefix}${r.name}_params`);
  const params: CgParam[] = callParams(r).filter((p) => p.direction !== 'out');
  w.line(`/** Parameters of ${objectLabel(r)}. */`);
  if (!params.length) {
    w.line(`export type ${name} = Record<string, never>;`);
    return;
  }
  w.block(`export interface ${name} {`, () => {
    for (const p of params) {
      const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
      w.line(`${localName(bindNameOf(p), o)}${p.hasDefault ? '?' : ''}: ${tsType(rt, false, o)};`);
    }
  });
}

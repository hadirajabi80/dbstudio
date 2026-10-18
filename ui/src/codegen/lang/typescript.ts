// TypeScript generator: interfaces (default), Node driver data access (node-mssql / node-oracledb /
// better-sqlite3, chosen by the connection's dialect) and Zod schemas.
import type { Dialect } from '../../api/types';
import type { CgInput, CgPackage, CgParam, CgQuery, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import { camel, NameScope, pascal } from '../naming';
import type { CodegenOptions } from '../options';
import { bindNameOf, DIALECT_LABEL, friendlyParam, localName, membersOf, objectLabel, pkMembers, routineSqlName, typeNameOf, type Member } from '../shape';
import { crudSql, defaultsNote, qi, rewriteQuery, trimStatement } from '../sqlgen';
import { resolveType, type ResolvedType } from '../types';
import { commentText, Writer } from '../writer';

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
      const notes = [commentText(m.col.comment), m.type.known ? '' : `TODO: unmapped type ${m.col.dbType}`].filter(Boolean).join(' — ');
      if (notes) w.line(`/** ${notes} */`);
      w.line(prop(m, ctx.o));
    }
  });
}

function zodType(m: Member, o: CodegenOptions): string {
  const t = m.type;
  let z: string;
  switch (baseTs(t, o)) {
    case 'number':
      z = /^(int|uint)/.test(t.logical) ? 'z.number().int()' : 'z.number()';
      break;
    case 'boolean':
      z = 'z.boolean()';
      break;
    case 'Date':
      z = 'z.coerce.date()';
      break;
    case 'bigint':
      z = 'z.bigint()';
      break;
    case 'Buffer':
      z = 'z.instanceof(Uint8Array)';
      break;
    case 'unknown':
      z = 'z.unknown()';
      break;
    default:
      if (t.logical === 'guid') z = 'z.string().uuid()';
      else if (t.logical === 'datetime' || t.logical === 'datetimeoffset') z = 'z.string().datetime({ offset: true, local: true })';
      else if (t.logical === 'date') z = 'z.string().date()';
      else z = t.length && t.logical === 'string' ? `z.string().max(${t.length})` : 'z.string()';
  }
  if (m.nullable) z += o.tsNullable === 'optional' ? '.nullish()' : '.nullable()';
  return z;
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
 * correctly against what SQLite writes itself (CURRENT_TIMESTAMP, datetime(), date()):
 * - timestamps are UTC 'YYYY-MM-DD HH:MM:SS', read back as UTC (ISO text with 'T', 'Z' or an offset is read as written),
 * - DATE columns hold the local calendar day 'YYYY-MM-DD' of the Date and read back as local midnight, so
 *   new Date(1990, 4, 17) is stored as '1990-05-17' in every time zone.
 */
const SQLITE_DATE_HELPERS = {
  toSqliteDateTime: [
    "/** A Date as SQLite's UTC timestamp text 'YYYY-MM-DD HH:MM:SS' (the format CURRENT_TIMESTAMP writes). */",
    'function toSqliteDateTime(d: Date): string {',
    "  return d.toISOString().replace('T', ' ').replace(/\\.\\d{3}Z$/, '');",
    '}',
  ],
  fromSqliteDateTime: [
    "/** SQLite timestamp text ('YYYY-MM-DD HH:MM:SS', UTC) as a Date; ISO text with 'T', 'Z' or an offset is read as written. */",
    'function fromSqliteDateTime(s: string): Date {',
    "  const iso = s.length === 10 ? `${s}T00:00:00` : s.replace(' ', 'T');",
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
    "/** SQLite DATE text 'YYYY-MM-DD' as a Date at local midnight of that day. */",
    'function fromSqliteDate(s: string): Date {',
    "  const [y, m, d] = s.slice(0, 10).split('-').map(Number);",
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
    return m.nullable ? `${src} == null ? null : ${fn}(${src} as string)` : `${fn}(${src} as string)`;
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
  const rowType = typeNameOf(`${q.name}_row`, o, false);
  const members = membersOf(q.columns, d, o, rowType);
  interfaceDecl(w, rowType, members, `Row of the ${q.name} query.`, ctx);
  w.blank();
  const fn = claim(ctx, camel(q.name), camel(`${q.name}_query`));
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
  const units: Unit[] = [];
  const exported = new Set<string>();
  const unitFor = (name: string, label: string, fn: (w: Writer, ctx: Ctx) => void) => {
    const ctx: Ctx = { d, o, imports: new Map(), helpers: new Map(), exported };
    const w = new Writer('  ');
    fn(w, ctx);
    if (!w.isEmpty) units.push({ name, label, imports: ctx.imports, helpers: ctx.helpers, body: w.toString() });
  };
  for (const obj of input.objects) {
    if (isTable(obj)) {
      const typeName = typeNameOf(obj.name, o);
      const members = membersOf(obj.columns, d, o, typeName);
      const doc = [commentText(obj.comment), `${obj.kind === 'view' ? 'View' : 'Table'} ${objectLabel(obj)}.`].filter(Boolean).join(' — ');
      unitFor(camel(typeName), objectLabel(obj), (w, ctx) => {
        if (o.flavor === 'zod') zodDecl(w, typeName, members, doc, ctx);
        else interfaceDecl(w, typeName, members, doc, ctx);
        if (o.flavor === 'driver' && o.include.repository) {
          w.blank();
          driverCrud(w, obj, typeName, members, ctx);
        }
      });
    } else if (obj.kind === 'query') {
      unitFor(camel(obj.name), obj.name, (w, ctx) => {
        if (o.flavor === 'driver') queryDriver(w, obj, ctx);
        else {
          const rowType = typeNameOf(`${obj.name}_row`, o, false);
          const members = membersOf(obj.columns, d, o, rowType);
          if (o.flavor === 'zod') zodDecl(w, rowType, members, `Row of the ${obj.name} query.`, ctx);
          else interfaceDecl(w, rowType, members, `Row of the ${obj.name} query.`, ctx);
        }
      });
    } else if (o.flavor === 'driver' && o.include.procedures && d !== 'sqlite') {
      if (isRoutine(obj)) unitFor(camel(obj.name), objectLabel(obj), (w, ctx) => routineDriver(w, obj, ctx, ''));
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
  const header = (labels: string[]) => `// Generated by DbStudio from ${DIALECT_LABEL[d]}: ${labels.join(', ')}. Review before use.`;
  const file = (us: Unit[]) => {
    const imports = new Map<string, string>();
    us.forEach((u) => u.imports.forEach((v, k) => imports.set(k, v)));
    const imp = [...imports.values()].sort();
    const helpers = new Map<string, string>();
    us.forEach((u) => u.helpers.forEach((v, k) => helpers.set(k, v)));
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
  const name = pascal(`${prefix}${r.name}_params`);
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

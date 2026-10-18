// C# generator: Dapper (default), EF Core, ADO.NET and model-only flavors.
import type { Dialect } from '../../api/types';
import type { CgColumn, CgInput, CgObject, CgPackage, CgParam, CgQuery, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import { NameScope, pascal, queryFnBase, withSuffix } from '../naming';
import type { CodegenOptions } from '../options';
import {
  bindNameOf, friendlyParam, DIALECT_LABEL, localName, membersOf, objectLabel, pkMembers, proceduresClassName, routineFnName, routineSqlName,
  typeNameOf, type Member,
} from '../shape';
import { crudSql, defaultsNote, qi, rewriteQuery, trimStatement, type ParamStyle } from '../sqlgen';
import { resolveType, type ResolvedType } from '../types';
import { commentText, dq, Writer } from '../writer';

const VALUE_TYPES = new Set(['bool', 'byte', 'short', 'int', 'long', 'decimal', 'float', 'double', 'DateTime', 'DateOnly', 'TimeOnly', 'TimeSpan', 'DateTimeOffset', 'Guid']);

interface Ctx {
  d: Dialect;
  o: CodegenOptions;
  usings: Set<string>;
  /** Tables in this generation run (EF navigations). */
  tables: CgTable[];
}

interface Unit {
  name: string;
  label: string;
  usings: Set<string>;
  body: string;
}

const PROVIDER: Record<Dialect, { ns: string; conn: string; param: string; prefix: string }> = {
  tsql: { ns: 'Microsoft.Data.SqlClient', conn: 'SqlConnection', param: 'SqlParameter', prefix: '@' },
  plsql: { ns: 'Oracle.ManagedDataAccess.Client', conn: 'OracleConnection', param: 'OracleParameter', prefix: '' },
  sqlite: { ns: 'Microsoft.Data.Sqlite', conn: 'SqliteConnection', param: 'SqliteParameter', prefix: '@' },
};

// ---------------- types ----------------

function baseType(t: ResolvedType, o: CodegenOptions): string {
  if (t.cs === 'DateOnly' && !o.dateOnly) return 'DateTime';
  if (t.cs === 'TimeOnly' && !o.dateOnly) return 'TimeSpan';
  return t.cs;
}

function csType(t: ResolvedType, nullable: boolean, o: CodegenOptions): string {
  const b = baseType(t, o);
  if (!nullable) return b;
  if (VALUE_TYPES.has(b)) return `${b}?`;
  return o.nullableReferenceTypes ? `${b}?` : b;
}

function isValueType(t: ResolvedType, o: CodegenOptions) {
  return VALUE_TYPES.has(baseType(t, o));
}

/** Type of a routine/query parameter value. In parameters with a default become optional nullable arguments. */
function paramType(dialect: Dialect, p: CgParam, o: CodegenOptions, nullable: boolean): ResolvedType & { text: string } {
  const t = resolveType(dialect, p.dbType, { numberOneAsBool: o.numberOneAsBool });
  return { ...t, text: csType(t, nullable, o) };
}

const DB_TYPE: Record<string, string> = {
  bool: 'Boolean', uint8: 'Byte', int16: 'Int16', int32: 'Int32', int64: 'Int64', decimal: 'Decimal', float32: 'Single', float64: 'Double',
  string: 'String', date: 'Date', datetime: 'DateTime', datetimeoffset: 'DateTimeOffset', time: 'Time', interval: 'Object', guid: 'Guid',
  binary: 'Binary', rowversion: 'Binary', xml: 'Xml', json: 'String', object: 'Object', cursor: 'Object',
};

function dbType(t: ResolvedType, dialect: Dialect): string {
  if (dialect === 'tsql' && t.base === 'datetime2') return 'DateTime2';
  if (dialect === 'tsql' && /^(varchar|char|text)$/.test(t.base)) return 'AnsiString';
  return DB_TYPE[t.logical] ?? 'Object';
}

const SQL_DB_TYPE: Record<string, string> = {
  int: 'Int', integer: 'Int', bigint: 'BigInt', smallint: 'SmallInt', tinyint: 'TinyInt', bit: 'Bit', decimal: 'Decimal', numeric: 'Decimal',
  money: 'Money', smallmoney: 'SmallMoney', float: 'Float', real: 'Real', date: 'Date', datetime: 'DateTime', datetime2: 'DateTime2',
  smalldatetime: 'SmallDateTime', datetimeoffset: 'DateTimeOffset', time: 'Time', char: 'Char', varchar: 'VarChar', nchar: 'NChar',
  nvarchar: 'NVarChar', text: 'Text', ntext: 'NText', sysname: 'NVarChar', binary: 'Binary', varbinary: 'VarBinary', image: 'Image',
  uniqueidentifier: 'UniqueIdentifier', xml: 'Xml', sql_variant: 'Variant', timestamp: 'Timestamp', rowversion: 'Timestamp', json: 'NVarChar',
};

const ORACLE_DB_TYPE: Record<string, string> = {
  'number#int': 'Int32', 'number#long': 'Int64', 'number#bigint': 'Decimal', 'number#bool': 'Int16', 'number#decimal': 'Decimal', integer: 'Decimal',
  int: 'Decimal', smallint: 'Decimal', pls_integer: 'Int32', binary_integer: 'Int32', float: 'Double', binary_float: 'BinaryFloat',
  binary_double: 'BinaryDouble', boolean: 'Boolean', char: 'Char', nchar: 'NChar', varchar: 'Varchar2', varchar2: 'Varchar2', nvarchar2: 'NVarchar2',
  clob: 'Clob', nclob: 'NClob', long: 'Long', rowid: 'Varchar2', urowid: 'Varchar2', date: 'Date', timestamp: 'TimeStamp',
  'timestamp with time zone': 'TimeStampTZ', 'timestamp with local time zone': 'TimeStampLTZ', 'interval day to second': 'IntervalDS',
  'interval year to month': 'IntervalYM', raw: 'Raw', 'long raw': 'LongRaw', blob: 'Blob', bfile: 'BFile', xmltype: 'XmlType', json: 'Json',
  sys_refcursor: 'RefCursor', 'ref cursor': 'RefCursor',
};

function providerDbType(dialect: Dialect, t: ResolvedType): string {
  if (dialect === 'tsql') return `SqlDbType.${SQL_DB_TYPE[t.base] ?? 'Variant'}`;
  if (dialect === 'plsql') return `OracleDbType.${ORACLE_DB_TYPE[t.base] ?? 'Varchar2'}`;
  const st: Record<string, string> = { int64: 'Integer', int32: 'Integer', int16: 'Integer', uint8: 'Integer', bool: 'Integer', float64: 'Real', float32: 'Real', binary: 'Blob' };
  return `SqliteType.${st[t.logical] ?? 'Text'}`;
}

/** DbDataReader getter for a column at ordinal `i`. */
function readerGet(t: ResolvedType, o: CodegenOptions, i: number, r = 'r'): string {
  const b = baseType(t, o);
  const direct: Record<string, string> = {
    bool: 'GetBoolean', byte: 'GetByte', short: 'GetInt16', int: 'GetInt32', long: 'GetInt64', decimal: 'GetDecimal', float: 'GetFloat',
    double: 'GetDouble', string: 'GetString', DateTime: 'GetDateTime', Guid: 'GetGuid', object: 'GetValue',
  };
  const m = direct[b];
  return m ? `${r}.${m}(${i})` : `${r}.GetFieldValue<${b}>(${i})`;
}

/** Convert an `object?` (ExecuteScalar / out parameter value) to a CLR type. */
function fromObject(expr: string, t: ResolvedType, nullable: boolean, o: CodegenOptions): string {
  const b = baseType(t, o);
  const conv: Record<string, string> = {
    bool: 'Convert.ToBoolean', byte: 'Convert.ToByte', short: 'Convert.ToInt16', int: 'Convert.ToInt32', long: 'Convert.ToInt64',
    decimal: 'Convert.ToDecimal', float: 'Convert.ToSingle', double: 'Convert.ToDouble', DateTime: 'Convert.ToDateTime', string: 'Convert.ToString',
  };
  const c = conv[b];
  const value = c ? (b === 'string' ? `${c}(${expr})!` : `${c}(${expr})`) : `(${b})${expr}!`;
  if (!nullable) return value;
  const nullType = csType(t, true, o);
  return `${expr} is null or DBNull ? (${nullType})null : ${value}`;
}

// ---------------- helpers ----------------

function sqlConst(w: Writer, name: string, sql: string, modifiers = 'private const string') {
  if (sql.includes('"""')) {
    w.line(`${modifiers} ${name} = @"${sql.replace(/"/g, '""')}";`);
    return;
  }
  w.line(`${modifiers} ${name} = """`);
  w.indent();
  w.lines_(sql);
  w.line('""";');
  w.dedent();
}

function summary(w: Writer, text: string | null | undefined) {
  const t = commentText(text);
  if (t) w.line(`/// <summary>${escapeXml(t)}</summary>`);
}

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function initializer(m: Member, o: CodegenOptions): string {
  if (m.nullable || isValueType(m.type, o) || !o.nullableReferenceTypes || o.requiredMembers) return '';
  const b = baseType(m.type, o);
  if (b === 'string') return ' = "";';
  if (b === 'byte[]') return ' = [];';
  return ' = null!;';
}

function todo(m: Member): string | null {
  return m.type.known ? null : `// TODO: unmapped type ${m.col.dbType}`;
}

function bindOf(m: Member): string {
  return m.name.replace(/^@/, '');
}

const SQL_NL = '\n';

// ---------------- model ----------------

function modelType(w: Writer, typeName: string, members: Member[], t: { comment?: string | null; name: string; schema: string | null; kind: string } | null, ctx: Ctx, opts: { annotations: boolean; ef?: boolean }) {
  const { o } = ctx;
  const annotate = opts.annotations && o.dataAnnotations && !opts.ef;
  if (annotate) {
    ctx.usings.add('System.ComponentModel.DataAnnotations');
    ctx.usings.add('System.ComponentModel.DataAnnotations.Schema');
  }
  summary(w, t?.comment);
  if (annotate && t && (t.kind === 'table' || t.kind === 'view')) {
    w.line(t.schema && !(ctx.d === 'sqlite' && t.schema === 'main') ? `[Table(${dq(t.name)}, Schema = ${dq(t.schema)})]` : `[Table(${dq(t.name)})]`);
  }
  w.allman(`public sealed ${o.records ? 'record' : 'class'} ${typeName}`, () => {
    members.forEach((m, i) => {
      if (i) w.blank();
      summary(w, m.col.comment);
      const td = todo(m);
      if (td) w.line(td);
      if (annotate) {
        if (m.col.pk && t?.kind === 'table') w.line('[Key]');
        if (m.col.identity) w.line('[DatabaseGenerated(DatabaseGeneratedOption.Identity)]');
        else if (m.col.computed) w.line('[DatabaseGenerated(DatabaseGeneratedOption.Computed)]');
        if (bindOf(m) !== m.col.name) w.line(`[Column(${dq(m.col.name)})]`);
        if (!m.nullable && !isValueType(m.type, o)) w.line('[Required]');
        if (m.type.length && m.type.logical === 'string') w.line(`[StringLength(${m.type.length})]`);
        else if (m.type.length && m.type.logical === 'binary') w.line(`[MaxLength(${m.type.length})]`);
      }
      const req = o.requiredMembers && !m.nullable && !isValueType(m.type, o) && o.nullableReferenceTypes ? 'required ' : '';
      w.line(`public ${req}${csType(m.type, m.nullable, o)} ${m.name} { get; ${o.records ? 'init' : 'set'}; }${initializer(m, o)}`);
    });
  });
}

// ---------------- Dapper ----------------

function dapperRepository(w: Writer, t: CgTable, typeName: string, members: Member[], ctx: Ctx) {
  const { d, o } = ctx;
  ctx.usings.add('System.Data');
  ctx.usings.add('Dapper');
  const ph = d === 'plsql' ? (n: string) => `:${n}` : (n: string) => `@${n}`;
  const byCol = new Map(members.map((m) => [m.col, m]));
  const crud = crudSql(t, d, {
    placeholder: ph,
    bindName: (c) => bindOf(byCol.get(c)!),
    alias: (c) => {
      const m = byCol.get(c)!;
      return bindOf(m).toLowerCase() === c.name.toLowerCase() ? null : bindOf(m);
    },
    newline: SQL_NL,
  });
  const pk = pkMembers(members, t.primaryKey);
  const repo = `${typeName}Repository`;
  const identity = members.find((m) => m.col === crud.insert?.returning);
  const insertType = identity ? csType(identity.type, false, o) : 'int';
  const keyArgs = pk.map((m) => `${csType(m.type, false, o)} ${localName(m.col.name, o)}`).join(', ');
  const keyObj = `new { ${pk.map((m) => (bindOf(m) === localName(m.col.name, o) ? bindOf(m) : `${bindOf(m)} = ${localName(m.col.name, o)}`)).join(', ')} }`;
  const nullableEntity = o.nullableReferenceTypes ? `${typeName}?` : typeName;

  if (o.include.interface) {
    w.allman(`public interface I${repo}`, () => {
      if (crud.selectByPk) w.line(`Task<${nullableEntity}> GetByIdAsync(${keyArgs}, CancellationToken ct = default);`);
      w.line(`Task<IReadOnlyList<${typeName}>> ListAsync(CancellationToken ct = default);`);
      if (crud.insert) w.line(`Task<${insertType}> InsertAsync(${typeName} entity, CancellationToken ct = default);`);
      if (crud.update) w.line(`Task<bool> UpdateAsync(${typeName} entity, CancellationToken ct = default);`);
      if (crud.delete) w.line(`Task<bool> DeleteAsync(${keyArgs}, CancellationToken ct = default);`);
    });
    w.blank();
  }
  summary(w, `Data access for ${objectLabel(t)}.`);
  w.allman(`public sealed class ${repo}(IDbConnection db)${o.include.interface ? ` : I${repo}` : ''}`, () => {
    sqlConst(w, 'SelectSql', crud.selectAll);
    if (crud.selectByPk) {
      w.blank();
      sqlConst(w, 'SelectByIdSql', crud.selectByPk.sql);
    }
    if (crud.insert) {
      w.blank();
      sqlConst(w, 'InsertSql', crud.insert.sql);
    }
    if (crud.update) {
      w.blank();
      sqlConst(w, 'UpdateSql', crud.update.sql);
    }
    if (crud.delete) {
      w.blank();
      sqlConst(w, 'DeleteSql', crud.delete.sql);
    }
    if (crud.selectByPk) {
      w.blank();
      w.line(`public Task<${nullableEntity}> GetByIdAsync(${keyArgs}, CancellationToken ct = default) =>`);
      w.indent().line(`db.QuerySingleOrDefaultAsync<${typeName}>(new CommandDefinition(SelectByIdSql, ${keyObj}, cancellationToken: ct));`).dedent();
    }
    w.blank();
    w.line(`public async Task<IReadOnlyList<${typeName}>> ListAsync(CancellationToken ct = default) =>`);
    w.indent().line(`(await db.QueryAsync<${typeName}>(new CommandDefinition(SelectSql, cancellationToken: ct))).AsList();`).dedent();
    if (crud.insert) {
      w.blank();
      summary(w, defaultsNote(crud.insert, !!crud.update));
      if (identity && crud.insert.returningKind === 'outBind') {
        w.allman(`public async Task<${insertType}> InsertAsync(${typeName} entity, CancellationToken ct = default)`, () => {
          w.line('var p = new DynamicParameters(entity);');
          w.line(`p.Add(${dq(crud.insert!.returningBind!)}, dbType: DbType.${dbType(identity.type, d)}, direction: ParameterDirection.Output);`);
          w.line('await db.ExecuteAsync(new CommandDefinition(InsertSql, p, cancellationToken: ct));');
          w.line(`return p.Get<${insertType}>(${dq(crud.insert!.returningBind!)});`);
        });
      } else if (identity) {
        w.line(`public Task<${insertType}> InsertAsync(${typeName} entity, CancellationToken ct = default) =>`);
        w.indent().line(`db.ExecuteScalarAsync<${insertType}>(new CommandDefinition(InsertSql, entity, cancellationToken: ct));`).dedent();
      } else {
        w.line(`public Task<int> InsertAsync(${typeName} entity, CancellationToken ct = default) =>`);
        w.indent().line('db.ExecuteAsync(new CommandDefinition(InsertSql, entity, cancellationToken: ct));').dedent();
      }
    }
    if (crud.update) {
      w.blank();
      w.line(`public async Task<bool> UpdateAsync(${typeName} entity, CancellationToken ct = default) =>`);
      w.indent().line('await db.ExecuteAsync(new CommandDefinition(UpdateSql, entity, cancellationToken: ct)) == 1;').dedent();
    }
    if (crud.delete) {
      w.blank();
      w.line(`public async Task<bool> DeleteAsync(${keyArgs}, CancellationToken ct = default) =>`);
      w.indent().line(`await db.ExecuteAsync(new CommandDefinition(DeleteSql, ${keyObj}, cancellationToken: ct)) == 1;`).dedent();
    }
  });
}

interface RoutineArg {
  p: CgParam;
  local: string;
  type: ResolvedType & { text: string };
  optional: boolean;
}

function routineArgs(r: CgRoutine, ctx: Ctx): RoutineArg[] {
  const scope = new NameScope(['db', 'ct', 'cmd', 'p', 'rows', 'value', 'context', 'oracle', 'returnValue']);
  const args = callParams(r)
    .filter((p) => p.direction === 'in' || p.direction === 'inout')
    .map((p) => {
      const optional = p.hasDefault;
      const type = paramType(ctx.d, p, ctx.o, optional || p.direction === 'inout');
      return { p, local: scope.take(localName(bindNameOf(p), ctx.o)), type, optional };
    });
  return [...args.filter((a) => !a.optional), ...args.filter((a) => a.optional)];
}

function argList(args: RoutineArg[]): string {
  return args.map((a) => `${a.type.text} ${a.local}${a.optional ? ' = null' : ''}`).join(', ');
}

interface OutInfo {
  p: CgParam;
  prop: string;
  local: string;
  type: ResolvedType;
  cursor: boolean;
}

function outsOf(r: CgRoutine, ctx: Ctx): OutInfo[] {
  return callParams(r)
    .filter((p) => p.direction === 'out' || p.direction === 'inout')
    .map((p) => ({
      p, prop: pascal(friendlyParam(bindNameOf(p))), local: localName(`${bindNameOf(p)}_param`, ctx.o),
      type: resolveType(ctx.d, p.dbType, { numberOneAsBool: ctx.o.numberOneAsBool }), cursor: isRefCursor(p.dbType),
    }));
}

function resultRowType(r: CgRoutine, ctx: Ctx): string | null {
  if (!r.resultColumns?.length) return null;
  return typeNameOf(`${r.package ? r.package + '_' : ''}${r.name}_row`, ctx.o, false);
}

/** Result record of a routine with OUT parameters (and the T-SQL return value). */
function resultRecord(r: CgRoutine, ctx: Ctx, rowsDecl: string | null, outs: OutInfo[]): { name: string; decl: string } {
  const name = typeNameOf(`${r.package ? r.package + '_' : ''}${r.name}_result`, ctx.o, false);
  const fields: string[] = [];
  if (rowsDecl) fields.push(`${rowsDecl} Rows`);
  for (const out of outs) {
    if (out.cursor) fields.push(`IReadOnlyList<dynamic> ${out.prop}`);
    else fields.push(`${csType(out.type, true, ctx.o)} ${out.prop}`);
  }
  if (ctx.d === 'tsql' && r.kind === 'proc') fields.push('int ReturnValue');
  return { name, decl: `public sealed record ${name}(${fields.join(', ')});` };
}

function dapperRoutine(w: Writer, r: CgRoutine, ctx: Ctx, receiver: string | null, decls: Writer) {
  const { d, o } = ctx;
  ctx.usings.add('System.Data');
  ctx.usings.add('Dapper');
  const outs = outsOf(r, ctx);
  if (d === 'plsql' && outs.some((x) => x.cursor)) {
    adoRoutine(w, r, ctx, receiver, decls, true);
    return;
  }
  const args = routineArgs(r, ctx);
  const fn = routineFnName(r.name, o);
  const sqlName = routineSqlName(r, d, qi);
  const rowType = resultRowType(r, ctx);
  const ret = returnParam(r);
  const sig = (retType: string, isAsync: boolean) =>
    `public ${receiver === null ? '' : 'static '}${isAsync ? 'async ' : ''}Task<${retType}> ${fn}(${[receiver ? `this ${receiver} db` : null, argList(args), 'CancellationToken ct = default'].filter(Boolean).join(', ')})`;
  summary(w, `Calls ${objectLabel(r)}.`);

  if (r.kind === 'func' && ret) {
    const rt = resolveType(d, ret.dbType, { numberOneAsBool: o.numberOneAsBool });
    const callArgs = callParams(r).map((p) => (d === 'plsql' ? `:${bindNameOf(p)}` : `@${bindNameOf(p)}`)).join(', ');
    const sql = d === 'plsql' ? `SELECT ${sqlName}(${callArgs}) FROM DUAL` : `SELECT ${sqlName}(${callArgs})`;
    const obj = args.length ? `new { ${args.map((a) => (a.local === bindNameOf(a.p) ? a.local : `${bindNameOf(a.p)} = ${a.local}`)).join(', ')} }` : 'null';
    w.line(`${sig(csType(rt, true, o), false)} =>`);
    w.indent().line(`db.ExecuteScalarAsync<${csType(rt, true, o)}>(new CommandDefinition(${dq(sql)}, ${obj}, cancellationToken: ct));`).dedent();
    return;
  }

  // SQL Server procedures return result sets; Oracle procedures only return values through OUT parameters.
  const hasRows = d === 'tsql' || !!rowType;
  const rowsDecl = hasRows ? `IReadOnlyList<${rowType ?? 'dynamic'}>` : null;
  const record = outs.length > 0 ? resultRecord(r, ctx, rowsDecl, outs) : null;
  if (record) decls.line(record.decl);
  const retType = record ? record.name : rowsDecl;
  const signature = retType
    ? sig(retType, true)
    : `public ${receiver === null ? '' : 'static '}async Task ${fn}(${[receiver ? `this ${receiver} db` : null, argList(args), 'CancellationToken ct = default'].filter(Boolean).join(', ')})`;
  w.allman(signature, () => {
    w.line('var p = new DynamicParameters();');
    for (const a of args) {
      const t = resolveType(d, a.p.dbType, { numberOneAsBool: o.numberOneAsBool });
      if (a.p.direction === 'inout') w.line(`p.Add(${dq(bindNameOf(a.p))}, ${a.local}, DbType.${dbType(t, d)}, ParameterDirection.InputOutput${sizeArg(t, true, d)});`);
      else w.line(`p.Add(${dq(bindNameOf(a.p))}, ${a.local});`);
    }
    for (const out of outs.filter((x) => x.p.direction === 'out')) {
      w.line(`p.Add(${dq(bindNameOf(out.p))}, dbType: DbType.${dbType(out.type, d)}, direction: ParameterDirection.Output${sizeArg(out.type, true, d)});`);
    }
    if (record && d === 'tsql') w.line('p.Add("RETURN_VALUE", dbType: DbType.Int32, direction: ParameterDirection.ReturnValue);');
    const command = `new CommandDefinition(${dq(sqlName)}, p, commandType: CommandType.StoredProcedure, cancellationToken: ct)`;
    if (hasRows) {
      const query = rowType ? `QueryAsync<${rowType}>` : 'QueryAsync';
      w.line(`var rows = (await db.${query}(${command})).AsList();`);
    } else {
      w.line(`await db.ExecuteAsync(${command});`);
    }
    if (!record) {
      if (hasRows) w.line('return rows;');
      return;
    }
    const fields = [...(hasRows ? ['rows'] : []), ...outs.map((x) => `p.Get<${csType(x.type, true, o)}>(${dq(bindNameOf(x.p))})`)];
    if (d === 'tsql') fields.push('p.Get<int>("RETURN_VALUE")');
    w.line(`return new ${record.name}(${fields.join(', ')});`);
  });
}

function sizeArg(t: ResolvedType, output = false, dialect: Dialect = 'tsql'): string {
  const parts: string[] = [];
  if (t.logical === 'string' || t.logical === 'binary') {
    if (t.length) parts.push(`size: ${t.length}`);
    // Oracle needs a buffer size for OUT strings (PL/SQL VARCHAR2 max 32767); SQL Server uses -1 for (max).
    else if (output) parts.push(dialect === 'plsql' ? 'size: 32767' : 'size: -1');
  }
  if (t.logical === 'decimal' && output && t.precision) parts.push(`precision: ${t.precision}`, `scale: ${t.scale ?? 0}`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

// ---------------- ADO.NET ----------------

function addParam(w: Writer, ctx: Ctx, cmd: string, bind: string, value: string, nullable: boolean) {
  const v = nullable ? `(object?)${value} ?? DBNull.Value` : value;
  if (ctx.d === 'plsql') w.line(`${cmd}.Parameters.Add(new OracleParameter(${dq(bind)}, ${v}));`);
  else w.line(`${cmd}.Parameters.AddWithValue(${dq(PROVIDER[ctx.d].prefix + bind)}, ${v});`);
}

function adoRepository(w: Writer, t: CgTable, typeName: string, members: Member[], ctx: Ctx) {
  const { d, o } = ctx;
  const prov = PROVIDER[d];
  ctx.usings.add('System.Data');
  ctx.usings.add('System.Data.Common');
  ctx.usings.add(prov.ns);
  const ph = d === 'plsql' ? (n: string) => `:${n}` : (n: string) => `@${n}`;
  const byCol = new Map(members.map((m) => [m.col, m]));
  const crud = crudSql(t, d, { placeholder: ph, bindName: (c) => bindOf(byCol.get(c)!), newline: SQL_NL });
  const pk = pkMembers(members, t.primaryKey);
  const repo = `${typeName}Repository`;
  const identity = members.find((m) => m.col === crud.insert?.returning);
  const insertType = identity ? csType(identity.type, false, o) : 'int';
  const keyArgs = pk.map((m) => `${csType(m.type, false, o)} ${localName(m.col.name, o)}`).join(', ');
  const nullableEntity = o.nullableReferenceTypes ? `${typeName}?` : typeName;
  const newCmd = (sqlConstName: string) => {
    w.line('await using var cmd = db.CreateCommand();');
    w.line(`cmd.CommandText = ${sqlConstName};`);
    if (d === 'plsql') w.line('cmd.BindByName = true;');
  };
  const bindEntity = (cols: CgColumn[]) => {
    for (const c of cols) {
      const m = byCol.get(c)!;
      addParam(w, ctx, 'cmd', bindOf(m), `entity.${m.name}`, m.nullable || !isValueType(m.type, o));
    }
  };
  const bindKeys = () => pk.forEach((m) => addParam(w, ctx, 'cmd', bindOf(m), localName(m.col.name, o), false));

  if (o.include.interface) {
    w.allman(`public interface I${repo}`, () => {
      if (crud.selectByPk) w.line(`Task<${nullableEntity}> GetByIdAsync(${keyArgs}, CancellationToken ct = default);`);
      w.line(`Task<IReadOnlyList<${typeName}>> ListAsync(CancellationToken ct = default);`);
      if (crud.insert) w.line(`Task<${insertType}> InsertAsync(${typeName} entity, CancellationToken ct = default);`);
      if (crud.update) w.line(`Task<bool> UpdateAsync(${typeName} entity, CancellationToken ct = default);`);
      if (crud.delete) w.line(`Task<bool> DeleteAsync(${keyArgs}, CancellationToken ct = default);`);
    });
    w.blank();
  }
  summary(w, `Data access for ${objectLabel(t)}.`);
  w.allman(`public sealed class ${repo}(${prov.conn} db)${o.include.interface ? ` : I${repo}` : ''}`, () => {
    sqlConst(w, 'SelectSql', crud.selectAll);
    for (const [name, s] of [['SelectByIdSql', crud.selectByPk], ['InsertSql', crud.insert], ['UpdateSql', crud.update], ['DeleteSql', crud.delete]] as const) {
      if (!s) continue;
      w.blank();
      sqlConst(w, name, s.sql);
    }
    w.blank();
    w.allman(`private static ${typeName} Map(DbDataReader r) => new()`, () => {
      members.forEach((m, i) => {
        const get = readerGet(m.type, o, i);
        w.line(`${m.name} = ${m.nullable ? `r.IsDBNull(${i}) ? null : ${get}` : get},`);
      });
    }, '};');
    w.blank();
    w.allman('private async ValueTask OpenAsync(CancellationToken ct)', () => {
      w.line('if (db.State != ConnectionState.Open) await db.OpenAsync(ct);');
    });
    if (crud.selectByPk) {
      w.blank();
      w.allman(`public async Task<${nullableEntity}> GetByIdAsync(${keyArgs}, CancellationToken ct = default)`, () => {
        newCmd('SelectByIdSql');
        bindKeys();
        w.line('await OpenAsync(ct);');
        w.line('await using var reader = await cmd.ExecuteReaderAsync(ct);');
        w.line('return await reader.ReadAsync(ct) ? Map(reader) : null;');
      });
    }
    w.blank();
    w.allman(`public async Task<IReadOnlyList<${typeName}>> ListAsync(CancellationToken ct = default)`, () => {
      newCmd('SelectSql');
      w.line('await OpenAsync(ct);');
      w.line('await using var reader = await cmd.ExecuteReaderAsync(ct);');
      w.line(`var list = new List<${typeName}>();`);
      w.line('while (await reader.ReadAsync(ct)) list.Add(Map(reader));');
      w.line('return list;');
    });
    if (crud.insert) {
      w.blank();
      summary(w, defaultsNote(crud.insert, !!crud.update));
      w.allman(`public async Task<${insertType}> InsertAsync(${typeName} entity, CancellationToken ct = default)`, () => {
        newCmd('InsertSql');
        bindEntity(crud.insert!.params);
        if (identity && crud.insert!.returningKind === 'outBind') {
          w.line(`var id = new OracleParameter { ParameterName = ${dq(crud.insert!.returningBind!)}, OracleDbTypeEx = ${providerDbType(d, identity.type)}, Direction = ParameterDirection.Output };`);
          w.line('cmd.Parameters.Add(id);');
          w.line('await OpenAsync(ct);');
          w.line('await cmd.ExecuteNonQueryAsync(ct);');
          w.line(`return ${fromObject('id.Value', identity.type, false, o)};`);
        } else if (identity) {
          w.line('await OpenAsync(ct);');
          w.line(`return ${fromObject('await cmd.ExecuteScalarAsync(ct)', identity.type, false, o)};`);
        } else {
          w.line('await OpenAsync(ct);');
          w.line('return await cmd.ExecuteNonQueryAsync(ct);');
        }
      });
    }
    if (crud.update) {
      w.blank();
      w.allman(`public async Task<bool> UpdateAsync(${typeName} entity, CancellationToken ct = default)`, () => {
        newCmd('UpdateSql');
        bindEntity(crud.update!.params);
        w.line('await OpenAsync(ct);');
        w.line('return await cmd.ExecuteNonQueryAsync(ct) == 1;');
      });
    }
    if (crud.delete) {
      w.blank();
      w.allman(`public async Task<bool> DeleteAsync(${keyArgs}, CancellationToken ct = default)`, () => {
        newCmd('DeleteSql');
        bindKeys();
        w.line('await OpenAsync(ct);');
        w.line('return await cmd.ExecuteNonQueryAsync(ct) == 1;');
      });
    }
  });
}

/**
 * Procedure/function wrapper with ADO.NET (also used by the Dapper flavor for Oracle REF CURSOR parameters).
 * `receiver` = extension receiver type (static class) or null (instance member using the `db` field).
 */
function adoRoutine(w: Writer, r: CgRoutine, ctx: Ctx, receiver: string | null, decls: Writer, dapperReader = false) {
  const { d, o } = ctx;
  const prov = PROVIDER[d];
  ctx.usings.add('System.Data');
  ctx.usings.add(prov.ns);
  const args = routineArgs(r, ctx);
  const outs = outsOf(r, ctx);
  const fn = routineFnName(r.name, o);
  const sqlName = routineSqlName(r, d, qi);
  const ret = returnParam(r);
  const castConn = receiver === null && dapperReader;
  const conn = castConn ? 'oracle' : 'db';
  const recv = receiver ? (dapperReader ? prov.conn : receiver) : null;
  const sig = (retType: string) =>
    `public ${receiver === null ? '' : 'static '}async Task<${retType}> ${fn}(${[recv ? `this ${recv} db` : null, argList(args), 'CancellationToken ct = default'].filter(Boolean).join(', ')})`;
  summary(w, `Calls ${objectLabel(r)}.`);

  const begin = () => {
    if (castConn) w.line(`var oracle = (${prov.conn})db;`);
    w.line(`await using var cmd = ${conn}.CreateCommand();`);
    if (d === 'plsql') w.line('cmd.BindByName = true;');
  };
  const bindArgs = () => {
    for (const a of args) {
      const t = resolveType(d, a.p.dbType, { numberOneAsBool: o.numberOneAsBool });
      const v = a.optional || !isValueType(t, o) || a.p.direction === 'inout' ? `(object?)${a.local} ?? DBNull.Value` : a.local;
      if (a.p.direction === 'inout') {
        const local = outs.find((x) => x.p === a.p)!.local;
        w.line(`var ${local} = cmd.Parameters.Add(${newParam(d, a.p, t, 'ParameterDirection.InputOutput')});`);
        w.line(`${local}.Value = ${v};`);
      } else if (d === 'plsql') {
        w.line(`cmd.Parameters.Add(${dq(bindNameOf(a.p))}, ${providerDbType(d, t)}).Value = ${v};`);
      } else {
        w.line(`cmd.Parameters.Add(new ${prov.param}(${dq(a.p.name)}, ${providerDbType(d, t)}) { Value = ${v} });`);
      }
    }
  };
  const open = () => w.line(`if (${conn}.State != ConnectionState.Open) await ${conn}.OpenAsync(ct);`);

  if (r.kind === 'func' && ret) {
    const rt = resolveType(d, ret.dbType, { numberOneAsBool: o.numberOneAsBool });
    const callArgs = callParams(r).map((p) => (d === 'plsql' ? `:${bindNameOf(p)}` : p.name)).join(', ');
    const sql = d === 'plsql' ? `SELECT ${sqlName}(${callArgs}) FROM DUAL` : `SELECT ${sqlName}(${callArgs})`;
    w.allman(sig(csType(rt, true, o)), () => {
      begin();
      w.line(`cmd.CommandText = ${dq(sql)};`);
      bindArgs();
      open();
      w.line(`var value = await cmd.ExecuteScalarAsync(ct);`);
      w.line(`return ${fromObject('value', rt, true, o)};`);
    });
    return;
  }

  const rowType = resultRowType(r, ctx);
  const cursorOuts = outs.filter((x) => x.cursor);
  // Only SQL Server procedures return result sets directly; Oracle returns them through REF CURSOR parameters.
  const hasRows = d === 'tsql';
  const rowsDecl = hasRows ? (rowType ? `IReadOnlyList<${rowType}>` : 'DataTable') : null;
  const record = outs.length > 0 ? resultRecord(r, ctx, rowsDecl, outs) : null;
  if (record) decls.line(record.decl);
  const useRecord = !!record;
  if (!dapperReader) ctx.usings.add('System.Data.Common');
  const rowsListType = rowType ? `List<${rowType}>` : 'DataTable';
  const retType = useRecord ? record!.name : hasRows ? (rowType ? `IReadOnlyList<${rowType}>` : 'DataTable') : 'int';
  w.allman(sig(retType), () => {
    begin();
    w.line(`cmd.CommandText = ${dq(sqlName)};`);
    w.line('cmd.CommandType = CommandType.StoredProcedure;');
    bindArgs();
    for (const out of outs.filter((x) => x.p.direction === 'out')) {
      if (d === 'plsql') {
        const ty = out.cursor ? 'OracleDbType = OracleDbType.RefCursor' : `OracleDbTypeEx = ${providerDbType(d, out.type)}`;
        const size = !out.cursor && (out.type.logical === 'string' || out.type.logical === 'binary') ? `, Size = ${out.type.length ?? 32767}` : '';
        w.line(`var ${out.local} = cmd.Parameters.Add(new OracleParameter { ParameterName = ${dq(bindNameOf(out.p))}, ${ty}, Direction = ParameterDirection.Output${size} });`);
      } else {
        w.line(`var ${out.local} = cmd.Parameters.Add(${newParam(d, out.p, out.type, 'ParameterDirection.Output')});`);
      }
    }
    if (d === 'tsql') w.line(`var returnValue = cmd.Parameters.Add(new SqlParameter("@RETURN_VALUE", SqlDbType.Int) { Direction = ParameterDirection.ReturnValue });`);
    open();
    if (hasRows) {
      if (rowType) {
        w.line(`var rows = new ${rowsListType}();`);
        w.allman('await using (var reader = await cmd.ExecuteReaderAsync(ct))', () => {
          w.line(`while (await reader.ReadAsync(ct)) rows.Add(Map${rowType}(reader));`);
        });
      } else {
        w.line('var rows = new DataTable();');
        w.allman('await using (var reader = await cmd.ExecuteReaderAsync(ct))', () => {
          w.line('rows.Load(reader);');
        });
      }
    } else {
      w.line(useRecord ? 'await cmd.ExecuteNonQueryAsync(ct);' : 'return await cmd.ExecuteNonQueryAsync(ct);');
    }
    for (const c of cursorOuts) {
      ctx.usings.add('Oracle.ManagedDataAccess.Types');
      const base = c.local.replace(/Param$/, '');
      const rd = `${base}Reader`;
      w.line(`using var ${rd} = ((OracleRefCursor)${c.local}.Value).GetDataReader();`);
      if (dapperReader) w.line(`var ${base}Rows = ${rd}.Parse().AsList();`);
      else {
        w.line(`var ${base}Rows = new List<dynamic>();`);
        w.line(`while (await ${rd}.ReadAsync(ct)) ${base}Rows.Add(ToExpando(${rd}));`);
        ctx.usings.add('System.Dynamic');
      }
    }
    if (useRecord) {
      const fields: string[] = [];
      if (hasRows) fields.push('rows');
      for (const out of outs) fields.push(out.cursor ? `${out.local.replace(/Param$/, '')}Rows` : fromObject(`${out.local}.Value`, out.type, true, o));
      if (d === 'tsql') fields.push('(int)returnValue.Value');
      w.line(`return new ${record!.name}(${fields.join(', ')});`);
    } else if (hasRows) {
      w.line('return rows;');
    }
  });
}

function newParam(d: Dialect, p: CgParam, t: ResolvedType, direction: string): string {
  if (d === 'tsql') {
    const extra: string[] = [`Direction = ${direction}`];
    if (t.logical === 'string' || t.logical === 'binary') extra.push(`Size = ${t.length ?? -1}`);
    if (t.logical === 'decimal' && t.precision) extra.push(`Precision = ${t.precision}`, `Scale = ${t.scale ?? 0}`);
    return `new SqlParameter(${dq(p.name)}, ${providerDbType(d, t)}) { ${extra.join(', ')} }`;
  }
  if (d === 'plsql') {
    const size = t.logical === 'string' || t.logical === 'binary' ? `, Size = ${t.length ?? 32767}` : '';
    return `new OracleParameter { ParameterName = ${dq(bindNameOf(p))}, OracleDbTypeEx = ${providerDbType(d, t)}, Direction = ${direction}${size} }`;
  }
  return `new SqliteParameter(${dq(p.name)}, ${providerDbType(d, t)}) { Direction = ${direction} }`;
}

// ---------------- EF Core ----------------

function efConfiguration(w: Writer, t: CgTable, typeName: string, members: Member[], ctx: Ctx, typeNames: Map<CgTable, string>) {
  const { d, o } = ctx;
  ctx.usings.add('Microsoft.EntityFrameworkCore');
  ctx.usings.add('Microsoft.EntityFrameworkCore.Metadata.Builders');
  w.allman(`public sealed class ${typeName}Configuration : IEntityTypeConfiguration<${typeName}>`, () => {
    w.allman(`public void Configure(EntityTypeBuilder<${typeName}> builder)`, () => {
      const schema = t.schema && !(d === 'sqlite' && t.schema === 'main') ? t.schema : null;
      const comment = commentText(t.comment);
      if (t.kind === 'view') {
        w.line(`builder.ToView(${dq(t.name)}${schema ? `, ${dq(schema)}` : ''});`);
      } else {
        w.line(`builder.ToTable(${dq(t.name)}${schema ? `, ${dq(schema)}` : ''}${comment ? `, t => t.HasComment(${dq(comment)})` : ''});`);
      }
      const pk = pkMembers(members, t.primaryKey);
      if (t.kind === 'view' || !pk.length) w.line('builder.HasNoKey();');
      else if (pk.length === 1) w.line(`builder.HasKey(e => e.${pk[0].name});`);
      else w.line(`builder.HasKey(e => new { ${pk.map((m) => `e.${m.name}`).join(', ')} });`);
      for (const m of members) {
        const calls: string[] = bindOf(m) !== m.col.name ? [`.HasColumnName(${dq(m.col.name)})`] : [];
        if (m.type.logical === 'string' && m.type.length) calls.push(`.HasMaxLength(${m.type.length})`);
        if (m.type.logical === 'binary' && m.type.length) calls.push(`.HasMaxLength(${m.type.length})`);
        if (m.type.logical === 'decimal' && m.type.precision) calls.push(`.HasPrecision(${m.type.precision}, ${m.type.scale ?? 0})`);
        if (!m.nullable && !isValueType(m.type, o)) calls.push('.IsRequired()');
        if (m.col.identity) calls.push('.ValueGeneratedOnAdd()');
        else if (m.col.computed) calls.push('.ValueGeneratedOnAddOrUpdate()');
        // A server default: EF Core leaves the column out of the INSERT while the property holds its CLR default.
        else if (m.col.hasDefault && t.kind === 'table' && !pk.includes(m)) calls.push('.ValueGeneratedOnAdd()');
        if (m.type.logical === 'rowversion') calls.push('.IsRowVersion()');
        const cm = commentText(m.col.comment);
        if (cm && t.kind === 'table') calls.push(`.HasComment(${dq(cm)})`);
        if (m.type.logical === 'object') {
          w.line(`// TODO: unmapped type ${m.col.dbType}; map it with a value converter or a provider type (e.g. NetTopologySuite).`);
          w.line(`builder.Ignore(e => e.${m.name});`);
          continue;
        }
        if (calls.length) w.line(`builder.Property(e => e.${m.name})${calls.join('')};`);
      }
      for (const fk of t.foreignKeys) {
        const target = ctx.tables.find((x) => x.name === fk.refTable && (x.schema === fk.refSchema || !fk.refSchema));
        if (!target) continue;
        const targetName = typeNames.get(target)!;
        const cols = fk.columns.map((c) => members.find((m) => m.col.name === c)).filter((m): m is Member => !!m);
        if (cols.length !== fk.columns.length) continue;
        const key = cols.length === 1 ? `e => e.${cols[0].name}` : `e => new { ${cols.map((m) => `e.${m.name}`).join(', ')} }`;
        w.line(`builder.HasOne<${targetName}>().WithMany().HasForeignKey(${key}).HasConstraintName(${dq(fk.name)});`);
      }
    });
  });
}

function efDbContext(w: Writer, tables: { t: CgTable; typeName: string }[], ctx: Ctx) {
  ctx.usings.add('Microsoft.EntityFrameworkCore');
  w.allman('public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)', () => {
    for (const { t, typeName } of tables) {
      const set = pascal(t.name);
      w.line(`public DbSet<${typeName}> ${set === typeName ? `${set}Set` : set} => Set<${typeName}>();`);
    }
    if (tables.length) w.blank();
    w.line('protected override void OnModelCreating(ModelBuilder modelBuilder) =>');
    w.indent().line('modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);').dedent();
  });
}

function efRoutine(w: Writer, r: CgRoutine, ctx: Ctx, decls: Writer) {
  const { d, o } = ctx;
  const outs = outsOf(r, ctx);
  if (outs.length || (r.kind === 'func' && d !== 'tsql')) {
    // Out parameters / cursors need provider parameters: reuse the ADO.NET wrapper on the context's connection.
    const inner = new Writer();
    adoRoutine(inner, r, { ...ctx }, PROVIDER[d].conn, decls);
    w.append(inner);
    return;
  }
  ctx.usings.add('Microsoft.EntityFrameworkCore');
  const args = routineArgs(r, ctx);
  const fn = routineFnName(r.name, o);
  const sqlName = routineSqlName(r, d, qi);
  const rowType = resultRowType(r, ctx);
  const ret = returnParam(r);
  const sig = (retType: string) =>
    `public static async Task<${retType}> ${fn}(${['this DbContext context', argList(args), 'CancellationToken ct = default'].filter(Boolean).join(', ')})`;
  if (!rowType && d === 'tsql' && r.kind === 'proc') {
    w.line('// The result shape is unknown: run the procedure once in DbStudio ("Run to infer result columns") to get a typed row class.');
  }
  summary(w, `Calls ${objectLabel(r)}.`);
  const named = args.map((a) => (d === 'plsql' ? `${bindNameOf(a.p)} => {${a.local}}` : `${a.p.name} = {${a.local}}`)).join(', ');
  if (r.kind === 'func' && ret) {
    const rt = resolveType(d, ret.dbType);
    const callArgs = callParams(r).map((p) => `{${localName(bindNameOf(p), o)}}`).join(', ');
    w.line(`${sig(csType(rt, true, o))} =>`);
    w.indent().line(`(await context.Database.SqlQuery<${csType(rt, true, o)}>($"SELECT ${sqlName}(${callArgs}) AS \\"Value\\"").ToListAsync(ct)).FirstOrDefault();`).dedent();
    return;
  }
  const call = d === 'plsql' ? `BEGIN ${sqlName}(${named}); END;` : `EXEC ${sqlName}${named ? ' ' + named : ''}`;
  if (rowType) {
    w.line(`${sig(`List<${rowType}>`)} =>`);
    w.indent().line(`await context.Database.SqlQuery<${rowType}>($${dq(call)}).ToListAsync(ct);`).dedent();
  } else {
    w.line(`${sig('int')} =>`);
    w.indent().line(`await context.Database.ExecuteSqlAsync($${dq(call)}, ct);`).dedent();
  }
}

// ---------------- queries ----------------

function queryUnit(q: CgQuery, ctx: Ctx, w: Writer, flavor: string) {
  const { d, o } = ctx;
  const rowType = typeNameOf(withSuffix(q.name, 'row'), o, false);
  const members = membersOf(q.columns, d, o, rowType);
  modelType(w, rowType, members, null, ctx, { annotations: false });
  w.blank();
  const fn = routineFnName(queryFnBase(q.name), o);
  const style: ParamStyle = d === 'plsql' ? 'colon' : 'at';
  const { sql } = rewriteQuery(trimStatement(q.sql), d, style);
  const args = q.params.map((p) => ({ p, local: localName(p.name, o), type: queryParamType(p.type, o) }));
  const argText = args.map((a) => `${a.type} ${a.local}`).join(', ');
  const cls = typeNameOf(withSuffix(q.name, 'query'), o, false);
  const underscores = members.some((m) => bindOf(m).toLowerCase() !== m.col.name.toLowerCase() && bindOf(m).toLowerCase() === m.col.name.replace(/_/g, '').toLowerCase());
  w.allman(`public static class ${cls}`, () => {
    sqlConst(w, 'Sql', sql, 'public const string');
    w.blank();
    if (flavor === 'adonet' || flavor === 'efcore') {
      const prov = PROVIDER[d];
      ctx.usings.add(prov.ns);
      ctx.usings.add('System.Data');
      const recv = flavor === 'efcore' ? 'DbContext context' : `${prov.conn} db`;
      w.allman(`public static async Task<IReadOnlyList<${rowType}>> ${fn}(${[`this ${recv}`, argText, 'CancellationToken ct = default'].filter(Boolean).join(', ')})`, () => {
        if (flavor === 'efcore') {
          ctx.usings.add('Microsoft.EntityFrameworkCore');
          w.line(`var db = (${prov.conn})context.Database.GetDbConnection();`);
        }
        w.line('await using var cmd = db.CreateCommand();');
        w.line('cmd.CommandText = Sql;');
        if (d === 'plsql') w.line('cmd.BindByName = true;');
        for (const a of args) addParam(w, ctx, 'cmd', a.p.name, a.local, false);
        w.line('if (db.State != ConnectionState.Open) await db.OpenAsync(ct);');
        w.line('await using var r = await cmd.ExecuteReaderAsync(ct);');
        w.line(`var list = new List<${rowType}>();`);
        w.allman('while (await r.ReadAsync(ct))', () => {
          w.allman(`list.Add(new ${rowType}`, () => {
            members.forEach((m, i) => {
              const get = readerGet(m.type, o, i);
              w.line(`${m.name} = ${m.nullable ? `r.IsDBNull(${i}) ? null : ${get}` : get},`);
            });
          }, '});');
        });
        w.line('return list;');
      });
    } else {
      ctx.usings.add('System.Data');
      ctx.usings.add('Dapper');
      if (underscores) w.line('// Column names use snake_case: enable Dapper.DefaultTypeMap.MatchNamesWithUnderscores = true once at startup.');
      const obj = args.length ? `new { ${args.map((a) => (a.local === a.p.name ? a.local : `${a.p.name} = ${a.local}`)).join(', ')} }` : 'null';
      w.line(`public static async Task<IReadOnlyList<${rowType}>> ${fn}(${['this IDbConnection db', argText, 'CancellationToken ct = default'].filter(Boolean).join(', ')}) =>`);
      w.indent().line(`(await db.QueryAsync<${rowType}>(new CommandDefinition(Sql, ${obj}, cancellationToken: ct))).AsList();`).dedent();
    }
  });
}

function queryParamType(t: CgQuery['params'][number]['type'], o: CodegenOptions): string {
  const map: Record<string, string> = {
    string: 'string', int: 'int', long: 'long', decimal: 'decimal', float: 'double', bool: 'bool',
    date: o.dateOnly ? 'DateOnly' : 'DateTime', datetime: 'DateTime', datetimeoffset: 'DateTimeOffset', time: o.dateOnly ? 'TimeOnly' : 'TimeSpan',
    guid: 'Guid', binary: 'byte[]',
  };
  return map[t] ?? 'object';
}

// ---------------- assembly ----------------

function mapperFor(w: Writer, rowType: string, members: Member[], o: CodegenOptions) {
  w.allman(`private static ${rowType} Map${rowType}(DbDataReader r) => new()`, () => {
    members.forEach((m, i) => {
      const get = readerGet(m.type, o, i);
      w.line(`${m.name} = ${m.nullable ? `r.IsDBNull(${i}) ? null : ${get}` : get},`);
    });
  }, '};');
}

function routineUnit(objs: CgRoutine[], ctx: Ctx, flavor: string, container: { name: string; kind: 'static' | 'package'; label: string }): string {
  const { d, o } = ctx;
  const w = new Writer();
  const decls = new Writer();
  // Row classes for routines with known result columns.
  for (const r of objs) {
    const rowType = resultRowType(r, ctx);
    if (rowType && r.resultColumns) {
      modelType(decls, rowType, membersOf(r.resultColumns, d, o, rowType), null, ctx, { annotations: false });
      decls.blank();
    }
  }
  const prov = PROVIDER[d];
  const body = new Writer();
  const instanceRecv = flavor === 'adonet' ? prov.conn : flavor === 'efcore' ? 'DbContext' : 'IDbConnection';
  objs.forEach((r, i) => {
    if (i) body.blank();
    const receiver = container.kind === 'static' ? (flavor === 'adonet' ? prov.conn : flavor === 'efcore' ? prov.conn : 'IDbConnection') : null;
    if (flavor === 'efcore') {
      if (container.kind === 'package') adoRoutine(body, r, ctx, null, decls);
      else efRoutine(body, r, ctx, decls);
    } else if (flavor === 'adonet') adoRoutine(body, r, ctx, receiver, decls);
    else dapperRoutine(body, r, ctx, receiver, decls);
    // ADO wrappers with typed rows need a mapper.
    const rowType = resultRowType(r, ctx);
    if (rowType && r.resultColumns && (flavor === 'adonet' || (flavor === 'efcore' && outsOf(r, ctx).length))) {
      ctx.usings.add('System.Data.Common');
      body.blank();
      mapperFor(body, rowType, membersOf(r.resultColumns, d, o, rowType), o);
    }
  });
  if (body.toString().includes('ToExpando(')) {
    body.blank();
    body.allman('private static dynamic ToExpando(IDataRecord r)', () => {
      body.line('IDictionary<string, object?> row = new ExpandoObject();');
      body.line('for (var i = 0; i < r.FieldCount; i++) row[r.GetName(i)] = r.IsDBNull(i) ? null : r.GetValue(i);');
      body.line('return row;');
    });
  }
  if (!decls.isEmpty) {
    w.append(decls);
    w.blank();
  }
  summary(w, container.label);
  if (container.kind === 'static') {
    w.allman(`public static partial class ${container.name}`, () => w.append(body));
  } else {
    const recv = flavor === 'efcore' ? prov.conn : instanceRecv;
    if (flavor === 'efcore') ctx.usings.add(prov.ns);
    w.allman(`public sealed class ${container.name}(${recv} db)`, () => w.append(body));
  }
  return w.toString();
}

export function generateCSharp(input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const d = input.dialect;
  const flavor = o.flavor;
  const tables = input.objects.filter(isTable);
  const typeNames = new Map<CgTable, string>();
  for (const t of tables) typeNames.set(t, typeNameOf(t.name, o));
  const units: Unit[] = [];

  const unitFor = (name: string, label: string, fn: (w: Writer, ctx: Ctx) => void) => {
    const ctx: Ctx = { d, o, usings: new Set(), tables };
    const w = new Writer();
    fn(w, ctx);
    if (!w.isEmpty) units.push({ name, label, usings: ctx.usings, body: w.toString() });
  };

  for (const obj of input.objects) {
    if (isTable(obj)) {
      const typeName = typeNames.get(obj)!;
      const members = membersOf(obj.columns, d, o, typeName);
      unitFor(typeName, objectLabel(obj), (w, ctx) => {
        if (o.include.model || flavor === 'efcore') modelType(w, typeName, members, obj, ctx, { annotations: true, ef: flavor === 'efcore' });
        if (flavor === 'efcore') {
          w.blank();
          efConfiguration(w, obj, typeName, members, ctx, typeNames);
        } else if (o.include.repository && flavor === 'dapper') {
          w.blank();
          dapperRepository(w, obj, typeName, members, ctx);
        } else if (o.include.repository && flavor === 'adonet') {
          w.blank();
          adoRepository(w, obj, typeName, members, ctx);
        }
      });
    } else if (obj.kind === 'query') {
      unitFor(typeNameOf(obj.name, o, false), obj.name, (w, ctx) => queryUnit(obj, ctx, w, flavor));
    }
  }

  if (flavor !== 'model' && o.include.procedures) {
    const routines = input.objects.filter(isRoutine);
    const bySchema = new Map<string, CgRoutine[]>();
    for (const r of routines) {
      const k = r.schema ?? '';
      bySchema.set(k, [...(bySchema.get(k) ?? []), r]);
    }
    for (const [schema, list] of bySchema) {
      const name = proceduresClassName(schema || null, o);
      if (o.combined) {
        unitFor(name, `${schema || 'default'} routines`, (w, ctx) => w.append(routineUnit(list, ctx, flavor, { name, kind: 'static', label: `Procedures and functions of ${schema || 'the database'}.` })));
      } else {
        for (const r of list) unitFor(`${name}.${pascal(r.name)}`, objectLabel(r), (w, ctx) => w.append(routineUnit([r], ctx, flavor, { name, kind: 'static', label: `Procedures and functions of ${schema || 'the database'}.` })));
      }
    }
    for (const pkg of input.objects.filter((x): x is CgPackage => x.kind === 'package')) {
      const name = pascal(pkg.name);
      unitFor(name, objectLabel(pkg), (w, ctx) => w.append(routineUnit(pkg.members, ctx, flavor, { name, kind: 'package', label: `Wrappers for package ${objectLabel(pkg)}.` })));
    }
  }

  if (flavor === 'efcore' && o.include.repository && tables.length) {
    unitFor('AppDbContext', 'DbContext', (w, ctx) => efDbContext(w, tables.map((t) => ({ t, typeName: typeNames.get(t)! })), ctx));
  }

  return assemble(units, input, o);
}

function assemble(units: Unit[], input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const header = (labels: string[]) => `// Generated by DbStudio from ${DIALECT_LABEL[input.dialect]}: ${labels.join(', ')}. Review before use.`;
  const file = (us: Unit[]): string => {
    const usings = new Set<string>();
    for (const u of us) for (const x of u.usings) usings.add(x);
    // BCL namespaces by usage, so the file compiles with ImplicitUsings off as well.
    const text = us.map((u) => u.body).join('\n');
    if (/\b(DateTime|DateOnly|TimeOnly|TimeSpan|DateTimeOffset|Guid|Convert|DBNull|ArgumentException)\b/.test(text)) usings.add('System');
    if (/\b(List|IReadOnlyList|IDictionary|IEnumerable)</.test(text)) usings.add('System.Collections.Generic');
    if (/\b(Task|ValueTask)\b/.test(text)) usings.add('System.Threading.Tasks');
    if (/\bCancellationToken\b/.test(text)) usings.add('System.Threading');
    if (/\.(FirstOrDefault|Select|Cast)\(|\.ToList\(\)/.test(text)) usings.add('System.Linq');
    const sorted = [...usings].sort((a, b) => {
      const sa = a.startsWith('System') ? 0 : 1;
      const sb = b.startsWith('System') ? 0 : 1;
      return sa - sb || a.localeCompare(b);
    });
    const parts = [header(us.map((u) => u.label))];
    parts.push(o.nullableReferenceTypes ? '#nullable enable' : '#nullable disable');
    parts.push('');
    if (sorted.length) parts.push(...sorted.map((u) => `using ${u};`), '');
    parts.push(`namespace ${o.namespace.trim() || 'App.Data'};`, '');
    parts.push(us.map((u) => u.body).join('\n\n'));
    return parts.join('\n') + '\n';
  };
  if (!units.length) return [];
  if (o.combined) {
    const name = (o.namespace.split('.').pop() || 'Generated').replace(/[^A-Za-z0-9_]/g, '') || 'Generated';
    return [{ path: `${units.length === 1 ? units[0].name : name}.cs`, language: 'csharp', content: file(units) }];
  }
  return units.map((u) => ({ path: `${u.name}.cs`, language: 'csharp', content: file([u]) }));
}

export type { CgObject };

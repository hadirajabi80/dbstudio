// Python generator: dataclass + DB-API driver (pyodbc / python-oracledb / sqlite3, by dialect),
// SQLAlchemy 2.0 declarative models and Pydantic v2 models.
import type { Dialect } from '../../api/types';
import type { CgInput, CgPackage, CgQuery, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import { NameScope, pascal, queryFnBase, snake, withSuffix } from '../naming';
import type { CodegenOptions } from '../options';
import { bindNameOf, DIALECT_LABEL, friendlyParam, localName, membersOf, objectLabel, pkMembers, routineSqlName, typeNameOf, type Member } from '../shape';
import { crudSql, defaultsNote, PH, qi, rewriteQuery, trimStatement, type Placeholder } from '../sqlgen';
import { resolveType, type ResolvedType } from '../types';
import { commentText, Writer } from '../writer';

interface Ctx {
  d: Dialect;
  o: CodegenOptions;
  /** module → names (`from module import a, b`); '' → plain `import x` lines. */
  from: Map<string, Set<string>>;
  plain: Set<string>;
}

const TYPE_IMPORT: Record<string, [string, string]> = {
  Decimal: ['decimal', 'Decimal'], date: ['datetime', 'date'], datetime: ['datetime', 'datetime'], time: ['datetime', 'time'],
  timedelta: ['datetime', 'timedelta'], UUID: ['uuid', 'UUID'], Any: ['typing', 'Any'],
};

function addImport(ctx: Ctx, module: string, name: string) {
  if (!ctx.from.has(module)) ctx.from.set(module, new Set());
  ctx.from.get(module)!.add(name);
}

function pyType(t: ResolvedType, nullable: boolean, ctx: Ctx): string {
  const b = t.py;
  const imp = TYPE_IMPORT[b];
  if (imp) addImport(ctx, imp[0], imp[1]);
  if (!nullable || b === 'Any') return b;
  if (ctx.o.pyUnionSyntax) return `${b} | None`;
  addImport(ctx, 'typing', 'Optional');
  return `Optional[${b}]`;
}

function q3(sql: string): string {
  return `"""\n${sql.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}\n"""`;
}

function docstring(w: Writer, text: string) {
  w.line(`"""${text.replace(/"""/g, "'''")}"""`);
}

function driverInfo(d: Dialect): { module: string; conn: string; ph: Placeholder } {
  if (d === 'tsql') return { module: 'pyodbc', conn: 'pyodbc.Connection', ph: PH.q };
  if (d === 'plsql') return { module: 'oracledb', conn: 'oracledb.Connection', ph: PH.colon };
  return { module: 'sqlite3', conn: 'sqlite3.Connection', ph: PH.q };
}

/** Convert a raw driver value to the field type where the driver does not (sqlite3 returns text for dates). */
function fromDb(expr: string, m: Member, ctx: Ctx): string {
  if (ctx.d !== 'sqlite') return expr;
  const b = m.type.py;
  let conv: string | null = null;
  if (b === 'datetime') conv = 'datetime.fromisoformat';
  else if (b === 'date') conv = 'date.fromisoformat';
  else if (b === 'Decimal') conv = 'Decimal';
  else if (b === 'time') conv = 'time.fromisoformat';
  else if (b === 'UUID') conv = 'UUID';
  else if (b === 'bool') conv = 'bool';
  if (!conv) return expr;
  const call = conv === 'Decimal' || conv === 'UUID' ? `${conv}(str(${expr}))` : `${conv}(${expr})`;
  return m.nullable ? `${call} if ${expr} is not None else None` : call;
}

/**
 * Convert a value for the driver where it cannot bind the Python type. The stdlib sqlite3 module rejects Decimal and
 * UUID ("type 'decimal.Decimal' is not supported"), and its date/datetime adapters are deprecated since Python 3.12:
 * bind text instead (ISO 8601; datetimes with a space, as SQLite's own datetime() writes them).
 */
function toDb(expr: string, py: string, nullable: boolean, ctx: Ctx): string {
  if (ctx.d !== 'sqlite') return expr;
  let conv: string | null = null;
  if (py === 'Decimal' || py === 'UUID') conv = `str(${expr})`;
  else if (py === 'datetime') conv = `${expr}.isoformat(" ")`;
  else if (py === 'date' || py === 'time') conv = `${expr}.isoformat()`;
  if (!conv) return expr;
  return nullable ? `(${conv} if ${expr} is not None else None)` : conv;
}

// ---------------- models ----------------

function dataclass(w: Writer, typeName: string, members: Member[], doc: string, ctx: Ctx) {
  addImport(ctx, 'dataclasses', 'dataclass');
  w.line(ctx.o.pyUnionSyntax ? '@dataclass(slots=True)' : '@dataclass');
  w.line(`class ${typeName}:`);
  w.indent();
  docstring(w, doc);
  w.blank();
  for (const m of members) {
    const todo = m.type.known ? '' : `  # TODO: unmapped type ${m.col.dbType}`;
    w.line(`${m.name}: ${pyType(m.type, m.nullable, ctx)}${todo}`);
    const c = commentText(m.col.comment);
    if (c) docstring(w, c);
  }
  w.dedent();
}

function pydanticModel(w: Writer, typeName: string, members: Member[], doc: string, ctx: Ctx) {
  addImport(ctx, 'pydantic', 'BaseModel');
  const needsField = members.some((m) => m.name !== m.col.name || (m.type.logical === 'string' && m.type.length));
  if (needsField) addImport(ctx, 'pydantic', 'Field');
  w.line(`class ${typeName}(BaseModel):`);
  w.indent();
  docstring(w, doc);
  w.blank();
  if (members.some((m) => m.name !== m.col.name)) {
    addImport(ctx, 'pydantic', 'ConfigDict');
    w.line('model_config = ConfigDict(populate_by_name=True)');
    w.blank();
  }
  for (const m of members) {
    const args: string[] = [];
    if (m.nullable) args.push('default=None');
    if (m.name !== m.col.name) args.push(`alias="${m.col.name}"`);
    if (m.type.logical === 'string' && m.type.length) args.push(`max_length=${m.type.length}`);
    const c = commentText(m.col.comment);
    if (c && needsField) args.push(`description="${c.replace(/"/g, '\\"')}"`);
    const t = pyType(m.type, m.nullable, ctx);
    const todo = m.type.known ? '' : `  # TODO: unmapped type ${m.col.dbType}`;
    if (args.length && needsField) w.line(`${m.name}: ${t} = Field(${args.join(', ')})${todo}`);
    else w.line(`${m.name}: ${t}${m.nullable ? ' = None' : ''}${todo}`);
  }
  w.dedent();
}

const SA_TYPE: Record<string, string> = {
  bool: 'Boolean', uint8: 'SmallInteger', int16: 'SmallInteger', int32: 'Integer', int64: 'BigInteger', decimal: 'Numeric', float32: 'Float',
  float64: 'Float', string: 'String', date: 'Date', datetime: 'DateTime', datetimeoffset: 'DateTime', time: 'Time', interval: 'Interval',
  guid: 'Uuid', binary: 'LargeBinary', rowversion: 'LargeBinary', xml: 'Text', json: 'JSON', object: 'NullType', cursor: 'NullType',
};

function saColumnType(t: ResolvedType, ctx: Ctx): string {
  const name = SA_TYPE[t.logical] ?? 'NullType';
  if (name === 'NullType') {
    addImport(ctx, 'sqlalchemy.types', 'NullType');
    return 'NullType()';
  }
  addImport(ctx, 'sqlalchemy', name);
  if (name === 'String' && t.length) return `String(${t.length})`;
  if (name === 'String' && /text|clob|ntext|max/i.test(t.dbType)) {
    addImport(ctx, 'sqlalchemy', 'Text');
    return 'Text()';
  }
  if (name === 'Numeric' && t.precision) return `Numeric(${t.precision}, ${t.scale ?? 0})`;
  if (name === 'DateTime' && t.logical === 'datetimeoffset') return 'DateTime(timezone=True)';
  return `${name}()`;
}

function sqlalchemyModel(w: Writer, typeName: string, members: Member[], t: CgTable, doc: string, ctx: Ctx) {
  addImport(ctx, 'sqlalchemy.orm', 'Mapped');
  addImport(ctx, 'sqlalchemy.orm', 'mapped_column');
  w.line(`class ${typeName}(Base):`);
  w.indent();
  docstring(w, doc);
  w.blank();
  w.line(`__tablename__ = "${t.name}"`);
  const pk = pkMembers(members, t.primaryKey);
  const args: string[] = [];
  if (t.schema && !(ctx.d === 'sqlite' && t.schema === 'main')) args.push(`"schema": "${t.schema}"`);
  if (commentText(t.comment)) args.push(`"comment": "${commentText(t.comment).replace(/"/g, '\\"')}"`);
  if (args.length) w.line(`__table_args__ = {${args.join(', ')}}`);
  if (t.kind === 'view') w.line('# A view: SQLAlchemy needs a primary key, so the first column stands in for it.');
  w.blank();
  for (const m of members) {
    const isPk = pk.includes(m) || (t.kind === 'view' && !pk.length && m === members[0]);
    const kw: string[] = [];
    if (m.name !== m.col.name) kw.unshift(`"${m.col.name}"`);
    kw.push(saColumnType(m.type, ctx));
    const fk = t.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === m.col.name);
    if (fk) {
      addImport(ctx, 'sqlalchemy', 'ForeignKey');
      const target = [fk.refSchema && !(ctx.d === 'sqlite' && fk.refSchema === 'main') ? fk.refSchema : null, fk.refTable, fk.refColumns[0]].filter(Boolean).join('.');
      kw.push(`ForeignKey("${target}")`);
    }
    if (isPk) kw.push('primary_key=True');
    if (m.col.identity) kw.push('autoincrement=True');
    else if (m.col.hasDefault && !isPk && t.kind === 'table') {
      // The server fills it on INSERT when the attribute is left unset.
      addImport(ctx, 'sqlalchemy', 'FetchedValue');
      kw.push('server_default=FetchedValue()');
    }
    if (m.col.computed) kw.push('# computed');
    const c = commentText(m.col.comment);
    if (c) kw.push(`comment="${c.replace(/"/g, '\\"')}"`);
    const todo = m.type.known ? '' : `  # TODO: unmapped type ${m.col.dbType}`;
    const typeText = pyType(m.type, m.nullable, ctx);
    w.line(`${m.name}: Mapped[${typeText}] = mapped_column(${kw.filter((k) => !k.startsWith('#')).join(', ')})${todo}`);
  }
  w.dedent();
}

// ---------------- repository (DB-API) ----------------

function repository(w: Writer, t: CgTable, typeName: string, members: Member[], ctx: Ctx) {
  const { d, o } = ctx;
  const drv = driverInfo(d);
  ctx.plain.add(drv.module);
  const byCol = new Map(members.map((m) => [m.col, m]));
  const crud = crudSql(t, d, { placeholder: drv.ph, bindName: (c) => byCol.get(c)!.name, identityReturn: d === 'sqlite' ? 'none' : 'auto', newline: '\n' });
  const pk = pkMembers(members, t.primaryKey);
  const cls = `${typeName}Repository`;
  const scope = new NameScope(['self', 'row', 'cur', 'rows', 'e', 'out']);
  const keys = pk.map((m) => ({ m, local: scope.take(localName(m.col.name, o)) }));
  const keySig = keys.map((k) => `${k.local}: ${pyType(k.m.type, false, ctx)}`).join(', ');
  const base = snake(typeName).toUpperCase();
  const identity = members.find((m) => m.col.identity);

  const consts: [string, string][] = [[`_${base}_SELECT`, crud.selectAll]];
  if (crud.selectByPk) consts.push([`_${base}_GET`, crud.selectByPk.sql]);
  if (crud.insert) consts.push([`_${base}_INSERT`, crud.insert.sql]);
  if (crud.update) consts.push([`_${base}_UPDATE`, crud.update.sql]);
  if (crud.delete) consts.push([`_${base}_DELETE`, crud.delete.sql]);
  for (const [n, s] of consts) w.line(`${n} = ${q3(s)}`);
  w.blanks(2);

  const args = (cols: { m: Member; expr: string; key?: boolean }[]) => {
    if (d === 'plsql') return `{${cols.map((c) => `"${c.m.name}": ${c.expr}`).join(', ')}}`;
    if (d === 'tsql') return cols.map((c) => c.expr).join(', ');
    const vals = cols.map((c) => toDb(c.expr, c.m.type.py, c.m.nullable && !c.key, ctx));
    return `(${vals.join(', ')}${cols.length === 1 ? ',' : ''})`;
  };
  /** Emit `cur.execute(...)` in a cursor scope (python-oracledb cursors are context managers; sqlite3's are not). */
  const withCursor = (body: () => void, after?: () => void) => {
    if (d === 'plsql') {
      w.line('with self._conn.cursor() as cur:');
      w.indent();
      body();
      w.dedent();
    } else {
      w.line('cur = self._conn.cursor()');
      body();
    }
    after?.();
  };
  const execute = (sqlName: string, cols: { m: Member; expr: string }[]) => w.line(`cur.execute(${sqlName}${cols.length ? ', ' + args(cols) : ''})`);

  w.line(`class ${cls}:`);
  w.indent();
  docstring(w, `Data access for ${objectLabel(t)}. Transactions are the caller's: call conn.commit() after writes.`);
  w.blank();
  w.line(`def __init__(self, conn: ${drv.conn}) -> None:`);
  w.indent().line('self._conn = conn').dedent();
  w.blank();
  w.line('@staticmethod');
  w.line(`def _from_row(row: Any) -> ${typeName}:`);
  addImport(ctx, 'typing', 'Any');
  w.indent();
  w.line(`return ${typeName}(`);
  w.indent();
  members.forEach((m, i) => w.line(`${m.name}=${fromDb(`row[${i}]`, m, ctx)},`));
  w.dedent();
  w.line(')');
  w.dedent();

  if (crud.selectByPk) {
    w.blank();
    let optType = `${typeName} | None`;
    if (!o.pyUnionSyntax) {
      addImport(ctx, 'typing', 'Optional');
      optType = `Optional[${typeName}]`;
    }
    w.line(`def get(self, ${keySig}) -> ${optType}:`);
    w.indent();
    withCursor(() => {
      execute(`_${base}_GET`, keys.map((k) => ({ m: k.m, expr: k.local, key: true })));
      w.line('row = cur.fetchone()');
    });
    w.line('return self._from_row(row) if row is not None else None');
    w.dedent();
  }
  w.blank();
  w.line(`def list_all(self) -> list[${typeName}]:`);
  w.indent();
  withCursor(() => {
    execute(`_${base}_SELECT`, []);
    w.line('rows = cur.fetchall()');
  });
  w.line('return [self._from_row(r) for r in rows]');
  w.dedent();
  if (crud.insert) {
    const ins = crud.insert;
    const cols = ins.params.map((c) => ({ m: byCol.get(c)!, expr: `e.${byCol.get(c)!.name}` }));
    w.blank();
    const idType = identity ? pyType(identity.type, false, ctx) : 'None';
    w.line(`def insert(self, e: ${typeName}) -> ${idType}:`);
    w.indent();
    const note = defaultsNote(ins, !!crud.update);
    if (identity || note) docstring(w, [identity ? `Insert a row and return the generated ${identity.col.name}.` : 'Insert a row.', note].filter(Boolean).join(' '));
    if (identity && ins.returningKind === 'row') {
      withCursor(() => {
        execute(`_${base}_INSERT`, cols);
        w.line('row = cur.fetchone()');
      });
      w.line(`return ${idType}(row[0])`);
    } else if (identity && ins.returningKind === 'outBind') {
      withCursor(() => {
        w.line(`new_id = cur.var(${oracleVarType(identity.type)})`);
        w.line(`cur.execute(_${base}_INSERT, {${[...cols.map((c) => `"${c.m.name}": ${c.expr}`), `"${ins.returningBind}": new_id`].join(', ')}})`);
      });
      w.line(`return ${idType}(new_id.getvalue()[0])`);
    } else if (identity) {
      withCursor(() => execute(`_${base}_INSERT`, cols));
      w.line(`return ${idType}(cur.lastrowid)`);
    } else {
      withCursor(() => execute(`_${base}_INSERT`, cols));
    }
    w.dedent();
  }
  const affected = (name: string, sig: string, sqlName: string, cols: { m: Member; expr: string }[]) => {
    w.blank();
    w.line(`def ${name}(self, ${sig}) -> bool:`);
    w.indent();
    withCursor(() => execute(sqlName, cols));
    w.line('return cur.rowcount == 1');
    w.dedent();
  };
  if (crud.update) affected('update', `e: ${typeName}`, `_${base}_UPDATE`, crud.update.params.map((c) => ({ m: byCol.get(c)!, expr: `e.${byCol.get(c)!.name}` })));
  if (crud.delete) affected('delete', keySig, `_${base}_DELETE`, keys.map((k) => ({ m: k.m, expr: k.local, key: true })));
  w.dedent();
}

// ---------------- routines ----------------

function routineFn(w: Writer, r: CgRoutine, ctx: Ctx, prefix: string) {
  const { d, o } = ctx;
  const drv = driverInfo(d);
  ctx.plain.add(drv.module);
  const fn = snake(`${prefix}${r.name}`);
  const scope = new NameScope(['conn', 'cur', 'row', 'rows', 'out', 'result']);
  const params = callParams(r);
  const args = params
    .filter((p) => p.direction === 'in' || p.direction === 'inout')
    .map((p) => {
      const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
      return { p, rt, local: scope.take(localName(bindNameOf(p), o)), type: pyType(rt, p.hasDefault || p.direction === 'inout', ctx) };
    });
  const required = args.filter((a) => !a.p.hasDefault);
  const optional = args.filter((a) => a.p.hasDefault);
  const sig = [`conn: ${drv.conn}`, ...required.map((a) => `${a.local}: ${a.type}`), ...optional.map((a) => `${a.local}: ${a.type} = None`)].join(', ');
  const ret = returnParam(r);
  const sqlName = routineSqlName(r, d, qi);
  const outs = params.filter((p) => p.direction === 'out' || p.direction === 'inout').map((p) => {
    const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
    return { p, rt, cursor: isRefCursor(p.dbType), name: snake(friendlyParam(bindNameOf(p))) };
  });

  if (r.kind === 'func' && ret) {
    const rt = resolveType(d, ret.dbType, { numberOneAsBool: o.numberOneAsBool });
    const t = pyType(rt, true, ctx);
    w.line(`def ${fn}(${sig}) -> ${t}:`);
    w.indent();
    docstring(w, `Call ${objectLabel(r)}.`);
    if (d === 'plsql') {
      w.line('with conn.cursor() as cur:');
      w.indent().line(`return cur.callfunc("${sqlName}", ${oracleVarType(rt)}, keyword_parameters={${args.map((a) => `"${bindNameOf(a.p)}": ${a.local}`).join(', ')}})`).dedent();
    } else {
      w.line(`row = conn.cursor().execute("SELECT ${sqlName}(${params.map(() => '?').join(', ')})", ${args.map((a) => a.local).join(', ')}).fetchone()`);
      w.line('return row[0] if row is not None else None');
    }
    w.dedent();
    return;
  }

  const resultName = pascal(`${prefix}${r.name}_result`);
  const hasRows = d === 'tsql';
  const fields = [
    ...(hasRows ? [['rows', 'list[tuple[Any, ...]]']] : []),
    ...outs.map((x) => [x.name, x.cursor ? 'list[tuple[Any, ...]]' : pyType(x.rt, true, ctx)]),
    ...(d === 'tsql' ? [['return_value', 'int']] : []),
  ];
  if (fields.some((f) => f[1].includes('Any'))) addImport(ctx, 'typing', 'Any');
  const hasResult = fields.length > 0;
  if (hasResult) {
    addImport(ctx, 'dataclasses', 'dataclass');
    w.line('@dataclass');
    w.line(`class ${resultName}:`);
    w.indent();
    docstring(w, `What ${objectLabel(r)} returns.`);
    w.blank();
    for (const [n, t] of fields) w.line(`${n}: ${t}`);
    w.dedent();
    w.blanks(2);
  }
  w.line(`def ${fn}(${sig}) -> ${hasResult ? resultName : 'None'}:`);
  w.indent();
  docstring(w, `Call ${objectLabel(r)}.`);
  if (d === 'tsql') {
    // pyodbc has no OUT parameters: run a batch that declares them and SELECTs them back.
    const decls = outs.map((x) => `@${bindNameOf(x.p)} ${outDecl(x.p.dbType)}`);
    const assigns = params.map((p) => {
      if (p.direction === 'in') return `@${bindNameOf(p)} = ?`;
      return `@${bindNameOf(p)} = @${bindNameOf(p)} OUTPUT`;
    });
    const inits = outs.filter((x) => x.p.direction === 'inout').map((x) => `SET @${bindNameOf(x.p)} = ?;`);
    const batch = [
      'SET NOCOUNT ON;',
      `DECLARE @return_value int${decls.length ? ', ' + decls.join(', ') : ''};`,
      ...inits,
      `EXEC @return_value = ${sqlName}${assigns.length ? ' ' + assigns.join(', ') : ''};`,
      `SELECT @return_value AS [__return_value]${outs.map((x) => `, @${bindNameOf(x.p)} AS [${bindNameOf(x.p)}]`).join('')};`,
    ].join('\n');
    const bindValues = [
      ...outs.filter((x) => x.p.direction === 'inout').map((x) => args.find((a) => a.p === x.p)!.local),
      ...params.filter((p) => p.direction === 'in').map((p) => args.find((a) => a.p === p)!.local),
    ];
    w.line(`sql = ${q3(batch)}`);
    w.line(`cur = conn.cursor().execute(sql${bindValues.length ? ', ' + bindValues.join(', ') : ''})`);
    w.line('rows: list[tuple[Any, ...]] = []');
    w.line('while not _is_status_row(cur):');
    w.indent();
    w.line('if cur.description:');
    w.indent().line('rows.extend(tuple(r) for r in cur.fetchall())').dedent();
    w.line('if not cur.nextset():');
    w.indent().line(`raise RuntimeError("${sqlName} returned no status row")`).dedent();
    w.dedent();
    w.line('status = cur.fetchone()');
    w.line(`return ${resultName}(rows=rows, ${outs.map((x, i) => `${x.name}=status[${i + 1}]`).join(', ')}${outs.length ? ', ' : ''}return_value=int(status[0]))`);
    ctx.from.set('__status__', new Set([JSON.stringify(outs.length + 1)]));
  } else {
    w.line('with conn.cursor() as cur:');
    w.indent();
    const kw: string[] = [];
    for (const p of params) {
      const a = args.find((x) => x.p === p);
      const out = outs.find((x) => x.p === p);
      if (out?.cursor) {
        w.line(`${out.name}_var = cur.var(oracledb.DB_TYPE_CURSOR)`);
        kw.push(`"${bindNameOf(p)}": ${out.name}_var`);
      } else if (out) {
        w.line(`${out.name}_var = cur.var(${oracleVarType(out.rt)})`);
        if (p.direction === 'inout') w.line(`${out.name}_var.setvalue(0, ${a!.local})`);
        kw.push(`"${bindNameOf(p)}": ${out.name}_var`);
      } else kw.push(`"${bindNameOf(p)}": ${a!.local}`);
    }
    w.line(`cur.callproc("${sqlName}", keyword_parameters={${kw.join(', ')}})`);
    if (hasResult) {
      w.line(`return ${resultName}(`);
      w.indent();
      for (const x of outs) w.line(x.cursor ? `${x.name}=[tuple(r) for r in ${x.name}_var.getvalue()],` : `${x.name}=${x.name}_var.getvalue(),`);
      w.dedent();
      w.line(')');
    }
    w.dedent();
  }
  w.dedent();
}

function oracleVarType(t: ResolvedType): string {
  switch (t.py) {
    case 'str':
      return 'str';
    case 'int':
      return 'int';
    case 'float':
      return 'float';
    case 'bool':
      return 'bool';
    case 'datetime':
      return 'oracledb.DB_TYPE_TIMESTAMP';
    case 'bytes':
      return 'bytes';
    default:
      return 'oracledb.DB_TYPE_NUMBER';
  }
}

function outDecl(dbType: string): string {
  const t = dbType.trim();
  if (/^(n?varchar|n?char|varbinary|binary)$/i.test(t)) return `${t}(max)`;
  return t;
}

// ---------------- queries ----------------

function queryFn(w: Writer, q: CgQuery, ctx: Ctx, rowType: string, members: Member[]) {
  const { d, o } = ctx;
  const drv = driverInfo(d);
  ctx.plain.add(drv.module);
  const style = d === 'plsql' ? 'colon' : d === 'tsql' ? 'q' : q.params.some((p) => p.positional) ? 'q' : 'colon';
  const { sql, order } = rewriteQuery(trimStatement(q.sql), d, style);
  const scope = new NameScope(['conn', 'cur', 'rows', 'r']);
  const args = q.params.map((p) => {
    const local = scope.take(localName(p.name, o));
    const type = queryParamPy(p.type, ctx);
    return { p, local, type, bind: toDb(local, type, false, ctx) };
  });
  const constName = `_${snake(q.name).toUpperCase()}_SQL`;
  w.line(`${constName} = ${q3(sql)}`);
  w.blanks(2);
  const fn = snake(queryFnBase(q.name));
  w.line(`def ${fn}(${[`conn: ${drv.conn}`, ...args.map((a) => `${a.local}: ${a.type}`)].join(', ')}) -> list[${rowType}]:`);
  w.indent();
  docstring(w, `Run the ${q.name} query.`);
  let bind = '';
  if (args.length) {
    if (style === 'colon') bind = `, {${args.map((a) => `"${a.p.name}": ${a.bind}`).join(', ')}}`;
    else if (d === 'tsql') bind = `, ${order.map((n) => args.find((a) => a.p.name === n)!.local).join(', ')}`;
    else bind = `, (${order.map((n) => args.find((a) => a.p.name === n)!.bind).join(', ')}${order.length === 1 ? ',' : ''})`;
  }
  w.line(`rows = conn.cursor().execute(${constName}${bind}).fetchall()`);
  w.line(`return [${rowType}(${members.map((m, i) => `${m.name}=${fromDb(`r[${i}]`, m, ctx)}`).join(', ')}) for r in rows]`);
  w.dedent();
}

function queryParamPy(t: CgQuery['params'][number]['type'], ctx: Ctx): string {
  const m: Record<string, string> = {
    string: 'str', int: 'int', long: 'int', decimal: 'Decimal', float: 'float', bool: 'bool', date: 'date', datetime: 'datetime',
    datetimeoffset: 'datetime', time: 'time', guid: 'UUID', binary: 'bytes',
  };
  const r = m[t] ?? 'Any';
  const imp = TYPE_IMPORT[r];
  if (imp) addImport(ctx, imp[0], imp[1]);
  return r;
}

// ---------------- assembly ----------------

interface Unit {
  name: string;
  label: string;
  ctx: Ctx;
  body: string;
}

export function generatePython(input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const d = input.dialect;
  const units: Unit[] = [];
  let needsBase = false;
  let needsStatus = false;
  const unitFor = (name: string, label: string, fn: (w: Writer, ctx: Ctx) => void) => {
    const ctx: Ctx = { d, o, from: new Map(), plain: new Set() };
    const w = new Writer('    ');
    fn(w, ctx);
    if (ctx.from.has('__status__')) {
      needsStatus = true;
      ctx.from.delete('__status__');
    }
    if (!w.isEmpty) units.push({ name, label, ctx, body: w.toString() });
  };
  for (const obj of input.objects) {
    if (isTable(obj)) {
      const typeName = typeNameOf(obj.name, o);
      const members = membersOf(obj.columns, d, o, typeName);
      const doc = [commentText(obj.comment), `Row of ${objectLabel(obj)}.`].filter(Boolean).join(' — ');
      unitFor(snake(obj.name), objectLabel(obj), (w, ctx) => {
        if (o.flavor === 'sqlalchemy') {
          needsBase = true;
          sqlalchemyModel(w, typeName, members, obj, doc, ctx);
        } else if (o.flavor === 'pydantic') pydanticModel(w, typeName, members, doc, ctx);
        else {
          dataclass(w, typeName, members, doc, ctx);
          if (o.include.repository) {
            w.blanks(2);
            repository(w, obj, typeName, members, ctx);
          }
        }
      });
    } else if (obj.kind === 'query') {
      const rowType = typeNameOf(withSuffix(obj.name, 'row'), o, false);
      const members = membersOf(obj.columns, d, o, rowType);
      unitFor(snake(obj.name), obj.name, (w, ctx) => {
        if (o.flavor === 'pydantic') pydanticModel(w, rowType, members, `Row of the ${obj.name} query.`, ctx);
        else dataclass(w, rowType, members, `Row of the ${obj.name} query.`, ctx);
        if (o.flavor === 'dataclass' && o.include.repository) {
          w.blanks(2);
          queryFn(w, obj, ctx, rowType, members);
        }
      });
    } else if (o.flavor === 'dataclass' && o.include.procedures && d !== 'sqlite') {
      if (isRoutine(obj)) unitFor(snake(obj.name), objectLabel(obj), (w, ctx) => routineFn(w, obj, ctx, ''));
      else if (obj.kind === 'package') {
        const pkg = obj as CgPackage;
        unitFor(snake(pkg.name), objectLabel(pkg), (w, ctx) => pkg.members.forEach((m, i) => {
          if (i) w.blanks(2);
          routineFn(w, m, ctx, `${pkg.name}_`);
        }));
      }
    }
  }
  if (!units.length) return [];

  const file = (us: Unit[], withBase: boolean, withStatus: boolean) => {
    const from = new Map<string, Set<string>>();
    const plain = new Set<string>();
    for (const u of us) {
      u.ctx.from.forEach((names, mod) => {
        if (!from.has(mod)) from.set(mod, new Set());
        names.forEach((n) => from.get(mod)!.add(n));
      });
      u.ctx.plain.forEach((p) => plain.add(p));
    }
    if (withBase) {
      if (!from.has('sqlalchemy.orm')) from.set('sqlalchemy.orm', new Set());
      from.get('sqlalchemy.orm')!.add('DeclarativeBase');
    }
    if (withStatus) {
      if (!from.has('typing')) from.set('typing', new Set());
      from.get('typing')!.add('Any');
    }
    const std = ['dataclasses', 'datetime', 'decimal', 'typing', 'uuid', 'sqlite3'];
    const isStd = (m: string) => std.includes(m.split('.')[0]);
    const lines: string[] = [`"""Generated by DbStudio from ${DIALECT_LABEL[d]}: ${us.map((u) => u.label).join(', ')}. Review before use."""`, '', 'from __future__ import annotations', ''];
    const stdLines: string[] = [];
    const extLines: string[] = [];
    for (const p of [...plain].sort()) (isStd(p) ? stdLines : extLines).push(`import ${p}`);
    for (const [mod, names] of [...from.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      (isStd(mod) ? stdLines : extLines).push(`from ${mod} import ${[...names].sort().join(', ')}`);
    }
    if (stdLines.length) lines.push(...stdLines.sort(sortImports), '');
    if (extLines.length) lines.push(...extLines.sort(sortImports), '');
    lines.push('');
    if (withBase) lines.push('class Base(DeclarativeBase):', '    """Declarative base shared by the generated models."""', '', '');
    if (withStatus) {
      lines.push(
        'def _is_status_row(cur: Any) -> bool:',
        '    """True for the trailing SELECT that carries the return value and OUT parameters."""',
        "    return bool(cur.description) and cur.description[0][0] == '__return_value'",
        '',
        '',
      );
    }
    lines.push(us.map((u) => u.body).join('\n\n\n'), '');
    return lines.join('\n');
  };
  if (o.combined) return [{ path: units.length === 1 ? `${units[0].name}.py` : 'db.py', language: 'python', content: file(units, needsBase, needsStatus) }];
  const files = units.map((u) => ({ path: `${u.name}.py`, language: 'python', content: file([u], false, u.body.includes('_is_status_row')) }));
  if (needsBase) {
    files.unshift({ path: 'base.py', language: 'python', content: file([], true, false) });
    for (const f of files.slice(1)) f.content = f.content.replace('from __future__ import annotations\n', 'from __future__ import annotations\n\nfrom .base import Base\n');
  }
  return files;
}

function sortImports(a: string, b: string): number {
  const key = (s: string) => s.replace(/^(from|import) /, '');
  return key(a).localeCompare(key(b));
}

export type { CgTable };

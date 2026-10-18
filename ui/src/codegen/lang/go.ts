// Go generator: database/sql (default) and sqlx flavors. Output is gofmt-clean (tabs, aligned struct fields).
import type { Dialect } from '../../api/types';
import type { CgInput, CgPackage, CgParam, CgQuery, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import { camel, goCamel, goPascal, NameScope } from '../naming';
import type { CodegenOptions } from '../options';
import { bindNameOf, DIALECT_LABEL, friendlyParam, membersOf, objectLabel, pkMembers, routineSqlName, typeNameOf, type Member } from '../shape';
import { crudSql, defaultsNote, PH, qi, rewriteQuery, trimStatement, type Placeholder } from '../sqlgen';
import { resolveType, type ResolvedType } from '../types';
import { commentText, Writer } from '../writer';

interface Ctx {
  d: Dialect;
  o: CodegenOptions;
  imports: Set<string>;
  /** Shared declarations (DBTX, helpers) needed by this unit. */
  shared: Set<'dbtx' | 'scanMaps' | 'execAffectedOne'>;
}

interface Unit {
  name: string;
  label: string;
  kind: 'table' | 'query' | 'routine' | 'package';
  ctx: Ctx;
  body: string;
}

const sqlx = (o: CodegenOptions) => o.flavor === 'sqlx';

// ---------------- types ----------------

function baseGoType(t: ResolvedType, o: CodegenOptions): string {
  if (t.logical === 'decimal' && o.goDecimal === 'string') return 'string';
  return t.go;
}

const SQL_NULL: Record<string, string> = {
  string: 'sql.NullString', int64: 'sql.NullInt64', int32: 'sql.NullInt32', int16: 'sql.NullInt16', uint8: 'sql.NullByte',
  float64: 'sql.NullFloat64', bool: 'sql.NullBool', 'time.Time': 'sql.NullTime',
};

function goType(t: ResolvedType, nullable: boolean, ctx: Ctx): string {
  const b = baseGoType(t, ctx.o);
  if (b.startsWith('time.')) ctx.imports.add('time');
  if (!nullable || b === '[]byte' || b === 'any') return b;
  if (ctx.o.goNullable === 'sqlNull') {
    ctx.imports.add('database/sql');
    return SQL_NULL[b] ?? `sql.Null[${b}]`;
  }
  return `*${b}`;
}

/** Placeholders per driver: go-mssqldb `@p1`, godror `:1`, go-sqlite3 `?`; sqlx rebinds `?`. */
function placeholder(ctx: Ctx): Placeholder {
  if (sqlx(ctx.o)) return PH.q;
  return ctx.d === 'tsql' ? PH.atP : ctx.d === 'plsql' ? PH.colonN : PH.q;
}

// ---------------- gofmt-compatible struct alignment ----------------

/** Struct fields aligned like gofmt (tabwriter: name, type, tag, trailing comment). */
function structBlock(w: Writer, name: string, fields: { name: string; type: string; tag: string; comment: string }[]) {
  w.line(`type ${name} struct {`);
  w.indent();
  const nameW = Math.max(...fields.map((f) => f.name.length));
  const typeW = Math.max(...fields.map((f) => f.type.length));
  // Tag column width is computed per run of consecutive commented lines (tabwriter column blocks).
  const tagW: number[] = fields.map(() => 0);
  for (let i = 0; i < fields.length; ) {
    if (!fields[i].comment) {
      i++;
      continue;
    }
    let j = i;
    while (j < fields.length && fields[j].comment) j++;
    const width = Math.max(...fields.slice(i, j).map((f) => f.tag.length));
    for (let k = i; k < j; k++) tagW[k] = width;
    i = j;
  }
  fields.forEach((f, i) => {
    let line = f.name.padEnd(nameW + 1) + (f.tag || f.comment ? f.type.padEnd(typeW + 1) : f.type);
    if (f.tag) line += f.comment ? f.tag.padEnd(tagW[i] + 1) : f.tag;
    if (f.comment) line += `// ${f.comment}`;
    w.line(line.trimEnd());
  });
  w.dedent();
  w.line('}');
}

function rawString(sql: string): string {
  return sql.includes('`') ? JSON.stringify(sql) : `\`${sql}\``;
}

// ---------------- model ----------------

function modelStruct(w: Writer, typeName: string, members: Member[], label: string | null, comment: string | null | undefined, ctx: Ctx) {
  const doc = commentText(comment);
  w.line(`// ${typeName} is a row of ${label ?? 'the query'}${doc ? `: ${doc.replace(/.$/, '')}.` : '.'}`);
  structBlock(
    w,
    typeName,
    members.map((m) => {
      const tags = [`db:"${m.col.name}"`];
      if (ctx.o.goJsonTags) tags.push(`json:"${camel(m.col.name)}${m.nullable ? ',omitempty' : ''}"`);
      const c = [m.type.known ? '' : `TODO: unmapped type ${m.col.dbType}`, commentText(m.col.comment)].filter(Boolean).join('; ');
      return { name: m.name, type: goType(m.type, m.nullable, ctx), tag: `\`${tags.join(' ')}\``, comment: c };
    }),
  );
}

function scanArgs(members: Member[], v: string): string {
  return members.map((m) => `&${v}.${m.name}`).join(', ');
}

function recv(typeName: string): string {
  return typeName.charAt(0).toLowerCase();
}

// ---------------- repository ----------------

function store(w: Writer, t: CgTable, typeName: string, members: Member[], ctx: Ctx) {
  const { d, o } = ctx;
  ctx.imports.add('context');
  const byCol = new Map(members.map((m) => [m.col, m]));
  const ph = placeholder(ctx);
  const crud = crudSql(t, d, { placeholder: ph, bindName: (c) => byCol.get(c)!.name, newline: '\n', identityReturn: d === 'sqlite' ? 'none' : 'auto' });
  const pk = pkMembers(members, t.primaryKey);
  const storeName = `${typeName}Store`;
  const v = recv(typeName) === 's' ? 'e' : recv(typeName);
  const scope = new NameScope(['ctx', 's', 'err', 'rows', 'res', v, 'n', 'items']);
  const keyArgs = pk.map((m) => ({ m, local: scope.take(goCamel(m.col.name)) }));
  const keySig = keyArgs.map((k) => `${k.local} ${goType(k.m.type, false, ctx)}`).join(', ');
  const keyVals = keyArgs.map((k) => k.local).join(', ');
  const base = goCamel(typeName);
  const q = (name: string) => (sqlx(o) ? `s.db.Rebind(${name})` : name);
  const dbType = sqlx(o) ? 'sqlx.ExtContext' : 'DBTX';
  if (sqlx(o)) ctx.imports.add('github.com/jmoiron/sqlx');
  else ctx.shared.add('dbtx');

  const sqlConst = (name: string, sql: string) => {
    w.line(`const ${name} = ${rawString(sql)}`);
    w.blank();
  };
  sqlConst(`${base}SelectSQL`, crud.selectAll);
  if (crud.selectByPk) sqlConst(`${base}GetSQL`, crud.selectByPk.sql);
  if (crud.insert) sqlConst(`${base}InsertSQL`, crud.insert.sql);
  if (crud.update) sqlConst(`${base}UpdateSQL`, crud.update.sql);
  if (crud.delete) sqlConst(`${base}DeleteSQL`, crud.delete.sql);

  w.line(`// ${storeName} reads and writes ${objectLabel(t)}.`);
  w.line(`type ${storeName} struct {`);
  w.indent().line(`db ${dbType}`).dedent();
  w.line('}');
  w.blank();
  w.line(`// New${storeName} returns ${/^[AEIOU]/.test(storeName) ? 'an' : 'a'} ${storeName} that runs on db (${sqlx(o) ? '*sqlx.DB or *sqlx.Tx' : '*sql.DB, *sql.Conn or *sql.Tx'}).`);
  w.line(`func New${storeName}(db ${dbType}) *${storeName} {`);
  w.indent().line(`return &${storeName}{db: db}`).dedent();
  w.line('}');

  if (crud.selectByPk) {
    w.blank();
    w.line(`// Get returns the row with the given key, or sql.ErrNoRows.`);
    w.line(`func (s *${storeName}) Get(ctx context.Context, ${keySig}) (*${typeName}, error) {`);
    w.indent();
    w.line(`var ${v} ${typeName}`);
    if (sqlx(o)) {
      w.line(`if err := sqlx.GetContext(ctx, s.db, &${v}, ${q(`${base}GetSQL`)}, ${keyVals}); err != nil {`);
    } else {
      w.line(`if err := s.db.QueryRowContext(ctx, ${base}GetSQL, ${keyVals}).Scan(${scanArgs(members, v)}); err != nil {`);
    }
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line(`return &${v}, nil`);
    w.dedent();
    w.line('}');
  }

  w.blank();
  w.line('// List returns every row.');
  w.line(`func (s *${storeName}) List(ctx context.Context) ([]${typeName}, error) {`);
  w.indent();
  if (sqlx(o)) {
    w.line(`var items []${typeName}`);
    w.line(`err := sqlx.SelectContext(ctx, s.db, &items, ${q(`${base}SelectSQL`)})`);
    w.line('return items, err');
  } else {
    w.line(`rows, err := s.db.QueryContext(ctx, ${base}SelectSQL)`);
    w.line('if err != nil {');
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line('defer rows.Close()');
    w.line(`var items []${typeName}`);
    w.line('for rows.Next() {');
    w.indent();
    w.line(`var ${v} ${typeName}`);
    w.line(`if err := rows.Scan(${scanArgs(members, v)}); err != nil {`);
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line(`items = append(items, ${v})`);
    w.dedent();
    w.line('}');
    w.line('return items, rows.Err()');
  }
  w.dedent();
  w.line('}');

  if (crud.insert) {
    const ins = crud.insert;
    const identity = ins.returning ? byCol.get(ins.returning)! : t.columns.find((c) => c.identity) ? byCol.get(t.columns.find((c) => c.identity)!)! : null;
    const args = ins.params.map((c) => `${v}.${byCol.get(c)!.name}`);
    w.blank();
    const idType = identity ? goType(identity.type, false, ctx) : null;
    w.line(identity ? `// Insert adds a row and returns its generated ${identity.col.name}.` : '// Insert adds a row.');
    const note = defaultsNote(ins, !!crud.update);
    if (note) w.line(`// ${note}`);
    w.line(`func (s *${storeName}) Insert(ctx context.Context, ${v} *${typeName}) ${identity ? `(${idType}, error)` : 'error'} {`);
    w.indent();
    if (identity && ins.returningKind === 'row') {
      w.line(`var id ${idType}`);
      w.line(`err := s.db.${sqlx(o) ? 'QueryRowxContext' : 'QueryRowContext'}(ctx, ${q(`${base}InsertSQL`)}, ${args.join(', ')}).Scan(&id)`);
      w.line('return id, err');
    } else if (identity && ins.returningKind === 'outBind') {
      ctx.imports.add('database/sql');
      w.line(`var id ${idType}`);
      w.line(`_, err := s.db.ExecContext(ctx, ${q(`${base}InsertSQL`)}, ${[...args, 'sql.Out{Dest: &id}'].join(', ')})`);
      w.line('return id, err');
    } else if (identity) {
      // SQLite: rowid of the new row.
      w.line(`res, err := s.db.ExecContext(ctx, ${q(`${base}InsertSQL`)}${args.length ? ', ' + args.join(', ') : ''})`);
      w.line('if err != nil {');
      w.indent().line('return 0, err').dedent();
      w.line('}');
      w.line('id, err := res.LastInsertId()');
      w.line(idType === 'int64' ? 'return id, err' : `return ${idType}(id), err`);
    } else {
      w.line(`_, err := s.db.ExecContext(ctx, ${q(`${base}InsertSQL`)}${args.length ? ', ' + args.join(', ') : ''})`);
      w.line('return err');
    }
    w.dedent();
    w.line('}');
  }
  const affectedOne = (sqlName: string, args: string[]) => {
    ctx.shared.add('execAffectedOne');
    w.line(`return execAffectedOne(s.db.ExecContext(ctx, ${q(sqlName)}, ${args.join(', ')}))`);
  };
  if (crud.update) {
    w.blank();
    w.line('// Update writes every non-key column; it returns sql.ErrNoRows when no row has the key.');
    w.line(`func (s *${storeName}) Update(ctx context.Context, ${v} *${typeName}) error {`);
    w.indent();
    affectedOne(`${base}UpdateSQL`, crud.update.params.map((c) => `${v}.${byCol.get(c)!.name}`));
    w.dedent();
    w.line('}');
  }
  if (crud.delete) {
    w.blank();
    w.line('// Delete removes the row with the given key; it returns sql.ErrNoRows when there is none.');
    w.line(`func (s *${storeName}) Delete(ctx context.Context, ${keySig}) error {`);
    w.indent();
    affectedOne(`${base}DeleteSQL`, keyArgs.map((k) => k.local));
    w.dedent();
    w.line('}');
  }
}

// ---------------- routines ----------------

interface Arg {
  p: CgParam;
  local: string;
  type: string;
  rt: ResolvedType;
}

function routineFn(w: Writer, r: CgRoutine, ctx: Ctx, prefix: string) {
  const { d, o } = ctx;
  ctx.imports.add('context');
  if (!sqlx(o)) ctx.shared.add('dbtx');
  const dbType = sqlx(o) ? 'sqlx.ExtContext' : 'DBTX';
  if (sqlx(o)) ctx.imports.add('github.com/jmoiron/sqlx');
  const fn = goPascal(`${prefix}${r.name}`);
  const scope = new NameScope(['ctx', 'db', 'err', 'rows', 'res', 'out', 'status', 'value', 'cur']);
  const args: Arg[] = callParams(r)
    .filter((p) => p.direction === 'in' || p.direction === 'inout')
    .map((p) => {
      const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
      return { p, rt, local: scope.take(goCamel(friendlyParam(bindNameOf(p)))), type: goType(rt, p.hasDefault, ctx) };
    });
  const outs = callParams(r).filter((p) => p.direction === 'out' || p.direction === 'inout');
  const ret = returnParam(r);
  const sqlName = routineSqlName(r, d, qi);
  const sig = args.map((a) => `${a.local} ${a.type}`).join(', ');

  if (r.kind === 'func' && ret) {
    w.line(`// ${fn} calls ${objectLabel(r)}.`);
    const rt = resolveType(d, ret.dbType, { numberOneAsBool: o.numberOneAsBool });
    const t = goType(rt, true, ctx);
    const placeholders = callParams(r).map((_, i) => (sqlx(o) ? '?' : d === 'tsql' ? `@p${i + 1}` : d === 'plsql' ? `:${i + 1}` : '?'));
    const sql = d === 'plsql' ? `SELECT ${sqlName}(${placeholders.join(', ')}) FROM DUAL` : `SELECT ${sqlName}(${placeholders.join(', ')})`;
    w.line(`func ${fn}(ctx context.Context, db ${dbType}${sig ? ', ' + sig : ''}) (${t}, error) {`);
    w.indent();
    w.line(`var value ${t}`);
    w.line(`err := db.${sqlx(o) ? 'QueryRowxContext' : 'QueryRowContext'}(ctx, ${sqlx(o) ? `db.Rebind(${JSON.stringify(sql)})` : JSON.stringify(sql)}${args.length ? ', ' + args.map((a) => a.local).join(', ') : ''}).Scan(&value)`);
    w.line('return value, err');
    w.dedent();
    w.line('}');
    return;
  }

  ctx.imports.add('database/sql');
  const resultName = goPascal(`${prefix}${r.name}_result`);
  const outFields = outs.map((p) => {
    const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
    const cursor = isRefCursor(p.dbType);
    return { p, cursor, field: goPascal(friendlyParam(bindNameOf(p))), type: cursor ? '[]map[string]any' : goType(rt, true, ctx) };
  });
  const tsqlRows = d === 'tsql';
  const fields: { name: string; type: string; tag: string; comment: string }[] = [];
  if (tsqlRows) fields.push({ name: 'Rows', type: '[]map[string]any', tag: '', comment: '' });
  for (const f of outFields) fields.push({ name: f.field, type: f.type, tag: '', comment: '' });
  if (d === 'tsql') fields.push({ name: 'ReturnStatus', type: 'int32', tag: '', comment: '' });
  const hasResult = fields.length > 0;
  if (hasResult) {
    w.line(`// ${resultName} holds what ${objectLabel(r)} returns.`);
    structBlock(w, resultName, fields);
    w.blank();
  }
  w.line(`// ${fn} calls ${objectLabel(r)}.`);
  w.line(`func ${fn}(ctx context.Context, db ${dbType}${sig ? ', ' + sig : ''}) ${hasResult ? `(${resultName}, error)` : 'error'} {`);
  w.indent();
  if (hasResult) w.line(`var out ${resultName}`);
  const callArgs: string[] = [];
  if (d === 'tsql') {
    ctx.imports.add('github.com/microsoft/go-mssqldb');
    for (const p of callParams(r)) {
      const name = JSON.stringify(bindNameOf(p));
      const a = args.find((x) => x.p === p);
      const f = outFields.find((x) => x.p === p);
      if (p.direction === 'in') callArgs.push(`sql.Named(${name}, ${a!.local})`);
      else if (p.direction === 'out') callArgs.push(`sql.Named(${name}, sql.Out{Dest: &out.${f!.field}})`);
      else {
        w.line(`out.${f!.field} = ${a!.type.startsWith('*') ? a!.local : `&${a!.local}`}`);
        callArgs.push(`sql.Named(${name}, sql.Out{Dest: &out.${f!.field}, In: true})`);
      }
    }
    w.line('var status mssql.ReturnStatus');
    callArgs.push('&status');
    // A single-word query runs as an RPC (stored procedure call) in go-mssqldb.
    w.line(`rows, err := db.QueryContext(ctx, ${JSON.stringify(sqlName)}${callArgs.length ? ', ' + callArgs.join(', ') : ''})`);
    w.line('if err != nil {');
    w.indent().line('return out, err').dedent();
    w.line('}');
    ctx.shared.add('scanMaps');
    w.line('out.Rows, err = scanMaps(rows)');
    w.line('if err != nil {');
    w.indent().line('return out, err').dedent();
    w.line('}');
    w.line('out.ReturnStatus = int32(status)');
    w.line('return out, nil');
  } else {
    // Oracle (godror): anonymous block with named notation; REF CURSORs come back as driver.Rows.
    const binds = callParams(r).map((p) => `${bindNameOf(p)} => :${bindNameOf(p)}`).join(', ');
    const cursors = outFields.filter((f) => f.cursor);
    if (cursors.length) {
      ctx.imports.add('database/sql/driver');
      ctx.imports.add('github.com/godror/godror');
      for (const c of cursors) w.line(`var ${goCamel(c.field)}Cursor driver.Rows`);
    }
    for (const p of callParams(r)) {
      const name = JSON.stringify(bindNameOf(p));
      const a = args.find((x) => x.p === p);
      const f = outFields.find((x) => x.p === p);
      if (p.direction === 'in') callArgs.push(`sql.Named(${name}, ${a!.local})`);
      else if (f?.cursor) callArgs.push(`sql.Named(${name}, sql.Out{Dest: &${goCamel(f.field)}Cursor})`);
      else if (p.direction === 'out') callArgs.push(`sql.Named(${name}, sql.Out{Dest: &out.${f!.field}})`);
      else {
        w.line(`out.${f!.field} = ${a!.type.startsWith('*') ? a!.local : `&${a!.local}`}`);
        callArgs.push(`sql.Named(${name}, sql.Out{Dest: &out.${f!.field}, In: true})`);
      }
    }
    const block = `BEGIN ${sqlName}(${binds}); END;`;
    w.line(`if _, err := db.ExecContext(ctx, ${JSON.stringify(block)}${callArgs.length ? ', ' + callArgs.join(', ') : ''}); err != nil {`);
    w.indent().line(hasResult ? 'return out, err' : 'return err').dedent();
    w.line('}');
    for (const c of cursors) {
      ctx.shared.add('scanMaps');
      const cv = `${goCamel(c.field)}Cursor`;
      w.line(`${goCamel(c.field)}Rows, err := godror.WrapRows(ctx, db, ${cv})`);
      w.line('if err != nil {');
      w.indent().line('return out, err').dedent();
      w.line('}');
      w.line(`if out.${c.field}, err = scanMaps(${goCamel(c.field)}Rows); err != nil {`);
      w.indent().line('return out, err').dedent();
      w.line('}');
    }
    w.line(hasResult ? 'return out, nil' : 'return nil');
  }
  w.dedent();
  w.line('}');
}

// ---------------- queries ----------------

function queryFn(w: Writer, q: CgQuery, ctx: Ctx) {
  const { d, o } = ctx;
  ctx.imports.add('context');
  const rowType = goPascal(`${q.name}_row`);
  const members = membersOf(q.columns, d, o, rowType);
  modelStruct(w, rowType, members, null, null, ctx);
  w.blank();
  const fn = goPascal(q.name);
  const constName = `${goCamel(q.name)}SQL`;
  const sqlText = trimStatement(q.sql);
  const positional = q.params.some((p) => p.positional);
  // sqlx: `?` + Rebind; database/sql: keep the dialect's own parameter syntax and bind by name.
  const text = sqlx(o) ? rewriteQuery(sqlText, d, 'q') : rewriteQuery(sqlText, d, 'keep');
  w.line(`const ${constName} = ${rawString(text.sql)}`);
  w.blank();
  const scope = new NameScope(['ctx', 'db', 'err', 'rows', 'items', 'r']);
  const args = q.params.map((p) => ({ p, local: scope.take(goCamel(p.name)), type: queryParamGoType(p.type, ctx) }));
  const dbType = sqlx(o) ? 'sqlx.ExtContext' : 'DBTX';
  if (sqlx(o)) ctx.imports.add('github.com/jmoiron/sqlx');
  else ctx.shared.add('dbtx');
  const callArgs = sqlx(o) || positional
    ? (sqlx(o) ? text.order.map((n) => args.find((a) => a.p.name === n)!.local) : args.map((a) => a.local))
    : args.map((a) => `sql.Named(${JSON.stringify(a.p.name)}, ${a.local})`);
  if (!sqlx(o) && !positional && args.length) ctx.imports.add('database/sql');
  w.line(`// ${fn} runs the ${q.name} query.`);
  w.line(`func ${fn}(ctx context.Context, db ${dbType}${args.length ? ', ' + args.map((a) => `${a.local} ${a.type}`).join(', ') : ''}) ([]${rowType}, error) {`);
  w.indent();
  if (sqlx(o)) {
    w.line(`var items []${rowType}`);
    w.line(`err := sqlx.SelectContext(ctx, db, &items, db.Rebind(${constName})${callArgs.length ? ', ' + callArgs.join(', ') : ''})`);
    w.line('return items, err');
  } else {
    w.line(`rows, err := db.QueryContext(ctx, ${constName}${callArgs.length ? ', ' + callArgs.join(', ') : ''})`);
    w.line('if err != nil {');
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line('defer rows.Close()');
    w.line(`var items []${rowType}`);
    w.line('for rows.Next() {');
    w.indent();
    w.line(`var r ${rowType}`);
    w.line(`if err := rows.Scan(${scanArgs(members, 'r')}); err != nil {`);
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line('items = append(items, r)');
    w.dedent();
    w.line('}');
    w.line('return items, rows.Err()');
  }
  w.dedent();
  w.line('}');
}

function queryParamGoType(t: CgQuery['params'][number]['type'], ctx: Ctx): string {
  const map: Record<string, string> = {
    string: 'string', int: 'int32', long: 'int64', decimal: ctx.o.goDecimal === 'string' ? 'string' : 'float64', float: 'float64', bool: 'bool',
    date: 'time.Time', datetime: 'time.Time', datetimeoffset: 'time.Time', time: 'time.Time', guid: 'string', binary: '[]byte',
  };
  const r = map[t] ?? 'any';
  if (r.startsWith('time.')) ctx.imports.add('time');
  return r;
}

// ---------------- shared declarations ----------------

function sharedDecls(kinds: Set<string>, imports: Set<string>): string {
  const w = new Writer('\t');
  if (kinds.has('dbtx')) {
    imports.add('context');
    imports.add('database/sql');
    w.line('// DBTX is satisfied by *sql.DB, *sql.Conn and *sql.Tx.');
    w.line('type DBTX interface {');
    w.indent();
    w.line('ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)');
    w.line('QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)');
    w.line('QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row');
    w.dedent();
    w.line('}');
  }
  if (kinds.has('execAffectedOne')) {
    imports.add('database/sql');
    w.blank();
    w.line('// execAffectedOne turns "0 rows affected" into sql.ErrNoRows.');
    w.line('func execAffectedOne(res sql.Result, err error) error {');
    w.indent();
    w.line('if err != nil {');
    w.indent().line('return err').dedent();
    w.line('}');
    w.line('n, err := res.RowsAffected()');
    w.line('if err != nil {');
    w.indent().line('return err').dedent();
    w.line('}');
    w.line('if n == 0 {');
    w.indent().line('return sql.ErrNoRows').dedent();
    w.line('}');
    w.line('return nil');
    w.dedent();
    w.line('}');
  }
  if (kinds.has('scanMaps')) {
    imports.add('database/sql');
    w.blank();
    w.line('// scanMaps reads every row of an untyped result set into maps keyed by column name, then closes rows.');
    w.line('func scanMaps(rows *sql.Rows) ([]map[string]any, error) {');
    w.indent();
    w.line('defer rows.Close()');
    w.line('cols, err := rows.Columns()');
    w.line('if err != nil {');
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line('var out []map[string]any');
    w.line('for rows.Next() {');
    w.indent();
    w.line('values := make([]any, len(cols))');
    w.line('ptrs := make([]any, len(cols))');
    w.line('for i := range values {');
    w.indent().line('ptrs[i] = &values[i]').dedent();
    w.line('}');
    w.line('if err := rows.Scan(ptrs...); err != nil {');
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line('row := make(map[string]any, len(cols))');
    w.line('for i, c := range cols {');
    w.indent().line('row[c] = values[i]').dedent();
    w.line('}');
    w.line('out = append(out, row)');
    w.dedent();
    w.line('}');
    w.line('return out, rows.Err()');
    w.dedent();
    w.line('}');
  }
  return w.toString();
}

// ---------------- assembly ----------------

export function generateGo(input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const d = input.dialect;
  const units: Unit[] = [];
  const unitFor = (name: string, label: string, kind: Unit['kind'], fn: (w: Writer, ctx: Ctx) => void) => {
    const ctx: Ctx = { d, o, imports: new Set(), shared: new Set() };
    const w = new Writer('\t');
    fn(w, ctx);
    if (!w.isEmpty) units.push({ name, label, kind, ctx, body: w.toString() });
  };

  for (const obj of input.objects) {
    if (isTable(obj)) {
      const typeName = typeNameOf(obj.name, o);
      const members = membersOf(obj.columns, d, o, typeName);
      unitFor(snakeFile(obj.name), objectLabel(obj), 'table', (w, ctx) => {
        modelStruct(w, typeName, members, objectLabel(obj), obj.comment, ctx);
        if (o.include.repository) {
          w.blank();
          store(w, obj, typeName, members, ctx);
        }
      });
    } else if (obj.kind === 'query' && o.include.repository) {
      unitFor(snakeFile(obj.name), obj.name, 'query', (w, ctx) => queryFn(w, obj, ctx));
    } else if (isRoutine(obj) && o.include.procedures) {
      unitFor(snakeFile(`${obj.schema ?? ''}_${obj.name}`), objectLabel(obj), 'routine', (w, ctx) => routineFn(w, obj, ctx, ''));
    } else if (obj.kind === 'package' && o.include.procedures) {
      const pkg = obj as CgPackage;
      unitFor(snakeFile(pkg.name), objectLabel(pkg), 'package', (w, ctx) => {
        pkg.members.forEach((m, i) => {
          if (i) w.blank();
          routineFn(w, m, ctx, `${pkg.name}_`);
        });
      });
    }
  }
  const order = (u: Unit) => (u.kind === 'table' ? 0 : u.kind === 'query' ? 1 : u.kind === 'routine' ? 2 : 3);
  units.sort((a, b) => order(a) - order(b));
  return assemble(units, input, o);
}

function snakeFile(name: string): string {
  return name.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase() || 'generated';
}

function importBlock(imports: Set<string>): string[] {
  const list = [...imports];
  const std = list.filter((i) => !i.includes('.')).sort();
  const ext = list.filter((i) => i.includes('.')).sort();
  const fmt = (i: string) => (i === 'github.com/microsoft/go-mssqldb' ? `mssql "${i}"` : `"${i}"`);
  if (!list.length) return [];
  if (list.length === 1) return [`import ${fmt(list[0])}`, ''];
  const lines = ['import ('];
  for (const i of std) lines.push(`\t${fmt(i)}`);
  if (std.length && ext.length) lines.push('');
  for (const i of ext) lines.push(`\t${fmt(i)}`);
  lines.push(')', '');
  return lines;
}

function assemble(units: Unit[], input: CgInput, o: CodegenOptions): GeneratedFile[] {
  if (!units.length) return [];
  const pkg = (o.namespace.trim().split(/[./]/).pop() || 'store').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'store';
  const header = (labels: string[]) => `// Code generated by DbStudio from ${DIALECT_LABEL[input.dialect]}: ${labels.join(', ')}. Review before use.`;
  const file = (bodies: string[], imports: Set<string>, labels: string[]) =>
    [header(labels), '', `package ${pkg}`, '', ...importBlock(imports), bodies.join('\n\n'), ''].join('\n');
  if (o.combined) {
    const imports = new Set<string>();
    const shared = new Set<string>();
    for (const u of units) {
      u.ctx.imports.forEach((i) => imports.add(i));
      u.ctx.shared.forEach((s) => shared.add(s));
    }
    const bodies = units.map((u) => u.body);
    const sh = sharedDecls(shared, imports);
    if (sh) bodies.push(sh);
    return [{ path: `${units.length === 1 ? units[0].name : pkg}.go`, language: 'go', content: file(bodies, imports, units.map((u) => u.label)) }];
  }
  const files: GeneratedFile[] = units.map((u) => ({ path: `${u.name}.go`, language: 'go', content: file([u.body], u.ctx.imports, [u.label]) }));
  const shared = new Set<string>();
  units.forEach((u) => u.ctx.shared.forEach((s) => shared.add(s)));
  if (shared.size) {
    const imports = new Set<string>();
    const sh = sharedDecls(shared, imports);
    files.push({ path: 'db.go', language: 'go', content: file([sh], imports, ['shared helpers']) });
  }
  return files;
}


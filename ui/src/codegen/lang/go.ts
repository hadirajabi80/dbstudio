// Go generator: database/sql (default) and sqlx flavors. Output is gofmt-clean (tabs, aligned struct fields).
import type { Dialect } from '../../api/types';
import type { CgInput, CgPackage, CgParam, CgQuery, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import { camel, goCamel, goPascal, NameScope, queryFnBase, withSuffix } from '../naming';
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
  shared: Set<'dbtx' | 'scanMaps' | 'execAffectedOne' | 'pgxDbtx' | 'pgxAffectedOne' | 'pgStdlib'>;
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
  if (ctx.d === 'pgsql') {
    const pt = pgGoType(t, nullable, ctx);
    typeImports(pt, ctx);
    return pt;
  }
  const b = baseGoType(t, ctx.o);
  if (b.startsWith('time.')) ctx.imports.add('time');
  if (!nullable || b === '[]byte' || b === 'any') return b;
  if (ctx.o.goNullable === 'sqlNull') {
    ctx.imports.add('database/sql');
    return SQL_NULL[b] ?? `sql.Null[${b}]`;
  }
  return `*${b}`;
}

// ---------------- PostgreSQL types (database/sql + pgx/v5/stdlib, sqlx, pgx native) ----------------

/** pgx `pgtype` value types for nullable columns (the "sql.Null*" option of the pgx flavor). */
const PGTYPE_NULL: Record<string, string> = {
  string: 'pgtype.Text', int64: 'pgtype.Int8', int32: 'pgtype.Int4', int16: 'pgtype.Int2', float64: 'pgtype.Float8', float32: 'pgtype.Float4',
  bool: 'pgtype.Bool',
};
const PGTYPE_TIME: Record<string, string> = { date: 'pgtype.Date', datetime: 'pgtype.Timestamp', datetimeoffset: 'pgtype.Timestamptz' };
/** Geometric / range / bit types pgx decodes natively (pgx flavor). */
const PGTYPE_OBJECT: Record<string, string> = {
  point: 'pgtype.Point', line: 'pgtype.Line', lseg: 'pgtype.Lseg', box: 'pgtype.Box', path: 'pgtype.Path', polygon: 'pgtype.Polygon',
  circle: 'pgtype.Circle', int4range: 'pgtype.Range[pgtype.Int4]', int8range: 'pgtype.Range[pgtype.Int8]', numrange: 'pgtype.Range[pgtype.Numeric]',
  daterange: 'pgtype.Range[pgtype.Date]', tsrange: 'pgtype.Range[pgtype.Timestamp]', tstzrange: 'pgtype.Range[pgtype.Timestamptz]',
  bit: 'pgtype.Bits', varbit: 'pgtype.Bits', 'bit varying': 'pgtype.Bits',
};
/** Array element types pgtype registers by Go type (so pgtype.Map.SQLScanner and pgx can decode `[]T`). */
const PG_SLICE_ELEMENTS = new Set(['string', 'int16', 'int32', 'int64', 'float32', 'float64', 'bool', 'time.Time', '[]byte', 'netip.Prefix']);

const pgxFlavor = (o: CodegenOptions) => o.flavor === 'pgx';

/**
 * PostgreSQL column type per flavor. database/sql (pgx/v5/stdlib) hands non-core types to Scan as text, so arrays and
 * inet go through pgtype.Map.SQLScanner; sqlx scans struct fields directly, so those stay in text form there.
 */
function pgGoType(t: ResolvedType, nullable: boolean, ctx: Ctx): string {
  const { o } = ctx;
  const native = pgxFlavor(o);
  const sqlNull = o.goNullable === 'sqlNull';
  const orNull = (b: string): string => {
    if (!nullable) return b;
    if (sqlNull) return native ? (PGTYPE_NULL[b] ?? `*${b}`) : (SQL_NULL[b] ?? `sql.Null[${b}]`);
    return `*${b}`;
  };
  if (t.array) {
    if (sqlx(o)) return orNull('string');
    const e = t.element ? pgGoType(t.element, false, ctx) : 'any';
    return PG_SLICE_ELEMENTS.has(e) ? `[]${e}` : 'any';
  }
  if (t.base === 'money') return orNull('string');
  if (t.logical === 'time') return /tz$|with time zone/.test(t.base) ? orNull('string') : 'pgtype.Time';
  if (t.logical === 'interval') {
    if (!native) return 'pgtype.Interval';
    return nullable ? (sqlNull ? 'pgtype.Interval' : '*time.Duration') : 'time.Duration';
  }
  if (t.logical === 'decimal' && native && o.goDecimal !== 'string') return 'pgtype.Numeric';
  if (t.go === 'net.HardwareAddr') return native ? 'net.HardwareAddr' : orNull('string');
  if (t.go === 'netip.Prefix') {
    if (sqlx(o)) return orNull('string');
    return native && nullable ? '*netip.Prefix' : 'netip.Prefix';
  }
  if (t.logical === 'object') return native ? (PGTYPE_OBJECT[t.base] ?? 'any') : 'any';
  if (t.logical === 'guid' && native && nullable && sqlNull) return 'pgtype.UUID';
  const b = baseGoType(t, o);
  // pgx decodes NULL json into a nil RawMessage; database/sql cannot Scan NULL into a json.RawMessage (only a pointer / sql.Null).
  if (!nullable || b === '[]byte' || b === 'any' || (b === 'json.RawMessage' && native)) return b;
  if (b === 'time.Time' && native && sqlNull) return PGTYPE_TIME[t.logical] ?? 'pgtype.Timestamptz';
  return orNull(b);
}

/** Imports named by a Go type expression. */
function typeImports(type: string, ctx: Ctx) {
  if (/\btime\./.test(type)) ctx.imports.add('time');
  if (/\bsql\./.test(type)) ctx.imports.add('database/sql');
  if (/\bpgtype\./.test(type)) ctx.imports.add('github.com/jackc/pgx/v5/pgtype');
  if (/\bjson\./.test(type)) ctx.imports.add('encoding/json');
  if (/\bnetip\./.test(type)) ctx.imports.add('net/netip');
  if (/\bnet\./.test(type)) ctx.imports.add('net');
}

/** database/sql + pgx/v5/stdlib: destinations that need pgtype.Map.SQLScanner (stdlib returns these as text). */
function needsPgScanner(type: string, ctx: Ctx): boolean {
  return ctx.d === 'pgsql' && ctx.o.flavor === 'database-sql' && (/^\[\](?!byte$)/.test(type) || type === 'netip.Prefix');
}

/** A Go string destination (`string`, `*string`, `sql.NullString`, `pgtype.Text`), i.e. the value's text form. */
const TEXT_FORM = /^(\*?string|sql\.NullString|pgtype\.Text)$/;

/** Field comment for PostgreSQL specifics (enum labels, text forms). */
function pgFieldNote(m: Member, type: string, ctx: Ctx): string {
  if (ctx.d !== 'pgsql') return '';
  const t = m.type;
  if (t.enumLabels?.length) return `enum ${m.col.dbType}: ${t.enumLabels.join(', ')}`;
  if (t.array && t.element?.enumLabels?.length && !sqlx(ctx.o)) {
    const el = m.col.dbType.replace(/\[\]$/, '');
    return pgxFlavor(ctx.o)
      ? `enum array: register ${el} and _${el} (Conn.LoadType + TypeMap().RegisterType, e.g. in pgxpool AfterConnect)`
      : `enum array ${m.col.dbType}: register the type (Conn.LoadType) before writing it`;
  }
  if (TEXT_FORM.test(type) && (t.array || t.go === 'netip.Prefix' || t.go === 'net.HardwareAddr')) return `${m.col.dbType} in PostgreSQL text form`;
  if (type === 'netip.Prefix' && m.nullable) return 'NULL scans as the zero Prefix';
  if (t.base === 'money') return 'money as text (lc_monetary format)';
  if (TEXT_FORM.test(type) && t.logical === 'time') return 'timetz as text';
  return '';
}

/** Placeholders per driver: go-mssqldb `@p1`, godror `:1`, go-sqlite3 `?`, pgx `$1`; sqlx rebinds `?` (not on PostgreSQL). */
function placeholder(ctx: Ctx): Placeholder {
  // PostgreSQL: $n for every flavor (sqlx passes it through; Rebind would also rewrite a ? inside literals / jsonb operators).
  if (ctx.d === 'pgsql') return PH.dollar;
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
  // The sentence gets its own period, so a trailing one in the comment is dropped (only a period).
  const docText = doc.replace(/\.$/, '');
  w.line(`// ${typeName} is a row of ${label ?? 'the query'}${docText ? `: ${docText}.` : '.'}`);
  structBlock(
    w,
    typeName,
    members.map((m) => {
      const tags = [`db:"${m.col.name}"`];
      if (ctx.o.goJsonTags) tags.push(`json:"${camel(m.col.name)}${m.nullable ? ',omitempty' : ''}"`);
      const type = goType(m.type, m.nullable, ctx);
      const c = [m.type.known ? '' : `TODO: unmapped type ${m.col.dbType}`, pgFieldNote(m, type, ctx), commentText(m.col.comment)].filter(Boolean).join('; ');
      return { name: m.name, type, tag: `\`${tags.join(' ')}\``, comment: c };
    }),
  );
}

function scanArgs(members: Member[], v: string, ctx?: Ctx): string {
  return members.map((m) => (ctx && needsPgScanner(goType(m.type, m.nullable, ctx), ctx) ? `pgMap.SQLScanner(&${v}.${m.name})` : `&${v}.${m.name}`)).join(', ');
}

/** database/sql on PostgreSQL: declare the pgtype.Map used by SQLScanner when a member needs it. */
function pgMapDecl(w: Writer, members: Member[], ctx: Ctx) {
  if (!members.some((m) => needsPgScanner(goType(m.type, m.nullable, ctx), ctx))) return;
  ctx.imports.add('github.com/jackc/pgx/v5/pgtype');
  w.line('pgMap := pgtype.NewMap()');
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
  const native = d === 'pgsql' && pgxFlavor(o);
  const scope = new NameScope(['ctx', 's', 'err', 'rows', 'res', v, 'n', 'items', ...(d === 'pgsql' ? ['pgMap'] : [])]);
  const keyArgs = pk.map((m) => ({ m, local: scope.take(goCamel(m.col.name)) }));
  const keySig = keyArgs.map((k) => `${k.local} ${goType(k.m.type, false, ctx)}`).join(', ');
  const keyVals = keyArgs.map((k) => k.local).join(', ');
  const base = goCamel(typeName);
  const q = (name: string) => (sqlx(o) && d !== 'pgsql' ? `s.db.Rebind(${name})` : name);
  const dbType = sqlx(o) ? 'sqlx.ExtContext' : 'DBTX';
  if (sqlx(o)) ctx.imports.add('github.com/jmoiron/sqlx');
  else ctx.shared.add(native ? 'pgxDbtx' : 'dbtx');
  if (native) ctx.imports.add('github.com/jackc/pgx/v5');
  const noRows = native ? 'pgx.ErrNoRows' : 'sql.ErrNoRows';

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
  const runsOn = native ? '*pgxpool.Pool, *pgx.Conn or pgx.Tx' : sqlx(o) ? '*sqlx.DB or *sqlx.Tx' : '*sql.DB, *sql.Conn or *sql.Tx';
  w.line(`// New${storeName} returns ${/^[AEIOU]/.test(storeName) ? 'an' : 'a'} ${storeName} that runs on db (${runsOn}).`);
  w.line(`func New${storeName}(db ${dbType}) *${storeName} {`);
  w.indent().line(`return &${storeName}{db: db}`).dedent();
  w.line('}');

  if (crud.selectByPk) {
    w.blank();
    w.line(`// Get returns the row with the given key, or ${noRows}.`);
    w.line(`func (s *${storeName}) Get(ctx context.Context, ${keySig}) (*${typeName}, error) {`);
    w.indent();
    if (native) {
      w.line(`rows, err := s.db.Query(ctx, ${base}GetSQL, ${keyVals})`);
      w.line('if err != nil {');
      w.indent().line('return nil, err').dedent();
      w.line('}');
      w.line(`return pgx.CollectOneRow(rows, pgx.RowToAddrOfStructByName[${typeName}])`);
    } else {
      w.line(`var ${v} ${typeName}`);
      if (sqlx(o)) {
        w.line(`if err := sqlx.GetContext(ctx, s.db, &${v}, ${q(`${base}GetSQL`)}, ${keyVals}); err != nil {`);
      } else {
        pgMapDecl(w, members, ctx);
        w.line(`if err := s.db.QueryRowContext(ctx, ${base}GetSQL, ${keyVals}).Scan(${scanArgs(members, v, ctx)}); err != nil {`);
      }
      w.indent().line('return nil, err').dedent();
      w.line('}');
      w.line(`return &${v}, nil`);
    }
    w.dedent();
    w.line('}');
  }

  w.blank();
  w.line('// List returns every row.');
  w.line(`func (s *${storeName}) List(ctx context.Context) ([]${typeName}, error) {`);
  w.indent();
  if (native) {
    w.line(`rows, err := s.db.Query(ctx, ${base}SelectSQL)`);
    w.line('if err != nil {');
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line(`return pgx.CollectRows(rows, pgx.RowToStructByName[${typeName}])`);
  } else if (sqlx(o)) {
    w.line(`var items []${typeName}`);
    w.line(`err := sqlx.SelectContext(ctx, s.db, &items, ${q(`${base}SelectSQL`)})`);
    w.line('return items, err');
  } else {
    w.line(`rows, err := s.db.QueryContext(ctx, ${base}SelectSQL)`);
    w.line('if err != nil {');
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line('defer rows.Close()');
    pgMapDecl(w, members, ctx);
    w.line(`var items []${typeName}`);
    w.line('for rows.Next() {');
    w.indent();
    w.line(`var ${v} ${typeName}`);
    w.line(`if err := rows.Scan(${scanArgs(members, v, ctx)}); err != nil {`);
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
      const queryRow = native ? 'QueryRow' : sqlx(o) ? 'QueryRowxContext' : 'QueryRowContext';
      w.line(`err := s.db.${queryRow}(ctx, ${q(`${base}InsertSQL`)}, ${args.join(', ')}).Scan(&id)`);
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
      w.line(`_, err := s.db.${native ? 'Exec' : 'ExecContext'}(ctx, ${q(`${base}InsertSQL`)}${args.length ? ', ' + args.join(', ') : ''})`);
      w.line('return err');
    }
    w.dedent();
    w.line('}');
  }
  const affectedOne = (sqlName: string, args: string[]) => {
    ctx.shared.add(native ? 'pgxAffectedOne' : 'execAffectedOne');
    w.line(`return execAffectedOne(s.db.${native ? 'Exec' : 'ExecContext'}(ctx, ${q(sqlName)}, ${args.join(', ')}))`);
  };
  if (crud.update) {
    w.blank();
    w.line(`// Update writes every non-key column; it returns ${noRows} when no row has the key.`);
    w.line(`func (s *${storeName}) Update(ctx context.Context, ${v} *${typeName}) error {`);
    w.indent();
    affectedOne(`${base}UpdateSQL`, crud.update.params.map((c) => `${v}.${byCol.get(c)!.name}`));
    w.dedent();
    w.line('}');
  }
  if (crud.delete) {
    w.blank();
    w.line(`// Delete removes the row with the given key; it returns ${noRows} when there is none.`);
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

// ---------------- PostgreSQL routines ----------------

/** Parameters pgNamedParams named `argN` (unnamed in the database: they can only be passed by position). */
const UNNAMED = new WeakSet<CgParam>();

/** PostgreSQL arguments may be unnamed: they get `arg1`, `arg2`, ... (Go names only; the SQL binds by position). */
function pgNamedParams(r: CgRoutine): CgRoutine {
  if (r.params.every((p) => p.direction === 'return' || p.name)) return r;
  let n = 0;
  return {
    ...r,
    params: r.params.map((p) => {
      if (p.direction === 'return' || p.name) return p;
      const named = { ...p, name: `arg${++n}` };
      UNNAMED.add(named);
      return named;
    }),
  };
}

export interface PgOverload {
  index: number;
  count: number;
  /** Signature of another overload whose defaults make it match the same call (PostgreSQL rejects it as ambiguous). */
  ambiguousWith: string | null;
}

const pgInArgs = (r: CgRoutine) => callParams(r).filter((p) => p.direction === 'in' || p.direction === 'inout');

/** Overload info for PostgreSQL routines sharing schema + name; null for routines that are not overloaded. */
function pgOverloads(objects: CgInput['objects']): Map<CgRoutine, PgOverload> {
  const groups = new Map<string, CgRoutine[]>();
  for (const x of objects) {
    if (!isRoutine(x)) continue;
    const k = `${x.schema ?? ''}.${x.name}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const out = new Map<CgRoutine, PgOverload>();
  const norm = (t: string) => t.trim().toLowerCase();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.forEach((r, i) => {
      const mine = pgInArgs(r);
      // foo(a) and foo(a, b DEFAULT x) both match foo($1): "function is not unique".
      const other = list.find((b) => {
        const theirs = pgInArgs(b);
        return b !== r && theirs.length > mine.length && mine.every((p, j) => norm(p.dbType) === norm(theirs[j].dbType)) && theirs.slice(mine.length).every((p) => p.hasDefault);
      });
      const sig = other ? `${objectLabel(other)}(${pgInArgs(other).map((p) => `${p.dbType}${p.hasDefault ? ' DEFAULT' : ''}`).join(', ')})` : null;
      out.set(r, { index: i + 1, count: list.length, ambiguousWith: sig });
    });
  }
  return out;
}

/** Go types that already hold nil (SQL NULL / "not passed") without a pointer. */
const nilable = (t: string) => /^(\[\]|map\[|\*)/.test(t) || t === 'any' || t === 'json.RawMessage' || t === 'net.HardwareAddr';

interface PgArg extends Arg {
  /** Has a server default: nil leaves it out of the call (named notation from the first such argument on). */
  optional: boolean;
  /** The Go parameter is `*T` only to say "not passed": dereference it for the driver. */
  deref: boolean;
}

/**
 * PostgreSQL routine wrapper: `SELECT s.f($1)` (scalar function), `SELECT cols FROM s.f($1)` (table function, rows into a
 * struct), `CALL s.p($1, $2)` (procedure; OUT arguments are passed as NULL and OUT / INOUT values come back as one row).
 * Arguments with a server default are optional (`*T`, nil = left out, named notation `name => $n` from there on) unless
 * the routine is overloaded; overloads get `::type` casts so the server resolves the right one.
 */
function pgRoutineFn(w: Writer, r: CgRoutine, ctx: Ctx, fn: string, overload: PgOverload | null) {
  const { d, o } = ctx;
  const native = pgxFlavor(o);
  ctx.imports.add('context');
  if (sqlx(o)) ctx.imports.add('github.com/jmoiron/sqlx');
  else ctx.shared.add(native ? 'pgxDbtx' : 'dbtx');
  const dbType = sqlx(o) ? 'sqlx.ExtContext' : 'DBTX';
  const scope = new NameScope(['ctx', 'db', 'err', 'rows', 'out', 'value', 'items', 'r', 'pgMap', 'args', 'list', 'call', 'fmt', 'strings']);
  const params = callParams(r);
  // Functions take their IN / INOUT arguments; a procedure's CALL lists OUT arguments too (as NULL, PostgreSQL 14+).
  const callList = r.kind === 'proc' ? params : params.filter((p) => p.direction !== 'out');
  // Defaults are left to the server only when every argument from the first defaulted one on can be named, and never
  // for overloads (leaving one out could match another overload).
  const firstDefault = callList.findIndex((p) => p.direction !== 'out' && p.hasDefault);
  const canOmit = !overload && firstDefault >= 0 && callList.slice(firstDefault).every((p) => !UNNAMED.has(p));
  const args: PgArg[] = params
    .filter((p) => p.direction === 'in' || p.direction === 'inout')
    .map((p) => {
      const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
      const base = goType(rt, false, ctx);
      const optional = canOmit && p.hasDefault;
      const deref = optional && !nilable(base);
      return { p, rt, local: scope.take(goCamel(friendlyParam(bindNameOf(p)))), type: deref ? `*${base}` : base, optional, deref };
    });
  const outs = params.filter((p) => p.direction === 'out' || p.direction === 'inout');
  const ret = returnParam(r);
  const sqlName = routineSqlName(r, d, qi);
  const sig = args.map((a) => `${a.local} ${a.type}`).join(', ');
  const head = `ctx context.Context, db ${dbType}${sig ? ', ' + sig : ''}`;
  const doc = (what: string) => {
    const sigText = args.map((a) => `${bindNameOf(a.p)} ${a.p.dbType}`).join(', ') || 'no arguments';
    w.line(`// ${fn} ${what}${overload ? ` (overload ${overload.index} of ${overload.count}: ${sigText})` : ''}.`);
    if (overload?.ambiguousWith) w.line(`// PostgreSQL reports this call as ambiguous while ${overload.ambiguousWith} exists; drop or rename one of them.`);
    const kept = overload ? args.filter((a) => a.p.hasDefault).map((a) => a.local) : [];
    if (kept.length) w.line(`// ${kept.join(', ')} ${kept.length > 1 ? 'have server defaults but are' : 'has a server default but is'} always passed: leaving ${kept.length > 1 ? 'them' : 'it'} out could match another overload.`);
    const opt = args.filter((a) => a.optional).map((a) => a.local);
    if (opt.length) w.line(`// ${opt.join(', ')} ${opt.length > 1 ? 'are' : 'is'} optional: nil leaves ${opt.length > 1 ? 'them' : 'it'} out of the call, so the server default applies.`);
  };
  const errCheck = (retLine: string) => {
    w.line('if err != nil {');
    w.indent().line(retLine).dedent();
    w.line('}');
  };

  /**
   * Emits the call text: a string literal when every argument is passed, else Go code that builds it (`call`, `args`).
   * Returns the query expression and the trailing argument list.
   */
  const emitCall = (prefix: string): { sql: string; argList: string } => {
    let n = 0;
    const cast = (p: CgParam) => (overload ? `::${p.dbType}` : '');
    const positional = (p: CgParam) => (p.direction === 'out' ? 'NULL' : `$${++n}`) + cast(p);
    const argOf = (p: CgParam) => args.find((a) => a.p === p)!;
    if (!canOmit) {
      return { sql: JSON.stringify(`${prefix}(${callList.map(positional).join(', ')})`), argList: args.length ? ', ' + args.map((a) => a.local).join(', ') : '' };
    }
    ctx.imports.add('fmt');
    ctx.imports.add('strings');
    const lead = callList.slice(0, firstDefault);
    w.line(`args := []any{${lead.filter((p) => p.direction !== 'out').map((p) => argOf(p).local).join(', ')}}`);
    w.line(`list := []string{${lead.map((p) => JSON.stringify(positional(p))).join(', ')}}`);
    for (const p of callList.slice(firstDefault)) {
      const name = qi(bindNameOf(p), d);
      if (p.direction === 'out') {
        w.line(`list = append(list, ${JSON.stringify(`${name} => NULL`)})`);
        continue;
      }
      const a = argOf(p);
      const add = () => {
        w.line(`args = append(args, ${a.deref ? '*' : ''}${a.local})`);
        w.line(`list = append(list, fmt.Sprintf(${JSON.stringify(`${name} => $%d`)}, len(args)))`);
      };
      if (!a.optional) {
        add();
        continue;
      }
      w.line(`if ${a.local} != nil {`);
      w.indent();
      add();
      w.dedent();
      w.line('}');
    }
    w.line(`call := ${JSON.stringify(`${prefix}(`)} + strings.Join(list, ", ") + ")"`);
    return { sql: 'call', argList: ', args...' };
  };
  const query = native ? 'Query' : 'QueryContext';
  const queryRow = native ? 'QueryRow' : sqlx(o) ? 'QueryRowxContext' : 'QueryRowContext';
  const exec = native ? 'Exec' : 'ExecContext';

  // Table function (RETURNS TABLE / SETOF composite with known columns): a row struct and a slice.
  const tableCols = r.kind === 'func' && r.resultColumns?.length ? r.resultColumns : null;
  if (tableCols) {
    const rowType = goPascal(withSuffix(fn, 'row'));
    const members = membersOf(tableCols, d, o, rowType);
    modelStruct(w, rowType, members, objectLabel(r), null, ctx);
    w.blank();
    doc(`returns the rows of ${objectLabel(r)}`);
    w.line(`func ${fn}(${head}) ([]${rowType}, error) {`);
    w.indent();
    const c = emitCall(`SELECT ${tableCols.map((x) => qi(x.name, d)).join(', ')} FROM ${sqlName}`);
    if (native) {
      ctx.imports.add('github.com/jackc/pgx/v5');
      w.line(`rows, err := db.Query(ctx, ${c.sql}${c.argList})`);
      errCheck('return nil, err');
      w.line(`return pgx.CollectRows(rows, pgx.RowToStructByName[${rowType}])`);
    } else if (sqlx(o)) {
      w.line(`var items []${rowType}`);
      w.line(`err := sqlx.SelectContext(ctx, db, &items, ${c.sql}${c.argList})`);
      w.line('return items, err');
    } else {
      w.line(`rows, err := db.QueryContext(ctx, ${c.sql}${c.argList})`);
      errCheck('return nil, err');
      w.line('defer rows.Close()');
      pgMapDecl(w, members, ctx);
      w.line(`var items []${rowType}`);
      w.line('for rows.Next() {');
      w.indent();
      w.line(`var r ${rowType}`);
      w.line(`if err := rows.Scan(${scanArgs(members, 'r', ctx)}); err != nil {`);
      w.indent().line('return nil, err').dedent();
      w.line('}');
      w.line('items = append(items, r)');
      w.dedent();
      w.line('}');
      w.line('return items, rows.Err()');
    }
    w.dedent();
    w.line('}');
    return;
  }

  // Scalar function (or SETOF scalar / SETOF record); functions with OUT parameters return a row (below).
  if (r.kind === 'func' && !outs.length && ret && !/^void$/i.test(ret.dbType.trim())) {
    const setof = /^\s*setof\s+(.+)$/i.exec(ret.dbType);
    const rt = resolveType(d, setof ? setof[1] : ret.dbType, { numberOneAsBool: o.numberOneAsBool });
    if (setof) {
      const record = rt.logical === 'object' && !rt.array;
      const el = record ? 'map[string]any' : goType(rt, true, ctx);
      doc(`returns the rows of ${objectLabel(r)}`);
      w.line(`func ${fn}(${head}) ([]${el}, error) {`);
      w.indent();
      const c = emitCall(`SELECT * FROM ${sqlName}`);
      w.line(`rows, err := db.${query}(ctx, ${c.sql}${c.argList})`);
      errCheck('return nil, err');
      if (native) {
        ctx.imports.add('github.com/jackc/pgx/v5');
        w.line(`return pgx.CollectRows(rows, ${record ? 'pgx.RowToMap' : `pgx.RowTo[${el}]`})`);
      } else if (record) {
        ctx.shared.add('scanMaps');
        w.line(`return scanMaps(rows)`);
      } else {
        w.line('defer rows.Close()');
        const dest = needsPgScanner(el, ctx) ? 'pgMap.SQLScanner(&value)' : '&value';
        if (dest !== '&value') {
          ctx.imports.add('github.com/jackc/pgx/v5/pgtype');
          w.line('pgMap := pgtype.NewMap()');
        }
        w.line(`var items []${el}`);
        w.line('for rows.Next() {');
        w.indent();
        w.line(`var value ${el}`);
        w.line(`if err := rows.Scan(${dest}); err != nil {`);
        w.indent().line('return nil, err').dedent();
        w.line('}');
        w.line('items = append(items, value)');
        w.dedent();
        w.line('}');
        w.line('return items, rows.Err()');
      }
      w.dedent();
      w.line('}');
      return;
    }
    const t = goType(rt, true, ctx);
    doc(`calls ${objectLabel(r)}`);
    w.line(`func ${fn}(${head}) (${t}, error) {`);
    w.indent();
    const c = emitCall(`SELECT ${sqlName}`);
    w.line(`var value ${t}`);
    const dest = needsPgScanner(t, ctx) ? 'pgMap.SQLScanner(&value)' : '&value';
    if (dest !== '&value') {
      ctx.imports.add('github.com/jackc/pgx/v5/pgtype');
      w.line('pgMap := pgtype.NewMap()');
    }
    w.line(`err := db.${queryRow}(ctx, ${c.sql}${c.argList}).Scan(${dest})`);
    w.line('return value, err');
    w.dedent();
    w.line('}');
    return;
  }

  // Procedure (CALL) or a function with OUT parameters (SELECT * FROM): OUT / INOUT values come back as one row.
  const prefix = r.kind === 'proc' ? `CALL ${sqlName}` : outs.length ? `SELECT * FROM ${sqlName}` : `SELECT ${sqlName}`;
  if (!outs.length) {
    doc(`calls ${objectLabel(r)}`);
    w.line(`func ${fn}(${head}) error {`);
    w.indent();
    const c = emitCall(prefix);
    w.line(`_, err := db.${exec}(ctx, ${c.sql}${c.argList})`);
    w.line('return err');
    w.dedent();
    w.line('}');
    return;
  }
  const resultName = goPascal(`${fn}_result`);
  const fieldScope = new NameScope([]);
  const fields = outs.map((p) => {
    const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
    return { p, name: fieldScope.take(goPascal(friendlyParam(bindNameOf(p)))), type: goType(rt, true, ctx), tag: '', comment: '' };
  });
  w.line(`// ${resultName} holds the OUT / INOUT values of ${objectLabel(r)}.`);
  structBlock(w, resultName, fields);
  w.blank();
  doc(`calls ${objectLabel(r)}; the OUT / INOUT values come back as a row`);
  w.line(`func ${fn}(${head}) (${resultName}, error) {`);
  w.indent();
  const c = emitCall(prefix);
  w.line(`var out ${resultName}`);
  const dests = fields.map((f) => (needsPgScanner(f.type, ctx) ? `pgMap.SQLScanner(&out.${f.name})` : `&out.${f.name}`));
  if (dests.some((x) => x.startsWith('pgMap'))) {
    ctx.imports.add('github.com/jackc/pgx/v5/pgtype');
    w.line('pgMap := pgtype.NewMap()');
  }
  w.line(`err := db.${queryRow}(ctx, ${c.sql}${c.argList}).Scan(${dests.join(', ')})`);
  w.line('return out, err');
  w.dedent();
  w.line('}');
}

// ---------------- queries ----------------

function queryFn(w: Writer, q: CgQuery, ctx: Ctx) {
  const { d, o } = ctx;
  ctx.imports.add('context');
  const rowType = goPascal(withSuffix(q.name, 'row'));
  const members = membersOf(q.columns, d, o, rowType);
  modelStruct(w, rowType, members, null, null, ctx);
  w.blank();
  const fn = goPascal(queryFnBase(q.name));
  const constName = `${goCamel(q.name)}SQL`;
  const sqlText = trimStatement(q.sql);
  const positional = q.params.some((p) => p.positional);
  const pg = d === 'pgsql';
  const native = pg && pgxFlavor(o);
  // PostgreSQL: `$n` bound by position (every flavor); sqlx: `?` + Rebind; database/sql: keep the dialect's own syntax and bind by name.
  const text = rewriteQuery(sqlText, d, pg ? 'dollar' : sqlx(o) ? 'q' : 'keep');
  w.line(`const ${constName} = ${rawString(text.sql)}`);
  w.blank();
  const scope = new NameScope(['ctx', 'db', 'err', 'rows', 'items', 'r', ...(pg ? ['pgMap'] : [])]);
  const args = q.params.map((p) => ({ p, local: scope.take(goCamel(p.name)), type: queryParamGoType(p.type, ctx) }));
  const dbType = sqlx(o) ? 'sqlx.ExtContext' : 'DBTX';
  if (sqlx(o)) ctx.imports.add('github.com/jmoiron/sqlx');
  else ctx.shared.add(native ? 'pgxDbtx' : 'dbtx');
  const callArgs = sqlx(o) || positional || pg
    ? (sqlx(o) || pg ? text.order.map((n) => args.find((a) => a.p.name === n)!.local) : args.map((a) => a.local))
    : args.map((a) => `sql.Named(${JSON.stringify(a.p.name)}, ${a.local})`);
  if (!sqlx(o) && !positional && !pg && args.length) ctx.imports.add('database/sql');
  w.line(`// ${fn} runs the ${q.name} query.`);
  w.line(`func ${fn}(ctx context.Context, db ${dbType}${args.length ? ', ' + args.map((a) => `${a.local} ${a.type}`).join(', ') : ''}) ([]${rowType}, error) {`);
  w.indent();
  if (sqlx(o)) {
    w.line(`var items []${rowType}`);
    w.line(`err := sqlx.SelectContext(ctx, db, &items, ${pg ? constName : `db.Rebind(${constName})`}${callArgs.length ? ', ' + callArgs.join(', ') : ''})`);
    w.line('return items, err');
  } else if (native) {
    ctx.imports.add('github.com/jackc/pgx/v5');
    w.line(`rows, err := db.Query(ctx, ${constName}${callArgs.length ? ', ' + callArgs.join(', ') : ''})`);
    w.line('if err != nil {');
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line(`return pgx.CollectRows(rows, pgx.RowToStructByName[${rowType}])`);
  } else {
    w.line(`rows, err := db.QueryContext(ctx, ${constName}${callArgs.length ? ', ' + callArgs.join(', ') : ''})`);
    w.line('if err != nil {');
    w.indent().line('return nil, err').dedent();
    w.line('}');
    w.line('defer rows.Close()');
    pgMapDecl(w, members, ctx);
    w.line(`var items []${rowType}`);
    w.line('for rows.Next() {');
    w.indent();
    w.line(`var r ${rowType}`);
    w.line(`if err := rows.Scan(${scanArgs(members, 'r', ctx)}); err != nil {`);
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

const PG_STDLIB = 'github.com/jackc/pgx/v5/stdlib';

function sharedDecls(kinds: Set<string>, imports: Set<string>): string {
  const w = new Writer('\t');
  if (kinds.has('pgStdlib')) {
    imports.add(PG_STDLIB);
    w.line(`// DriverName is the database/sql driver registered by the ${PG_STDLIB} import:`);
    w.line(`// open the database with ${kinds.has('dbtx') ? 'sql' : 'sqlx'}.Open(DriverName, dsn). The SQL uses PostgreSQL $n placeholders.`);
    w.line('const DriverName = "pgx"');
    if (kinds.has('dbtx')) w.blank();
  }
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
  if (kinds.has('pgxDbtx')) {
    imports.add('context');
    imports.add('github.com/jackc/pgx/v5');
    imports.add('github.com/jackc/pgx/v5/pgconn');
    imports.add('github.com/jackc/pgx/v5/pgxpool');
    w.line('// DBTX is satisfied by *pgxpool.Pool, *pgx.Conn and pgx.Tx.');
    w.line('type DBTX interface {');
    w.indent();
    w.line('Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error)');
    w.line('Query(ctx context.Context, query string, args ...any) (pgx.Rows, error)');
    w.line('QueryRow(ctx context.Context, query string, args ...any) pgx.Row');
    w.dedent();
    w.line('}');
    w.blank();
    w.line('var _ DBTX = (*pgxpool.Pool)(nil)');
  }
  if (kinds.has('pgxAffectedOne')) {
    imports.add('github.com/jackc/pgx/v5');
    imports.add('github.com/jackc/pgx/v5/pgconn');
    w.blank();
    w.line('// execAffectedOne turns "0 rows affected" into pgx.ErrNoRows.');
    w.line('func execAffectedOne(tag pgconn.CommandTag, err error) error {');
    w.indent();
    w.line('if err != nil {');
    w.indent().line('return err').dedent();
    w.line('}');
    w.line('if tag.RowsAffected() == 0 {');
    w.indent().line('return pgx.ErrNoRows').dedent();
    w.line('}');
    w.line('return nil');
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
  const pgOv = d === 'pgsql' ? pgOverloads(input.objects) : null;
  const unitFor = (name: string, label: string, kind: Unit['kind'], fn: (w: Writer, ctx: Ctx) => void) => {
    const ctx: Ctx = { d, o, imports: new Set(), shared: new Set() };
    const w = new Writer('\t');
    fn(w, ctx);
    // database/sql and sqlx on PostgreSQL run on jackc/pgx/v5/stdlib (driver name "pgx").
    if (d === 'pgsql' && !pgxFlavor(o) && (ctx.shared.has('dbtx') || ctx.imports.has('github.com/jmoiron/sqlx'))) ctx.shared.add('pgStdlib');
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
    } else if (isRoutine(obj) && o.include.procedures && d === 'pgsql') {
      // Overloads share a name in PostgreSQL; Go has no overloading, so the 2nd, 3rd, ... get a number.
      const overload = pgOv?.get(obj) ?? null;
      const index = overload?.index ?? 1;
      const base = index > 1 ? `${obj.name}_${index}` : obj.name;
      unitFor(snakeFile(`${obj.schema ?? ''}_${base}`), objectLabel(obj), 'routine', (w, ctx) => pgRoutineFn(w, pgNamedParams(obj), ctx, goPascal(base), overload));
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
  const fmt = (i: string) => (i === 'github.com/microsoft/go-mssqldb' ? `mssql "${i}"` : i === PG_STDLIB ? `_ "${i}"` : `"${i}"`);
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
  const header = (labels: string[]) => `// Code generated by Rowlit from ${DIALECT_LABEL[input.dialect]}: ${labels.join(', ')}. Review before use.`;
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


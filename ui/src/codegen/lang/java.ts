// Java generator: JDBC (records + DAO with PreparedStatement / CallableStatement) and JPA (@Entity) flavors.
// One public top-level type per file, as Java requires.
import type { Dialect } from '../../api/types';
import type { CgInput, CgPackage, CgParam, CgQuery, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import { camel, NameScope, pascal } from '../naming';
import type { CodegenOptions } from '../options';
import {
  bindNameOf, DIALECT_LABEL, friendlyParam, localName, membersOf, objectLabel, pkMembers, proceduresClassName, routineSqlName, typeNameOf,
  type Member,
} from '../shape';
import { crudSql, PH, qi, rewriteQuery, trimStatement } from '../sqlgen';
import { resolveType, type ResolvedType } from '../types';
import { commentText, dq, Writer } from '../writer';

interface Ctx {
  d: Dialect;
  o: CodegenOptions;
  imports: Set<string>;
}

const PRIMITIVE_BOX: Record<string, string> = { int: 'Integer', long: 'Long', short: 'Short', boolean: 'Boolean', double: 'Double', float: 'Float', byte: 'Byte' };

const IMPORT_OF: Record<string, string> = {
  BigDecimal: 'java.math.BigDecimal', LocalDate: 'java.time.LocalDate', LocalDateTime: 'java.time.LocalDateTime', OffsetDateTime: 'java.time.OffsetDateTime',
  LocalTime: 'java.time.LocalTime', Duration: 'java.time.Duration', UUID: 'java.util.UUID',
};

function javaType(t: ResolvedType, nullable: boolean, ctx: Ctx): string {
  const b = t.java;
  if (IMPORT_OF[b]) ctx.imports.add(IMPORT_OF[b]);
  return nullable && PRIMITIVE_BOX[b] ? PRIMITIVE_BOX[b] : b;
}

const SQL_TYPES: Record<string, string> = {
  bool: 'BOOLEAN', uint8: 'SMALLINT', int16: 'SMALLINT', int32: 'INTEGER', int64: 'BIGINT', decimal: 'DECIMAL', float32: 'REAL', float64: 'DOUBLE',
  string: 'VARCHAR', date: 'DATE', datetime: 'TIMESTAMP', datetimeoffset: 'TIMESTAMP_WITH_TIMEZONE', time: 'TIME', interval: 'OTHER', guid: 'VARCHAR',
  binary: 'VARBINARY', rowversion: 'VARBINARY', xml: 'VARCHAR', json: 'VARCHAR', object: 'OTHER', cursor: 'REF_CURSOR',
};

function sqlType(t: ResolvedType): string {
  return `Types.${SQL_TYPES[t.logical] ?? 'OTHER'}`;
}

/** ResultSet getter for a column (by label). */
function getter(t: ResolvedType, nullable: boolean, label: string, ctx: Ctx, rs = 'rs'): string {
  const b = t.java;
  const l = dq(label);
  if (ctx.d === 'sqlite' && (b === 'LocalDate' || b === 'LocalDateTime')) {
    // sqlite-jdbc stores dates as text; parse ISO-8601 (with a space or T separator).
    const parse = b === 'LocalDate' ? 'LocalDate.parse' : 'LocalDateTime.parse';
    const expr = b === 'LocalDate' ? `${parse}(s)` : `${parse}(s.replace(' ', 'T'))`;
    ctx.imports.add('java.util.Optional');
    return `Optional.ofNullable(${rs}.getString(${l})).map(s -> ${expr}).orElse(null)`;
  }
  if (b === 'UUID') {
    ctx.imports.add('java.util.Optional');
    return `Optional.ofNullable(${rs}.getString(${l})).map(UUID::fromString).orElse(null)`;
  }
  if (PRIMITIVE_BOX[b]) {
    if (nullable) return `${rs}.getObject(${l}, ${PRIMITIVE_BOX[b]}.class)`;
    const m: Record<string, string> = { int: 'getInt', long: 'getLong', short: 'getShort', boolean: 'getBoolean', double: 'getDouble', float: 'getFloat', byte: 'getByte' };
    return `${rs}.${m[b]}(${l})`;
  }
  switch (b) {
    case 'String':
      return `${rs}.getString(${l})`;
    case 'BigDecimal':
      return `${rs}.getBigDecimal(${l})`;
    case 'byte[]':
      return `${rs}.getBytes(${l})`;
    case 'Object':
      return `${rs}.getObject(${l})`;
    default:
      return `${rs}.getObject(${l}, ${b}.class)`;
  }
}

/** PreparedStatement setter. */
function setter(t: ResolvedType, nullable: boolean, index: string, expr: string, ps = 'ps'): string {
  const b = t.java;
  if (b === 'UUID') return `${ps}.setString(${index}, ${expr} == null ? null : ${expr}.toString())`;
  if (PRIMITIVE_BOX[b] && !nullable) {
    const m: Record<string, string> = { int: 'setInt', long: 'setLong', short: 'setShort', boolean: 'setBoolean', double: 'setDouble', float: 'setFloat', byte: 'setByte' };
    return `${ps}.${m[b]}(${index}, ${expr})`;
  }
  switch (b) {
    case 'String':
      return `${ps}.setString(${index}, ${expr})`;
    case 'BigDecimal':
      return `${ps}.setBigDecimal(${index}, ${expr})`;
    case 'byte[]':
      return `${ps}.setBytes(${index}, ${expr})`;
    default:
      return `${ps}.setObject(${index}, ${expr}, ${sqlType(t)})`;
  }
}

function textBlock(sql: string, indent = '            '): string {
  const body = sql.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""').split('\n').map((l) => indent + l).join('\n');
  return `"""\n${body}"""`;
}

function javadoc(w: Writer, text: string | null | undefined) {
  const t = commentText(text);
  if (t) w.line(`/** ${t.replace(/</g, '&lt;')} */`);
}

// ---------------- model ----------------

function recordOrClass(w: Writer, typeName: string, members: Member[], doc: string, ctx: Ctx, opts: { jpa?: CgTable } = {}) {
  const { o } = ctx;
  javadoc(w, doc);
  if (opts.jpa) {
    jpaEntity(w, typeName, members, opts.jpa, ctx);
    return;
  }
  if (o.javaRecords) {
    w.line(`public record ${typeName}(`);
    w.indent().indent();
    members.forEach((m, i) => {
      const todo = m.type.known ? '' : ` // TODO: unmapped type ${m.col.dbType}`;
      w.line(`${javaType(m.type, m.nullable, ctx)} ${m.name}${i < members.length - 1 ? ',' : ') {'}${todo}`);
    });
    w.dedent().dedent();
    w.line('}');
    return;
  }
  w.block(`public final class ${typeName} {`, () => {
    for (const m of members) {
      if (!m.type.known) w.line(`// TODO: unmapped type ${m.col.dbType}`);
      w.line(`private ${javaType(m.type, m.nullable, ctx)} ${m.name};`);
    }
    w.blank();
    w.line(`public ${typeName}() {`);
    w.line('}');
    for (const m of members) {
      const t = javaType(m.type, m.nullable, ctx);
      const cap = m.name.charAt(0).toUpperCase() + m.name.slice(1).replace(/_$/, '');
      w.blank();
      w.line(`public ${t} ${t === 'boolean' ? 'is' : 'get'}${cap}() {`);
      w.indent().line(`return ${m.name};`).dedent();
      w.line('}');
      w.blank();
      w.line(`public void set${cap}(${t} value) {`);
      w.indent().line(`this.${m.name} = value;`).dedent();
      w.line('}');
    }
  });
}

/** Accessor used by DAO code: records `e.name()`, classes `e.getName()`. */
function access(m: Member, ctx: Ctx, v = 'e'): string {
  if (ctx.o.javaRecords) return `${v}.${m.name}()`;
  const t = m.type.java;
  const cap = m.name.charAt(0).toUpperCase() + m.name.slice(1).replace(/_$/, '');
  return `${v}.${t === 'boolean' && !m.nullable ? 'is' : 'get'}${cap}()`;
}

function jpaEntity(w: Writer, typeName: string, members: Member[], t: CgTable, ctx: Ctx) {
  const { d } = ctx;
  ctx.imports.add('jakarta.persistence.*');
  w.line('@Entity');
  const schema = t.schema && !(d === 'sqlite' && t.schema === 'main') ? `, schema = ${dq(t.schema)}` : '';
  w.line(`@Table(name = ${dq(jpaQuote(t.name, d))}${schema})`);
  const pk = pkMembers(members, t.primaryKey);
  const composite = pk.length > 1;
  if (composite) w.line(`@IdClass(${typeName}.Key.class)`);
  if (t.kind === 'view') w.line('@org.hibernate.annotations.Immutable');
  w.block(`public class ${typeName} {`, () => {
    for (const m of members) {
      if (!m.type.known) w.line(`// TODO: unmapped type ${m.col.dbType}`);
      if (pk.includes(m) || (t.kind === 'view' && !pk.length && m === members[0])) w.line('@Id');
      if (m.col.identity) w.line('@GeneratedValue(strategy = GenerationType.IDENTITY)');
      const attrs = [`name = ${dq(jpaQuote(m.col.name, d))}`];
      if (!m.nullable) attrs.push('nullable = false');
      if (m.type.logical === 'string' && m.type.length) attrs.push(`length = ${m.type.length}`);
      if (m.type.logical === 'decimal' && m.type.precision) attrs.push(`precision = ${m.type.precision}`, `scale = ${m.type.scale ?? 0}`);
      if (m.col.identity || m.col.computed || m.type.logical === 'rowversion') attrs.push('insertable = false', 'updatable = false');
      if (m.type.logical === 'binary' && !m.type.length) w.line('@Lob');
      if (m.type.logical === 'rowversion') w.line('@Version');
      w.line(`@Column(${attrs.join(', ')})`);
      w.line(`private ${javaType(m.type, m.nullable || m.col.identity, ctx)} ${m.name};`);
      w.blank();
    }
    w.line(`protected ${typeName}() {`);
    w.line('}');
    for (const m of members) {
      const ty = javaType(m.type, m.nullable || m.col.identity, ctx);
      const cap = m.name.charAt(0).toUpperCase() + m.name.slice(1).replace(/_$/, '');
      w.blank();
      w.line(`public ${ty} get${cap}() {`);
      w.indent().line(`return ${m.name};`).dedent();
      w.line('}');
      if (!m.col.identity && !m.col.computed && m.type.logical !== 'rowversion') {
        w.blank();
        w.line(`public void set${cap}(${ty} value) {`);
        w.indent().line(`this.${m.name} = value;`).dedent();
        w.line('}');
      }
    }
    if (composite) {
      ctx.imports.add('java.io.Serializable');
      w.blank();
      w.line('/** Composite primary key. */');
      w.line(`public record Key(${pk.map((m) => `${javaType(m.type, true, ctx)} ${m.name}`).join(', ')}) implements Serializable {`);
      w.line('}');
    }
  });
}

/** Hibernate quotes identifiers wrapped in backticks; needed for case-sensitive or reserved names. */
function jpaQuote(name: string, d: Dialect): string {
  return qi(name, d) === name ? name : `\`${name}\``;
}

// ---------------- DAO ----------------

function dao(w: Writer, t: CgTable, typeName: string, members: Member[], ctx: Ctx) {
  const { d, o } = ctx;
  ctx.imports.add('java.sql.*');
  ctx.imports.add('java.util.ArrayList');
  ctx.imports.add('java.util.List');
  ctx.imports.add('java.util.Objects');
  ctx.imports.add('java.util.Optional');
  ctx.imports.add('javax.sql.DataSource');
  const byCol = new Map(members.map((m) => [m.col, m]));
  const crud = crudSql(t, d, { placeholder: PH.q, bindName: (c) => byCol.get(c)!.name, identityReturn: 'none', newline: '\n' });
  const pk = pkMembers(members, t.primaryKey);
  const cls = `${typeName}Dao`;
  const scope = new NameScope(['c', 'ps', 'rs', 'e', 'keys', 'dataSource']);
  const keys = pk.map((m) => ({ m, local: scope.take(localName(m.col.name, o)) }));
  const keySig = keys.map((k) => `${javaType(k.m.type, false, ctx)} ${k.local}`).join(', ');
  const identity = members.find((m) => m.col.identity);

  w.line(`/** JDBC data access for ${objectLabel(t)}. */`);
  w.block(`public final class ${cls} {`, () => {
    const constant = (name: string, sql: string) => {
      w.line(`private static final String ${name} = ${textBlock(sql)};`);
      w.blank();
    };
    constant('SELECT_SQL', crud.selectAll);
    if (crud.selectByPk) constant('SELECT_BY_KEY_SQL', crud.selectByPk.sql);
    if (crud.insert) constant('INSERT_SQL', crud.insert.sql);
    if (crud.update) constant('UPDATE_SQL', crud.update.sql);
    if (crud.delete) constant('DELETE_SQL', crud.delete.sql);
    w.line('private final DataSource dataSource;');
    w.blank();
    w.line(`public ${cls}(DataSource dataSource) {`);
    w.indent().line('this.dataSource = Objects.requireNonNull(dataSource, "dataSource");').dedent();
    w.line('}');
    w.blank();
    w.line(`/** Maps the current row (RowMapper style). */`);
    w.line(`public static ${typeName} map(ResultSet rs) throws SQLException {`);
    w.indent();
    if (o.javaRecords) {
      w.line(`return new ${typeName}(`);
      w.indent().indent();
      members.forEach((m, i) => w.line(`${getter(m.type, m.nullable, m.col.name, ctx)}${i < members.length - 1 ? ',' : ');'}`));
      w.dedent().dedent();
    } else {
      w.line(`${typeName} e = new ${typeName}();`);
      for (const m of members) {
        const cap = m.name.charAt(0).toUpperCase() + m.name.slice(1).replace(/_$/, '');
        w.line(`e.set${cap}(${getter(m.type, m.nullable, m.col.name, ctx)});`);
      }
      w.line('return e;');
    }
    w.dedent();
    w.line('}');

    const bindAll = (cols: { m: Member; expr: string }[]) => cols.forEach((c, i) => w.line(`${setter(c.m.type, c.m.nullable, String(i + 1), c.expr)};`));

    if (crud.selectByPk) {
      w.blank();
      w.line(`public Optional<${typeName}> findById(${keySig}) throws SQLException {`);
      w.indent();
      w.line('try (Connection c = dataSource.getConnection();');
      w.line('        PreparedStatement ps = c.prepareStatement(SELECT_BY_KEY_SQL)) {');
      w.indent();
      bindAll(keys.map((k) => ({ m: k.m, expr: k.local })));
      w.line('try (ResultSet rs = ps.executeQuery()) {');
      w.indent().line('return rs.next() ? Optional.of(map(rs)) : Optional.empty();').dedent();
      w.line('}');
      w.dedent();
      w.line('}');
      w.dedent();
      w.line('}');
    }
    w.blank();
    w.line(`public List<${typeName}> findAll() throws SQLException {`);
    w.indent();
    w.line('try (Connection c = dataSource.getConnection();');
    w.line('        PreparedStatement ps = c.prepareStatement(SELECT_SQL);');
    w.line('        ResultSet rs = ps.executeQuery()) {');
    w.indent();
    w.line(`List<${typeName}> list = new ArrayList<>();`);
    w.line('while (rs.next()) {');
    w.indent().line('list.add(map(rs));').dedent();
    w.line('}');
    w.line('return list;');
    w.dedent();
    w.line('}');
    w.dedent();
    w.line('}');

    if (crud.insert) {
      w.blank();
      const binds = crud.insert.params.map((c) => ({ m: byCol.get(c)!, expr: access(byCol.get(c)!, ctx) }));
      const idType = identity ? javaType(identity.type, false, ctx) : null;
      w.line(identity ? `/** Inserts a row and returns the generated ${identity.col.name}. */` : '/** Inserts a row. */');
      w.line(`public ${idType ?? 'void'} insert(${typeName} e) throws SQLException {`);
      w.indent();
      w.line('try (Connection c = dataSource.getConnection();');
      w.line(`        PreparedStatement ps = c.prepareStatement(INSERT_SQL${identity ? `, new String[] {${dq(identity.col.name)}}` : ''})) {`);
      w.indent();
      bindAll(binds);
      w.line('ps.executeUpdate();');
      if (identity) {
        w.line('try (ResultSet keys = ps.getGeneratedKeys()) {');
        w.indent();
        w.line('if (!keys.next()) {');
        w.indent().line(`throw new SQLException("No generated key returned for ${t.name}");`).dedent();
        w.line('}');
        const g: Record<string, string> = { int: 'getInt', long: 'getLong', short: 'getShort', BigDecimal: 'getBigDecimal' };
        w.line(`return keys.${g[idType!] ?? 'getLong'}(1);`);
        w.dedent();
        w.line('}');
      }
      w.dedent();
      w.line('}');
      w.dedent();
      w.line('}');
    }
    const affected = (name: string, sqlConst: string, sig: string, binds: { m: Member; expr: string }[]) => {
      w.blank();
      w.line(`public boolean ${name}(${sig}) throws SQLException {`);
      w.indent();
      w.line('try (Connection c = dataSource.getConnection();');
      w.line(`        PreparedStatement ps = c.prepareStatement(${sqlConst})) {`);
      w.indent();
      bindAll(binds);
      w.line('return ps.executeUpdate() == 1;');
      w.dedent();
      w.line('}');
      w.dedent();
      w.line('}');
    };
    if (crud.update) affected('update', 'UPDATE_SQL', `${typeName} e`, crud.update.params.map((c) => ({ m: byCol.get(c)!, expr: access(byCol.get(c)!, ctx) })));
    if (crud.delete) affected('deleteById', 'DELETE_SQL', keySig, keys.map((k) => ({ m: k.m, expr: k.local })));
  });
}

// ---------------- routines ----------------

function routines(w: Writer, list: CgRoutine[], cls: string, label: string, ctx: Ctx, prefix: (r: CgRoutine) => string) {
  const { d, o } = ctx;
  ctx.imports.add('java.sql.*');
  ctx.imports.add('java.util.Objects');
  ctx.imports.add('javax.sql.DataSource');
  w.line(`/** CallableStatement wrappers for ${label}. */`);
  w.block(`public final class ${cls} {`, () => {
    w.line('private final DataSource dataSource;');
    w.blank();
    w.line(`public ${cls}(DataSource dataSource) {`);
    w.indent().line('this.dataSource = Objects.requireNonNull(dataSource, "dataSource");').dedent();
    w.line('}');
    const usesMaps = list.some((r) => d === 'tsql' || callParams(r).some((p) => isRefCursor(p.dbType)));
    for (const r of list) {
      w.blank();
      routine(w, r, ctx, prefix(r));
    }
    if (usesMaps && list.some((r) => r.kind === 'proc')) {
      ctx.imports.add('java.util.ArrayList');
      ctx.imports.add('java.util.LinkedHashMap');
      ctx.imports.add('java.util.List');
      ctx.imports.add('java.util.Map');
      w.blank();
      w.line('private static List<Map<String, Object>> toMaps(ResultSet rs) throws SQLException {');
      w.indent();
      w.line('ResultSetMetaData md = rs.getMetaData();');
      w.line('List<Map<String, Object>> rows = new ArrayList<>();');
      w.line('while (rs.next()) {');
      w.indent();
      w.line('Map<String, Object> row = new LinkedHashMap<>();');
      w.line('for (int i = 1; i <= md.getColumnCount(); i++) {');
      w.indent().line('row.put(md.getColumnLabel(i), rs.getObject(i));').dedent();
      w.line('}');
      w.line('rows.add(row);');
      w.dedent();
      w.line('}');
      w.line('return rows;');
      w.dedent();
      w.line('}');
    }
    void o;
  });
}

function routine(w: Writer, r: CgRoutine, ctx: Ctx, prefix: string) {
  const { d, o } = ctx;
  const fn = camel(`${prefix}${r.name}`);
  const scope = new NameScope(['c', 'cs', 'rs', 'rows', 'dataSource']);
  const params = callParams(r);
  const args = params
    .filter((p) => p.direction === 'in' || p.direction === 'inout')
    .map((p) => {
      const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
      return { p, rt, local: scope.take(localName(bindNameOf(p), o)), type: javaType(rt, true, ctx) };
    });
  const ret = returnParam(r);
  const sqlName = routineSqlName(r, d, qi);
  const sig = args.map((a) => `${a.type} ${a.local}`).join(', ');
  const outs = params.filter((p) => p.direction === 'out' || p.direction === 'inout').map((p) => {
    const rt = resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
    const cursor = isRefCursor(p.dbType);
    if (cursor) ctx.imports.add('java.util.List').add('java.util.Map');
    return { p, rt, cursor, name: camel(friendlyParam(bindNameOf(p))), type: cursor ? 'List<Map<String, Object>>' : javaType(rt, true, ctx) };
  });
  const offset = ret || (d === 'tsql' && r.kind === 'proc') ? 1 : 0;
  const placeholders = params.map(() => '?').join(', ');
  const call = ret ? `{? = call ${sqlName}(${placeholders})}` : d === 'tsql' ? `{? = call ${sqlName}(${placeholders})}` : `{call ${sqlName}(${placeholders})}`;
  const bindParams = () => {
    if (offset) w.line(`cs.registerOutParameter(1, ${ret ? sqlType(resolveType(d, ret.dbType)) : 'Types.INTEGER'});`);
    params.forEach((p, i) => {
      const idx = String(i + 1 + offset);
      const a = args.find((x) => x.p === p);
      const out = outs.find((x) => x.p === p);
      if (a) w.line(`${setter(a.rt, true, idx, a.local, 'cs')};`);
      if (out) w.line(`cs.registerOutParameter(${idx}, ${out.cursor ? 'Types.REF_CURSOR' : sqlType(out.rt)});`);
    });
  };
  const outValue = (out: (typeof outs)[number], idx: number) => {
    if (out.cursor) return `toMaps(cs.getObject(${idx}, ResultSet.class))`;
    return getterByIndex(out.rt, idx, ctx);
  };

  if (r.kind === 'func' && ret) {
    const rt = resolveType(d, ret.dbType, { numberOneAsBool: o.numberOneAsBool });
    const t = javaType(rt, true, ctx);
    w.line(`/** Calls ${objectLabel(r)}. */`);
    w.line(`public ${t} ${fn}(${sig}) throws SQLException {`);
    w.indent();
    w.line('try (Connection c = dataSource.getConnection();');
    w.line(`        CallableStatement cs = c.prepareCall(${dq(call)})) {`);
    w.indent();
    bindParams();
    w.line('cs.execute();');
    w.line(`return ${getterByIndex(rt, 1, ctx)};`);
    w.dedent();
    w.line('}');
    w.dedent();
    w.line('}');
    return;
  }

  const hasRows = d === 'tsql';
  const resultName = pascal(`${prefix}${r.name}_result`);
  const fields = [
    ...(hasRows ? ['List<Map<String, Object>> rows'] : []),
    ...outs.map((x) => `${x.type} ${x.name}`),
    ...(d === 'tsql' ? ['int returnValue'] : []),
  ];
  if (hasRows) ctx.imports.add('java.util.List').add('java.util.Map').add('java.util.ArrayList');
  const hasResult = fields.length > 0;
  if (hasResult) {
    w.line(`/** What ${objectLabel(r)} returns. */`);
    w.line(`public record ${resultName}(${fields.join(', ')}) {`);
    w.line('}');
    w.blank();
  }
  w.line(`/** Calls ${objectLabel(r)}. */`);
  w.line(`public ${hasResult ? resultName : 'void'} ${fn}(${sig}) throws SQLException {`);
  w.indent();
  w.line('try (Connection c = dataSource.getConnection();');
  w.line(`        CallableStatement cs = c.prepareCall(${dq(call)})) {`);
  w.indent();
  bindParams();
  if (hasRows) {
    w.line('List<Map<String, Object>> rows = new ArrayList<>();');
    w.line('if (cs.execute()) {');
    w.indent();
    w.line('try (ResultSet rs = cs.getResultSet()) {');
    w.indent().line('rows = toMaps(rs);').dedent();
    w.line('}');
    w.dedent();
    w.line('}');
    w.line('while (cs.getMoreResults() || cs.getUpdateCount() != -1) {');
    w.indent().line('// drain remaining results so OUT parameters are available').dedent();
    w.line('}');
  } else {
    w.line('cs.execute();');
  }
  if (hasResult) {
    const vals = [
      ...(hasRows ? ['rows'] : []),
      ...outs.map((x) => outValue(x, params.indexOf(x.p) + 1 + offset)),
      ...(d === 'tsql' ? ['cs.getInt(1)'] : []),
    ];
    w.line(`return new ${resultName}(`);
    w.indent().indent();
    vals.forEach((v, i) => w.line(`${v}${i < vals.length - 1 ? ',' : ');'}`));
    w.dedent().dedent();
  }
  w.dedent();
  w.line('}');
  w.dedent();
  w.line('}');
}

function getterByIndex(t: ResolvedType, idx: number, ctx: Ctx): string {
  const b = t.java;
  if (IMPORT_OF[b]) ctx.imports.add(IMPORT_OF[b]);
  if (PRIMITIVE_BOX[b]) return `cs.getObject(${idx}, ${PRIMITIVE_BOX[b]}.class)`;
  if (b === 'String') return `cs.getString(${idx})`;
  if (b === 'BigDecimal') return `cs.getBigDecimal(${idx})`;
  if (b === 'byte[]') return `cs.getBytes(${idx})`;
  if (b === 'Object') return `cs.getObject(${idx})`;
  if (b === 'UUID') return `cs.getString(${idx}) == null ? null : UUID.fromString(cs.getString(${idx}))`;
  return `cs.getObject(${idx}, ${b}.class)`;
}

// ---------------- queries ----------------

function queryDao(w: Writer, q: CgQuery, ctx: Ctx, rowType: string, members: Member[]) {
  const { d, o } = ctx;
  ctx.imports.add('java.sql.*');
  ctx.imports.add('java.util.ArrayList');
  ctx.imports.add('java.util.List');
  ctx.imports.add('java.util.Objects');
  ctx.imports.add('javax.sql.DataSource');
  const cls = pascal(`${q.name}_query`);
  const { sql, order } = rewriteQuery(trimStatement(q.sql), d, 'q');
  const scope = new NameScope(['c', 'ps', 'rs', 'list', 'dataSource']);
  const args = q.params.map((p) => ({ p, local: scope.take(localName(p.name, o)), ...queryParamJava(p.type, ctx) }));
  w.line(`/** Runs the ${q.name} query. Named parameters are bound by position (JDBC uses ?). */`);
  w.block(`public final class ${cls} {`, () => {
    w.line(`private static final String SQL = ${textBlock(sql)};`);
    w.blank();
    w.line('private final DataSource dataSource;');
    w.blank();
    w.line(`public ${cls}(DataSource dataSource) {`);
    w.indent().line('this.dataSource = Objects.requireNonNull(dataSource, "dataSource");').dedent();
    w.line('}');
    w.blank();
    w.line(`public List<${rowType}> run(${args.map((a) => `${a.type} ${a.local}`).join(', ')}) throws SQLException {`);
    w.indent();
    w.line('try (Connection c = dataSource.getConnection();');
    w.line('        PreparedStatement ps = c.prepareStatement(SQL)) {');
    w.indent();
    order.forEach((name, i) => {
      const a = args.find((x) => x.p.name === name)!;
      w.line(`${setter(a.rt, true, String(i + 1), a.local)};`);
    });
    w.line('try (ResultSet rs = ps.executeQuery()) {');
    w.indent();
    w.line(`List<${rowType}> list = new ArrayList<>();`);
    w.line('while (rs.next()) {');
    w.indent();
    if (o.javaRecords) {
      w.line(`list.add(new ${rowType}(`);
      w.indent().indent();
      members.forEach((m, i) => w.line(`${getter(m.type, m.nullable, m.col.name, ctx)}${i < members.length - 1 ? ',' : '));'}`));
      w.dedent().dedent();
    } else {
      w.line(`${rowType} r = new ${rowType}();`);
      for (const m of members) {
        const cap = m.name.charAt(0).toUpperCase() + m.name.slice(1).replace(/_$/, '');
        w.line(`r.set${cap}(${getter(m.type, m.nullable, m.col.name, ctx)});`);
      }
      w.line('list.add(r);');
    }
    w.dedent();
    w.line('}');
    w.line('return list;');
    w.dedent();
    w.line('}');
    w.dedent();
    w.line('}');
    w.dedent();
    w.line('}');
  });
}

function queryParamJava(t: CgQuery['params'][number]['type'], ctx: Ctx): { type: string; rt: ResolvedType } {
  const logical: Record<string, string> = {
    string: 'nvarchar', int: 'int', long: 'bigint', decimal: 'decimal', float: 'float', bool: 'bit', date: 'date', datetime: 'datetime2',
    datetimeoffset: 'datetimeoffset', time: 'time', guid: 'uniqueidentifier', binary: 'varbinary',
  };
  const rt = resolveType('tsql', logical[t] ?? 'nvarchar');
  return { rt, type: javaType(rt, true, ctx) };
}

// ---------------- assembly ----------------

interface Unit {
  name: string;
  label: string;
  imports: Set<string>;
  body: string;
}

export function generateJava(input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const d = input.dialect;
  const units: Unit[] = [];
  const unitFor = (name: string, label: string, fn: (w: Writer, ctx: Ctx) => void) => {
    const ctx: Ctx = { d, o, imports: new Set() };
    const w = new Writer('    ');
    fn(w, ctx);
    if (!w.isEmpty) units.push({ name, label, imports: ctx.imports, body: w.toString() });
  };
  const jpa = o.flavor === 'jpa';
  for (const obj of input.objects) {
    if (isTable(obj)) {
      const typeName = typeNameOf(obj.name, o);
      const members = membersOf(obj.columns, d, o, typeName);
      const doc = [commentText(obj.comment), `Row of ${objectLabel(obj)}.`].filter(Boolean).join(' — ');
      unitFor(typeName, objectLabel(obj), (w, ctx) => recordOrClass(w, typeName, members, doc, ctx, jpa ? { jpa: obj } : {}));
      if (!jpa && o.include.repository) unitFor(`${typeName}Dao`, objectLabel(obj), (w, ctx) => dao(w, obj, typeName, members, ctx));
    } else if (obj.kind === 'query') {
      const rowType = typeNameOf(`${obj.name}_row`, o, false);
      const members = membersOf(obj.columns, d, o, rowType);
      unitFor(rowType, obj.name, (w, ctx) => recordOrClass(w, rowType, members, `Row of the ${obj.name} query.`, ctx));
      if (o.include.repository) unitFor(pascal(`${obj.name}_query`), obj.name, (w, ctx) => queryDao(w, obj, ctx, rowType, members));
    }
  }
  if (o.include.procedures && !jpa) {
    const bySchema = new Map<string, CgRoutine[]>();
    for (const r of input.objects.filter(isRoutine)) bySchema.set(r.schema ?? '', [...(bySchema.get(r.schema ?? '') ?? []), r]);
    for (const [schema, list] of bySchema) {
      const cls = proceduresClassName(schema || null, o);
      unitFor(cls, `${schema || 'default'} routines`, (w, ctx) => routines(w, list, cls, `the routines of ${schema || 'the database'}`, ctx, () => ''));
    }
    for (const pkg of input.objects.filter((x): x is CgPackage => x.kind === 'package')) {
      const cls = pascal(pkg.name);
      unitFor(cls, objectLabel(pkg), (w, ctx) => routines(w, pkg.members, cls, `package ${objectLabel(pkg)}`, ctx, () => ''));
    }
  }
  const pkgName = o.namespace.trim() || 'com.example.data';
  return units.map((u) => {
    const imports = [...u.imports].sort((a, b) => {
      const rank = (s: string) => (s.startsWith('java.') ? 1 : s.startsWith('javax.') ? 2 : 0);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    const groups: string[] = [];
    let last = -1;
    for (const i of imports) {
      const rank = i.startsWith('java.') || i.startsWith('javax.') ? 1 : 0;
      if (last !== -1 && rank !== last) groups.push('');
      groups.push(`import ${i};`);
      last = rank;
    }
    const content = [
      `// Generated by DbStudio from ${DIALECT_LABEL[d]}: ${u.label}. Review before use.`,
      `package ${pkgName};`,
      '',
      ...(groups.length ? [...groups, ''] : []),
      u.body,
      '',
    ].join('\n');
    return { path: `${u.name}.java`, language: 'java', content };
  });
}

export type { CgParam };

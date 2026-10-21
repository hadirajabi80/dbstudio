// Java generator: JDBC (records + DAO with PreparedStatement / CallableStatement) and JPA (@Entity) flavors.
// One public top-level type per file, as Java requires.
import type { Dialect } from '../../api/types';
import type { CgInput, CgPackage, CgParam, CgQuery, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import { camel, NameScope, pascal, withSuffix } from '../naming';
import type { CodegenOptions } from '../options';
import {
  bindNameOf, DIALECT_LABEL, friendlyParam, localName, membersOf, objectLabel, pkMembers, proceduresClassName, routineSqlName, typeNameOf,
  type Member,
} from '../shape';
import { crudSql, defaultsNote, PH, qi, rewriteQuery, trimStatement } from '../sqlgen';
import { resolveType, type ResolvedType } from '../types';
import { commentText, dq, Writer } from '../writer';

interface Ctx {
  d: Dialect;
  o: CodegenOptions;
  imports: Set<string>;
  /** PostgreSQL: helpers of the generated package-private PgJdbc class this output uses (shared by all files). */
  pgHelpers: Set<'array' | 'strings' | 'duration'>;
}

const PRIMITIVE_BOX: Record<string, string> = { int: 'Integer', long: 'Long', short: 'Short', boolean: 'Boolean', double: 'Double', float: 'Float', byte: 'Byte' };

const IMPORT_OF: Record<string, string> = {
  BigDecimal: 'java.math.BigDecimal', LocalDate: 'java.time.LocalDate', LocalDateTime: 'java.time.LocalDateTime', OffsetDateTime: 'java.time.OffsetDateTime',
  LocalTime: 'java.time.LocalTime', Duration: 'java.time.Duration', UUID: 'java.util.UUID', OffsetTime: 'java.time.OffsetTime',
};

function javaType(t: ResolvedType, nullable: boolean, ctx: Ctx): string {
  if (ctx.d === 'pgsql' && t.array) return pgArrayType(t, ctx);
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

// ---------------- PostgreSQL (pgjdbc) ----------------

/** Array element types pgjdbc's `Array.getArray()` returns as such (boxed); other element types come back as Object[]. */
const PG_ARRAY_ELEMENTS = new Set(['Integer', 'Long', 'Short', 'Float', 'Double', 'Boolean', 'BigDecimal', 'String', 'UUID']);

/** Java type of a PostgreSQL array: `Integer[]` (getArray() returns boxed elements), `Object[]` when pgjdbc returns another type. */
function pgArrayType(t: ResolvedType, ctx: Ctx): string {
  const e = t.element ? (PRIMITIVE_BOX[t.element.java] ?? t.element.java) : 'Object';
  if (!PG_ARRAY_ELEMENTS.has(e)) return 'Object[]';
  if (IMPORT_OF[e]) ctx.imports.add(IMPORT_OF[e]);
  return `${e}[]`;
}

/** PostgreSQL types that are text in Java but not text on the server: bound with setObject(..., Types.OTHER) (server-side cast). */
function pgTextLike(t: ResolvedType): boolean {
  return /^(text|varchar|char|bpchar|character|character varying|name|citext)$/.test(t.base) && !t.enumLabels?.length;
}

/** Element type name for Connection.createArrayOf (pgjdbc resolves these spellings). */
function pgArrayElementName(t: ResolvedType): string {
  const b = t.element?.base ?? 'text';
  const alias: Record<string, string> = {
    'double precision': 'float8', 'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp',
    'time without time zone': 'time', 'time with time zone': 'timetz', character: 'bpchar', char: 'bpchar',
  };
  return alias[b] ?? b;
}

/** pgjdbc ResultSet getter; `key` is the column label literal or a 1-based index. */
function pgGetter(t: ResolvedType, nullable: boolean, key: string, ctx: Ctx, rs: string): string {
  if (t.array) {
    const type = pgArrayType(t, ctx);
    if (type === 'String[]') {
      ctx.pgHelpers.add('strings');
      return `PgJdbc.strings(${rs}.getArray(${key}))`;
    }
    ctx.pgHelpers.add('array');
    return `PgJdbc.array(${rs}.getArray(${key}), ${type}.class)`;
  }
  const b = t.java;
  if (IMPORT_OF[b]) ctx.imports.add(IMPORT_OF[b]);
  if (b === 'Duration') {
    ctx.pgHelpers.add('duration');
    return `PgJdbc.duration(${rs}.getObject(${key}))`;
  }
  if (PRIMITIVE_BOX[b]) {
    if (nullable) return `${rs}.getObject(${key}, ${PRIMITIVE_BOX[b]}.class)`;
    const m: Record<string, string> = { int: 'getInt', long: 'getLong', short: 'getShort', boolean: 'getBoolean', double: 'getDouble', float: 'getFloat', byte: 'getByte' };
    return `${rs}.${m[b]}(${key})`;
  }
  if (b === 'String') return `${rs}.getString(${key})`;
  if (b === 'BigDecimal') return `${rs}.getBigDecimal(${key})`;
  if (b === 'byte[]') return `${rs}.getBytes(${key})`;
  if (b === 'Object') return `${rs}.getObject(${key})`;
  // UUID, LocalDate, LocalDateTime, LocalTime, OffsetDateTime, OffsetTime: pgjdbc's getObject(int, Class).
  return `${rs}.getObject(${key}, ${b}.class)`;
}

/**
 * pgjdbc PreparedStatement setter. Arrays go through `c.createArrayOf` (the open Connection is `c`); json/jsonb, enums,
 * inet, xml and other non-text types held as String are sent with Types.OTHER so the server casts them (no `?::type`
 * in the SQL); interval goes as its ISO-8601 text (Duration.toString()), java.time values through setObject(i, v).
 */
function pgSetter(t: ResolvedType, nullable: boolean, index: string, expr: string, ps: string): string {
  if (t.array) return `${ps}.setArray(${index}, ${expr} == null ? null : c.createArrayOf(${dq(pgArrayElementName(t))}, ${expr}))`;
  const b = t.java;
  if (PRIMITIVE_BOX[b] && !nullable) {
    const m: Record<string, string> = { int: 'setInt', long: 'setLong', short: 'setShort', boolean: 'setBoolean', double: 'setDouble', float: 'setFloat', byte: 'setByte' };
    return `${ps}.${m[b]}(${index}, ${expr})`;
  }
  if (PRIMITIVE_BOX[b]) return `${ps}.setObject(${index}, ${expr}, ${sqlType(t)})`;
  if (b === 'String') return pgTextLike(t) ? `${ps}.setString(${index}, ${expr})` : `${ps}.setObject(${index}, ${expr}, Types.OTHER)`;
  if (b === 'BigDecimal') return `${ps}.setBigDecimal(${index}, ${expr})`;
  if (b === 'byte[]') return `${ps}.setBytes(${index}, ${expr})`;
  if (b === 'Duration') return `${ps}.setObject(${index}, ${expr} == null ? null : ${expr}.toString(), Types.OTHER)`;
  if (b === 'UUID' || b === 'Object') return `${ps}.setObject(${index}, ${expr}, Types.OTHER)`;
  return `${ps}.setObject(${index}, ${expr})`;
}

/** The package-private PgJdbc helper class (array / interval conversions). */
function pgJdbcHelpers(w: Writer, helpers: Set<string>, imports: Set<string>) {
  imports.add('java.sql.SQLException');
  w.line('/** PostgreSQL JDBC (pgjdbc) conversions used by the generated code. */');
  w.block('final class PgJdbc {', () => {
    w.line('private PgJdbc() {');
    w.line('}');
    if (helpers.has('array')) {
      imports.add('java.sql.Array');
      w.blank();
      w.line('/** A PostgreSQL array as the Java array pgjdbc builds (boxed elements); null for SQL NULL. */');
      w.line('static <T> T array(Array a, Class<T> type) throws SQLException {');
      w.indent().line('return a == null ? null : type.cast(a.getArray());').dedent();
      w.line('}');
    }
    if (helpers.has('strings')) {
      imports.add('java.sql.Array');
      w.blank();
      w.line('/** A text, varchar or enum array as String[] (each element via toString(), so enum elements work whatever pgjdbc builds); null for SQL NULL. */');
      w.line('static String[] strings(Array a) throws SQLException {');
      w.indent();
      w.line('if (a == null) {');
      w.indent().line('return null;').dedent();
      w.line('}');
      w.line('Object[] values = (Object[]) a.getArray();');
      w.line('String[] out = new String[values.length];');
      w.line('for (int i = 0; i < values.length; i++) {');
      w.indent().line('out[i] = values[i] == null ? null : values[i].toString();').dedent();
      w.line('}');
      w.line('return out;');
      w.dedent();
      w.line('}');
    }
    if (helpers.has('duration')) {
      imports.add('java.time.Duration');
      imports.add('org.postgresql.util.PGInterval');
      w.blank();
      w.line('/** An interval (PGInterval) as a Duration; a month counts as 30 days and a year as 365. Null for SQL NULL. */');
      w.line('static Duration duration(Object value) {');
      w.indent();
      w.line('if (value == null) {');
      w.indent().line('return null;').dedent();
      w.line('}');
      w.line('PGInterval i = (PGInterval) value;');
      w.line('return Duration.ofDays(i.getYears() * 365L + i.getMonths() * 30L + i.getDays())');
      w.indent().indent();
      w.line('.plusHours(i.getHours())');
      w.line('.plusMinutes(i.getMinutes())');
      w.line('.plusNanos(Math.round(i.getSeconds() * 1_000_000_000d));');
      w.dedent().dedent();
      w.dedent();
      w.line('}');
    }
  });
}

/** ResultSet getter for a column (by label). */
function getter(t: ResolvedType, nullable: boolean, label: string, ctx: Ctx, rs = 'rs'): string {
  if (ctx.d === 'pgsql') return pgGetter(t, nullable, dq(label), ctx, rs);
  const b = t.java;
  // The getter names the type (LocalDateTime.parse, UUID::fromString, LocalDate.class): import it like javaType does.
  if (IMPORT_OF[b]) ctx.imports.add(IMPORT_OF[b]);
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
      if (d === 'pgsql' && pgJpaUnmapped(m.type)) {
        // JPA has no mapping for java.lang.Object: keep the field out of the persistence model.
        w.line(`// TODO: ${m.col.dbType} has no JPA mapping (Object); map it with a Hibernate UserType or drop the field.`);
        w.line('@Transient');
        w.line(`private ${javaType(m.type, true, ctx)} ${m.name};`);
        w.blank();
        continue;
      }
      if (pk.includes(m) || (t.kind === 'view' && !pk.length && m === members[0])) w.line('@Id');
      if (m.col.identity) w.line('@GeneratedValue(strategy = GenerationType.IDENTITY)');
      const attrs = [`name = ${dq(jpaQuote(m.col.name, d))}`];
      if (!m.nullable) attrs.push('nullable = false');
      if (m.type.logical === 'string' && m.type.length) attrs.push(`length = ${m.type.length}`);
      if (m.type.logical === 'decimal' && m.type.precision) attrs.push(`precision = ${m.type.precision}`, `scale = ${m.type.scale ?? 0}`);
      if (m.col.identity || m.col.computed || m.type.logical === 'rowversion') attrs.push('insertable = false', 'updatable = false');
      // A server default fills it on INSERT (as the JDBC insert does); updates still write it.
      else if (m.col.hasDefault && t.kind === 'table' && !pk.includes(m)) attrs.push('insertable = false');
      // PostgreSQL: @Lob byte[] would map to a large object (oid); bytea is Hibernate's default for byte[].
      if (m.type.logical === 'binary' && !m.type.length && d !== 'pgsql') w.line('@Lob');
      if (m.type.logical === 'rowversion') w.line('@Version');
      if (d === 'pgsql') {
        const pg = pgJpaColumn(m.type, qi(m.col.name, d));
        if (pg.columnDefinition) attrs.push(`columnDefinition = ${dq(pg.columnDefinition)}`);
        pg.annotations.forEach((a) => w.line(a));
      }
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

/** PostgreSQL columns JPA cannot map (java.lang.Object: geometric, tsvector, range types; arrays of those). */
function pgJpaUnmapped(t: ResolvedType): boolean {
  if (t.array) {
    const e = t.element ? (PRIMITIVE_BOX[t.element.java] ?? t.element.java) : 'Object';
    return !PG_ARRAY_ELEMENTS.has(e);
  }
  return t.java === 'Object';
}

const HB = 'org.hibernate.annotations';
const SQL_TYPES_HB = 'org.hibernate.type.SqlTypes';

/**
 * Hibernate 6 mapping of PostgreSQL-specific columns: `columnDefinition` for DDL plus `@JdbcTypeCode` (json, arrays,
 * interval, timetz) or a `@ColumnTransformer` cast for String fields held in enum / inet / xml columns.
 */
function pgJpaColumn(t: ResolvedType, column: string): { columnDefinition: string | null; annotations: string[] } {
  const def = t.dbType.trim();
  if (t.array) {
    const el = t.element;
    const annotations = [`@${HB}.JdbcTypeCode(${SQL_TYPES_HB}.ARRAY)`];
    if (el && el.java === 'String' && !pgTextLike(el)) annotations.push(`@${HB}.ColumnTransformer(read = ${dq(`${column}::text[]`)}, write = ${dq(`?::${def}`)})`);
    return { columnDefinition: def, annotations };
  }
  if (t.logical === 'json') return { columnDefinition: def, annotations: [`@${HB}.JdbcTypeCode(${SQL_TYPES_HB}.JSON)`] };
  if (t.logical === 'interval') return { columnDefinition: def, annotations: [`@${HB}.JdbcTypeCode(${SQL_TYPES_HB}.INTERVAL_SECOND)`] };
  if (t.java === 'OffsetTime') return { columnDefinition: def, annotations: [`@${HB}.JdbcTypeCode(${SQL_TYPES_HB}.TIME_WITH_TIMEZONE)`] };
  if (t.java === 'String' && !pgTextLike(t)) return { columnDefinition: def, annotations: [`@${HB}.ColumnTransformer(write = ${dq(`?::${def}`)})`] };
  if (t.base === 'money') return { columnDefinition: def, annotations: [] };
  return { columnDefinition: null, annotations: [] };
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
  // PostgreSQL: INSERT ... RETURNING read with executeQuery; the other dialects use getGeneratedKeys.
  const crud = crudSql(t, d, { placeholder: PH.q, bindName: (c) => byCol.get(c)!.name, identityReturn: d === 'pgsql' ? 'auto' : 'none', newline: '\n' });
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

    const bind = (m: Member, i: number, expr: string) => (d === 'pgsql' ? pgSetter(m.type, m.nullable, String(i), expr, 'ps') : setter(m.type, m.nullable, String(i), expr));
    const bindAll = (cols: { m: Member; expr: string }[]) => cols.forEach((c, i) => w.line(`${bind(c.m, i + 1, c.expr)};`));

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
      const note = defaultsNote(crud.insert, !!crud.update);
      w.line(`/** ${identity ? `Inserts a row and returns the generated ${identity.col.name}.` : 'Inserts a row.'}${note ? ` ${note}` : ''} */`);
      w.line(`public ${idType ?? 'void'} insert(${typeName} e) throws SQLException {`);
      w.indent();
      w.line('try (Connection c = dataSource.getConnection();');
      const returning = crud.insert.returningKind === 'row' && identity;
      w.line(`        PreparedStatement ps = c.prepareStatement(INSERT_SQL${identity && !returning ? `, new String[] {${dq(identity.col.name)}}` : ''})) {`);
      w.indent();
      bindAll(binds);
      if (returning) {
        w.line('try (ResultSet rs = ps.executeQuery()) {');
        w.indent();
        w.line('if (!rs.next()) {');
        w.indent().line(`throw new SQLException("INSERT ... RETURNING returned no row for ${t.name}");`).dedent();
        w.line('}');
        w.line(`return ${pgGetter(identity.type, false, '1', ctx, 'rs')};`);
        w.dedent();
        w.line('}');
      } else w.line('ps.executeUpdate();');
      if (identity && !returning) {
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

// ---------------- PostgreSQL routines (PreparedStatement: SELECT f(?) / CALL p(?)) ----------------

const pgInArgs = (r: CgRoutine) => callParams(r).filter((p) => p.direction === 'in' || p.direction === 'inout');

/**
 * PostgreSQL routine wrappers on PreparedStatement (pgjdbc has no CallableStatement OUT binds for procedures):
 * `SELECT s.f(?)` (scalar), `SELECT cols FROM s.f(?)` (table function into a nested record), `CALL s.p(?, ?)` (OUT
 * arguments passed as NULL; OUT / INOUT values read from the returned row). Arguments with a server default are left out
 * of the call when null (named notation `name => ?` from there on) unless the routine is overloaded; overloads keep the
 * Java method name while their Java parameter types differ (a number otherwise) and get `?::type` casts.
 */
function pgRoutines(w: Writer, list: CgRoutine[], cls: string, label: string, ctx: Ctx) {
  ctx.imports.add('java.sql.*');
  ctx.imports.add('java.util.Objects');
  ctx.imports.add('javax.sql.DataSource');
  // Overload groups (same name): numbering and "this call is ambiguous" notes.
  const groups = new Map<string, CgRoutine[]>();
  for (const r of list) groups.set(r.name, [...(groups.get(r.name) ?? []), r]);
  const norm = (t: string) => t.trim().toLowerCase();
  w.line(`/** JDBC wrappers (SELECT / CALL) for ${label}. */`);
  w.block(`public final class ${cls} {`, () => {
    w.line('private final DataSource dataSource;');
    w.blank();
    w.line(`public ${cls}(DataSource dataSource) {`);
    w.indent().line('this.dataSource = Objects.requireNonNull(dataSource, "dataSource");').dedent();
    w.line('}');
    const javaSigs = new Map<string, Set<string>>();
    let usesMaps = false;
    for (const r of list) {
      const group = groups.get(r.name)!;
      const index = group.indexOf(r) + 1;
      const mine = pgInArgs(r);
      const other = group.length > 1
        ? group.find((b) => b !== r && pgInArgs(b).length > mine.length && mine.every((p, j) => norm(p.dbType) === norm(pgInArgs(b)[j].dbType)) && pgInArgs(b).slice(mine.length).every((p) => p.hasDefault))
        : undefined;
      const sig = mine.map((p) => javaType(resolveType('pgsql', p.dbType, { numberOneAsBool: ctx.o.numberOneAsBool }), true, ctx)).join(',');
      const seen = javaSigs.get(r.name) ?? new Set<string>();
      const fn = camel(seen.has(sig) ? `${r.name}_${index}` : r.name);
      seen.add(sig);
      javaSigs.set(r.name, seen);
      const typeBase = index > 1 ? `${r.name}_${index}` : r.name;
      const overload = group.length > 1
        ? { index, count: group.length, ambiguousWith: other ? `${objectLabel(other)}(${pgInArgs(other).map((p) => `${p.dbType}${p.hasDefault ? ' DEFAULT' : ''}`).join(', ')})` : null }
        : null;
      w.blank();
      if (pgRoutine(w, r, ctx, fn, typeBase, overload)) usesMaps = true;
    }
    if (usesMaps) {
      ctx.imports.add('java.util.ArrayList');
      ctx.imports.add('java.util.List');
      ctx.imports.add('java.util.LinkedHashMap');
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
  });
}

/** One PostgreSQL routine wrapper; returns true when it uses the class's toMaps helper. */
function pgRoutine(w: Writer, r: CgRoutine, ctx: Ctx, fn: string, typeBase: string, overload: { index: number; count: number; ambiguousWith: string | null } | null): boolean {
  const { o } = ctx;
  const d: Dialect = 'pgsql';
  const scope = new NameScope(['c', 'ps', 'rs', 'list', 'sql', 'i', 'dataSource', 'rows']);
  const params = callParams(r).map((p, i) => (p.name ? p : { ...p, name: `arg${i + 1}` }));
  const unnamed = new Set(params.filter((_p, i) => !callParams(r)[i].name));
  // Functions take their IN / INOUT arguments; a procedure's CALL lists OUT arguments too (as NULL, PostgreSQL 14+).
  const callList = r.kind === 'proc' ? params : params.filter((p) => p.direction !== 'out');
  const firstDefault = callList.findIndex((p) => p.direction !== 'out' && p.hasDefault);
  const canOmit = !overload && firstDefault >= 0 && callList.slice(firstDefault).every((p) => !unnamed.has(p));
  const rtOf = (p: CgParam) => resolveType(d, p.dbType, { numberOneAsBool: o.numberOneAsBool });
  const args = params
    .filter((p) => p.direction === 'in' || p.direction === 'inout')
    .map((p) => ({ p, rt: rtOf(p), local: scope.take(localName(bindNameOf(p), o)), type: javaType(rtOf(p), true, ctx), optional: canOmit && p.hasDefault }));
  const outs = params.filter((p) => p.direction === 'out' || p.direction === 'inout');
  const ret = returnParam(r);
  const sqlName = routineSqlName(r, d, qi);
  const sig = args.map((a) => `${a.type} ${a.local}`).join(', ');
  const doc = (what: string) => {
    const parts = [`${what}${overload ? ` (overload ${overload.index} of ${overload.count})` : ''}.`];
    if (overload?.ambiguousWith) parts.push(`PostgreSQL reports this call as ambiguous while ${overload.ambiguousWith} exists.`);
    const kept = overload ? args.filter((a) => a.p.hasDefault).map((a) => a.local) : [];
    if (kept.length) parts.push(`${kept.join(', ')}: always passed (leaving a default out could match another overload).`);
    const opt = args.filter((a) => a.optional).map((a) => a.local);
    if (opt.length) parts.push(`${opt.join(', ')}: null leaves ${opt.length > 1 ? 'them' : 'it'} out of the call, so the server default applies.`);
    w.line(`/** ${parts.join(' ')} */`);
  };

  // Call text: a constant when every argument is passed, else built at run time (`sql`); then the binds.
  const callSql = (prefix: string): string => {
    const cast = (p: CgParam) => (overload ? `::${p.dbType}` : '');
    const positional = (p: CgParam) => (p.direction === 'out' ? 'NULL' : '?') + cast(p);
    if (!canOmit) return dq(`${prefix}(${callList.map(positional).join(', ')})`);
    ctx.imports.add('java.util.ArrayList');
    ctx.imports.add('java.util.List');
    const lead = callList.slice(0, firstDefault).map((p) => dq(positional(p)));
    w.line(`List<String> list = new ArrayList<>(${lead.length ? `List.of(${lead.join(', ')})` : ''});`);
    for (const p of callList.slice(firstDefault)) {
      const text = dq(`${qi(bindNameOf(p), d)} => ${p.direction === 'out' ? 'NULL' : '?'}`);
      const a = args.find((x) => x.p === p);
      if (a?.optional) {
        w.line(`if (${a.local} != null) {`);
        w.indent().line(`list.add(${text});`).dedent();
        w.line('}');
      } else w.line(`list.add(${text});`);
    }
    w.line(`String sql = ${dq(`${prefix}(`)} + String.join(", ", list) + ")";`);
    return 'sql';
  };
  const binds = () => {
    if (!canOmit) {
      args.forEach((a, i) => w.line(`${pgSetter(a.rt, true, String(i + 1), a.local, 'ps')};`));
      return;
    }
    w.line('int i = 0;');
    for (const a of args) {
      const set = `${pgSetter(a.rt, true, '++i', a.local, 'ps')};`;
      if (a.optional) {
        w.line(`if (${a.local} != null) {`);
        w.indent().line(set).dedent();
        w.line('}');
      } else w.line(set);
    }
  };
  const open = (sqlExpr: string) => {
    w.line('try (Connection c = dataSource.getConnection();');
    w.line(`        PreparedStatement ps = c.prepareStatement(${sqlExpr})) {`);
    w.indent();
    binds();
  };
  const close = () => {
    w.dedent();
    w.line('}');
    w.dedent();
    w.line('}');
  };
  const noRow = (what: string) => {
    w.line('if (!rs.next()) {');
    w.indent().line(`throw new SQLException(${dq(`${what} returned no row`)});`).dedent();
    w.line('}');
  };

  // Table function: rows into a nested record.
  const tableCols = r.kind === 'func' && r.resultColumns?.length ? r.resultColumns : null;
  if (tableCols) {
    ctx.imports.add('java.util.ArrayList');
    ctx.imports.add('java.util.List');
    const rowType = pascal(withSuffix(typeBase, 'row'));
    const members = membersOf(tableCols, d, o, rowType);
    w.line(`/** A row of ${objectLabel(r)}. */`);
    w.line(`public record ${rowType}(${members.map((m) => `${javaType(m.type, m.nullable, ctx)} ${m.name}`).join(', ')}) {`);
    w.line('}');
    w.blank();
    doc(`Returns the rows of ${objectLabel(r)}`);
    w.line(`public List<${rowType}> ${fn}(${sig}) throws SQLException {`);
    w.indent();
    open(callSql(`SELECT ${tableCols.map((x) => qi(x.name, d)).join(', ')} FROM ${sqlName}`));
    w.line('try (ResultSet rs = ps.executeQuery()) {');
    w.indent();
    w.line(`List<${rowType}> rows = new ArrayList<>();`);
    w.line('while (rs.next()) {');
    w.indent();
    w.line(`rows.add(new ${rowType}(`);
    w.indent().indent();
    members.forEach((m, i) => w.line(`${pgGetter(m.type, m.nullable, dq(m.col.name), ctx, 'rs')}${i < members.length - 1 ? ',' : '));'}`));
    w.dedent().dedent();
    w.dedent();
    w.line('}');
    w.line('return rows;');
    w.dedent();
    w.line('}');
    close();
    return false;
  }

  // Scalar function, SETOF scalar / record.
  if (r.kind === 'func' && !outs.length && ret && !/^void$/i.test(ret.dbType.trim())) {
    const setof = /^\s*setof\s+(.+)$/i.exec(ret.dbType);
    const rt = resolveType(d, setof ? setof[1] : ret.dbType, { numberOneAsBool: o.numberOneAsBool });
    if (setof) {
      ctx.imports.add('java.util.ArrayList');
      ctx.imports.add('java.util.List');
      const record = rt.logical === 'object' && !rt.array;
      const el = record ? 'Map<String, Object>' : javaType(rt, true, ctx);
      doc(`Returns the rows of ${objectLabel(r)}`);
      w.line(`public List<${el}> ${fn}(${sig}) throws SQLException {`);
      w.indent();
      open(callSql(`SELECT * FROM ${sqlName}`));
      w.line('try (ResultSet rs = ps.executeQuery()) {');
      w.indent();
      if (record) w.line('return toMaps(rs);');
      else {
        w.line(`List<${el}> rows = new ArrayList<>();`);
        w.line('while (rs.next()) {');
        w.indent().line(`rows.add(${pgGetter(rt, true, '1', ctx, 'rs')});`).dedent();
        w.line('}');
        w.line('return rows;');
      }
      w.dedent();
      w.line('}');
      close();
      return record;
    }
    const t = javaType(rt, true, ctx);
    doc(`Calls ${objectLabel(r)}`);
    w.line(`public ${t} ${fn}(${sig}) throws SQLException {`);
    w.indent();
    open(callSql(`SELECT ${sqlName}`));
    w.line('try (ResultSet rs = ps.executeQuery()) {');
    w.indent();
    noRow(objectLabel(r));
    w.line(`return ${pgGetter(rt, true, '1', ctx, 'rs')};`);
    w.dedent();
    w.line('}');
    close();
    return false;
  }

  // Procedure (CALL) or function with OUT parameters (SELECT * FROM): OUT / INOUT values come back as one row.
  const prefix = r.kind === 'proc' ? `CALL ${sqlName}` : outs.length ? `SELECT * FROM ${sqlName}` : `SELECT ${sqlName}`;
  if (!outs.length) {
    doc(`Calls ${objectLabel(r)}`);
    w.line(`public void ${fn}(${sig}) throws SQLException {`);
    w.indent();
    open(callSql(prefix));
    w.line('ps.execute();');
    close();
    return false;
  }
  const resultName = pascal(`${typeBase}_result`);
  const fieldScope = new NameScope([]);
  const fields = outs.map((p) => ({ p, rt: rtOf(p), name: fieldScope.take(camel(friendlyParam(bindNameOf(p)))), type: javaType(rtOf(p), true, ctx) }));
  w.line(`/** The OUT / INOUT values of ${objectLabel(r)}. */`);
  w.line(`public record ${resultName}(${fields.map((f) => `${f.type} ${f.name}`).join(', ')}) {`);
  w.line('}');
  w.blank();
  doc(`Calls ${objectLabel(r)}; the OUT / INOUT values come back as a row`);
  w.line(`public ${resultName} ${fn}(${sig}) throws SQLException {`);
  w.indent();
  open(callSql(prefix));
  w.line('try (ResultSet rs = ps.executeQuery()) {');
  w.indent();
  noRow(objectLabel(r));
  w.line(`return new ${resultName}(`);
  w.indent().indent();
  fields.forEach((f, i) => w.line(`${pgGetter(f.rt, true, String(i + 1), ctx, 'rs')}${i < fields.length - 1 ? ',' : ');'}`));
  w.dedent().dedent();
  w.dedent();
  w.line('}');
  close();
  return false;
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
  const cls = pascal(withSuffix(q.name, 'query'));
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
  const pgHelpers: Ctx['pgHelpers'] = new Set();
  const unitFor = (name: string, label: string, fn: (w: Writer, ctx: Ctx) => void) => {
    const ctx: Ctx = { d, o, imports: new Set(), pgHelpers };
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
      const rowType = typeNameOf(withSuffix(obj.name, 'row'), o, false);
      const members = membersOf(obj.columns, d, o, rowType);
      unitFor(rowType, obj.name, (w, ctx) => recordOrClass(w, rowType, members, `Row of the ${obj.name} query.`, ctx));
      if (o.include.repository) unitFor(pascal(withSuffix(obj.name, 'query')), obj.name, (w, ctx) => queryDao(w, obj, ctx, rowType, members));
    }
  }
  if (o.include.procedures && !jpa) {
    const bySchema = new Map<string, CgRoutine[]>();
    for (const r of input.objects.filter(isRoutine)) bySchema.set(r.schema ?? '', [...(bySchema.get(r.schema ?? '') ?? []), r]);
    for (const [schema, list] of bySchema) {
      const cls = proceduresClassName(schema || null, o);
      const label = `the routines of ${schema || 'the database'}`;
      unitFor(cls, `${schema || 'default'} routines`, (w, ctx) => (d === 'pgsql' ? pgRoutines(w, list, cls, label, ctx) : routines(w, list, cls, label, ctx, () => '')));
    }
    for (const pkg of input.objects.filter((x): x is CgPackage => x.kind === 'package')) {
      const cls = pascal(pkg.name);
      unitFor(cls, objectLabel(pkg), (w, ctx) => routines(w, pkg.members, cls, `package ${objectLabel(pkg)}`, ctx, () => ''));
    }
  }
  if (pgHelpers.size) {
    const w = new Writer('    ');
    const imports = new Set<string>();
    pgJdbcHelpers(w, pgHelpers, imports);
    units.push({ name: 'PgJdbc', label: 'pgjdbc helpers', imports, body: w.toString() });
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

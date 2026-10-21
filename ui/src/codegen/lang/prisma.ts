// Prisma schema generator (TypeScript "Prisma schema" flavor, PostgreSQL only; docs/PLAN-PG.md 4.1): one
// `schema.prisma` with the datasource, the client generator, a model per table (a view block per view), enums from
// the catalog's enum types and relations from the foreign keys (with the back-relation field on the referenced model).
import type { CgColumn, CgInput, CgTable, GeneratedFile } from '../model';
import { isTable } from '../model';
import { camel, NameScope, pascal, singularize } from '../naming';
import type { CodegenOptions } from '../options';
import { monacoLanguageOf } from '../options';
import { DIALECT_LABEL } from '../shape';
import { resolveType, type ResolvedType } from '../types';
import { commentText, dq } from '../writer';

/** Prisma scalar for a type, with the native `@db.` attribute when it narrows the default mapping; null = Unsupported. */
function scalar(t: ResolvedType): { type: string; db: string | null } | null {
  const base = t.base.replace(/\[\]$/, '');
  if (base === 'bit') return { type: 'String', db: `@db.Bit(${t.length ?? t.precision ?? 1})` };
  if (base === 'varbit') return { type: 'String', db: t.length ?? t.precision ? `@db.VarBit(${t.length ?? t.precision})` : '@db.VarBit' };
  if (base === 'oid') return { type: 'Int', db: '@db.Oid' };
  switch (t.logical) {
    case 'bool': return { type: 'Boolean', db: null };
    case 'int16': return { type: 'Int', db: '@db.SmallInt' };
    case 'int32': return { type: 'Int', db: null };
    case 'int64': return { type: 'BigInt', db: null };
    case 'decimal':
      if (base === 'money') return { type: 'Decimal', db: '@db.Money' };
      return { type: 'Decimal', db: t.precision ? `@db.Decimal(${t.precision}, ${t.scale ?? 0})` : null };
    case 'float32': return { type: 'Float', db: '@db.Real' };
    case 'float64': return { type: 'Float', db: null };
    case 'string':
      if (t.enumLabels?.length) return null;
      if (base === 'varchar') return { type: 'String', db: t.length ? `@db.VarChar(${t.length})` : '@db.VarChar' };
      if (base === 'char' || base === 'character' || base === 'bpchar') return { type: 'String', db: `@db.Char(${t.length ?? 1})` };
      if (base === 'citext') return { type: 'String', db: '@db.Citext' };
      if (base === 'inet') return { type: 'String', db: '@db.Inet' };
      // No Prisma native type: cidr, macaddr, macaddr8.
      if (base === 'cidr' || base === 'macaddr' || base === 'macaddr8') return null;
      return { type: 'String', db: null };
    case 'guid': return { type: 'String', db: '@db.Uuid' };
    case 'date': return { type: 'DateTime', db: '@db.Date' };
    // Prisma's DateTime default is timestamp(3): PostgreSQL's default precision is 6.
    case 'datetime': return { type: 'DateTime', db: `@db.Timestamp(${t.precision ?? 6})` };
    case 'datetimeoffset': return { type: 'DateTime', db: `@db.Timestamptz(${t.precision ?? 6})` };
    case 'time': return { type: 'DateTime', db: /tz|with time zone/.test(base) ? `@db.Timetz(${t.precision ?? 6})` : `@db.Time(${t.precision ?? 6})` };
    case 'binary': return { type: 'Bytes', db: null };
    case 'json': return { type: 'Json', db: base === 'json' ? '@db.Json' : null };
    case 'xml': return { type: 'String', db: '@db.Xml' };
    default: return null;
  }
}

interface Field {
  name: string;
  type: string;
  attrs: string[];
  comment: string | null;
}

interface PrismaEnum {
  name: string;
  db: string;
  labels: string[];
  schema: string;
}

/** A Prisma identifier (`[A-Za-z][A-Za-z0-9_]*`). */
function ident(s: string, prefix: string): string {
  const t = s.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z]/.test(t) ? t : `${prefix}${t}`;
}

/** `sales.order_status[]` → { schema: 'sales', name: 'order_status' }. */
function typeRef(dbType: string): { schema: string | null; name: string } {
  const parts = dbType.replace(/(\s*\[\s*\d*\s*\])+$/, '').trim().split('.').map((x) => x.replace(/^"(.*)"$/, '$1'));
  return parts.length > 1 ? { schema: parts[0], name: parts[parts.length - 1] } : { schema: null, name: parts[0] };
}

const fieldName = (col: string) => ident(camel(col), 'f');
const hasKey = (t: CgTable) => t.primaryKey.length > 0;

export function generatePrisma(input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const tables = input.objects.filter(isTable);
  const schemas = [...new Set(tables.map((t) => t.schema ?? 'public'))].sort();
  const multi = schemas.length > 1;
  const enums = new Map<string, PrismaEnum>();
  const names = new NameScope([], true);
  const modelName = new Map<string, string>();
  const key = (schema: string | null, name: string) => `${schema ?? 'public'}.${name}`;
  for (const t of tables) modelName.set(key(t.schema, t.name), names.take(ident(pascal(o.singularize ? singularize(t.name) : t.name), 'M')));
  /** The enum of a column's type, declared once (named so it never clashes with a model). */
  const enumOf = (c: CgColumn, labels: string[], t: CgTable): string => {
    const ref = typeRef(c.dbType);
    const schema = ref.schema ?? t.schema ?? 'public';
    const k = `${schema}.${ref.name}`;
    let e = enums.get(k);
    if (!e) {
      const base = ident(pascal(ref.name), 'E');
      // A model of the same name keeps it: the enum becomes MoodEnum.
      e = { name: names.take([...modelName.values()].some((m) => m.toLowerCase() === base.toLowerCase()) ? `${base}Enum` : base), db: ref.name, labels, schema };
      enums.set(k, e);
    }
    return e.name;
  };

  // Pass 1: scalar fields of every model.
  const parts = tables.map((t) => {
    const used = new NameScope([], true);
    const notes: string[] = [];
    const fields = t.columns.map((c) => columnField(c, t, used, enumOf, notes));
    return { t, mName: modelName.get(key(t.schema, t.name))!, used, notes, fields };
  });
  const partOf = (schema: string | null, name: string) => parts.find((p) => key(p.t.schema, p.t.name) === key(schema, name));
  const fieldFor = (part: (typeof parts)[number], col: string) => part.fields[part.t.columns.findIndex((c) => c.name === col)]?.name ?? fieldName(col);

  // Pass 2: a relation field per foreign key whose table is in this run, and the back-relation on the referenced model.
  // Keyless tables are @@ignore'd, and Prisma rejects relations to ignored models: they get none.
  for (const p of parts) {
    if (p.t.kind !== 'table' || !hasKey(p.t)) continue;
    for (const fk of p.t.foreignKeys) {
      const ref = partOf(fk.refSchema ?? p.t.schema, fk.refTable);
      if (!ref || ref.t.kind !== 'table' || !hasKey(ref.t)) continue;
      const named = p.t.foreignKeys.filter((f) => key(f.refSchema ?? p.t.schema, f.refTable) === key(ref.t.schema, ref.t.name)).length > 1 || ref === p;
      const relName = named ? `name: ${dq(fk.name)}, ` : '';
      const optional = fk.columns.some((c) => p.t.columns.find((x) => x.name === c)?.nullable);
      const base = fk.columns.length === 1 ? fk.columns[0].replace(/_?id$/i, '') : '';
      p.fields.push({
        name: p.used.take(ident(camel(base || ref.mName), 'r')), type: `${ref.mName}${optional ? '?' : ''}`, comment: null,
        attrs: [`@relation(${relName}fields: [${fk.columns.map((c) => fieldFor(p, c)).join(', ')}], references: [${fk.refColumns.map((c) => fieldFor(ref, c)).join(', ')}], map: ${dq(fk.name)})`],
      });
      // A foreign key over the whole primary key is one-to-one: the back-relation is a single optional field.
      const oneToOne = fk.columns.length === p.t.primaryKey.length && fk.columns.every((c) => p.t.primaryKey.includes(c));
      ref.fields.push({
        // Two relations between the same models: peopleByManager, peopleByMentor.
        name: ref.used.take(ident(camel(oneToOne ? (o.singularize ? singularize(p.t.name) : p.t.name) : named ? `${p.t.name}_by_${base || fk.name}` : p.t.name), 'r')),
        type: `${p.mName}${oneToOne ? '?' : '[]'}`, comment: null, attrs: named ? [`@relation(${dq(fk.name)})`] : [],
      });
    }
  }
  const out = parts.map((p) => modelBlock(p.t, p.mName, p.fields, p.notes, multi));

  const views = tables.some((t) => t.kind === 'view');
  const preview = [...(multi ? ['"multiSchema"'] : []), ...(views ? ['"views"'] : [])];
  const head = [
    `// Prisma schema generated by DbStudio from ${DIALECT_LABEL[input.dialect]}.`,
    '// Review relation names and run `npx prisma validate`; `npx prisma db pull` introspects the live database.',
    '',
    'generator client {',
    '  provider        = "prisma-client-js"',
    ...(preview.length ? [`  previewFeatures = [${preview.join(', ')}]`] : []),
    '}',
    '',
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    ...(multi ? [`  schemas  = [${schemas.map(dq).join(', ')}]`] : []),
    '}',
  ];
  const enumBlocks = [...enums.values()].map((e) => {
    const values = new NameScope([], false);
    return [
      `enum ${e.name} {`,
      ...e.labels.map((l) => {
        const v = values.take(ident(l, 'V'));
        return v === l ? `  ${l}` : `  ${v} @map(${dq(l)})`;
      }),
      '',
      ...(e.name !== e.db ? [`  @@map(${dq(e.db)})`] : []),
      ...(multi ? [`  @@schema(${dq(e.schema)})`] : []),
      '}',
    ].join('\n');
  });
  const content = [head.join('\n'), ...out, ...enumBlocks].join('\n\n') + '\n';
  return [{ path: 'schema.prisma', language: monacoLanguageOf('typescript', 'prisma'), content }];
}

function columnField(c: CgColumn, t: CgTable, used: NameScope, enumOf: (c: CgColumn, labels: string[], t: CgTable) => string, notes: string[]): Field {
  const rt = resolveType('pgsql', c.dbType, { enumLabels: c.enumLabels, domainBase: c.domainBase });
  const el = rt.array && rt.element ? rt.element : rt;
  const name = used.take(fieldName(c.name));
  const attrs: string[] = [];
  let type: string;
  let unsupported = false;
  if (el.enumLabels?.length) type = enumOf(c, el.enumLabels, t);
  else {
    const s = scalar(el);
    if (s) {
      type = s.type;
      if (s.db) attrs.push(s.db);
    } else {
      unsupported = true;
      // Unsupported types keep their database spelling (arrays included): Prisma Client cannot read or write them.
      type = `Unsupported(${dq(c.dbType)})`;
    }
  }
  // Prisma lists cannot be optional (a nullable array column is noted on the model).
  if (rt.array && !unsupported) type = `${type}[]`;
  else if (c.nullable) type += '?';
  const pk = t.primaryKey.length === 1 && t.primaryKey[0] === c.name;
  if (pk) attrs.unshift('@id');
  if (c.identity) attrs.push('@default(autoincrement())');
  else if (c.hasDefault && el.logical === 'guid') attrs.push('@default(dbgenerated("gen_random_uuid()"))');
  else if (c.hasDefault && (el.logical === 'datetime' || el.logical === 'datetimeoffset')) attrs.push('@default(now())');
  else if (c.hasDefault) attrs.push('@default(dbgenerated())');
  if (name !== c.name) attrs.push(`@map(${dq(c.name)})`);
  if (c.computed) notes.push(`${c.name} is a generated column (read-only; Prisma cannot declare it, writes are rejected by the server)`);
  if (rt.array && !unsupported && c.nullable) notes.push(`${c.name} is a nullable array: Prisma lists cannot be optional`);
  const comment = c.comment ? commentText(c.comment) : null;
  return { name, type, attrs, comment };
}

function modelBlock(t: CgTable, mName: string, fields: Field[], notes: string[], multi: boolean): string {
  const width = Math.max(...fields.map((f) => f.name.length));
  const twidth = Math.max(...fields.map((f) => f.type.length));
  const lines: string[] = [];
  const doc = commentText(t.comment);
  if (doc) lines.push(`/// ${doc}`);
  for (const n of notes) lines.push(`/// ${n}`);
  // Prisma needs a unique criterion per model / view; without one it must be ignored (as `prisma db pull` does).
  const keyless = !hasKey(t);
  if (keyless) lines.push(`/// The underlying ${t.kind} has no primary key: Prisma Client ignores it until a field is marked @id or @unique (then remove @@ignore).`);
  lines.push(`${t.kind === 'view' ? 'view' : 'model'} ${mName} {`);
  for (const f of fields) {
    if (f.comment) lines.push(`  /// ${f.comment}`);
    lines.push(`  ${f.name.padEnd(width)} ${f.attrs.length ? f.type.padEnd(twidth) : f.type}${f.attrs.length ? ` ${f.attrs.join(' ')}` : ''}`.trimEnd());
  }
  const fieldOf = (col: string) => fields[t.columns.findIndex((c) => c.name === col)]?.name ?? fieldName(col);
  const tail: string[] = [];
  if (t.primaryKey.length > 1) tail.push(`  @@id([${t.primaryKey.map(fieldOf).join(', ')}])`);
  if (mName !== t.name) tail.push(`  @@map(${dq(t.name)})`);
  if (multi) tail.push(`  @@schema(${dq(t.schema ?? 'public')})`);
  if (keyless) tail.push('  @@ignore');
  if (tail.length) lines.push('', ...tail);
  lines.push('}');
  return lines.join('\n');
}

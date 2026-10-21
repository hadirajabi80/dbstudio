// PostgreSQL table/view designer for the mock engine: a small TypeScript scripter producing the engine's script
// shape (docs/PLAN-PG.md 2.7), so the designer preview in `npm run dev:mock` and the component tests look like the real
// thing (types and features come from the recorded fixtures/m15/designer/pgsql-types.json). Not a full diff: renames,
// drops, adds, type / nullability / default / identity changes, constraints, indexes and comments.
import type {
  DdlStatement, ForeignKeyModel, IndexModel, TableColumnModel, TableModel, TableScriptRequest,
  TableScriptResponse, ViewScriptRequest,
} from '../../api/types';
import { quoteIdent } from '../../lib/sql';

const q = (s: string) => quoteIdent(s, 'pgsql');
const qn = (schema: string | null, name: string) => (schema ? `${q(schema)}.${q(name)}` : q(name));
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function identityClause(c: TableColumnModel): string {
  if (!c.identity) return '';
  const opts = c.identity.seed !== 1 || c.identity.increment !== 1 ? ` (START WITH ${c.identity.seed} INCREMENT BY ${c.identity.increment})` : '';
  return ` GENERATED ${c.identity.always ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${opts}`;
}

function columnDef(c: TableColumnModel): string {
  const parts = [q(c.name), c.type];
  if (c.collation) parts.push(`COLLATE ${q(c.collation)}`);
  let s = parts.join(' ');
  if (c.computed) s += ` GENERATED ALWAYS AS (${c.computed.expression}) STORED`;
  s += identityClause(c);
  if (c.default && !c.computed && !c.identity) s += ` DEFAULT ${c.default}`;
  if (!c.nullable) s += ' NOT NULL';
  return s;
}

function fkDef(f: ForeignKeyModel): string {
  const actions = `${f.onDelete !== 'NO ACTION' ? ` ON DELETE ${f.onDelete}` : ''}${f.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${f.onUpdate}` : ''}`;
  return `${f.name ? `CONSTRAINT ${q(f.name)} ` : ''}FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${qn(f.refSchema, f.refTable)} (${f.refColumns.map(q).join(', ')})${actions}`;
}

function indexSql(t: TableModel, x: IndexModel): string {
  const cols = x.columns.map((c) => `${q(c.name)}${c.desc ? ' DESC' : ''}`).join(', ');
  const include = x.include.length ? ` INCLUDE (${x.include.map(q).join(', ')})` : '';
  const where = x.filter ? ` WHERE ${x.filter}` : '';
  return `CREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${q(x.name)} ON ${qn(t.schema, t.name)} USING btree (${cols})${include}${where}`;
}

function comments(t: TableModel, old: TableModel | null): DdlStatement[] {
  const out: DdlStatement[] = [];
  const table = qn(t.schema, t.name);
  if ((t.comment ?? null) !== (old?.comment ?? null)) out.push({ sql: `COMMENT ON TABLE ${table} IS ${t.comment ? lit(t.comment) : 'NULL'}`, kind: 'comment', warning: null });
  for (const c of t.columns) {
    const before = old?.columns.find((o) => (o.id ?? o.name) === (c.id ?? c.name));
    if ((c.comment ?? null) !== (before?.comment ?? null)) out.push({ sql: `COMMENT ON COLUMN ${table}.${q(c.name)} IS ${c.comment ? lit(c.comment) : 'NULL'}`, kind: 'comment', warning: null });
  }
  return out;
}

function warningsFor(t: TableModel): string[] {
  const w: string[] = [];
  if (t.columns.some((c) => c.computed && !c.computed.persisted)) w.push('PostgreSQL only supports STORED generated columns');
  if (t.primaryKey?.clustered || t.indexes.some((i) => i.clustered)) w.push('PostgreSQL has no clustered indexes; the option is ignored');
  return w;
}

/** CREATE TABLE … / ALTER TABLE … in PgDdlScripter's shape; one transaction, never a rebuild. */
export function scriptPgTable(req: TableScriptRequest): TableScriptResponse {
  const t = req.desired;
  const o = req.original;
  const table = qn(t.schema, t.name);
  const statements: DdlStatement[] = [];
  if (!o) {
    const lines = t.columns.map(columnDef);
    if (t.primaryKey?.columns.length) lines.push(`${t.primaryKey.name ? `CONSTRAINT ${q(t.primaryKey.name)} ` : ''}PRIMARY KEY (${t.primaryKey.columns.map(q).join(', ')})`);
    for (const u of t.uniques) lines.push(`${u.name ? `CONSTRAINT ${q(u.name)} ` : ''}UNIQUE (${u.columns.map(q).join(', ')})`);
    for (const c of t.checks) lines.push(`${c.name ? `CONSTRAINT ${q(c.name)} ` : ''}CHECK (${c.expression})`);
    for (const f of t.foreignKeys) lines.push(fkDef(f));
    const tablespace = t.options.tablespace ? `\nTABLESPACE ${q(t.options.tablespace)}` : '';
    statements.push({ sql: `CREATE TABLE ${table} (\n    ${lines.join(',\n    ')}\n)${tablespace}`, kind: 'create', warning: null });
    for (const x of t.indexes) statements.push({ sql: indexSql(t, x), kind: 'index', warning: null });
    statements.push(...comments(t, null));
    return { statements, rebuildRequired: false, transactional: true, warnings: warningsFor(t), changes: [] };
  }
  const oldTable = qn(o.schema, o.name);
  if (o.name !== t.name) statements.push({ sql: `ALTER TABLE ${oldTable} RENAME TO ${q(t.name)}`, kind: 'rename', warning: null });
  const sub: string[] = [];
  const byId = new Map(o.columns.map((c) => [c.id ?? c.name, c]));
  for (const c of t.columns) {
    const before = byId.get(c.id ?? c.name);
    if (before && before.name !== c.name) statements.push({ sql: `ALTER TABLE ${table} RENAME COLUMN ${q(before.name)} TO ${q(c.name)}`, kind: 'rename', warning: null });
  }
  for (const c of o.columns) if (!t.columns.some((d) => (d.id ?? d.name) === (c.id ?? c.name))) sub.push(`DROP COLUMN ${q(c.name)}`);
  for (const c of t.columns) {
    const before = byId.get(c.id ?? c.name);
    if (!before) {
      sub.push(`ADD COLUMN ${columnDef(c)}`);
      continue;
    }
    const col = q(c.name);
    if (before.type !== c.type) sub.push(`ALTER COLUMN ${col} TYPE ${c.type} USING ${col}::${c.type}`);
    if (before.nullable !== c.nullable) sub.push(`ALTER COLUMN ${col} ${c.nullable ? 'DROP' : 'SET'} NOT NULL`);
    if ((before.default ?? null) !== (c.default ?? null)) sub.push(c.default ? `ALTER COLUMN ${col} SET DEFAULT ${c.default}` : `ALTER COLUMN ${col} DROP DEFAULT`);
    if (!before.identity && c.identity) sub.push(`ALTER COLUMN ${col} ADD${identityClause(c)}`);
    else if (before.identity && !c.identity) sub.push(`ALTER COLUMN ${col} DROP IDENTITY IF EXISTS`);
    else if (before.identity && c.identity && !!before.identity.always !== !!c.identity.always) sub.push(`ALTER COLUMN ${col} SET GENERATED ${c.identity.always ? 'ALWAYS' : 'BY DEFAULT'}`);
  }
  const key = (v: unknown) => JSON.stringify(v);
  if (key(o.primaryKey) !== key(t.primaryKey)) {
    if (o.primaryKey) sub.push(`DROP CONSTRAINT ${q(o.primaryKey.name ?? `${o.name}_pkey`)}`);
    if (t.primaryKey?.columns.length) sub.push(`ADD ${t.primaryKey.name ? `CONSTRAINT ${q(t.primaryKey.name)} ` : ''}PRIMARY KEY (${t.primaryKey.columns.map(q).join(', ')})`);
  }
  for (const f of o.foreignKeys) if (!t.foreignKeys.some((g) => key(g) === key(f)) && f.name) sub.push(`DROP CONSTRAINT ${q(f.name)}`);
  for (const f of t.foreignKeys) if (!o.foreignKeys.some((g) => key(g) === key(f))) sub.push(`ADD ${fkDef(f)}`);
  for (const c of o.checks) if (!t.checks.some((g) => key(g) === key(c)) && c.name) sub.push(`DROP CONSTRAINT ${q(c.name)}`);
  for (const c of t.checks) if (!o.checks.some((g) => key(g) === key(c))) sub.push(`ADD ${c.name ? `CONSTRAINT ${q(c.name)} ` : ''}CHECK (${c.expression})`);
  // Column and constraint subcommands of one table go into one ALTER TABLE (one table rewrite).
  if (sub.length) statements.push({ sql: `ALTER TABLE ${table}\n    ${sub.join(',\n    ')}`, kind: sub.some((s) => s.startsWith('DROP')) ? 'drop' : 'alter', warning: null });
  for (const x of o.indexes) if (!t.indexes.some((y) => key(y) === key(x))) statements.push({ sql: `DROP INDEX ${qn(t.schema, x.name)}`, kind: 'drop', warning: null });
  for (const x of t.indexes) if (!o.indexes.some((y) => key(y) === key(x))) statements.push({ sql: indexSql(t, x), kind: 'index', warning: null });
  statements.push(...comments(t, o));
  return { statements, rebuildRequired: false, transactional: true, warnings: warningsFor(t), changes: [] };
}

export function scriptPgView(req: ViewScriptRequest): { statements: DdlStatement[]; rebuildRequired: boolean; transactional: boolean; warnings: string[] } {
  const statements: DdlStatement[] = [];
  if (req.originalName && req.originalName !== req.name) {
    statements.push({ sql: `ALTER VIEW ${qn(req.schema, req.originalName)} RENAME TO ${q(req.name)}`, kind: 'rename', warning: null });
  }
  const body = req.body.trim().replace(/;\s*$/, '');
  statements.push({ sql: `CREATE OR REPLACE VIEW ${qn(req.schema, req.name)} AS\n${body}${req.options.checkOption ? '\nWITH CASCADED CHECK OPTION' : ''}`, kind: req.originalName ? 'alter' : 'create', warning: null });
  const warnings = ['CREATE OR REPLACE can only append columns; drop the view first to remove or retype columns'];
  if (req.options.schemaBinding) warnings.push('SCHEMABINDING is ignored by PostgreSQL');
  if (req.options.force) warnings.push('FORCE is ignored by PostgreSQL');
  return { statements, rebuildRequired: false, transactional: true, warnings };
}

/** Designer model of a catalog table (columns as the catalog reports them). */
export function pgTableModel(schema: string, name: string, columns: { name: string; type: string; nullable: boolean; pk?: boolean; identity?: boolean; comment?: string | null; default?: string | null }[], fks: ForeignKeyModel[], comment: string | null): TableModel {
  const pk = columns.filter((c) => c.pk).map((c) => c.name);
  return {
    schema, name, comment, options: { withoutRowid: false, strict: false, tablespace: null },
    columns: columns.map((c) => ({
      id: c.name, name: c.name, type: c.type, nullable: c.nullable, default: c.identity ? null : c.default ?? null, defaultName: null,
      identity: c.identity ? { seed: 1, increment: 1, always: false } : null, computed: null, collation: null, comment: c.comment ?? null, autoincrement: false,
    })),
    primaryKey: pk.length ? { name: `${name}_pkey`, columns: pk, clustered: false } : null,
    uniques: [], indexes: [], foreignKeys: fks, checks: [],
  };
}

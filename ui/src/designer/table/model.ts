// Pure editing operations of the table designer over the wire TableModel (docs/PLAN-M1.5.md 1.3.1 / 3.9).
// Every operation returns a new model; constraint/index column lists follow column renames and removals.
import type {
  CheckModel, Dialect, ForeignKeyModel, IndexModel, ReferentialAction, TableColumnModel, TableModel, UniqueModel,
} from '../../api/types';

export const DEFAULT_COLUMN_TYPE: Record<Dialect, string> = { tsql: 'nvarchar(100)', plsql: 'VARCHAR2(100)', sqlite: 'TEXT' };
export const DEFAULT_KEY_TYPE: Record<Dialect, string> = { tsql: 'int', plsql: 'NUMBER(10)', sqlite: 'INTEGER' };

export function caseFor(dialect: Dialect, name: string): string {
  return dialect === 'plsql' ? name.toUpperCase() : dialect === 'sqlite' ? name.toLowerCase() : name;
}

export function blankColumn(dialect: Dialect, name: string, type = DEFAULT_COLUMN_TYPE[dialect]): TableColumnModel {
  return {
    id: null, name, type, nullable: true, default: null, defaultName: null, identity: null, computed: null, collation: null, comment: null,
    autoincrement: false,
  };
}

/** A new table: one surrogate key column, as most tables start. */
export function newTableModel(dialect: Dialect, schema: string | null, name = ''): TableModel {
  const id = {
    ...blankColumn(dialect, caseFor(dialect, 'Id'), DEFAULT_KEY_TYPE[dialect]),
    nullable: false,
    identity: dialect === 'sqlite' ? null : { seed: 1, increment: 1 },
  };
  return {
    schema: dialect === 'sqlite' ? schema ?? 'main' : schema,
    name,
    comment: null,
    options: { withoutRowid: false, strict: false, tablespace: null },
    columns: [id],
    primaryKey: { name: null, columns: [id.name], clustered: dialect === 'tsql' },
    uniques: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
  };
}

/** Stable ids for a model read from the server (id = original name, so a rename is detectable by the diff). */
export function withIds(t: TableModel): TableModel {
  return { ...t, columns: t.columns.map((c) => ({ ...c, id: c.id ?? c.name })) };
}

const renameIn = (cols: string[], from: string, to: string) => cols.map((c) => (c === from ? to : c));
const without = (cols: string[], name: string) => cols.filter((c) => c !== name);

/** Next free "Column1", "Column2", ... (in the dialect's case). */
export function nextColumnName(t: TableModel, dialect: Dialect, base = 'Column'): string {
  const used = new Set(t.columns.map((c) => c.name.toLowerCase()));
  for (let i = 1; ; i++) {
    const n = caseFor(dialect, `${base}${i}`);
    if (!used.has(n.toLowerCase())) return n;
  }
}

export function addColumn(t: TableModel, dialect: Dialect, at = t.columns.length, patch: Partial<TableColumnModel> = {}): TableModel {
  const col = { ...blankColumn(dialect, nextColumnName(t, dialect)), ...patch };
  const columns = [...t.columns];
  columns.splice(Math.max(0, Math.min(at, columns.length)), 0, col);
  return { ...t, columns };
}

export function removeColumn(t: TableModel, index: number): TableModel {
  const col = t.columns[index];
  if (!col) return t;
  const name = col.name;
  const pk = t.primaryKey ? { ...t.primaryKey, columns: without(t.primaryKey.columns, name) } : null;
  return {
    ...t,
    columns: t.columns.filter((_, i) => i !== index),
    primaryKey: pk && pk.columns.length ? pk : null,
    uniques: t.uniques.map((u) => ({ ...u, columns: without(u.columns, name) })).filter((u) => u.columns.length),
    indexes: t.indexes
      .map((x) => ({ ...x, columns: x.columns.filter((c) => c.name !== name), include: without(x.include, name) }))
      .filter((x) => x.columns.length),
    foreignKeys: t.foreignKeys.filter((f) => !f.columns.includes(name)),
  };
}

export function moveColumn(t: TableModel, index: number, delta: number): TableModel {
  const to = index + delta;
  if (index < 0 || index >= t.columns.length || to < 0 || to >= t.columns.length) return t;
  const columns = [...t.columns];
  const [c] = columns.splice(index, 1);
  columns.splice(to, 0, c);
  return { ...t, columns };
}

export function duplicateColumn(t: TableModel, index: number, dialect: Dialect): TableModel {
  const src = t.columns[index];
  if (!src) return t;
  const used = new Set(t.columns.map((c) => c.name.toLowerCase()));
  let name = `${src.name}${dialect === 'plsql' ? '_COPY' : '_copy'}`;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${src.name}${dialect === 'plsql' ? '_COPY' : '_copy'}${i}`;
  const copy: TableColumnModel = { ...src, id: null, name, identity: null, autoincrement: false, defaultName: null };
  const columns = [...t.columns];
  columns.splice(index + 1, 0, copy);
  return { ...t, columns };
}

/** Patch a column; a rename is propagated to keys, indexes, uniques and foreign keys. */
export function updateColumn(t: TableModel, index: number, patch: Partial<TableColumnModel>, dialect: Dialect): TableModel {
  const old = t.columns[index];
  if (!old) return t;
  let col: TableColumnModel = { ...old, ...patch };
  // Invariants: identity / autoincrement / PK columns are NOT NULL; only one identity column.
  if ((patch.identity && col.identity) || (patch.autoincrement && col.autoincrement)) col = { ...col, nullable: false };
  let columns = t.columns.map((c, i) => (i === index ? col : c));
  if (patch.identity) columns = columns.map((c, i) => (i !== index && c.identity ? { ...c, identity: null } : c));
  if (patch.autoincrement) columns = columns.map((c, i) => (i !== index && c.autoincrement ? { ...c, autoincrement: false } : c));
  let next: TableModel = { ...t, columns };
  if (patch.name !== undefined && patch.name !== old.name) next = renameReferences(next, old.name, patch.name);
  if (col.autoincrement && dialect === 'sqlite') next = { ...next, primaryKey: { name: next.primaryKey?.name ?? null, columns: [col.name], clustered: false } };
  if (patch.nullable === true && next.primaryKey?.columns.includes(col.name)) {
    next = { ...next, columns: next.columns.map((c, i) => (i === index ? { ...c, nullable: false } : c)) };
  }
  return next;
}

function renameReferences(t: TableModel, from: string, to: string): TableModel {
  return {
    ...t,
    primaryKey: t.primaryKey ? { ...t.primaryKey, columns: renameIn(t.primaryKey.columns, from, to) } : null,
    uniques: t.uniques.map((u) => ({ ...u, columns: renameIn(u.columns, from, to) })),
    indexes: t.indexes.map((x) => ({ ...x, columns: x.columns.map((c) => (c.name === from ? { ...c, name: to } : c)), include: renameIn(x.include, from, to) })),
    foreignKeys: t.foreignKeys.map((f) => ({ ...f, columns: renameIn(f.columns, from, to) })),
  };
}

/** Toggle a column in the primary key (appended in key order); PK columns become NOT NULL. */
export function togglePrimaryKey(t: TableModel, index: number, dialect: Dialect): TableModel {
  const col = t.columns[index];
  if (!col) return t;
  const cols = t.primaryKey?.columns ?? [];
  const inPk = cols.includes(col.name);
  const nextCols = inPk ? without(cols, col.name) : [...cols, col.name];
  const pk = nextCols.length ? { name: t.primaryKey?.name ?? null, columns: nextCols, clustered: t.primaryKey?.clustered ?? dialect === 'tsql' } : null;
  const columns = t.columns.map((c, i) => (i === index && !inPk ? { ...c, nullable: false } : i === index && inPk ? { ...c, autoincrement: false } : c));
  return { ...t, primaryKey: pk, columns };
}

export function setPrimaryKeyOrder(t: TableModel, columns: string[]): TableModel {
  if (!t.primaryKey) return t;
  return { ...t, primaryKey: { ...t.primaryKey, columns } };
}

// ---------------- constraints ----------------

const cleanName = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, '_');

export function defaultConstraintName(t: TableModel, dialect: Dialect, prefix: 'PK' | 'UQ' | 'IX' | 'FK' | 'CK', parts: string[]): string {
  const raw = [prefix, cleanName(t.name || 'Table'), ...parts.map(cleanName)].filter(Boolean).join('_');
  const n = dialect === 'plsql' ? raw.toUpperCase().slice(0, 128) : dialect === 'sqlite' ? raw.toLowerCase() : raw;
  return n;
}

export function addIndex(t: TableModel, dialect: Dialect, columns: string[] = []): TableModel {
  const cols = columns.length ? columns : t.columns.slice(0, 1).map((c) => c.name);
  let name = defaultConstraintName(t, dialect, 'IX', cols);
  const used = new Set(t.indexes.map((i) => i.name.toLowerCase()));
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${defaultConstraintName(t, dialect, 'IX', cols)}_${i}`;
  const idx: IndexModel = { name, columns: cols.map((c) => ({ name: c, desc: false })), unique: false, clustered: false, include: [], filter: null };
  return { ...t, indexes: [...t.indexes, idx] };
}

export function updateIndex(t: TableModel, i: number, patch: Partial<IndexModel>): TableModel {
  return { ...t, indexes: t.indexes.map((x, k) => (k === i ? { ...x, ...patch } : x)) };
}

export function removeIndex(t: TableModel, i: number): TableModel {
  return { ...t, indexes: t.indexes.filter((_, k) => k !== i) };
}

export function addUnique(t: TableModel, dialect: Dialect, columns: string[] = []): TableModel {
  const cols = columns.length ? columns : t.columns.slice(0, 1).map((c) => c.name);
  const u: UniqueModel = { name: defaultConstraintName(t, dialect, 'UQ', cols), columns: cols };
  return { ...t, uniques: [...t.uniques, u] };
}

export function updateUnique(t: TableModel, i: number, patch: Partial<UniqueModel>): TableModel {
  return { ...t, uniques: t.uniques.map((x, k) => (k === i ? { ...x, ...patch } : x)) };
}

export function removeUnique(t: TableModel, i: number): TableModel {
  return { ...t, uniques: t.uniques.filter((_, k) => k !== i) };
}

export function addForeignKey(t: TableModel, dialect: Dialect, fk: Partial<ForeignKeyModel> = {}): TableModel {
  const refTable = fk.refTable ?? '';
  const f: ForeignKeyModel = {
    name: fk.name ?? defaultConstraintName(t, dialect, 'FK', [refTable || 'Ref']),
    columns: fk.columns ?? [],
    refSchema: fk.refSchema ?? t.schema,
    refTable,
    refColumns: fk.refColumns ?? [],
    onDelete: fk.onDelete ?? 'NO ACTION',
    onUpdate: fk.onUpdate ?? 'NO ACTION',
  };
  return { ...t, foreignKeys: [...t.foreignKeys, f] };
}

export function updateForeignKey(t: TableModel, i: number, patch: Partial<ForeignKeyModel>): TableModel {
  return { ...t, foreignKeys: t.foreignKeys.map((x, k) => (k === i ? { ...x, ...patch } : x)) };
}

export function removeForeignKey(t: TableModel, i: number): TableModel {
  return { ...t, foreignKeys: t.foreignKeys.filter((_, k) => k !== i) };
}

export function addCheck(t: TableModel, dialect: Dialect): TableModel {
  const c: CheckModel = { name: defaultConstraintName(t, dialect, 'CK', [String(t.checks.length + 1)]), expression: '' };
  return { ...t, checks: [...t.checks, c] };
}

export function updateCheck(t: TableModel, i: number, patch: Partial<CheckModel>): TableModel {
  return { ...t, checks: t.checks.map((x, k) => (k === i ? { ...x, ...patch } : x)) };
}

export function removeCheck(t: TableModel, i: number): TableModel {
  return { ...t, checks: t.checks.filter((_, k) => k !== i) };
}

/** ON DELETE / ON UPDATE actions per dialect (Oracle: no ON UPDATE, no RESTRICT). */
export function referentialActions(dialect: Dialect, which: 'delete' | 'update'): ReferentialAction[] {
  if (dialect === 'plsql') return which === 'delete' ? ['NO ACTION', 'CASCADE', 'SET NULL'] : ['NO ACTION'];
  if (dialect === 'tsql') return ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'];
  return ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'];
}

// ---------------- validation / dirty ----------------

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  /** Column index the issue belongs to (grid highlight). */
  column?: number;
}

const INTEGER_TYPES = /^(tinyint|smallint|int|integer|bigint|number|numeric|decimal)\b/i;

export function validateTable(t: TableModel, dialect: Dialect): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!t.name.trim()) out.push({ severity: 'error', message: 'The table needs a name.' });
  if (!t.columns.length) out.push({ severity: 'error', message: 'Add at least one column.' });
  const seen = new Map<string, number>();
  t.columns.forEach((c, i) => {
    if (!c.name.trim()) out.push({ severity: 'error', message: `Column ${i + 1} needs a name.`, column: i });
    const k = c.name.trim().toLowerCase();
    if (k && seen.has(k)) out.push({ severity: 'error', message: `Duplicate column name “${c.name}”.`, column: i });
    seen.set(k, i);
    if (!c.type.trim() && !c.computed) out.push({ severity: 'error', message: `Column “${c.name || i + 1}” needs a type.`, column: i });
    if (c.identity && !INTEGER_TYPES.test(c.type.trim())) out.push({ severity: 'error', message: `Identity column “${c.name}” must have an integer type.`, column: i });
    if (c.autoincrement && !/^integer$/i.test(c.type.trim())) out.push({ severity: 'error', message: `AUTOINCREMENT needs type INTEGER (“${c.name}”).`, column: i });
    if (c.computed && !c.computed.expression.trim()) out.push({ severity: 'error', message: `Computed column “${c.name}” needs an expression.`, column: i });
  });
  if (!t.primaryKey?.columns.length) out.push({ severity: 'warning', message: 'The table has no primary key.' });
  if (t.options.withoutRowid && dialect === 'sqlite' && !t.primaryKey?.columns.length) out.push({ severity: 'error', message: 'WITHOUT ROWID tables need a primary key.' });
  for (const f of t.foreignKeys) {
    if (!f.refTable) out.push({ severity: 'error', message: `Foreign key ${f.name ?? ''} needs a referenced table.` });
    else if (!f.columns.length || f.columns.length !== f.refColumns.length) out.push({ severity: 'error', message: `Foreign key ${f.name ?? ''}: pick as many columns as referenced columns.` });
  }
  for (const c of t.checks) if (!c.expression.trim()) out.push({ severity: 'error', message: `Check ${c.name ?? ''} needs an expression.` });
  for (const x of t.indexes) if (!x.columns.length) out.push({ severity: 'error', message: `Index ${x.name} needs at least one column.` });
  return out;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** Canonical JSON for dirty checks (key order independent). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = canonical((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

export function sameModel(a: TableModel | null, b: TableModel | null): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Parse `nvarchar(100)` / `NUMBER(10,2)` / `varchar(max)`. */
export function parseType(text: string): { base: string; args: string[] } {
  const m = /^\s*([^()]+?)\s*(?:\(([^)]*)\))?\s*(.*)$/.exec(text);
  if (!m) return { base: text.trim(), args: [] };
  const base = `${m[1]}${m[3] ? ' ' + m[3] : ''}`.trim();
  return { base, args: m[2] ? m[2].split(',').map((s) => s.trim()) : [] };
}

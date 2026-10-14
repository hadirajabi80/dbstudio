// Name binding over the statement model + catalog index: sources, output columns, qualifiers, variables.
import type { CatalogObjectType } from '../../api/types';
import type { CatalogIndex, NameRef, ObjectEntry, SchemaEntry } from './index';
import type { ColumnDef, CteDef, NamePart, Scope, TableRef, TempTableDef, VarDef } from '../parse/statement-model';

export interface DocSymbols {
  /** Temp tables / tables created earlier in the document (and in the current statement). Key: upper name. */
  tables: Map<string, TempTableDef>;
  /** Variables declared earlier in the same batch (T-SQL). Key: upper name. */
  variables: Map<string, VarDef>;
}

export const EMPTY_SYMBOLS: DocSymbols = { tables: new Map(), variables: new Map() };

export interface ResolvedSource {
  ref: TableRef;
  /** Name used to qualify columns: alias, else the object name. */
  label: string;
  entry: ObjectEntry | null;
  synonym: ObjectEntry | null;
  cte: CteDef | null;
  temp: TempTableDef | null;
  variable: VarDef | null;
  /** `dbo.Customers`, `cte big`, `#tmp`, `(subquery)`. */
  display: string;
  /** Short table name for details (`Customers`). */
  shortName: string;
  unresolved: boolean;
  columns(): ColumnDef[];
}

export interface VisibleSource { src: ResolvedSource; level: number }

export type QualifierTarget =
  | { kind: 'source'; src: ResolvedSource }
  | { kind: 'record'; name: string; columns: ColumnDef[]; variable: VarDef }
  | { kind: 'object'; entry: ObjectEntry }
  | { kind: 'schema'; schema: SchemaEntry | null; name: string; database?: string }
  | { kind: 'database'; name: string }
  | { kind: 'package'; entry: ObjectEntry }
  | { kind: 'sequence'; entry: ObjectEntry };

const TABULAR = (e: ObjectEntry) => e.isTabular;

export class Binder {
  readonly index: CatalogIndex;
  readonly symbols: DocSymbols;
  private readonly cache = new WeakMap<TableRef, ResolvedSource>();
  private readonly outCache = new WeakMap<Scope, ColumnDef[]>();
  private depth = 0;

  constructor(index: CatalogIndex, symbols: DocSymbols = EMPTY_SYMBOLS) {
    this.index = index;
    this.symbols = symbols;
  }

  key(p: NameRef): string { return this.index.keyOf(p.text, p.quoted); }
  sameName(a: NameRef, b: NameRef): boolean { return this.key(a) === this.key(b); }

  // ------------------------------------------------------------ sources

  source(ref: TableRef, scope: Scope): ResolvedSource {
    const c = this.cache.get(ref);
    if (c) return c;
    const r = this.resolveSource(ref, scope);
    this.cache.set(ref, r);
    return r;
  }

  private mk(ref: TableRef, init: Partial<ResolvedSource> & { display: string; shortName: string; columns: () => ColumnDef[] }): ResolvedSource {
    const label = ref.alias ?? (ref.parts.length ? ref.parts[ref.parts.length - 1].text : init.shortName);
    let cached: ColumnDef[] | null = null;
    const colsFn = init.columns;
    return {
      ref, label, entry: null, synonym: null, cte: null, temp: null, variable: null, unresolved: false, ...init,
      columns: () => (cached ??= this.guard(colsFn)),
    };
  }

  private guard(fn: () => ColumnDef[]): ColumnDef[] {
    if (this.depth > 12) return [];
    this.depth++;
    try { return fn(); } finally { this.depth--; }
  }

  private resolveSource(ref: TableRef, scope: Scope): ResolvedSource {
    if ((ref.kind === 'subquery' || ref.kind === 'values') && ref.subScope) {
      const sub = ref.subScope;
      return this.mk(ref, {
        display: ref.kind === 'values' ? '(values)' : '(subquery)', shortName: ref.alias ?? 'subquery',
        columns: () => renameColumns(this.outputColumns(sub), ref.columnAliases),
      });
    }
    const parts = ref.parts;
    if (parts.length === 0) return this.mk(ref, { display: '?', shortName: '?', unresolved: true, columns: () => [] });
    const last = parts[parts.length - 1];
    if (ref.remote) return this.mk(ref, { display: parts.map((p) => p.text).join('.'), shortName: last.text, unresolved: true, columns: () => [] });
    if (ref.kind === 'tableVar') {
      const v = this.findVar(last.text, scope);
      if (v) return this.mk(ref, { display: v.name, shortName: v.name, variable: v, columns: () => v.columns ?? [] });
      const t = this.symbols.tables.get(last.text.toUpperCase());
      if (t) return this.mk(ref, { display: t.name, shortName: t.name, temp: t, columns: () => this.tempColumns(t) });
      return this.mk(ref, { display: last.text, shortName: last.text, unresolved: true, columns: () => [] });
    }
    if (parts.length === 1 && !last.quoted && last.text.startsWith('#')) {
      const t = this.symbols.tables.get(last.text.toUpperCase());
      if (t) return this.mk(ref, { display: t.name, shortName: t.name, temp: t, columns: () => this.tempColumns(t) });
      return this.mk(ref, { display: last.text, shortName: last.text, unresolved: true, columns: () => [] });
    }
    if (parts.length === 1) {
      const cte = this.findCte(last, scope);
      if (cte) {
        return this.mk(ref, { display: `cte ${cte.name}`, shortName: cte.name, cte, columns: () => this.cteColumns(cte) });
      }
      const t = this.symbols.tables.get(last.text.toUpperCase());
      if (t && (t.kind !== 'table' || !this.index.resolve([last], TABULAR))) {
        return this.mk(ref, { display: t.name, shortName: t.name, temp: t, columns: () => this.tempColumns(t) });
      }
    }
    const pred = ref.kind === 'function' ? (e: ObjectEntry) => e.type === 'tablefunc' || e.isTabular : TABULAR;
    const raw = this.index.resolveRaw(parts, (e) => e.type === 'synonym' || pred(e));
    if (raw) {
      const syn = raw.type === 'synonym' ? raw : null;
      const target = syn ? this.index.followSynonym(syn) : raw;
      const e = target && pred(target) ? target : null;
      if (e) {
        return this.mk(ref, {
          display: syn ? `${syn.qualifiedName} → ${e.qualifiedName}` : e.qualifiedName, shortName: e.name, entry: e, synonym: syn,
          columns: () => e.columns(),
        });
      }
      return this.mk(ref, { display: raw.qualifiedName, shortName: raw.name, synonym: syn, unresolved: true, columns: () => [] });
    }
    if (parts.length === 1 && this.index.spec.id === 'plsql') {
      const pub = this.index.requestPublicSynonym(last.quoted ? last.text : last.text.toUpperCase());
      if (pub) {
        return this.mk(ref, { display: `PUBLIC.${pub.name}`, shortName: pub.name, entry: pub, columns: () => pub.columns() });
      }
    }
    // tables created earlier in the script (CREATE TABLE x) but not in the catalog yet
    const t = this.symbols.tables.get(last.text.toUpperCase());
    if (t) return this.mk(ref, { display: t.name, shortName: t.name, temp: t, columns: () => this.tempColumns(t) });
    return this.mk(ref, { display: parts.map((p) => p.text).join('.'), shortName: last.text, unresolved: true, columns: () => [] });
  }

  tempColumns(t: TempTableDef): ColumnDef[] {
    if (t.columns) return t.columns;
    if (t.likeParts) {
      const e = this.index.resolve(t.likeParts, TABULAR);
      return e ? e.columns() : [];
    }
    if (t.fromScope) return this.outputColumns(t.fromScope);
    return [];
  }

  findCte(name: NameRef, scope: Scope | null): CteDef | null {
    for (let s = scope; s; s = s.parent) {
      for (const c of s.ctes) if (this.key({ text: c.name, quoted: c.quoted }) === this.key(name)) return c;
    }
    return null;
  }

  cteColumns(cte: CteDef): ColumnDef[] {
    const body = cte.body ? this.outputColumns(cte.body) : [];
    if (cte.columns && cte.columns.length) return renameColumns(body, cte.columns, true);
    return body;
  }

  /** Effective sources of a scope (UPDATE alias targets de-duplicated). */
  ownSources(scope: Scope): ResolvedSource[] {
    const out: ResolvedSource[] = [];
    for (const ref of scope.sources) {
      if (ref.isTarget && !ref.alias && ref.parts.length === 1) {
        const other = scope.sources.find((r) => r !== ref && r.alias && this.sameName({ text: r.alias, quoted: !!r.aliasQuoted }, ref.parts[0]));
        if (other) continue;
      }
      out.push(this.source(ref, scope));
    }
    return out;
  }

  /** Sources visible in a scope: own first (level 0), then correlated outer scopes. */
  visibleSources(scope: Scope): VisibleSource[] {
    const out: VisibleSource[] = [];
    let level = 0;
    for (let s: Scope | null = scope; s; s = s.outer, level++) {
      for (const src of this.ownSources(s)) out.push({ src, level });
      if (level > 8) break;
    }
    return out;
  }

  /** Resolve a target table (INSERT/UPDATE/DELETE/MERGE), following T-SQL `UPDATE alias ... FROM t alias`. */
  target(scope: Scope): ResolvedSource | null {
    const ref = scope.targetTable;
    if (!ref) return null;
    if (!ref.alias && ref.parts.length === 1) {
      const other = scope.sources.find((r) => r !== ref && r.alias && this.sameName({ text: r.alias, quoted: !!r.aliasQuoted }, ref.parts[0]));
      if (other) return this.source(other, scope);
    }
    return this.source(ref, scope);
  }

  findSourceByLabel(name: NameRef, scope: Scope): VisibleSource | null {
    const vis = this.visibleSources(scope);
    const k = this.key(name);
    for (const v of vis) if (v.src.ref.alias && this.index.keyOf(v.src.ref.alias, !!v.src.ref.aliasQuoted) === k) return v;
    for (const v of vis) {
      if (v.src.ref.alias) continue;
      const p = v.src.ref.parts;
      if (p.length && this.key(p[p.length - 1]) === k) return v;
    }
    return null;
  }

  /** Output columns of a query scope (projections with `*` expanded). */
  outputColumns(scope: Scope): ColumnDef[] {
    const c = this.outCache.get(scope);
    if (c) return c;
    const out: ColumnDef[] = [];
    this.outCache.set(scope, out); // recursion guard (recursive CTE)
    const own = this.ownSources(scope);
    for (const p of scope.projections) {
      if (p.assignment) continue;
      if (p.star) {
        if (p.star.qualifier.length === 0) {
          for (const s of own) for (const col of s.columns()) out.push({ ...col, ordinal: out.length + 1 });
        } else {
          const q = p.star.qualifier[p.star.qualifier.length - 1];
          const src = own.find((s) => (s.ref.alias ? this.index.keyOf(s.ref.alias, !!s.ref.aliasQuoted) : this.key(s.ref.parts[s.ref.parts.length - 1] ?? q)) === this.key(q));
          if (src) for (const col of src.columns()) out.push({ ...col, ordinal: out.length + 1 });
        }
        continue;
      }
      let name = p.alias ?? p.colRef?.name.text ?? null;
      if (!name) continue;
      // Oracle: unquoted output names fold to upper case
      const quoted = p.alias ? !!p.aliasQuoted : !!p.colRef?.name.quoted;
      if (this.index.spec.caseFolding === 'upper' && !quoted) name = name.toUpperCase();
      let base: ColumnDef | undefined;
      if (p.colRef) base = this.lookupColumnRef(p.colRef.qualifier, p.colRef.name, scope, own);
      out.push({
        name, type: base?.type ?? '', nullable: base?.nullable, isPk: base?.isPk, comment: base?.comment,
        ordinal: out.length + 1, origin: base?.origin, defRange: p.aliasRange ?? p.range,
      });
    }
    return out;
  }

  private lookupColumnRef(qualifier: NamePart[], name: NamePart, scope: Scope, own: ResolvedSource[]): ColumnDef | undefined {
    const k = this.key(name);
    if (qualifier.length) {
      const q = qualifier[qualifier.length - 1];
      const v = this.findSourceByLabel(q, scope);
      return v?.src.columns().find((c) => this.index.keyOfCatalog(c.name) === k || c.name.toUpperCase() === name.text.toUpperCase());
    }
    for (const s of own) {
      const col = s.columns().find((c) => this.index.keyOfCatalog(c.name) === k);
      if (col) return col;
    }
    return undefined;
  }

  // ------------------------------------------------------------ variables

  /** Variables visible from a scope: local declarations (inner first) and earlier batch declarations. */
  variables(scope: Scope): VarDef[] {
    const out: VarDef[] = [];
    const seen = new Set<string>();
    for (let s: Scope | null = scope; s; s = s.parent) {
      for (const [k, v] of s.localVars) if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
    for (const [k, v] of this.symbols.variables) if (!seen.has(k)) { seen.add(k); out.push(v); }
    return out;
  }

  findVar(name: string, scope: Scope): VarDef | null {
    const k = (name.startsWith(':') ? name.slice(1) : name).toUpperCase();
    for (let s: Scope | null = scope; s; s = s.parent) {
      const v = s.localVars.get(k);
      if (v) return v;
    }
    return this.symbols.variables.get(k) ?? null;
  }

  /** Columns of a record variable (%ROWTYPE, cursor FOR-loop record, trigger :NEW/:OLD). */
  recordColumns(v: VarDef, scope: Scope): ColumnDef[] | null {
    if (v.query) return this.outputColumns(v.query);
    if (v.recordOfCursor) {
      const c = this.findVar(v.recordOfCursor, scope);
      if (c?.query) return this.outputColumns(c.query);
      return null;
    }
    if (v.rowtypeOf && v.rowtypeOf.length) {
      if (v.rowtypeOf.length === 1) {
        const c = this.findVar(v.rowtypeOf[0].text, scope);
        if (c && c.kind === 'cursor' && c.query) return this.outputColumns(c.query);
      }
      const e = this.index.resolve(v.rowtypeOf, TABULAR);
      return e ? e.columns() : null;
    }
    if (v.columns) return v.columns;
    return null;
  }

  // ------------------------------------------------------------ qualifiers

  /** What does `a.` / `a.b.` refer to at this scope? */
  resolveQualifier(parts: NamePart[], scope: Scope): QualifierTarget | null {
    const idx = this.index;
    if (parts.length === 1) {
      const q = parts[0];
      const src = this.findSourceByLabel(q, scope);
      if (src) return { kind: 'source', src: src.src };
      const v = this.findVar(q.text, scope);
      if (v) {
        const cols = this.recordColumns(v, scope);
        if (cols) return { kind: 'record', name: v.name, columns: cols, variable: v };
      }
      // trigger :NEW / :OLD (param token text includes the colon)
      const cte = this.findCte(q, scope);
      if (cte) return { kind: 'record', name: cte.name, columns: this.cteColumns(cte), variable: { name: cte.name, kind: 'record', type: 'CTE', range: cte.nameRange } };
      const obj = idx.resolve([q], (e) => e.type === 'package' || e.type === 'sequence' || e.isTabular);
      const sch = idx.schema(q.text, q.quoted);
      if (obj && obj.type === 'package') return { kind: 'package', entry: obj };
      if (obj && obj.type === 'sequence') return { kind: 'sequence', entry: obj };
      if (sch) return { kind: 'schema', schema: sch, name: sch.name };
      if (idx.spec.id === 'tsql' && idx.databases.some((d) => idx.keyOf(d, true) === idx.keyOf(q.text, q.quoted))) {
        return { kind: 'database', name: q.text };
      }
      if (obj) return { kind: 'object', entry: obj };
      const temp = this.symbols.tables.get(q.text.toUpperCase());
      if (temp) return { kind: 'record', name: temp.name, columns: this.tempColumns(temp), variable: { name: temp.name, kind: 'tableVar', type: 'TABLE', range: temp.defRange } };
      return null;
    }
    if (parts.length === 2) {
      const [a, b] = parts;
      if (idx.spec.id === 'tsql' && b.text === '') {
        // db..  → default schema of that database
        return { kind: 'schema', schema: idx.defaultSchemaEntry() ?? null, name: idx.defaultSchema, database: a.text };
      }
      const sch = idx.schema(a.text, a.quoted);
      if (sch) {
        const obj = idx.resolve([a, b], (e) => e.type === 'package' || e.type === 'sequence' || e.isTabular);
        if (obj?.type === 'package') return { kind: 'package', entry: obj };
        if (obj?.type === 'sequence') return { kind: 'sequence', entry: obj };
        if (obj) return { kind: 'object', entry: obj };
        return null;
      }
      if (idx.spec.id === 'tsql' && idx.databases.some((d) => idx.keyOf(d, true) === idx.keyOf(a.text, a.quoted))) {
        const local = idx.database && idx.keyOf(a.text, a.quoted) === idx.keyOfCatalog(idx.database);
        const s2 = local ? idx.schema(b.text, b.quoted) ?? null : null;
        return { kind: 'schema', schema: s2, name: b.text, database: a.text };
      }
      return null;
    }
    if (parts.length === 3 && idx.spec.id === 'tsql') {
      const obj = idx.resolve(parts, TABULAR);
      if (obj) return { kind: 'object', entry: obj };
    }
    if (parts.length === 3 && idx.spec.id === 'plsql') {
      const obj = idx.resolve(parts.slice(0, 2), (e) => e.type === 'package');
      if (obj) return { kind: 'package', entry: obj };
    }
    return null;
  }

  /** Columns reachable through a qualifier, or null if it is not a column container. */
  qualifierColumns(t: QualifierTarget, scope: Scope): ColumnDef[] | null {
    void scope;
    switch (t.kind) {
      case 'source': return t.src.columns();
      case 'record': return t.columns;
      case 'object': return t.entry.columns();
      default: return null;
    }
  }
}

function renameColumns(cols: ColumnDef[], names: string[] | undefined, keepExtra = false): ColumnDef[] {
  if (!names || names.length === 0) return cols;
  const out: ColumnDef[] = names.map((n, i) => ({ ...(cols[i] ?? { type: '', ordinal: i + 1 }), name: n, ordinal: i + 1 }));
  if (keepExtra) return out;
  return out;
}

export function objectTypeLabel(t: CatalogObjectType): string {
  switch (t) {
    case 'table': return 'table';
    case 'view': return 'view';
    case 'mview': return 'materialized view';
    case 'proc': return 'procedure';
    case 'func': return 'function';
    case 'tablefunc': return 'table function';
    case 'synonym': return 'synonym';
    case 'sequence': return 'sequence';
    case 'package': return 'package';
    case 'type': return 'type';
    case 'trigger': return 'trigger';
  }
}

// Soft (instant, client-side) diagnostics (PLAN 4.11).
import type { DiagnosticSeverity, Token } from '../types';
import type { DialectSpec } from '../dialect/spec';
import type { CatalogIndex } from '../catalog/index';
import type { Binder } from '../catalog/binder';
import type { Scope, StatementModel, TableRef } from '../parse/statement-model';
import type { SplitStatement } from '../split/splitter';

export interface RawDiagnostic { start: number; end: number; severity: DiagnosticSeverity; code: string; message: string }

/** Lexical problems over the whole document: unterminated strings/comments/identifiers, unbalanced parens per statement. */
export function lexicalDiagnostics(tokens: Token[], statements: SplitStatement[]): RawDiagnostic[] {
  const out: RawDiagnostic[] = [];
  for (const t of tokens) {
    if (!t.unterminated) continue;
    const what = t.kind === 'comment' ? 'Unterminated comment' : t.kind === 'string' ? 'Unterminated string literal' : 'Unterminated quoted identifier';
    out.push({ start: t.start, end: Math.min(t.end, t.start + Math.max(1, t.text.indexOf('\n') >= 0 ? t.text.indexOf('\n') : t.text.length)), severity: 'error', code: 'unterminated', message: what });
  }
  for (const st of statements) {
    const stack: Token[] = [];
    for (let i = st.tokStart; i < st.tokEnd; i++) {
      const t = tokens[i];
      if (t.kind !== 'punct') continue;
      if (t.text === '(') stack.push(t);
      else if (t.text === ')') {
        if (stack.length) stack.pop();
        else out.push({ start: t.start, end: t.end, severity: 'error', code: 'paren', message: "Unbalanced ')'" });
      }
    }
    for (const t of stack) out.push({ start: t.start, end: t.end, severity: 'error', code: 'paren', message: "Unclosed '('" });
  }
  return out;
}

function schemaLoaded(index: CatalogIndex, ref: TableRef): boolean {
  if (!index.snapshot) return false;
  if (ref.parts.length === 1 && index.spec.id === 'pgsql') {
    // every search_path schema must be loaded before an unqualified name can be called unknown
    const missing = index.unloadedSearchPath();
    for (const m of missing) index.requestSchema(m);
    return missing.length === 0 && index.defaultEntries().length > 0;
  }
  if (ref.parts.length === 1) return !!index.defaultSchemaEntry();
  if (ref.parts.length === 2) return !!index.schema(ref.parts[0].text, ref.parts[0].quoted);
  if (ref.parts.length === 3 && index.spec.id === 'pgsql') {
    return !!index.database && index.keyOf(ref.parts[0].text, ref.parts[0].quoted) === index.keyOfCatalog(index.database) && !!index.schema(ref.parts[1].text, ref.parts[1].quoted);
  }
  if (ref.parts.length === 3 && index.spec.id === 'tsql') {
    return !!index.database && ref.parts[0].text.toUpperCase() === index.database.toUpperCase() && (ref.parts[1].text === '' ? !!index.defaultSchemaEntry() : !!index.schema(ref.parts[1].text, ref.parts[1].quoted));
  }
  return false;
}

export function statementDiagnostics(st: SplitStatement, model: StatementModel, binder: Binder, index: CatalogIndex, spec: DialectSpec): RawDiagnostic[] {
  const out: RawDiagnostic[] = [];
  const first = model.tokens[0];
  if (!first) return out;
  if (st.skipOnRun) {
    if (st.kind === 'psql') out.push({ start: st.start, end: st.end, severity: 'warning', code: 'psql', message: 'psql meta-command (\\d, \\c …) is not SQL; it is skipped on run' });
    else out.push({ start: st.start, end: st.end, severity: 'warning', code: 'sqlplus', message: 'SQL*Plus command not supported; it is skipped on run' });
    return out;
  }
  if (st.isPlsqlBlock && st.missingSlash) {
    const last = model.tokens[model.tokens.length - 1];
    out.push({ start: last.start, end: last.end, severity: 'info', code: 'missing-slash', message: "PL/SQL block is not terminated by a '/' line" });
  }
  const catalogReady = !!index.snapshot;
  for (const s of model.scopes) {
    // duplicate aliases
    const seen = new Map<string, TableRef>();
    for (const ref of s.sources) {
      const label = ref.alias ?? (ref.parts.length ? ref.parts[ref.parts.length - 1].text : null);
      if (!label) continue;
      const k = index.keyOf(label, !!ref.aliasQuoted);
      if (seen.has(k) && ref.alias && !ref.isTarget) {
        const r = ref.aliasRange ?? ref.nameRange;
        out.push({ start: r[0], end: r[1], severity: 'warning', code: 'duplicate-alias', message: `Duplicate alias '${label}'` });
      }
      seen.set(k, ref);
    }
    // unknown tables
    if (catalogReady) {
      const refs = [...s.sources];
      if (s.targetTable && !refs.includes(s.targetTable)) refs.push(s.targetTable);
      for (const ref of refs) {
        if (ref.kind !== 'table' || ref.remote) continue;
        if (ref.isTarget && !ref.alias && ref.parts.length === 1 && s.sources.some((r) => r !== ref && r.alias && index.keyOf(r.alias, !!r.aliasQuoted) === index.keyOf(ref.parts[0].text, ref.parts[0].quoted))) continue;
        const src = binder.source(ref, s);
        if (!src.unresolved || src.synonym) continue;
        if (!schemaLoaded(index, ref)) continue;
        if (spec.id === 'plsql' && ref.parts.length === 1 && index.publicResolver && !index.wasPublicRequested(ref.parts[0].quoted ? ref.parts[0].text : ref.parts[0].text.toUpperCase())) continue;
        if (spec.id === 'plsql' && ref.parts.length === 1 && index.publicResolver && index.requestPublicSynonym(ref.parts[0].quoted ? ref.parts[0].text : ref.parts[0].text.toUpperCase()) === undefined) continue;
        const name = ref.parts.map((p) => p.text).join('.');
        out.push({ start: ref.nameRange[0], end: ref.nameRange[1], severity: 'warning', code: 'unknown-table', message: `Unknown table '${name}'` });
      }
    }
    // INSERT column count
    if (s.kind === 'insert' && s.insertColumns?.length && s.valuesCount !== undefined && s.valuesCount > 0 && s.valuesCount !== s.insertColumns.length) {
      const r = s.valuesRange ?? [s.start, s.start + 6];
      out.push({ start: r[0], end: Math.min(r[1], r[0] + 1), severity: 'warning', code: 'insert-count', message: `INSERT has ${s.insertColumns.length} target columns but ${s.valuesCount} values` });
    }
    // DELETE / UPDATE without WHERE
    if ((s.kind === 'delete' || s.kind === 'update') && !s.hasWhere && isTopLevelDml(s)) {
      const kw = model.tokens.find((t) => t.start === s.start);
      out.push({ start: s.start, end: kw ? kw.end : s.start + 6, severity: 'warning', code: 'no-where', message: `${s.kind.toUpperCase()} without WHERE` });
    }
  }
  // qualified column references
  if (catalogReady) {
    for (const ch of model.chains) {
      if (ch.isCall || ch.parts.length < 2) continue;
      const q = ch.parts.slice(0, -1);
      const name = ch.parts[ch.parts.length - 1];
      if (name.text === '*' || name.text === '') continue;
      const t = binder.resolveQualifier(q, ch.scope);
      if (!t) {
        if (q.length === 1 && isLikelyAlias(q[0].text, spec) && !index.schema(q[0].text, q[0].quoted) && !binder.findVar(q[0].text, ch.scope) && !spec.packageMap.has(q[0].text.toUpperCase())) {
          if (ch.scope.kind !== 'plsqlBlock' && ch.scope.kind !== 'other' && index.defaultSchemaEntry()) {
            out.push({ start: q[0].range[0], end: q[0].range[1], severity: 'warning', code: 'unknown-alias', message: `Unknown alias or table '${q[0].text}'` });
          }
        }
        continue;
      }
      if (t.kind !== 'source' && t.kind !== 'record' && t.kind !== 'object') continue;
      if (t.kind === 'source' && (t.src.unresolved)) continue;
      const cols = t.kind === 'source' ? t.src.columns() : t.kind === 'record' ? t.columns : t.entry.columns();
      if (!cols.length) continue;
      if (q.length !== ch.parts.length - 1) continue;
      const k = index.keyOf(name.text, name.quoted);
      if (cols.some((c) => index.keyOfCatalog(c.name) === k || (spec.caseFolding === 'insensitive' && c.name.toUpperCase() === name.text.toUpperCase()))) continue;
      // Oracle pseudo columns on any table
      if (spec.id === 'plsql' && ['ROWID', 'ROWNUM', 'ORA_ROWSCN', 'NEXTVAL', 'CURRVAL', 'LEVEL'].includes(name.text.toUpperCase())) continue;
      if (spec.id === 'sqlite' && ['ROWID', 'OID', '_ROWID_'].includes(name.text.toUpperCase())) continue;
      // PostgreSQL system columns on every table
      if (spec.id === 'pgsql' && !name.quoted && PG_SYSTEM_COLUMNS.has(name.text.toLowerCase())) continue;
      const owner = t.kind === 'source' ? (t.src.entry ? t.src.entry.qualifiedName : t.src.display) : t.kind === 'record' ? t.name : t.entry.qualifiedName;
      out.push({ start: name.range[0], end: name.range[1], severity: 'warning', code: 'unknown-column', message: `Column '${name.text}' not found in ${owner}` });
    }
    // ambiguous unqualified columns (info)
    for (const ch of model.chains) {
      if (ch.isCall || ch.parts.length !== 1) continue;
      const s = ch.scope;
      if (s.sources.length < 2) continue;
      const nm = ch.parts[0];
      if (nm.quoted === false && spec.keywords.has(nm.text.toUpperCase())) continue;
      if (s.projections.some((p) => p.alias && p.alias.toUpperCase() === nm.text.toUpperCase())) continue;
      if (binder.findSourceByLabel(nm, s)) continue;
      const k = index.keyOf(nm.text, nm.quoted);
      const owners = binder.ownSources(s).filter((src) => src.columns().some((c) => index.keyOfCatalog(c.name) === k));
      if (owners.length > 1) {
        out.push({ start: nm.range[0], end: nm.range[1], severity: 'info', code: 'ambiguous-column', message: `Column '${nm.text}' is ambiguous (${owners.map((o) => o.label).join(', ')})` });
      }
    }
  }
  if (spec.id === 'pgsql' && catalogReady) out.push(...castDiagnostics(model, index, spec));
  return out;
}

const PG_SYSTEM_COLUMNS = new Set(['ctid', 'xmin', 'xmax', 'cmin', 'cmax', 'tableoid', 'oid']);
/** Valid PostgreSQL type names that the completion list leaves out (pseudo-types, internal and reg* types). */
const PG_EXTRA_TYPES = new Set(`
  name line path regnamespace regrole regprocedure regoper regoperator regconfig regdictionary xid xid8 cid tid pg_lsn
  aclitem int2vector oidvector unknown cstring any anynonarray anyenum anyrange anymultirange anycompatible
  anycompatiblearray anycompatiblenonarray anycompatiblerange event_trigger language_handler internal
  fdw_handler table_am_handler index_am_handler tsm_handler pg_node_tree pg_snapshot txid_snapshot geometry
  geography ltree cube vector halfvec sparsevec`.split(/\s+/).filter(Boolean));

/** Info: `expr::name` where name is neither a known data type nor a type of the catalog. */
function castDiagnostics(model: StatementModel, index: CatalogIndex, spec: DialectSpec): RawDiagnostic[] {
  const out: RawDiagnostic[] = [];
  const toks = model.tokens;
  for (let i = 0; i + 1 < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'op' || t.text !== '::') continue;
    const n = toks[i + 1];
    if (n.kind !== 'ident' && n.kind !== 'keyword') continue;
    const nx = toks[i + 2];
    if (nx && nx.kind === 'punct' && nx.text === '.') continue; // schema-qualified: resolved by the server
    const lower = n.text.toLowerCase();
    if (spec.dataTypeSet.has(n.upper) || PG_EXTRA_TYPES.has(lower)) continue;
    if (/^(character|double|timestamp|time|bit|interval)$/.test(lower)) continue;
    if (index.resolve([{ text: n.text, quoted: false }], (e) => e.type === 'type' || e.type === 'table' || e.type === 'view')) continue;
    if (index.unloadedSearchPath().length) continue;
    out.push({ start: n.start, end: n.end, severity: 'info', code: 'unknown-type', message: `'::' cast to unknown type '${n.text}'` });
  }
  return out;
}

function isTopLevelDml(s: Scope): boolean {
  // a DELETE/UPDATE directly in the statement (or block), not a CTE body
  return !!s.parent && (s.parent.kind === 'other' || s.parent.kind === 'plsqlBlock');
}

function isLikelyAlias(name: string, spec: DialectSpec): boolean {
  if (spec.id === 'tsql' && (name.startsWith('@') || name.startsWith('#'))) return false;
  if (name.startsWith(':')) return false;
  if (['INSERTED', 'DELETED', 'EXCLUDED', 'NEW', 'OLD', 'SQL', 'SYS', 'INFORMATION_SCHEMA', 'DBO'].includes(name.toUpperCase())) return false;
  return /^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(name);
}
